export const MAX_CARD_TILT_DEGREES = 7;
const TILT_TARGETS = '.interactive-card, .calendar-tilt-card';

function clampUnit(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

export function cardTiltAngles(x, y) {
  const horizontal = clampUnit(x);
  const vertical = clampUnit(y);
  return {
    rotateX:Number(((0.5 - vertical) * MAX_CARD_TILT_DEGREES * 2).toFixed(2)),
    rotateY:Number(((horizontal - 0.5) * MAX_CARD_TILT_DEGREES * 2).toFixed(2)),
  };
}

export function initCardTilt() {
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
    document.querySelectorAll(TILT_TARGETS).forEach(resetCard);
    activeCard = null;
  }

  function canTilt() {
    return finePointer.matches && !reducedMotion.matches;
  }

  function onPointerMove(event) {
    const card = event.target?.closest?.(TILT_TARGETS);
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
    const { rotateX, rotateY } = cardTiltAngles(x, y);
    card.style.setProperty('--card-rotate-x', `${rotateX}deg`);
    card.style.setProperty('--card-rotate-y', `${rotateY}deg`);
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

  document.addEventListener('pointermove', onPointerMove, { passive:true });
  document.addEventListener('pointerout', onPointerOut);
  window.addEventListener('blur', resetAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetAll(); });
  finePointer.addEventListener?.('change', () => { if (!canTilt()) resetAll(); });
  reducedMotion.addEventListener?.('change', () => { if (!canTilt()) resetAll(); });

  return { reset:resetAll };
}
