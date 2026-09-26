/**
 * An inbound row left OPEN ('pending'/'processing'/'turn_done') behind a
 * FINAL terminal record (finalized_replied, finalized_no_reply_policy,
 * failed_terminal).
 *
 * Live finalization writes the terminal record and the inbound mutation in
 * one transaction, so current code cannot produce this combination; rows
 * written by an older release can. Every stuck-inbound sweep bucket requires
 * NOT EXISTS turn_terminal_records and the recovery-owner bucket requires a
 * transferred disposition, so such a row stays open until an operator closes
 * it. The sweep only REPORTS candidates; each close is an operator decision
 * taken through `turn-recovery-operator close-inbound`.
 *
 * The status a close applies is the one the record itself implies, derived by
 * the same mapping live finalization uses (deriveTerminalInboundMutation) and
 * validated by the same contract (normalizeFinalizeTurnTerminalParams) and the
 * same delivery-proof rule. One evaluator serves the sweep report and the CLI,
 * so a sweep skip and a CLI refusal cannot drift apart.
 *
 * Works on a raw connection so the CLI can evaluate through a read-only
 * handle without the migrating Database wrapper.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  deriveTerminalInboundMutation,
  DELIVERY_STATUS_PROOF,
  normalizeFinalizeTurnTerminalParams,
  type TerminalInboundMutation,
  type TurnTerminalPersistenceParams,
  type TurnTerminalRecordRow,
} from './turn-finalization-contract.ts';

type PreparedStatement = ReturnType<DatabaseSync['prepare']>;

const FINAL_TERMINAL_DISPOSITIONS: ReadonlySet<string> = new Set([
  'finalized_replied',
  'finalized_no_reply_policy',
  'failed_terminal',
]);
const OPEN_STATUSES: ReadonlySet<string> = new Set(['pending', 'processing', 'turn_done']);

export type TerminalRecordInboundCloseRefusal =
  | 'inbound_not_found'
  | 'no_terminal_record'
  | 'multiple_terminal_records'
  | 'non_final_disposition'
  | 'identity_mismatch'
  | 'disposition_link'
  | 'recovery_job'
  | 'delivery_proof_invalid'
  | 'record_contract_invalid'
  | 'closed_differently';

export type TerminalRecordInboundCloseEvaluation =
  | {
    readonly verdict: 'eligible';
    readonly seq: number;
    readonly recordId: number;
    readonly disposition: string;
    readonly fromStatus: string;
    readonly mutation: TerminalInboundMutation;
  }
  | {
    readonly verdict: 'already_closed';
    readonly seq: number;
    readonly recordId: number;
    readonly disposition: string;
    readonly status: string;
  }
  | {
    readonly verdict: 'refused';
    readonly seq: number;
    readonly reason: TerminalRecordInboundCloseRefusal;
    readonly recordId?: number;
    readonly disposition?: string;
    readonly status?: string;
  };

interface InboundCloseRow {
  processing_status: string;
  conversation_key: string;
  chat_jid: string;
  terminal_reason: string | null;
  failure_class: string | null;
}

interface DeliveryOpRow {
  conversation_key: string;
  chat_jid: string;
  source_inbound_seq: number | null;
  status: string;
}

function recordAsPersistenceParams(record: TurnTerminalRecordRow): TurnTerminalPersistenceParams {
  return {
    scope: record.scope,
    conversationKey: record.conversation_key,
    deliveryJid: record.delivery_jid,
    inboundSeq: record.inbound_seq,
    logicalTurnId: record.logical_turn_id,
    managerId: record.manager_id,
    generation: record.generation,
    attemptKind: record.attempt_kind,
    attemptFailureClass: record.attempt_failure_class,
    inboundDisposition: record.inbound_disposition,
    deliveryKind: record.delivery_kind,
    deliveryOpId: record.delivery_op_id,
    recoveryOwnerLogicalTurnId: record.recovery_owner_logical_turn_id,
    recoveryOwnerManagerId: record.recovery_owner_manager_id,
    recoveryOwnerGeneration: record.recovery_owner_generation,
    replyGuaranteeDisarmed: record.reply_guarantee_disarmed === 1,
  };
}

function matchesMutation(row: InboundCloseRow, mutation: TerminalInboundMutation): boolean {
  return mutation.kind === 'complete'
    ? row.processing_status === 'complete' && row.terminal_reason === mutation.terminalReason
    : row.processing_status === 'failed' && row.failure_class === mutation.failureClass;
}

export class TerminalRecordInboundCloser {
  private readonly selectInbound: PreparedStatement;
  private readonly selectRecords: PreparedStatement;
  private readonly selectLinked: PreparedStatement;
  private readonly selectRecoveryJob: PreparedStatement;
  private readonly selectDeliveryOp: PreparedStatement;
  private readonly selectCandidates: PreparedStatement;
  private readonly closeComplete: PreparedStatement;
  private readonly closeFailed: PreparedStatement;

  constructor(raw: DatabaseSync) {
    this.selectInbound = raw.prepare(
      `SELECT processing_status, conversation_key, chat_jid, terminal_reason, failure_class
       FROM inbound_events WHERE seq = ?`,
    );
    this.selectRecords = raw.prepare(
      `SELECT * FROM turn_terminal_records WHERE inbound_seq_key = ? ORDER BY id ASC`,
    );
    // Both columns: the disposition_inbound_proof_immutable trigger fires on
    // either, so a close of a linked row would abort.
    this.selectLinked = raw.prepare(
      `SELECT 1 FROM inbound_disposition_links
       WHERE inbound_seq = ? OR superseded_by_seq = ? LIMIT 1`,
    );
    this.selectRecoveryJob = raw.prepare(
      `SELECT 1 FROM turn_recovery_jobs WHERE source_inbound_seq = ? LIMIT 1`,
    );
    this.selectDeliveryOp = raw.prepare(
      `SELECT conversation_key, chat_jid, source_inbound_seq, status FROM outbound_ops WHERE id = ?`,
    );
    // Pre-filters the refusals that are common and permanent so they neither
    // occupy the bounded window forever nor show up in the sweep report;
    // evaluate() re-checks every rule.
    this.selectCandidates = raw.prepare(
      `SELECT i.seq AS seq
       FROM inbound_events i
       JOIN turn_terminal_records t
         ON t.inbound_seq_key = i.seq
        AND t.inbound_disposition IN ('finalized_replied', 'finalized_no_reply_policy', 'failed_terminal')
        AND t.conversation_key = i.conversation_key
        AND t.delivery_jid = i.chat_jid
       WHERE i.processing_status IN ('pending', 'processing', 'turn_done')
         AND i.received_at < datetime('now', '-5 minutes')
         AND NOT EXISTS (
           SELECT 1 FROM turn_terminal_records other
           WHERE other.inbound_seq_key = i.seq AND other.id <> t.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM inbound_disposition_links l
           WHERE l.inbound_seq = i.seq OR l.superseded_by_seq = i.seq
         )
         AND NOT EXISTS (
           SELECT 1 FROM turn_recovery_jobs j WHERE j.source_inbound_seq = i.seq
         )
       ORDER BY i.seq ASC
       LIMIT 200`,
    );
    this.closeComplete = raw.prepare(
      `UPDATE inbound_events
       SET processing_status = 'complete', completed_at = datetime('now'), terminal_reason = ?
       WHERE seq = ? AND processing_status IN ('pending', 'processing', 'turn_done')`,
    );
    this.closeFailed = raw.prepare(
      // terminal_reason stays exactly 'error', as in DurabilityEngine.markInboundFailed.
      `UPDATE inbound_events
       SET processing_status = 'failed', completed_at = datetime('now'),
           terminal_reason = 'error', failure_class = ?
       WHERE seq = ? AND processing_status IN ('pending', 'processing', 'turn_done')`,
    );
  }

  /** Bounded pre-filtered candidates, oldest first; each still goes through evaluate(). */
  candidates(): number[] {
    return (this.selectCandidates.all() as Array<{ seq: number }>).map((row) => row.seq);
  }

  /** Candidates that pass every rule — what the sweep reports. Writes nothing. */
  eligibleCandidates(): number[] {
    return this.candidates().filter((seq) => this.evaluate(seq).verdict === 'eligible');
  }

  evaluate(seq: number): TerminalRecordInboundCloseEvaluation {
    const inbound = this.selectInbound.get(seq) as InboundCloseRow | undefined;
    if (!inbound) return { verdict: 'refused', seq, reason: 'inbound_not_found' };
    const status = inbound.processing_status;

    const records = this.selectRecords.all(seq) as unknown as TurnTerminalRecordRow[];
    if (records.length === 0) return { verdict: 'refused', seq, reason: 'no_terminal_record', status };
    if (records.length > 1) {
      return { verdict: 'refused', seq, reason: 'multiple_terminal_records', status };
    }
    const record = records[0]!;
    const refused = (reason: TerminalRecordInboundCloseRefusal): TerminalRecordInboundCloseEvaluation => ({
      verdict: 'refused', seq, reason, recordId: record.id, disposition: record.inbound_disposition, status,
    });

    if (!FINAL_TERMINAL_DISPOSITIONS.has(record.inbound_disposition)) {
      return refused('non_final_disposition');
    }
    if (
      record.conversation_key !== inbound.conversation_key ||
      record.delivery_jid !== inbound.chat_jid
    ) {
      return refused('identity_mismatch');
    }
    if (this.selectLinked.get(seq, seq) !== undefined) return refused('disposition_link');
    if (this.selectRecoveryJob.get(seq) !== undefined) return refused('recovery_job');

    let mutation: TerminalInboundMutation | undefined;
    try {
      const terminal = recordAsPersistenceParams(record);
      mutation = deriveTerminalInboundMutation(terminal);
      normalizeFinalizeTurnTerminalParams({ terminal, ...(mutation ? { inbound: mutation } : {}) });
    } catch {
      return refused('record_contract_invalid');
    }
    if (mutation === undefined) return refused('record_contract_invalid');
    if (!this.deliveryProofHolds(record)) return refused('delivery_proof_invalid');

    if (!OPEN_STATUSES.has(status)) {
      return matchesMutation(inbound, mutation)
        ? { verdict: 'already_closed', seq, recordId: record.id, disposition: record.inbound_disposition, status }
        : refused('closed_differently');
    }
    return {
      verdict: 'eligible',
      seq,
      recordId: record.id,
      disposition: record.inbound_disposition,
      fromStatus: status,
      mutation,
    };
  }

  /**
   * Live finalization's delivery proof (DurabilityEngine
   * validateTerminalDeliveryProof), re-read now: the selected op still exists,
   * belongs to this inbound and identity, and still has the proving status.
   */
  private deliveryProofHolds(record: TurnTerminalRecordRow): boolean {
    if (record.delivery_kind === 'none') return record.delivery_op_id === null;
    if (record.delivery_op_id === null) return false;
    const op = this.selectDeliveryOp.get(record.delivery_op_id) as DeliveryOpRow | undefined;
    return op !== undefined &&
      op.conversation_key === record.conversation_key &&
      op.chat_jid === record.delivery_jid &&
      op.source_inbound_seq === record.inbound_seq &&
      op.status === DELIVERY_STATUS_PROOF[record.delivery_kind];
  }

  /** Apply an eligible close inside the caller's transaction. */
  applyWithinCallerTransaction(mutation: TerminalInboundMutation): void {
    const result = mutation.kind === 'complete'
      ? this.closeComplete.run(mutation.terminalReason, mutation.seq)
      : this.closeFailed.run(mutation.failureClass, mutation.seq);
    if (result.changes !== 1) {
      throw new Error('Terminal-record inbound close did not update exactly one open row');
    }
  }
}
