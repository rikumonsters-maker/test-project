// Announced earliest activation: 2026-11-06 18:00 Asia/Tokyo.
export const NAMED_BUSY_ACTIVATION_AT = '2026-11-06T09:00:00Z';
export const namedBusyActive = (now = Date.now()): boolean =>
  now >= Date.parse(NAMED_BUSY_ACTIVATION_AT);
