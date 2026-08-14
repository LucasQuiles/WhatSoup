// src/core/substrate/schema.ts
// Substrate slice 1 schema — 9 tables + indexes.
// All timestamps are unix seconds (INTEGER).

export const MIGRATION_23 = `
CREATE TABLE IF NOT EXISTS beads (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT    NOT NULL CHECK (kind IN ('task','project','observation','agent_job','watch')),
  status             TEXT    NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','proposed','paused','completed','cancelled','failed')),
  title              TEXT    NOT NULL,
  body               TEXT,
  owner_jid          TEXT    NOT NULL,
  chat_jid           TEXT,
  source_message_pk  INTEGER,
  due_at             INTEGER,
  priority           INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -2 AND 2),
  confidence         REAL,
  proposal_reason    TEXT,
  review_by_at       INTEGER,
  parent_bead_id     INTEGER REFERENCES beads(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  completed_at       INTEGER,
  cancelled_at       INTEGER,
  metadata_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_beads_owner_status      ON beads(owner_jid, status);
CREATE INDEX IF NOT EXISTS idx_beads_kind_status       ON beads(kind, status);
CREATE INDEX IF NOT EXISTS idx_beads_status_due        ON beads(status, due_at);
CREATE INDEX IF NOT EXISTS idx_beads_source_message_pk ON beads(source_message_pk);
CREATE INDEX IF NOT EXISTS idx_beads_chat_jid_updated  ON beads(chat_jid, updated_at DESC);

CREATE TABLE IF NOT EXISTS bead_triggers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  bead_id          INTEGER NOT NULL REFERENCES beads(id) ON DELETE CASCADE,
  kind             TEXT    NOT NULL,
  spec_json        TEXT    NOT NULL,
  spec_version     INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','paused','expired','cancelled')),
  interval_seconds INTEGER,
  next_fire_at     INTEGER,
  last_fire_at     INTEGER,
  terminal_at      INTEGER,
  on_terminal      TEXT    NOT NULL DEFAULT 'notify'
                   CHECK (on_terminal IN ('notify','silent','reopen_bead')),
  report_chat_jid  TEXT    NOT NULL,
  dedupe_key       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_due    ON bead_triggers(status, next_fire_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_triggers_bead   ON bead_triggers(bead_id);
CREATE INDEX IF NOT EXISTS idx_triggers_dedupe ON bead_triggers(kind, dedupe_key);

CREATE TABLE IF NOT EXISTS trigger_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id            INTEGER NOT NULL REFERENCES bead_triggers(id) ON DELETE CASCADE,
  bead_id               INTEGER NOT NULL REFERENCES beads(id) ON DELETE CASCADE,
  status                TEXT    NOT NULL CHECK (status IN ('queued','running','ok','noop','failed','terminal_fired')),
  -- 'queued' is reserved: runs insert directly as 'running' (#2566 slice-4 audit);
  -- kept in the CHECK for a future admission queue rather than paying a migration.
  started_at            INTEGER NOT NULL,
  finished_at           INTEGER,
  duration_ms           INTEGER,
  retrieval_context_id  TEXT,    -- reserved: not yet wired (0-ref; intentional)
  output_summary        TEXT,
  output_json           TEXT,
  error_kind            TEXT,
  error_message         TEXT,
  delivered_message_pk  INTEGER,
  attempt               INTEGER NOT NULL DEFAULT 1,  -- always 1 today; reserved for retry lineage (#2566 slice-4 audit)
  metadata_json         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_runs_trigger_started ON trigger_runs(trigger_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_bead_started    ON trigger_runs(bead_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_started  ON trigger_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS bead_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bead_id            INTEGER NOT NULL REFERENCES beads(id) ON DELETE CASCADE,
  event_type         TEXT    NOT NULL,
  payload_json       TEXT    NOT NULL DEFAULT '{}',
  actor              TEXT    NOT NULL,
  source_message_pk  INTEGER,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_bead_created ON bead_events(bead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON bead_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('person','org','project','place','topic','other')),
  canonical_name  TEXT    NOT NULL,
  contact_jid     TEXT    UNIQUE,
  group_jid       TEXT    UNIQUE,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  merged_into_id  INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_entities_kind_name ON entities(kind, canonical_name);
CREATE INDEX IF NOT EXISTS idx_entities_merged    ON entities(merged_into_id) WHERE merged_into_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS entity_aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias       TEXT    NOT NULL,
  alias_kind  TEXT    NOT NULL CHECK (alias_kind IN ('display_name','handle','email','phone','url','nickname','other')),
  source      TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(entity_id, alias, alias_kind)
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON entity_aliases(alias);

CREATE TABLE IF NOT EXISTS entity_observations (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id                  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind                       TEXT    NOT NULL CHECK (kind IN ('preference','fact','relation','status','contact_info','note','other')),
  text                       TEXT    NOT NULL,
  confidence                 REAL    NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_message_pk          INTEGER,
  source_kind                TEXT    NOT NULL CHECK (source_kind IN ('inline','sweep','manual','journal','notes','inbox')),
  supersedes_observation_id  INTEGER REFERENCES entity_observations(id) ON DELETE SET NULL,
  forgotten                  INTEGER NOT NULL DEFAULT 0,
  forgotten_reason           TEXT,
  created_at                 INTEGER NOT NULL,
  metadata_json              TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_obs_entity_live  ON entity_observations(entity_id, forgotten, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_supersedes   ON entity_observations(supersedes_observation_id);
CREATE INDEX IF NOT EXISTS idx_obs_source_msg   ON entity_observations(source_message_pk);

CREATE TABLE IF NOT EXISTS bead_entity_refs (
  bead_id     INTEGER NOT NULL REFERENCES beads(id) ON DELETE CASCADE,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL CHECK (role IN ('subject','owner','stakeholder','mentioned','source','blocked_by','project')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (bead_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_refs_entity ON bead_entity_refs(entity_id);

-- reserved: not yet wired (sweep_runs is 0-ref; intentional, do not remove)
CREATE TABLE IF NOT EXISTS sweep_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT    NOT NULL UNIQUE,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,
  last_message_pk    INTEGER,
  proposed_count     INTEGER NOT NULL DEFAULT 0,
  updated_count      INTEGER NOT NULL DEFAULT 0,
  completed_count    INTEGER NOT NULL DEFAULT 0,
  observation_count  INTEGER NOT NULL DEFAULT 0,
  error_kind         TEXT,
  error_message      TEXT,
  metadata_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sweep_started ON sweep_runs(started_at DESC);
`;
