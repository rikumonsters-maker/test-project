CREATE TABLE IF NOT EXISTS personal_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  event_date TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  all_day INTEGER NOT NULL,
  note TEXT NOT NULL,
  extra_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_operation TEXT NOT NULL,
  import_source TEXT,
  import_fingerprint TEXT,
  PRIMARY KEY(user_id,id),
  UNIQUE(user_id,import_source,import_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_personal_date ON personal_events(user_id,event_date,deleted);
CREATE TABLE IF NOT EXISTS personal_event_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_changes_user ON personal_event_changes(user_id,seq);
CREATE TABLE IF NOT EXISTS personal_event_operations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY(user_id,operation_id)
);
CREATE TABLE IF NOT EXISTS personal_sync_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  activated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS personal_event_insert AFTER INSERT ON personal_events BEGIN
  INSERT INTO personal_event_changes(user_id,event_json) VALUES (NEW.user_id,json_object(
    'id',NEW.id,'date',NEW.event_date,'title',NEW.title,'start',NEW.starts_at,'end',NEW.ends_at,
    'allDay',json(CASE WHEN NEW.all_day=1 THEN 'true' ELSE 'false' END),'note',NEW.note,'extra',json(NEW.extra_json),
    'version',NEW.version,'deleted',json(CASE WHEN NEW.deleted=1 THEN 'true' ELSE 'false' END),
    'createdAt',NEW.created_at,'updatedAt',NEW.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS personal_event_update AFTER UPDATE ON personal_events BEGIN
  INSERT INTO personal_event_changes(user_id,event_json) VALUES (NEW.user_id,json_object(
    'id',NEW.id,'date',NEW.event_date,'title',NEW.title,'start',NEW.starts_at,'end',NEW.ends_at,
    'allDay',json(CASE WHEN NEW.all_day=1 THEN 'true' ELSE 'false' END),'note',NEW.note,'extra',json(NEW.extra_json),
    'version',NEW.version,'deleted',json(CASE WHEN NEW.deleted=1 THEN 'true' ELSE 'false' END),
    'createdAt',NEW.created_at,'updatedAt',NEW.updated_at));
END;
