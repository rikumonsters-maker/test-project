import test from 'node:test';
import assert from 'node:assert/strict';
import { cardTiltAngles, MAX_CARD_TILT_DEGREES } from './card-tilt.mjs';

test('card tilt reaches but never exceeds seven degrees on any edge', () => {
  assert.equal(MAX_CARD_TILT_DEGREES, 7);
  assert.deepEqual(cardTiltAngles(0, 0), { rotateX:7, rotateY:-7 });
  assert.deepEqual(cardTiltAngles(1, 1), { rotateX:-7, rotateY:7 });
  for (const [x, y] of [[-10, -10], [10, 10], [0.25, 0.75], [0.5, 0.5]]) {
    const angles = cardTiltAngles(x, y);
    assert.ok(Math.abs(angles.rotateX) <= MAX_CARD_TILT_DEGREES);
    assert.ok(Math.abs(angles.rotateY) <= MAX_CARD_TILT_DEGREES);
  }
});

test('invalid pointer coordinates produce a neutral and safe tilt', () => {
  assert.deepEqual(cardTiltAngles(Number.NaN, Number.POSITIVE_INFINITY), { rotateX:0, rotateY:0 });
});
