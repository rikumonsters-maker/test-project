-- A closed group and all of its history remain in D1. Membership is active
-- only while both the member and the group are active.
ALTER TABLE groups ADD COLUMN closed_at TEXT;
ALTER TABLE groups ADD COLUMN closed_by_user_id TEXT REFERENCES users(id);
ALTER TABLE groups ADD COLUMN closed_by_member_id TEXT REFERENCES group_members(id);
CREATE INDEX idx_groups_closed_at ON groups(closed_at);
DROP VIEW active_group_members;
CREATE VIEW active_group_members AS
  SELECT m.* FROM group_members m JOIN groups g ON g.id=m.group_id
  WHERE m.left_at IS NULL AND g.closed_at IS NULL;

-- Old Workers may hold a membership or invite lookup from before closure.
-- The final member row is retained, but its account and legacy token access
-- are revoked in the same D1 batch as the group closure.
CREATE TRIGGER closed_group_member_insert BEFORE INSERT ON group_members
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=NEW.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_member_reactivate BEFORE UPDATE OF user_id,left_at ON group_members
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM groups g WHERE g.id=NEW.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_member_update_guard BEFORE UPDATE ON group_members
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
  AND NOT (OLD.left_at IS NULL AND NEW.left_at IS NOT NULL AND NEW.user_id IS NULL
    AND NEW.departed_user_id IS COALESCE(OLD.departed_user_id,OLD.user_id)
    AND NEW.id=OLD.id AND NEW.group_id=OLD.group_id)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_update_guard BEFORE UPDATE ON groups
WHEN OLD.closed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_delete_guard BEFORE DELETE ON groups
WHEN OLD.closed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'group history must be retained'); END;

-- Fail closed for requests authorized before the group closed. The existing
-- 0014a/0015 guards remain installed and are not weakened.
CREATE TRIGGER closed_group_event_update BEFORE UPDATE ON shared_events
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_event_delete BEFORE DELETE ON shared_events
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_wish_update BEFORE UPDATE ON group_availability_wishes
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_wish_delete BEFORE DELETE ON group_availability_wishes
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_reaction_update BEFORE UPDATE ON group_availability_reactions
WHEN EXISTS (SELECT 1 FROM group_availability_wishes w JOIN groups g ON g.id=w.group_id
  WHERE w.id=OLD.wish_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_reaction_delete BEFORE DELETE ON group_availability_reactions
WHEN EXISTS (SELECT 1 FROM group_availability_wishes w JOIN groups g ON g.id=w.group_id
  WHERE w.id=OLD.wish_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_calendar_update BEFORE UPDATE ON member_calendar_entries
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_calendar_delete BEFORE DELETE ON member_calendar_entries
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_schedule_update BEFORE UPDATE ON group_schedules
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_schedule_delete BEFORE DELETE ON group_schedules
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_participant_update BEFORE UPDATE ON shared_event_participants
WHEN EXISTS (SELECT 1 FROM shared_events e JOIN groups g ON g.id=e.group_id
  WHERE e.id=OLD.event_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_participant_delete BEFORE DELETE ON shared_event_participants
WHEN EXISTS (SELECT 1 FROM shared_events e JOIN groups g ON g.id=e.group_id
  WHERE e.id=OLD.event_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_schedule_option_update BEFORE UPDATE ON group_schedule_options
WHEN EXISTS (SELECT 1 FROM group_schedules s JOIN groups g ON g.id=s.group_id
  WHERE s.id=OLD.schedule_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_schedule_option_delete BEFORE DELETE ON group_schedule_options
WHEN EXISTS (SELECT 1 FROM group_schedules s JOIN groups g ON g.id=s.group_id
  WHERE s.id=OLD.schedule_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_schedule_vote_delete BEFORE DELETE ON group_schedule_votes
WHEN EXISTS (SELECT 1 FROM group_schedule_options o JOIN group_schedules s ON s.id=o.schedule_id
  JOIN groups g ON g.id=s.group_id WHERE o.id=OLD.option_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_reminder_update BEFORE UPDATE ON event_reminders
WHEN OLD.scope='shared' AND EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_reminder_delete BEFORE DELETE ON event_reminders
WHEN OLD.scope='shared' AND EXISTS (SELECT 1 FROM groups g WHERE g.id=OLD.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_push_insert BEFORE INSERT ON push_deliveries
WHEN NEW.scope='group' AND EXISTS (SELECT 1 FROM groups g WHERE g.id=NEW.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;
CREATE TRIGGER closed_group_notification_insert BEFORE INSERT ON in_app_notifications
WHEN EXISTS (SELECT 1 FROM groups g WHERE g.id=NEW.group_id AND g.closed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'group is closed'); END;

-- The final assertion rolls back the whole close batch if a join, a second
-- closure, or a membership change invalidates its assumptions.
CREATE TABLE group_closure_assertions (
  nonce TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid=1)
);
