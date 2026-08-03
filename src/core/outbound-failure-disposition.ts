import { isRecord } from '../lib/type-guards.ts';
import { isOutboundGovernorShed } from './outbound-governor-shed.ts';
import { isOutboundIdentityBlocked } from './outbound-identity/guard.ts';
import {
  ErrorCode,
  type ErrorCode as TransportErrorCode,
  type OperationPhase,
} from './transport-error-taxonomy.ts';

export const OUTBOUND_FAILURE_EVIDENCE_SCHEMA =
  'whatsoup-outbound-failure-v1' as const;
export const OUTBOUND_FAILURE_EVIDENCE_MAX_BYTES = 2_048;

export const OUTBOUND_FAILURE_STAGES = [
  'admission',
  'provider_request',
  'provider_response',
  'acknowledgement',
  'runtime',
] as const;
export type OutboundFailureStage = (typeof OUTBOUND_FAILURE_STAGES)[number];

export const OUTBOUND_MUTATION_STATES = [
  'not_started',
  'rejected',
  'ambiguous',
  'submitted',
] as const;
export type OutboundMutationState = (typeof OUTBOUND_MUTATION_STATES)[number];

export const OUTBOUND_RETRY_DECISIONS = [
  'retry_now',
  'retry_not_before',
  'stop',
] as const;
export type OutboundRetryDecision = (typeof OUTBOUND_RETRY_DECISIONS)[number];

export const OUTBOUND_RETRY_OWNERS = [
  'agent_queue',
  'chat_runtime',
  'send_tracked',
  'pending_drainer',
  'recovery',
  'none',
] as const;
export type OutboundRetryOwner = (typeof OUTBOUND_RETRY_OWNERS)[number];

export const OUTBOUND_ATTEMPT_BUDGET_DISPOSITIONS = [
  'consume',
  'preserve',
  'stop',
] as const;
export type OutboundAttemptBudgetDisposition =
  (typeof OUTBOUND_ATTEMPT_BUDGET_DISPOSITIONS)[number];

export const OUTBOUND_EVIDENCE_COVERAGE = [
  'complete',
  'partial',
] as const;
export type OutboundEvidenceCoverage = (typeof OUTBOUND_EVIDENCE_COVERAGE)[number];

/**
 * Bounded disposition for a terminal outbound quarantine. This deliberately
 * lives outside the versioned failure-evidence payload: historical evidence
 * remains decodable as v1 while new rows receive an explicit policy outcome.
 */
export const OUTBOUND_QUARANTINE_DISPOSITIONS = [
  'delivery_ambiguous_unsafe',
  'delivery_not_attempted',
  'record_unreconstructable',
  'stale_status_discarded',
  'legacy_unclassified',
] as const;
export type OutboundQuarantineDisposition =
  (typeof OUTBOUND_QUARANTINE_DISPOSITIONS)[number];

export interface OutboundQuarantineDispositionPolicy {
  /** Whether an external provider call might already have happened. */
  providerCall: 'possible' | 'not_started' | 'unknown';
  /** Stable, content-free alert routing. */
  alertSource: string;
  alertSeverity: 'critical' | 'warning' | 'info';
  alertSummary: string;
  /** Whether a human acknowledgement is required before retirement. */
  acknowledgement: 'delivery-risk-reviewed' | 'record-reconstruction-reviewed' | 'none';
  /** Retention class consumed by terminal database retention. */
  retention: 'extended' | 'standard';
  /** Whether recovery may clear this incident after its exact contributors reach zero. */
  clearWhenContributorFree: boolean;
}

export const OUTBOUND_QUARANTINE_DISPOSITION_POLICIES: Readonly<
  Record<OutboundQuarantineDisposition, OutboundQuarantineDispositionPolicy>
> = {
  delivery_ambiguous_unsafe: {
    providerCall: 'possible',
    alertSource: 'outbound_delivery_ambiguous',
    alertSeverity: 'critical',
    alertSummary: 'outbound delivery is ambiguous; automatic replay remains disabled',
    acknowledgement: 'delivery-risk-reviewed',
    retention: 'extended',
    clearWhenContributorFree: true,
  },
  delivery_not_attempted: {
    providerCall: 'not_started',
    alertSource: 'outbound_delivery_not_attempted',
    alertSeverity: 'warning',
    alertSummary: 'outbound delivery was not attempted and requires disposition review',
    acknowledgement: 'none',
    retention: 'standard',
    clearWhenContributorFree: true,
  },
  record_unreconstructable: {
    providerCall: 'not_started',
    alertSource: 'outbound_record_unreconstructable',
    alertSeverity: 'warning',
    alertSummary: 'outbound record cannot be reconstructed and requires review',
    acknowledgement: 'record-reconstruction-reviewed',
    retention: 'standard',
    clearWhenContributorFree: true,
  },
  stale_status_discarded: {
    providerCall: 'not_started',
    alertSource: 'outbound_status_discarded',
    alertSeverity: 'info',
    alertSummary: 'stale outbound status notice was discarded before send',
    acknowledgement: 'none',
    retention: 'standard',
    clearWhenContributorFree: false,
  },
  legacy_unclassified: {
    providerCall: 'unknown',
    alertSource: 'outbound_quarantine_unclassified',
    alertSeverity: 'warning',
    alertSummary: 'outbound quarantine lacks a classified disposition',
    acknowledgement: 'delivery-risk-reviewed',
    retention: 'extended',
    clearWhenContributorFree: true,
  },
};

export type InternalOutboundFailureCode =
  | 'outbound.unknown_failure'
  | 'outbound.shutdown_before_send'
  | 'outbound.shutdown_deadline'
  | 'outbound.crash_in_flight'
  | 'outbound.echo_timeout'
  | 'outbound.superseded'
  | 'outbound.pending_replay_unreconstructable'
  | 'outbound.status_ping_expired'
  | 'outbound.unsafe_delivery_unconfirmed'
  | 'outbound.governor_shed'
  | 'outbound.identity_blocked'
  | 'outbound.replay_failed'
  | 'outbound.deferral_limit_exceeded'
  | 'outbound.replay_attempt_limit_exceeded';

export type OutboundFailureCode = TransportErrorCode | InternalOutboundFailureCode;

export interface OutboundFailureEvidenceV1 {
  schema: typeof OUTBOUND_FAILURE_EVIDENCE_SCHEMA;
  failure_code: OutboundFailureCode;
  stage: OutboundFailureStage;
  mutation_state: OutboundMutationState;
  retryable: boolean;
  retry_decision: OutboundRetryDecision;
  retry_not_before: string | null;
  retry_owner: OutboundRetryOwner;
  attempt_budget_disposition: OutboundAttemptBudgetDisposition;
  logical_attempt_count: number;
  provider_submission_count: number;
  first_failure_at: string;
  last_failure_at: string;
  evidence_coverage: OutboundEvidenceCoverage;
}

export interface LegacyOutboundFailureEvidence {
  schema: 'legacy_unclassified';
  failure_code: 'outbound.legacy_unclassified';
  evidence_coverage: 'legacy_unclassified';
}

export type DecodedOutboundFailureEvidence =
  | OutboundFailureEvidenceV1
  | LegacyOutboundFailureEvidence;

export interface ClassifyOutboundFailureOptions {
  nowMs?: number;
  retryOwner: Exclude<OutboundRetryOwner, 'none'>;
  attemptsRemaining: number;
  previousEvidence?: OutboundFailureEvidenceV1;
}

export interface CreateInternalOutboundFailureEvidenceOptions {
  failureCode: InternalOutboundFailureCode;
  stage: OutboundFailureStage;
  mutationState: OutboundMutationState;
  retryable?: boolean;
  retryDecision?: OutboundRetryDecision;
  retryNotBefore?: string | null;
  retryOwner?: OutboundRetryOwner;
  attemptBudgetDisposition?: OutboundAttemptBudgetDisposition;
  logicalAttemptCount?: number;
  providerSubmissionCount?: number;
  nowMs?: number;
  previousEvidence?: OutboundFailureEvidenceV1;
  evidenceCoverage?: OutboundEvidenceCoverage;
}

const LEGACY_UNCLASSIFIED: LegacyOutboundFailureEvidence = Object.freeze({
  schema: 'legacy_unclassified',
  failure_code: 'outbound.legacy_unclassified',
  evidence_coverage: 'legacy_unclassified',
});

const V1_KEYS = new Set<keyof OutboundFailureEvidenceV1>([
  'schema',
  'failure_code',
  'stage',
  'mutation_state',
  'retryable',
  'retry_decision',
  'retry_not_before',
  'retry_owner',
  'attempt_budget_disposition',
  'logical_attempt_count',
  'provider_submission_count',
  'first_failure_at',
  'last_failure_at',
  'evidence_coverage',
]);

const TRANSPORT_CODES = new Set<string>(Object.values(ErrorCode));
const INTERNAL_CODES = new Set<string>([
  'outbound.unknown_failure',
  'outbound.shutdown_before_send',
  'outbound.shutdown_deadline',
  'outbound.crash_in_flight',
  'outbound.echo_timeout',
  'outbound.superseded',
  'outbound.pending_replay_unreconstructable',
  'outbound.status_ping_expired',
  'outbound.unsafe_delivery_unconfirmed',
  'outbound.governor_shed',
  'outbound.identity_blocked',
  'outbound.replay_failed',
  'outbound.deferral_limit_exceeded',
  'outbound.replay_attempt_limit_exceeded',
]);
/** Runtime source of truth for every code accepted in v1 outbound evidence. */
export const OUTBOUND_FAILURE_EVIDENCE_CODES = Object.freeze([
  ...TRANSPORT_CODES,
  ...INTERNAL_CODES,
]);
const STAGES = new Set<string>(OUTBOUND_FAILURE_STAGES);
const MUTATION_STATES = new Set<string>(OUTBOUND_MUTATION_STATES);
const RETRY_DECISIONS = new Set<string>(OUTBOUND_RETRY_DECISIONS);
const RETRY_OWNERS = new Set<string>(OUTBOUND_RETRY_OWNERS);
const ATTEMPT_BUDGET_DISPOSITIONS =
  new Set<string>(OUTBOUND_ATTEMPT_BUDGET_DISPOSITIONS);
const EVIDENCE_COVERAGE = new Set<string>(OUTBOUND_EVIDENCE_COVERAGE);

function safeGet(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function readTransportPayload(
  error: unknown,
): {
  code: TransportErrorCode;
  retryable: boolean;
  phase?: OperationPhase;
  retryAfterMs?: number;
} | null {
  if (!isRecord(error)) return null;
  const payload = safeGet(error, 'payload');
  if (!isRecord(payload)) return null;
  const code = safeGet(payload, 'code');
  const retryable = safeGet(payload, 'retryable');
  if (
    typeof code !== 'string'
    || !TRANSPORT_CODES.has(code)
    || typeof retryable !== 'boolean'
  ) {
    return null;
  }
  const rawPhase = safeGet(payload, 'phase');
  const phase: OperationPhase | undefined = rawPhase === 'not_started'
    || rawPhase === 'provider_call_started'
    || rawPhase === 'ack_received'
    ? rawPhase
    : undefined;
  const rawRetryAfterMs = safeGet(payload, 'retryAfterMs');
  return {
    code: code as TransportErrorCode,
    retryable,
    phase,
    retryAfterMs: typeof rawRetryAfterMs === 'number' ? rawRetryAfterMs : undefined,
  };
}

// Every accepted deadline must serialize to a 24-char ISO string (isIsoTimestamp's
// contract). That caps the year at 9999 — Date.parse('9999-12-31T23:59:59.999Z') —
// well short of Date's own range ceiling (±8_640_000_000_000_000 ms), which
// produces extended-year strings (e.g. "+275760-09-13T00:00:00.000Z", 27 chars)
// that isIsoTimestamp always rejects.
const MAX_ISO_TIMESTAMP_MS = 253_402_300_799_999;

function validPositiveDelay(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const delayMs = Math.ceil(value);
  const deadlineMs = nowMs + delayMs;
  return Number.isFinite(deadlineMs) && deadlineMs <= MAX_ISO_TIMESTAMP_MS
    ? delayMs
    : null;
}

function stageFor(
  code: OutboundFailureCode,
  phase: OperationPhase | undefined,
): OutboundFailureStage {
  if (phase === 'not_started') return 'admission';
  if (phase === 'ack_received') return 'acknowledgement';
  if (
    code === ErrorCode.UNSUPPORTED_CAPABILITY
    || code === ErrorCode.PAYLOAD_TOO_LARGE
    || code === ErrorCode.CONVERSATION_NOT_FOUND
    || code === 'outbound.governor_shed'
    || code === 'outbound.identity_blocked'
    || code === 'outbound.shutdown_before_send'
  ) {
    return 'admission';
  }
  if (
    code === ErrorCode.AUTH_REQUIRED
    || code === ErrorCode.RATE_LIMITED
    || code === ErrorCode.PERMANENT_PROVIDER
  ) {
    return 'provider_response';
  }
  return 'provider_request';
}

function mutationStateFor(
  code: OutboundFailureCode,
  phase: OperationPhase | undefined,
): OutboundMutationState {
  if (
    phase === 'not_started'
    || code === ErrorCode.UNSUPPORTED_CAPABILITY
    || code === ErrorCode.PAYLOAD_TOO_LARGE
    || code === ErrorCode.CONVERSATION_NOT_FOUND
    || code === 'outbound.governor_shed'
    || code === 'outbound.identity_blocked'
    || code === 'outbound.shutdown_before_send'
  ) {
    return 'not_started';
  }
  if (
    code === ErrorCode.SEND_AMBIGUOUS
    || code === ErrorCode.TRANSIENT_PROVIDER
    || code === 'outbound.unknown_failure'
    || code === 'outbound.shutdown_deadline'
    || code === 'outbound.crash_in_flight'
    || code === 'outbound.echo_timeout'
    || code === 'outbound.replay_failed'
    || phase === 'ack_received'
  ) {
    return 'ambiguous';
  }
  return 'rejected';
}

function toIsoTimestamp(nowMs: number): string {
  if (!Number.isFinite(nowMs)) throw new RangeError('Outbound evidence time must be finite');
  return new Date(nowMs).toISOString();
}

function monotonicEvidenceTimestamp(
  nowMs: number,
  previous?: OutboundFailureEvidenceV1,
): string {
  const candidate = toIsoTimestamp(nowMs);
  if (
    previous !== undefined
    && candidate < previous.last_failure_at
  ) {
    return previous.last_failure_at;
  }
  return candidate;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertValidEvidence(
  value: OutboundFailureEvidenceV1,
): OutboundFailureEvidenceV1 {
  const record = value as unknown as Record<string, unknown>;
  if (
    Object.keys(record).length !== V1_KEYS.size
    || Object.keys(record).some((key) => !V1_KEYS.has(key as keyof OutboundFailureEvidenceV1))
  ) {
    throw new Error('Outbound failure evidence contains unknown or missing fields');
  }
  if (value.schema !== OUTBOUND_FAILURE_EVIDENCE_SCHEMA) {
    throw new Error('Outbound failure evidence schema is unsupported');
  }
  if (
    !TRANSPORT_CODES.has(value.failure_code)
    && !INTERNAL_CODES.has(value.failure_code)
  ) {
    throw new Error('Outbound failure evidence code is unregistered');
  }
  if (
    !STAGES.has(value.stage)
    || !MUTATION_STATES.has(value.mutation_state)
    || !RETRY_DECISIONS.has(value.retry_decision)
    || !RETRY_OWNERS.has(value.retry_owner)
    || !ATTEMPT_BUDGET_DISPOSITIONS.has(value.attempt_budget_disposition)
    || !EVIDENCE_COVERAGE.has(value.evidence_coverage)
  ) {
    throw new Error('Outbound failure evidence contains an invalid bounded value');
  }
  if (typeof value.retryable !== 'boolean') {
    throw new Error('Outbound failure evidence retryable must be boolean');
  }
  if (
    !Number.isSafeInteger(value.logical_attempt_count)
    || value.logical_attempt_count < 0
  ) {
    throw new Error('Outbound logical attempt count must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(value.provider_submission_count)
    || value.provider_submission_count < 0
    || value.provider_submission_count > value.logical_attempt_count
  ) {
    throw new Error('Outbound provider submission count contradicts logical attempts');
  }
  if (
    !isIsoTimestamp(value.first_failure_at)
    || !isIsoTimestamp(value.last_failure_at)
    || Date.parse(value.first_failure_at) > Date.parse(value.last_failure_at)
  ) {
    throw new Error('Outbound failure evidence timestamps are invalid');
  }
  if (
    value.retry_not_before !== null
    && !isIsoTimestamp(value.retry_not_before)
  ) {
    throw new Error('Outbound retry-not-before must be an absolute ISO timestamp');
  }
  if (value.retry_decision === 'retry_not_before') {
    if (
      value.retry_not_before === null
      || value.retry_owner !== 'pending_drainer'
      || value.attempt_budget_disposition !== 'preserve'
      || !value.retryable
      || value.mutation_state === 'ambiguous'
      || value.mutation_state === 'submitted'
    ) {
      throw new Error('Outbound deferred retry evidence is incoherent');
    }
  } else if (value.retry_not_before !== null) {
    throw new Error('Outbound non-deferred evidence cannot carry retry-not-before');
  }
  if (
    value.retry_decision === 'stop'
    && (
      value.retry_owner !== 'none'
      || value.attempt_budget_disposition !== 'stop'
    )
  ) {
    throw new Error('Stopped outbound evidence cannot retain retry ownership or budget');
  }
  if (
    value.retry_decision === 'retry_now'
    && (
      !value.retryable
      || value.retry_owner === 'none'
      || value.attempt_budget_disposition === 'stop'
    )
  ) {
    throw new Error('Immediate outbound retry evidence is incoherent');
  }
  return value;
}

export function encodeOutboundFailureEvidence(
  evidence: OutboundFailureEvidenceV1,
): string {
  const encoded = JSON.stringify(assertValidEvidence(evidence));
  if (Buffer.byteLength(encoded, 'utf8') > OUTBOUND_FAILURE_EVIDENCE_MAX_BYTES) {
    throw new Error('Outbound failure evidence exceeds the durable size bound');
  }
  return encoded;
}

export function decodeOutboundFailureEvidence(
  stored: string | null | undefined,
): DecodedOutboundFailureEvidence {
  if (typeof stored !== 'string' || stored.length === 0) return LEGACY_UNCLASSIFIED;
  if (Buffer.byteLength(stored, 'utf8') > OUTBOUND_FAILURE_EVIDENCE_MAX_BYTES) {
    return LEGACY_UNCLASSIFIED;
  }
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!isRecord(parsed)) return LEGACY_UNCLASSIFIED;
    return assertValidEvidence(parsed as unknown as OutboundFailureEvidenceV1);
  } catch {
    return LEGACY_UNCLASSIFIED;
  }
}

export function classifyOutboundFailure(
  error: unknown,
  options: ClassifyOutboundFailureOptions,
): OutboundFailureEvidenceV1 {
  if (!Number.isSafeInteger(options.attemptsRemaining) || options.attemptsRemaining < 0) {
    throw new RangeError('Outbound attempts remaining must be a non-negative safe integer');
  }
  const nowMs = options.nowMs ?? Date.now();
  const now = monotonicEvidenceTimestamp(nowMs, options.previousEvidence);
  const payload = readTransportPayload(error);
  const code: OutboundFailureCode = payload?.code as TransportErrorCode
    ?? (isOutboundIdentityBlocked(error)
      ? 'outbound.identity_blocked'
      : isOutboundGovernorShed(error)
        ? 'outbound.governor_shed'
        : 'outbound.unknown_failure');
  const phase = payload?.phase;
  const stage = stageFor(code, phase);
  const mutationState = mutationStateFor(code, phase);
  const retryable = payload?.retryable
    ?? !(isOutboundIdentityBlocked(error) || isOutboundGovernorShed(error));
  const retryAfterMs = retryable && mutationState !== 'ambiguous'
    ? validPositiveDelay(payload?.retryAfterMs, nowMs)
    : null;

  let retryDecision: OutboundRetryDecision;
  let retryNotBefore: string | null = null;
  let retryOwner: OutboundRetryOwner;
  let budget: OutboundAttemptBudgetDisposition;
  if (retryAfterMs !== null) {
    retryDecision = 'retry_not_before';
    retryNotBefore = toIsoTimestamp(nowMs + retryAfterMs);
    retryOwner = 'pending_drainer';
    budget = 'preserve';
  } else if (retryable && options.attemptsRemaining > 0) {
    retryDecision = 'retry_now';
    retryOwner = options.retryOwner;
    budget = 'consume';
  } else {
    retryDecision = 'stop';
    retryOwner = 'none';
    budget = 'stop';
  }

  const previous = options.previousEvidence;
  const logicalAttemptCount = (previous?.logical_attempt_count ?? 0) + 1;
  const providerSubmissionCount = (previous?.provider_submission_count ?? 0)
    + (mutationState === 'not_started' ? 0 : 1);

  return assertValidEvidence({
    schema: OUTBOUND_FAILURE_EVIDENCE_SCHEMA,
    failure_code: code,
    stage,
    mutation_state: mutationState,
    retryable,
    retry_decision: retryDecision,
    retry_not_before: retryNotBefore,
    retry_owner: retryOwner,
    attempt_budget_disposition: budget,
    logical_attempt_count: logicalAttemptCount,
    provider_submission_count: providerSubmissionCount,
    first_failure_at: previous?.first_failure_at ?? now,
    last_failure_at: now,
    evidence_coverage: payload ? 'complete' : 'partial',
  });
}

export function createInternalOutboundFailureEvidence(
  options: CreateInternalOutboundFailureEvidenceOptions,
): OutboundFailureEvidenceV1 {
  const previous = options.previousEvidence;
  const now = monotonicEvidenceTimestamp(options.nowMs ?? Date.now(), previous);
  const retryDecision = options.retryDecision ?? 'stop';
  return assertValidEvidence({
    schema: OUTBOUND_FAILURE_EVIDENCE_SCHEMA,
    failure_code: options.failureCode,
    stage: options.stage,
    mutation_state: options.mutationState,
    retryable: options.retryable ?? false,
    retry_decision: retryDecision,
    retry_not_before: options.retryNotBefore ?? null,
    retry_owner: options.retryOwner ?? (retryDecision === 'stop' ? 'none' : 'recovery'),
    attempt_budget_disposition: options.attemptBudgetDisposition
      ?? (retryDecision === 'stop' ? 'stop' : 'consume'),
    logical_attempt_count: options.logicalAttemptCount
      ?? ((previous?.logical_attempt_count ?? 0) + 1),
    provider_submission_count: options.providerSubmissionCount
      ?? (previous?.provider_submission_count ?? 0),
    first_failure_at: previous?.first_failure_at ?? now,
    last_failure_at: now,
    evidence_coverage: options.evidenceCoverage ?? 'complete',
  });
}

/**
 * Classify only from the bounded, validated outbound evidence contract. In
 * particular, an operation type, payload, or historical error string can
 * never make a row appear never-sent: that conclusion requires both a
 * not-started mutation state and zero provider submissions.
 */
export function classifyOutboundQuarantineDisposition(
  evidence: OutboundFailureEvidenceV1,
): OutboundQuarantineDisposition {
  if (
    evidence.failure_code === 'outbound.unsafe_delivery_unconfirmed'
    && evidence.mutation_state === 'ambiguous'
  ) {
    return 'delivery_ambiguous_unsafe';
  }

  const provenNotStarted = evidence.mutation_state === 'not_started'
    && evidence.provider_submission_count === 0;
  if (!provenNotStarted) return 'legacy_unclassified';

  switch (evidence.failure_code) {
    case 'outbound.deferral_limit_exceeded':
      return 'delivery_not_attempted';
    case 'outbound.replay_attempt_limit_exceeded':
      return 'delivery_not_attempted';
    case 'outbound.pending_replay_unreconstructable':
      return 'record_unreconstructable';
    case 'outbound.status_ping_expired':
      return 'stale_status_discarded';
    default:
      return 'legacy_unclassified';
  }
}

// Failure classes eligible for a best-effort user-facing "your message wasn't
// delivered" notice, sent through the SAME channel that just failed. A
// notice is only warranted when the failure is provably about THIS message
// (its size or a requested capability) rather than the destination or the
// provider connection — a short fixed-string notice to the same destination
// does not share that defect, so it is likely to land.
//
// Deliberately excluded, even though they can also reach retry_decision
// 'stop':
//   - transport.auth_required   (auth — session/credential problem, not this message)
//   - transport.rate_limited    (rate-limit/deferral — retryable, not a stop-worthy rejection)
//   - transport.transient_provider (connectivity — a retryable class can still
//     land on 'stop' once attempts are exhausted; that exhaustion says nothing
//     about whether a fresh notice send would succeed)
//   - transport.send_ambiguous  (ambiguous — the original may have landed; the
//     outcome of a notice send would be equally uncertain)
//   - transport.conversation_not_found (the DESTINATION is the defect — a
//     notice to the same broken destination would hit the identical wall,
//     stronger than "unknown": it is a proven negative)
//   - transport.permanent_provider (mapPortError's unmatched-error fallback —
//     channel health is unproven for whatever provider condition landed here)
//   - every internal outbound.* code (shutdown, governor-shed, crash-in-flight,
//     etc. — none carry transport-typed evidence of channel health)
const NOTICE_ELIGIBLE_FAILURE_CODES: ReadonlySet<OutboundFailureCode> = new Set([
  ErrorCode.PAYLOAD_TOO_LARGE,
  ErrorCode.UNSUPPORTED_CAPABILITY,
]);

/**
 * True when a stopped outbound failure proves the channel itself is healthy,
 * so a best-effort user notice is warranted. False for every retryable
 * outcome (retry_now / retry_not_before) and for stopped failures whose
 * class does not prove channel health (dead-channel / unknown classes stay
 * silent — durable evidence only).
 */
export function outboundFailureWarrantsUserNotice(
  evidence: Pick<OutboundFailureEvidenceV1, 'retry_decision' | 'failure_code'>,
): boolean {
  return evidence.retry_decision === 'stop'
    && NOTICE_ELIGIBLE_FAILURE_CODES.has(evidence.failure_code);
}

export function transferOutboundRetryOwnership(
  evidence: OutboundFailureEvidenceV1,
  retryOwner: Exclude<OutboundRetryOwner, 'none'>,
  nowMs = Date.now(),
): OutboundFailureEvidenceV1 {
  return assertValidEvidence({
    ...evidence,
    retryable: true,
    retry_decision: 'retry_now',
    retry_not_before: null,
    retry_owner: retryOwner,
    attempt_budget_disposition: 'preserve',
    last_failure_at: monotonicEvidenceTimestamp(nowMs, evidence),
  });
}
