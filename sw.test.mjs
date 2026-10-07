import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { PUBLIC_APP_ORIGIN, resolvePublicAppOrigin } from './config.mjs';

function worker(origin = PUBLIC_APP_ORIGIN) {
  const handlers = new Map();
  const notifications = [];
  const opened = [];
  const self = {
    location:{ origin },
    addEventListener:(name, handler) => handlers.set(name, handler),
    registration:{ showNotification:async (title, options) => { notifications.push({ title, options }); } },
    clients:{ matchAll:async () => [], openWindow:async (url) => { opened.push(url); } },
  };
  const source = readFileSync(new URL('./sw.js', import.meta.url), 'utf8')
    .replace("import { resolvePublicAppOrigin } from './config.mjs';", '');
  vm.runInNewContext(source, { self, URL, resolvePublicAppOrigin });
  return { handlers, notifications, opened };
}

test('push displays the group message and notification tap opens that group', async () => {
  const { handlers, notifications, opened } = worker();
  let pending;
  handlers.get('push')({ data:{ json:() => ({ body:'「サークル」に新しい予定が追加されました', url:'/?group=group-1' }) }, waitUntil:(promise) => { pending = promise; } });
  await pending;
  assert.equal(notifications[0].title, 'DaySync');
  assert.equal(notifications[0].options.data.url, `${PUBLIC_APP_ORIGIN}/?group=group-1`);
  handlers.get('notificationclick')({ notification:{ data:notifications[0].options.data, close() {} }, waitUntil:(promise) => { pending = promise; } });
  await pending;
  assert.deepEqual(opened, [`${PUBLIC_APP_ORIGIN}/?group=group-1`]);
});

test('push never navigates to a different origin', async () => {
  const { handlers, notifications } = worker();
  let pending;
  handlers.get('push')({ data:{ json:() => ({ url:'https://evil.example/' }) }, waitUntil:(promise) => { pending = promise; } });
  await pending;
  assert.equal(notifications[0].options.data.url, `${PUBLIC_APP_ORIGIN}/`);
});

test('notifications received on the old URL open the new public group URL', async () => {
  const { handlers, notifications, opened } = worker('https://test-project-nu-one-12.vercel.app');
  let pending;
  handlers.get('push')({ data:{ json:() => ({ url:'/?group=moved-group' }) }, waitUntil:(promise) => { pending = promise; } });
  await pending;
  handlers.get('notificationclick')({ notification:{ data:notifications[0].options.data, close() {} }, waitUntil:(promise) => { pending = promise; } });
  await pending;
  assert.deepEqual(opened, [`${PUBLIC_APP_ORIGIN}/?group=moved-group`]);
});
