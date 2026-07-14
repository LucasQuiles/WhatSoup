import type { DatabaseSync } from 'node:sqlite';
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

export interface OperatorCatchupRecoveryInspection {
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
  wouldInsert: number;
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
 * Validate an operator catch-up closure without mutating the database. This is
 * the canonical proof inspection used by both CLI dry runs and the write path.
 */
export function inspectOperatorCatchupRecovery(
  raw: DatabaseSync,
  params: CloseOperatorCatchupRecoveryParams,
): OperatorCatchupRecoveryInspection {
  const planId = requiredText(params.planId, 'Recovery plan ID');
  const conversationKey = requiredText(params.conversationKey, 'Conversation key');
  const actor = requiredText(params.actor, 'Recovery actor');
  const evidenceRef = requiredText(params.evidenceRef, 'Recovery evidence reference', 8192);
  const catchupSeq = positiveSeq(params.catchupSeq, 'Catch-up sequence');
  const expectedSourceSeqs = normalizedSourceSeqs(params.expectedSourceSeqs);

  const plan = raw.prepare(`
    SELECT plan_id
    FROM recovery_plans
    WHERE plan_id = ?
  `).get(planId);
  if (!plan) throw new Error('Recovery plan does not exist');

  const pending = raw.prepare(`
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

  const closed = raw.prepare(`
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
    const witness = raw.prepare(`
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
      wouldInsert: 0,
      idempotent: true,
      openBefore: 0,
      openAfter: 0,
    };
  }

  const target = raw.prepare(`
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

  const deliveredReply = raw.prepare(`
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

  return {
    planId,
    conversationKey,
    sourceSeqs: expectedSourceSeqs,
    catchupSeq,
    actor,
    evidenceRef,
    evidenceBasis: deliveredReply.evidence_basis,
    terminalRecordId: deliveredReply.terminal_record_id,
    selectedOpId: deliveredReply.selected_op_id,
    recoveryJobId: deliveredReply.recovery_job_id,
    completionProofId: deliveredReply.completion_proof_id,
    wouldInsert: expectedSourceSeqs.length,
    idempotent: false,
    openBefore: expectedSourceSeqs.length,
    openAfter: 0,
  };
}

function closeInspectedOperatorCatchupRecovery(
  raw: DatabaseSync,
  params: CloseOperatorCatchupRecoveryParams,
): CloseOperatorCatchupRecoveryReceipt {
  const inspection = inspectOperatorCatchupRecovery(raw, params);
  if (inspection.idempotent) {
    const { wouldInsert: _wouldInsert, ...receipt } = inspection;
    return { ...receipt, inserted: 0 };
  }

  const insert = raw.prepare(`
    INSERT INTO inbound_disposition_links (
      inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
      reason, evidence_ref, actor
    ) VALUES (?, ?, 'superseded_by_operator_catchup', ?,
              ?, ?, ?)
  `);
  let inserted = 0;
  for (const seq of inspection.sourceSeqs) {
    inserted += Number(insert.run(
      seq,
      inspection.planId,
      inspection.catchupSeq,
      CLOSURE_REASON,
      inspection.evidenceRef,
      inspection.actor,
    ).changes);
  }
  const openAfter = Number((raw.prepare(`
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
  `).get(inspection.planId, inspection.conversationKey) as { count: number }).count);
  if (openAfter !== 0 || inserted !== inspection.sourceSeqs.length) {
    throw new Error('Catch-up closure did not resolve the exact recovery set');
  }
  const witness = raw.prepare(`
    SELECT target_seq, actor, evidence_ref, evidence_basis,
           terminal_record_id, selected_op_id, recovery_job_id,
           completion_proof_id
    FROM operator_catchup_closure_witnesses
    WHERE recovery_plan_id = ? AND conversation_key = ?
  `).get(inspection.planId, inspection.conversationKey) as ClosureWitnessRow | undefined;
  if (
    !witness
    || witness.target_seq !== inspection.catchupSeq
    || witness.actor !== inspection.actor
    || witness.evidence_ref !== inspection.evidenceRef
    || witness.evidence_basis !== inspection.evidenceBasis
    || witness.terminal_record_id !== inspection.terminalRecordId
    || witness.selected_op_id !== inspection.selectedOpId
    || witness.recovery_job_id !== inspection.recoveryJobId
    || witness.completion_proof_id !== inspection.completionProofId
  ) {
    throw new Error('Catch-up closure did not persist its exact proof witness');
  }
  const { wouldInsert: _wouldInsert, ...receipt } = inspection;
  return { ...receipt, inserted, openAfter };
}

/** Close using a raw, already-open SQLite handle without running app migrations. */
export function closeOperatorCatchupRecoveryRaw(
  raw: DatabaseSync,
  params: CloseOperatorCatchupRecoveryParams,
  transactionalAttestation?: (transactionRaw: DatabaseSync) => void,
): CloseOperatorCatchupRecoveryReceipt {
  const foreignKeys = raw.prepare('PRAGMA foreign_keys').get() as {
    foreign_keys: number;
  } | undefined;
  if (foreignKeys?.foreign_keys !== 1) {
    throw new Error('Operator catch-up closure requires foreign-key enforcement');
  }
  // Acquire the single-writer reservation before proof inspection so a live
  // service writer cannot change the closure inputs between validation and
  // insertion. Busy/lock failures occur before any closure row is written.
  const begin = raw.prepare('BEGIN IMMEDIATE');
  const commit = raw.prepare('COMMIT');
  const rollback = raw.prepare('ROLLBACK');
  begin.run();
  let opened = true;
  try {
    transactionalAttestation?.(raw);
    const receipt = closeInspectedOperatorCatchupRecovery(raw, params);
    commit.run();
    opened = false;
    return receipt;
  } catch (error) {
    if (opened) {
      try { rollback.run(); } catch { /* best-effort rollback */ }
    }
    throw error;
  }
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
  return withTransaction(db, () => closeInspectedOperatorCatchupRecovery(db.raw, params));
}
