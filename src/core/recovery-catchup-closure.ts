import type { DatabaseSync } from 'node:sqlite';
import type { Database } from './database.ts';
import { assertCanonicalSchema43 } from './database-migration-43.ts';
import { withTransaction } from './db-tx.ts';
import { allFromStatement } from '../lib/db-query.ts';

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

export interface ReconcileOperatorCatchupParams {
  /** Ledger actor recorded on auto-closed links. Defaults to 'auto_reconciler'. */
  actor?: string;
  /** Max distinct (plan, conversation) groups processed per invocation. */
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

function classifyReconcileSkip(error: unknown): ReconcileSkipReason {
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
  if (!Number.isSafeInteger(groupLimit) || groupLimit <= 0) {
    throw new Error('Reconciler group limit must be a positive safe integer');
  }

  // Plain autocommit read; the per-group closure below opens its own
  // BEGIN IMMEDIATE single-writer reservation.
  const rows = allFromStatement<PendingGroupRow>(raw.prepare(`
    SELECT links.recovery_plan_id AS plan_id,
           source.conversation_key AS conversation_key,
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

  const groups = new Map<string, { planId: string; conversationKey: string; seqs: number[] }>();
  for (const row of rows) {
    const key = `${row.plan_id} ${row.conversation_key}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = { planId: row.plan_id, conversationKey: row.conversation_key, seqs: [] };
      groups.set(key, bucket);
    }
    bucket.seqs.push(row.inbound_seq);
  }

  // Earliest unambiguous delivery proof strictly later than every source seq.
  const candidate = raw.prepare(`
    SELECT MIN(target_seq) AS catchup_seq
    FROM operator_catchup_delivery_proofs
    WHERE conversation_key = ? AND target_seq > ?
  `);

  const report: ReconcileOperatorCatchupReport = {
    attempted: 0, closed: 0, linksClosed: 0, skipped: 0, skips: [],
  };

  let processed = 0;
  for (const bucket of groups.values()) {
    if (processed >= groupLimit) break;
    processed += 1;
    // seqs are ORDER BY inbound_seq ASC, so the last is the max.
    const maxSourceSeq = bucket.seqs[bucket.seqs.length - 1];
    const candidateRow = candidate.get(bucket.conversationKey, maxSourceSeq) as
      | { catchup_seq: number | null }
      | undefined;
    const catchupSeq = candidateRow?.catchup_seq ?? null;
    if (catchupSeq === null) {
      report.skipped += 1;
      report.skips.push({
        planId: bucket.planId,
        conversationKey: bucket.conversationKey,
        nSourceSeqs: bucket.seqs.length,
        reason: 'no_catchup_candidate',
      });
      continue;
    }
    report.attempted += 1;
    try {
      const receipt = closeOperatorCatchupRecoveryRaw(raw, {
        planId: bucket.planId,
        conversationKey: bucket.conversationKey,
        expectedSourceSeqs: bucket.seqs,
        catchupSeq,
        actor,
        evidenceRef: `auto://catchup-delivery-proof:seq=${catchupSeq}`,
      });
      report.closed += 1;
      report.linksClosed += receipt.inserted;
    } catch (error) {
      report.skipped += 1;
      report.skips.push({
        planId: bucket.planId,
        conversationKey: bucket.conversationKey,
        nSourceSeqs: bucket.seqs.length,
        reason: classifyReconcileSkip(error),
      });
    }
  }
  return report;
}
