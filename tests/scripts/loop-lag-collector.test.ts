import { describe, expect, it, vi } from 'vitest';

import {
  advanceCollectorState,
  decodeLoopLagSamplesResponse,
  fetchLoopLagSamplePage,
  initialCollectorState,
  validateLoopbackBaseUrl,
} from '../../scripts/lib/loop-lag-collector.ts';

function response(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'health.event-loop-samples.v1',
    generated_at: '2026-08-15T00:00:00.000Z',
    process: { pid: 42, started_at_ms: 1_785_000_000_000, commit: 'a'.repeat(40) },
    cadence_ms: 500,
    oldest_sequence: 1,
    latest_sequence: 2,
    next_after: 2,
    truncated: false,
    gap: null,
    samples: [
      { sequence: 1, at_ms: 500, wall_at_ms: 1_785_000_000_500, lag_ms: 0, source: 'interval', discontinuity: false, elu_utilization: 0.1, cpu_delta_ms: 2 },
      { sequence: 2, at_ms: 1_000, wall_at_ms: 1_785_000_001_000, lag_ms: 300, source: 'interval', discontinuity: false, elu_utilization: 0.2, cpu_delta_ms: 3 },
    ],
    ...overrides,
  };
}

describe('validateLoopbackBaseUrl', () => {
  it.each(['http://127.0.0.1:9091', 'http://[::1]:9091', 'http://localhost:9091'])('accepts %s', (value) => {
    expect(validateLoopbackBaseUrl(value).origin).toBe(value);
  });

  it.each([
    'https://127.0.0.1:9091',
    'http://127.0.0.2:9091',
    'http://example.com:9091',
    'http://user:pass@127.0.0.1:9091',
    'http://127.0.0.1:9091/prefix',
    'http://127.0.0.1:9091/#fragment',
  ])('rejects %s', (value) => {
    expect(() => validateLoopbackBaseUrl(value)).toThrow(/loopback/);
  });
});

describe('decodeLoopLagSamplesResponse', () => {
  it('accepts the exact endpoint contract', () => {
    expect(decodeLoopLagSamplesResponse(response()).samples).toHaveLength(2);
  });

  it.each([
    response({ schema_version: 'future.v2' }),
    response({ process: { pid: -1, started_at_ms: 1, commit: null } }),
    response({ samples: [{ ...response().samples[0], sequence: 2 }, { ...response().samples[1], sequence: 1 }] }),
    response({ next_after: Number.MAX_SAFE_INTEGER + 1 }),
  ])('rejects malformed or incompatible responses', (value) => {
    expect(() => decodeLoopLagSamplesResponse(value)).toThrow(/endpoint response/);
  });
});

describe('advanceCollectorState', () => {
  it('deduplicates overlapping pages and preserves the 9-second-late causal timestamp', () => {
    const first = advanceCollectorState(initialCollectorState('line-a'), decodeLoopLagSamplesResponse(response()), '2026-08-15T00:00:10.000Z');
    const overlap = advanceCollectorState(first.state, decodeLoopLagSamplesResponse(response()), '2026-08-15T00:00:19.000Z');

    expect(first.records.filter((record) => record.recordType === 'sample')).toHaveLength(2);
    expect(overlap.records.filter((record) => record.recordType === 'sample')).toHaveLength(0);
    expect(first.records[1]).toMatchObject({
      recordType: 'sample',
      sample: { wall_at_ms: 1_785_000_001_000, lag_ms: 300 },
    });
  });

  it('emits cursor eviction and process change exactly once', () => {
    const first = advanceCollectorState(initialCollectorState('line-a'), decodeLoopLagSamplesResponse(response()), '2026-08-15T00:00:10.000Z');
    const evictedBody = response({
      gap: { kind: 'cursor_evicted', after: 2, first_available_sequence: 10 },
      oldest_sequence: 10,
      latest_sequence: 10,
      next_after: 10,
      samples: [{ ...response().samples[0], sequence: 10 }],
    });
    const evicted = advanceCollectorState(first.state, decodeLoopLagSamplesResponse(evictedBody), '2026-08-15T00:00:20.000Z');
    expect(evicted.records.filter((record) => record.recordType === 'gap')).toEqual([
      expect.objectContaining({ kind: 'cursor_evicted' }),
    ]);

    const changedBody = response({
      process: { pid: 43, started_at_ms: 1_785_000_100_000, commit: 'b'.repeat(40) },
      oldest_sequence: 1,
      latest_sequence: 1,
      next_after: 1,
      samples: [{ ...response().samples[0], sequence: 1 }],
    });
    const changed = advanceCollectorState(evicted.state, decodeLoopLagSamplesResponse(changedBody), '2026-08-15T00:00:30.000Z');
    expect(changed.records.filter((record) => record.recordType === 'gap')).toEqual([
      expect.objectContaining({ kind: 'process_changed' }),
    ]);
    expect(changed.records.filter((record) => record.recordType === 'sample')).toHaveLength(0);
    expect(changed.state.cursor).toBe(0);

    const refetched = advanceCollectorState(changed.state, decodeLoopLagSamplesResponse(changedBody), '2026-08-15T00:00:30.001Z');
    expect(refetched.records.filter((record) => record.recordType === 'sample')).toHaveLength(1);
  });
});

describe('fetchLoopLagSamplePage', () => {
  it('uses token-file auth, loopback, redirect refusal, and an exact cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response()), { status: 200 }));
    const readToken = vi.fn().mockReturnValue('c'.repeat(64));
    const result = await fetchLoopLagSamplePage(
      { baseUrl: 'http://127.0.0.1:9091', tokenFile: '/private/token', after: 4, limit: 160 },
      { fetch: fetchMock, readToken },
    );

    expect(result).toMatchObject({ ok: true });
    expect(readToken).toHaveBeenCalledExactlyOnceWith('/private/token');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9091/health/event-loop-samples?after=4&limit=160',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: `Bearer ${'c'.repeat(64)}` },
      }),
    );
  });

  it.each([
    [401, 'authentication_failed', false],
    [404, 'endpoint_unsupported', false],
    [503, 'http_5xx', true],
  ] as const)('classifies HTTP %i without including response content', async (status, kind, retryable) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('secret response', { status }));
    const result = await fetchLoopLagSamplePage(
      { baseUrl: 'http://localhost:9091', tokenFile: '/private/token', limit: 1 },
      { fetch: fetchMock, readToken: () => 'd'.repeat(64) as never },
    );
    expect(result).toEqual({ ok: false, kind, retryable, status });
    expect(JSON.stringify(result)).not.toContain('secret response');
  });

  it('classifies an unsafe token file before network access', async () => {
    const fetchMock = vi.fn();
    const result = await fetchLoopLagSamplePage(
      { baseUrl: 'http://localhost:9091', tokenFile: '/private/token', limit: 1 },
      { fetch: fetchMock, readToken: () => { throw new Error('unsafe token file'); } },
    );
    expect(result).toEqual({ ok: false, kind: 'token_file_rejected', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
