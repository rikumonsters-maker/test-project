-- Acknowledging the policy notice is informational, not a sharing preference.
-- Existing per-group settings remain intact for clients that have not seen it.
CREATE TABLE named_busy_policy_notices (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  acknowledged_at TEXT NOT NULL
);
