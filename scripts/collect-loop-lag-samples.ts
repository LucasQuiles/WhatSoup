import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readPrivateHealthTokenFileSync } from '../src/fleet/health-token-file.ts';
import { systemClock } from '../src/lib/clock.ts';
import {
  appendPrivateJsonLineSync,
  readPrivateFileSync,
  writeAtomicPrivateFileSync,
} from '../src/lib/private-fs.ts';
import {
  advanceCollectorState,
  fetchLoopLagSamplePage,
  initialCollectorState,
  validateLoopbackBaseUrl,
  type CollectorState,
} from './lib/loop-lag-collector.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_LIMIT = 160;
const COLLECTOR_RECORD_TYPES = new Set(['run_started', 'sample', 'gap', 'poll_error', 'run_completed']);
const EFFECTS = Object.freeze({
  network_effect: 'read_only_loopback',
  filesystem_effect: 'append_private_artifact',
  destructive: false,
  idempotent_samples: true,
  supports_dry_run: false,
});

type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type Writer = (text: string) => void;

interface RunDeps {
  stdout?: Writer;
  stderr?: Writer;
  fetch?: typeof fetch;
  nowIso?: () => string;
  nowMs?: () => number;
  randomUuid?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

interface CollectConfig {
  instance: string;
  baseUrl: string;
  tokenFile: string;
  output: string;
  once: boolean;
  intervalMs?: number;
  durationMs?: number;
  limit: number;
  maxOutputBytes: number;
}

interface CollectorRecordBase {
  schema_version: 1;
  record_type: string;
  run_id: string;
  observed_at: string;
  instance: string;
}

export function appendBoundedCollectorRecord(
  filePath: string,
  record: Record<string, unknown>,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): void {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new RangeError('max output bytes must be a positive safe integer');
  }
  assertCollectorRecord(record);
  const line = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > maxOutputBytes) throw new Error('collector record exceeds output limit');

  let existingBytes = 0;
  try {
    existingBytes = lstatSync(filePath).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existingBytes + lineBytes <= maxOutputBytes) {
    appendPrivateJsonLineSync(filePath, record);
    return;
  }

  const existing = readPrivateFileSync(filePath, {
    label: 'loop-lag evidence',
    maxBytes: maxOutputBytes,
  });
  if (existing === null || !existing.endsWith('\n')) {
    throw new Error('loop-lag evidence tail is malformed');
  }
  const rows = existing.slice(0, -1).split('\n').map(parseCollectorLine);
  const selected: string[] = [];
  let selectedBytes = lineBytes;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = `${JSON.stringify(rows[index])}\n`;
    const candidateBytes = Buffer.byteLength(candidate);
    if (selectedBytes + candidateBytes > maxOutputBytes) break;
    selected.unshift(candidate);
    selectedBytes += candidateBytes;
  }
  writeAtomicPrivateFileSync(
    filePath,
    `${selected.join('')}${line}`,
    'loop-lag evidence',
    'required',
  );
}

export async function run(argv = process.argv.slice(2), deps: RunDeps = {}): Promise<ExitCode> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  if (argv[0] === 'schema' && (argv.length === 1 || (argv.length === 3 && argv[1] === '--format' && argv[2] === 'json'))) {
    stdout(`${JSON.stringify({
      ok: true,
      command: 'schema',
      effects: EFFECTS,
      commands: {
        collect: {
          required: ['--instance', '--base-url', '--token-file', '--output', '--format=json'],
          modes: ['--once', '--interval-ms + --duration-ms'],
          interval_ms: { minimum: 1_000, maximum: 300_000, gap_free_ceiling: 150_000 },
          limit: { minimum: 1, maximum: 160, default: 160 },
          max_output_bytes: { minimum: 1, default: DEFAULT_MAX_OUTPUT_BYTES },
        },
      },
      record_schema_version: 1,
      endpoint_schema_version: 'health.event-loop-samples.v1',
      exit_codes: { complete: 0, partial: 1, invalid: 2, authentication_failed: 3, endpoint_unsupported: 4, no_successful_poll: 5, output_failed: 6 },
    })}\n`);
    return 0;
  }

  const config = parseCollectArgs(argv);
  if (config === null) {
    stderr('collect-loop-lag-samples: invalid invocation\n');
    return 2;
  }
  try {
    validateLoopbackBaseUrl(config.baseUrl);
  } catch {
    stderr('collect-loop-lag-samples: invalid loopback base URL\n');
    return 2;
  }

  const nowIso = deps.nowIso ?? (() => systemClock.nowIso());
  const nowMs = deps.nowMs ?? (() => systemClock.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const runId = (deps.randomUuid ?? randomUUID)();
  let state: CollectorState;
  try {
    state = recoverCollectorState(config.output, config.instance, config.maxOutputBytes);
    appendBoundedCollectorRecord(config.output, baseRecord('run_started', runId, nowIso(), config.instance, {
      base_url: validateLoopbackBaseUrl(config.baseUrl).origin,
      mode: config.once ? 'once' : 'interval',
      interval_ms: config.intervalMs ?? null,
      duration_ms: config.durationMs ?? null,
      limit: config.limit,
      max_output_bytes: config.maxOutputBytes,
      effects: EFFECTS,
    }), config.maxOutputBytes);
  } catch {
    stderr('collect-loop-lag-samples: output artifact unavailable\n');
    return 6;
  }

  let successfulPolls = 0;
  let failedPolls = 0;
  let sampleCount = 0;
  let gapCount = 0;
  let partial = false;
  let terminal: ExitCode | null = null;
  const startedMs = nowMs();
  let nextPollMs = startedMs;

  do {
    const observedAt = nowIso();
    if (nowMs() > nextPollMs && successfulPolls + failedPolls > 0) {
      partial = true;
      gapCount += 1;
      try {
        appendBoundedCollectorRecord(config.output, baseRecord('gap', runId, observedAt, config.instance, {
          kind: 'poll_interval_missed',
        }), config.maxOutputBytes);
      } catch {
        terminal = 6;
        break;
      }
    }
    let pollHadSuccess = false;
    let pageAttempts = 0;
    while (pageAttempts < 5) {
      pageAttempts += 1;
      const result = await fetchLoopLagSamplePage({
        baseUrl: config.baseUrl,
        tokenFile: config.tokenFile,
        after: state.cursor ?? 0,
        limit: config.limit,
      }, {
        fetch: deps.fetch ?? fetch,
        readToken: readPrivateHealthTokenFileSync,
      });

      if (!result.ok) {
        failedPolls += 1;
        partial = true;
        try {
          appendBoundedCollectorRecord(config.output, baseRecord('poll_error', runId, observedAt, config.instance, {
            kind: result.kind,
            status: result.status ?? null,
            retryable: result.retryable,
            count: failedPolls,
          }), config.maxOutputBytes);
        } catch {
          terminal = 6;
          break;
        }
        if (result.kind === 'authentication_failed') terminal = 3;
        else if (result.kind === 'endpoint_unsupported') terminal = 4;
        else if (config.once && !pollHadSuccess) terminal = 5;
        break;
      }

      pollHadSuccess = true;
      const transition = advanceCollectorState(state, result.response, observedAt);
      state = transition.state;
      const processChanged = transition.records.some(
        (record) => record.recordType === 'gap' && record.kind === 'process_changed',
      );
      try {
        for (const record of transition.records) {
          if (record.recordType === 'sample') sampleCount += 1;
          else {
            gapCount += 1;
            partial = true;
          }
          appendBoundedCollectorRecord(config.output, baseRecord(
            record.recordType,
            runId,
            record.observedAt,
            config.instance,
            record.recordType === 'sample'
              ? { process: record.process, sample: record.sample }
              : { kind: record.kind, detail: record.detail },
          ), config.maxOutputBytes);
        }
      } catch {
        terminal = 6;
        break;
      }
      if (!processChanged && !result.response.truncated) break;
    }
    if (pollHadSuccess) successfulPolls += 1;
    if (pageAttempts === 5 && terminal === null) {
      partial = true;
      failedPolls += 1;
      try {
        appendBoundedCollectorRecord(config.output, baseRecord('poll_error', runId, observedAt, config.instance, {
          kind: 'pagination_exhausted', status: null, retryable: false, count: failedPolls,
        }), config.maxOutputBytes);
      } catch {
        terminal = 6;
      }
      if (config.once) terminal = 4;
    }

    if (config.once || terminal !== null) break;
    nextPollMs += config.intervalMs!;
    const remaining = startedMs + config.durationMs! - nowMs();
    if (remaining <= 0) break;
    await sleep(Math.min(Math.max(0, nextPollMs - nowMs()), remaining));
  } while (nowMs() < startedMs + config.durationMs!);

  if (terminal === 6) {
    stderr('collect-loop-lag-samples: output artifact write failed\n');
    return 6;
  }
  const exitCode: ExitCode = terminal
    ?? (successfulPolls === 0 ? 5 : partial ? 1 : 0);
  const outcome = exitCode === 0 ? 'complete'
    : exitCode === 1 ? 'partial'
      : exitCode === 3 ? 'authentication_failed'
        : exitCode === 4 ? 'endpoint_unsupported'
          : 'no_successful_poll';
  const summary = {
    ok: exitCode === 0,
    outcome,
    successful_polls: successfulPolls,
    failed_polls: failedPolls,
    sample_count: sampleCount,
    gap_count: gapCount,
    next_after: state.cursor ?? 0,
  };
  try {
    appendBoundedCollectorRecord(config.output, baseRecord('run_completed', runId, nowIso(), config.instance, summary), config.maxOutputBytes);
  } catch {
    stderr('collect-loop-lag-samples: output artifact finalization failed\n');
    return 6;
  }
  stdout(`${JSON.stringify(summary)}\n`);
  return exitCode;
}

function parseCollectArgs(argv: readonly string[]): CollectConfig | null {
  if (argv[0] !== 'collect') return null;
  const values = new Map<string, string>();
  let once = false;
  const valueFlags = new Set(['--instance', '--base-url', '--token-file', '--output', '--interval-ms', '--duration-ms', '--limit', '--max-output-bytes', '--format']);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--once') {
      if (once) return null;
      once = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag) || index + 1 >= argv.length) return null;
    values.set(flag, argv[index + 1]!);
    index += 1;
  }
  const instance = values.get('--instance');
  const baseUrl = values.get('--base-url');
  const tokenFile = values.get('--token-file');
  const output = values.get('--output');
  if (!instance || !baseUrl || !tokenFile || !output || values.get('--format') !== 'json') return null;
  if (!path.isAbsolute(tokenFile) || !path.isAbsolute(output) || tokenFile === output) return null;
  const intervalMs = parseInteger(values.get('--interval-ms'));
  const durationMs = parseInteger(values.get('--duration-ms'));
  if (once ? intervalMs !== undefined || durationMs !== undefined : intervalMs === undefined || durationMs === undefined) return null;
  if (!once && (intervalMs! < 1_000 || intervalMs! > 300_000 || durationMs! < 1)) return null;
  const limit = parseInteger(values.get('--limit')) ?? DEFAULT_LIMIT;
  const maxOutputBytes = parseInteger(values.get('--max-output-bytes')) ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (limit < 1 || limit > 160 || maxOutputBytes < 1) return null;
  return { instance, baseUrl, tokenFile, output, once, intervalMs, durationMs, limit, maxOutputBytes };
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function baseRecord(
  recordType: string,
  runId: string,
  observedAt: string,
  instance: string,
  payload: Record<string, unknown>,
): CollectorRecordBase & Record<string, unknown> {
  return { schema_version: 1, record_type: recordType, run_id: runId, observed_at: observedAt, instance, ...payload };
}

function assertCollectorRecord(value: unknown): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as Record<string, unknown>).schema_version !== 1
    || typeof (value as Record<string, unknown>).record_type !== 'string'
    || !COLLECTOR_RECORD_TYPES.has((value as Record<string, unknown>).record_type as string)
    || typeof (value as Record<string, unknown>).run_id !== 'string'
    || typeof (value as Record<string, unknown>).observed_at !== 'string'
    || typeof (value as Record<string, unknown>).instance !== 'string'
  ) throw new Error('invalid collector record');
}

function parseCollectorLine(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('loop-lag evidence tail is malformed');
  }
  assertCollectorRecord(parsed);
  return parsed;
}

function recoverCollectorState(filePath: string, instance: string, maxBytes: number): CollectorState {
  const contents = readPrivateFileSync(filePath, { label: 'loop-lag evidence', maxBytes });
  if (contents === null || contents === '') return initialCollectorState(instance);
  if (!contents.endsWith('\n')) throw new Error('loop-lag evidence tail is malformed');
  const rows = contents.slice(0, -1).split('\n').map(parseCollectorLine);
  let state = initialCollectorState(instance);
  for (const row of rows) {
    if (row.instance !== instance || row.record_type !== 'sample') continue;
    const process = row.process;
    const sample = row.sample;
    if (typeof process !== 'object' || process === null || typeof sample !== 'object' || sample === null) {
      throw new Error('loop-lag evidence tail is malformed');
    }
    const p = process as { pid?: unknown; started_at_ms?: unknown; commit?: unknown };
    const s = sample as { sequence?: unknown };
    if (!Number.isSafeInteger(p.pid) || !Number.isFinite(p.started_at_ms) || !Number.isSafeInteger(s.sequence)) {
      throw new Error('loop-lag evidence tail is malformed');
    }
    state = {
      instance,
      process: { pid: p.pid as number, started_at_ms: p.started_at_ms as number, commit: typeof p.commit === 'string' ? p.commit : null },
      cursor: s.sequence as number,
      seenKeys: [],
    };
  }
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await run();
}
