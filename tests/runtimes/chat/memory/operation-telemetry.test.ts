import { describe, expect, it } from 'vitest';

import {
  MEMORY_OPERATION_FAILURE_CODES,
  bucketMemoryScores,
  buildMemoryOperationEvent,
  classifyMemoryFilter,
  classifyMemoryOperationFailure,
  createMemoryOperationContext,
} from '../../../../src/runtimes/chat/memory/operation-telemetry.ts';

describe('memory operation telemetry', () => {
  it('creates a content-independent opaque operation identity', () => {
    const context = createMemoryOperationContext({
      operation: 'search',
      traceId: '0123abcd',
      scopeKind: 'chat',
      filterShape: 'chat_eq',
    });

    expect(context.operationId).toMatch(/^[a-f0-9]{32}$/);
    expect(context.traceId).toBe('0123abcd');
    expect(MEMORY_OPERATION_FAILURE_CODES).toContain('project_guard_failed');
  });

  it('omits caller-controlled non-opaque trace text', () => {
    expect(
      createMemoryOperationContext({
        operation: 'search',
        traceId: 'SYNTHETIC_PRIVATE_TRACE_MARKER',
        scopeKind: 'chat',
        filterShape: 'chat_eq',
      }).traceId,
    ).toBeUndefined();
  });

  it.each([
    [{ status: 400 }, 'invalid_request', false],
    [{ status: 401 }, 'auth_failed', false],
    [{ status: 408 }, 'timeout', true],
    [{ status: 429 }, 'rate_limited', true],
    [{ status: 503 }, 'provider_unavailable', true],
    [
      Object.assign(new Error('SYNTHETIC_PRIVATE_TIMEOUT_MARKER'), {
        code: 'ETIMEDOUT',
      }),
      'timeout',
      true,
    ],
    [
      Object.assign(new Error('SYNTHETIC_PRIVATE_NETWORK_MARKER'), {
        cause: { code: 'ENOTFOUND' },
      }),
      'network_error',
      true,
    ],
    [new Error('SYNTHETIC_PRIVATE_PROVIDER_MARKER'), 'unknown', true],
  ])(
    'classifies bounded machine evidence without returning prose',
    (error, code, retryable) => {
      const failure = classifyMemoryOperationFailure(error);

      expect(failure).toEqual({ code, retryable });
      expect(JSON.stringify(failure)).not.toContain('SYNTHETIC_PRIVATE');
    },
  );

  it('bounds cause traversal and tolerates cycles', () => {
    const fifthCause = { code: 'ETIMEDOUT' };
    const fourthCause = { cause: fifthCause };
    const thirdCause = { cause: fourthCause };
    const secondCause = { cause: thirdCause };
    const firstCause = { cause: secondCause };
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;

    expect(classifyMemoryOperationFailure(firstCause)).toEqual({
      code: 'unknown',
      retryable: true,
    });
    expect(classifyMemoryOperationFailure(cyclic)).toEqual({
      code: 'unknown',
      retryable: true,
    });
  });

  it('projects filters without values', () => {
    expect(
      classifyMemoryFilter({
        chat_jid: { $eq: 'SYNTHETIC_PRIVATE_CHAT_MARKER' },
      }),
    ).toEqual({ scopeKind: 'chat', filterShape: 'chat_eq' });
    expect(
      classifyMemoryFilter({
        chat_jid: { $eq: 'SYNTHETIC_PRIVATE_CHAT_MARKER' },
        memory_type: { $eq: 'SYNTHETIC_PRIVATE_TYPE_MARKER' },
      }),
    ).toEqual({ scopeKind: 'global', filterShape: 'mixed' });
    expect(
      classifyMemoryFilter({
        private_key: 'SYNTHETIC_PRIVATE_FILTER_MARKER',
      }),
    ).toEqual({ scopeKind: 'global', filterShape: 'unknown' });
  });

  it('buckets scores into bounded aggregate counts', () => {
    expect(bucketMemoryScores([0.9, 0.75, 0.74, 0.4, 0.39, Number.NaN])).toEqual(
      {
        high: 2,
        medium: 2,
        low: 1,
      },
    );
  });

  it('builds only the versioned allowlisted envelope', () => {
    const event = buildMemoryOperationEvent(
      {
        operationId: 'a'.repeat(32),
        traceId: '0123abcd',
        operation: 'search',
        scopeKind: 'chat',
        filterShape: 'chat_eq',
      },
      {
        stage: 'request',
        status: 'failed',
        failureCode: 'timeout',
        retryable: true,
        attempt: 2,
        resultCount: 0,
        durationMs: 123,
        scores: [],
        evidenceCoverage: 'provider_error',
      },
    );

    expect(event).toEqual({
      schema: 'whatsoup-memory-operation-v1',
      operation_id: 'a'.repeat(32),
      trace_id: '0123abcd',
      operation: 'search',
      stage: 'request',
      status: 'failed',
      failure_code: 'timeout',
      retryable: true,
      attempt: 2,
      result_count: 0,
      score_buckets: { high: 0, medium: 0, low: 0 },
      duration_bucket: 'lt_1s',
      scope_kind: 'chat',
      filter_shape: 'chat_eq',
      evidence_coverage: 'provider_error',
    });
    expect(Object.keys(event).sort()).toEqual([
      'attempt',
      'duration_bucket',
      'evidence_coverage',
      'failure_code',
      'filter_shape',
      'operation',
      'operation_id',
      'result_count',
      'retryable',
      'schema',
      'scope_kind',
      'score_buckets',
      'stage',
      'status',
      'trace_id',
    ]);
  });
});
