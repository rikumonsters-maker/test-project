import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { safeNotificationTarget } from './notifications.mjs';

test('notification links only navigate within the DaySync app', () => {
  assert.equal(safeNotificationTarget('/?group=group-1&date=2026-11-15&wishId=wish-1'),
    '/?group=group-1&date=2026-11-15&wishId=wish-1');
  assert.equal(safeNotificationTarget('/?reminder=personal&eventId=event-1'),
    '/?reminder=personal&eventId=event-1');
  assert.equal(safeNotificationTarget('/?group=group-1&scheduleId=schedule-1'),
    '/?group=group-1&scheduleId=schedule-1');
  for (const value of ['https://evil.test/', '//evil.test/', '/other', '/?next=https://evil.test',
    'javascript:alert(1)', null]) assert.equal(safeNotificationTarget(value),null);
});

test('the bell precedes the profile button and the dialog has accessible controls', async () => {
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  assert.ok(html.indexOf('id="notification-open"') < html.indexOf('id="account-open"'));
  assert.match(html,/<dialog[^>]*id="notification-dialog"[^>]*aria-labelledby="notification-title"/);
  assert.match(html,/id="notification-open"[^>]*aria-haspopup="dialog"[^>]*aria-controls="notification-dialog"/);
  assert.match(html,/id="notification-read-all"/);
  assert.match(html,/id="notification-empty"[^>]*role="status"[^>]*>通知はありません/);
  assert.match(html,/id="notification-error"[^>]*role="alert"/);
});
