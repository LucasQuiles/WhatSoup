// Migration 57 — durable trigger-occurrence lifecycle (#2566 slice 1).
//
// trigger_runs only ever commits terminal evidence: processTrigger() executes
// first and inserts running+terminal inside one transaction, so a crash or
// hang during execution leaves no row at all. This table is the pre-execution
// ownership record: a row is committed BEFORE the executor is invoked, carries
// a fenced lease (owner + generation + expiry), and UNIQUE(trigger_id,
// scheduled_for, attempt) gives every scheduled occurrence a stable identity
// independent of process and attempt. trigger_runs is unchanged — readers
// migrate in later slices.
import type { DatabaseSync } from 'node:sqlite';

export function runMigration57(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trigger_occurrences (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_id       INTEGER NOT NULL REFERENCES bead_triggers(id) ON DELETE CASCADE,
      bead_id          INTEGER NOT NULL REFERENCES beads(id) ON DELETE CASCADE,
      scheduled_for    INTEGER NOT NULL,
      attempt          INTEGER NOT NULL DEFAULT 1,
      state            TEXT    NOT NULL CHECK (state IN ('claimed','running','ok','noop','failed','terminal_fired','stale')),
      lease_owner      TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 1,
      lease_expires_at INTEGER,
      claimed_at       INTEGER NOT NULL,
      started_at       INTEGER,
      finished_at      INTEGER,
      stale_cause      TEXT,
      metadata_json    TEXT    NOT NULL DEFAULT '{}',
      UNIQUE (trigger_id, scheduled_for, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_occurrences_state_lease
      ON trigger_occurrences(state, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_occurrences_trigger_scheduled
      ON trigger_occurrences(trigger_id, scheduled_for DESC);
  `);
}
