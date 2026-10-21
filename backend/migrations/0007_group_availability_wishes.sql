CREATE TABLE IF NOT EXISTS group_availability_wishes (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wish_date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  is_all_day INTEGER NOT NULL DEFAULT 1 CHECK (is_all_day IN (0, 1)),
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_wishes_group_date
  ON group_availability_wishes(group_id, wish_date);

CREATE TABLE IF NOT EXISTS group_availability_reactions (
  wish_id TEXT NOT NULL REFERENCES group_availability_wishes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wish_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_wish_reactions_user
  ON group_availability_reactions(user_id);
