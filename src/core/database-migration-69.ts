import type { DatabaseSync } from 'node:sqlite';
import { notOperatorCatchupSql } from './delivery-corroboration-sql.ts';

export const OPERATOR_CATCHUP_PROOF_SQL = `
  SELECT op.id
  FROM outbound_ops op
  JOIN inbound_events source ON source.seq = op.source_inbound_seq
  JOIN inbound_disposition_links pending ON pending.inbound_seq = source.seq
  WHERE op.id = $opId AND source.seq = $sourceSeq
    AND pending.recovery_plan_id = $planId
    AND pending.disposition = 'recovery_pending_operator_catchup'
    AND op.conversation_key = source.conversation_key AND op.chat_jid = source.chat_jid
    AND op.op_type = 'text' AND op.is_terminal = 0 AND op.replay_policy = 'unsafe'
    AND json_valid(op.payload)
    AND json_extract(op.payload, '$.operatorCatchup.planId') = $planId
    AND json_extract(op.payload, '$.operatorCatchup.sourceSeq') = $sourceSeq
    AND length(trim(json_extract(op.payload, '$.operatorCatchup.actor'))) > 0
    AND length(trim(json_extract(op.payload, '$.operatorCatchup.evidenceRef'))) > 0
    AND op.status = 'echoed' AND length(trim(op.wa_message_id)) > 0
    AND julianday(op.created_at) >= julianday(pending.created_at)
    AND julianday(op.created_at) >= julianday(source.received_at)
    AND julianday(op.submitted_at) >= julianday(op.created_at)
    AND julianday(op.echoed_at) >= julianday(op.submitted_at)
    AND NOT EXISTS (
      SELECT 1 FROM inbound_disposition_links closed
      WHERE closed.inbound_seq = source.seq
        AND closed.recovery_plan_id = pending.recovery_plan_id
        AND closed.disposition = 'superseded_by_operator_catchup'
    )
`;

const proofForInsert = OPERATOR_CATCHUP_PROOF_SQL
  .replaceAll('$opId', 'NEW.outbound_op_id')
  .replaceAll('$sourceSeq', 'NEW.source_seq')
  .replaceAll('$planId', 'NEW.recovery_plan_id');

const OBJECTS: ReadonlyArray<[string, string]> = [
  ['operator_catchup_resolution_fulfillment_required', `CREATE TRIGGER operator_catchup_resolution_fulfillment_required
    BEFORE INSERT ON inbound_disposition_links
    WHEN NEW.disposition = 'superseded_by_operator_catchup'
      AND NEW.original_fulfillment_confirmed <> 1
    BEGIN SELECT RAISE(ABORT, 'Original request fulfillment must be confirmed'); END`],
  ['operator_catchup_resolution_no_corroboration', `CREATE TRIGGER operator_catchup_resolution_no_corroboration
    BEFORE INSERT ON turn_delivery_corroboration
    WHEN EXISTS (SELECT 1 FROM outbound_ops candidate
      WHERE candidate.id = NEW.corroborating_op_id AND NOT (${notOperatorCatchupSql('candidate')}))
    BEGIN SELECT RAISE(ABORT, 'Operator catch-up cannot corroborate the original delivery'); END`],
  ['operator_catchup_resolutions', `CREATE TABLE operator_catchup_resolutions (
    recovery_plan_id TEXT NOT NULL REFERENCES recovery_plans(plan_id) ON DELETE RESTRICT,
    source_seq INTEGER NOT NULL REFERENCES inbound_events(seq) ON DELETE RESTRICT,
    outbound_op_id INTEGER NOT NULL UNIQUE REFERENCES outbound_ops(id) ON DELETE RESTRICT,
    actor TEXT NOT NULL CHECK(length(trim(actor)) > 0 AND length(CAST(actor AS BLOB)) <= 2048),
    evidence_ref TEXT NOT NULL CHECK(length(trim(evidence_ref)) > 0 AND length(CAST(evidence_ref AS BLOB)) <= 8192),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (recovery_plan_id, source_seq)
  )`],
  ['operator_catchup_resolution_validate', `CREATE TRIGGER operator_catchup_resolution_validate
    BEFORE INSERT ON operator_catchup_resolutions
    WHEN NOT EXISTS (${proofForInsert})
    BEGIN SELECT RAISE(ABORT, 'Operator catch-up requires its bound echoed operation'); END`],
  ['operator_catchup_resolution_no_update', `CREATE TRIGGER operator_catchup_resolution_no_update
    BEFORE UPDATE ON operator_catchup_resolutions
    BEGIN SELECT RAISE(ABORT, 'Operator catch-up resolution is append-only'); END`],
  ['operator_catchup_resolution_no_delete', `CREATE TRIGGER operator_catchup_resolution_no_delete
    BEFORE DELETE ON operator_catchup_resolutions
    BEGIN SELECT RAISE(ABORT, 'Operator catch-up resolution is append-only'); END`],
  ['operator_catchup_resolution_no_replace', `CREATE TRIGGER operator_catchup_resolution_no_replace
    BEFORE INSERT ON operator_catchup_resolutions
    WHEN EXISTS (
      SELECT 1 FROM operator_catchup_resolutions existing
      WHERE (existing.recovery_plan_id = NEW.recovery_plan_id AND existing.source_seq = NEW.source_seq)
        OR existing.outbound_op_id = NEW.outbound_op_id
    )
    BEGIN SELECT RAISE(ABORT, 'Operator catch-up resolution is append-only'); END`],
  ['operator_catchup_resolution_outbound_immutable', `CREATE TRIGGER operator_catchup_resolution_outbound_immutable
    BEFORE UPDATE OF conversation_key, chat_jid, source_inbound_seq, op_type, payload,
      is_terminal, replay_policy, status, wa_message_id, created_at, submitted_at, echoed_at ON outbound_ops
    WHEN EXISTS (SELECT 1 FROM operator_catchup_resolutions WHERE outbound_op_id = OLD.id)
      AND (NEW.conversation_key IS NOT OLD.conversation_key OR NEW.chat_jid IS NOT OLD.chat_jid
        OR NEW.source_inbound_seq IS NOT OLD.source_inbound_seq OR NEW.op_type IS NOT OLD.op_type
        OR NEW.payload IS NOT OLD.payload OR NEW.is_terminal IS NOT OLD.is_terminal
        OR NEW.replay_policy IS NOT OLD.replay_policy OR NEW.status IS NOT OLD.status
        OR NEW.wa_message_id IS NOT OLD.wa_message_id OR NEW.created_at IS NOT OLD.created_at
        OR NEW.submitted_at IS NOT OLD.submitted_at OR NEW.echoed_at IS NOT OLD.echoed_at)
    BEGIN SELECT RAISE(ABORT, 'Operator catch-up delivery proof is immutable'); END`],
  ['operator_catchup_resolution_source_immutable', `CREATE TRIGGER operator_catchup_resolution_source_immutable
    BEFORE UPDATE OF conversation_key, chat_jid, message_id, received_at ON inbound_events
    WHEN EXISTS (SELECT 1 FROM operator_catchup_resolutions WHERE source_seq = OLD.seq)
      AND (NEW.conversation_key IS NOT OLD.conversation_key OR NEW.chat_jid IS NOT OLD.chat_jid
        OR NEW.message_id IS NOT OLD.message_id OR NEW.received_at IS NOT OLD.received_at)
    BEGIN SELECT RAISE(ABORT, 'Operator catch-up source identity is immutable'); END`],
  ['operator_catchup_resolution_no_legacy_close', `CREATE TRIGGER operator_catchup_resolution_no_legacy_close
    BEFORE INSERT ON inbound_disposition_links
    WHEN NEW.disposition = 'superseded_by_operator_catchup' AND EXISTS (
      SELECT 1 FROM operator_catchup_resolutions
      WHERE recovery_plan_id = NEW.recovery_plan_id AND source_seq = NEW.inbound_seq
    )
    BEGIN SELECT RAISE(ABORT, 'Operator catch-up source already resolved'); END`],
];

export function runMigration69(db: DatabaseSync): void {
  db.exec('SAVEPOINT migration_69');
  try {
    db.exec(`ALTER TABLE inbound_disposition_links ADD COLUMN original_fulfillment_confirmed
      INTEGER NOT NULL DEFAULT 0 CHECK(original_fulfillment_confirmed IN (0, 1))`);
    for (const [, sql] of OBJECTS) db.exec(sql);
    db.exec('RELEASE migration_69');
  } catch (error) {
    db.exec('ROLLBACK TO migration_69');
    db.exec('RELEASE migration_69');
    throw error;
  }
}

export function assertOperatorCatchupResolutionSchema(db: DatabaseSync): void {
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 69').get()) {
    throw new Error('Operator catch-up resolution requires schema 69');
  }
  const fulfillment = db.prepare("SELECT type, \"notnull\", dflt_value FROM pragma_table_info('inbound_disposition_links') WHERE name = 'original_fulfillment_confirmed'").get() as
    { type: string; notnull: number; dflt_value: string } | undefined;
  if (!fulfillment || fulfillment.type !== 'INTEGER' || fulfillment.notnull !== 1 || fulfillment.dflt_value !== '0') {
    throw new Error('Operator catch-up fulfillment schema drift');
  }
  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  for (const [name, sql] of OBJECTS) {
    const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string } | undefined;
    if (!row || normalize(row.sql) !== normalize(sql)) throw new Error('Operator catch-up resolution schema drift');
  }
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  if (foreignKeys.foreign_keys !== 1) throw new Error('Operator catch-up resolution requires foreign keys');
}
