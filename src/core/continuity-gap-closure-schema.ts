// Read side of the migration-65 continuity-gap closure ledger. Health and the
// closure command both read through here, so a malformed row fails every
// reader the same way instead of being counted as zero debt.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const CONTINUITY_GAP_CLOSURE_CONTRACT = 'continuity-gap-closure.v1';
export const CONTINUITY_GAP_CLOSURE_MIGRATION = 65;

export type ContinuityGapDisposition = 'addressed' | 'declined';
export type ContinuityGapProofKind = 'live_reissue' | 'sender_declined' | 'owner_declined';
export type ContinuityGapOriginalClassification = 'absent' | 'observed_not_admitted' | 'ambiguous';

/** One append-only closure row, in the exact column order of migration 65. */
export interface ContinuityGapClosureRecord {
  planId: string;
  contractVersion: typeof CONTINUITY_GAP_CLOSURE_CONTRACT;
  operationId: string;
  receiptFingerprint: string;
  originalClassification: ContinuityGapOriginalClassification;
  originalContentType: string;
  disposition: ContinuityGapDisposition;
  proofKind: ContinuityGapProofKind;
  evidenceManifestSha256: string;
  originalManifestSha256: string;
  proofSetSha256: string;
  linkedInboundSeq: number;
  linkedMessageSha256: string;
  terminalRecordId: number | null;
  audioMediaSha256: string | null;
  audioTranscriptSha256: string | null;
  ambiguityResolutionSha256: string | null;
  decisionRecordSha256: string | null;
  decisionSource: string | null;
  policySha256: string | null;
  policyVersion: string | null;
  actor: string;
  authority: string;
  observedAt: string;
  decidedAt: string;
}

export type UnsignedContinuityGapClosure = Omit<ContinuityGapClosureRecord, 'operationId'>;

export type ContinuityGapClosureLedger =
  | { state: 'absent' }
  | { state: 'present'; rows: ContinuityGapClosureRecord[] };

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PLAN_ID_PATTERN = /^continuity-gap:v1:[a-f0-9]{64}$/;
const GUARD_TRIGGERS = [
  'continuity_gap_closures_append_only_delete',
  'continuity_gap_closures_append_only_update',
  'continuity_gap_closures_validate_insert',
] as const;

// Every bound field except the operation ID itself, in a fixed order.
const OPERATION_FIELDS = [
  'planId', 'contractVersion', 'receiptFingerprint', 'originalClassification',
  'originalContentType', 'disposition', 'proofKind', 'evidenceManifestSha256',
  'originalManifestSha256', 'proofSetSha256', 'linkedInboundSeq', 'linkedMessageSha256',
  'terminalRecordId', 'audioMediaSha256', 'audioTranscriptSha256',
  'ambiguityResolutionSha256', 'decisionRecordSha256', 'decisionSource', 'policySha256',
  'policyVersion', 'actor', 'authority', 'observedAt', 'decidedAt',
] as const satisfies ReadonlyArray<keyof UnsignedContinuityGapClosure>;

/** Deterministic operation ID: SHA-256 over every bound closure field. */
export function continuityGapClosureOperationId(record: UnsignedContinuityGapClosure): string {
  const canonical = JSON.stringify(OPERATION_FIELDS.map((field) => [field, record[field]]));
  return createHash('sha256').update(`continuity-gap-closure-operation:v1\n${canonical}`).digest('hex');
}

interface ClosureRow {
  plan_id: unknown;
  contract_version: unknown;
  operation_id: unknown;
  receipt_fingerprint: unknown;
  original_classification: unknown;
  original_content_type: unknown;
  disposition: unknown;
  proof_kind: unknown;
  evidence_manifest_sha256: unknown;
  original_manifest_sha256: unknown;
  proof_set_sha256: unknown;
  linked_inbound_seq: unknown;
  linked_message_sha256: unknown;
  terminal_record_id: unknown;
  audio_media_sha256: unknown;
  audio_transcript_sha256: unknown;
  ambiguity_resolution_sha256: unknown;
  decision_record_sha256: unknown;
  decision_source: unknown;
  policy_sha256: unknown;
  policy_version: unknown;
  actor: unknown;
  authority: unknown;
  observed_at: unknown;
  decided_at: unknown;
}

function malformed(): Error {
  return new Error('continuity gap closure ledger contains a malformed closure');
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw malformed();
  return value;
}

function optionalHash(value: unknown): string | null {
  return value === null ? null : hash(value);
}

function text(value: unknown, maxBytes: number): string {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw malformed();
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric) || numeric < 1) {
    throw malformed();
  }
  return numeric;
}

function instant(value: unknown): string {
  const parsed = text(value, 30);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(parsed)
    || Number.isNaN(Date.parse(parsed))) {
    throw malformed();
  }
  return parsed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw malformed();
  }
  return value as T;
}

/**
 * Re-validates a stored row with the same rules migration 65 enforces. The
 * table can be recreated without its CHECKs (schema self-heal recreates tables
 * but not triggers), so the reader never trusts the constraints alone.
 */
export function closureRecordFromRow(row: ClosureRow): ContinuityGapClosureRecord {
  const planId = text(row.plan_id, 82);
  if (!PLAN_ID_PATTERN.test(planId)) throw malformed();
  const record: ContinuityGapClosureRecord = {
    planId,
    contractVersion: oneOf(row.contract_version, [CONTINUITY_GAP_CLOSURE_CONTRACT]),
    operationId: hash(row.operation_id),
    receiptFingerprint: hash(row.receipt_fingerprint),
    originalClassification: oneOf(
      row.original_classification,
      ['absent', 'observed_not_admitted', 'ambiguous'],
    ),
    originalContentType: text(row.original_content_type, 64),
    disposition: oneOf(row.disposition, ['addressed', 'declined']),
    proofKind: oneOf(row.proof_kind, ['live_reissue', 'sender_declined', 'owner_declined']),
    evidenceManifestSha256: hash(row.evidence_manifest_sha256),
    originalManifestSha256: hash(row.original_manifest_sha256),
    proofSetSha256: hash(row.proof_set_sha256),
    linkedInboundSeq: positiveInteger(row.linked_inbound_seq),
    linkedMessageSha256: hash(row.linked_message_sha256),
    terminalRecordId: row.terminal_record_id === null
      ? null
      : positiveInteger(row.terminal_record_id),
    audioMediaSha256: optionalHash(row.audio_media_sha256),
    audioTranscriptSha256: optionalHash(row.audio_transcript_sha256),
    ambiguityResolutionSha256: optionalHash(row.ambiguity_resolution_sha256),
    decisionRecordSha256: optionalHash(row.decision_record_sha256),
    decisionSource: row.decision_source === null
      ? null
      : oneOf(row.decision_source, ['original_sender_inbound@1', 'owner_inbound@1']),
    policySha256: optionalHash(row.policy_sha256),
    policyVersion: row.policy_version === null ? null : text(row.policy_version, 128),
    actor: text(row.actor, 256),
    authority: text(row.authority, 512),
    observedAt: instant(row.observed_at),
    decidedAt: instant(row.decided_at),
  };
  assertClosureShape(record);
  const { operationId, ...unsigned } = record;
  if (continuityGapClosureOperationId(unsigned) !== operationId) throw malformed();
  return record;
}

/** Disposition ↔ proof shape, identical to the migration-65 CHECK. */
export function assertClosureShape(record: ContinuityGapClosureRecord): void {
  const audio = record.originalContentType === 'audio';
  const ambiguousShape = (record.originalClassification === 'ambiguous')
    === (record.ambiguityResolutionSha256 !== null);
  const policyShape = (record.policySha256 === null) === (record.policyVersion === null);
  const ordered = Date.parse(record.decidedAt) <= Date.parse(record.observedAt);
  const addressed = record.disposition === 'addressed'
    && record.proofKind === 'live_reissue'
    && record.terminalRecordId !== null
    && record.decisionRecordSha256 === null
    && record.decisionSource === null
    && (audio
      ? record.audioMediaSha256 !== null && record.audioTranscriptSha256 !== null
      : record.audioMediaSha256 === null && record.audioTranscriptSha256 === null);
  const declined = record.disposition === 'declined'
    && (record.proofKind === 'sender_declined' || record.proofKind === 'owner_declined')
    && record.terminalRecordId === null
    && record.decisionRecordSha256 !== null
    && record.decisionSource === (record.proofKind === 'sender_declined'
      ? 'original_sender_inbound@1'
      : 'owner_inbound@1')
    && record.policySha256 !== null
    && record.audioTranscriptSha256 === null
    && (audio || record.audioMediaSha256 === null);
  if (!ambiguousShape || !policyShape || !ordered || !(addressed || declined)) throw malformed();
}

function migrationRecorded(raw: DatabaseSync): boolean {
  const ledger = raw.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  if (!ledger) return false;
  return raw.prepare('SELECT 1 FROM schema_migrations WHERE version >= ? LIMIT 1')
    .get(CONTINUITY_GAP_CLOSURE_MIGRATION) !== undefined;
}

/**
 * Returns every closure, validated, or `absent` for a database that never ran
 * migration 65. Throws when the table vanished after the migration was
 * recorded, lost an append-only guard, or holds a malformed or duplicate row.
 */
export function readContinuityGapClosureLedger(raw: DatabaseSync): ContinuityGapClosureLedger {
  const objects = raw.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE (type = 'table' AND name = 'continuity_gap_closures')
       OR (type = 'trigger' AND tbl_name = 'continuity_gap_closures')
  `).all() as Array<{ type: string; name: string }>;
  const hasTable = objects.some((object) => object.type === 'table');
  if (!hasTable) {
    if (migrationRecorded(raw)) {
      throw new Error('continuity gap closure ledger is missing after migration 65');
    }
    return { state: 'absent' };
  }
  const triggers = new Set(objects.filter((o) => o.type === 'trigger').map((o) => o.name));
  if (!GUARD_TRIGGERS.every((name) => triggers.has(name))) {
    throw new Error('continuity gap closure ledger guards are missing');
  }
  const rows = raw.prepare(`
    SELECT plan_id, contract_version, operation_id, receipt_fingerprint,
           original_classification, original_content_type, disposition, proof_kind,
           evidence_manifest_sha256, original_manifest_sha256, proof_set_sha256,
           linked_inbound_seq, linked_message_sha256, terminal_record_id,
           audio_media_sha256, audio_transcript_sha256, ambiguity_resolution_sha256,
           decision_record_sha256, decision_source, policy_sha256, policy_version,
           actor, authority, observed_at, decided_at
    FROM continuity_gap_closures
    ORDER BY rowid
  `).all() as unknown as ClosureRow[];
  const records = rows.map(closureRecordFromRow);
  const plans = new Set<string>();
  const operations = new Set<string>();
  for (const record of records) {
    if (plans.has(record.planId) || operations.has(record.operationId)) {
      throw new Error('continuity gap closure ledger contains a duplicate closure');
    }
    plans.add(record.planId);
    operations.add(record.operationId);
  }
  return { state: 'present', rows: records };
}
