-- A full (including empty) monthly shift snapshot is needed to distinguish
-- "no registered shifts" from "this member has not synced this month".
-- Keying by member ID keeps a new membership unverified after rejoining.
CREATE TABLE group_calendar_sync_coverage (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id, month)
);
CREATE TRIGGER group_calendar_coverage_active_insert BEFORE INSERT ON group_calendar_sync_coverage
WHEN NOT EXISTS (SELECT 1 FROM active_group_members m WHERE m.id=NEW.member_id AND m.group_id=NEW.group_id)
BEGIN SELECT RAISE(ABORT, 'inactive group membership'); END;
CREATE TRIGGER group_calendar_coverage_active_update BEFORE UPDATE ON group_calendar_sync_coverage
WHEN NOT EXISTS (SELECT 1 FROM active_group_members m WHERE m.id=NEW.member_id AND m.group_id=NEW.group_id)
BEGIN SELECT RAISE(ABORT, 'inactive group membership'); END;
CREATE INDEX idx_shared_events_date ON shared_events(event_date);
CREATE INDEX idx_member_calendar_date_member ON member_calendar_entries(event_date,member_id);
