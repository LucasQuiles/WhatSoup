import type { RawLoopLagSample, RawLoopLagSamplePage } from '../lib/loop-lag-sampler.ts';

export const LOOP_LAG_SAMPLES_SCHEMA_VERSION = 'health.event-loop-samples.v1';
export const LOOP_LAG_SAMPLES_MAX_LIMIT = 160;
export const LOOP_LAG_SAMPLES_MAX_RESPONSE_BYTES = 32 * 1024;

export type LoopLagQueryErrorCode =
  | 'unknown_query_parameter'
  | 'repeated_query_parameter'
  | 'invalid_after'
  | 'invalid_limit';

export type LoopLagSamplesQueryResult =
  | { readonly ok: true; readonly after?: number; readonly limit: number }
  | { readonly ok: false; readonly status: 400; readonly code: LoopLagQueryErrorCode };

export interface LoopLagSamplesProcessIdentity {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly commit: string | null;
}

export interface LoopLagSamplesWireSample {
  readonly sequence: number;
  readonly at_ms: number;
  readonly wall_at_ms: number;
  readonly lag_ms: number;
  readonly source: RawLoopLagSample['source'];
  readonly discontinuity: boolean;
  readonly elu_utilization: number | null;
  readonly cpu_delta_ms: number | null;
}

export interface LoopLagSamplesResponse {
  readonly schema_version: typeof LOOP_LAG_SAMPLES_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly process: {
    readonly pid: number;
    readonly started_at_ms: number;
    readonly commit: string | null;
  };
  readonly cadence_ms: number;
  readonly oldest_sequence: number | null;
  readonly latest_sequence: number | null;
  readonly next_after: number;
  readonly truncated: boolean;
  readonly gap: {
    readonly kind: 'cursor_evicted';
    readonly after: number;
    readonly first_available_sequence: number;
  } | null;
  readonly samples: readonly LoopLagSamplesWireSample[];
}

export function parseLoopLagSamplesQuery(url: URL): LoopLagSamplesQueryResult {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'after' && key !== 'limit')) {
    return { ok: false, status: 400, code: 'unknown_query_parameter' };
  }
  if (url.searchParams.getAll('after').length > 1 || url.searchParams.getAll('limit').length > 1) {
    return { ok: false, status: 400, code: 'repeated_query_parameter' };
  }

  const rawAfter = url.searchParams.get('after');
  const rawLimit = url.searchParams.get('limit');
  let after: number | undefined;
  if (rawAfter !== null) {
    const parsedAfter = parseCanonicalInteger(rawAfter);
    if (parsedAfter === null || parsedAfter < 0) {
      return { ok: false, status: 400, code: 'invalid_after' };
    }
    after = parsedAfter;
  }
  const limit = rawLimit === null ? LOOP_LAG_SAMPLES_MAX_LIMIT : parseCanonicalInteger(rawLimit);
  if (limit === null || limit < 1 || limit > LOOP_LAG_SAMPLES_MAX_LIMIT) {
    return { ok: false, status: 400, code: 'invalid_limit' };
  }
  return after === undefined ? { ok: true, limit } : { ok: true, after, limit };
}

export function buildLoopLagSamplesResponse(input: {
  readonly generatedAt: string;
  readonly process: LoopLagSamplesProcessIdentity;
  readonly cadenceMs: number;
  readonly page: RawLoopLagSamplePage;
}): LoopLagSamplesResponse {
  return {
    schema_version: LOOP_LAG_SAMPLES_SCHEMA_VERSION,
    generated_at: input.generatedAt,
    process: {
      pid: input.process.pid,
      started_at_ms: input.process.startedAtMs,
      commit: input.process.commit,
    },
    cadence_ms: input.cadenceMs,
    oldest_sequence: input.page.oldestSequence,
    latest_sequence: input.page.latestSequence,
    next_after: input.page.nextAfter,
    truncated: input.page.truncated,
    gap: input.page.gap === null
      ? null
      : {
          kind: input.page.gap.kind,
          after: input.page.gap.after,
          first_available_sequence: input.page.gap.firstAvailableSequence,
        },
    samples: input.page.samples.map(projectSample),
  };
}

function parseCanonicalInteger(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function projectSample(sample: RawLoopLagSample): LoopLagSamplesWireSample {
  return {
    sequence: sample.sequence,
    at_ms: roundFinite(sample.atMs, 3, 'atMs'),
    wall_at_ms: roundFinite(sample.wallAtMs, 3, 'wallAtMs'),
    lag_ms: roundFinite(sample.lagMs, 3, 'lagMs'),
    source: sample.source,
    discontinuity: sample.discontinuity,
    elu_utilization: sample.eluUtilization === null
      ? null
      : roundFinite(sample.eluUtilization, 6, 'eluUtilization'),
    cpu_delta_ms: sample.cpuDeltaMs === null
      ? null
      : roundFinite(sample.cpuDeltaMs, 3, 'cpuDeltaMs'),
  };
}

function roundFinite(value: number, digits: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  if (Number.isInteger(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
