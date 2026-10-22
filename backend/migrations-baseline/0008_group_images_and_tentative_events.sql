ALTER TABLE groups ADD COLUMN avatar_key TEXT;
ALTER TABLE groups ADD COLUMN avatar_updated_at TEXT;

ALTER TABLE shared_events ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'
  CHECK (status IN ('tentative', 'confirmed'));
ALTER TABLE shared_events ADD COLUMN wish_id TEXT REFERENCES group_availability_wishes(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_events_wish ON shared_events(wish_id) WHERE wish_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shared_event_participants (
  event_id TEXT NOT NULL REFERENCES shared_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_event_participants_user ON shared_event_participants(user_id);

INSERT INTO shared_events (id, group_id, created_by_member_id, title, event_date, starts_at,
  ends_at, all_day, note, created_at, updated_at, status, wish_id)
SELECT lower(hex(randomblob(16))), w.group_id, m.id,
  COALESCE(NULLIF(w.message, ''), 'みんなで遊ぶ'), w.wish_date, w.start_time,
  w.end_time, w.is_all_day, '', w.created_at, w.updated_at, 'tentative', w.id
FROM group_availability_wishes w JOIN group_members m ON m.group_id = w.group_id AND m.user_id = w.user_id
WHERE EXISTS (SELECT 1 FROM group_availability_reactions r WHERE r.wish_id = w.id)
  AND NOT EXISTS (SELECT 1 FROM shared_events e WHERE e.wish_id = w.id);
