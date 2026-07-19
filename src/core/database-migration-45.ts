import type { DatabaseSync } from 'node:sqlite';

// ─── Migration 45: outbound_op_message_ids + payload-hash dedup index ───────
//
// M1 (outbound replay termination): markSubmitted used to OVERWRITE
// outbound_ops.wa_message_id on every resend, destroying the echo-reconciliation
// key for previously submitted copies — a resent op could never confirm via an
// echo of an earlier submission, so maybe_sent never converged. The side table
// keeps EVERY historical wa_message_id per op (backfilled from existing rows);
// echo matching and recovery join against it. The (chat_jid, payload_hash,
// status) index supports the durable duplicate-suppression check (payload_hash
// was previously written but never consulted).

const MIGRATION_45_OUTBOUND_OP_MESSAGE_IDS = `
CREATE TABLE IF NOT EXISTS outbound_op_message_ids (
  op_id INTEGER NOT NULL REFERENCES outbound_ops(id),
  wa_message_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (op_id, wa_message_id)
);

CREATE INDEX IF NOT EXISTS idx_outbound_op_message_ids_wa
  ON outbound_op_message_ids(wa_message_id);

CREATE INDEX IF NOT EXISTS idx_outbound_ops_chat_hash_status
  ON outbound_ops(chat_jid, payload_hash, status);

INSERT OR IGNORE INTO outbound_op_message_ids (op_id, wa_message_id, submitted_at)
SELECT id, wa_message_id, COALESCE(submitted_at, created_at)
FROM outbound_ops
WHERE wa_message_id IS NOT NULL;
`;

export function runMigration45(db: DatabaseSync): void {
  // Legacy partial-state databases (pre-durability bootstraps) may lack
  // outbound_ops entirely; skip — the side table is meaningless without it
  // (same guard discipline as migration 44's agent_sessions check).
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbound_ops'")
    .get() as { name: string } | undefined;
  if (!table) return;

  db.exec(MIGRATION_45_OUTBOUND_OP_MESSAGE_IDS);
}
