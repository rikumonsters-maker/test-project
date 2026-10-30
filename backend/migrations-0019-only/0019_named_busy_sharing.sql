-- Explicit, per-group permission to show a member's busy intervals with their name.
-- Absence of a row means OFF. Membership history and existing events are unchanged.
CREATE TABLE group_named_busy_sharing (
  member_id TEXT NOT NULL PRIMARY KEY REFERENCES group_members(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  CHECK (length(member_id)>0)
);
