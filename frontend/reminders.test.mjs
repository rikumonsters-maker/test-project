import test from "node:test";
import assert from "node:assert/strict";
import { currentTimeZone, normalizeReminderSettings, readReminderSettings, writeReminderSettings } from "./reminders.mjs";

test("normalizes several preset and custom reminder offsets without duplicates", () => {
  assert.deepEqual(normalizeReminderSettings([1440, 10, 45, 10], "Asia/Tokyo"), {
    offsetMinutes:[10, 45, 1440], timeZone:"Asia/Tokyo",
  });
});

test("accepts no reminders and preserves other event extra fields", () => {
  const extra = writeReminderSettings({ place:"駅前", customTag:"保管" }, [], "Asia/Tokyo");
  assert.deepEqual(extra, { place:"駅前", customTag:"保管", daySyncReminders:{ offsetMinutes:[], timeZone:"Asia/Tokyo" } });
  assert.deepEqual(readReminderSettings(extra), { offsetMinutes:[], timeZone:"Asia/Tokyo" });
});

test("uses the device time zone when an older event has no reminder setting", () => {
  const settings = readReminderSettings({ note:"legacy" });
  assert.deepEqual(settings, { offsetMinutes:[], timeZone:currentTimeZone() });
});

test("rejects invalid offsets and time zones instead of silently storing them", () => {
  for (const value of [0, -1, 10081, 1.5, "30"]) {
    assert.equal(normalizeReminderSettings([value], "Asia/Tokyo"), null);
  }
  assert.equal(normalizeReminderSettings([10], "Not/A-Timezone"), null);
  assert.throws(() => writeReminderSettings({}, [10081], "Asia/Tokyo"), /通知タイミング/);
});
