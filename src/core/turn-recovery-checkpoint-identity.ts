/**
 * Late-echo completed identity. A completed per-chat turn that was transferred
 * to a recovery owner while its answer awaited the echo is finalized without a
 * completed checkpoint identity. When the echo settles the recovery job, this
 * statement records that identity in the same transaction.
 *
 * It requires the stored outgoing message for the op's exact conversation and
 * delivery chat, and exactly one outbound op claiming that WhatsApp message.
 * The checkpoint must still end at that inbound and delivery, in a live session
 * for the conversation, with no active turn and no newer completed identity.
 * Otherwise it changes nothing. Bind the outbound op ID.
 */
export function promoteEchoedCheckpointIdentitySql(validRecoveryJobFrom: string): string {
  return `
    UPDATE session_checkpoints AS checkpoint
    SET completed_inbound_seq = proof.inbound_seq,
        completed_delivery_jid = proof.delivery_jid,
        completed_delivery_namespace = substr(proof.delivery_jid, instr(proof.delivery_jid, '@') + 1),
        completed_scope = proof.scope,
        completed_logical_turn_id = proof.logical_turn_id,
        completed_manager_id = proof.manager_id,
        completed_generation = proof.generation,
        checkpoint_version = checkpoint.checkpoint_version + 1,
        updated_at = datetime('now')
    FROM (
      SELECT t.inbound_seq, t.delivery_jid, t.scope, t.logical_turn_id,
             t.manager_id, t.generation, t.conversation_key, o.id AS outbound_op_id
      ${validRecoveryJobFrom}
      JOIN messages m
        ON m.message_id = o.wa_message_id
       AND m.is_from_me = 1
       AND m.conversation_key = o.conversation_key
       AND m.chat_jid = o.chat_jid
      WHERE o.id = ?
        AND o.status = 'echoed' AND o.echoed_at IS NOT NULL AND o.is_terminal = 1
        AND (SELECT COUNT(*) FROM outbound_ops claim WHERE claim.wa_message_id = o.wa_message_id) = 1
        AND t.scope = 'per_chat' AND t.attempt_kind = 'completed'
        AND j.state = 'completed' AND j.completion_kind = 'echo'
        AND j.completion_proof_id = 'outbound-op:' || o.id
        AND j.echo_conflict_at IS NULL
        AND i.processing_status = 'complete' AND i.terminal_reason = 'response_echoed'
    ) AS proof
    WHERE checkpoint.conversation_key = proof.conversation_key
      AND checkpoint.last_inbound_seq = proof.inbound_seq
      AND checkpoint.last_flushed_outbound_id = proof.outbound_op_id
      AND checkpoint.active_turn_id IS NULL
      AND checkpoint.session_status IN ('active', 'suspended', 'orphaned')
      AND EXISTS (
        SELECT 1 FROM agent_sessions session
        WHERE session.session_id = checkpoint.session_id
          AND session.workspace_key = checkpoint.conversation_key
          AND session.status IN ('active', 'suspended')
      )
      AND (checkpoint.completed_inbound_seq IS NULL
           OR checkpoint.completed_inbound_seq < proof.inbound_seq)
  `;
}
