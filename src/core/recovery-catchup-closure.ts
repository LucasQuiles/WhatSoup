import type { DatabaseSync } from 'node:sqlite';
import type { Database } from './database.ts';
import { assertCanonicalSchema43 } from './database-migration-43.ts';
import { withTransaction } from './db-tx.ts';
import { allFromStatement } from '../lib/db-query.ts';
import { AGENT_FAILURE_NOTICE_PAYLOAD_HASHES } from './agent-failure-notices.ts';

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
 * The catch-up half of the closure proof: a completed inbound in the recovery
 * conversation whose reply has a unique echoed delivery proof on its own chat.
 */
function inspectCatchupTarget(
  raw: DatabaseSync,
  conversationKey: string,
  catchupSeq: number,
): { chatJid: string; deliveredReply: DeliveredReplyRow } {
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
  return { chatJid: target.chat_jid, deliveredReply };
}

/**
 * Validate canonical schema-43 state and an operator catch-up closure without
 * mutating the database. This is the proof inspection used by both CLI dry
 * runs and the write path.
 */
export function inspectOperatorCatchupRecovery(
  raw: DatabaseSync,
  params: CloseOperatorCatchupRecoveryParams,
): OperatorCatchupRecoveryInspection {
  assertCanonicalSchema43(raw);
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

  const pending = allFromStatement<DispositionRow>(raw.prepare(`
    SELECT links.inbound_seq, links.superseded_by_seq, links.actor, links.evidence_ref
    FROM inbound_disposition_links links
    JOIN inbound_events source ON source.seq = links.inbound_seq
    WHERE links.recovery_plan_id = ?
      AND links.disposition = 'recovery_pending_operator_catchup'
      AND source.conversation_key = ?
    ORDER BY links.inbound_seq
  `), planId, conversationKey);
  const pendingSeqs = pending.map((row) => row.inbound_seq);
  if (!sameNumbers(pendingSeqs, expectedSourceSeqs)) {
    throw new Error('Expected source sequences must exactly match the pending recovery set');
  }
  if (expectedSourceSeqs.some((seq) => catchupSeq <= seq)) {
    throw new Error('Catch-up sequence must be later than every source sequence');
  }

  const closed = allFromStatement<DispositionRow>(raw.prepare(`
    SELECT links.inbound_seq, links.superseded_by_seq, links.actor, links.evidence_ref
    FROM inbound_disposition_links links
    JOIN inbound_events source ON source.seq = links.inbound_seq
    WHERE links.recovery_plan_id = ?
      AND links.disposition = 'superseded_by_operator_catchup'
      AND source.conversation_key = ?
    ORDER BY links.inbound_seq
  `), planId, conversationKey);
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

  const { deliveredReply } = inspectCatchupTarget(raw, conversationKey, catchupSeq);

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

function withWriterReservation<T>(
  raw: DatabaseSync,
  transactionalAttestation: ((transactionRaw: DatabaseSync) => void) | undefined,
  work: () => T,
): T {
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
    const result = work();
    commit.run();
    opened = false;
    return result;
  } catch (error) {
    if (opened) {
      try { rollback.run(); } catch { /* best-effort rollback */ }
    }
    throw error;
  }
}

/** Close using a raw, already-open SQLite handle without running app migrations. */
export function closeOperatorCatchupRecoveryRaw(
  raw: DatabaseSync,
  params: CloseOperatorCatchupRecoveryParams,
  transactionalAttestation?: (transactionRaw: DatabaseSync) => void,
): CloseOperatorCatchupRecoveryReceipt {
  return withWriterReservation(
    raw,
    transactionalAttestation,
    () => closeInspectedOperatorCatchupRecovery(raw, params),
  );
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

// ---------------------------------------------------------------------------
// Failed-source closure (#3903)
//
// Startup recovery writes recovery_pending_operator_catchup links for open rows
// only, so an inbound that ended processing_status='failed' with a
// failed_terminal record and no delivery never enters a recovery plan and the
// closure above cannot close it. This route creates the operator plan and the
// pending links for exactly those failed sources and then runs the unchanged
// closure, all in one writer transaction. The source inbound and terminal rows
// are never written: the original failure, failure class and attempts stay as
// recorded, and the closure exists only as plan + links.
// ---------------------------------------------------------------------------

const FAILED_SOURCE_PLAN_SUMMARY = 'operator catch-up closure of a failed source inbound';
const FAILED_SOURCE_PENDING_REASON = 'failed source inbound enrolled for operator catch-up closure';
const DELIVERED_OP_FINGERPRINT_PATTERN = /^[0-9a-f]{12}$/;

/** What a delivered-op fingerprint binds: the op, its exact payload and its status. */
export interface DeliveredOpIdentity {
  opId: number;
  payloadHash: string | null;
  status: string;
}

export interface CloseFailedSourceOperatorCatchupParams extends CloseOperatorCatchupRecoveryParams {
  /** Operator acks; must equal the fingerprints of every delivered source op. */
  ackedDeliveredOpFingerprints?: string[];
  /**
   * Fingerprint of a delivered op. Supplied by the caller so the core never
   * emits raw op ids or payload hashes; required when acks are given.
   */
  deliveredOpFingerprint?: (op: DeliveredOpIdentity) => string;
}

/** A source op not proven unsent: delivered, possibly delivered, or still in flight. */
export interface DeliveredSourceOp extends DeliveredOpIdentity {
  sourceSeq: number;
  isTerminal: boolean;
  opType: string;
  /** A non-terminal text op whose payload hash is a registered failure notice. */
  registeredNotice: boolean;
  /** A registered notice that is proven delivered (echoed), so nothing can follow. */
  closable: boolean;
}

export interface FailedSourceOperatorCatchupInspection extends OperatorCatchupRecoveryInspection {
  deliveredOps: DeliveredSourceOp[];
  /** Every delivered op is closable; the write refuses otherwise. */
  allClosable: boolean;
  /** The acks equal the delivered-op fingerprints exactly; the write refuses otherwise. */
  acksMatch: boolean;
}

function normalizedAckFingerprints(acks: string[] | undefined): string[] {
  const normalized = (acks ?? []).map((ack) => {
    if (!DELIVERED_OP_FINGERPRINT_PATTERN.test(ack)) {
      throw new Error('Delivered-op acknowledgement must be a delivered-op fingerprint');
    }
    return ack;
  }).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Delivered-op acknowledgements contain duplicates');
  }
  return normalized;
}

/**
 * Every source op not proven unsent, in id order. failed_permanent is the only
 * proven-unsent status: markFailedPermanent accepts only deterministic
 * non-delivery evidence and the finalizer reads it as not_sent. Of the rest
 * (OUTBOUND_STATUSES in durability.ts) only echoed is proven delivered:
 * pending and sending can still be sent, and submitted, maybe_sent and
 * quarantined may arrive later. An op closes only as an echoed, non-terminal
 * text op whose payload hash is a registered failure notice. is_terminal = 1
 * marks a delivered answer (markTerminal, the chat runtime), so the turn was
 * answered. Payload text is never matched, only the exact hash.
 */
function selectDeliveredSourceOps(raw: DatabaseSync, sourceSeqs: number[]): DeliveredSourceOp[] {
  const select = raw.prepare(`
    SELECT id, source_inbound_seq, is_terminal, status, op_type, payload_hash
    FROM outbound_ops
    WHERE source_inbound_seq = ? AND status <> 'failed_permanent'
    ORDER BY id
  `);
  const ops: DeliveredSourceOp[] = [];
  for (const seq of sourceSeqs) {
    for (const op of allFromStatement<{
      id: number;
      source_inbound_seq: number;
      is_terminal: number;
      status: string;
      op_type: string;
      payload_hash: string | null;
    }>(select, seq)) {
      const registeredNotice = op.op_type === 'text'
        && op.is_terminal === 0
        && op.payload_hash !== null
        && AGENT_FAILURE_NOTICE_PAYLOAD_HASHES.has(op.payload_hash);
      ops.push({
        opId: op.id,
        sourceSeq: op.source_inbound_seq,
        isTerminal: op.is_terminal !== 0,
        status: op.status,
        opType: op.op_type,
        payloadHash: op.payload_hash,
        registeredNotice,
        closable: registeredNotice && op.status === 'echoed',
      });
    }
  }
  return ops.sort((left, right) => left.opId - right.opId);
}

/**
 * The evidence reference recorded on the plan, links and witness. The bound
 * ops are part of it, so a replay against a different op set is refused by
 * the existing changed-evidence check.
 */
function boundEvidenceRef(evidenceRef: string, ops: DeliveredSourceOp[]): string {
  const bound = ops.length === 0
    ? evidenceRef
    : `${evidenceRef} acked-delivered-ops=${ops.map(({ opId, payloadHash }) => `${opId}:${payloadHash}`).join(',')}`;
  return requiredText(bound, 'Recovery evidence reference', 8192);
}

/**
 * Validate a failed-source closure without mutating the database. A plan that
 * already carries its closure witness is delegated to the plain inspection, so
 * an exact replay is idempotent and a changed catch-up, evidence or op set is
 * refused.
 */
export function inspectFailedSourceOperatorCatchupRecovery(
  raw: DatabaseSync,
  params: CloseFailedSourceOperatorCatchupParams,
): FailedSourceOperatorCatchupInspection {
  assertCanonicalSchema43(raw);
  const planId = requiredText(params.planId, 'Recovery plan ID');
  const conversationKey = requiredText(params.conversationKey, 'Conversation key');
  const actor = requiredText(params.actor, 'Recovery actor');
  const operatorEvidenceRef = requiredText(params.evidenceRef, 'Recovery evidence reference', 8192);
  const catchupSeq = positiveSeq(params.catchupSeq, 'Catch-up sequence');
  const sourceSeqs = normalizedSourceSeqs(params.expectedSourceSeqs);
  const acks = normalizedAckFingerprints(params.ackedDeliveredOpFingerprints);
  const fingerprint = params.deliveredOpFingerprint;
  if (acks.length > 0 && fingerprint === undefined) {
    throw new Error('Delivered-op acknowledgements require a fingerprint function');
  }

  const deliveredOps = selectDeliveredSourceOps(raw, sourceSeqs);
  const opFingerprints = fingerprint === undefined
    ? []
    : deliveredOps.map((op) => fingerprint(op)).sort();
  const acksMatch = deliveredOps.length === acks.length
    && opFingerprints.length === acks.length
    && opFingerprints.every((value, index) => value === acks[index]);
  const allClosable = deliveredOps.every((op) => op.closable);
  const evidenceRef = boundEvidenceRef(operatorEvidenceRef, deliveredOps);

  const plan = raw.prepare('SELECT plan_id FROM recovery_plans WHERE plan_id = ?').get(planId);
  if (plan) {
    const witness = raw.prepare(`
      SELECT 1 AS present
      FROM operator_catchup_closure_witnesses
      WHERE recovery_plan_id = ? AND conversation_key = ?
    `).get(planId, conversationKey);
    if (!witness) throw new Error('Failed-source recovery plan already exists');
    if (!acksMatch || !allClosable) {
      throw new Error('Recovery was already closed against a different catch-up or evidence');
    }
    const existing = inspectOperatorCatchupRecovery(raw, { ...params, evidenceRef });
    return { ...existing, deliveredOps, allClosable, acksMatch };
  }

  if (sourceSeqs.some((seq) => catchupSeq <= seq)) {
    throw new Error('Catch-up sequence must be later than every source sequence');
  }
  const selectSource = raw.prepare(`
    SELECT chat_jid, processing_status
    FROM inbound_events
    WHERE seq = ? AND conversation_key = ?
  `);
  // The source must be reply debt in the observer's failedTerminalDebt sense
  // (deploy/scripts/reply-guarantee-observer.py): its only terminal record is
  // an armed failed_terminal with no delivery that the operator did not
  // cancel. A second record of any kind means another disposition exists.
  const selectTerminalRecords = raw.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(
        terminal.inbound_disposition = 'failed_terminal'
        AND terminal.delivery_kind = 'none'
        AND terminal.delivery_op_id IS NULL
        AND terminal.reply_guarantee_disarmed = 0
        AND COALESCE(terminal.attempt_failure_class, '') <> 'operator_cancelled'
      ), 0) AS debt
    FROM turn_terminal_records terminal
    WHERE terminal.inbound_seq_key = ?
  `);
  // A recovery job owns the source's reply; closing it here would compete with
  // that owner (precedent: TerminalRecordInboundCloser.selectRecoveryJob).
  const selectRecoveryJob = raw.prepare(`
    SELECT 1 AS present FROM turn_recovery_jobs WHERE source_inbound_seq = ? LIMIT 1
  `);
  // Both columns, as TerminalRecordInboundCloser.selectLinked: a source that is
  // already another recovery's catch-up target has a disposition too.
  const selectLinked = raw.prepare(`
    SELECT 1 AS present FROM inbound_disposition_links
    WHERE inbound_seq = ? OR superseded_by_seq = ? LIMIT 1
  `);
  const sourceChats = new Set<string>();
  for (const seq of sourceSeqs) {
    const source = selectSource.get(seq, conversationKey) as {
      chat_jid: string;
      processing_status: string;
    } | undefined;
    if (!source) throw new Error('Failed source inbound does not exist in the recovery conversation');
    if (source.processing_status !== 'failed') throw new Error('Failed source inbound must be failed');
    const terminals = selectTerminalRecords.get(seq) as { total: number; debt: number };
    if (Number(terminals.total) !== 1 || Number(terminals.debt) !== 1) {
      throw new Error('Failed source inbound must have exactly one armed, undelivered failed terminal record');
    }
    if (selectRecoveryJob.get(seq)) throw new Error('Failed source inbound has a turn recovery job');
    if (selectLinked.get(seq, seq)) {
      throw new Error('Failed source inbound already has a disposition link');
    }
    sourceChats.add(source.chat_jid);
  }

  const { chatJid, deliveredReply } = inspectCatchupTarget(raw, conversationKey, catchupSeq);
  // The closure trigger requires target.chat_jid = source.chat_jid per link;
  // checking it here keeps a dry run from reporting ready for a closure the
  // write would reject.
  if (sourceChats.size !== 1 || !sourceChats.has(chatJid)) {
    throw new Error('Failed source inbound must share the catch-up chat');
  }

  return {
    planId,
    conversationKey,
    sourceSeqs,
    catchupSeq,
    actor,
    evidenceRef,
    evidenceBasis: deliveredReply.evidence_basis,
    terminalRecordId: deliveredReply.terminal_record_id,
    selectedOpId: deliveredReply.selected_op_id,
    recoveryJobId: deliveredReply.recovery_job_id,
    completionProofId: deliveredReply.completion_proof_id,
    wouldInsert: sourceSeqs.length,
    idempotent: false,
    openBefore: 0,
    openAfter: 0,
    deliveredOps,
    allClosable,
    acksMatch,
  };
}

/**
 * Enroll failed sources in a new operator recovery plan and close them against
 * a proven catch-up, atomically. Re-inspects inside the writer reservation, so
 * a link, op or op status that changed after a dry run makes the closure refuse.
 */
export function closeFailedSourceOperatorCatchupRecoveryRaw(
  raw: DatabaseSync,
  params: CloseFailedSourceOperatorCatchupParams,
  transactionalAttestation?: (transactionRaw: DatabaseSync) => void,
): CloseOperatorCatchupRecoveryReceipt {
  return withWriterReservation(raw, transactionalAttestation, () => {
    const {
      wouldInsert: _wouldInsert,
      deliveredOps: _deliveredOps,
      allClosable,
      acksMatch,
      ...inspection
    } = inspectFailedSourceOperatorCatchupRecovery(raw, params);
    if (inspection.idempotent) return { ...inspection, inserted: 0 };
    if (!allClosable) {
      throw new Error('Failed source inbound has an outbound op that is not an echoed registered failure notice');
    }
    if (!acksMatch) {
      throw new Error('Delivered-op acknowledgements must match the delivered failure-notice ops exactly');
    }

    const planInserted = Number(raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES (?, 'operator', ?, ?, ?)
    `).run(
      inspection.planId,
      inspection.actor,
      FAILED_SOURCE_PLAN_SUMMARY,
      inspection.evidenceRef,
    ).changes);
    if (planInserted !== 1) throw new Error('Failed-source recovery plan was not recorded exactly once');
    const insertPending = raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL, ?, ?, ?)
    `);
    for (const seq of inspection.sourceSeqs) {
      const changes = Number(insertPending.run(
        seq,
        inspection.planId,
        FAILED_SOURCE_PENDING_REASON,
        inspection.evidenceRef,
        inspection.actor,
      ).changes);
      if (changes !== 1) {
        throw new Error('Pending operator catch-up disposition was not recorded exactly once');
      }
    }

    const receipt = closeInspectedOperatorCatchupRecovery(raw, {
      ...params,
      evidenceRef: inspection.evidenceRef,
    });
    if (receipt.idempotent || receipt.inserted !== inspection.sourceSeqs.length) {
      throw new Error('Catch-up closure did not resolve the exact recovery set');
    }
    // Nothing was open before this transaction; the pending links it wrote are
    // closed by the same transaction.
    return { ...receipt, openBefore: 0 };
  });
}

// ---------------------------------------------------------------------------
// Automatic catch-up reconciler (see docs/turn-recovery-continuity-reconciler.md)
//
// A pure selector on top of the closure primitive above: it invents no new
// proof or closure semantics. For each open pending (plan, conversation) group
// it picks the earliest later inbound that carries a unique delivery proof and
// calls closeOperatorCatchupRecoveryRaw verbatim. Every closure is still
// re-proven by inspectOperatorCatchupRecovery AND independently by the DB
// trigger inbound_disposition_closure_validate_insert, so a wrong selection
// fails closed and cannot corrupt state. The reconciler is therefore
// best-effort: unprovable groups stay correctly pending.
// ---------------------------------------------------------------------------

export const RECONCILE_DEFAULT_GROUP_LIMIT = 50;
export const RECONCILE_DEFAULT_ACTOR = 'auto_reconciler';
/**
 * Groups a pass may examine for each group it is allowed to attempt a closure
 * on. A group with no catch-up candidate costs an examination but not an
 * attempt, so the pass reaches closable groups sitting behind unattemptable
 * ones while the per-group work stays bounded.
 */
export const RECONCILE_EXAMINATION_MULTIPLIER = 20;

export interface ReconcileOperatorCatchupParams {
  /** Ledger actor recorded on auto-closed links. Defaults to 'auto_reconciler'. */
  actor?: string;
  /**
   * Max closure attempts per invocation. A group with no catch-up candidate
   * does not charge it; up to `groupLimit * RECONCILE_EXAMINATION_MULTIPLIER`
   * groups are examined per pass.
   */
  groupLimit?: number;
}

export type ReconcileSkipReason =
  | 'no_catchup_candidate'
  | 'closure_rejected'
  | 'busy'
  | 'error';

export interface ReconcileSkip {
  planId: string;
  conversationKey: string;
  nSourceSeqs: number;
  reason: ReconcileSkipReason;
}

export interface ReconcileOperatorCatchupReport {
  /** Groups with a candidate catch-up that a closure was attempted for. */
  attempted: number;
  /** Groups whose open set was fully superseded. */
  closed: number;
  /** Total disposition links moved to superseded_by_operator_catchup. */
  linksClosed: number;
  /** Groups left pending this pass (no candidate, or a fail-closed rejection). */
  skipped: number;
  skips: ReconcileSkip[];
}

interface PendingGroupRow {
  plan_id: string;
  conversation_key: string;
  chat_jid: string;
  inbound_seq: number;
}

// Known, benign fail-closed rejections from the closure primitive and the DB
// trigger. Anything NOT in this set (e.g. a schema-drift assertion or an
// unexpected bug) is reported as 'error' so the caller can alert rather than
// silently treat it as a normal not-yet-superseded group.
const BENIGN_CLOSURE_REJECTIONS: ReadonlySet<string> = new Set([
  'Recovery plan does not exist',
  'Expected source sequences must exactly match the pending recovery set',
  'Catch-up sequence must be later than every source sequence',
  'Catch-up inbound does not exist in the recovery conversation',
  'Catch-up inbound must be complete',
  'Catch-up reply must have echoed delivery proof',
  'Catch-up closure did not resolve the exact recovery set',
  'Catch-up closure did not persist its exact proof witness',
  'Recovery was already closed against a different catch-up or evidence',
  'Closed recovery lacks its exact durable proof witness',
  'invalid operator catch-up closure',
]);

/**
 * Classify a per-group closure failure into a bounded skip reason. Exported so
 * the operator batch command reports rejections in the reconciler's own terms.
 */
export function classifyReconcileSkip(error: unknown): ReconcileSkipReason {
  const sqliteError = error as { code?: unknown; errcode?: unknown };
  if (
    sqliteError?.code === 'ERR_SQLITE_ERROR'
    && typeof sqliteError.errcode === 'number'
    && (sqliteError.errcode === 5 || sqliteError.errcode === 6)
  ) {
    return 'busy';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|database table is locked/i.test(message)) return 'busy';
  if (BENIGN_CLOSURE_REJECTIONS.has(message)) return 'closure_rejected';
  return 'error';
}

/** One open pending (plan, conversation) group and the catch-up it would close against. */
export interface OperatorCatchupCandidateGroup {
  planId: string;
  conversationKey: string;
  chatJid: string;
  /** Pending source sequences, ascending. */
  sourceSeqs: number[];
  /** Earliest same-chat delivery-proof target later than every source, or null. */
  catchupSeq: number | null;
}

/**
 * The reconciler's selection rule, without closing anything: enumerate open
 * pending groups in stable order and pair each with its catch-up candidate,
 * under the same two budgets reconcileOperatorCatchupRecoveries applies (a
 * group with a candidate charges `groupLimit`; every examined group charges
 * `groupLimit * RECONCILE_EXAMINATION_MULTIPLIER`). Read-only.
 *
 * Shared by the reconciler and the operator batch command so both select the
 * same target for the same state; neither invents its own proof rule.
 */
export function selectOperatorCatchupCandidates(
  raw: DatabaseSync,
  groupLimit: number = RECONCILE_DEFAULT_GROUP_LIMIT,
): OperatorCatchupCandidateGroup[] {
  if (!Number.isSafeInteger(groupLimit) || groupLimit <= 0) {
    throw new Error('Reconciler group limit must be a positive safe integer');
  }

  // Plain autocommit read; the per-group closure below opens its own
  // BEGIN IMMEDIATE single-writer reservation.
  const rows = allFromStatement<PendingGroupRow>(raw.prepare(`
    SELECT links.recovery_plan_id AS plan_id,
           source.conversation_key AS conversation_key,
           source.chat_jid AS chat_jid,
           links.inbound_seq AS inbound_seq
    FROM inbound_disposition_links links
    JOIN inbound_events source ON source.seq = links.inbound_seq
    WHERE links.disposition = 'recovery_pending_operator_catchup'
      AND links.superseded_by_seq IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM inbound_disposition_links closed
        WHERE closed.inbound_seq = links.inbound_seq
          AND closed.recovery_plan_id = links.recovery_plan_id
          AND closed.disposition = 'superseded_by_operator_catchup'
      )
    ORDER BY links.recovery_plan_id, source.conversation_key, links.inbound_seq
  `));

  const groups = new Map<string, {
    planId: string;
    conversationKey: string;
    chatJid: string;
    seqs: number[];
  }>();
  for (const row of rows) {
    // The separator is U+0000, written as an escape so line tools do not
    // treat this file as binary.
    const key = `${row.plan_id}\x00${row.conversation_key}`;
    let bucket = groups.get(key);
    if (!bucket) {
      // Rows are ordered by inbound_seq, so this is the earliest source's chat.
      bucket = {
        planId: row.plan_id,
        conversationKey: row.conversation_key,
        chatJid: row.chat_jid,
        seqs: [],
      };
      groups.set(key, bucket);
    }
    bucket.seqs.push(row.inbound_seq);
  }

  // Earliest unambiguous delivery proof strictly later than every source seq,
  // on the sources' own chat. A closure inserts one link per source and the
  // trigger inbound_disposition_closure_validate_insert requires
  // target.chat_jid = source.chat_jid on every one of them, so a proof from
  // another chat under the same conversation_key can never close the group.
  // Without the chat filter such a proof, whenever it sorts earliest, is
  // re-picked on every pass and the group never closes even though its own
  // catch-up is provable. A group whose sources span several chats cannot close
  // under any target; it is still attempted and the trigger rejects it closed.
  const candidate = raw.prepare(`
    SELECT MIN(target_seq) AS catchup_seq
    FROM operator_catchup_delivery_proofs
    WHERE conversation_key = ? AND chat_jid = ? AND target_seq > ?
  `);

  const selected: OperatorCatchupCandidateGroup[] = [];
  let withCandidate = 0;

  // Two budgets. groupLimit caps closure attempts. examinationLimit caps how
  // many groups the pass may look at, because a group with no candidate no
  // longer charges groupLimit: without a second cap a large backlog of
  // candidate-less groups would be probed in full. Enumeration order is a
  // stable recovery_plan_id, so this raises the point at which a fixed prefix
  // of unattemptable groups starves the ones behind it from groupLimit to
  // examinationLimit rather than removing it. It bounds the per-group candidate
  // probes and closure attempts only; the enumeration query above still reads
  // every open pending link.
  const examinationLimit = groupLimit * RECONCILE_EXAMINATION_MULTIPLIER;
  let examined = 0;
  for (const bucket of groups.values()) {
    if (withCandidate >= groupLimit) break;
    if (examined >= examinationLimit) break;
    examined += 1;
    // seqs are ORDER BY inbound_seq ASC, so the last is the max.
    const maxSourceSeq = bucket.seqs[bucket.seqs.length - 1];
    const candidateRow = candidate.get(bucket.conversationKey, bucket.chatJid, maxSourceSeq) as
      | { catchup_seq: number | null }
      | undefined;
    const catchupSeq = candidateRow?.catchup_seq ?? null;
    if (catchupSeq !== null) withCandidate += 1;
    selected.push({
      planId: bucket.planId,
      conversationKey: bucket.conversationKey,
      chatJid: bucket.chatJid,
      sourceSeqs: bucket.seqs,
      catchupSeq,
    });
  }
  return selected;
}

/**
 * Automatically close every open catch-up recovery whose conversation has
 * demonstrably caught up (a later completed inbound with a unique, echoed
 * delivery proof). Uses a raw, already-open SQLite handle with foreign-key
 * enforcement; each group's closure runs in its own single-writer transaction
 * inside closeOperatorCatchupRecoveryRaw. Never throws for a per-group closure
 * rejection — those are recorded as bounded skips — so one unprovable group
 * cannot stall the rest of the sweep.
 */
export function reconcileOperatorCatchupRecoveries(
  raw: DatabaseSync,
  params: ReconcileOperatorCatchupParams = {},
): ReconcileOperatorCatchupReport {
  const actor = requiredText(params.actor ?? RECONCILE_DEFAULT_ACTOR, 'Reconciler actor');
  const groupLimit = params.groupLimit ?? RECONCILE_DEFAULT_GROUP_LIMIT;
  // Candidates are read up front. A closure only appends disposition links, and
  // the candidate query reads delivery proofs alone, so closing one group cannot
  // change another group's candidate: this matches probing between closures.
  const selected = selectOperatorCatchupCandidates(raw, groupLimit);

  const report: ReconcileOperatorCatchupReport = {
    attempted: 0, closed: 0, linksClosed: 0, skipped: 0, skips: [],
  };
  for (const group of selected) {
    const { catchupSeq } = group;
    if (catchupSeq === null) {
      report.skipped += 1;
      report.skips.push({
        planId: group.planId,
        conversationKey: group.conversationKey,
        nSourceSeqs: group.sourceSeqs.length,
        reason: 'no_catchup_candidate',
      });
      continue;
    }
    report.attempted += 1;
    try {
      const receipt = closeOperatorCatchupRecoveryRaw(raw, {
        planId: group.planId,
        conversationKey: group.conversationKey,
        expectedSourceSeqs: group.sourceSeqs,
        catchupSeq,
        actor,
        evidenceRef: `auto://catchup-delivery-proof:seq=${catchupSeq}`,
      });
      report.closed += 1;
      report.linksClosed += receipt.inserted;
    } catch (error) {
      report.skipped += 1;
      report.skips.push({
        planId: group.planId,
        conversationKey: group.conversationKey,
        nSourceSeqs: group.sourceSeqs.length,
        reason: classifyReconcileSkip(error),
      });
    }
  }
  return report;
}
