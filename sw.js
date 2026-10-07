import { resolvePublicAppOrigin } from './config.mjs';

const appOrigin = resolvePublicAppOrigin(self.location);

function safeUrl(value) {
  try {
    const destination = new URL(typeof value === 'string' ? value : '/', appOrigin);
    if (destination.origin === appOrigin || destination.origin === self.location.origin) {
      return new URL(destination.pathname + destination.search + destination.hash, appOrigin).href;
    }
  } catch { /* Ignore malformed notification destinations. */ }
  return new URL('/', appOrigin).href;
}

self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data?.json() || {}; } catch { /* Show a safe generic notification. */ }
  const url = safeUrl(message.url);
  event.waitUntil(self.registration.showNotification('DaySync', {
    body:typeof message.body === 'string' ? message.body : '新しい共有予定があります',
    icon:'/icons/icon-192.png',
    badge:'/icons/icon-192.png',
    data:{ url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    for (const client of windows) {
      if (new URL(client.url).origin !== appOrigin) continue;
      try {
        const navigated = 'navigate' in client ? await client.navigate(url) : null;
        if (navigated) return navigated.focus();
      } catch { /* Open a new window if an existing one cannot navigate. */ }
    }
    return self.clients.openWindow(url);
  })());
});
