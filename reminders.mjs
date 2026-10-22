export const REMINDER_EXTRA_KEY = "daySyncReminders";
export const REMINDER_PRESETS = [
  { minutes:10, label:"10分前" },
  { minutes:30, label:"30分前" },
  { minutes:60, label:"1時間前" },
  { minutes:120, label:"2時間前" },
  { minutes:1440, label:"1日前" },
];
export const MAX_REMINDER_MINUTES = 7 * 24 * 60;
export const MAX_REMINDER_COUNT = 8;

export function currentTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo"; }
  catch { return "Asia/Tokyo"; }
}

export function normalizeReminderSettings(offsetMinutes, timeZone = currentTimeZone()) {
  if (!Array.isArray(offsetMinutes) || offsetMinutes.length > MAX_REMINDER_COUNT || typeof timeZone !== "string" || timeZone.length > 64) return null;
  try { new Intl.DateTimeFormat("en", { timeZone }).format(0); }
  catch { return null; }
  if (offsetMinutes.some((value) => !Number.isSafeInteger(value) || value < 1 || value > MAX_REMINDER_MINUTES)) return null;
  return { offsetMinutes:[...new Set(offsetMinutes)].sort((a,b) => a-b), timeZone };
}

export function readReminderSettings(extra) {
  const raw = extra && typeof extra === "object" ? extra[REMINDER_EXTRA_KEY] : null;
  if (!raw) return { offsetMinutes:[], timeZone:currentTimeZone() };
  return normalizeReminderSettings(raw.offsetMinutes, raw.timeZone) || { offsetMinutes:[], timeZone:currentTimeZone() };
}

export function writeReminderSettings(extra, offsetMinutes, timeZone = currentTimeZone()) {
  const normalized = normalizeReminderSettings(offsetMinutes, timeZone);
  if (!normalized) throw new Error("通知タイミングを確認してください。");
  return { ...(extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}), [REMINDER_EXTRA_KEY]:normalized };
}
