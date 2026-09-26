// Write side of continuity-gap closure: one append-only row per recorded gap,
// written only inside an immediate writer reservation that re-runs the caller's
// full evidence check first. See docs/runbook.md, "Close a continuity gap".
import type { DatabaseSync } from 'node:sqlite';
import { readContinuityGapLedger } from './continuity-gap-ledger.ts';
import {
  assertClosureShape,
  continuityGapClosureOperationId,
  readContinuityGapClosureLedger,
  type ContinuityGapClosureRecord,
} from './continuity-gap-closure-schema.ts';

export {
  continuityGapClosureOperationId,
  type UnsignedContinuityGapClosure,
} from './continuity-gap-closure-schema.ts';

export type ContinuityGapClosureFailureKind = 'blocked' | 'conflict';

/**
 * `blocked`: a required input, predecessor or authority is unavailable.
 * `conflict` (CLOSURE_PROOF_CONFLICT): evidence contradicts the recorded gap
 * or an existing closure. Both are raised before any write.
 */
export class ContinuityGapClosureError extends Error {
  readonly kind: ContinuityGapClosureFailureKind;
  readonly condition: string;

  constructor(kind: ContinuityGapClosureFailureKind, condition: string, message: string) {
    super(message);
    this.name = 'ContinuityGapClosureError';
    this.kind = kind;
    this.condition = condition;
  }
}

export interface ContinuityGapClosureInspection {
  state: 'open' | 'already_closed';
}

function sameRecord(left: ContinuityGapClosureRecord, right: ContinuityGapClosureRecord): boolean {
  const keys = Object.keys(left) as Array<keyof ContinuityGapClosureRecord>;
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/**
 * Decides, without writing, whether `record` may be appended: the plan must be
 * one recorded open gap for this receipt, and any existing closure must be the
 * same operation. Callers inside a transaction get a decision that holds for
 * the rest of that transaction.
 */
export function inspectContinuityGapClosure(
  raw: DatabaseSync,
  record: ContinuityGapClosureRecord,
): ContinuityGapClosureInspection {
  try {
    assertClosureShape(record);
  } catch {
    throw new ContinuityGapClosureError(
      'conflict',
      'invalid_proof_shape',
      'Closure disposition and proof shape do not match',
    );
  }
  const { operationId, ...unsigned } = record;
  if (continuityGapClosureOperationId(unsigned) !== operationId) {
    throw new ContinuityGapClosureError(
      'conflict',
      'operation_id_mismatch',
      'Closure operation ID does not match its bound evidence',
    );
  }
  const closures = readContinuityGapClosureLedger(raw);
  if (closures.state === 'absent') {
    throw new ContinuityGapClosureError(
      'blocked',
      'schema_not_migrated',
      'Database has not applied migration 66; run the service binary to migrate it first',
    );
  }
  const gap = readContinuityGapLedger(raw).find((entry) => entry.planId === record.planId);
  if (!gap) {
    throw new ContinuityGapClosureError(
      'blocked',
      'gap_not_recorded',
      'No recorded continuity gap has this plan ID',
    );
  }
  if (
    gap.observation.receiptFingerprint !== record.receiptFingerprint
    || gap.observation.classification !== record.originalClassification
  ) {
    throw new ContinuityGapClosureError(
      'conflict',
      'stale_fingerprint',
      'Closure receipt fingerprint or classification differs from the recorded gap',
    );
  }
  const existing = closures.rows.find((row) => row.planId === record.planId);
  if (!existing) return { state: 'open' };
  if (sameRecord(existing, record)) return { state: 'already_closed' };
  throw new ContinuityGapClosureError(
    'conflict',
    'closure_changed',
    'This gap already has a different closure',
  );
}

export interface ContinuityGapClosureApplyResult {
  inserted: boolean;
  idempotent: boolean;
  record: ContinuityGapClosureRecord;
}

/**
 * Takes the writer reservation, runs `build` (the full evidence recheck) on the
 * same connection, then appends the closure or returns the recorded outcome
 * for the same operation. Any failure rolls back; nothing partial remains.
 */
export function applyContinuityGapClosure(
  raw: DatabaseSync,
  build: (raw: DatabaseSync) => ContinuityGapClosureRecord,
): ContinuityGapClosureApplyResult {
  raw.exec('BEGIN IMMEDIATE');
  let open = true;
  try {
    const record = build(raw);
    const inspection = inspectContinuityGapClosure(raw, record);
    if (inspection.state === 'open') insertClosure(raw, record);
    raw.exec('COMMIT');
    open = false;
    return inspection.state === 'open'
      ? { inserted: true, idempotent: false, record }
      : { inserted: false, idempotent: true, record };
  } catch (error) {
    if (open) {
      try {
        raw.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Continuity gap closure failed and rollback did not complete',
        );
      }
    }
    throw error;
  }
}

function insertClosure(raw: DatabaseSync, record: ContinuityGapClosureRecord): void {
  const changes = raw.prepare(`
    INSERT INTO continuity_gap_closures (
      plan_id, contract_version, operation_id, receipt_fingerprint,
      original_classification, original_content_type, disposition, proof_kind,
      evidence_manifest_sha256, original_manifest_sha256, proof_set_sha256,
      linked_inbound_seq, linked_message_sha256, terminal_record_id,
      audio_media_sha256, audio_transcript_sha256, ambiguity_resolution_sha256,
      decision_record_sha256, decision_source, policy_sha256, policy_version,
      actor, authority, observed_at, decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.planId,
    record.contractVersion,
    record.operationId,
    record.receiptFingerprint,
    record.originalClassification,
    record.originalContentType,
    record.disposition,
    record.proofKind,
    record.evidenceManifestSha256,
    record.originalManifestSha256,
    record.proofSetSha256,
    record.linkedInboundSeq,
    record.linkedMessageSha256,
    record.terminalRecordId,
    record.audioMediaSha256,
    record.audioTranscriptSha256,
    record.ambiguityResolutionSha256,
    record.decisionRecordSha256,
    record.decisionSource,
    record.policySha256,
    record.policyVersion,
    record.actor,
    record.authority,
    record.observedAt,
    record.decidedAt,
  ).changes;
  if (Number(changes) !== 1) {
    throw new Error('Continuity gap closure insert did not append exactly one row');
  }
}
