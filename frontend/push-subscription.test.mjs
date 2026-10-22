import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationKey, registerPushSubscription, subscriptionKeyState } from './push-subscription.mjs';

const publicKey = 'AQIDBA';
const key = applicationKey(publicKey);

function subscription(applicationServerKey = key) {
  let unsubscribed = 0;
  return {
    endpoint:'https://web.push.apple.com/existing',
    options:{ applicationServerKey },
    toJSON:() => ({ keys:{ p256dh:'receiver-key', auth:'auth-key' } }),
    unsubscribe:async () => { unsubscribed++; return true; },
    get unsubscribed() { return unsubscribed; },
  };
}

test('recognizes matching and stale VAPID keys without exposing subscription secrets', () => {
  assert.equal(subscriptionKeyState(subscription(), publicKey), 'match');
  assert.equal(subscriptionKeyState(subscription(new Uint8Array([4, 5, 6])), publicKey), 'mismatch');
  assert.equal(subscriptionKeyState(subscription(null), publicKey), 'unknown');
});

test('repairs a missing server row by reusing the existing local subscription', async () => {
  const existing = subscription();
  let subscribeCalls = 0;
  const calls = [];
  const worker = { pushManager:{
    getSubscription:async () => existing,
    subscribe:async () => { subscribeCalls++; return subscription(); },
  } };
  await registerPushSubscription(worker, publicKey, async (path, options) => calls.push({ path, options }));
  assert.equal(existing.unsubscribed, 0);
  assert.equal(subscribeCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/push/subscribe');
  assert.equal(calls[0].options.payload.endpoint, existing.endpoint);
});

test('preserves an existing subscription when account registration fails', async () => {
  const existing = subscription();
  const worker = { pushManager:{ getSubscription:async () => existing,
    subscribe:async () => { throw new Error('should not create another subscription'); } } };
  await assert.rejects(registerPushSubscription(worker, publicKey, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(existing.unsubscribed, 0);
});

test('renews a mismatched VAPID subscription only after an explicit repair action', async () => {
  const old = subscription(new Uint8Array([4, 5, 6]));
  const replacement = subscription();
  replacement.endpoint = 'https://web.push.apple.com/replacement';
  let subscribeCalls = 0;
  const paths = [];
  const worker = { pushManager:{ getSubscription:async () => old, subscribe:async () => {
    subscribeCalls++;
    return replacement;
  } } };
  await registerPushSubscription(worker, publicKey, async (path) => { paths.push(path); });
  assert.equal(old.unsubscribed, 1);
  assert.equal(subscribeCalls, 1);
  assert.deepEqual(paths, ['/api/push/subscribe', '/api/push/unsubscribe']);
});
