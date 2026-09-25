// continuity-closure-evidence.v1: turns a protected evidence manifest into one
// verified closure record, or a Blocked / CLOSURE_PROOF_CONFLICT decision. The
// same function runs for preview (on a static snapshot) and inside the apply
// transaction, so apply always rechecks every file digest and database link.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ContinuityGapClosureError,
  continuityGapClosureOperationId,
  type UnsignedContinuityGapClosure,
} from '../../src/core/continuity-gap-closure.ts';
import {
  CONTINUITY_GAP_CLOSURE_CONTRACT,
  readContinuityGapClosureLedger,
  type ContinuityGapClosureRecord,
} from '../../src/core/continuity-gap-closure-schema.ts';
import {
  readContinuityGapLedger,
  type ContinuityGapLedgerEntry,
} from '../../src/core/continuity-gap-ledger.ts';
import { isRecord } from '../../src/lib/type-guards.ts';
import {
  acceptedVerifier,
  loadClosureAuthorityPolicy,
  verifyDecision,
  type LoadedClosureAuthorityPolicy,
} from './continuity-closure-authority.ts';
import {
  continuityDestinationFingerprint,
  continuityReceiptFingerprints,
  parseContinuityManifest,
  type ContinuityManifestReceipt,
} from './continuity-manifest-audit.ts';

export const CLOSURE_EVIDENCE_CONTRACT = 'continuity-closure-evidence.v1';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PROOF_BYTES = 64 * 1024 * 1024;
const MAX_PROOFS = 16;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SUPPORTED_PROOF_KINDS = ['live_reissue', 'sender_declined', 'owner_declined'] as const;
const PROOF_ROLES = new Set(['context_witness', 'original_media', 'transcript', 'supporting']);

interface FileReference {
  path: string;
  sha256: string;
}

interface ProofReference extends FileReference {
  role: string;
}

export interface ClosureEvidenceManifest {
  contract: typeof CLOSURE_EVIDENCE_CONTRACT;
  planId: string;
  original: {
    manifest: FileReference;
    ordinal: number;
    receiptFingerprint: string;
    contentType: string;
    conversationFingerprint: string;
  };
  disposition: 'addressed' | 'declined';
  proofKind: 'live_reissue' | 'sender_declined' | 'owner_declined';
  actor: string;
  authority: string;
  observedAt: string;
  decidedAt: string;
  liveInbound: { seq: number; messageSha256: string } | null;
  proofs: ProofReference[];
  audio: { mediaSha256: string; transcriptSha256: string; enrichmentComplete: boolean } | null;
  ambiguityResolution: FileReference | null;
  decision: {
    source: string;
    verifierVersion: number;
    inboundSeq: number;
    messageSha256: string;
    record: FileReference;
  } | null;
}

export interface ClosureEvaluationInputs {
  evidenceRoot: string;
  evidencePath: string;
  policyPath: string | null;
  instanceId: string | null;
  nowMs: number;
}

export interface ClosureEvaluation {
  record: ContinuityGapClosureRecord;
  checks: string[];
}

/** Progress visible to the caller even when evaluation stops early. */
export interface ClosureEvaluationTrace {
  planId: string | null;
  checks: string[];
}

function blocked(condition: string, message: string): ContinuityGapClosureError {
  return new ContinuityGapClosureError('blocked', condition, message);
}

function conflict(condition: string, message: string): ContinuityGapClosureError {
  return new ContinuityGapClosureError('conflict', condition, message);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

// ── Manifest parsing ────────────────────────────────────────────────────────

function invalid(detail: string): ContinuityGapClosureError {
  return conflict('evidence_manifest_invalid', `Evidence manifest is invalid: ${detail}`);
}

function exactObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${label} must be an object`);
  const found = Object.keys(value);
  if (found.length !== keys.length || !keys.every((key) => found.includes(key))) {
    throw invalid(`${label} must contain exactly: ${keys.join(', ')}`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw invalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw invalid(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function bounded(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalid(`${label} must be a bounded nonempty string`);
  }
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid(`${label} must be a UTC ISO-8601 instant`);
  }
  return value;
}

function fileReference(value: unknown, label: string): FileReference {
  const ref = exactObject(value, label, ['path', 'sha256']);
  return { path: bounded(ref.path, `${label}.path`, 1024), sha256: digest(ref.sha256, `${label}.sha256`) };
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

export function parseClosureEvidenceManifest(value: unknown): ClosureEvidenceManifest {
  const root = exactObject(value, 'manifest', [
    'contract', 'planId', 'original', 'disposition', 'proofKind', 'actor', 'authority',
    'observedAt', 'decidedAt', 'liveInbound', 'proofs', 'audio', 'ambiguityResolution', 'decision',
  ]);
  if (root.contract !== CLOSURE_EVIDENCE_CONTRACT) throw invalid('unsupported contract');
  const planId = bounded(root.planId, 'planId', 82);
  if (!/^continuity-gap:v1:[a-f0-9]{64}$/.test(planId)) throw invalid('planId is not a continuity plan');
  const original = exactObject(root.original, 'original', [
    'manifest', 'ordinal', 'receiptFingerprint', 'contentType', 'conversationFingerprint',
  ]);
  if (root.disposition !== 'addressed' && root.disposition !== 'declined') {
    throw invalid('disposition must be addressed or declined');
  }
  const proofKind = bounded(root.proofKind, 'proofKind', 64);
  if (!(SUPPORTED_PROOF_KINDS as readonly string[]).includes(proofKind)) {
    // Fail closed on anything not implemented, including external-action
    // outcomes and owner-session decisions: there is no verifier for them.
    throw blocked(
      'proof_kind_unsupported',
      `proofKind ${proofKind} is not supported; supported: ${SUPPORTED_PROOF_KINDS.join(', ')}`,
    );
  }
  if (!Array.isArray(root.proofs) || root.proofs.length > MAX_PROOFS) {
    throw invalid(`proofs must be an array of at most ${MAX_PROOFS}`);
  }
  return {
    contract: CLOSURE_EVIDENCE_CONTRACT,
    planId,
    original: {
      manifest: fileReference(original.manifest, 'original.manifest'),
      ordinal: positive(original.ordinal, 'original.ordinal'),
      receiptFingerprint: digest(original.receiptFingerprint, 'original.receiptFingerprint'),
      contentType: bounded(original.contentType, 'original.contentType', 64),
      conversationFingerprint: digest(
        original.conversationFingerprint,
        'original.conversationFingerprint',
      ),
    },
    disposition: root.disposition,
    proofKind: proofKind as ClosureEvidenceManifest['proofKind'],
    actor: bounded(root.actor, 'actor', 256),
    authority: bounded(root.authority, 'authority', 512),
    observedAt: instant(root.observedAt, 'observedAt'),
    decidedAt: instant(root.decidedAt, 'decidedAt'),
    liveInbound: nullable(root.liveInbound, (value) => {
      const live = exactObject(value, 'liveInbound', ['seq', 'messageSha256']);
      return {
        seq: positive(live.seq, 'liveInbound.seq'),
        messageSha256: digest(live.messageSha256, 'liveInbound.messageSha256'),
      };
    }),
    proofs: root.proofs.map((value, index) => {
      const proof = exactObject(value, `proofs[${index}]`, ['role', 'path', 'sha256']);
      if (typeof proof.role !== 'string' || !PROOF_ROLES.has(proof.role)) {
        throw invalid(`proofs[${index}].role is not supported`);
      }
      return { role: proof.role, ...fileReference({ path: proof.path, sha256: proof.sha256 }, `proofs[${index}]`) };
    }),
    audio: nullable(root.audio, (value) => {
      const audio = exactObject(value, 'audio', ['mediaSha256', 'transcriptSha256', 'enrichmentComplete']);
      if (typeof audio.enrichmentComplete !== 'boolean') {
        throw invalid('audio.enrichmentComplete must be a boolean');
      }
      return {
        mediaSha256: digest(audio.mediaSha256, 'audio.mediaSha256'),
        transcriptSha256: digest(audio.transcriptSha256, 'audio.transcriptSha256'),
        enrichmentComplete: audio.enrichmentComplete,
      };
    }),
    ambiguityResolution: nullable(root.ambiguityResolution, (value) =>
      fileReference(value, 'ambiguityResolution')),
    decision: nullable(root.decision, (value) => {
      const decision = exactObject(value, 'decision', [
        'source', 'verifierVersion', 'inboundSeq', 'messageSha256', 'record',
      ]);
      return {
        source: bounded(decision.source, 'decision.source', 64),
        verifierVersion: positive(decision.verifierVersion, 'decision.verifierVersion'),
        inboundSeq: positive(decision.inboundSeq, 'decision.inboundSeq'),
        messageSha256: digest(decision.messageSha256, 'decision.messageSha256'),
        record: fileReference(decision.record, 'decision.record'),
      };
    }),
  };
}

// ── Protected evidence files ────────────────────────────────────────────────

/** Canonical evidence root; refuses a root that other users can write. */
export function protectedEvidenceRoot(evidenceRoot: string): string {
  let real: string;
  try {
    real = realpathSync(evidenceRoot);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw blocked('evidence_missing', 'Evidence root is not an existing directory');
  }
  if ((statSync(real).mode & 0o022) !== 0) {
    throw blocked('evidence_root_unprotected', 'Evidence root must not be group- or world-writable');
  }
  return real;
}

/**
 * Reads one evidence file beneath the protected root. Relative paths only; a
 * `..` segment or a symlink that resolves outside the root is refused.
 * `private` files (manifests and decision records carry private identifiers)
 * must have no group or other permission bits.
 */
export function readEvidenceFile(
  root: string,
  relative: string,
  options: { maxBytes: number; private: boolean },
): Buffer {
  const segments = relative.split(/[\\/]/);
  if (isAbsolute(relative) || segments.some((part) => part === '..' || part === '.' || part === '')) {
    throw conflict('evidence_path_invalid', 'Evidence paths must be plain relative paths');
  }
  let real: string;
  try {
    real = realpathSync(join(root, relative));
  } catch {
    throw blocked('evidence_missing', `Evidence file is missing: ${relative}`);
  }
  if (!real.startsWith(`${root}${sep}`)) {
    throw conflict('evidence_path_escape', 'Evidence path resolves outside the protected root');
  }
  const stat = lstatSync(real);
  if (!stat.isFile()) throw conflict('evidence_path_invalid', 'Evidence path is not a regular file');
  if (options.private && (stat.mode & 0o077) !== 0) {
    throw blocked('evidence_unprotected', `Evidence file must not be group- or world-readable: ${relative}`);
  }
  if (stat.size > options.maxBytes) {
    throw conflict('evidence_too_large', `Evidence file exceeds ${options.maxBytes} bytes`);
  }
  return readFileSync(real);
}

function verifiedFile(
  root: string,
  ref: FileReference,
  options: { maxBytes: number; private: boolean },
): Buffer {
  const bytes = readEvidenceFile(root, ref.path, options);
  if (sha256(bytes) !== ref.sha256) {
    throw conflict('digest_mismatch', `Evidence file digest differs: ${ref.path}`);
  }
  return bytes;
}

function parseJson(bytes: Buffer, condition: string, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw conflict(condition, `${label} is not valid JSON`);
  }
}

// ── Evaluation ──────────────────────────────────────────────────────────────

interface OriginalReceipt {
  entry: ContinuityGapLedgerEntry;
  receipt: ContinuityManifestReceipt;
  manifestSha256: string;
}

function verifyOriginalReceipt(
  raw: DatabaseSync,
  root: string,
  manifest: ClosureEvidenceManifest,
): OriginalReceipt {
  if (readContinuityGapClosureLedger(raw).state === 'absent') {
    throw blocked(
      'schema_not_migrated',
      'Database has not applied migration 65; run the service binary to migrate it first',
    );
  }
  const entry = readContinuityGapLedger(raw).find((row) => row.planId === manifest.planId);
  if (!entry) throw blocked('gap_not_recorded', 'No recorded continuity gap has this plan ID');
  const bytes = verifiedFile(root, manifest.original.manifest, {
    maxBytes: MAX_JSON_BYTES,
    private: true,
  });
  let original;
  try {
    original = parseContinuityManifest(parseJson(bytes, 'original_manifest_invalid', 'Original manifest'));
  } catch (error) {
    if (error instanceof ContinuityGapClosureError) throw error;
    throw conflict('original_manifest_invalid', 'Original continuity manifest does not parse');
  }
  const receipt = original.receipts[manifest.original.ordinal - 1];
  const recorded = entry.observation;
  const derived = receipt ? continuityReceiptFingerprints(original, receipt) : null;
  if (
    !receipt
    || !derived
    || receipt.ordinal !== recorded.ordinal
    || derived.receiptFingerprint !== recorded.receiptFingerprint
    || derived.destinationFingerprint !== recorded.destinationFingerprint
    || derived.manifestFingerprint !== recorded.manifestFingerprint
    || derived.evidenceFingerprint !== recorded.evidenceFingerprint
  ) {
    throw conflict(
      'original_receipt_mismatch',
      'Original manifest receipt does not reproduce the recorded gap identity',
    );
  }
  if (manifest.original.receiptFingerprint !== recorded.receiptFingerprint) {
    throw conflict('stale_fingerprint', 'Evidence names a different receipt fingerprint');
  }
  if (manifest.original.conversationFingerprint !== recorded.destinationFingerprint) {
    throw conflict('wrong_conversation', 'Evidence names a different conversation');
  }
  // The type comes from the verified original receipt, never from the caller.
  if (manifest.original.contentType !== receipt.contentType) {
    throw conflict('content_type_mismatch', 'Evidence content type differs from the original receipt');
  }
  return { entry, receipt, manifestSha256: sha256(bytes) };
}

interface LiveInboundRow {
  message_id: string;
  conversation_key: string;
  chat_jid: string;
  processing_status: string;
  message_timestamp: number | null;
  is_from_me: number | null;
}

function verifyLiveReissue(
  raw: DatabaseSync,
  live: { seq: number; messageSha256: string },
  original: OriginalReceipt,
): number {
  const row = raw.prepare(`
    SELECT inbound.message_id, inbound.conversation_key, inbound.chat_jid,
           inbound.processing_status,
           messages.timestamp AS message_timestamp, messages.is_from_me
    FROM inbound_events inbound
    LEFT JOIN messages ON messages.message_id = inbound.message_id
    WHERE inbound.seq = ?
  `).get(live.seq) as LiveInboundRow | undefined;
  if (!row) throw blocked('live_inbound_missing', 'Live inbound is not present in the database');
  if (sha256(row.message_id) !== live.messageSha256) {
    throw conflict('live_inbound_mismatch', 'Live inbound message does not match its hash');
  }
  const destination = continuityDestinationFingerprint(row.conversation_key, sha256(row.chat_jid));
  if (destination !== original.entry.observation.destinationFingerprint) {
    throw conflict('wrong_conversation', 'Live inbound is not in the gap conversation');
  }
  if (
    row.message_id === original.receipt.messageId
    || row.message_timestamp === null
    || Number(row.is_from_me) !== 0
    || Number(row.message_timestamp) <= original.receipt.sentAt
  ) {
    throw conflict('not_later_live_inbound', 'Live inbound must be a later real inbound, not the original');
  }
  if (row.processing_status !== 'complete') {
    throw blocked('live_inbound_incomplete', 'Live inbound has not completed processing');
  }
  const proof = raw.prepare(`
    SELECT terminal_record_id
    FROM operator_catchup_delivery_proofs
    WHERE target_seq = ? AND conversation_key = ? AND chat_jid = ?
  `).get(live.seq, row.conversation_key, row.chat_jid) as { terminal_record_id: number } | undefined;
  if (!proof) {
    throw blocked('terminal_proof_missing', 'Live inbound has no terminal delivery proof');
  }
  return Number(proof.terminal_record_id);
}

function proofByRole(
  manifest: ClosureEvidenceManifest,
  role: string,
): ProofReference | undefined {
  const matches = manifest.proofs.filter((proof) => proof.role === role);
  if (matches.length > 1) throw conflict('invalid_proof_shape', `Duplicate ${role} proof`);
  return matches[0];
}

/**
 * Verifies every independently supplied hash, identity and decision reference
 * against the protected files and the database `raw` currently shows.
 */
export function evaluateContinuityGapClosure(
  raw: DatabaseSync,
  inputs: ClosureEvaluationInputs,
  trace: ClosureEvaluationTrace = { planId: null, checks: [] },
): ClosureEvaluation {
  const checks = trace.checks;
  const root = protectedEvidenceRoot(inputs.evidenceRoot);
  const manifestBytes = readEvidenceFile(root, inputs.evidencePath, {
    maxBytes: MAX_JSON_BYTES,
    private: true,
  });
  const manifest = parseClosureEvidenceManifest(
    parseJson(manifestBytes, 'evidence_manifest_invalid', 'Evidence manifest'),
  );
  trace.planId = manifest.planId;
  checks.push('evidence_manifest');

  const observedMs = Date.parse(manifest.observedAt);
  const decidedMs = Date.parse(manifest.decidedAt);
  if (decidedMs > observedMs || observedMs > inputs.nowMs) {
    throw conflict('invalid_time', 'Decision must precede observation, and observation now');
  }

  const original = verifyOriginalReceipt(raw, root, manifest);
  if (decidedMs <= original.receipt.sentAt * 1000) {
    throw conflict('invalid_time', 'Decision cannot precede the original receipt');
  }
  checks.push('original_receipt');

  let ambiguityResolutionSha256: string | null = null;
  if (original.entry.observation.classification === 'ambiguous') {
    if (!manifest.ambiguityResolution) {
      throw blocked('ambiguity_unresolved', 'An originally ambiguous gap needs a resolution proof');
    }
    verifiedFile(root, manifest.ambiguityResolution, { maxBytes: MAX_PROOF_BYTES, private: false });
    ambiguityResolutionSha256 = manifest.ambiguityResolution.sha256;
    checks.push('ambiguity_resolution');
  } else if (manifest.ambiguityResolution) {
    throw conflict('invalid_proof_shape', 'Only an originally ambiguous gap takes a resolution proof');
  }

  for (const proof of manifest.proofs) {
    verifiedFile(root, proof, { maxBytes: MAX_PROOF_BYTES, private: false });
  }
  const proofSetSha256 = sha256(JSON.stringify(
    manifest.proofs.map((proof) => [proof.role, proof.sha256]).sort(),
  ));
  checks.push('proof_digests');

  const policy: LoadedClosureAuthorityPolicy | null = inputs.policyPath === null
    ? null
    : loadClosureAuthorityPolicy(inputs.policyPath, inputs.instanceId ?? '', decidedMs, inputs.nowMs);
  if (policy) checks.push('authority_policy');

  const audio = original.receipt.contentType === 'audio';
  const unsigned: UnsignedContinuityGapClosure = {
    planId: manifest.planId,
    contractVersion: CONTINUITY_GAP_CLOSURE_CONTRACT,
    receiptFingerprint: original.entry.observation.receiptFingerprint,
    originalClassification: original.entry.observation.classification,
    originalContentType: original.receipt.contentType,
    disposition: manifest.disposition,
    proofKind: manifest.proofKind,
    evidenceManifestSha256: sha256(manifestBytes),
    originalManifestSha256: original.manifestSha256,
    proofSetSha256,
    linkedInboundSeq: 0,
    linkedMessageSha256: '',
    terminalRecordId: null,
    audioMediaSha256: null,
    audioTranscriptSha256: null,
    ambiguityResolutionSha256,
    decisionRecordSha256: null,
    decisionSource: null,
    policySha256: policy?.sha256 ?? null,
    policyVersion: policy?.policy.policyVersion ?? null,
    actor: manifest.actor,
    authority: manifest.authority,
    observedAt: manifest.observedAt,
    decidedAt: manifest.decidedAt,
  };

  if (manifest.disposition === 'addressed') {
    if (manifest.proofKind !== 'live_reissue' || manifest.decision || !manifest.liveInbound) {
      throw conflict('invalid_proof_shape', 'addressed requires a live reissue and no decision');
    }
    if (audio) {
      if (!manifest.audio) {
        throw blocked('audio_evidence_missing', 'An audio receipt needs media and transcript proof');
      }
      if (!manifest.audio.enrichmentComplete) {
        throw blocked('media_not_ready', 'Audio enrichment is not complete');
      }
      const media = proofByRole(manifest, 'original_media');
      const transcript = proofByRole(manifest, 'transcript');
      if (!media || !transcript) {
        throw blocked('audio_evidence_missing', 'Audio closure needs original_media and transcript files');
      }
      if (transcript.sha256 !== manifest.audio.transcriptSha256) {
        throw conflict('transcript_changed', 'Transcript file differs from the bound transcript hash');
      }
      if (media.sha256 !== manifest.audio.mediaSha256) {
        throw conflict('media_changed', 'Media file differs from the bound media hash');
      }
      unsigned.audioMediaSha256 = media.sha256;
      unsigned.audioTranscriptSha256 = transcript.sha256;
      checks.push('audio_bound');
    } else if (manifest.audio) {
      throw conflict('invalid_proof_shape', 'Only an audio receipt takes an audio section');
    }
    if (!proofByRole(manifest, 'context_witness')) {
      throw blocked('context_witness_missing', 'addressed needs the exact selected-context witness');
    }
    checks.push('context_witness');
    unsigned.terminalRecordId = verifyLiveReissue(raw, manifest.liveInbound, original);
    unsigned.linkedInboundSeq = manifest.liveInbound.seq;
    unsigned.linkedMessageSha256 = manifest.liveInbound.messageSha256;
    checks.push('live_inbound', 'terminal_proof');
  } else {
    if (manifest.proofKind === 'live_reissue' || manifest.liveInbound || manifest.audio) {
      throw conflict(
        'invalid_proof_shape',
        'declined takes no live reissue, transcript or audio-ready claim',
      );
    }
    if (!manifest.decision) {
      throw blocked('decision_missing', 'declined needs a scoped decision record');
    }
    const verifierId = acceptedVerifier(
      manifest.decision.source,
      manifest.decision.verifierVersion,
      policy?.policy ?? null,
    );
    const expectedKind = verifierId === 'original_sender_inbound' ? 'sender_declined' : 'owner_declined';
    if (manifest.proofKind !== expectedKind || !policy) {
      throw conflict('invalid_proof_shape', 'proofKind does not match the decision source');
    }
    const recordBytes = verifiedFile(root, manifest.decision.record, {
      maxBytes: MAX_JSON_BYTES,
      private: true,
    });
    const verified = verifyDecision(raw, verifierId, policy.policy, {
      source: manifest.decision.source,
      verifierVersion: manifest.decision.verifierVersion,
      inboundSeq: manifest.decision.inboundSeq,
      messageSha256: manifest.decision.messageSha256,
      recordBytes,
    }, {
      planId: manifest.planId,
      receiptFingerprint: original.entry.observation.receiptFingerprint,
      destinationFingerprint: original.entry.observation.destinationFingerprint,
      originalSenderFingerprint: original.receipt.senderFingerprint,
      originalMessageId: original.receipt.messageId,
      originalSentAtSec: original.receipt.sentAt,
    });
    unsigned.linkedInboundSeq = verified.linkedInboundSeq;
    unsigned.linkedMessageSha256 = verified.linkedMessageSha256;
    unsigned.decisionRecordSha256 = manifest.decision.record.sha256;
    unsigned.decisionSource = `${verifierId}@1`;
    checks.push('decision_verified');
  }

  return {
    record: { ...unsigned, operationId: continuityGapClosureOperationId(unsigned) },
    checks,
  };
}
