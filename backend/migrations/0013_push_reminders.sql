ALTER TABLE group_availability_wishes ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX idx_group_wish_request
  ON group_availability_wishes(group_id, user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

ALTER TABLE push_deliveries ADD COLUMN scope TEXT NOT NULL DEFAULT 'group'
  CHECK (scope IN ('group', 'personal'));
ALTER TABLE push_deliveries ADD COLUMN recipient_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE push_deliveries ADD COLUMN target_path TEXT;
ALTER TABLE push_deliveries ADD COLUMN reminder_id TEXT;
ALTER TABLE push_deliveries ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX idx_push_delivery_dedupe ON push_deliveries(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE event_reminders (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'shared')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  personal_event_id TEXT,
  shared_event_id TEXT REFERENCES shared_events(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL CHECK (offset_minutes BETWEEN 1 AND 10080),
  time_zone TEXT NOT NULL,
  event_start_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  queued_at TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  CHECK (
    (scope = 'personal' AND group_id IS NULL AND personal_event_id IS NOT NULL AND shared_event_id IS NULL)
    OR (scope = 'shared' AND group_id IS NOT NULL AND personal_event_id IS NULL AND shared_event_id IS NOT NULL)
  ),
  FOREIGN KEY(user_id, personal_event_id) REFERENCES personal_events(user_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_personal_reminder_unique
  ON event_reminders(user_id, personal_event_id, offset_minutes) WHERE scope = 'personal';
CREATE UNIQUE INDEX idx_shared_reminder_unique
  ON event_reminders(user_id, shared_event_id, offset_minutes) WHERE scope = 'shared';
CREATE INDEX idx_event_reminders_due ON event_reminders(due_at, id) WHERE queued_at IS NULL;

CREATE INDEX idx_push_deliveries_reminder ON push_deliveries(reminder_id) WHERE reminder_id IS NOT NULL;
