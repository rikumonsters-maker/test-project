CREATE TABLE in_app_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'group_event_created', 'group_event_updated', 'group_joined',
    'wish_created', 'wish_interested', 'event_reminder'
  )),
  target_path TEXT NOT NULL CHECK (substr(target_path, 1, 2) = '/?' OR target_path = '/'),
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX idx_in_app_notifications_user_time
  ON in_app_notifications(user_id, created_at DESC, id DESC);
CREATE INDEX idx_in_app_notifications_unread
  ON in_app_notifications(user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
