-- Keep the old untimed bio for compatibility. It is not a seven-day status.
ALTER TABLE users ADD COLUMN status_message TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN status_updated_at TEXT;
ALTER TABLE users ADD COLUMN status_expires_at TEXT;
