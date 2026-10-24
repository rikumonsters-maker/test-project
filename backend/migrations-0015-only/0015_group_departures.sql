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

ALTER TABLE groups ADD COLUMN management_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER departed_group_update_guard BEFORE UPDATE ON groups
WHEN EXISTS (SELECT 1 FROM group_members m WHERE m.group_id=OLD.id AND m.left_at IS NOT NULL)
  AND NEW.management_version <= OLD.management_version
BEGIN
  SELECT RAISE(ABORT, 'group update requires active member');
END;
CREATE TRIGGER departed_calendar_delete_guard BEFORE DELETE ON member_calendar_entries
WHEN EXISTS (SELECT 1 FROM group_members m WHERE m.id=OLD.member_id AND m.left_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;
CREATE TRIGGER revoked_reaction_delete_guard BEFORE DELETE ON group_availability_reactions
WHEN OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;

-- Old Workers can retain an authorization result from before a departure.
-- Require a new-Worker write marker to edit or delete an orphaned event.
ALTER TABLE shared_events ADD COLUMN management_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE shared_event_delete_grants (
  event_id TEXT PRIMARY KEY REFERENCES shared_events(id) ON DELETE CASCADE,
  actor_member_id TEXT NOT NULL REFERENCES group_members(id)
);
CREATE TRIGGER orphan_event_update_guard BEFORE UPDATE ON shared_events
WHEN EXISTS (SELECT 1 FROM group_members author
  WHERE author.id=OLD.created_by_member_id AND author.left_at IS NOT NULL)
  AND NEW.management_version <= OLD.management_version
BEGIN
  SELECT RAISE(ABORT, 'orphan event requires active manager');
END;
CREATE TRIGGER orphan_event_delete_guard BEFORE DELETE ON shared_events
WHEN EXISTS (SELECT 1 FROM group_members author
  WHERE author.id=OLD.created_by_member_id AND author.left_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM shared_event_delete_grants grant_row
    JOIN active_group_members actor ON actor.id=grant_row.actor_member_id
    WHERE grant_row.event_id=OLD.id AND actor.group_id=OLD.group_id)
BEGIN
  SELECT RAISE(ABORT, 'orphan event requires active manager');
END;

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
  ON m.group_id=e.group_id WHERE e.id=NEW.event_id AND m.user_id=NEW.user_id
    AND (e.wish_id IS NULL OR m.id=e.created_by_member_id OR EXISTS (
      SELECT 1 FROM group_availability_reactions r
      WHERE r.wish_id=e.wish_id AND r.user_id=NEW.user_id AND r.revoked_at IS NULL)))
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;
-- Old Workers do not understand revoked participation. A rejoined account
-- must not be able to recreate its former shared reminder through one.
CREATE TRIGGER shared_reminders_active_participant BEFORE INSERT ON event_reminders
WHEN NEW.scope='shared' AND NOT EXISTS (
  SELECT 1 FROM shared_events e JOIN active_group_members m
    ON m.group_id=e.group_id AND m.user_id=NEW.user_id
  WHERE e.id=NEW.shared_event_id AND e.group_id=NEW.group_id AND e.status='confirmed'
    AND (e.wish_id IS NULL OR EXISTS (
      SELECT 1 FROM shared_event_participants p
      WHERE p.event_id=e.id AND p.user_id=NEW.user_id AND p.revoked_at IS NULL)))
BEGIN
  SELECT RAISE(ABORT, 'inactive group membership');
END;
