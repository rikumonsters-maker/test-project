import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLIC_APP_ORIGIN, createInviteUrl, resolveApiBase, resolvePublicAppOrigin } from './config.mjs';

test('all public and preview pages generate canonical invitations without unrelated parameters', () => {
  for (const origin of [PUBLIC_APP_ORIGIN, 'https://test-project-nu-one-12.vercel.app', 'https://preview.example']) {
    assert.equal(createInviteUrl('MP-ABC', { origin }).href, `${PUBLIC_APP_ORIGIN}/?invite=MP-ABC`);
  }
});

test('local development keeps local invitations and the existing API port', () => {
  for (const hostname of ['localhost', '127.0.0.1']) {
    const location = { hostname, origin:`http://${hostname}:5500` };
    assert.equal(resolvePublicAppOrigin(location), location.origin);
    assert.equal(createInviteUrl('MP-ABC', location).href, `${location.origin}/?invite=MP-ABC`);
    assert.equal(resolveApiBase(location), `http://${hostname}:8787`);
  }
  assert.equal(resolveApiBase({ hostname:'daysync-app.vercel.app' }), '');
});
