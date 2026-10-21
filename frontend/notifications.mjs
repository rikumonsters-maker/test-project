const dateTime = new Intl.DateTimeFormat('ja-JP', { dateStyle:'medium', timeStyle:'short' });

export function safeNotificationTarget(value) {
  if (typeof value !== 'string' || !(value === '/' || value.startsWith('/?'))) return null;
  try {
    const target = new URL(value, 'https://daysync.invalid');
    if (target.origin !== 'https://daysync.invalid' || target.pathname !== '/') return null;
    const allowed = new Set(['group','date','eventId','wishId','reminder']);
    if ([...target.searchParams.keys()].some((key) => !allowed.has(key))) return null;
    return target.pathname + target.search;
  } catch { return null; }
}

export function initNotificationCenter({ requestJson, navigate = (path) => window.location.assign(path) }) {
  const $ = (id) => document.getElementById(id);
  const openButton = $('notification-open');
  const badge = $('notification-badge');
  const dialog = $('notification-dialog');
  const closeButton = $('notification-close');
  const readAllButton = $('notification-read-all');
  const list = $('notification-list');
  const empty = $('notification-empty');
  const moreButton = $('notification-more');
  const error = $('notification-error');
  let notifications = [];
  let cursor = null;
  let unreadCount = 0;
  let loading = false;
  let timer = null;

  function showError(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }
  function setCount(value) {
    unreadCount = Math.max(0, Number(value) || 0);
    badge.hidden = unreadCount === 0;
    badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    openButton.setAttribute('aria-label', unreadCount
      ? `通知を開く（未読${unreadCount}件）` : '通知を開く');
    readAllButton.disabled = unreadCount === 0;
  }
  function render() {
    list.replaceChildren();
    empty.hidden = notifications.length > 0;
    moreButton.hidden = !cursor;
    for (const item of notifications) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `notification-item${item.readAt ? '' : ' is-unread'}`;
      const main = document.createElement('span');
      main.className = 'notification-item-main';
      if (!item.readAt) {
        const dot = document.createElement('span');
        dot.className = 'notification-unread-dot';
        dot.setAttribute('aria-hidden','true');
        main.append(dot);
      }
      const message = document.createElement('span');
      message.textContent = item.message;
      main.append(message);
      const time = document.createElement('time');
      time.className = 'notification-time';
      time.dateTime = item.createdAt;
      const parsed = new Date(item.createdAt);
      time.textContent = Number.isNaN(parsed.getTime()) ? '' : dateTime.format(parsed);
      button.setAttribute('aria-label', `${item.readAt ? '' : '未読、'}${item.message}、${time.textContent}`);
      button.append(main,time);
      button.addEventListener('click', async () => {
        const target = safeNotificationTarget(item.targetPath);
        if (!target) { showError('通知の移動先を確認できません。'); return; }
        button.disabled = true;
        try {
          const result = await requestJson('/api/notifications/read', { payload:{id:item.id} });
          item.readAt = new Date().toISOString();
          setCount(result.unreadCount);
        } catch { /* Navigation remains available if a read update fails. */ }
        dialog.close();
        navigate(target);
      });
      row.append(button);
      list.append(row);
    }
  }
  async function refreshCount() {
    try {
      const result = await requestJson('/api/notifications/count', { method:'GET' });
      setCount(result.unreadCount);
    } catch { /* The next refresh retries without affecting the rest of the app. */ }
  }
  async function loadPage(reset = false) {
    if (loading) return;
    loading = true;
    moreButton.disabled = true;
    showError();
    try {
      const query = !reset && cursor
        ? `?beforeAt=${encodeURIComponent(cursor.beforeAt)}&beforeId=${encodeURIComponent(cursor.beforeId)}` : '';
      const result = await requestJson('/api/notifications'+query, { method:'GET' });
      notifications = reset ? result.notifications : [...notifications, ...result.notifications];
      cursor = result.nextCursor;
      setCount(result.unreadCount);
      render();
    } catch (cause) { showError(cause.message || '通知を読み込めませんでした。'); }
    finally { loading = false; moreButton.disabled = false; }
  }
  openButton.addEventListener('click', () => {
    if (dialog.open) return;
    dialog.showModal();
    openButton.setAttribute('aria-expanded','true');
    closeButton.focus();
    void loadPage(true);
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    openButton.setAttribute('aria-expanded','false');
    openButton.focus();
  });
  readAllButton.addEventListener('click', async () => {
    readAllButton.disabled = true;
    showError();
    try {
      await requestJson('/api/notifications/read-all', { payload:{} });
      const now = new Date().toISOString();
      for (const item of notifications) item.readAt ||= now;
      setCount(0);
      render();
    } catch (cause) { showError(cause.message || '既読にできませんでした。'); readAllButton.disabled = false; }
  });
  moreButton.addEventListener('click', () => void loadPage());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshCount();
  });
  return {
    start() {
      void refreshCount();
      if (!timer) timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void refreshCount();
      }, 60_000);
    },
    stop() { if (timer) window.clearInterval(timer); timer = null; },
  };
}
