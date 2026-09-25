import { describe, expect, it } from 'vitest';

import {
  LOOP_LAG_SAMPLES_MAX_RESPONSE_BYTES,
  LOOP_LAG_SAMPLES_SCHEMA_VERSION,
  buildLoopLagSamplesResponse,
  parseLoopLagSamplesQuery,
} from '../../src/core/loop-lag-samples-endpoint.ts';
import type { RawLoopLagSamplePage } from '../../src/lib/loop-lag-sampler.ts';

function url(query = ''): URL {
  return new URL(`http://localhost/health/event-loop-samples${query}`);
}

function page(count: number): RawLoopLagSamplePage {
  const first = Number.MAX_SAFE_INTEGER - count;
  const samples = Array.from({ length: count }, (_, index) => ({
    sequence: first + index,
    atMs: Number.MAX_SAFE_INTEGER - index,
    wallAtMs: Number.MAX_SAFE_INTEGER - index,
    lagMs: 10_000.123456789,
    source: index % 2 === 0 ? 'interval' as const : 'snapshot' as const,
    discontinuity: index % 17 === 0,
    eluUtilization: 0.123456789012345,
    cpuDeltaMs: 123_456.123456789,
  }));
  return {
    oldestSequence: samples[0]?.sequence ?? null,
    latestSequence: samples.at(-1)?.sequence ?? null,
    nextAfter: samples.at(-1)?.sequence ?? 0,
    truncated: false,
    gap: null,
    samples,
  };
}

describe('parseLoopLagSamplesQuery', () => {
  it('defaults limit and preserves an omitted cursor', () => {
    expect(parseLoopLagSamplesQuery(url())).toEqual({ ok: true, limit: 160 });
  });

  it('accepts canonical bounded integers', () => {
    expect(parseLoopLagSamplesQuery(url('?after=0&limit=160'))).toEqual({
      ok: true,
      after: 0,
      limit: 160,
    });
  });

  it.each([
    ['?other=1', 'unknown_query_parameter'],
    ['?after=1&after=2', 'repeated_query_parameter'],
    ['?limit=1&limit=2', 'repeated_query_parameter'],
    ['?after=', 'invalid_after'],
    ['?after=-1', 'invalid_after'],
    ['?after=1.5', 'invalid_after'],
    ['?after=1e2', 'invalid_after'],
    [`?after=${Number.MAX_SAFE_INTEGER + 1}`, 'invalid_after'],
    ['?limit=', 'invalid_limit'],
    ['?limit=0', 'invalid_limit'],
    ['?limit=161', 'invalid_limit'],
    ['?limit=1.5', 'invalid_limit'],
  ])('fails closed for %s', (query, code) => {
    expect(parseLoopLagSamplesQuery(url(query))).toEqual({ ok: false, status: 400, code });
  });
});

describe('buildLoopLagSamplesResponse', () => {
  it('pins the versioned empty-page shape and next_after', () => {
    const response = buildLoopLagSamplesResponse({
      generatedAt: '2026-08-15T00:00:00.000Z',
      process: { pid: 123, startedAtMs: 1_785_000_000_000, commit: 'a'.repeat(40) },
      cadenceMs: 500,
      page: {
        oldestSequence: null,
        latestSequence: null,
        nextAfter: 0,
        truncated: false,
        gap: null,
        samples: [],
      },
    });

    expect(response).toEqual({
      schema_version: LOOP_LAG_SAMPLES_SCHEMA_VERSION,
      generated_at: '2026-08-15T00:00:00.000Z',
      process: { pid: 123, started_at_ms: 1_785_000_000_000, commit: 'a'.repeat(40) },
      cadence_ms: 500,
      oldest_sequence: null,
      latest_sequence: null,
      next_after: 0,
      truncated: false,
      gap: null,
      samples: [],
    });
  });

  it('projects gap and sample fields with bounded transport precision', () => {
    const response = buildLoopLagSamplesResponse({
      generatedAt: '2026-08-15T00:00:00.000Z',
      process: { pid: 123, startedAtMs: 1_785_000_000_000, commit: 'b'.repeat(40) },
      cadenceMs: 500,
      page: {
        ...page(1),
        gap: { kind: 'cursor_evicted', after: 4, firstAvailableSequence: 10 },
      },
    });

    expect(response.gap).toEqual({
      kind: 'cursor_evicted',
      after: 4,
      first_available_sequence: 10,
    });
    expect(response.samples[0]).toMatchObject({
      lag_ms: 10_000.123,
      elu_utilization: 0.123457,
      cpu_delta_ms: 123_456.123,
    });
  });

  it('keeps the maximum 160-record response strictly below 32 KiB', () => {
    const response = buildLoopLagSamplesResponse({
      generatedAt: '2026-08-15T00:00:00.000Z',
      process: {
        pid: Number.MAX_SAFE_INTEGER,
        startedAtMs: Number.MAX_SAFE_INTEGER,
        commit: 'f'.repeat(40),
      },
      cadenceMs: 500,
      page: page(160),
    });
    const body = JSON.stringify(response);
    expect(Buffer.byteLength(body), `endpoint body was ${Buffer.byteLength(body)} bytes`)
      .toBeLessThan(LOOP_LAG_SAMPLES_MAX_RESPONSE_BYTES);
    expect(body).not.toMatch(/NaN|Infinity/);
  });
});
