import { randomBytes } from 'node:crypto';

export const MEMORY_OPERATION_TELEMETRY_SCHEMA =
  'whatsoup-memory-operation-v1' as const;

export const MEMORY_OPERATION_FAILURE_CODES = [
  'none',
  'breaker_open',
  'project_guard_failed',
  'auth_failed',
  'rate_limited',
  'timeout',
  'network_error',
  'invalid_request',
  'provider_unavailable',
  'unknown',
] as const;

export type MemoryOperationFailureCode =
  (typeof MEMORY_OPERATION_FAILURE_CODES)[number];

export type MemoryReadinessState =
  | 'disabled'
  | 'auth_failed'
  | 'index_missing'
  | 'project_mismatch'
  | 'network_error'
  | 'unknown'
  | 'ready';

export interface MemoryReadinessLogFields {
  pineconeReadiness: MemoryReadinessState;
}

export interface MemoryOperationFailure {
  code: MemoryOperationFailureCode;
  retryable: boolean;
}

export type MemoryOperation =
  | 'search'
  | 'entity_search'
  | 'rerank'
  | 'upsert'
  | 'readiness'
  | 'memory_write';

export type MemoryScopeKind =
  | 'none'
  | 'chat'
  | 'sender'
  | 'self'
  | 'entity'
  | 'global'
  | 'batch';

export type MemoryFilterShape =
  | 'none'
  | 'chat_eq'
  | 'sender_eq'
  | 'memory_type_eq'
  | 'source_ne'
  | 'mixed'
  | 'unknown';

export interface MemoryOperationContext {
  operationId: string;
  traceId?: string;
  operation: MemoryOperation;
  scopeKind: MemoryScopeKind;
  filterShape: MemoryFilterShape;
}

export type MemoryOperationStage =
  | 'guard'
  | 'request'
  | 'rerank'
  | 'write'
  | 'finalize';

export type MemoryOperationStatus =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'skipped';

export type MemoryEvidenceCoverage =
  | 'not_observed'
  | 'local_guard'
  | 'provider_response'
  | 'provider_error'
  | 'fallback_scores';

export interface MemoryScoreBuckets {
  high: number;
  medium: number;
  low: number;
}

export type MemoryDurationBucket =
  | 'unknown'
  | 'lt_100ms'
  | 'lt_1s'
  | 'lt_5s'
  | 'gte_5s';

export interface MemoryOperationOutcome {
  stage: MemoryOperationStage;
  status: MemoryOperationStatus;
  failureCode: MemoryOperationFailureCode;
  retryable: boolean;
  attempt: 0 | 1 | 2;
  resultCount: number;
  durationMs?: number;
  scores?: readonly number[];
  evidenceCoverage: MemoryEvidenceCoverage;
}

export interface MemoryOperationEvent {
  schema: typeof MEMORY_OPERATION_TELEMETRY_SCHEMA;
  operation_id: string;
  trace_id?: string;
  operation: MemoryOperation;
  stage: MemoryOperationStage;
  status: MemoryOperationStatus;
  failure_code: MemoryOperationFailureCode;
  retryable: boolean;
  attempt: 0 | 1 | 2;
  result_count: number;
  score_buckets?: MemoryScoreBuckets;
  duration_bucket: MemoryDurationBucket;
  scope_kind: MemoryScopeKind;
  filter_shape: MemoryFilterShape;
  evidence_coverage: MemoryEvidenceCoverage;
}

const OPAQUE_OPERATION_ID = /^[a-f0-9]{32}$/;
const OPAQUE_TRACE_ID = /^[a-f0-9]{8,64}$/;
const NETWORK_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export function normalizeMemoryTraceId(
  traceId: string | undefined,
): string | undefined {
  return traceId && OPAQUE_TRACE_ID.test(traceId) ? traceId : undefined;
}

export function buildMemoryReadinessLogFields(
  state: MemoryReadinessState,
): MemoryReadinessLogFields {
  return { pineconeReadiness: state };
}

export function createMemoryOperationContext(input: {
  operation: MemoryOperation;
  traceId?: string;
  operationId?: string;
  scopeKind: MemoryScopeKind;
  filterShape: MemoryFilterShape;
}): MemoryOperationContext {
  const operationId =
    input.operationId && OPAQUE_OPERATION_ID.test(input.operationId)
      ? input.operationId
      : randomBytes(16).toString('hex');
  const traceId = normalizeMemoryTraceId(input.traceId);

  return {
    operationId,
    ...(traceId ? { traceId } : {}),
    operation: input.operation,
    scopeKind: input.scopeKind,
    filterShape: input.filterShape,
  };
}

function readBoundedField(value: object, field: PropertyKey): unknown {
  try {
    return Reflect.get(value, field);
  } catch {
    return undefined;
  }
}

export function classifyMemoryOperationFailure(
  error: unknown,
): MemoryOperationFailure {
  const statuses: number[] = [];
  const codes: string[] = [];
  const names: string[] = [];
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < 4; depth += 1) {
    if (
      (typeof current !== 'object' && typeof current !== 'function') ||
      current === null ||
      visited.has(current)
    ) {
      break;
    }

    visited.add(current);
    const status = readBoundedField(current, 'status');
    const code = readBoundedField(current, 'code');
    const name = readBoundedField(current, 'name');
    if (typeof status === 'number' && Number.isFinite(status)) {
      statuses.push(status);
    }
    if (typeof code === 'string') {
      codes.push(code);
    }
    if (typeof name === 'string') {
      names.push(name);
    }
    current = readBoundedField(current, 'cause');
  }

  if (statuses.some((status) => status === 400 || status === 413)) {
    return { code: 'invalid_request', retryable: false };
  }
  if (statuses.some((status) => status === 401 || status === 403)) {
    return { code: 'auth_failed', retryable: false };
  }
  if (
    statuses.includes(408) ||
    codes.includes('ETIMEDOUT') ||
    names.includes('AbortError')
  ) {
    return { code: 'timeout', retryable: true };
  }
  if (statuses.includes(429)) {
    return { code: 'rate_limited', retryable: true };
  }
  if (codes.some((code) => NETWORK_FAILURE_CODES.has(code))) {
    return { code: 'network_error', retryable: true };
  }
  if (
    statuses.some((status) => status >= 500 && status <= 599) ||
    codes.includes('PINECONE_UNAVAILABLE')
  ) {
    return { code: 'provider_unavailable', retryable: true };
  }
  return { code: 'unknown', retryable: true };
}

function hasExactOperator(value: unknown, operator: '$eq' | '$ne'): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  try {
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === operator;
  } catch {
    return false;
  }
}

export function classifyMemoryFilter(filters: unknown): {
  scopeKind: MemoryScopeKind;
  filterShape: MemoryFilterShape;
} {
  if (typeof filters !== 'object' || filters === null) {
    return { scopeKind: 'global', filterShape: 'unknown' };
  }

  let keys: string[];
  try {
    keys = Object.keys(filters);
  } catch {
    return { scopeKind: 'global', filterShape: 'unknown' };
  }

  if (keys.length === 0) {
    return { scopeKind: 'none', filterShape: 'none' };
  }
  if (keys.length > 1) {
    return { scopeKind: 'global', filterShape: 'mixed' };
  }

  const key = keys[0];
  const value = readBoundedField(filters, key);
  if (key === 'chat_jid' && hasExactOperator(value, '$eq')) {
    return { scopeKind: 'chat', filterShape: 'chat_eq' };
  }
  if (key === 'sender_jid' && hasExactOperator(value, '$eq')) {
    return { scopeKind: 'sender', filterShape: 'sender_eq' };
  }
  if (key === 'memory_type' && hasExactOperator(value, '$eq')) {
    return { scopeKind: 'self', filterShape: 'memory_type_eq' };
  }
  if (key === 'source' && hasExactOperator(value, '$ne')) {
    return { scopeKind: 'entity', filterShape: 'source_ne' };
  }
  return { scopeKind: 'global', filterShape: 'unknown' };
}

export function bucketMemoryScores(
  scores: readonly number[],
): MemoryScoreBuckets {
  const buckets: MemoryScoreBuckets = { high: 0, medium: 0, low: 0 };
  for (const score of scores) {
    if (!Number.isFinite(score)) {
      continue;
    }
    if (score >= 0.75) {
      buckets.high += 1;
    } else if (score >= 0.4) {
      buckets.medium += 1;
    } else {
      buckets.low += 1;
    }
  }
  return buckets;
}

export function bucketMemoryDuration(
  durationMs: number | undefined,
): MemoryDurationBucket {
  if (durationMs === undefined || !Number.isFinite(durationMs)) {
    return 'unknown';
  }
  if (durationMs < 100) {
    return 'lt_100ms';
  }
  if (durationMs < 1_000) {
    return 'lt_1s';
  }
  if (durationMs < 5_000) {
    return 'lt_5s';
  }
  return 'gte_5s';
}

export function buildMemoryOperationEvent(
  context: MemoryOperationContext,
  outcome: MemoryOperationOutcome,
): MemoryOperationEvent {
  const resultCount =
    Number.isFinite(outcome.resultCount) && outcome.resultCount > 0
      ? Math.trunc(outcome.resultCount)
      : 0;
  const event: MemoryOperationEvent = {
    schema: MEMORY_OPERATION_TELEMETRY_SCHEMA,
    operation_id: context.operationId,
    operation: context.operation,
    stage: outcome.stage,
    status: outcome.status,
    failure_code: outcome.failureCode,
    retryable: outcome.retryable,
    attempt: outcome.attempt,
    result_count: resultCount,
    duration_bucket: bucketMemoryDuration(outcome.durationMs),
    scope_kind: context.scopeKind,
    filter_shape: context.filterShape,
    evidence_coverage: outcome.evidenceCoverage,
  };

  if (context.traceId !== undefined) {
    event.trace_id = context.traceId;
  }
  if (outcome.scores !== undefined) {
    event.score_buckets = bucketMemoryScores(outcome.scores);
  }
  return event;
}
