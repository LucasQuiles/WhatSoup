import { randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import { withTransaction } from './db-tx.ts';
import type { RecoveryStats } from './durability.ts';

const RECOVERY_ACTOR = 'durability_engine';
const DELIVERY_CORROBORATION_BASIS = 'same_source_later_echoed_op';

type PreparedStatement = ReturnType<Database['raw']['prepare']>;

export interface RecoveryReceipt {
  recoveryPlanId: string;
  recoveryRunId: number;
}

export type RecoveryOrigin =
  | 'pre_connect_recovery'
  | 'post_connect_recovery'
  | 'stuck_inbound_sweep';

interface RecoveryEvidenceStatements {
  insertRecoveryPlan: PreparedStatement;
  insertStartedRecoveryRun: PreparedStatement;
  finalizeStartedRecoveryRun: PreparedStatement;
  insertPendingDisposition: PreparedStatement;
  countOpenRecoveries: PreparedStatement;
  reconcileTurnDeliveryCorroboration: PreparedStatement;
  hasTurnDeliveryCorroboration: PreparedStatement;
}

export class DurabilityRecoveryEvidence {
  private readonly db: Database;
  private readonly statements: RecoveryEvidenceStatements;

  constructor(db: Database) {
    this.db = db;
    const prepare = db.raw.prepare.bind(db.raw);
    this.statements = {
      insertRecoveryPlan: prepare(`
        INSERT INTO recovery_plans (
          plan_id, origin, actor, summary, evidence_ref
        ) VALUES (?, ?, ?, ?, ?)
      `),
      insertStartedRecoveryRun: prepare(`
        INSERT INTO recovery_runs (trigger, recovery_plan_id)
        VALUES (?, ?)
      `),
      finalizeStartedRecoveryRun: prepare(`
        UPDATE recovery_runs
        SET inbound_replayed = ?,
            outbound_reconciled = ?,
            outbound_replayed = ?,
            outbound_quarantined = ?,
            tool_calls_recovered = ?,
            tool_calls_replayed = ?,
            tool_calls_quarantined = ?,
            sessions_restored = ?,
            notes = ?,
            completed_at = datetime('now')
        WHERE id = ? AND recovery_plan_id = ? AND completed_at IS NULL
      `),
      insertPendingDisposition: prepare(`
        INSERT INTO inbound_disposition_links (
          inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
          reason, evidence_ref, actor
        ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL, ?, ?, ?)
      `),
      countOpenRecoveries: prepare(`
        SELECT COUNT(*) AS count
        FROM inbound_disposition_links pending
        WHERE pending.disposition = 'recovery_pending_operator_catchup'
          AND NOT EXISTS (
            SELECT 1
            FROM inbound_disposition_links closure
            WHERE closure.inbound_seq = pending.inbound_seq
              AND closure.recovery_plan_id = pending.recovery_plan_id
              AND closure.disposition = 'superseded_by_operator_catchup'
          )
      `),
      reconcileTurnDeliveryCorroboration: prepare(`
        INSERT OR IGNORE INTO turn_delivery_corroboration (
          terminal_record_id, corroborating_op_id, basis, actor, evidence_ref
        )
        SELECT
          terminal.id,
          candidate.id,
          ?,
          ?,
          'recovery_plan:' || ? || '/recovery_run:' || CAST(? AS INTEGER)
            || '/terminal_record:' || terminal.id || '/selected_op:' || selected.id
        FROM turn_terminal_records terminal
        JOIN outbound_ops selected ON selected.id = terminal.delivery_op_id
        JOIN outbound_ops candidate
          ON candidate.source_inbound_seq = selected.source_inbound_seq
         AND candidate.conversation_key = selected.conversation_key
         AND candidate.chat_jid = selected.chat_jid
         AND candidate.status = 'echoed'
         AND candidate.id > selected.id
        WHERE terminal.delivery_kind = 'delivery_unknown'
          AND terminal.inbound_seq IS NOT NULL
          AND terminal.inbound_seq_key = terminal.inbound_seq
          AND selected.source_inbound_seq IS NOT NULL
          AND selected.source_inbound_seq = terminal.inbound_seq
          AND selected.conversation_key = terminal.conversation_key
          AND selected.chat_jid = terminal.delivery_jid
          AND selected.is_terminal = 1
      `),
      hasTurnDeliveryCorroboration: prepare(`
        SELECT 1 AS present
        FROM turn_terminal_records terminal
        JOIN turn_delivery_corroboration corroboration
          ON corroboration.terminal_record_id = terminal.id
        WHERE terminal.delivery_kind = 'delivery_unknown'
          AND terminal.delivery_op_id = ?
        LIMIT 1
      `),
    };
  }

  startWithinTransaction(
    origin: RecoveryOrigin,
    trigger: string,
    summary: string,
  ): RecoveryReceipt {
    const recoveryPlanId = `recovery-${randomUUID()}`;
    this.statements.insertRecoveryPlan.run(
      recoveryPlanId,
      origin,
      RECOVERY_ACTOR,
      summary,
      null,
    );
    const inserted = this.statements.insertStartedRecoveryRun.run(trigger, recoveryPlanId);
    const recoveryRunId = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(recoveryRunId) || recoveryRunId < 1) {
      throw new Error('Recovery run did not return a durable positive identity');
    }
    return { recoveryPlanId, recoveryRunId };
  }

  start(
    origin: RecoveryOrigin,
    trigger: string,
    summary: string,
  ): RecoveryReceipt {
    return withTransaction(this.db, () => this.startWithinTransaction(origin, trigger, summary));
  }

  finalize(receipt: RecoveryReceipt, stats: RecoveryStats, notes: string | null = null): void {
    const result = this.statements.finalizeStartedRecoveryRun.run(
      stats.inboundReplayed,
      stats.outboundReconciled,
      stats.outboundReplayed,
      stats.outboundQuarantined,
      stats.toolCallsRecovered,
      stats.toolCallsReplayed,
      stats.toolCallsQuarantined,
      stats.sessionsRestored,
      notes,
      receipt.recoveryRunId,
      receipt.recoveryPlanId,
    );
    if (result.changes !== 1) {
      throw new Error('Recovery run receipt could not be finalized exactly once');
    }
  }

  countOpen(): number {
    return (this.statements.countOpenRecoveries.get() as { count: number }).count;
  }

  recordPendingWithinTransaction(
    seq: number,
    receipt: RecoveryReceipt,
    reason: string,
    mutateInbound: () => void,
  ): void {
    mutateInbound();
    const result = this.statements.insertPendingDisposition.run(
      seq,
      receipt.recoveryPlanId,
      reason,
      `recovery_run:${receipt.recoveryRunId}`,
      RECOVERY_ACTOR,
    );
    if (result.changes !== 1) {
      throw new Error('Pending operator catch-up disposition was not recorded exactly once');
    }
  }

  recordPending(
    seq: number,
    receipt: RecoveryReceipt,
    reason: string,
    mutateInbound: () => void,
  ): void {
    withTransaction(this.db, () => this.recordPendingWithinTransaction(
      seq,
      receipt,
      reason,
      mutateInbound,
    ));
  }

  reconcileDeliveryCorroboration(receipt: RecoveryReceipt): number {
    return Number(this.statements.reconcileTurnDeliveryCorroboration.run(
      DELIVERY_CORROBORATION_BASIS,
      RECOVERY_ACTOR,
      receipt.recoveryPlanId,
      receipt.recoveryRunId,
    ).changes);
  }

  hasDeliveryCorroboration(opId: number): boolean {
    return this.statements.hasTurnDeliveryCorroboration.get(opId) !== undefined;
  }
}
