import test from "node:test";
import assert from "node:assert/strict";
import { transitionEndDelayMs } from "./dialog-motion.mjs";

test("dialog transition delay follows the longest CSS transition", () => {
  assert.equal(transitionEndDelayMs("260ms, 260ms"), 260);
  assert.equal(transitionEndDelayMs("0.26s, 200ms", "0ms, 40ms"), 260);
  assert.equal(transitionEndDelayMs("120ms, 260ms", "0ms, 30ms"), 290);
});

test("dialog transition delay handles reduced motion and invalid values", () => {
  assert.equal(transitionEndDelayMs("0ms, 0ms"), 0);
  assert.equal(transitionEndDelayMs("n/a", "invalid"), 0);
});
