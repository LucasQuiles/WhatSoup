import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SQLITE_BUSY_TIMEOUT_MS } from '../src/lib/sqlite-constants.ts';

const TERMINAL_OUTBOUND_STATUSES = [
  'echoed',
  'failed_permanent',
  'quarantined',
  'cancelled',
] as const;
const KNOWN_OUTBOUND_STATUSES = [
  'pending',
  'sending',
  'submitted',
  'echoed',
  'maybe_sent',
  'failed_permanent',
  'quarantined',
  'cancelled',
] as const;
const KNOWN_REPLAY_POLICIES = ['safe', 'unsafe', 'read_only'] as const;
const REPLAY_SAFE_POLICIES = ['safe', 'read_only'] as const;

/**
 * Inbound dispositions that still owe a turn. Mirrors the open set the
 * reply-guarantee observer uses (deploy/scripts/reply-guarantee-observer.py).
 */
const OPEN_INBOUND_STATUSES = ['pending', 'processing', 'turn_done'] as const;

/**
 * How recently an open inbound must have arrived to count as LIVE work rather
 * than stale debt. Same 15 minutes the reply-guarantee observer uses to call an
 * open inbound stale (its DEFAULT_STALE_SECONDS), read from the other side.
 *
 * The recency scoping is the whole point: q holds open inbounds from weeks ago,
 * and a bare "any open inbound blocks the stop" rule would make a wedged
 * instance permanently unrestartable — including the restart that clears the
 * wedge. Stale rows are counted and reported, never blocking.
 */
export const LIVE_TURN_WINDOW_SECONDS = 15 * 60;

export interface RestartSafetyVerdict {
  schemaVersion: 1;
  ok: boolean;
  decision: 'allow' | 'block';
  reason:
    | 'restart_safe'
    | 'restart_safe_with_unsafe_debt'
    | 'safe_nonterminal_outbound'
    | 'unknown_outbound_state'
    | 'initial_database_create'
    | 'missing_database'
    | 'preflight_error';
  quickCheck: 'ok' | 'not_applicable';
  outbound: {
    maxId: number;
    safeNonterminal: number;
    unsafeNonterminal: number;
    unknownStatus: number;
    unknownReplayPolicy: number;
  };
  inbound: {
    processing: number;
    recent: number;
  };
}

/**
 * Verdict for the PRE-STOP question, which the start gate above cannot answer.
 *
 * `inspectRestartSafety` runs from the launch wrapper at ExecStart — on
 * 2026-08-29 it published its verdict three seconds AFTER the stop that had
 * already finalized two owner DMs `failed` with no replay. Refusing there would
 * only refuse to start. This verdict is for whoever issues the stop.
 */
export interface StopSafetyVerdict {
  schemaVersion: 1;
  ok: boolean;
  decision: 'allow' | 'block';
  reason: 'stop_safe' | 'live_turns_in_flight' | 'missing_database' | 'preflight_error';
  quickCheck: 'ok' | 'not_applicable';
  liveTurns: {
    /** Open inbounds received inside the window — stopping now loses these. */
    inFlight: number;
    /** Open inbounds older than the window: stale debt, deliberately not blocking. */
    staleIgnored: number;
    windowSeconds: number;
  };
}

export interface StopSafetyOptions {
  /** Override the liveness window; defaults to {@link LIVE_TURN_WINDOW_SECONDS}. */
  liveWindowSeconds?: number;
}

interface CountRow {
  count: number;
}

interface OutboundInventoryRow {
  max_id: number | null;
  safe_nonterminal: number;
  unsafe_nonterminal: number;
  unknown_status: number;
  unknown_replay_policy: number;
}

function assertExistingRegularDatabase(dbPath: string): string {
  const absolute = resolve(dbPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new Error('Database path must be an existing regular file');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Database path must be an existing regular file');
  }
  return absolute;
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

function assertRequiredSchema(db: DatabaseSync): void {
  for (const table of ['outbound_ops', 'inbound_events']) {
    const row = db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(table);
    if (!row) throw new Error(`Restart safety requires table ${table}`);
  }

  const outboundColumns = new Set(
    (db.prepare('PRAGMA table_info(outbound_ops)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const column of ['id', 'status', 'replay_policy', 'is_terminal', 'created_at']) {
    if (!outboundColumns.has(column)) {
      throw new Error(`Restart safety requires outbound_ops.${column}`);
    }
  }

  const inboundColumns = new Set(
    (db.prepare('PRAGMA table_info(inbound_events)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const column of ['processing_status', 'received_at']) {
    if (!inboundColumns.has(column)) {
      throw new Error(`Restart safety requires inbound_events.${column}`);
    }
  }
}

function assertQuickCheck(db: DatabaseSync): 'ok' {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
  if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== 'ok') {
    throw new Error('Database quick_check failed');
  }
  return 'ok';
}

export function inspectRestartSafety(dbPath: string): RestartSafetyVerdict {
  const absolute = assertExistingRegularDatabase(dbPath);
  const db = new DatabaseSync(absolute, {
    readOnly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
    enableForeignKeyConstraints: false,
  });
  try {
    db.exec('PRAGMA query_only = ON');
    const quickCheck = assertQuickCheck(db);
    assertRequiredSchema(db);

    const inventory = db.prepare(`
      SELECT
        MAX(id) AS max_id,
        SUM(CASE
          WHEN replay_policy IN (${sqlList(REPLAY_SAFE_POLICIES)})
           AND status NOT IN (${sqlList(TERMINAL_OUTBOUND_STATUSES)})
          THEN 1 ELSE 0 END) AS safe_nonterminal,
        SUM(CASE
          WHEN replay_policy = 'unsafe'
           AND status NOT IN (${sqlList(TERMINAL_OUTBOUND_STATUSES)})
          THEN 1 ELSE 0 END) AS unsafe_nonterminal,
        SUM(CASE
          WHEN status NOT IN (${sqlList(KNOWN_OUTBOUND_STATUSES)})
          THEN 1 ELSE 0 END) AS unknown_status,
        SUM(CASE
          WHEN replay_policy NOT IN (${sqlList(KNOWN_REPLAY_POLICIES)})
          THEN 1 ELSE 0 END) AS unknown_replay_policy
      FROM outbound_ops
    `).get() as unknown as OutboundInventoryRow;

    const processing = db.prepare(`
      SELECT COUNT(*) AS count
      FROM inbound_events
      WHERE processing_status = 'processing'
    `).get() as unknown as CountRow;
    const recent = db.prepare(`
      SELECT COUNT(*) AS count
      FROM inbound_events
      WHERE received_at >= datetime('now', '-5 minutes')
    `).get() as unknown as CountRow;

    const outbound = {
      maxId: Number(inventory.max_id ?? 0),
      safeNonterminal: Number(inventory.safe_nonterminal ?? 0),
      unsafeNonterminal: Number(inventory.unsafe_nonterminal ?? 0),
      unknownStatus: Number(inventory.unknown_status ?? 0),
      unknownReplayPolicy: Number(inventory.unknown_replay_policy ?? 0),
    };
    const unknown = outbound.unknownStatus > 0 || outbound.unknownReplayPolicy > 0;
    const blocked = unknown || outbound.safeNonterminal > 0;
    const reason: RestartSafetyVerdict['reason'] = unknown
      ? 'unknown_outbound_state'
      : outbound.safeNonterminal > 0
        ? 'safe_nonterminal_outbound'
        : outbound.unsafeNonterminal > 0
          ? 'restart_safe_with_unsafe_debt'
          : 'restart_safe';

    return {
      schemaVersion: 1,
      ok: !blocked,
      decision: blocked ? 'block' : 'allow',
      reason,
      quickCheck,
      outbound,
      inbound: {
        processing: Number(processing.count),
        recent: Number(recent.count),
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Is it safe to STOP this instance right now? Read-only, and never throws on a
 * missing database — a database that does not exist cannot hold live work.
 *
 * Blocks only on OPEN inbounds received within the liveness window. Stale open
 * rows are reported in `staleIgnored` and never block, so wedge recovery by
 * restart stays possible.
 */
export function inspectStopSafety(
  dbPath: string,
  options: StopSafetyOptions = {},
): StopSafetyVerdict {
  const windowSeconds = options.liveWindowSeconds ?? LIVE_TURN_WINDOW_SECONDS;
  if (missingDatabase(dbPath)) {
    return {
      schemaVersion: 1,
      ok: true,
      decision: 'allow',
      reason: 'missing_database',
      quickCheck: 'not_applicable',
      liveTurns: { inFlight: 0, staleIgnored: 0, windowSeconds },
    };
  }

  const absolute = assertExistingRegularDatabase(dbPath);
  const db = new DatabaseSync(absolute, {
    readOnly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
    enableForeignKeyConstraints: false,
  });
  try {
    db.exec('PRAGMA query_only = ON');
    const quickCheck = assertQuickCheck(db);
    assertRequiredSchema(db);

    const modifier = `-${windowSeconds} seconds`;
    const openStatuses = sqlList(OPEN_INBOUND_STATUSES);
    const inFlight = db.prepare(`
      SELECT COUNT(*) AS count
      FROM inbound_events
      WHERE processing_status IN (${openStatuses})
        AND received_at >= datetime('now', ?)
    `).get(modifier) as unknown as CountRow;
    const stale = db.prepare(`
      SELECT COUNT(*) AS count
      FROM inbound_events
      WHERE processing_status IN (${openStatuses})
        AND received_at < datetime('now', ?)
    `).get(modifier) as unknown as CountRow;

    const liveTurns = {
      inFlight: Number(inFlight.count),
      staleIgnored: Number(stale.count),
      windowSeconds,
    };
    const blocked = liveTurns.inFlight > 0;
    return {
      schemaVersion: 1,
      ok: !blocked,
      decision: blocked ? 'block' : 'allow',
      reason: blocked ? 'live_turns_in_flight' : 'stop_safe',
      quickCheck,
      liveTurns,
    };
  } finally {
    db.close();
  }
}

type PreflightMode = 'start' | 'stop';

interface RestartSafetyCliArgs {
  dbPath: string;
  instance?: string;
  initialMarker?: string;
  mode: PreflightMode;
  json: true;
}

function parseCliArgs(argv: string[]): RestartSafetyCliArgs {
  let dbPath: string | undefined;
  let instance: string | undefined;
  let initialMarker: string | undefined;
  let mode: PreflightMode | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      if (mode !== undefined) throw new Error('Duplicate argument: --mode');
      const value = argv[index + 1];
      if (value !== 'start' && value !== 'stop') {
        throw new Error('--mode must be start or stop');
      }
      mode = value;
      index += 1;
    } else if (arg === '--db') {
      if (dbPath !== undefined) throw new Error('Duplicate argument: --db');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--db is required');
      dbPath = value;
      index += 1;
    } else if (arg === '--instance' || arg === '--initial-marker') {
      const current = arg === '--instance' ? instance : initialMarker;
      if (current !== undefined) throw new Error(`Duplicate argument: ${arg}`);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} is required`);
      if (arg === '--instance') instance = value;
      else initialMarker = value;
      index += 1;
    } else if (arg === '--json') {
      if (json) throw new Error('Duplicate argument: --json');
      json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!dbPath) throw new Error('--db is required');
  if (!json) throw new Error('--json is required');
  if ((instance === undefined) !== (initialMarker === undefined)) {
    throw new Error('--instance and --initial-marker must be provided together');
  }
  return {
    dbPath,
    ...(instance === undefined ? {} : { instance }),
    ...(initialMarker === undefined ? {} : { initialMarker }),
    mode: mode ?? 'start',
    json: true,
  };
}

function missingDatabase(dbPath: string): boolean {
  try {
    lstatSync(resolve(dbPath));
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

function initialMarkerMatches(markerPath: string, instance: string): boolean {
  try {
    const stat = lstatSync(resolve(markerPath));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    return readFileSync(markerPath, 'utf8').trim() === instance;
  } catch {
    return false;
  }
}

function noDatabaseVerdict(approved: boolean): RestartSafetyVerdict {
  return {
    schemaVersion: 1,
    ok: approved,
    decision: approved ? 'allow' : 'block',
    reason: approved ? 'initial_database_create' : 'missing_database',
    quickCheck: 'not_applicable',
    outbound: {
      maxId: 0,
      safeNonterminal: 0,
      unsafeNonterminal: 0,
      unknownStatus: 0,
      unknownReplayPolicy: 0,
    },
    inbound: { processing: 0, recent: 0 },
  };
}

export function runRestartSafetyPreflightCli(
  argv: string[],
  write: (chunk: string) => void = (chunk) => { process.stdout.write(chunk); },
): number {
  const args = parseCliArgs(argv);
  if (args.mode === 'stop') {
    const stopVerdict = inspectStopSafety(args.dbPath);
    write(`${JSON.stringify(stopVerdict)}\n`);
    return stopVerdict.ok ? 0 : 3;
  }
  const verdict = missingDatabase(args.dbPath)
    ? noDatabaseVerdict(
        args.instance !== undefined
        && args.initialMarker !== undefined
        && initialMarkerMatches(args.initialMarker, args.instance),
      )
    : inspectRestartSafety(args.dbPath);
  write(`${JSON.stringify(verdict)}\n`);
  return verdict.ok ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runRestartSafetyPreflightCli(process.argv.slice(2));
  } catch {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      decision: 'block',
      reason: 'preflight_error',
    })}\n`);
    process.exitCode = 3;
  }
}
