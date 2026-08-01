import type { DatabaseSync } from 'node:sqlite';

const REQUIRED_CHECKPOINT_COLUMNS = [
  'id',
  'session_id',
  'session_status',
  'completed_inbound_seq',
  'completed_delivery_jid',
  'completed_delivery_namespace',
  'completed_scope',
  'completed_logical_turn_id',
  'completed_manager_id',
  'completed_generation',
  'checkpoint_version',
  'updated_at',
] as const;

function hasCompleteCheckpointSchema(db: DatabaseSync): boolean {
  const columns = new Set((db.prepare("PRAGMA table_info('session_checkpoints')").all() as Array<{
    name: string;
  }>).map(({ name }) => name));
  if (columns.size === 0) return false;
  const missing = REQUIRED_CHECKPOINT_COLUMNS.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new Error(`migration 53 session_checkpoints missing required columns: ${missing.join(', ')}`);
  }
  return true;
}

/**
 * Adds a bounded, content-free admission ledger for completed-delivery identity
 * failures. Older active/suspended/orphaned checkpoints that cannot contain a complete
 * proof bundle are quarantined once; semantic validation remains a runtime
 * responsibility because it depends on canonical WhatsApp identity parsing.
 */
export function runMigration54(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS completed_delivery_identity_admissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_kind TEXT NOT NULL
        CHECK (target_kind IN ('checkpoint', 'agent_session')),
      target_id INTEGER NOT NULL
        CHECK (typeof(target_id) = 'integer' AND target_id > 0),
      state TEXT NOT NULL DEFAULT 'quarantined'
        CHECK (state IN ('quarantined', 'resolved')),
      reason TEXT NOT NULL
        CHECK (reason IN ('missing', 'invalid', 'scope_mismatch')),
      attempts INTEGER NOT NULL DEFAULT 1
        CHECK (typeof(attempts) = 'integer' AND attempts = 1),
      owner TEXT NOT NULL DEFAULT 'fresh_inbound'
        CHECK (owner IN ('fresh_inbound', 'operator')),
      next_action TEXT NOT NULL DEFAULT 'fresh_inbound'
        CHECK (next_action IN ('fresh_inbound', 'operator')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_transition_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      CHECK (
        (state = 'quarantined' AND resolved_at IS NULL)
        OR (state = 'resolved' AND resolved_at IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_completed_delivery_identity_admissions_open_transition
      ON completed_delivery_identity_admissions(state, last_transition_at)
      WHERE state = 'quarantined';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_completed_delivery_identity_admissions_one_open_target
      ON completed_delivery_identity_admissions(target_kind, target_id)
      WHERE state = 'quarantined';
  `);

  // Isolated historical migration fixtures may intentionally omit durable
  // checkpoint state altogether. Create the content-free ledger, but only
  // backfill when the table is present and has the full prior schema. An
  // extant partial table remains a fail-closed migration error.
  if (!hasCompleteCheckpointSchema(db)) return;

  db.prepare(`
    INSERT OR IGNORE INTO completed_delivery_identity_admissions (
      target_kind, target_id, state, reason, attempts, owner, next_action
    )
    SELECT 'checkpoint', id, 'quarantined', 'missing', 1, 'fresh_inbound', 'fresh_inbound'
    FROM session_checkpoints
    WHERE session_status IN ('active', 'suspended', 'orphaned')
      AND session_id IS NOT NULL
      AND (
        completed_inbound_seq IS NULL
        OR completed_delivery_jid IS NULL
        OR completed_delivery_namespace IS NULL
        OR completed_scope IS NULL
        OR completed_logical_turn_id IS NULL
        OR completed_manager_id IS NULL
        OR completed_generation IS NULL
      )
  `).run();

  db.prepare(`
    UPDATE session_checkpoints
    SET session_status = 'orphaned',
        checkpoint_version = checkpoint_version + 1,
        updated_at = datetime('now')
    WHERE session_status IN ('active', 'suspended')
      AND id IN (
        SELECT target_id
        FROM completed_delivery_identity_admissions
        WHERE target_kind = 'checkpoint' AND state = 'quarantined'
      )
  `).run();
}
