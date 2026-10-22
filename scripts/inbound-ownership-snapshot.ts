/**
 * Read-only, content-free ownership snapshot for inbounds stuck in
 * `processing` (#3560).
 *
 *   node scripts/inbound-ownership-snapshot.ts --db <instance dbPath>
 *     [--min-age-minutes N]              default 15, the reply-guarantee observer's stale threshold
 *     [--queue-scope per_chat|global]    default per_chat; use global for shared/single instances
 *     [--provider-execution-json FILE]   a saved authenticated health body (or its bare
 *                                        runtime.agent.providerExecution object)
 *     [--provider-captured-at ISO]       capture time for a body without generated_at
 *
 * For every `processing` inbound older than N minutes it prints one JSON line
 * naming the owner (queued / deferred / executing / no_owner) from the
 * persisted durability rows, joined with the provider-execution gate state when
 * a health capture is supplied. The capture is a separate observation taken by
 * the operator, not simultaneous with the database read. Its time comes from,
 * in order: the body's own top-level `generated_at`; else --provider-captured-at;
 * else it is unknown, which counts as stale. The file's mtime is never used: a
 * copied, touched or re-saved file would make an old body look fresh. A
 * `generated_at` that is present but unparseable is also unknown (the flag
 * does not override a body's own claim). A capture outside the freshness
 * window (PROVIDER_CAPTURE_MAX_AGE_SECONDS) is reported `stale` and
 * attributes nothing.
 *
 * Safety posture:
 *   - opens the database read-only with `PRAGMA query_only = ON`, never through
 *     the migrating Database wrapper and never with `immutable=1`, so committed
 *     WAL frames stay visible (docs/reply-guarantee.md "Boundaries");
 *   - output is content-free: sequences, states, epochs, ages, turn ids and
 *     scope hashes only — never message text, chat/sender identifiers, message
 *     ids or paths.
 *
 * Exit codes: 0 every reported row has an owner; 3 at least one row is
 * unowned or queued behind an unowned head; 2 usage, input or open error.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CliArgError, takeNumber, takeValue } from './lib/cli-args.ts';
import { SQLITE_BUSY_TIMEOUT_MS } from '../src/lib/sqlite-constants.ts';
import {
  DEFAULT_OWNERSHIP_MIN_AGE_MINUTES,
  parseProviderExecutionObservation,
  readInboundOwnershipSnapshot,
  type InboundOwnershipQueueScope,
  type ProviderCaptureTimeSource,
  type ProviderExecutionObservation,
} from '../src/runtimes/agent/inbound-ownership-snapshot.ts';

const USAGE_EXIT = 2;
const UNOWNED_EXIT = 3;

/** An ISO-8601 instant with an explicit zone, as /health's generated_at is written. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseIsoInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

interface InboundOwnershipCliArgs {
  dbPath: string;
  minAgeMinutes: number;
  queueScope: InboundOwnershipQueueScope;
  providerExecutionPath?: string;
  providerCapturedAtMs?: number;
}

function parseCliArgs(argv: readonly string[]): InboundOwnershipCliArgs {
  let dbPath: string | undefined;
  let minAgeMinutes: number | undefined;
  let queueScope: InboundOwnershipQueueScope | undefined;
  let providerExecutionPath: string | undefined;
  let providerCapturedAtMs: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--db') {
      if (dbPath !== undefined) throw new CliArgError('Duplicate argument: --db');
      const taken = takeValue(argv, index);
      dbPath = taken.value;
      index = taken.index;
    } else if (arg === '--min-age-minutes') {
      if (minAgeMinutes !== undefined) throw new CliArgError('Duplicate argument: --min-age-minutes');
      const taken = takeNumber(argv, index);
      if (taken.value < 0) throw new CliArgError('--min-age-minutes must be zero or greater');
      minAgeMinutes = taken.value;
      index = taken.index;
    } else if (arg === '--queue-scope') {
      if (queueScope !== undefined) throw new CliArgError('Duplicate argument: --queue-scope');
      const taken = takeValue(argv, index);
      if (taken.value !== 'per_chat' && taken.value !== 'global') {
        throw new CliArgError('--queue-scope must be per_chat or global');
      }
      queueScope = taken.value;
      index = taken.index;
    } else if (arg === '--provider-execution-json') {
      if (providerExecutionPath !== undefined) {
        throw new CliArgError('Duplicate argument: --provider-execution-json');
      }
      const taken = takeValue(argv, index);
      providerExecutionPath = taken.value;
      index = taken.index;
    } else if (arg === '--provider-captured-at') {
      if (providerCapturedAtMs !== undefined) {
        throw new CliArgError('Duplicate argument: --provider-captured-at');
      }
      const taken = takeValue(argv, index);
      const parsed = parseIsoInstant(taken.value);
      if (parsed === null) {
        throw new CliArgError('--provider-captured-at must be an ISO-8601 instant with a zone');
      }
      providerCapturedAtMs = parsed;
      index = taken.index;
    } else {
      throw new CliArgError(`Unknown argument: ${arg}`);
    }
  }
  if (dbPath === undefined) throw new CliArgError('--db is required');
  if (providerCapturedAtMs !== undefined && providerExecutionPath === undefined) {
    throw new CliArgError('--provider-captured-at requires --provider-execution-json');
  }
  return {
    dbPath,
    minAgeMinutes: minAgeMinutes ?? DEFAULT_OWNERSHIP_MIN_AGE_MINUTES,
    queueScope: queueScope ?? 'per_chat',
    ...(providerExecutionPath === undefined ? {} : { providerExecutionPath }),
    ...(providerCapturedAtMs === undefined ? {} : { providerCapturedAtMs }),
  };
}

function assertExistingRegularDatabase(dbPath: string): string {
  const absolute = resolve(dbPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new Error('database_missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('database_not_regular_file');
  return absolute;
}

interface ProviderCapture {
  observation: ProviderExecutionObservation;
  capturedAtMs: number | null;
  source: ProviderCaptureTimeSource;
}

/**
 * Accepts either the bare providerExecution object or a saved health body,
 * where the runbook documents it at `runtime.agent.providerExecution`. The
 * body's own top-level `generated_at` dates it; the operator flag only dates a
 * body that carries none.
 */
function loadProviderExecution(path: string, flagCapturedAtMs: number | undefined): ProviderCapture {
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('provider_execution_unreadable');
  }
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  const nested = (record as { runtime?: { agent?: { providerExecution?: unknown } } } | null)
    ?.runtime?.agent?.providerExecution;
  const observation = parseProviderExecutionObservation(nested ?? body);
  if (!observation) throw new Error('provider_execution_invalid');

  if (record !== null && Object.hasOwn(record, 'generated_at')) {
    // The body's own claim wins, even when unparseable (then unknown, so stale).
    const payloadMs = parseIsoInstant(record['generated_at']);
    return payloadMs === null
      ? { observation, capturedAtMs: null, source: 'unknown' }
      : { observation, capturedAtMs: payloadMs, source: 'payload_generated_at' };
  }
  if (flagCapturedAtMs !== undefined) {
    return { observation, capturedAtMs: flagCapturedAtMs, source: 'operator_flag' };
  }
  return { observation, capturedAtMs: null, source: 'unknown' };
}

function refusal(reason: string): string {
  return `${JSON.stringify({ schemaVersion: 1, ok: false, reason })}\n`;
}

export function runInboundOwnershipSnapshotCli(
  argv: readonly string[],
  write: (chunk: string) => void = (chunk) => { process.stdout.write(chunk); },
  nowMs?: number,
): number {
  let args: InboundOwnershipCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof CliArgError)) throw error;
    write(refusal('usage_error'));
    return USAGE_EXIT;
  }

  let providerExecution: ProviderExecutionObservation | null = null;
  let providerExecutionCapturedAtMs: number | null = null;
  let providerExecutionCaptureTimeSource: ProviderCaptureTimeSource | undefined;
  let absolute: string;
  try {
    if (args.providerExecutionPath !== undefined) {
      const capture = loadProviderExecution(args.providerExecutionPath, args.providerCapturedAtMs);
      providerExecution = capture.observation;
      providerExecutionCapturedAtMs = capture.capturedAtMs;
      providerExecutionCaptureTimeSource = capture.source;
    }
    absolute = assertExistingRegularDatabase(args.dbPath);
  } catch (error) {
    write(refusal(error instanceof Error ? error.message : 'input_error'));
    return USAGE_EXIT;
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(absolute, {
      readOnly: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: false,
    });
  } catch {
    write(refusal('database_open_failed'));
    return USAGE_EXIT;
  }
  try {
    db.exec('PRAGMA query_only = ON');
    const snapshot = readInboundOwnershipSnapshot(db, {
      minAgeMinutes: args.minAgeMinutes,
      queueScope: args.queueScope,
      providerExecution,
      providerExecutionCapturedAtMs,
      ...(providerExecutionCaptureTimeSource === undefined ? {} : { providerExecutionCaptureTimeSource }),
      ...(nowMs === undefined ? {} : { nowMs }),
    });
    write(`${JSON.stringify(snapshot)}\n`);
    return snapshot.healthy ? 0 : UNOWNED_EXIT;
  } catch {
    write(refusal('snapshot_failed'));
    return USAGE_EXIT;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runInboundOwnershipSnapshotCli(process.argv.slice(2));
}
