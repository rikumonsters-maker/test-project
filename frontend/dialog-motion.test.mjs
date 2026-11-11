import test from "node:test";
import assert from "node:assert/strict";
import { dialogExitDelayMs, transitionEndDelayMs } from "./dialog-motion.mjs";

test("dialog transition delay follows the longest CSS transition", () => {
  assert.equal(transitionEndDelayMs("260ms, 260ms"), 260);
  assert.equal(transitionEndDelayMs("0.26s, 200ms", "0ms, 40ms"), 260);
  assert.equal(transitionEndDelayMs("120ms, 260ms", "0ms, 30ms"), 290);
});

test("dialog transition delay handles reduced motion and invalid values", () => {
  assert.equal(transitionEndDelayMs("0ms, 0ms"), 0);
  assert.equal(transitionEndDelayMs("n/a", "invalid"), 0);
});

test("shared dialogs use their own depth transition when closing", () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    matchMedia: () => ({ matches:false }),
    getComputedStyle: () => ({ transitionDuration:"240ms, 240ms, 240ms", transitionDelay:"0s" }),
  };
  const dialog = {
    querySelector: () => null,
    matches: selector => selector.includes(".common-availability-dialog"),
  };
  try {
    assert.equal(dialogExitDelayMs(dialog), 240);
    globalThis.window.matchMedia = () => ({ matches:true });
    assert.equal(dialogExitDelayMs(dialog), 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
