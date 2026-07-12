/**
 * Migrations 37–40 — the durable turn-lifecycle schema (turn terminal records,
 * turn recovery jobs, completed checkpoint identity, delivery proof).
 *
 * Implementation home extracted from database.ts per the 2026-07-11 turn-lifecycle
 * fitness design. database.ts keeps thin runMigration37–40 wrappers so the ordered
 * MIGRATIONS map and the static migration-numbering guard stay anchored there.
 * Depends only on node:sqlite contracts; migration 40 re-runs migration 39's
 * idempotent shape before its own body.
 */
import type { DatabaseSync } from 'node:sqlite';

const TURN_TERMINAL_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS turn_terminal_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      delivery_jid TEXT NOT NULL,
      inbound_seq INTEGER CHECK (inbound_seq IS NULL OR inbound_seq > 0),
      inbound_seq_key INTEGER NOT NULL
        CHECK (inbound_seq_key = COALESCE(inbound_seq, -1)),
      logical_turn_id TEXT NOT NULL,
      manager_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      attempt_kind TEXT NOT NULL,
      attempt_failure_class TEXT,
      inbound_disposition TEXT NOT NULL,
      delivery_kind TEXT NOT NULL,
      delivery_op_id INTEGER,
      recovery_owner_logical_turn_id TEXT,
      recovery_owner_manager_id TEXT,
      recovery_owner_generation INTEGER,
      reply_guarantee_disarmed INTEGER NOT NULL
        CHECK (reply_guarantee_disarmed IN (0, 1)),
      duplicate_finalize_count INTEGER NOT NULL DEFAULT 0
        CHECK (duplicate_finalize_count >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_duplicate_at TEXT,
      CONSTRAINT turn_terminal_owner_coherence CHECK (
        (
          inbound_disposition = 'transferred_to_recovery_owner'
          AND recovery_owner_logical_turn_id IS NOT NULL
          AND length(trim(replace(replace(replace(
            recovery_owner_logical_turn_id, char(9), ' '
          ), char(10), ' '), char(13), ' '))) > 0
          AND recovery_owner_manager_id IS NOT NULL
          AND length(trim(replace(replace(replace(
            recovery_owner_manager_id, char(9), ' '
          ), char(10), ' '), char(13), ' '))) > 0
          AND typeof(recovery_owner_generation) = 'integer'
          AND recovery_owner_generation BETWEEN 1 AND 9007199254740991
        )
        OR
        (
          inbound_disposition <> 'transferred_to_recovery_owner'
          AND recovery_owner_logical_turn_id IS NULL
          AND recovery_owner_manager_id IS NULL
          AND recovery_owner_generation IS NULL
        )
      ),
      CONSTRAINT turn_terminal_disarm_evidence CHECK (
        reply_guarantee_disarmed = 0
        OR delivery_kind = 'echoed'
        OR inbound_disposition = 'finalized_no_reply_policy'
      ),
      CONSTRAINT turn_terminal_unknown_stays_armed CHECK (
        delivery_kind <> 'delivery_unknown'
        OR reply_guarantee_disarmed = 0
      ),
      UNIQUE (inbound_seq_key, logical_turn_id, generation)
    );
`;

function createTurnTerminalIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turn_terminal_conversation_created
      ON turn_terminal_records(conversation_key, created_at);
  `);
}

export function runMigration37(db: DatabaseSync): void {
  db.exec(TURN_TERMINAL_TABLE_DDL);
  createTurnTerminalIndex(db);
}

function requiredRecoveryIdentity(column: string): string {
  return `length(trim(replace(replace(replace(
          ${column}, char(9), ' '
        ), char(10), ' '), char(13), ' '))) > 0`;
}

const TURN_RECOVERY_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS turn_recovery_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_record_id INTEGER NOT NULL UNIQUE
        REFERENCES turn_terminal_records(id) ON DELETE RESTRICT,
      scope TEXT NOT NULL CHECK (scope IN ('per_chat', 'shared', 'singleton')),
      conversation_key TEXT NOT NULL,
      delivery_jid TEXT NOT NULL,
      source_inbound_seq INTEGER NOT NULL
        CHECK (typeof(source_inbound_seq) = 'integer'
          AND source_inbound_seq BETWEEN 1 AND 9007199254740991),
      source_inbound_seq_key INTEGER NOT NULL
        CHECK (source_inbound_seq_key = source_inbound_seq),
      source_logical_turn_id TEXT NOT NULL,
      source_manager_id TEXT NOT NULL,
      source_generation INTEGER NOT NULL
        CHECK (typeof(source_generation) = 'integer'
          AND source_generation BETWEEN 1 AND 9007199254740991),
      source_message_id TEXT NOT NULL,
      owner_logical_turn_id TEXT NOT NULL,
      owner_manager_id TEXT NOT NULL,
      owner_generation INTEGER NOT NULL
        CHECK (typeof(owner_generation) = 'integer'
          AND owner_generation BETWEEN 1 AND 9007199254740991),
      assigned_owner_logical_turn_id TEXT NOT NULL,
      assigned_owner_manager_id TEXT NOT NULL,
      assigned_owner_generation INTEGER NOT NULL
        CHECK (typeof(assigned_owner_generation) = 'integer'
          AND assigned_owner_generation BETWEEN 1 AND 9007199254740991),
      replay_safe INTEGER NOT NULL CHECK (replay_safe IN (0, 1)),
      replay_safety_proof_id TEXT,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      replay_text TEXT NOT NULL,
      is_group INTEGER NOT NULL CHECK (is_group IN (0, 1)),
      group_name TEXT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('blocked_unsafe', 'pending', 'claimed', 'completed', 'exhausted')),
      attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 5),
      claim_epoch INTEGER NOT NULL DEFAULT 0
        CHECK (claim_epoch = attempt_count),
      assignment_epoch INTEGER NOT NULL DEFAULT 0
        CHECK (assignment_epoch BETWEEN 0 AND 9007199254740991),
      claim_token TEXT,
      claim_expires_at TEXT,
      last_requeue_claim_token_hash TEXT,
      last_requeue_claim_epoch INTEGER,
      last_requeue_backoff_seconds INTEGER,
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      duplicate_enqueue_count INTEGER NOT NULL DEFAULT 0
        CHECK (duplicate_enqueue_count >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      completed_at TEXT,
      CONSTRAINT turn_recovery_replay_safe CHECK (
        replay_safe = 0 OR replay_safety_proof_id IS NULL
      ),
      CONSTRAINT turn_recovery_required_identity CHECK (
        ${requiredRecoveryIdentity('conversation_key')}
        AND ${requiredRecoveryIdentity('delivery_jid')}
        AND ${requiredRecoveryIdentity('source_logical_turn_id')}
        AND ${requiredRecoveryIdentity('source_manager_id')}
        AND ${requiredRecoveryIdentity('source_message_id')}
        AND ${requiredRecoveryIdentity('owner_logical_turn_id')}
        AND ${requiredRecoveryIdentity('owner_manager_id')}
        AND ${requiredRecoveryIdentity('assigned_owner_logical_turn_id')}
        AND ${requiredRecoveryIdentity('assigned_owner_manager_id')}
        AND ${requiredRecoveryIdentity('sender_jid')}
      ),
      CONSTRAINT turn_recovery_payload_bounds CHECK (
        length(CAST(conversation_key AS BLOB)) <= 2048
        AND length(CAST(delivery_jid AS BLOB)) <= 2048
        AND length(CAST(source_logical_turn_id AS BLOB)) <= 2048
        AND length(CAST(source_manager_id AS BLOB)) <= 2048
        AND length(CAST(source_message_id AS BLOB)) <= 2048
        AND length(CAST(owner_logical_turn_id AS BLOB)) <= 2048
        AND length(CAST(owner_manager_id AS BLOB)) <= 2048
        AND length(CAST(assigned_owner_logical_turn_id AS BLOB)) <= 2048
        AND length(CAST(assigned_owner_manager_id AS BLOB)) <= 2048
        AND length(CAST(sender_jid AS BLOB)) <= 2048
        AND (replay_safety_proof_id IS NULL
          OR length(CAST(replay_safety_proof_id AS BLOB)) <= 2048)
        AND (sender_name IS NULL OR length(CAST(sender_name AS BLOB)) <= 4096)
        AND length(trim(replace(replace(replace(
          replay_text, char(9), ' '
        ), char(10), ' '), char(13), ' '))) > 0
        AND length(CAST(replay_text AS BLOB)) <= 262144
        AND (group_name IS NULL OR length(CAST(group_name AS BLOB)) <= 4096)
      ),
      CONSTRAINT turn_recovery_group_coherence CHECK (
        is_group = 1 OR group_name IS NULL
      ),
      CONSTRAINT turn_recovery_owner_separation CHECK (
        NOT (
          source_logical_turn_id = owner_logical_turn_id
          AND source_manager_id = owner_manager_id
          AND source_generation = owner_generation
        )
        AND NOT (
          source_logical_turn_id = assigned_owner_logical_turn_id
          AND source_manager_id = assigned_owner_manager_id
          AND source_generation = assigned_owner_generation
        )
      ),
      CONSTRAINT turn_recovery_last_requeue_coherence CHECK (
        (
          last_requeue_claim_token_hash IS NULL
          AND last_requeue_claim_epoch IS NULL
          AND last_requeue_backoff_seconds IS NULL
        )
        OR (
          state IN ('pending', 'exhausted')
          AND last_requeue_claim_token_hash IS NOT NULL
          AND length(last_requeue_claim_token_hash) = 64
          AND last_requeue_claim_token_hash NOT GLOB '*[^0-9a-f]*'
          AND last_requeue_claim_epoch = claim_epoch
          AND last_requeue_claim_epoch BETWEEN 1 AND 5
          AND last_requeue_backoff_seconds BETWEEN 0 AND 3600
        )
      ),
      CONSTRAINT turn_recovery_state_coherence CHECK (
        (
          state = 'blocked_unsafe'
          AND replay_safe = 0
          AND replay_safety_proof_id IS NULL
          AND attempt_count = 0
          AND claim_token IS NULL
          AND claimed_at IS NULL
          AND claim_expires_at IS NULL
          AND completed_at IS NULL
        )
        OR (
          state = 'pending'
          AND attempt_count < 5
          AND (
            replay_safe = 1
            OR (
              replay_safety_proof_id IS NOT NULL
              AND ${requiredRecoveryIdentity('replay_safety_proof_id')}
            )
          )
          AND claim_token IS NULL
          AND claimed_at IS NULL
          AND claim_expires_at IS NULL
          AND completed_at IS NULL
        )
        OR (
          state = 'claimed'
          AND attempt_count BETWEEN 1 AND 5
          AND (
            replay_safe = 1
            OR (
              replay_safety_proof_id IS NOT NULL
              AND ${requiredRecoveryIdentity('replay_safety_proof_id')}
            )
          )
          AND claim_token IS NOT NULL
          AND ${requiredRecoveryIdentity('claim_token')}
          AND claimed_at IS NOT NULL
          AND claim_expires_at IS NOT NULL
          AND completed_at IS NULL
        )
        OR (
          state = 'completed'
          AND attempt_count BETWEEN 1 AND 5
          AND (
            replay_safe = 1
            OR (
              replay_safety_proof_id IS NOT NULL
              AND ${requiredRecoveryIdentity('replay_safety_proof_id')}
            )
          )
          AND claim_token IS NOT NULL
          AND ${requiredRecoveryIdentity('claim_token')}
          AND claimed_at IS NOT NULL
          AND claim_expires_at IS NOT NULL
          AND completed_at IS NOT NULL
        )
        OR (
          state = 'exhausted'
          AND attempt_count = 5
          AND (
            replay_safe = 1
            OR (
              replay_safety_proof_id IS NOT NULL
              AND ${requiredRecoveryIdentity('replay_safety_proof_id')}
            )
          )
          AND claim_token IS NULL
          AND claimed_at IS NULL
          AND claim_expires_at IS NULL
          AND completed_at IS NULL
        )
      ),
      UNIQUE (source_inbound_seq_key, source_logical_turn_id, source_generation)
    );
`;

export function runMigration38(db: DatabaseSync): void {
  db.exec(TURN_RECOVERY_TABLE_DDL);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS turn_recovery_immutable_envelope
    BEFORE UPDATE OF
      terminal_record_id, scope, conversation_key, delivery_jid,
      source_inbound_seq, source_inbound_seq_key, source_logical_turn_id,
      source_manager_id, source_generation, source_message_id,
      owner_logical_turn_id, owner_manager_id, owner_generation,
      replay_safe, sender_jid, sender_name, replay_text, is_group, group_name,
      created_at
    ON turn_recovery_jobs
    WHEN NEW.terminal_record_id IS NOT OLD.terminal_record_id
      OR NEW.scope IS NOT OLD.scope
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.delivery_jid IS NOT OLD.delivery_jid
      OR NEW.source_inbound_seq IS NOT OLD.source_inbound_seq
      OR NEW.source_inbound_seq_key IS NOT OLD.source_inbound_seq_key
      OR NEW.source_logical_turn_id IS NOT OLD.source_logical_turn_id
      OR NEW.source_manager_id IS NOT OLD.source_manager_id
      OR NEW.source_generation IS NOT OLD.source_generation
      OR NEW.source_message_id IS NOT OLD.source_message_id
      OR NEW.owner_logical_turn_id IS NOT OLD.owner_logical_turn_id
      OR NEW.owner_manager_id IS NOT OLD.owner_manager_id
      OR NEW.owner_generation IS NOT OLD.owner_generation
      OR NEW.replay_safe IS NOT OLD.replay_safe
      OR NEW.sender_jid IS NOT OLD.sender_jid
      OR NEW.sender_name IS NOT OLD.sender_name
      OR NEW.replay_text IS NOT OLD.replay_text
      OR NEW.is_group IS NOT OLD.is_group
      OR NEW.group_name IS NOT OLD.group_name
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery immutable envelope');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_immutable_promotion_proof
    BEFORE UPDATE OF replay_safety_proof_id ON turn_recovery_jobs
    WHEN OLD.replay_safety_proof_id IS NOT NULL
      AND NEW.replay_safety_proof_id IS NOT OLD.replay_safety_proof_id
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery immutable promotion proof');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_assignment_epoch_fence
    BEFORE UPDATE OF
      assigned_owner_logical_turn_id, assigned_owner_manager_id,
      assigned_owner_generation, assignment_epoch
    ON turn_recovery_jobs
    WHEN (
      (
        NEW.assigned_owner_logical_turn_id IS NOT OLD.assigned_owner_logical_turn_id
        OR NEW.assigned_owner_manager_id IS NOT OLD.assigned_owner_manager_id
        OR NEW.assigned_owner_generation IS NOT OLD.assigned_owner_generation
      )
      AND NEW.assignment_epoch <> OLD.assignment_epoch + 1
    ) OR (
      NEW.assigned_owner_logical_turn_id IS OLD.assigned_owner_logical_turn_id
      AND NEW.assigned_owner_manager_id IS OLD.assigned_owner_manager_id
      AND NEW.assigned_owner_generation IS OLD.assigned_owner_generation
      AND NEW.assignment_epoch <> OLD.assignment_epoch
    )
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery assignment epoch fence');
    END;

    CREATE INDEX IF NOT EXISTS idx_turn_terminal_delivery_op
      ON turn_terminal_records(delivery_op_id)
      WHERE delivery_op_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_turn_recovery_state_id
      ON turn_recovery_jobs(state, id);
    CREATE INDEX IF NOT EXISTS idx_turn_recovery_owner_state
      ON turn_recovery_jobs(
        assigned_owner_logical_turn_id, assigned_owner_manager_id,
        assigned_owner_generation, state, next_attempt_at, id
      );
    CREATE INDEX IF NOT EXISTS idx_turn_recovery_stale_claim
      ON turn_recovery_jobs(state, claim_expires_at, id);
  `);
}

export function runMigration39(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_checkpoints'")
    .get() as { name: string } | undefined;
  if (!table) return;

  const columns: ReadonlyArray<readonly [string, 'TEXT' | 'INTEGER']> = [
    ['completed_inbound_seq', 'INTEGER'],
    ['completed_delivery_jid', 'TEXT'],
    ['completed_delivery_namespace', 'TEXT'],
    ['completed_scope', 'TEXT'],
    ['completed_logical_turn_id', 'TEXT'],
    ['completed_manager_id', 'TEXT'],
    ['completed_generation', 'INTEGER'],
  ];
  const existing = new Set(
    (db.prepare("PRAGMA table_info('session_checkpoints')").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const [name, type] of columns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE session_checkpoints ADD COLUMN ${name} ${type}`);
    }
  }
  const partialBundle = `
    ((completed_inbound_seq IS NOT NULL)
      + (completed_delivery_jid IS NOT NULL)
      + (completed_delivery_namespace IS NOT NULL)
      + (completed_scope IS NOT NULL)
      + (completed_logical_turn_id IS NOT NULL)
      + (completed_manager_id IS NOT NULL)
      + (completed_generation IS NOT NULL)) NOT IN (0, 7)
  `;
  db.exec(`
    DROP TRIGGER IF EXISTS session_checkpoints_completed_identity_bundle_insert;
    DROP TRIGGER IF EXISTS session_checkpoints_completed_identity_bundle_update;

    CREATE TRIGGER IF NOT EXISTS session_checkpoints_completed_identity_bundle_insert
    BEFORE INSERT ON session_checkpoints
    WHEN ${partialBundle.replaceAll('completed_', 'NEW.completed_')}
    BEGIN
      SELECT RAISE(ABORT, 'session checkpoint completed identity bundle must be all-or-none');
    END;

    CREATE TRIGGER IF NOT EXISTS session_checkpoints_completed_identity_bundle_update
    BEFORE UPDATE OF
      completed_inbound_seq, completed_delivery_jid,
      completed_delivery_namespace, completed_scope,
      completed_logical_turn_id, completed_manager_id, completed_generation
    ON session_checkpoints
    WHEN ${partialBundle.replaceAll('completed_', 'NEW.completed_')}
    BEGIN
      SELECT RAISE(ABORT, 'session checkpoint completed identity bundle must be all-or-none');
    END;
  `);
}

export function runMigration40(db: DatabaseSync): void {
  // Migration 39 originally omitted the inbound sequence from the completed
  // resume identity. Re-run its idempotent shape first so an already-recorded
  // v39 database receives the dedicated field and the seven-field trigger.
  runMigration39(db);
  const checkpointTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_checkpoints'",
  ).get() as { name: string } | undefined;
  if (checkpointTable) {
    // A six-field legacy bundle may already have been mixed with a newer
    // last_inbound_seq. Clear it rather than fabricating unsafe resume proof;
    // the next genuinely terminal turn repopulates the complete bundle.
    db.exec(`
      UPDATE session_checkpoints
      SET completed_inbound_seq = NULL,
          completed_delivery_jid = NULL,
          completed_delivery_namespace = NULL,
          completed_scope = NULL,
          completed_logical_turn_id = NULL,
          completed_manager_id = NULL,
          completed_generation = NULL
      WHERE completed_inbound_seq IS NULL
        AND (
          completed_delivery_jid IS NOT NULL
          OR completed_delivery_namespace IS NOT NULL
          OR completed_scope IS NOT NULL
          OR completed_logical_turn_id IS NOT NULL
          OR completed_manager_id IS NOT NULL
          OR completed_generation IS NOT NULL
        )
    `);
  }

  const requiredTables = ['inbound_events', 'outbound_ops', 'turn_terminal_records', 'turn_recovery_jobs'];
  const presentTables = new Set(
    (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('inbound_events', 'outbound_ops', 'turn_terminal_records', 'turn_recovery_jobs')
    `).all() as Array<{ name: string }>).map((row) => row.name),
  );
  // Historical/partial-schema fixtures can legitimately omit the durability
  // substrate. There is no recovery boundary to harden in that shape.
  if (requiredTables.some((table) => !presentTables.has(table))) return;

  const recoveryColumns = new Set(
    (db.prepare("PRAGMA table_info('turn_recovery_jobs')").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  const completionColumns: ReadonlyArray<readonly [string, string]> = [
    ['completion_kind', "TEXT CHECK (completion_kind IS NULL OR completion_kind IN ('worker', 'echo'))"],
    ['completion_proof_id', 'TEXT'],
    ['echo_conflict_at', 'TEXT'],
    ['echo_conflict_reason', 'TEXT'],
  ];
  for (const [name, type] of completionColumns) {
    if (!recoveryColumns.has(name)) {
      db.exec(`ALTER TABLE turn_recovery_jobs ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`
    UPDATE turn_recovery_jobs
    SET completion_kind = 'worker',
        completion_proof_id = 'legacy-worker:' || id || ':' || claim_epoch
    WHERE state = 'completed' AND completion_kind IS NULL
  `);

  const invalidExisting = db.prepare(`
    SELECT t.id
    FROM turn_terminal_records t
    LEFT JOIN outbound_ops o ON o.id = t.delivery_op_id
    WHERE t.inbound_disposition = 'transferred_to_recovery_owner'
      AND (
        t.delivery_kind NOT IN ('enqueued', 'flushed', 'delivery_unknown')
        OR t.inbound_seq IS NULL
        OR t.delivery_op_id IS NULL
        OR o.id IS NULL
        OR o.conversation_key <> t.conversation_key
        OR o.chat_jid <> t.delivery_jid
        OR o.source_inbound_seq IS NOT t.inbound_seq
      )
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (invalidExisting) {
    throw new Error(
      `turn recovery transfer ${invalidExisting.id} lacks matching unresolved delivery evidence`,
    );
  }

  const orphanTransfer = db.prepare(`
    SELECT t.id
    FROM turn_terminal_records t
    LEFT JOIN turn_recovery_jobs j ON j.terminal_record_id = t.id
    WHERE t.inbound_disposition = 'transferred_to_recovery_owner'
      AND j.id IS NULL
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (orphanTransfer) {
    throw new Error(
      `turn recovery transfer ${orphanTransfer.id} has no linked recovery job`,
    );
  }

  const invalidRecoveryLink = db.prepare(`
    SELECT j.id
    FROM turn_recovery_jobs j
    LEFT JOIN turn_terminal_records t ON t.id = j.terminal_record_id
    LEFT JOIN inbound_events i ON i.seq = j.source_inbound_seq
    LEFT JOIN outbound_ops o ON o.id = t.delivery_op_id
    WHERE t.id IS NULL
      OR t.inbound_disposition <> 'transferred_to_recovery_owner'
      OR t.scope IS NOT j.scope
      OR t.conversation_key IS NOT j.conversation_key
      OR t.delivery_jid IS NOT j.delivery_jid
      OR t.inbound_seq IS NOT j.source_inbound_seq
      OR t.inbound_seq_key IS NOT j.source_inbound_seq_key
      OR t.logical_turn_id IS NOT j.source_logical_turn_id
      OR t.manager_id IS NOT j.source_manager_id
      OR t.generation IS NOT j.source_generation
      OR t.recovery_owner_logical_turn_id IS NOT j.owner_logical_turn_id
      OR t.recovery_owner_manager_id IS NOT j.owner_manager_id
      OR t.recovery_owner_generation IS NOT j.owner_generation
      OR t.delivery_kind NOT IN ('enqueued', 'flushed', 'delivery_unknown')
      OR i.seq IS NULL
      OR i.message_id IS NOT j.source_message_id
      OR i.conversation_key IS NOT j.conversation_key
      OR i.chat_jid IS NOT j.delivery_jid
      OR o.id IS NULL
      OR o.source_inbound_seq IS NOT j.source_inbound_seq
      OR o.conversation_key IS NOT j.conversation_key
      OR o.chat_jid IS NOT j.delivery_jid
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (invalidRecoveryLink) {
    throw new Error(
      `turn recovery job ${invalidRecoveryLink.id} has an inconsistent proof link`,
    );
  }

  const invalidCompletedRecovery = db.prepare(`
    SELECT j.id
    FROM turn_recovery_jobs j
    JOIN inbound_events i ON i.seq = j.source_inbound_seq
    JOIN turn_terminal_records t ON t.id = j.terminal_record_id
    JOIN outbound_ops o ON o.id = t.delivery_op_id
    WHERE j.state = 'completed'
      AND (
        i.processing_status NOT IN ('complete', 'failed')
        OR o.status NOT IN ('echoed', 'failed_permanent', 'quarantined')
      )
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (invalidCompletedRecovery) {
    throw new Error(
      `turn recovery job ${invalidCompletedRecovery.id} is completed without terminal source and delivery proof`,
    );
  }

  const duplicateSelectedDelivery = db.prepare(`
    SELECT delivery_op_id
    FROM turn_terminal_records
    WHERE inbound_disposition = 'transferred_to_recovery_owner'
      AND delivery_op_id IS NOT NULL
    GROUP BY delivery_op_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get() as { delivery_op_id: number } | undefined;
  if (duplicateSelectedDelivery) {
    throw new Error(
      `turn recovery delivery ${duplicateSelectedDelivery.delivery_op_id} has multiple terminal owners`,
    );
  }

  const invalidTransfer = `
    NEW.inbound_disposition = 'transferred_to_recovery_owner'
    AND (
      NEW.delivery_kind NOT IN ('enqueued', 'flushed', 'delivery_unknown')
      OR NEW.inbound_seq IS NULL
      OR NEW.delivery_op_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM outbound_ops o
        WHERE o.id = NEW.delivery_op_id
          AND o.conversation_key = NEW.conversation_key
          AND o.chat_jid = NEW.delivery_jid
          AND o.source_inbound_seq IS NEW.inbound_seq
          AND (
            (NEW.delivery_kind = 'enqueued' AND o.status = 'pending')
            OR (NEW.delivery_kind = 'flushed' AND o.status = 'submitted')
            OR (NEW.delivery_kind = 'delivery_unknown' AND o.status = 'maybe_sent')
          )
      )
    )
  `;
  db.exec(`
    DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery;
    DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery_update;
    DROP TRIGGER IF EXISTS turn_terminal_recovery_envelope_immutable;
    DROP TRIGGER IF EXISTS turn_recovery_selected_delivery_identity_immutable;
    DROP TRIGGER IF EXISTS turn_recovery_source_inbound_identity_immutable;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_source;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_source_insert;
    DROP TRIGGER IF EXISTS turn_recovery_completion_metadata_coherent;
    DROP TRIGGER IF EXISTS turn_recovery_completion_metadata_coherent_insert;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_delivery;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_delivery_insert;
    DROP TRIGGER IF EXISTS turn_recovery_completed_source_stays_terminal;
    DROP TRIGGER IF EXISTS turn_recovery_completed_delivery_stays_terminal;
    DROP TRIGGER IF EXISTS turn_recovery_retain_source_inbound;
    DROP TRIGGER IF EXISTS turn_recovery_retain_selected_delivery;

    DROP INDEX IF EXISTS idx_turn_terminal_delivery_op;
    CREATE UNIQUE INDEX idx_turn_terminal_delivery_op
      ON turn_terminal_records(delivery_op_id)
      WHERE inbound_disposition = 'transferred_to_recovery_owner'
        AND delivery_op_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS turn_terminal_transfer_requires_delivery
    BEFORE INSERT ON turn_terminal_records
    WHEN ${invalidTransfer}
      AND NOT EXISTS (
        SELECT 1 FROM turn_terminal_records existing
        WHERE existing.inbound_seq_key = NEW.inbound_seq_key
          AND existing.logical_turn_id = NEW.logical_turn_id
          AND existing.generation = NEW.generation
      )
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery transfer requires matching unresolved delivery evidence');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_terminal_transfer_requires_delivery_update
    BEFORE UPDATE OF
      inbound_disposition, delivery_kind, delivery_op_id,
      conversation_key, delivery_jid, inbound_seq
    ON turn_terminal_records
    WHEN ${invalidTransfer}
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery transfer requires matching unresolved delivery evidence');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_terminal_recovery_envelope_immutable
    BEFORE UPDATE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1 FROM turn_recovery_jobs j WHERE j.terminal_record_id = OLD.id
    ) AND (
      NEW.scope IS NOT OLD.scope
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.delivery_jid IS NOT OLD.delivery_jid
      OR NEW.inbound_seq IS NOT OLD.inbound_seq
      OR NEW.inbound_seq_key IS NOT OLD.inbound_seq_key
      OR NEW.logical_turn_id IS NOT OLD.logical_turn_id
      OR NEW.manager_id IS NOT OLD.manager_id
      OR NEW.generation IS NOT OLD.generation
      OR NEW.attempt_kind IS NOT OLD.attempt_kind
      OR NEW.attempt_failure_class IS NOT OLD.attempt_failure_class
      OR NEW.inbound_disposition IS NOT OLD.inbound_disposition
      OR NEW.delivery_kind IS NOT OLD.delivery_kind
      OR NEW.delivery_op_id IS NOT OLD.delivery_op_id
      OR NEW.recovery_owner_logical_turn_id IS NOT OLD.recovery_owner_logical_turn_id
      OR NEW.recovery_owner_manager_id IS NOT OLD.recovery_owner_manager_id
      OR NEW.recovery_owner_generation IS NOT OLD.recovery_owner_generation
      OR NEW.reply_guarantee_disarmed IS NOT OLD.reply_guarantee_disarmed
      OR NEW.created_at IS NOT OLD.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'linked turn recovery terminal envelope is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_selected_delivery_identity_immutable
    BEFORE UPDATE OF conversation_key, chat_jid, source_inbound_seq ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM turn_recovery_jobs j
      JOIN turn_terminal_records t ON t.id = j.terminal_record_id
      WHERE t.delivery_op_id = OLD.id
    ) AND (
      NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.chat_jid IS NOT OLD.chat_jid
      OR NEW.source_inbound_seq IS NOT OLD.source_inbound_seq
    )
    BEGIN
      SELECT RAISE(ABORT, 'selected turn recovery delivery identity is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_source_inbound_identity_immutable
    BEFORE UPDATE OF message_id, conversation_key, chat_jid ON inbound_events
    WHEN EXISTS (
      SELECT 1 FROM turn_recovery_jobs j WHERE j.source_inbound_seq = OLD.seq
    ) AND (
      NEW.message_id IS NOT OLD.message_id
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.chat_jid IS NOT OLD.chat_jid
    )
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery source inbound identity is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_requires_terminal_source
    BEFORE UPDATE OF state ON turn_recovery_jobs
    WHEN NEW.state = 'completed'
      AND OLD.state <> 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM inbound_events i
        WHERE i.seq = NEW.source_inbound_seq
          AND i.processing_status IN ('complete', 'failed')
      )
    BEGIN
      SELECT RAISE(ABORT, 'recovery source inbound must be terminal before completion');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_requires_terminal_source_insert
    BEFORE INSERT ON turn_recovery_jobs
    WHEN NEW.state = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM inbound_events i
        WHERE i.seq = NEW.source_inbound_seq
          AND i.processing_status IN ('complete', 'failed')
      )
    BEGIN
      SELECT RAISE(ABORT, 'recovery source inbound must be terminal before completion');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_metadata_coherent
    BEFORE UPDATE OF state, completion_kind, completion_proof_id ON turn_recovery_jobs
    WHEN (
      NEW.state = 'completed'
      AND (
        NEW.completion_kind NOT IN ('worker', 'echo')
        OR NEW.completion_proof_id IS NULL
        OR length(trim(NEW.completion_proof_id)) = 0
        OR length(CAST(NEW.completion_proof_id AS BLOB)) > 2048
      )
    ) OR (
      NEW.state <> 'completed'
      AND (NEW.completion_kind IS NOT NULL OR NEW.completion_proof_id IS NOT NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'recovery completion metadata is incoherent');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_metadata_coherent_insert
    BEFORE INSERT ON turn_recovery_jobs
    WHEN (
      NEW.state = 'completed'
      AND (
        NEW.completion_kind NOT IN ('worker', 'echo')
        OR NEW.completion_proof_id IS NULL
        OR length(trim(NEW.completion_proof_id)) = 0
        OR length(CAST(NEW.completion_proof_id AS BLOB)) > 2048
      )
    ) OR (
      NEW.state <> 'completed'
      AND (NEW.completion_kind IS NOT NULL OR NEW.completion_proof_id IS NOT NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'recovery completion metadata is incoherent');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_requires_terminal_delivery
    BEFORE UPDATE OF state ON turn_recovery_jobs
    WHEN NEW.state = 'completed'
      AND OLD.state <> 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM turn_terminal_records t
        JOIN outbound_ops o ON o.id = t.delivery_op_id
        WHERE t.id = NEW.terminal_record_id
          AND t.inbound_disposition = 'transferred_to_recovery_owner'
          AND t.scope = NEW.scope
          AND t.inbound_seq = NEW.source_inbound_seq
          AND t.conversation_key = NEW.conversation_key
          AND t.delivery_jid = NEW.delivery_jid
          AND o.source_inbound_seq = NEW.source_inbound_seq
          AND o.conversation_key = NEW.conversation_key
          AND o.chat_jid = NEW.delivery_jid
          AND o.status IN ('echoed', 'failed_permanent', 'quarantined')
      )
    BEGIN
      SELECT RAISE(ABORT, 'recovery selected delivery must be terminal before completion');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_requires_terminal_delivery_insert
    BEFORE INSERT ON turn_recovery_jobs
    WHEN NEW.state = 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM turn_terminal_records t
        JOIN outbound_ops o ON o.id = t.delivery_op_id
        WHERE t.id = NEW.terminal_record_id
          AND t.inbound_disposition = 'transferred_to_recovery_owner'
          AND t.scope = NEW.scope
          AND t.inbound_seq = NEW.source_inbound_seq
          AND t.conversation_key = NEW.conversation_key
          AND t.delivery_jid = NEW.delivery_jid
          AND o.source_inbound_seq = NEW.source_inbound_seq
          AND o.conversation_key = NEW.conversation_key
          AND o.chat_jid = NEW.delivery_jid
          AND o.status IN ('echoed', 'failed_permanent', 'quarantined')
      )
    BEGIN
      SELECT RAISE(ABORT, 'recovery selected delivery must be terminal before completion');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completed_source_stays_terminal
    BEFORE UPDATE OF processing_status ON inbound_events
    WHEN NEW.processing_status NOT IN ('complete', 'failed')
      AND EXISTS (
        SELECT 1 FROM turn_recovery_jobs j
        WHERE j.source_inbound_seq = OLD.seq AND j.state = 'completed'
      )
    BEGIN
      SELECT RAISE(ABORT, 'completed recovery source inbound must stay terminal');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completed_delivery_stays_terminal
    BEFORE UPDATE OF status ON outbound_ops
    WHEN NEW.status NOT IN ('echoed', 'failed_permanent', 'quarantined')
      AND EXISTS (
        SELECT 1
        FROM turn_recovery_jobs j
        JOIN turn_terminal_records t ON t.id = j.terminal_record_id
        WHERE t.delivery_op_id = OLD.id AND j.state = 'completed'
      )
    BEGIN
      SELECT RAISE(ABORT, 'completed recovery selected delivery must stay terminal');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_retain_source_inbound
    BEFORE DELETE ON inbound_events
    WHEN EXISTS (
      SELECT 1 FROM turn_recovery_jobs j
      WHERE j.source_inbound_seq = OLD.seq
    )
    BEGIN
      SELECT RAISE(ABORT, 'cannot delete outstanding recovery proof source inbound');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_retain_selected_delivery
    BEFORE DELETE ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM turn_recovery_jobs j
      JOIN turn_terminal_records t ON t.id = j.terminal_record_id
      WHERE t.delivery_op_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'cannot delete outstanding recovery proof selected delivery');
    END;
  `);
}
