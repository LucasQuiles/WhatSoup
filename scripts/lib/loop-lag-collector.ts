import { z } from 'zod';

import type { CanonicalHealthToken } from '../../src/fleet/health-token-file.ts';
import { readPrivateHealthTokenFileSync } from '../../src/fleet/health-token-file.ts';
import {
  LOOP_LAG_SAMPLES_MAX_RESPONSE_BYTES,
  LOOP_LAG_SAMPLES_SCHEMA_VERSION,
  type LoopLagSamplesResponse,
} from '../../src/core/loop-lag-samples-endpoint.ts';

const ProcessSchema = z.object({
  pid: z.number().int().positive().safe(),
  started_at_ms: z.number().nonnegative().finite(),
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
}).strict();

const SampleSchema = z.object({
  sequence: z.number().int().positive().safe(),
  at_ms: z.number().nonnegative().finite(),
  wall_at_ms: z.number().nonnegative().finite(),
  lag_ms: z.number().nonnegative().finite(),
  source: z.enum(['interval', 'snapshot']),
  discontinuity: z.boolean(),
  elu_utilization: z.number().min(0).max(1).finite().nullable(),
  cpu_delta_ms: z.number().nonnegative().finite().nullable(),
}).strict();

const ResponseSchema = z.object({
  schema_version: z.literal(LOOP_LAG_SAMPLES_SCHEMA_VERSION),
  generated_at: z.string().datetime({ offset: true }),
  process: ProcessSchema,
  cadence_ms: z.number().int().positive().safe(),
  oldest_sequence: z.number().int().positive().safe().nullable(),
  latest_sequence: z.number().int().positive().safe().nullable(),
  next_after: z.number().int().nonnegative().safe(),
  truncated: z.boolean(),
  gap: z.object({
    kind: z.literal('cursor_evicted'),
    after: z.number().int().nonnegative().safe(),
    first_available_sequence: z.number().int().positive().safe(),
  }).strict().nullable(),
  samples: z.array(SampleSchema).max(160),
}).strict();

export interface CollectorState {
  readonly instance: string;
  readonly process: LoopLagSamplesResponse['process'] | null;
  readonly cursor: number | undefined;
  readonly seenKeys: readonly string[];
}

export type CollectorObservationRecord =
  | {
      readonly recordType: 'sample';
      readonly process: LoopLagSamplesResponse['process'];
      readonly sample: LoopLagSamplesResponse['samples'][number];
      readonly observedAt: string;
    }
  | {
      readonly recordType: 'gap';
      readonly kind: 'cursor_evicted' | 'process_changed';
      readonly observedAt: string;
      readonly detail: Record<string, number | string | null>;
    };

export interface CollectorTransition {
  readonly state: CollectorState;
  readonly records: readonly CollectorObservationRecord[];
}

export type FetchPageResult =
  | { readonly ok: true; readonly response: LoopLagSamplesResponse }
  | {
      readonly ok: false;
      readonly kind: 'authentication_failed' | 'token_file_rejected' | 'endpoint_unsupported' | 'http_5xx' | 'request_failed';
      readonly retryable: boolean;
      readonly status?: number;
    };

export function validateLoopbackBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('base URL must be a loopback HTTP origin');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  if (
    url.protocol !== 'http:'
    || !loopback
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('base URL must be a loopback HTTP origin');
  }
  return url;
}

export function decodeLoopLagSamplesResponse(value: unknown): LoopLagSamplesResponse {
  const parsed = ResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid loop-lag endpoint response');
  const response = parsed.data;
  for (let index = 1; index < response.samples.length; index += 1) {
    if (response.samples[index - 1]!.sequence >= response.samples[index]!.sequence) {
      throw new Error('invalid loop-lag endpoint response ordering');
    }
  }
  if (response.samples.length > 0 && response.next_after !== response.samples.at(-1)!.sequence) {
    throw new Error('invalid loop-lag endpoint response cursor');
  }
  return response;
}

export function initialCollectorState(instance: string): CollectorState {
  return { instance, process: null, cursor: undefined, seenKeys: [] };
}

export function advanceCollectorState(
  state: CollectorState,
  response: LoopLagSamplesResponse,
  observedAt: string,
): CollectorTransition {
  const records: CollectorObservationRecord[] = [];
  const processChanged = state.process !== null
    && (state.process.pid !== response.process.pid
      || state.process.started_at_ms !== response.process.started_at_ms);
  let seen = processChanged ? new Set<string>() : new Set(state.seenKeys);

  if (processChanged) {
    records.push({
      recordType: 'gap',
      kind: 'process_changed',
      observedAt,
      detail: {
        previous_pid: state.process!.pid,
        previous_started_at_ms: state.process!.started_at_ms,
        next_pid: response.process.pid,
        next_started_at_ms: response.process.started_at_ms,
      },
    });
    return {
      state: {
        instance: state.instance,
        process: response.process,
        cursor: 0,
        seenKeys: [],
      },
      records,
    };
  }
  if (response.gap !== null) {
    records.push({
      recordType: 'gap',
      kind: 'cursor_evicted',
      observedAt,
      detail: {
        after: response.gap.after,
        first_available_sequence: response.gap.first_available_sequence,
      },
    });
  }

  for (const sample of response.samples) {
    const key = `${state.instance}:${response.process.started_at_ms}:${response.process.pid}:${sample.sequence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({ recordType: 'sample', process: response.process, sample, observedAt });
  }
  if (seen.size > 720) seen = new Set([...seen].slice(-720));

  return {
    state: {
      instance: state.instance,
      process: response.process,
      cursor: response.next_after,
      seenKeys: [...seen],
    },
    records,
  };
}

export async function fetchLoopLagSamplePage(
  input: {
    readonly baseUrl: string;
    readonly tokenFile: string;
    readonly after?: number;
    readonly limit: number;
  },
  deps: {
    readonly fetch: typeof fetch;
    readonly readToken: (path: string) => CanonicalHealthToken | null;
  } = { fetch, readToken: readPrivateHealthTokenFileSync },
): Promise<FetchPageResult> {
  const baseUrl = validateLoopbackBaseUrl(input.baseUrl);
  let token: CanonicalHealthToken | null;
  try {
    token = deps.readToken(input.tokenFile);
  } catch {
    return { ok: false, kind: 'token_file_rejected', retryable: false };
  }
  if (token === null) return { ok: false, kind: 'authentication_failed', retryable: false };
  const endpoint = new URL('/health/event-loop-samples', baseUrl);
  if (input.after !== undefined) endpoint.searchParams.set('after', String(input.after));
  endpoint.searchParams.set('limit', String(input.limit));

  let result: Response;
  try {
    result = await deps.fetch(endpoint.href, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { ok: false, kind: 'request_failed', retryable: true };
  }
  if (result.status === 401) {
    return { ok: false, kind: 'authentication_failed', retryable: false, status: result.status };
  }
  if (result.status === 404) {
    return { ok: false, kind: 'endpoint_unsupported', retryable: false, status: result.status };
  }
  if (result.status >= 500) {
    return { ok: false, kind: 'http_5xx', retryable: true, status: result.status };
  }
  if (!result.ok) {
    return { ok: false, kind: 'request_failed', retryable: false, status: result.status };
  }

  let boundedBody: { readonly ok: true; readonly text: string } | { readonly ok: false };
  try {
    boundedBody = await readBoundedResponseBody(result, LOOP_LAG_SAMPLES_MAX_RESPONSE_BYTES);
  } catch {
    return { ok: false, kind: 'request_failed', retryable: true };
  }
  if (!boundedBody.ok) {
    return { ok: false, kind: 'endpoint_unsupported', retryable: false, status: result.status };
  }
  try {
    return { ok: true, response: decodeLoopLagSamplesResponse(JSON.parse(boundedBody.text)) };
  } catch {
    return { ok: false, kind: 'endpoint_unsupported', retryable: false, status: result.status };
  }
}

async function readBoundedResponseBody(
  response: Response,
  exclusiveMaxBytes: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  if (response.body === null) return { ok: true, text: '' };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes >= exclusiveMaxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The body is already rejected; cancellation failure cannot make it admissible.
      }
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks, totalBytes).toString('utf8') };
}
