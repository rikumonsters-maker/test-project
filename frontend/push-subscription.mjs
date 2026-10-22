export function applicationKey(base64url) {
  const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - base64url.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function subscriptionKeyState(subscription, publicKey) {
  const key = subscription?.options?.applicationServerKey;
  if (!key || typeof key.byteLength !== 'number') return 'unknown';
  const actual = new Uint8Array(key.buffer || key, key.byteOffset || 0, key.byteLength);
  const expected = applicationKey(publicKey);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
    ? 'match' : 'mismatch';
}

export async function registerPushSubscription(worker, publicKey, requestJson) {
  let subscription = await worker.pushManager.getSubscription();
  let replacedEndpoint = null;
  if (subscription && subscriptionKeyState(subscription, publicKey) === 'mismatch') {
    replacedEndpoint = subscription.endpoint;
    if (!await subscription.unsubscribe()) throw new Error('古い通知登録を解除できませんでした。');
    subscription = null;
  }
  if (!subscription) {
    subscription = await worker.pushManager.subscribe({
      userVisibleOnly:true, applicationServerKey:applicationKey(publicKey),
    });
  }
  const details = subscription.toJSON();
  await requestJson('/api/push/subscribe', {
    payload:{ endpoint:subscription.endpoint, p256dh:details.keys?.p256dh, auth:details.keys?.auth },
  });
  if (replacedEndpoint && replacedEndpoint !== subscription.endpoint) {
    await requestJson('/api/push/unsubscribe', { payload:{ endpoint:replacedEndpoint } }).catch(() => {});
  }
  return subscription;
}
