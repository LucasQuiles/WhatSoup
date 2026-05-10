export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version       INTEGER PRIMARY KEY,
     applied_at    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS baseline (
     probe_id      TEXT NOT NULL,
     scope_id      TEXT NOT NULL,
     expected_doc  TEXT NOT NULL,
     captured_at   TEXT NOT NULL,
     captured_by   TEXT NOT NULL,
     hmac          TEXT NOT NULL,
     PRIMARY KEY (probe_id, scope_id)
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     ts            TEXT NOT NULL,
     kind          TEXT NOT NULL,
     domain        TEXT,
     scope_id      TEXT,
     probe_id      TEXT,
     severity      TEXT,
     fingerprint   TEXT,
     correlation_id TEXT,
     payload       TEXT NOT NULL,
     alerted_to    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_events_fingerprint ON events(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)`,
  `CREATE TABLE IF NOT EXISTS mutes (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     host          TEXT NOT NULL,
     domain        TEXT NOT NULL,
     expires_at    TEXT NOT NULL,
     reason        TEXT NOT NULL,
     allow_revert_suppression INTEGER NOT NULL DEFAULT 0,
     created_by    TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_mutes_expires ON mutes(expires_at)`,
  `CREATE TABLE IF NOT EXISTS runtime_state (
     key           TEXT PRIMARY KEY,
     value         TEXT NOT NULL
   )`,
] as const satisfies ReadonlyArray<string>;

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length;
