export const PROCESS_TREE_MAX_DURATION_MS = 60_000;

export const PROCESS_TREE_DIAGNOSTIC_SOURCES = [
  'session_shutdown',
  'stale_session_sweep',
  'ownership_loss_cleanup',
] as const;

export type ProcessTreeDiagnosticSource = typeof PROCESS_TREE_DIAGNOSTIC_SOURCES[number];

export const PROCESS_TREE_TERMINATION_ERROR_CODES = [
  'PROCESS_TREE_INVALID_OPTIONS',
  'PROCESS_TREE_INVALID_TARGET',
  'PROCESS_TREE_INVALID_GENERATION',
  'PROCESS_TREE_INVALID_DURATION',
  'PROCESS_TREE_LEASE_CONFLICT',
  'PROCESS_TREE_RETRY_LEASE_REQUIRED',
  'PROCESS_TREE_RETRY_LEASE_MISSING',
  'PROCESS_TREE_RETRY_LEASE_EXPIRED',
  'PROCESS_TREE_RETRY_ATTEMPTS_EXHAUSTED',
  'PROCESS_TREE_RETRY_NOT_ALLOWED',
  'PROCESS_TREE_LEASE_CAPACITY',
  'PROCESS_TREE_IDENTITY_LIMIT',
  'PROCESS_TREE_INITIAL_CENSUS_UNAVAILABLE',
  'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
  'PROCESS_TREE_ROOT_MISSING',
  'PROCESS_TREE_ROOT_AMBIGUOUS',
  'PROCESS_TREE_CENSUS_MALFORMED',
  'PROCESS_TREE_CENSUS_PERMISSION_DENIED',
  'PROCESS_TREE_PRE_SIGNAL_CENSUS_UNAVAILABLE',
  'PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE',
  'PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE',
  'PROCESS_TREE_SIGNAL_PERMISSION_DENIED',
  'PROCESS_TREE_SIGNAL_FAILED',
  'PROCESS_TREE_SURVIVORS_REMAIN',
  'PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED',
  'PROCESS_TREE_UNEXPECTED_FAILURE',
] as const;

export type ProcessTreeTerminationErrorCode =
  typeof PROCESS_TREE_TERMINATION_ERROR_CODES[number];

export type ProcessTreeTerminationRetryClass =
  | 'invalid_request'
  | 'active_lease'
  | 'census_retryable'
  | 'permission_denied'
  | 'signal_retryable'
  | 'survivor_unresolved'
  | 'unknown';

export interface ProcessTreeTerminationErrorOptions {
  readonly systemCode?: string | null;
}

function isBoundedSystemCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

const RETRY_CLASS_BY_ERROR_CODE: Readonly<
  Record<ProcessTreeTerminationErrorCode, ProcessTreeTerminationRetryClass>
> = {
  PROCESS_TREE_INVALID_OPTIONS: 'invalid_request',
  PROCESS_TREE_INVALID_TARGET: 'invalid_request',
  PROCESS_TREE_INVALID_GENERATION: 'invalid_request',
  PROCESS_TREE_INVALID_DURATION: 'invalid_request',
  PROCESS_TREE_LEASE_CONFLICT: 'active_lease',
  PROCESS_TREE_RETRY_LEASE_REQUIRED: 'active_lease',
  PROCESS_TREE_RETRY_LEASE_MISSING: 'invalid_request',
  PROCESS_TREE_RETRY_LEASE_EXPIRED: 'survivor_unresolved',
  PROCESS_TREE_RETRY_ATTEMPTS_EXHAUSTED: 'survivor_unresolved',
  PROCESS_TREE_RETRY_NOT_ALLOWED: 'permission_denied',
  PROCESS_TREE_LEASE_CAPACITY: 'active_lease',
  PROCESS_TREE_IDENTITY_LIMIT: 'census_retryable',
  PROCESS_TREE_INITIAL_CENSUS_UNAVAILABLE: 'census_retryable',
  PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED: 'census_retryable',
  PROCESS_TREE_ROOT_MISSING: 'census_retryable',
  PROCESS_TREE_ROOT_AMBIGUOUS: 'census_retryable',
  PROCESS_TREE_CENSUS_MALFORMED: 'census_retryable',
  PROCESS_TREE_CENSUS_PERMISSION_DENIED: 'permission_denied',
  PROCESS_TREE_PRE_SIGNAL_CENSUS_UNAVAILABLE: 'census_retryable',
  PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE: 'census_retryable',
  PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE: 'census_retryable',
  PROCESS_TREE_SIGNAL_PERMISSION_DENIED: 'permission_denied',
  PROCESS_TREE_SIGNAL_FAILED: 'signal_retryable',
  PROCESS_TREE_SURVIVORS_REMAIN: 'survivor_unresolved',
  PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED: 'census_retryable',
  PROCESS_TREE_UNEXPECTED_FAILURE: 'unknown',
};

export const PROCESS_TREE_DIAGNOSTIC_FAILURE_CODES = [
  'PROCESS_TREE_DIAGNOSTIC_LOG_FAILED',
  'PROCESS_TREE_OUTCOME_OBSERVER_FAILED',
  'PROCESS_TREE_CGROUP_OBSERVER_FAILED',
  'PROCESS_TREE_CGROUP_OBSERVATION_UNAVAILABLE',
  'PROCESS_TREE_CGROUP_LIMIT_DEPTH',
  'PROCESS_TREE_CGROUP_LIMIT_ENTRIES',
  'PROCESS_TREE_CGROUP_LIMIT_BYTES',
  'PROCESS_TREE_CGROUP_LIMIT_TIME',
  'PROCESS_TREE_CGROUP_INPUT_INVALID',
] as const;

export type ProcessTreeDiagnosticFailureCode =
  typeof PROCESS_TREE_DIAGNOSTIC_FAILURE_CODES[number];

export class ProcessTreeTerminationError extends Error {
  readonly code: ProcessTreeTerminationErrorCode;
  readonly retryClass: ProcessTreeTerminationRetryClass;
  declare readonly systemCode?: string;
  private readonly diagnosticCodeSet = new Set<ProcessTreeDiagnosticFailureCode>();

  constructor(
    code: ProcessTreeTerminationErrorCode,
    message: string,
    options?: ProcessTreeTerminationErrorOptions,
  ) {
    super(message);
    this.name = 'ProcessTreeTerminationError';
    this.code = code;
    this.retryClass = RETRY_CLASS_BY_ERROR_CODE[code];
    if (isBoundedSystemCode(options?.systemCode)) this.systemCode = options.systemCode;
  }

  get diagnosticCodes(): readonly ProcessTreeDiagnosticFailureCode[] {
    return [...this.diagnosticCodeSet].sort();
  }

  addDiagnosticCodes(codes: Iterable<ProcessTreeDiagnosticFailureCode>): this {
    for (const code of codes) this.diagnosticCodeSet.add(code);
    return this;
  }
}

export interface ProcessTreeFailureDiagnostic {
  readonly errorCode: ProcessTreeTerminationErrorCode;
  readonly retryClass: ProcessTreeTerminationRetryClass;
  readonly systemCode?: string;
}

/** Stable projection for logs at process-tree caller boundaries. */
export function processTreeFailureDiagnostic(error: unknown): ProcessTreeFailureDiagnostic {
  if (!(error instanceof ProcessTreeTerminationError)) {
    return {
      errorCode: 'PROCESS_TREE_UNEXPECTED_FAILURE',
      retryClass: 'unknown',
    };
  }
  return {
    errorCode: error.code,
    retryClass: error.retryClass,
    ...(error.systemCode === undefined ? {} : { systemCode: error.systemCode }),
  };
}

export interface KillSessionOutcome {
  readonly outcome: 'terminated' | 'escalated' | 'unresolved_ambiguous';
  readonly durationMs: number;
  readonly ownedProcessCount: number;
  readonly signaledProcessCount: number;
  readonly ambiguousProcessCount: number;
  readonly diagnosticState: 'complete' | 'inconclusive';
  readonly diagnosticCodes: readonly ProcessTreeDiagnosticFailureCode[];
}

/** Pre-existing authority for the exact root process incarnation. */
export interface ProcessTreeRootAuthority {
  readonly pid: number;
  readonly parentPid: number;
  readonly birthToken: string;
}

export interface CgroupDivergenceInfo {
  readonly cgroupMemberCount: number;
  readonly ownedCount: number;
  readonly offTreeCount: number;
}
