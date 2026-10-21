CREATE TABLE IF NOT EXISTS member_calendar_entries (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('shift', 'personal')),
  source_id TEXT NOT NULL,
  event_date TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL DEFAULT '',
  ends_at TEXT NOT NULL DEFAULT '',
  all_day INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (group_id, member_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_member_calendar_group_date
  ON member_calendar_entries(group_id, event_date);
