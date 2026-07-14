import type { DatabaseSync } from 'node:sqlite';

const REQUIRED_TABLES = [
  'inbound_events',
  'outbound_ops',
  'turn_terminal_records',
  'turn_recovery_jobs',
  'recovery_plans',
  'inbound_disposition_links',
  'turn_delivery_corroboration',
] as const;

/**
 * Extend operator catch-up closure proof to the durability engine's second
 * legitimate echo path: a transferred terminal whose selected delivery was
 * later echoed and whose recovery job was completed by that exact echo.
 */
export function runMigration42(db: DatabaseSync): void {
  const presentTables = new Set(
    (db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'inbound_events', 'outbound_ops', 'turn_terminal_records',
          'turn_recovery_jobs', 'recovery_plans', 'inbound_disposition_links',
          'turn_delivery_corroboration'
        )
    `).all() as Array<{ name: string }>).map((row) => row.name),
  );
  const missingTables = REQUIRED_TABLES.filter((table) => !presentTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`migration 42 missing required tables: ${missingTables.join(', ')}`);
  }

  db.exec(`
    DROP TRIGGER IF EXISTS inbound_disposition_closure_validate_insert;
    DROP TRIGGER IF EXISTS operator_catchup_terminal_proof_immutable;
    DROP TRIGGER IF EXISTS operator_catchup_terminal_proof_retain;
    DROP TRIGGER IF EXISTS operator_catchup_selected_outbound_proof_immutable;
    DROP TRIGGER IF EXISTS operator_catchup_selected_outbound_proof_retain;
    DROP TRIGGER IF EXISTS operator_catchup_recovery_job_proof_immutable;
    DROP TRIGGER IF EXISTS operator_catchup_recovery_job_proof_retain;
    DROP VIEW IF EXISTS operator_catchup_delivery_proofs;
    DROP VIEW IF EXISTS operator_catchup_delivery_proof_candidates;

    -- One glass-box predicate is shared by application lookup, admission, and
    -- proof retention so those enforcement layers cannot drift apart.
    CREATE VIEW operator_catchup_delivery_proof_candidates AS
    SELECT
      target.seq AS target_seq,
      target.conversation_key,
      target.chat_jid,
      terminal.id AS terminal_record_id,
      selected.id AS selected_op_id,
      NULL AS recovery_job_id,
      CASE
        WHEN terminal.delivery_kind = 'echoed' AND selected.status = 'echoed'
          THEN 'selected_echoed'
        ELSE 'selected_corroborated'
      END AS evidence_basis
    FROM inbound_events target
    JOIN turn_terminal_records terminal
      ON terminal.inbound_seq = target.seq
     AND terminal.inbound_seq_key = target.seq
     AND terminal.conversation_key = target.conversation_key
     AND terminal.delivery_jid = target.chat_jid
    JOIN outbound_ops selected
      ON selected.id = terminal.delivery_op_id
     AND selected.source_inbound_seq = target.seq
     AND selected.conversation_key = target.conversation_key
     AND selected.chat_jid = target.chat_jid
     AND selected.is_terminal = 1
    WHERE target.processing_status = 'complete'
      AND target.completed_at IS NOT NULL
      AND terminal.inbound_disposition = 'finalized_replied'
      AND (
        (terminal.delivery_kind = 'echoed' AND selected.status = 'echoed')
        OR (
          terminal.delivery_kind = 'delivery_unknown'
          AND EXISTS (
            SELECT 1
            FROM turn_delivery_corroboration proof
            JOIN outbound_ops corroborating
              ON corroborating.id = proof.corroborating_op_id
            WHERE proof.terminal_record_id = terminal.id
              AND selected.source_inbound_seq IS NOT NULL
              AND corroborating.source_inbound_seq = selected.source_inbound_seq
              AND corroborating.conversation_key = selected.conversation_key
              AND corroborating.chat_jid = selected.chat_jid
              AND corroborating.status = 'echoed'
              AND corroborating.id > selected.id
          )
        )
      )

    UNION ALL

    SELECT
      target.seq AS target_seq,
      target.conversation_key,
      target.chat_jid,
      terminal.id AS terminal_record_id,
      selected.id AS selected_op_id,
      recovery.id AS recovery_job_id,
      'selected_echoed_recovery' AS evidence_basis
    FROM inbound_events target
    JOIN turn_terminal_records terminal
      ON terminal.inbound_seq = target.seq
     AND terminal.inbound_seq_key = target.seq
     AND terminal.conversation_key = target.conversation_key
     AND terminal.delivery_jid = target.chat_jid
    JOIN outbound_ops selected
      ON selected.id = terminal.delivery_op_id
     AND selected.source_inbound_seq = target.seq
     AND selected.conversation_key = target.conversation_key
     AND selected.chat_jid = target.chat_jid
     AND selected.is_terminal = 1
     AND selected.status = 'echoed'
    JOIN turn_recovery_jobs recovery
      ON recovery.terminal_record_id = terminal.id
     AND recovery.scope = terminal.scope
     AND recovery.conversation_key = target.conversation_key
     AND recovery.delivery_jid = target.chat_jid
     AND recovery.source_inbound_seq = target.seq
     AND recovery.source_inbound_seq_key = target.seq
     AND recovery.source_logical_turn_id = terminal.logical_turn_id
     AND recovery.source_manager_id = terminal.manager_id
     AND recovery.source_generation = terminal.generation
     AND recovery.source_message_id = target.message_id
     AND recovery.owner_logical_turn_id = terminal.recovery_owner_logical_turn_id
     AND recovery.owner_manager_id = terminal.recovery_owner_manager_id
     AND recovery.owner_generation = terminal.recovery_owner_generation
    WHERE target.processing_status = 'complete'
      AND target.completed_at IS NOT NULL
      AND terminal.inbound_disposition = 'transferred_to_recovery_owner'
      AND terminal.delivery_kind IN ('enqueued', 'flushed', 'delivery_unknown')
      AND recovery.state = 'completed'
      AND recovery.completed_at IS NOT NULL
      AND recovery.completion_kind = 'echo'
      AND recovery.completion_proof_id = 'outbound-op:' || CAST(selected.id AS TEXT);

    -- Ambiguous targets fail closed. A closure receipt names one terminal and
    -- selected operation, so more than one independently valid candidate is
    -- not silently resolved by query order.
    CREATE VIEW operator_catchup_delivery_proofs AS
    SELECT
      target_seq,
      conversation_key,
      chat_jid,
      terminal_record_id,
      selected_op_id,
      recovery_job_id,
      evidence_basis
    FROM operator_catchup_delivery_proof_candidates
    GROUP BY target_seq, conversation_key, chat_jid
    HAVING COUNT(*) = 1;

    CREATE TRIGGER inbound_disposition_closure_validate_insert
    BEFORE INSERT ON inbound_disposition_links
    WHEN NEW.disposition = 'superseded_by_operator_catchup'
      AND NEW.superseded_by_seq IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM inbound_disposition_links pending
        JOIN inbound_events source ON source.seq = NEW.inbound_seq
        JOIN inbound_events target ON target.seq = NEW.superseded_by_seq
        JOIN operator_catchup_delivery_proofs proof
          ON proof.target_seq = target.seq
         AND proof.conversation_key = target.conversation_key
         AND proof.chat_jid = target.chat_jid
        WHERE pending.inbound_seq = NEW.inbound_seq
          AND pending.recovery_plan_id = NEW.recovery_plan_id
          AND pending.disposition = 'recovery_pending_operator_catchup'
          AND pending.superseded_by_seq IS NULL
          AND target.seq > source.seq
          AND target.conversation_key = source.conversation_key
          AND target.chat_jid = source.chat_jid
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid operator catch-up closure');
    END;

    CREATE TRIGGER operator_catchup_terminal_proof_immutable
    BEFORE UPDATE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN operator_catchup_delivery_proof_candidates proof
        ON proof.target_seq = closure.superseded_by_seq
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND proof.terminal_record_id = OLD.id
    ) AND (
      NEW.id IS NOT OLD.id
      OR NEW.scope IS NOT OLD.scope
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
      SELECT RAISE(ABORT, 'operator catch-up terminal proof is immutable');
    END;

    CREATE TRIGGER operator_catchup_terminal_proof_retain
    BEFORE DELETE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN operator_catchup_delivery_proof_candidates proof
        ON proof.target_seq = closure.superseded_by_seq
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND proof.terminal_record_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up terminal proof must be retained');
    END;

    CREATE TRIGGER operator_catchup_selected_outbound_proof_immutable
    BEFORE UPDATE ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN operator_catchup_delivery_proof_candidates proof
        ON proof.target_seq = closure.superseded_by_seq
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND proof.selected_op_id = OLD.id
    ) AND (
      NEW.id IS NOT OLD.id
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.chat_jid IS NOT OLD.chat_jid
      OR NEW.op_type IS NOT OLD.op_type
      OR NEW.payload IS NOT OLD.payload
      OR NEW.payload_hash IS NOT OLD.payload_hash
      OR NEW.status IS NOT OLD.status
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.submitted_at IS NOT OLD.submitted_at
      OR NEW.echoed_at IS NOT OLD.echoed_at
      OR NEW.wa_message_id IS NOT OLD.wa_message_id
      OR NEW.error IS NOT OLD.error
      OR NEW.source_inbound_seq IS NOT OLD.source_inbound_seq
      OR NEW.retry_count IS NOT OLD.retry_count
      OR NEW.is_terminal IS NOT OLD.is_terminal
      OR NEW.replay_policy IS NOT OLD.replay_policy
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up selected outbound proof is immutable');
    END;

    CREATE TRIGGER operator_catchup_selected_outbound_proof_retain
    BEFORE DELETE ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN operator_catchup_delivery_proof_candidates proof
        ON proof.target_seq = closure.superseded_by_seq
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND proof.selected_op_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up selected outbound proof must be retained');
    END;

    CREATE TRIGGER operator_catchup_recovery_job_proof_immutable
    BEFORE UPDATE ON turn_recovery_jobs
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN operator_catchup_delivery_proof_candidates proof
        ON proof.target_seq = closure.superseded_by_seq
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND proof.recovery_job_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up recovery job proof is immutable');
    END;

    CREATE TRIGGER operator_catchup_recovery_job_proof_retain
    BEFORE DELETE ON turn_recovery_jobs
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN operator_catchup_delivery_proof_candidates proof
        ON proof.target_seq = closure.superseded_by_seq
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND proof.recovery_job_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up recovery job proof must be retained');
    END;
  `);
}
