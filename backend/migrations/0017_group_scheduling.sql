-- Preserve the original author separately from the current manager.
ALTER TABLE group_availability_wishes ADD COLUMN manager_member_id TEXT REFERENCES group_members(id);
ALTER TABLE group_availability_wishes ADD COLUMN management_state TEXT NOT NULL DEFAULT 'open' CHECK(management_state IN ('open','closed','converted'));
ALTER TABLE group_availability_wishes ADD COLUMN management_version INTEGER NOT NULL DEFAULT 0;
UPDATE group_availability_wishes SET manager_member_id=(
  SELECT id FROM active_group_members WHERE group_id=group_availability_wishes.group_id
    AND user_id=group_availability_wishes.user_id);
CREATE TRIGGER wish_manager_on_insert AFTER INSERT ON group_availability_wishes
WHEN NEW.manager_member_id IS NULL
BEGIN
  UPDATE group_availability_wishes SET manager_member_id=(
    SELECT id FROM active_group_members WHERE group_id=NEW.group_id AND user_id=NEW.user_id)
    WHERE id=NEW.id;
END;
CREATE TRIGGER wish_manager_active_update BEFORE UPDATE OF manager_member_id ON group_availability_wishes
WHEN NEW.management_state='open' AND NOT EXISTS (
  SELECT 1 FROM active_group_members m WHERE m.id=NEW.manager_member_id AND m.group_id=NEW.group_id)
BEGIN SELECT RAISE(ABORT,'wish manager must be active'); END;
CREATE TRIGGER wish_management_guard BEFORE UPDATE ON group_availability_wishes
WHEN OLD.manager_member_id IS NOT NULL AND OLD.manager_member_id IS NOT (
  SELECT id FROM active_group_members WHERE group_id=OLD.group_id AND user_id=OLD.user_id)
  AND NEW.management_version<=OLD.management_version
BEGIN SELECT RAISE(ABORT,'transferred wish requires active manager'); END;
CREATE TRIGGER transferred_wish_delete_guard BEFORE DELETE ON group_availability_wishes
WHEN OLD.manager_member_id IS NOT NULL AND OLD.manager_member_id IS NOT (
  SELECT id FROM active_group_members WHERE group_id=OLD.group_id AND user_id=OLD.user_id)
BEGIN SELECT RAISE(ABORT,'transferred wish must be retained'); END;
CREATE TRIGGER closed_wish_update_guard BEFORE UPDATE ON group_availability_wishes
WHEN OLD.management_state!='open' AND NEW.management_version<=OLD.management_version
BEGIN SELECT RAISE(ABORT,'closed wish must be retained'); END;
CREATE TRIGGER closed_wish_delete_guard BEFORE DELETE ON group_availability_wishes
WHEN OLD.management_state!='open'
BEGIN SELECT RAISE(ABORT,'closed wish must be retained'); END;
CREATE TRIGGER closed_wish_reaction_guard BEFORE INSERT ON group_availability_reactions
WHEN EXISTS (SELECT 1 FROM group_availability_wishes w WHERE w.id=NEW.wish_id AND w.management_state!='open')
BEGIN SELECT RAISE(ABORT,'wish is closed'); END;
CREATE TRIGGER closed_wish_reaction_update_guard BEFORE UPDATE OF revoked_at ON group_availability_reactions
WHEN NEW.revoked_at IS NULL AND EXISTS (
  SELECT 1 FROM group_availability_wishes w WHERE w.id=NEW.wish_id AND w.management_state!='open')
BEGIN SELECT RAISE(ABORT,'wish is closed'); END;

CREATE TABLE group_schedules (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_by_member_id TEXT NOT NULL REFERENCES group_members(id),
  manager_member_id TEXT NOT NULL REFERENCES group_members(id),
  source_wish_id TEXT UNIQUE REFERENCES group_availability_wishes(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  response_deadline TEXT NOT NULL,
  minimum_participants INTEGER NOT NULL CHECK(minimum_participants>=1),
  require_all INTEGER NOT NULL DEFAULT 0 CHECK(require_all IN (0,1)),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','confirmed','cancelled')),
  confirmed_event_id TEXT UNIQUE REFERENCES shared_events(id),
  client_request_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deadline_notified_at TEXT,
  reminder_notified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(group_id,created_by_member_id,client_request_id)
);
CREATE INDEX idx_group_schedules_group_state ON group_schedules(group_id,state,updated_at);
CREATE INDEX idx_group_schedules_deadline ON group_schedules(state,response_deadline);
CREATE TRIGGER schedule_manager_active_insert BEFORE INSERT ON group_schedules
WHEN NOT EXISTS (SELECT 1 FROM active_group_members m WHERE m.id=NEW.manager_member_id AND m.group_id=NEW.group_id)
BEGIN SELECT RAISE(ABORT,'schedule manager must be active'); END;
CREATE TRIGGER schedule_manager_active_update BEFORE UPDATE ON group_schedules
WHEN NEW.state='open' AND NOT EXISTS (SELECT 1 FROM active_group_members m WHERE m.id=NEW.manager_member_id AND m.group_id=NEW.group_id)
BEGIN SELECT RAISE(ABORT,'schedule manager must be active'); END;
CREATE TRIGGER schedule_source_wish_guard BEFORE INSERT ON group_schedules
WHEN NEW.source_wish_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM group_availability_wishes w WHERE w.id=NEW.source_wish_id
    AND w.group_id=NEW.group_id AND w.manager_member_id=NEW.manager_member_id
    AND w.management_state='open')
BEGIN SELECT RAISE(ABORT,'wish is not available for scheduling'); END;

CREATE TABLE group_schedule_participants (
  schedule_id TEXT NOT NULL REFERENCES group_schedules(id),
  member_id TEXT NOT NULL REFERENCES group_members(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY(schedule_id,member_id)
);
CREATE INDEX idx_schedule_participant_member ON group_schedule_participants(member_id,schedule_id);
CREATE TRIGGER schedule_participant_active_insert BEFORE INSERT ON group_schedule_participants
WHEN NOT EXISTS (SELECT 1 FROM group_schedules s JOIN active_group_members m
  ON m.group_id=s.group_id WHERE s.id=NEW.schedule_id AND m.id=NEW.member_id AND s.state='open')
BEGIN SELECT RAISE(ABORT,'schedule participant must be active'); END;

CREATE TABLE group_schedule_options (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES group_schedules(id),
  event_date TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  cancelled_at TEXT,
  client_request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(schedule_id,client_request_id)
);
CREATE UNIQUE INDEX idx_schedule_active_option ON group_schedule_options(schedule_id,event_date,starts_at,ends_at)
  WHERE cancelled_at IS NULL;
CREATE INDEX idx_schedule_options_plan ON group_schedule_options(schedule_id,cancelled_at);
CREATE TRIGGER schedule_option_active_insert BEFORE INSERT ON group_schedule_options
WHEN NOT EXISTS (SELECT 1 FROM group_schedules s WHERE s.id=NEW.schedule_id AND s.state='open'
  AND s.response_deadline>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS
    (SELECT 1 FROM active_group_members m WHERE m.id=s.manager_member_id AND m.group_id=s.group_id))
BEGIN SELECT RAISE(ABORT,'schedule is closed'); END;
CREATE TRIGGER schedule_option_active_update BEFORE UPDATE OF cancelled_at ON group_schedule_options
WHEN NOT EXISTS (SELECT 1 FROM group_schedules s JOIN active_group_members m
  ON m.id=s.manager_member_id AND m.group_id=s.group_id WHERE s.id=NEW.schedule_id
    AND s.state='open' AND s.response_deadline>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'schedule is closed'); END;

CREATE TABLE group_schedule_votes (
  option_id TEXT NOT NULL REFERENCES group_schedule_options(id),
  member_id TEXT NOT NULL REFERENCES group_members(id),
  response TEXT NOT NULL CHECK(response IN ('yes','maybe','no')),
  maybe_confirmed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(option_id,member_id)
);
CREATE INDEX idx_schedule_votes_member ON group_schedule_votes(member_id,option_id);
CREATE TRIGGER schedule_vote_active_insert BEFORE INSERT ON group_schedule_votes
WHEN NOT EXISTS (SELECT 1 FROM group_schedule_options o JOIN group_schedules s ON s.id=o.schedule_id
  JOIN group_schedule_participants p ON p.schedule_id=s.id AND p.member_id=NEW.member_id
  JOIN active_group_members m ON m.id=p.member_id AND m.group_id=s.group_id
  WHERE o.id=NEW.option_id AND o.cancelled_at IS NULL AND s.state='open'
    AND s.response_deadline>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'vote is closed'); END;
CREATE TRIGGER schedule_vote_active_update BEFORE UPDATE ON group_schedule_votes
WHEN NOT EXISTS (SELECT 1 FROM group_schedule_options o JOIN group_schedules s ON s.id=o.schedule_id
  JOIN group_schedule_participants p ON p.schedule_id=s.id AND p.member_id=NEW.member_id
  JOIN active_group_members m ON m.id=p.member_id AND m.group_id=s.group_id
  WHERE o.id=NEW.option_id AND o.cancelled_at IS NULL AND s.state='open'
    AND s.response_deadline>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'vote is closed'); END;

ALTER TABLE shared_events ADD COLUMN schedule_plan_id TEXT REFERENCES group_schedules(id);
CREATE UNIQUE INDEX idx_shared_events_schedule ON shared_events(schedule_plan_id) WHERE schedule_plan_id IS NOT NULL;
ALTER TABLE shared_events ADD COLUMN cancelled_at TEXT;
CREATE TRIGGER closed_wish_event_guard BEFORE INSERT ON shared_events
WHEN NEW.wish_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM group_availability_wishes w WHERE w.id=NEW.wish_id AND w.management_state!='open')
BEGIN SELECT RAISE(ABORT,'wish is closed'); END;
CREATE TRIGGER transferred_wish_event_update_guard BEFORE UPDATE ON shared_events
WHEN OLD.wish_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM group_availability_wishes w
  WHERE w.id=OLD.wish_id AND w.manager_member_id IS NOT (
    SELECT id FROM active_group_members m WHERE m.group_id=w.group_id AND m.user_id=w.user_id))
  AND NEW.management_version<=OLD.management_version
BEGIN SELECT RAISE(ABORT,'transferred wish requires active manager'); END;
CREATE TRIGGER closed_wish_event_update_guard BEFORE UPDATE ON shared_events
WHEN OLD.wish_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM group_availability_wishes w WHERE w.id=OLD.wish_id AND w.management_state!='open')
  AND NEW.management_version<=OLD.management_version
BEGIN SELECT RAISE(ABORT,'closed wish event must be retained'); END;
CREATE TRIGGER closed_wish_event_delete_guard BEFORE DELETE ON shared_events
WHEN OLD.wish_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM group_availability_wishes w WHERE w.id=OLD.wish_id AND w.management_state!='open')
BEGIN SELECT RAISE(ABORT,'closed wish event must be retained'); END;
-- The current manager may finalize a retained tentative wish event even when
-- its historical creator has left. Every other participant still needs a
-- current reaction and an active membership.
DROP TRIGGER participants_active_member;
CREATE TRIGGER participants_active_member BEFORE INSERT ON shared_event_participants
WHEN NOT EXISTS (SELECT 1 FROM shared_events e JOIN active_group_members m
  ON m.group_id=e.group_id AND m.user_id=NEW.user_id WHERE e.id=NEW.event_id
    AND (e.wish_id IS NULL OR m.id=e.created_by_member_id OR EXISTS (
      SELECT 1 FROM group_availability_wishes w WHERE w.id=e.wish_id AND w.manager_member_id=m.id
        AND w.management_state='open') OR EXISTS (
      SELECT 1 FROM group_availability_reactions r WHERE r.wish_id=e.wish_id
        AND r.user_id=NEW.user_id AND r.revoked_at IS NULL)))
BEGIN SELECT RAISE(ABORT,'inactive group membership'); END;
ALTER TABLE push_deliveries ADD COLUMN schedule_id TEXT REFERENCES group_schedules(id);
-- Keep the existing notification table and its rows. The storage kind stays
-- compatible with its original CHECK while the API presents schedule_kind.
ALTER TABLE in_app_notifications ADD COLUMN schedule_id TEXT REFERENCES group_schedules(id);
ALTER TABLE in_app_notifications ADD COLUMN schedule_kind TEXT CHECK(schedule_kind IN (
  'schedule_started','schedule_option_added','schedule_deadline','schedule_reminder',
  'schedule_confirmed','schedule_changed','schedule_cancelled'));
CREATE INDEX idx_schedule_notices ON in_app_notifications(schedule_id,user_id);

-- The final assertion rolls back a whole leave batch if a concurrent change
-- prevents departure or leaves active work behind.
CREATE TABLE group_departure_assertions (
  nonce TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid=1)
);
