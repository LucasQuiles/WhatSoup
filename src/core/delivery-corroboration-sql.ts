function sqlAlias(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error('delivery corroboration SQL alias must be an identifier');
  }
  return value;
}

/**
 * Canonical semantic proof for a selected delivery: an append-only
 * corroboration row whose candidate is a later echoed operation for the same
 * source inbound, conversation, and destination.
 */
export function validDeliveryCorroborationForTerminalSql(terminalAlias: string): string {
  const terminal = sqlAlias(terminalAlias);
  return `EXISTS (
    SELECT 1
    FROM outbound_ops selected
    JOIN turn_delivery_corroboration corroboration
      ON corroboration.terminal_record_id = ${terminal}.id
     AND corroboration.basis = 'same_source_later_echoed_op'
    JOIN outbound_ops candidate
      ON candidate.id = corroboration.corroborating_op_id
     AND candidate.source_inbound_seq = selected.source_inbound_seq
     AND candidate.conversation_key = selected.conversation_key
     AND candidate.chat_jid = selected.chat_jid
     AND candidate.status = 'echoed'
     AND candidate.id > selected.id
    WHERE selected.id = ${terminal}.delivery_op_id
      AND ${terminal}.delivery_kind = 'delivery_unknown'
      AND ${terminal}.inbound_seq IS NOT NULL
      AND ${terminal}.inbound_seq_key = ${terminal}.inbound_seq
      AND selected.source_inbound_seq = ${terminal}.inbound_seq
      AND selected.conversation_key = ${terminal}.conversation_key
      AND selected.chat_jid = ${terminal}.delivery_jid
      AND selected.is_terminal = 1
  )`;
}

/** One row per selected operation with at least one semantically valid proof. */
export function validDeliveryCorroboratedSelectedOpsSql(): string {
  return `SELECT DISTINCT selected.id AS selected_op_id
    FROM turn_delivery_corroboration corroboration
    JOIN turn_terminal_records terminal
      ON terminal.id = corroboration.terminal_record_id
     AND terminal.delivery_kind = 'delivery_unknown'
     AND terminal.inbound_seq IS NOT NULL
     AND terminal.inbound_seq_key = terminal.inbound_seq
    JOIN outbound_ops selected
      ON selected.id = terminal.delivery_op_id
     AND selected.source_inbound_seq = terminal.inbound_seq
     AND selected.conversation_key = terminal.conversation_key
     AND selected.chat_jid = terminal.delivery_jid
     AND selected.is_terminal = 1
    JOIN outbound_ops candidate
      ON candidate.id = corroboration.corroborating_op_id
     AND candidate.source_inbound_seq = selected.source_inbound_seq
     AND candidate.conversation_key = selected.conversation_key
     AND candidate.chat_jid = selected.chat_jid
     AND candidate.status = 'echoed'
     AND candidate.id > selected.id
    WHERE corroboration.basis = 'same_source_later_echoed_op'`;
}

export function validDeliveryCorroborationForJobSql(jobAlias: string): string {
  const job = sqlAlias(jobAlias);
  return `EXISTS (
    SELECT 1
    FROM turn_terminal_records terminal
    WHERE terminal.id = ${job}.terminal_record_id
      AND ${validDeliveryCorroborationForTerminalSql('terminal')}
  )`;
}
