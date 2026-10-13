// Migration 67 — direct remote-memory lifecycle ledger.
//
// Direct `memory_write` records previously had no local receipt after their
// provider upsert. This ledger deliberately stores lifecycle metadata only:
// opaque record identity, configured destination provenance, scope, bounded
// retry fields, and acknowledgement/absence evidence. It never stores a memory
// payload, its provenance prose, provider bodies, or raw errors.
import type { DatabaseSync } from 'node:sqlite';

const CREATE_LIFECYCLE_TABLE = `
  CREATE TABLE IF NOT EXISTS remote_memory_lifecycle (
    remote_record_id          TEXT PRIMARY KEY NOT NULL,
    account_id                TEXT NOT NULL,
    index_name                TEXT NOT NULL,
    namespace                 TEXT NOT NULL DEFAULT '',
    conversation_key          TEXT NOT NULL,
    sender_jid                TEXT NOT NULL,
    memory_type               TEXT NOT NULL,
    source                    TEXT NOT NULL,
    accepted_at               INTEGER NOT NULL,
    expires_at                INTEGER NOT NULL,
    state                     TEXT NOT NULL DEFAULT 'write_intent'
                              CHECK (state IN (
                                'write_intent', 'active', 'write_ambiguous',
                                'erase_pending', 'leased', 'retry_wait',
                                'provider_acknowledged', 'absence_verified',
                                'retry_exhausted'
                              )),
    erase_scope               TEXT,
    erase_requested_at        INTEGER,
    lease_owner               TEXT,
    lease_expires_at          INTEGER,
    attempt_count             INTEGER NOT NULL DEFAULT 0
                              CHECK (attempt_count >= 0 AND attempt_count <= 8),
    failure_code              TEXT,
    next_attempt_at           INTEGER,
    provider_acknowledged_at  INTEGER,
    absence_verified_at       INTEGER,
    write_finalized_at        INTEGER,
    created_at                INTEGER NOT NULL,
    updated_at                INTEGER NOT NULL,
    CHECK (remote_record_id = trim(remote_record_id) AND length(remote_record_id) BETWEEN 1 AND 128),
    CHECK (namespace = ''),
    CHECK (length(account_id) BETWEEN 1 AND 256),
    CHECK (length(index_name) BETWEEN 1 AND 256),
    CHECK (length(conversation_key) BETWEEN 1 AND 512),
    CHECK (length(sender_jid) BETWEEN 1 AND 512),
    CHECK (length(memory_type) BETWEEN 1 AND 64),
    CHECK (source = 'memory_write'),
    CHECK (expires_at >= accepted_at),
    CHECK ((erase_requested_at IS NULL) = (erase_scope IS NULL)),
    CHECK (erase_scope IS NULL OR erase_scope IN ('account', 'sender', 'conversation', 'expiry')),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK (lease_expires_at IS NULL OR lease_expires_at >= created_at),
    CHECK (failure_code IS NULL OR failure_code IN (
      'timeout', 'network_error', 'provider_unavailable', 'project_guard_failed', 'unknown'
    )),
    CHECK (next_attempt_at IS NULL OR next_attempt_at >= accepted_at),
    CHECK (provider_acknowledged_at IS NULL OR erase_requested_at IS NOT NULL),
    CHECK (absence_verified_at IS NULL OR provider_acknowledged_at IS NOT NULL)
  );

  CREATE INDEX IF NOT EXISTS idx_remote_memory_lifecycle_scope
    ON remote_memory_lifecycle(account_id, index_name, conversation_key, sender_jid);
  CREATE INDEX IF NOT EXISTS idx_remote_memory_lifecycle_due
    ON remote_memory_lifecycle(state, next_attempt_at, lease_expires_at, expires_at);
`;

const CREATE_TOMBSTONE_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS remote_memory_lifecycle_tombstone_wins
  BEFORE UPDATE ON remote_memory_lifecycle
  WHEN OLD.erase_requested_at IS NOT NULL
       AND NEW.state IN ('write_intent', 'active', 'write_ambiguous')
  BEGIN
    SELECT RAISE(ABORT, 'remote_memory_lifecycle: erase tombstone wins');
  END;
`;

export function runMigration67(db: DatabaseSync): void {
  db.exec('SAVEPOINT migration_67');
  try {
    db.exec(CREATE_LIFECYCLE_TABLE);
    db.exec(CREATE_TOMBSTONE_TRIGGER);
    db.exec('RELEASE migration_67');
  } catch (error) {
    db.exec('ROLLBACK TO migration_67');
    db.exec('RELEASE migration_67');
    throw error;
  }
}
