-- Explicit, per-group permission to show a member's busy intervals with their name.
-- Absence of a row means OFF. Membership history and existing events are unchanged.
CREATE TABLE group_named_busy_sharing (
  group_id TEXT NOT NULL REFERENCES groups(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
