const $ = (id) => document.getElementById(id);

function status(message = '', kind = '') {
  const element = $('push-status');
  element.textContent = message;
  element.className = `status ${kind}`.trim();
  element.hidden = !message;
}

function profileError(message = '') {
  $('profile-error').textContent = message;
  $('profile-error').hidden = !message;
}

function statusResult(message = '', kind = '') {
  const element = $('profile-status-result');
  element.textContent = message;
  element.className = `status ${kind}`.trim();
  element.hidden = !message;
}

function supportsPush() {
  return window.isSecureContext && Boolean(navigator.serviceWorker?.register) &&
    typeof window.PushManager === 'function' && typeof window.Notification?.requestPermission === 'function';
}

function needsHomeScreen() {
  const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return appleMobile && !window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone;
}

function unsupportedMessage() {
  if (needsHomeScreen()) {
    return 'iPhoneで通知を利用するには、DaySyncをホーム画面に追加してください。';
  }
  return 'この環境ではPush通知を利用できません。HTTPSと対応ブラウザーを確認してください。';
}

function applicationKey(base64url) {
  const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - base64url.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function initProfile({ requestJson, onLogout, onNameChange }) {
  let currentProfile = null;
  let registrationPromise = null;
  let enabled = false;
  let publicKey = null;
  let statusExpiryTimer = null;

  async function registration() {
    if (!registrationPromise) registrationPromise = navigator.serviceWorker.register('/sw.js', { scope:'/', type:'module' });
    return registrationPromise;
  }

  function showProfile(profile) {
    currentProfile = profile;
    if (statusExpiryTimer) clearTimeout(statusExpiryTimer);
    statusExpiryTimer = null;
    const expiresAt = Date.parse(profile.statusExpiresAt || '');
    const activeStatus = profile.statusMessage && expiresAt > Date.now() ? profile.statusMessage : '';
    $('profile-icon').textContent = profile.profileIcon;
    $('profile-name').textContent = profile.displayName;
    $('profile-status-message').textContent = activeStatus;
    $('profile-current-status').hidden = !activeStatus;
    $('profile-account-name').textContent = profile.displayName;
    $('profile-email').textContent = profile.email;
    $('profile-icon-input').value = profile.profileIcon;
    $('profile-name-input').value = profile.displayName;
    $('profile-status-input').value = activeStatus;
    if (activeStatus) statusExpiryTimer = setTimeout(() => {
      $('profile-status-message').textContent = '';
      $('profile-current-status').hidden = true;
      if ($('profile-status-input').value === activeStatus) $('profile-status-input').value = '';
      statusExpiryTimer = null;
    }, Math.max(1, expiresAt - Date.now() + 20));
    onNameChange(profile.displayName, profile.profileIcon);
  }

  function updateToggle() {
    $('push-toggle').textContent = enabled ? 'この端末の通知をOFFにする' : '通知を受け取る';
    $('push-toggle').setAttribute('aria-pressed', String(enabled));
  }

  async function refreshNotifications() {
    if (!supportsPush()) { enabled = false; updateToggle(); return; }
    try { publicKey = (await requestJson('/api/push/config', { method:'GET' })).publicKey; }
    catch (error) { status(error.message, 'caution'); enabled = false; updateToggle(); return; }
    if (Notification.permission !== 'granted') { enabled = false; updateToggle(); return; }
    const subscription = await (await registration()).pushManager.getSubscription();
    if (!subscription) { enabled = false; updateToggle(); return; }
    enabled = Boolean((await requestJson('/api/push/status', { payload:{ endpoint:subscription.endpoint } })).enabled);
    updateToggle();
  }

  async function refresh() {
    try {
      const { profile } = await requestJson('/api/profile', { method:'GET' });
      showProfile(profile);
      profileError();
    } catch (error) { profileError(`プロフィールを読み込めませんでした。${error.message}`); }
    try { await refreshNotifications(); }
    catch (error) { status(`通知状態を確認できませんでした。${error.message}`, 'error'); }
  }

  async function turnOn() {
    if (needsHomeScreen()) return status(unsupportedMessage(), 'caution');
    if (!supportsPush()) return status(unsupportedMessage(), 'caution');
    if (!publicKey) return status('通知はまだ設定されていません。しばらくしてからお試しください。', 'caution');
    if (Notification.permission === 'denied') return status('通知が許可されていません。端末の設定から変更してください。', 'caution');
    // Permission must be requested directly inside the user's click gesture.
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return status('通知が許可されていません。端末の設定から変更してください。', 'caution');
    const worker = await registration();
    let subscription = await worker.pushManager.getSubscription();
    if (subscription) {
      const registered = await requestJson('/api/push/status', { payload:{ endpoint:subscription.endpoint } });
      if (!registered.enabled) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    if (!subscription) subscription = await worker.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:applicationKey(publicKey) });
    const details = subscription.toJSON();
    try {
      await requestJson('/api/push/subscribe', { payload:{ endpoint:subscription.endpoint, p256dh:details.keys?.p256dh, auth:details.keys?.auth } });
    } catch (error) {
      await subscription.unsubscribe();
      throw error;
    }
    enabled = true;
    updateToggle();
    status('この端末の通知をONにしました。', 'safe');
  }

  async function turnOff() {
    const subscription = await (await registration()).pushManager.getSubscription();
    if (subscription) {
      await requestJson('/api/push/unsubscribe', { payload:{ endpoint:subscription.endpoint } });
      await subscription.unsubscribe();
    }
    enabled = false;
    updateToggle();
    status('この端末の通知をOFFにしました。', 'safe');
  }

  $('edit-profile').addEventListener('click', () => {
    if (!currentProfile) return;
    $('profile-form').hidden = false;
    $('edit-profile').hidden = true;
    $('profile-name-input').focus();
  });
  $('cancel-profile').addEventListener('click', () => {
    if (currentProfile) showProfile(currentProfile);
    $('profile-form').hidden = true;
    $('edit-profile').hidden = false;
    profileError();
  });
  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    profileError();
    const button = $('profile-form').querySelector('[type=submit]');
    button.disabled = true;
    try {
      const { profile } = await requestJson('/api/profile/update', { payload:{
        profileIcon:$('profile-icon-input').value,
        displayName:$('profile-name-input').value,
      } });
      showProfile(profile);
      $('profile-form').hidden = true;
      $('edit-profile').hidden = false;
    } catch (error) { profileError(error.message); }
    finally { button.disabled = false; }
  });
  $('profile-status-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('profile-status-form').querySelector('[type=submit]');
    button.disabled = true;
    statusResult();
    try {
      const { profile } = await requestJson('/api/profile/status', { payload:{ statusMessage:$('profile-status-input').value } });
      showProfile(profile);
      statusResult(profile.statusMessage ? '更新しました。7日後に自動で消えます。' : '今やりたいことを削除しました。', 'safe');
    } catch (error) { statusResult(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  $('push-toggle').addEventListener('click', async () => {
    const button = $('push-toggle');
    button.disabled = true;
    status();
    try { if (enabled) await turnOff(); else await turnOn(); }
    catch (error) { status(`通知を変更できませんでした。${error.message}`, 'error'); }
    finally { button.disabled = false; }
  });
  $('logout-button').addEventListener('click', async () => {
    const button = $('logout-button');
    button.disabled = true;
    try {
      let subscription = null;
      try { if (supportsPush()) subscription = await (await registration()).pushManager.getSubscription(); }
      catch { /* A broken notification setup must never block logout. */ }
      await requestJson('/api/auth/logout', { payload:{ endpoint:subscription?.endpoint || '' } });
      if (subscription) await subscription.unsubscribe().catch(() => {});
      onLogout();
    } catch (error) { profileError(`ログアウトできませんでした。${error.message}`); button.disabled = false; }
  });

  if (supportsPush()) void registration().catch(() => { /* Report this when the user opens notification settings. */ });
  updateToggle();
  return { refresh };
}
