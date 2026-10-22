/**
 * #3295 S4: detect a session checkpoint whose completed identity names an
 * admission-rejected terminal record. Such a turn never crossed the provider
 * boundary, so the checkpoint is not resumable until a later completed turn
 * replaces the identity. These identities were written before the turn
 * finalization contract stopped deriving them; this module only reads.
 */
import type { Database } from '../../core/database.ts';

/**
 * SQL predicate over a `session_checkpoints` row aliased `checkpoint`. It
 * matches the full completed identity, so a later valid turn that reuses the
 * inbound sequence under another logical turn is never excluded.
 */
export const COMPLETED_IDENTITY_IS_ADMISSION_REJECTED_SQL = `EXISTS (
  SELECT 1
  FROM turn_terminal_records AS terminal
  WHERE terminal.attempt_kind = 'admission_rejected'
    AND terminal.conversation_key = checkpoint.conversation_key
    AND terminal.scope = checkpoint.completed_scope
    AND terminal.delivery_jid = checkpoint.completed_delivery_jid
    AND terminal.inbound_seq = checkpoint.completed_inbound_seq
    AND terminal.logical_turn_id = checkpoint.completed_logical_turn_id
    AND terminal.manager_id = checkpoint.completed_manager_id
    AND terminal.generation = checkpoint.completed_generation
)`;

export interface CompletedCheckpointIdentityRow {
  conversation_key: string;
  completed_scope: string | null;
  completed_delivery_jid: string | null;
  completed_inbound_seq: number | null;
  completed_logical_turn_id: string | null;
  completed_manager_id: string | null;
  completed_generation: number | null;
}

/** Whether this checkpoint's completed identity is an admission-rejected turn. */
export function checkpointCompletedIdentityIsAdmissionRejected(
  db: Database,
  checkpoint: CompletedCheckpointIdentityRow,
): boolean {
  const row = db.raw.prepare(
    `SELECT 1 AS rejected
     FROM (
       SELECT ? AS conversation_key, ? AS completed_scope, ? AS completed_delivery_jid,
              ? AS completed_inbound_seq, ? AS completed_logical_turn_id,
              ? AS completed_manager_id, ? AS completed_generation
     ) AS checkpoint
     WHERE ${COMPLETED_IDENTITY_IS_ADMISSION_REJECTED_SQL}`,
  ).get(
    checkpoint.conversation_key,
    checkpoint.completed_scope,
    checkpoint.completed_delivery_jid,
    checkpoint.completed_inbound_seq,
    checkpoint.completed_logical_turn_id,
    checkpoint.completed_manager_id,
    checkpoint.completed_generation,
  );
  return row !== undefined;
}
