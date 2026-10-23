import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('password recovery and password change UI are excluded from the current release', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(html, /forgot-password|reset-password|show-change-password|change-password-form/);
  assert.doesNotMatch(app, /initPasswordRecovery|password-recovery/);
});
