import type { DatabaseSync } from 'node:sqlite';

function addRecoveryPlanColumn(db: DatabaseSync): void {
  const table = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_runs'
  `).get();
  if (!table) return;
  const columns = db.prepare("PRAGMA table_info('recovery_runs')").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'recovery_plan_id')) {
    db.exec(`
      ALTER TABLE recovery_runs
      ADD COLUMN recovery_plan_id TEXT REFERENCES recovery_plans(plan_id) ON DELETE RESTRICT
    `);
  }
}

export function runMigration41(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_plans (
      plan_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL CHECK (
        origin IN ('pre_connect_recovery', 'post_connect_recovery', 'stuck_inbound_sweep', 'operator')
      ),
      actor TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (length(trim(plan_id)) > 0 AND length(CAST(plan_id AS BLOB)) <= 2048),
      CHECK (length(trim(actor)) > 0 AND length(CAST(actor AS BLOB)) <= 2048),
      CHECK (length(trim(summary)) > 0 AND length(CAST(summary AS BLOB)) <= 8192),
      CHECK (evidence_ref IS NULL OR length(CAST(evidence_ref AS BLOB)) <= 8192)
    );
  `);

  addRecoveryPlanColumn(db);

  const requiredParents = ['inbound_events', 'outbound_ops', 'turn_terminal_records'];
  const parentCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name IN ('inbound_events', 'outbound_ops', 'turn_terminal_records')
  `).get() as { count: number }).count;
  if (parentCount !== requiredParents.length) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_disposition_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inbound_seq INTEGER NOT NULL REFERENCES inbound_events(seq) ON DELETE RESTRICT,
      recovery_plan_id TEXT NOT NULL REFERENCES recovery_plans(plan_id) ON DELETE RESTRICT,
      disposition TEXT NOT NULL CHECK (
        disposition IN ('recovery_pending_operator_catchup', 'superseded_by_operator_catchup')
      ),
      superseded_by_seq INTEGER REFERENCES inbound_events(seq) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      evidence_ref TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (disposition = 'recovery_pending_operator_catchup' AND superseded_by_seq IS NULL)
        OR
        (disposition = 'superseded_by_operator_catchup'
          AND superseded_by_seq IS NOT NULL
          AND superseded_by_seq > inbound_seq)
      ),
      CHECK (length(trim(reason)) > 0 AND length(CAST(reason AS BLOB)) <= 8192),
      CHECK (length(trim(actor)) > 0 AND length(CAST(actor AS BLOB)) <= 2048),
      CHECK (evidence_ref IS NULL OR length(CAST(evidence_ref AS BLOB)) <= 8192)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_disposition_pending_unique
      ON inbound_disposition_links(inbound_seq, recovery_plan_id, disposition)
      WHERE disposition = 'recovery_pending_operator_catchup' AND superseded_by_seq IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_disposition_closure_unique
      ON inbound_disposition_links(inbound_seq, recovery_plan_id)
      WHERE disposition = 'superseded_by_operator_catchup' AND superseded_by_seq IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_inbound_disposition_open
      ON inbound_disposition_links(recovery_plan_id, disposition, inbound_seq);

    CREATE TABLE IF NOT EXISTS turn_delivery_corroboration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_record_id INTEGER NOT NULL
        REFERENCES turn_terminal_records(id) ON DELETE RESTRICT,
      corroborating_op_id INTEGER NOT NULL
        REFERENCES outbound_ops(id) ON DELETE RESTRICT,
      basis TEXT NOT NULL CHECK (basis = 'same_source_later_echoed_op'),
      actor TEXT NOT NULL,
      evidence_ref TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (terminal_record_id, corroborating_op_id),
      CHECK (length(trim(actor)) > 0 AND length(CAST(actor AS BLOB)) <= 2048),
      CHECK (evidence_ref IS NULL OR length(CAST(evidence_ref AS BLOB)) <= 8192)
    );

    CREATE TRIGGER IF NOT EXISTS recovery_plans_append_only_update
    BEFORE UPDATE ON recovery_plans
    BEGIN
      SELECT RAISE(ABORT, 'recovery_plans is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS recovery_plans_append_only_delete
    BEFORE DELETE ON recovery_plans
    BEGIN
      SELECT RAISE(ABORT, 'recovery_plans is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS inbound_disposition_links_append_only_update
    BEFORE UPDATE ON inbound_disposition_links
    BEGIN
      SELECT RAISE(ABORT, 'inbound_disposition_links is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS inbound_disposition_links_append_only_delete
    BEFORE DELETE ON inbound_disposition_links
    BEGIN
      SELECT RAISE(ABORT, 'inbound_disposition_links is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS inbound_disposition_closure_validate_insert
    BEFORE INSERT ON inbound_disposition_links
    WHEN NEW.disposition = 'superseded_by_operator_catchup'
      AND NEW.superseded_by_seq IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM inbound_disposition_links pending
        JOIN inbound_events source ON source.seq = NEW.inbound_seq
        JOIN inbound_events target ON target.seq = NEW.superseded_by_seq
        JOIN turn_terminal_records terminal ON terminal.inbound_seq = target.seq
        JOIN outbound_ops selected ON selected.id = terminal.delivery_op_id
        WHERE pending.inbound_seq = NEW.inbound_seq
          AND pending.recovery_plan_id = NEW.recovery_plan_id
          AND pending.disposition = 'recovery_pending_operator_catchup'
          AND pending.superseded_by_seq IS NULL
          AND target.seq > source.seq
          AND target.conversation_key = source.conversation_key
          AND target.chat_jid = source.chat_jid
          AND target.processing_status = 'complete'
          AND target.completed_at IS NOT NULL
          AND terminal.inbound_seq_key = target.seq
          AND terminal.conversation_key = target.conversation_key
          AND terminal.delivery_jid = target.chat_jid
          AND terminal.inbound_disposition = 'finalized_replied'
          AND selected.source_inbound_seq = target.seq
          AND selected.conversation_key = target.conversation_key
          AND selected.chat_jid = target.chat_jid
          AND selected.is_terminal = 1
          AND (
            (terminal.delivery_kind = 'echoed' AND selected.status = 'echoed')
            OR EXISTS (
              SELECT 1
              FROM turn_delivery_corroboration proof
              JOIN outbound_ops corroborating
                ON corroborating.id = proof.corroborating_op_id
              WHERE proof.terminal_record_id = terminal.id
                AND terminal.delivery_kind = 'delivery_unknown'
                AND selected.source_inbound_seq IS NOT NULL
                AND corroborating.source_inbound_seq = selected.source_inbound_seq
                AND corroborating.conversation_key = selected.conversation_key
                AND corroborating.chat_jid = selected.chat_jid
                AND corroborating.status = 'echoed'
                AND corroborating.id > selected.id
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid operator catch-up closure');
    END;

    CREATE TRIGGER IF NOT EXISTS operator_catchup_terminal_proof_immutable
    BEFORE UPDATE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN inbound_events target ON target.seq = closure.superseded_by_seq
      JOIN outbound_ops selected ON selected.id = OLD.delivery_op_id
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND OLD.inbound_seq = target.seq
        AND OLD.inbound_seq_key = target.seq
        AND OLD.conversation_key = target.conversation_key
        AND OLD.delivery_jid = target.chat_jid
        AND OLD.inbound_disposition = 'finalized_replied'
        AND OLD.delivery_kind = 'echoed'
        AND selected.source_inbound_seq = target.seq
        AND selected.conversation_key = target.conversation_key
        AND selected.chat_jid = target.chat_jid
        AND selected.status = 'echoed'
        AND selected.is_terminal = 1
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
    CREATE TRIGGER IF NOT EXISTS operator_catchup_terminal_proof_retain
    BEFORE DELETE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN inbound_events target ON target.seq = closure.superseded_by_seq
      JOIN outbound_ops selected ON selected.id = OLD.delivery_op_id
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND OLD.inbound_seq = target.seq
        AND OLD.inbound_seq_key = target.seq
        AND OLD.conversation_key = target.conversation_key
        AND OLD.delivery_jid = target.chat_jid
        AND OLD.inbound_disposition = 'finalized_replied'
        AND OLD.delivery_kind = 'echoed'
        AND selected.source_inbound_seq = target.seq
        AND selected.conversation_key = target.conversation_key
        AND selected.chat_jid = target.chat_jid
        AND selected.status = 'echoed'
        AND selected.is_terminal = 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up terminal proof must be retained');
    END;

    CREATE TRIGGER IF NOT EXISTS operator_catchup_selected_outbound_proof_immutable
    BEFORE UPDATE ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN inbound_events target ON target.seq = closure.superseded_by_seq
      JOIN turn_terminal_records terminal ON terminal.inbound_seq = target.seq
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND terminal.inbound_seq_key = target.seq
        AND terminal.conversation_key = target.conversation_key
        AND terminal.delivery_jid = target.chat_jid
        AND terminal.inbound_disposition = 'finalized_replied'
        AND terminal.delivery_kind = 'echoed'
        AND terminal.delivery_op_id = OLD.id
        AND OLD.source_inbound_seq = target.seq
        AND OLD.conversation_key = target.conversation_key
        AND OLD.chat_jid = target.chat_jid
        AND OLD.status = 'echoed'
        AND OLD.is_terminal = 1
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
    CREATE TRIGGER IF NOT EXISTS operator_catchup_selected_outbound_proof_retain
    BEFORE DELETE ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM inbound_disposition_links closure
      JOIN inbound_events target ON target.seq = closure.superseded_by_seq
      JOIN turn_terminal_records terminal ON terminal.inbound_seq = target.seq
      WHERE closure.disposition = 'superseded_by_operator_catchup'
        AND terminal.inbound_seq_key = target.seq
        AND terminal.conversation_key = target.conversation_key
        AND terminal.delivery_jid = target.chat_jid
        AND terminal.inbound_disposition = 'finalized_replied'
        AND terminal.delivery_kind = 'echoed'
        AND terminal.delivery_op_id = OLD.id
        AND OLD.source_inbound_seq = target.seq
        AND OLD.conversation_key = target.conversation_key
        AND OLD.chat_jid = target.chat_jid
        AND OLD.status = 'echoed'
        AND OLD.is_terminal = 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up selected outbound proof must be retained');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_delivery_corroboration_validate_insert
    BEFORE INSERT ON turn_delivery_corroboration
    WHEN NOT EXISTS (
      SELECT 1
      FROM turn_terminal_records terminal
      JOIN outbound_ops selected ON selected.id = terminal.delivery_op_id
      JOIN outbound_ops corroborating ON corroborating.id = NEW.corroborating_op_id
      WHERE terminal.id = NEW.terminal_record_id
        AND terminal.delivery_kind = 'delivery_unknown'
        AND terminal.inbound_seq IS NOT NULL
        AND terminal.inbound_seq_key = terminal.inbound_seq
        AND selected.source_inbound_seq IS NOT NULL
        AND selected.source_inbound_seq = terminal.inbound_seq
        AND selected.conversation_key = terminal.conversation_key
        AND selected.chat_jid = terminal.delivery_jid
        AND selected.is_terminal = 1
        AND corroborating.source_inbound_seq = selected.source_inbound_seq
        AND corroborating.conversation_key = selected.conversation_key
        AND corroborating.chat_jid = selected.chat_jid
        AND corroborating.status = 'echoed'
        AND corroborating.id > selected.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid delivery corroboration');
    END;
    CREATE TRIGGER IF NOT EXISTS turn_delivery_corroboration_append_only_update
    BEFORE UPDATE ON turn_delivery_corroboration
    BEGIN
      SELECT RAISE(ABORT, 'turn_delivery_corroboration is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS turn_delivery_corroboration_append_only_delete
    BEFORE DELETE ON turn_delivery_corroboration
    BEGIN
      SELECT RAISE(ABORT, 'turn_delivery_corroboration is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS corroborated_terminal_proof_immutable
    BEFORE UPDATE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1 FROM turn_delivery_corroboration proof
      WHERE proof.terminal_record_id = OLD.id
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
      SELECT RAISE(ABORT, 'corroborated terminal proof is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS corroborated_terminal_proof_retain
    BEFORE DELETE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1 FROM turn_delivery_corroboration proof
      WHERE proof.terminal_record_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'corroborated terminal proof must be retained');
    END;

    CREATE TRIGGER IF NOT EXISTS corroborated_selected_outbound_proof_immutable
    BEFORE UPDATE ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM turn_delivery_corroboration proof
      JOIN turn_terminal_records terminal ON terminal.id = proof.terminal_record_id
      WHERE terminal.delivery_op_id = OLD.id
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
      SELECT RAISE(ABORT, 'corroborated selected outbound proof is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS corroborated_selected_outbound_proof_retain
    BEFORE DELETE ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM turn_delivery_corroboration proof
      JOIN turn_terminal_records terminal ON terminal.id = proof.terminal_record_id
      WHERE terminal.delivery_op_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'corroborated selected outbound proof must be retained');
    END;

    CREATE TRIGGER IF NOT EXISTS corroborating_outbound_proof_immutable
    BEFORE UPDATE ON outbound_ops
    WHEN EXISTS (
      SELECT 1 FROM turn_delivery_corroboration proof
      WHERE proof.corroborating_op_id = OLD.id
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
      SELECT RAISE(ABORT, 'corroborating outbound proof is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS corroborating_outbound_proof_retain
    BEFORE DELETE ON outbound_ops
    WHEN EXISTS (
      SELECT 1 FROM turn_delivery_corroboration proof
      WHERE proof.corroborating_op_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'corroborating outbound proof must be retained');
    END;

    CREATE TRIGGER IF NOT EXISTS disposition_inbound_proof_immutable
    BEFORE UPDATE ON inbound_events
    WHEN EXISTS (
      SELECT 1 FROM inbound_disposition_links proof
      WHERE proof.inbound_seq = OLD.seq OR proof.superseded_by_seq = OLD.seq
    ) AND (
      NEW.seq IS NOT OLD.seq
      OR NEW.message_id IS NOT OLD.message_id
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.chat_jid IS NOT OLD.chat_jid
      OR NEW.received_at IS NOT OLD.received_at
      OR NEW.routed_to IS NOT OLD.routed_to
      OR NEW.processing_status IS NOT OLD.processing_status
      OR NEW.completed_at IS NOT OLD.completed_at
      OR NEW.terminal_reason IS NOT OLD.terminal_reason
      OR NEW.failure_class IS NOT OLD.failure_class
      OR NEW.continuity_candidate_reason IS NOT OLD.continuity_candidate_reason
      OR NEW.continuity_candidate_source IS NOT OLD.continuity_candidate_source
      OR NEW.continuity_candidate_marked_at IS NOT OLD.continuity_candidate_marked_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'disposition inbound proof is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS disposition_inbound_proof_retain
    BEFORE DELETE ON inbound_events
    WHEN EXISTS (
      SELECT 1 FROM inbound_disposition_links proof
      WHERE proof.inbound_seq = OLD.seq OR proof.superseded_by_seq = OLD.seq
    )
    BEGIN
      SELECT RAISE(ABORT, 'disposition inbound proof must be retained');
    END;
  `);
}
