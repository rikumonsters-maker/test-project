import test from 'node:test';
import assert from 'node:assert/strict';
import { userStorageKey, readStoredState, savePersonalState } from './storage.mjs';

test('personal data belongs to only the selected user ID', () => {
  const values = new Map();
  const storage = { getItem:key => values.get(key) ?? null, setItem:(key, value) => values.set(key, value) };
  const first = userStorageKey('11111111-1111-4111-8111-111111111111');
  const second = userStorageKey('22222222-2222-4222-8222-222222222222');
  savePersonalState(storage, first, { shifts:{ '2026-10-01':{ start:'09:00' } }, groups:[{ memberToken:'secret' }], expenses:{} });
  assert.equal(readStoredState(storage, first).shifts['2026-10-01'].start, '09:00');
  assert.deepEqual(readStoredState(storage, second), {});
  assert.equal(values.get(first).includes('memberToken'), false);
  assert.equal(values.get(first).includes('secret'), false);
});
