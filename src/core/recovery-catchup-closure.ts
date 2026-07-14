import type { Database } from './database.ts';
import { withTransaction } from './db-tx.ts';

export interface CloseOperatorCatchupRecoveryParams {
  planId: string;
  conversationKey: string;
  expectedSourceSeqs: number[];
  catchupSeq: number;
  actor: string;
  evidenceRef: string;
}

export interface CloseOperatorCatchupRecoveryReceipt {
  planId: string;
  conversationKey: string;
  sourceSeqs: number[];
  catchupSeq: number;
  actor: string;
  evidenceRef: string;
  evidenceBasis: 'selected_echoed' | 'selected_corroborated' | 'selected_echoed_recovery';
  terminalRecordId: number;
  selectedOpId: number;
  recoveryJobId: number | null;
  completionProofId: string | null;
  inserted: number;
  idempotent: boolean;
  openBefore: number;
  openAfter: number;
}

interface DispositionRow {
  inbound_seq: number;
  superseded_by_seq: number | null;
  actor: string;
  evidence_ref: string | null;
}

interface DeliveredReplyRow {
  terminal_record_id: number;
  selected_op_id: number;
  recovery_job_id: number | null;
  completion_proof_id: string | null;
  evidence_basis: 'selected_echoed' | 'selected_corroborated' | 'selected_echoed_recovery';
}

interface ClosureWitnessRow extends DeliveredReplyRow {
  target_seq: number;
  actor: string;
  evidence_ref: string;
}

const CLOSURE_REASON = 'operator catch-up completed with proven echoed reply';

function requiredText(value: string, label: string, maxBytes = 2048): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required`);
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  return normalized;
}

function positiveSeq(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function normalizedSourceSeqs(values: number[]): number[] {
  if (values.length === 0) throw new Error('Expected source sequence set is required');
  const normalized = values.map((value) => positiveSeq(value, 'Source sequence'));
  const unique = [...new Set(normalized)].sort((left, right) => left - right);
  if (unique.length !== values.length) throw new Error('Expected source sequence set contains duplicates');
  return unique;
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Append the durable catch-up closure for an exact set of pending recovery links.
 * The target must already be a completed turn with independently confirmed reply
 * delivery. Every validation and insert is in one transaction; exact replays are
 * idempotent and any mismatch is fail-closed.
 */
export function closeOperatorCatchupRecovery(
  db: Database,
  params: CloseOperatorCatchupRecoveryParams,
): CloseOperatorCatchupRecoveryReceipt {
  const planId = requiredText(params.planId, 'Recovery plan ID');
  const conversationKey = requiredText(params.conversationKey, 'Conversation key');
  const actor = requiredText(params.actor, 'Recovery actor');
  const evidenceRef = requiredText(params.evidenceRef, 'Recovery evidence reference', 8192);
  const catchupSeq = positiveSeq(params.catchupSeq, 'Catch-up sequence');
  const expectedSourceSeqs = normalizedSourceSeqs(params.expectedSourceSeqs);

  return withTransaction(db, () => {
    const plan = db.raw.prepare(`
      SELECT plan_id
      FROM recovery_plans
      WHERE plan_id = ?
    `).get(planId);
    if (!plan) throw new Error('Recovery plan does not exist');

    const pending = db.raw.prepare(`
      SELECT links.inbound_seq, links.superseded_by_seq, links.actor, links.evidence_ref
      FROM inbound_disposition_links links
      JOIN inbound_events source ON source.seq = links.inbound_seq
      WHERE links.recovery_plan_id = ?
        AND links.disposition = 'recovery_pending_operator_catchup'
        AND source.conversation_key = ?
      ORDER BY links.inbound_seq
    `).all(planId, conversationKey) as unknown as DispositionRow[];
    const pendingSeqs = pending.map((row) => row.inbound_seq);
    if (!sameNumbers(pendingSeqs, expectedSourceSeqs)) {
      throw new Error('Expected source sequences must exactly match the pending recovery set');
    }
    if (expectedSourceSeqs.some((seq) => catchupSeq <= seq)) {
      throw new Error('Catch-up sequence must be later than every source sequence');
    }

    const closed = db.raw.prepare(`
      SELECT links.inbound_seq, links.superseded_by_seq, links.actor, links.evidence_ref
      FROM inbound_disposition_links links
      JOIN inbound_events source ON source.seq = links.inbound_seq
      WHERE links.recovery_plan_id = ?
        AND links.disposition = 'superseded_by_operator_catchup'
        AND source.conversation_key = ?
      ORDER BY links.inbound_seq
    `).all(planId, conversationKey) as unknown as DispositionRow[];
    if (closed.length > 0) {
      const closedSeqs = closed.map((row) => row.inbound_seq);
      const exactReplay = closed.every((row) => (
        row.superseded_by_seq === catchupSeq
        && row.actor === actor
        && row.evidence_ref === evidenceRef
      ));
      if (!sameNumbers(closedSeqs, expectedSourceSeqs) || !exactReplay) {
        throw new Error('Recovery was already closed against a different catch-up or evidence');
      }
      const witness = db.raw.prepare(`
        SELECT target_seq, actor, evidence_ref, evidence_basis,
               terminal_record_id, selected_op_id, recovery_job_id,
               completion_proof_id
        FROM operator_catchup_closure_witnesses
        WHERE recovery_plan_id = ? AND conversation_key = ?
      `).get(planId, conversationKey) as ClosureWitnessRow | undefined;
      if (
        !witness
        || witness.target_seq !== catchupSeq
        || witness.actor !== actor
        || witness.evidence_ref !== evidenceRef
      ) {
        throw new Error('Closed recovery lacks its exact durable proof witness');
      }
      return {
        planId,
        conversationKey,
        sourceSeqs: expectedSourceSeqs,
        catchupSeq,
        actor,
        evidenceRef,
        evidenceBasis: witness.evidence_basis,
        terminalRecordId: witness.terminal_record_id,
        selectedOpId: witness.selected_op_id,
        recoveryJobId: witness.recovery_job_id,
        completionProofId: witness.completion_proof_id,
        inserted: 0,
        idempotent: true,
        openBefore: 0,
        openAfter: 0,
      };
    }
    const target = db.raw.prepare(`
      SELECT seq, chat_jid, processing_status
      FROM inbound_events
      WHERE seq = ? AND conversation_key = ?
    `).get(catchupSeq, conversationKey) as {
      seq: number;
      chat_jid: string;
      processing_status: string;
    } | undefined;
    if (!target) throw new Error('Catch-up inbound does not exist in the recovery conversation');
    if (target.processing_status !== 'complete') throw new Error('Catch-up inbound must be complete');

    const deliveredReply = db.raw.prepare(`
      SELECT
        proof.terminal_record_id,
        proof.selected_op_id,
        proof.recovery_job_id,
        proof.completion_proof_id,
        proof.evidence_basis
      FROM operator_catchup_delivery_proofs proof
      WHERE proof.target_seq = ?
        AND proof.conversation_key = ?
        AND proof.chat_jid = ?
      ORDER BY proof.terminal_record_id, proof.selected_op_id
      LIMIT 1
    `).get(catchupSeq, conversationKey, target.chat_jid) as DeliveredReplyRow | undefined;
    if (!deliveredReply) throw new Error('Catch-up reply must have echoed delivery proof');

    const insert = db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'superseded_by_operator_catchup', ?,
                ?, ?, ?)
    `);
    let inserted = 0;
    for (const seq of expectedSourceSeqs) {
      inserted += Number(insert.run(
        seq,
        planId,
        catchupSeq,
        CLOSURE_REASON,
        evidenceRef,
        actor,
      ).changes);
    }
    const openAfter = Number((db.raw.prepare(`
      SELECT COUNT(*) AS count
      FROM inbound_disposition_links pending_link
      JOIN inbound_events source ON source.seq = pending_link.inbound_seq
      WHERE pending_link.recovery_plan_id = ?
        AND pending_link.disposition = 'recovery_pending_operator_catchup'
        AND source.conversation_key = ?
        AND NOT EXISTS (
          SELECT 1
          FROM inbound_disposition_links closure
          WHERE closure.inbound_seq = pending_link.inbound_seq
            AND closure.recovery_plan_id = pending_link.recovery_plan_id
            AND closure.disposition = 'superseded_by_operator_catchup'
        )
    `).get(planId, conversationKey) as { count: number }).count);
    if (openAfter !== 0 || inserted !== expectedSourceSeqs.length) {
      throw new Error('Catch-up closure did not resolve the exact recovery set');
    }
    const witness = db.raw.prepare(`
      SELECT target_seq, actor, evidence_ref, evidence_basis,
             terminal_record_id, selected_op_id, recovery_job_id,
             completion_proof_id
      FROM operator_catchup_closure_witnesses
      WHERE recovery_plan_id = ? AND conversation_key = ?
    `).get(planId, conversationKey) as ClosureWitnessRow | undefined;
    if (
      !witness
      || witness.target_seq !== catchupSeq
      || witness.actor !== actor
      || witness.evidence_ref !== evidenceRef
      || witness.evidence_basis !== deliveredReply.evidence_basis
      || witness.terminal_record_id !== deliveredReply.terminal_record_id
      || witness.selected_op_id !== deliveredReply.selected_op_id
      || witness.recovery_job_id !== deliveredReply.recovery_job_id
      || witness.completion_proof_id !== deliveredReply.completion_proof_id
    ) {
      throw new Error('Catch-up closure did not persist its exact proof witness');
    }
    return {
      planId,
      conversationKey,
      sourceSeqs: expectedSourceSeqs,
      catchupSeq,
      actor,
      evidenceRef,
      evidenceBasis: witness.evidence_basis,
      terminalRecordId: witness.terminal_record_id,
      selectedOpId: witness.selected_op_id,
      recoveryJobId: witness.recovery_job_id,
      completionProofId: witness.completion_proof_id,
      inserted,
      idempotent: false,
      openBefore: expectedSourceSeqs.length,
      openAfter,
    };
  });
}
