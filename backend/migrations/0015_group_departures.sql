-- Keep historical member rows because shared_events references their IDs.
-- An active membership is a new incarnation after every rejoin.
ALTER TABLE group_members ADD COLUMN left_at TEXT;
-- An old Worker only checks user_id. Clear it on departure so even an old
-- version cannot authenticate the historical membership after a cutover.
-- Keep the account association separately for audit and recovery.
ALTER TABLE group_members ADD COLUMN departed_user_id TEXT REFERENCES users(id);
DROP INDEX idx_group_members_group_user;
CREATE UNIQUE INDEX idx_group_members_group_user
  ON group_members(group_id, user_id) WHERE user_id IS NOT NULL AND left_at IS NULL;
CREATE VIEW active_group_members AS SELECT * FROM group_members WHERE left_at IS NULL;

-- Preserve participation and inbox history without reviving it on rejoin.
ALTER TABLE group_availability_reactions ADD COLUMN revoked_at TEXT;
ALTER TABLE shared_event_participants ADD COLUMN revoked_at TEXT;
ALTER TABLE in_app_notifications ADD COLUMN revoked_at TEXT;

-- Fail closed if an already-authorized request tries to insert after departure.
CREATE TRIGGER shared_events_active_creator BEFORE INSERT ON shared_events
WHEN NOT EXISTS (SELECT 1 FROM active_group_members WHERE id=NEW.created_by_member_id AND group_id=NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;
CREATE TRIGGER calendar_entries_active_member BEFORE INSERT ON member_calendar_entries
WHEN NOT EXISTS (SELECT 1 FROM active_group_members WHERE id=NEW.member_id AND group_id=NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;
CREATE TRIGGER wishes_active_owner BEFORE INSERT ON group_availability_wishes
WHEN NOT EXISTS (SELECT 1 FROM active_group_members WHERE user_id=NEW.user_id AND group_id=NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;
CREATE TRIGGER reactions_active_member BEFORE INSERT ON group_availability_reactions
WHEN NOT EXISTS (SELECT 1 FROM group_availability_wishes w JOIN active_group_members m
  ON m.group_id=w.group_id WHERE w.id=NEW.wish_id AND m.user_id=NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;
CREATE TRIGGER reactions_active_reactivation BEFORE UPDATE OF revoked_at ON group_availability_reactions
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM group_availability_wishes w JOIN active_group_members m
  ON m.group_id=w.group_id WHERE w.id=NEW.wish_id AND m.user_id=NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;
CREATE TRIGGER participants_active_member BEFORE INSERT ON shared_event_participants
WHEN NOT EXISTS (SELECT 1 FROM shared_events e JOIN active_group_members m
  ON m.group_id=e.group_id WHERE e.id=NEW.event_id AND m.user_id=NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;
