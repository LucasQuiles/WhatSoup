// Fixtures for continuity-gap closure tests. Every identifier is fabricated;
// nothing here derives from a real conversation, sender or message.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  continuityGapPlanId,
  recordContinuityGaps,
  type ContinuityGapObservation,
} from '../../../src/core/continuity-gap-ledger.ts';
import {
  CONTINUITY_GAP_CLOSURE_CONTRACT,
  type ContinuityGapClosureRecord,
} from '../../../src/core/continuity-gap-closure-schema.ts';
import {
  continuityGapClosureOperationId,
  type UnsignedContinuityGapClosure,
} from '../../../src/core/continuity-gap-closure.ts';

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function gapObservation(
  ordinal: number,
  classification: ContinuityGapObservation['classification'],
): ContinuityGapObservation {
  return {
    ordinal,
    classification,
    receiptFingerprint: digest(`fixture-receipt-${ordinal}`),
    destinationFingerprint: digest('fixture-destination'),
    manifestFingerprint: digest('fixture-manifest'),
    evidenceFingerprint: digest('fixture-evidence'),
  };
}

/** Records gaps and returns their deterministic plan IDs, in input order. */
export function recordGaps(
  raw: DatabaseSync,
  observations: ContinuityGapObservation[],
): string[] {
  recordContinuityGaps(raw, observations);
  return observations.map(continuityGapPlanId);
}

export function unsignedClosure(
  observation: ContinuityGapObservation,
  overrides: Partial<UnsignedContinuityGapClosure> = {},
): UnsignedContinuityGapClosure {
  const disposition = overrides.disposition ?? 'addressed';
  const declined = disposition === 'declined';
  return {
    planId: continuityGapPlanId(observation),
    contractVersion: CONTINUITY_GAP_CLOSURE_CONTRACT,
    receiptFingerprint: observation.receiptFingerprint,
    originalClassification: observation.classification,
    originalContentType: 'text',
    disposition,
    proofKind: declined ? 'sender_declined' : 'live_reissue',
    evidenceManifestSha256: digest(`evidence-manifest-${observation.ordinal}`),
    originalManifestSha256: digest('original-manifest'),
    proofSetSha256: digest(`proof-set-${observation.ordinal}`),
    linkedInboundSeq: 100 + observation.ordinal,
    linkedMessageSha256: digest(`live-message-${observation.ordinal}`),
    terminalRecordId: declined ? null : 500 + observation.ordinal,
    audioMediaSha256: null,
    audioTranscriptSha256: null,
    ambiguityResolutionSha256: observation.classification === 'ambiguous'
      ? digest(`resolution-${observation.ordinal}`)
      : null,
    decisionRecordSha256: declined ? digest(`decision-${observation.ordinal}`) : null,
    decisionSource: declined ? 'original_sender_inbound@1' : null,
    policySha256: declined ? digest('policy') : null,
    policyVersion: declined ? 'fixture-policy-1' : null,
    actor: 'operator:fixture',
    authority: 'owner-request:fixture',
    observedAt: '2026-09-25T00:10:00.000Z',
    decidedAt: '2026-09-25T00:05:00.000Z',
    ...overrides,
  };
}

export function signedClosure(
  observation: ContinuityGapObservation,
  overrides: Partial<UnsignedContinuityGapClosure> = {},
): ContinuityGapClosureRecord {
  const unsigned = unsignedClosure(observation, overrides);
  return { ...unsigned, operationId: continuityGapClosureOperationId(unsigned) };
}

/** Test-owned SQL: the column list is part of the migration-65 contract. */
export function insertClosureRow(raw: DatabaseSync, record: ContinuityGapClosureRecord): void {
  raw.prepare(`
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
  );
}
