import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../logger.ts';
import { errorMessage } from '../lib/error-message.ts';
import type { Database } from './database.ts';
import { withTransaction } from './db-tx.ts';

const log = createChildLogger('durability');
const RECOVERY_ACTOR = 'durability_engine';
const DELIVERY_CORROBORATION_BASIS = 'same_source_later_echoed_op';

type PreparedStatement = ReturnType<Database['raw']['prepare']>;

export interface RecoveryReceipt {
  recoveryPlanId: string;
  recoveryRunId: number;
}

export interface RecoveryStats {
  inboundReplayed: number;
  outboundReconciled: number;
  outboundReplayed: number;
  outboundQuarantined: number;
  toolCallsRecovered: number;
  toolCallsReplayed: number;
  toolCallsQuarantined: number;
  sessionsRestored: number;
  recoveryPlanId?: string | null;
  recoveryRunId?: number | null;
  openRecoveries?: number;
}

export type RecoveryOrigin =
  | 'pre_connect_recovery'
  | 'post_connect_recovery'
  | 'stuck_inbound_sweep';

interface RecoveryEvidenceStatements {
  insertRecoveryPlan: PreparedStatement;
  insertStartedRecoveryRun: PreparedStatement;
  finalizeStartedRecoveryRun: PreparedStatement;
  recordIncompleteRecoveryRun: PreparedStatement;
  insertPendingDisposition: PreparedStatement;
  countOpenRecoveries: PreparedStatement;
  reconcileTurnDeliveryCorroboration: PreparedStatement;
  hasTurnDeliveryCorroboration: PreparedStatement;
}

type RecoveryOperation =
  | 'preConnectRecovery'
  | 'postConnectRecovery'
  | 'reconcileLiveMaybeSent';

interface RecoveryPhaseFailure {
  phase: string;
  error: unknown;
}

export function createRecoveryStats(receipt?: RecoveryReceipt): RecoveryStats {
  return {
    inboundReplayed: 0,
    outboundReconciled: 0,
    outboundReplayed: 0,
    outboundQuarantined: 0,
    toolCallsRecovered: 0,
    toolCallsReplayed: 0,
    toolCallsQuarantined: 0,
    sessionsRestored: 0,
    recoveryPlanId: receipt?.recoveryPlanId ?? null,
    recoveryRunId: receipt?.recoveryRunId ?? null,
    openRecoveries: 0,
  };
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
            status = 'completed',
            completed_at = datetime('now')
        WHERE id = ? AND recovery_plan_id = ? AND completed_at IS NULL
      `),
      recordIncompleteRecoveryRun: prepare(`
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
            status = 'failed',
            error_kind = ?,
            error_message = ?
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

  begin(
    operation: RecoveryOperation,
    origin: RecoveryOrigin,
    trigger: string,
    summary: string,
  ): DurabilityRecoveryRun {
    return new DurabilityRecoveryRun(
      this,
      operation,
      this.start(origin, trigger, summary),
    );
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

  recordIncomplete(
    receipt: RecoveryReceipt,
    stats: RecoveryStats,
    notes: string,
    errorKind: string | null = null,
    errorMsg: string | null = null,
  ): void {
    const result = this.statements.recordIncompleteRecoveryRun.run(
      stats.inboundReplayed,
      stats.outboundReconciled,
      stats.outboundReplayed,
      stats.outboundQuarantined,
      stats.toolCallsRecovered,
      stats.toolCallsReplayed,
      stats.toolCallsQuarantined,
      stats.sessionsRestored,
      notes,
      errorKind,
      errorMsg,
      receipt.recoveryRunId,
      receipt.recoveryPlanId,
    );
    if (result.changes !== 1) {
      throw new Error('Incomplete recovery run receipt could not be recorded exactly once');
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

/** Owns one durable recovery receipt from admission through finalization. */
class DurabilityRecoveryRun {
  readonly receipt: RecoveryReceipt;
  readonly stats: RecoveryStats;
  private readonly evidence: DurabilityRecoveryEvidence;
  private readonly operation: RecoveryOperation;
  private readonly failures: RecoveryPhaseFailure[] = [];

  constructor(
    evidence: DurabilityRecoveryEvidence,
    operation: RecoveryOperation,
    receipt: RecoveryReceipt,
  ) {
    this.evidence = evidence;
    this.operation = operation;
    this.receipt = receipt;
    this.stats = createRecoveryStats(receipt);
  }

  recordFailure(phase: string, error: unknown): void {
    this.failures.push({ phase, error });
  }

  failImmediately(
    phase: string,
    error: unknown,
    openRecoveries: number | null = null,
  ): never {
    this.recordFailure(phase, error);
    return this.failIncomplete(openRecoveries);
  }

  attestOpenRecoveries(): void {
    try {
      this.stats.openRecoveries = this.evidence.countOpen();
    } catch (err) {
      this.failImmediately('count_open_recoveries', err);
    }
    if (this.failures.length > 0) {
      this.failIncomplete(this.stats.openRecoveries ?? null);
    }
  }

  finalize(notes?: string): void {
    try {
      this.evidence.finalize(
        this.receipt,
        this.stats,
        notes ?? JSON.stringify({ openRecoveries: this.stats.openRecoveries }),
      );
    } catch (err) {
      this.failImmediately(
        'finalize_recovery_run',
        err,
        this.stats.openRecoveries ?? null,
      );
    }
  }

  private failIncomplete(openRecoveries: number | null): never {
    const failedPhases = [...new Set(this.failures.map(({ phase }) => phase))];
    const primaryFailure = this.failures[0]?.error;
    const primaryError = primaryFailure instanceof Error
      ? primaryFailure
      : new Error(`${this.operation} failed during ${failedPhases[0] ?? 'unknown_phase'}`, {
        cause: primaryFailure,
      });
    try {
      this.evidence.recordIncomplete(
        this.receipt,
        this.stats,
        JSON.stringify({ status: 'incomplete', failedPhases, openRecoveries }),
        failedPhases[0] ?? null,
        errorMessage(primaryError),
      );
    } catch (receiptFailure) {
      const receiptError = receiptFailure instanceof Error
        ? receiptFailure
        : new Error('Incomplete recovery receipt persistence failed', {
          cause: receiptFailure,
        });
      log.error(
        { failedPhases, receiptError },
        `${this.operation}: incomplete recovery receipt could not be recorded`,
      );
      throw new AggregateError(
        [primaryError, receiptError],
        `${this.operation}: recovery failed and its incomplete receipt could not be recorded`,
        { cause: primaryError },
      );
    }
    log.error({ failedPhases }, `${this.operation}: incomplete recovery recorded`);
    throw primaryError;
  }
}
