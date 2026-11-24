-- GymLog sync server (Cloudflare D1). Append-only change log: the current state of an entity is its
-- highest version row. UNIQUE(type,id,version) is the optimistic lock (a concurrent or stale writer
-- cannot take a version that exists); UNIQUE(op_id) makes retries idempotent. Nothing is ever updated
-- or deleted: a deletion is a row with deleted=1 (tombstone), so a stale device can never resurrect it.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  payload TEXT,
  op_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (type, id, version),
  UNIQUE (op_id),
  CHECK ((deleted = 1 AND payload IS NULL) OR (deleted = 0 AND payload IS NOT NULL))
);
