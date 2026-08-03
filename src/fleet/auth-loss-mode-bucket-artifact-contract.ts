import { isStrictIsoUtcTimestamp } from './time-utils.ts';
import { requireEnum, requireRecord, requireString } from '../lib/type-guards.ts';

const artifactName = 'auth-loss-mode-bucket-producer-dry-run';
const proofName = 'auth-loss-mode-bucket-artifact-contract-proof';

const sampleIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const forbiddenKeys = new Set([
  'evidence',
  'text',
  'body',
  'message',
  'chat',
  'jid',
  'lid',
  'phone',
  'line',
  'auth',
  'creds',
  'path',
  'token',
  'secret',
  'raw',
]);
const unsafePatterns = [
  /\b\d{7,}@(s\.whatsapp\.net|g\.us)\b/i,
  /\b[A-Za-z0-9_-]{8,}@lid\b/i,
  /(?:^|[^\w-])(?:\+\d[\d .()-]{8,}\d|\d{10,16})(?:$|[^\w-])/,
  /\bauth\/(?:creds|session|keys)\.json\b/i,
  /\b(?:bearer|token|secret|password)\b\s*[:=]\s*["']?(?!redacted\b|<redacted>)[^\s"',}]{6,}/i,
];

const falseReasons = new Set([
  'restart_required_without_pairing_context',
  'registration_attempt_without_structured_rejection',
  'line_attestation_missing_proof',
  'unstructured_text_not_authoritative',
  'no_authoritative_mode_bucket_signal',
]);
const trueReasons = new Set([
  'server_revoked_session',
  'pairing_code_rejected',
  'registration_rejected',
  'owner_attested_line_status',
]);
const authFailureClasses = new Set([
  'none',
  'pairing_required',
  'serverside_logout_irreversible',
  'local_corruption_restorable',
  'local_corruption_unrestorable',
  'auth_bond_at_risk',
  'registration_blocked',
  'line_quarantined',
]);
const disconnectClasses = new Set([
  'none',
  'serverside_logout_irreversible',
  'duplicate_session_replaced',
  'multidevice_mismatch',
  'restart_required',
  'restart_required_flapping',
  'transient_reconnect',
  'unknown_reconnect',
  'registration_rejected',
  'pairing_code_rejected',
  'line_restricted',
]);
const buckets = new Set([
  'mode_1_manual_relink',
  'transient_flap',
  'session_contended',
  'local_corruption',
  'registration_blocked',
  'line_quarantined',
]);
const closeEdges = new Set([
  'WA_AUTH_BOND_RELINK_VERIFIED',
  'per_instance_mode_bucketed_quiet_dwell',
  'reconnect_verified_bond_or_terminal_escalation',
  'local_auth_bond_recovery',
  'owner_verified_registration_recovered',
  'owner_verified_line_unquarantined_or_migrated',
]);

export interface AuthLossModeArtifactContractProof {
  artifact: typeof proofName;
  schemaVersion: 1;
  sourceArtifact: typeof artifactName;
  sampleCount: number;
  emittedCount: number;
  suppressedCount: number;
  bucketCounts: Record<string, number>;
  redaction: {
    rawIdentifiersAllowed: false;
    evidenceCopied: false;
    forbiddenFieldScan: 'pass';
    unsafePatternScan: 'pass';
  };
}

export function validateAuthLossModeProducerArtifact(input: unknown): AuthLossModeArtifactContractProof {
  assertNoUnsafeContent(input);

  const artifact = requireRecord(input, 'artifact');
  if (artifact.artifact !== artifactName) throw new Error('unknown artifact type');
  if (artifact.schemaVersion !== 1) throw new Error('unknown schemaVersion');
  assertIsoTimestamp(requireString(artifact.generatedAt, 'generatedAt'));
  const redaction = requireRecord(artifact.redaction, 'redaction');
  if (redaction.rawIdentifiersAllowed !== false || redaction.evidenceCopied !== false) {
    throw new Error('redaction guarantees are required');
  }

  const decisions = asArray(artifact.decisions, 'decisions');
  const sampleCount = asNumber(artifact.sampleCount, 'sampleCount');
  if (sampleCount !== decisions.length) {
    throw new Error(`sampleCount mismatch: expected ${decisions.length}, got ${sampleCount}`);
  }

  const seenIds = new Set<string>();
  const bucketCounts: Record<string, number> = {};
  let emittedCount = 0;
  let suppressedCount = 0;

  for (const [index, decisionValue] of decisions.entries()) {
    const decision = requireRecord(decisionValue, `decisions[${index}]`);
    const id = requireString(decision.id, `decisions[${index}].id`);
    assertSafeSampleId(id);
    if (seenIds.has(id)) throw new Error(`duplicate decision id: ${id}`);
    seenIds.add(id);

    if (decision.emits === false) {
      suppressedCount += 1;
      requireEnum(decision.reason, `decisions[${index}].reason`, falseReasons);
      if ('event' in decision || 'decision' in decision) {
        throw new Error(`suppressed decision ${id} must not include event or decision`);
      }
      continue;
    }

    if (decision.emits !== true) throw new Error(`decisions[${index}].emits must be boolean`);
    emittedCount += 1;
    requireEnum(decision.reason, `decisions[${index}].reason`, trueReasons);
    validateEvent(requireRecord(decision.event, `decisions[${index}].event`), index);
    const outage = requireRecord(decision.decision, `decisions[${index}].decision`);
    validateOpenOutageDecision(outage, index);
    const bucket = requireString(outage.bucket, `decisions[${index}].decision.bucket`);
    bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
  }

  return {
    artifact: proofName,
    schemaVersion: 1,
    sourceArtifact: artifactName,
    sampleCount,
    emittedCount,
    suppressedCount,
    bucketCounts,
    redaction: {
      rawIdentifiersAllowed: false,
      evidenceCopied: false,
      forbiddenFieldScan: 'pass',
      unsafePatternScan: 'pass',
    },
  };
}

function validateEvent(event: Record<string, unknown>, index: number): void {
  for (const key of Object.keys(event)) {
    if (key !== 'authFailureClass' && key !== 'disconnectClass') {
      throw new Error(`unknown event field: decisions[${index}].event.${key}`);
    }
  }
  if ('authFailureClass' in event) {
    requireEnum(event.authFailureClass, `decisions[${index}].event.authFailureClass`, authFailureClasses);
  }
  if ('disconnectClass' in event) {
    requireEnum(event.disconnectClass, `decisions[${index}].event.disconnectClass`, disconnectClasses);
  }
  if (!('authFailureClass' in event) && !('disconnectClass' in event)) {
    throw new Error(`decisions[${index}].event must include an auth or disconnect class`);
  }
}

function validateOpenOutageDecision(decision: Record<string, unknown>, index: number): void {
  if (decision.action !== 'open_outage') {
    throw new Error(`decisions[${index}].decision.action must be open_outage`);
  }
  const bucket = requireString(decision.bucket, `decisions[${index}].decision.bucket`);
  const closeEdge = requireString(decision.closeEdge, `decisions[${index}].decision.closeEdge`);
  requireEnum(bucket, `decisions[${index}].decision.bucket`, buckets);
  requireEnum(closeEdge, `decisions[${index}].decision.closeEdge`, closeEdges);
  requireEnum(decision.confidence, `decisions[${index}].decision.confidence`, new Set(['confirmed', 'inferred']));

  if (bucket === 'mode_1_manual_relink' && closeEdge !== 'WA_AUTH_BOND_RELINK_VERIFIED') {
    throw new Error('mode_1_manual_relink requires WA_AUTH_BOND_RELINK_VERIFIED close edge');
  }
  if (bucket === 'registration_blocked' && closeEdge !== 'owner_verified_registration_recovered') {
    throw new Error('registration_blocked requires owner_verified_registration_recovered close edge');
  }
  if (bucket === 'line_quarantined' && closeEdge !== 'owner_verified_line_unquarantined_or_migrated') {
    throw new Error('line_quarantined requires owner_verified_line_unquarantined_or_migrated close edge');
  }
  if (bucket === 'transient_flap' && closeEdge !== 'per_instance_mode_bucketed_quiet_dwell') {
    throw new Error('transient_flap requires per-instance quiet dwell close edge');
  }
  if (bucket === 'session_contended' && closeEdge !== 'reconnect_verified_bond_or_terminal_escalation') {
    throw new Error('session_contended requires reconnect or terminal escalation close edge');
  }
  if (bucket === 'local_corruption' && closeEdge !== 'local_auth_bond_recovery') {
    throw new Error('local_corruption requires local auth bond recovery close edge');
  }
}

function assertNoUnsafeContent(value: unknown): void {
  if (typeof value === 'string') {
    if (unsafePatterns.some((pattern) => pattern.test(value))) {
      throw new Error('unsafe string pattern in producer artifact');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoUnsafeContent(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLowerCase())) {
        throw new Error(`forbidden field in producer artifact: ${key}`);
      }
      assertNoUnsafeContent(item);
    }
  }
}

// Non-validating: only narrows to unknown[]; element shape is checked
// per-entry inside the decisions loop via requireRecord. Left local (not
// requireArrayOfRecords) because eagerly validating every element's shape
// here would run before the sampleCount-vs-length check below, changing
// which error surfaces first for a payload that is wrong in both ways.
function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function assertIsoTimestamp(value: string): void {
  if (!isStrictIsoUtcTimestamp(value)) {
    throw new Error(`invalid generatedAt timestamp: ${value}`);
  }
}

function assertSafeSampleId(id: string): void {
  if (!sampleIdPattern.test(id)) {
    throw new Error(`unsafe sample id: ${id}`);
  }
}
