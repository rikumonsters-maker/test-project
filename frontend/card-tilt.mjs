export const CARD_TILT_STORAGE_KEY = 'daysync-card-3d-tilt';
const ROTATION_LIMIT_DEGREES = 7;

export function readCardTiltPreference(storage) {
  try { return storage?.getItem(CARD_TILT_STORAGE_KEY) !== 'off'; }
  catch { return true; }
}

function browserStorage() {
  try { return globalThis.localStorage; }
  catch { return null; }
}

export function initCardTilt({
  root = document.documentElement,
  storage = browserStorage(),
  toggle = document.getElementById('card-tilt-toggle'),
  status = document.getElementById('card-tilt-status'),
} = {}) {
  let enabled = readCardTiltPreference(storage);
  let activeCard = null;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function resetCard(card) {
    if (!card) return;
    card.style.removeProperty('--card-rotate-x');
    card.style.removeProperty('--card-rotate-y');
    card.style.removeProperty('--card-highlight-x');
    card.style.removeProperty('--card-highlight-y');
  }

  function resetAll() {
    document.querySelectorAll('.interactive-card').forEach(resetCard);
    activeCard = null;
  }

  function canTilt() {
    return enabled && finePointer.matches && !reducedMotion.matches;
  }

  function showStatus(message, kind = '') {
    if (!status) return;
    status.textContent = message;
    status.className = `status ${kind}`.trim();
    status.hidden = !message;
  }

  function applyPreference(value, persist = false) {
    enabled = Boolean(value);
    root.dataset.cardTilt = enabled ? 'on' : 'off';
    if (toggle) toggle.checked = enabled;
    if (!canTilt()) resetAll();
    if (!persist) return;

    try {
      if (!storage) throw new Error('Storage unavailable');
      storage.setItem(CARD_TILT_STORAGE_KEY, enabled ? 'on' : 'off');
      showStatus(enabled
        ? '3DチルトをONにしました。この設定はこのブラウザーに保存されます。'
        : '3DチルトをOFFにしました。予定やボタンの操作は変わりません。', 'safe');
    } catch {
      showStatus('設定をこのブラウザーに保存できませんでした。再読み込み後は初期設定に戻る場合があります。', 'caution');
    }
  }

  function onPointerMove(event) {
    const card = event.target?.closest?.('.interactive-card');
    if (event.pointerType !== 'mouse' || !canTilt() || !card) {
      if (activeCard) resetCard(activeCard);
      activeCard = null;
      return;
    }

    if (activeCard && activeCard !== card) resetCard(activeCard);
    activeCard = card;
    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) { resetCard(card); activeCard = null; return; }
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const xRotation = (0.5 - y) * ROTATION_LIMIT_DEGREES * 2;
    const yRotation = (x - 0.5) * ROTATION_LIMIT_DEGREES * 2;
    card.style.setProperty('--card-rotate-x', `${xRotation.toFixed(2)}deg`);
    card.style.setProperty('--card-rotate-y', `${yRotation.toFixed(2)}deg`);
    card.style.setProperty('--card-highlight-x', `${(x * 100).toFixed(1)}%`);
    card.style.setProperty('--card-highlight-y', `${(y * 100).toFixed(1)}%`);
  }

  function onPointerOut(event) {
    const remainsInside = event.relatedTarget instanceof Node && activeCard?.contains(event.relatedTarget);
    if (activeCard && !remainsInside) {
      resetCard(activeCard);
      activeCard = null;
    }
  }

  applyPreference(enabled);
  toggle?.addEventListener('change', () => applyPreference(toggle.checked, true));
  document.addEventListener('pointermove', onPointerMove, { passive:true });
  document.addEventListener('pointerout', onPointerOut);
  window.addEventListener('blur', resetAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetAll(); });
  finePointer.addEventListener?.('change', () => { if (!canTilt()) resetAll(); });
  reducedMotion.addEventListener?.('change', () => { if (!canTilt()) resetAll(); });

  return { isEnabled:() => enabled };
}
