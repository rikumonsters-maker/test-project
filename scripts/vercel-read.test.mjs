import test from 'node:test';
import assert from 'node:assert/strict';
import { vercelJson } from './vercel-read.mjs';

test('authentication and not-found responses stop without logging credentials or response content', async () => {
  const token = 'synthetic-secret-never-log';
  for (const status of [401, 403, 404]) {
    const request = async (url, options) => {
      assert.match(url, /^https:\/\/api\.vercel\.com\//);
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      return { ok: false, status, json: async () => ({ error: { message: 'private response' } }) };
    };
    await assert.rejects(vercelJson('/v13/deployments/example', token, 'deployment', request), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.stack, /synthetic-secret-never-log|private response/);
      return true;
    });
  }
});
