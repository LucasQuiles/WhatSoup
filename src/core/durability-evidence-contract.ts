import {
  ErrorCode,
  allErrorCodes,
  isTransportErrorEvidence,
} from './transport-error-taxonomy.ts';

export const TOOL_INPUT_MARKER = '[metadata-only]';
export const TOOL_RESULT_MARKERS = Object.freeze({
  success: '[metadata-only:success]',
  error: '[metadata-only:error]',
  recovery: '[metadata-only:recovery]',
});

export const TOOL_FAILURE_CODES = [
  'validation_rejected',
  'authorization_denied',
  'policy_or_hook_blocked',
  'cancelled',
  'dependency_unavailable',
  'rate_limited',
  'resource_exhausted',
  'handler_failed',
  'returned_error',
  'unknown',
] as const;

export type ToolFailureCode = typeof TOOL_FAILURE_CODES[number];
export const TOOL_FAILURE_STAGES = [
  'admission',
  'validation',
  'authorization',
  'policy',
  'handler',
  'dependency',
  'recovery',
  'unknown',
] as const;
export type ToolFailureStage = typeof TOOL_FAILURE_STAGES[number];
export type RetryDisposition = 'not_applicable' | 'retryable' | 'not_retryable' | 'unknown';
export type OperatorAction = 'none' | 'inspect' | 'recover' | 'unknown';
export type ToolEvidenceCoverage = 'complete' | 'partial' | 'legacy_unclassified';

export interface ToolFailureDisposition {
  retryDisposition: Exclude<RetryDisposition, 'not_applicable'>;
  operatorAction: OperatorAction;
}

export const TOOL_FAILURE_DISPOSITIONS = Object.freeze({
  validation_rejected: { retryDisposition: 'not_retryable', operatorAction: 'none' },
  authorization_denied: { retryDisposition: 'not_retryable', operatorAction: 'recover' },
  policy_or_hook_blocked: { retryDisposition: 'not_retryable', operatorAction: 'inspect' },
  cancelled: { retryDisposition: 'not_retryable', operatorAction: 'none' },
  dependency_unavailable: { retryDisposition: 'retryable', operatorAction: 'inspect' },
  rate_limited: { retryDisposition: 'retryable', operatorAction: 'none' },
  resource_exhausted: { retryDisposition: 'not_retryable', operatorAction: 'recover' },
  handler_failed: { retryDisposition: 'not_retryable', operatorAction: 'inspect' },
  returned_error: { retryDisposition: 'unknown', operatorAction: 'inspect' },
  unknown: { retryDisposition: 'unknown', operatorAction: 'inspect' },
} as const satisfies Record<ToolFailureCode, ToolFailureDisposition>);

export interface ToolFailureEvidence extends ToolFailureDisposition {
  failureCode: ToolFailureCode;
  failureStage: ToolFailureStage;
  evidenceCoverage: ToolEvidenceCoverage;
}

export type ToolDurabilityWriteStage = 'record' | 'execute' | 'complete' | 'deny';

export interface ToolDurabilityTelemetrySnapshot {
  observed: true;
  totalWriteLosses: number;
  byStage: Record<ToolDurabilityWriteStage, number>;
  firstLossAt: number | null;
  lastLossAt: number | null;
}

export type ToolCompletionEvidence =
  | {
      isError: false;
      durationMs: number;
      evidenceCoverage?: Extract<ToolEvidenceCoverage, 'complete' | 'partial'>;
    }
  | {
      isError: true;
      durationMs: number;
      failure: ToolFailureEvidence;
    };

const RESOURCE_EXHAUSTION_CODES = new Set([
  'ENOSPC',
  'ENOMEM',
  'EMFILE',
  'ENFILE',
  'SQLITE_FULL',
  'SQLITE_NOMEM',
]);

function evidenceFor(
  failureCode: ToolFailureCode,
  failureStage: ToolFailureStage,
  evidenceCoverage: ToolEvidenceCoverage = 'complete',
): ToolFailureEvidence {
  return {
    failureCode,
    failureStage,
    ...TOOL_FAILURE_DISPOSITIONS[failureCode],
    evidenceCoverage,
  };
}

export function classifyThrownToolFailure(error: unknown): ToolFailureEvidence {
  if (
    error instanceof Error
    && (
      error.name === 'AbortError'
      || (error as Error & { code?: unknown }).code === 'ABORT_ERR'
    )
  ) {
    return evidenceFor('cancelled', 'handler');
  }

  const stableCode = error instanceof Error
    ? (error as Error & { code?: unknown }).code
    : undefined;
  if (typeof stableCode === 'string' && RESOURCE_EXHAUSTION_CODES.has(stableCode)) {
    return evidenceFor('resource_exhausted', 'dependency');
  }

  if (isTransportErrorEvidence(error)) {
    if (error.payload.code === ErrorCode.RATE_LIMITED) {
      return evidenceFor('rate_limited', 'dependency');
    }
    if (error.payload.code === ErrorCode.PAYLOAD_TOO_LARGE) {
      return evidenceFor('resource_exhausted', 'dependency');
    }
    return evidenceFor('dependency_unavailable', 'dependency');
  }

  if (error instanceof Error) {
    return evidenceFor('handler_failed', 'handler');
  }

  return evidenceFor('unknown', 'unknown', 'partial');
}

export const TOOL_DURABILITY_GROUPS = [
  'advanced',
  'audit',
  'business',
  'calls',
  'chat-management',
  'chat-operations',
  'community',
  'groups',
  'knowledge',
  'media',
  'memory-write',
  'messaging',
  'newsletter',
  'presence',
  'profile',
  'retention',
  'scheduling',
  'search',
  'status',
  'substrate',
  'voice',
  'other',
] as const;

export type ToolDurabilityGroup = typeof TOOL_DURABILITY_GROUPS[number];
const TOOL_DURABILITY_GROUP_SET = new Set<string>(TOOL_DURABILITY_GROUPS);

export function normalizeToolDurabilityGroup(group: string | undefined): ToolDurabilityGroup {
  return group !== undefined && TOOL_DURABILITY_GROUP_SET.has(group)
    ? group as ToolDurabilityGroup
    : 'other';
}

export const OUTBOUND_FAILURE_CODES = [
  ...allErrorCodes(),
  'unknown',
  'legacy_unclassified',
] as const;

export type OutboundAuditFailureCode = typeof OUTBOUND_FAILURE_CODES[number];
export type OutboundOutcomeCode =
  | 'intent'
  | 'submitted'
  | 'confirmed'
  | 'failed_not_sent'
  | 'ambiguous'
  | 'legacy_unclassified';
export type OutboundAuditFailureStage =
  | 'not_started'
  | 'provider_call_started'
  | 'ack_received'
  | 'unknown';
export type OutboundAuditMutationState =
  | 'not_started'
  | 'not_mutated'
  | 'maybe_mutated'
  | 'acknowledged'
  | 'unknown';
export type OutboundAuditEvidenceCoverage = 'typed' | 'untyped' | 'legacy_unclassified';

export interface OutboundAuditFailureEvidence {
  outcomeCode: 'failed_not_sent' | 'ambiguous';
  failureCode: Exclude<OutboundAuditFailureCode, 'legacy_unclassified'>;
  failureStage: OutboundAuditFailureStage;
  mutationState: 'not_mutated' | 'maybe_mutated' | 'unknown';
  retryable: boolean;
  evidenceCoverage: Exclude<OutboundAuditEvidenceCoverage, 'legacy_unclassified'>;
}

const DEFINITELY_NOT_SENT_CODES = new Set<string>([
  ErrorCode.UNSUPPORTED_CAPABILITY,
  ErrorCode.PAYLOAD_TOO_LARGE,
  ErrorCode.CONVERSATION_NOT_FOUND,
  ErrorCode.AUTH_REQUIRED,
  ErrorCode.RATE_LIMITED,
  ErrorCode.PERMANENT_PROVIDER,
]);
const OUTBOUND_FAILURE_CODE_SET = new Set<string>(allErrorCodes());

export function classifyOutboundSendFailure(error: unknown): OutboundAuditFailureEvidence {
  if (!isTransportErrorEvidence(error)) {
    return {
      outcomeCode: 'ambiguous',
      failureCode: 'unknown',
      failureStage: 'unknown',
      mutationState: 'unknown',
      retryable: false,
      evidenceCoverage: 'untyped',
    };
  }

  const { code, phase, retryable } = error.payload;
  const failureCode: Exclude<OutboundAuditFailureCode, 'legacy_unclassified'> =
    OUTBOUND_FAILURE_CODE_SET.has(code) ? code as ErrorCode : 'unknown';
  if (code === ErrorCode.SEND_AMBIGUOUS) {
    return {
      outcomeCode: 'ambiguous',
      failureCode,
      failureStage: phase ?? 'unknown',
      mutationState: 'maybe_mutated',
      retryable,
      evidenceCoverage: 'typed',
    };
  }

  if (
    phase !== 'ack_received'
    && DEFINITELY_NOT_SENT_CODES.has(code)
  ) {
    return {
      outcomeCode: 'failed_not_sent',
      failureCode,
      failureStage: phase ?? 'not_started',
      mutationState: 'not_mutated',
      retryable,
      evidenceCoverage: 'typed',
    };
  }

  return {
    outcomeCode: 'ambiguous',
    failureCode,
    failureStage: phase ?? 'unknown',
    mutationState: phase === 'provider_call_started' || phase === 'ack_received'
      ? 'maybe_mutated'
      : 'unknown',
    retryable,
    evidenceCoverage: 'typed',
  };
}
