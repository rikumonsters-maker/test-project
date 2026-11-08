import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_TILT_STORAGE_KEY, readCardTiltPreference } from './card-tilt.mjs';

test('3D card tilt is enabled by default and only an explicit off value disables it', () => {
  assert.equal(readCardTiltPreference({ getItem: () => null }), true);
  assert.equal(readCardTiltPreference({ getItem: () => 'on' }), true);
  assert.equal(readCardTiltPreference({ getItem: () => 'off' }), false);
  assert.equal(CARD_TILT_STORAGE_KEY, 'daysync-card-3d-tilt');
});

test('3D card tilt safely defaults on if browser storage is unavailable', () => {
  assert.equal(readCardTiltPreference(null), true);
  assert.equal(readCardTiltPreference({ getItem: () => { throw new Error('blocked'); } }), true);
});
