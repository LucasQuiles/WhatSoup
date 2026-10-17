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
 * wedge.
 *
 * Age alone does not prove a row dead, though (#3703): turns that progress for
 * 16-22 minutes are routine. An open row older than the window is stale debt
 * only when persisted ownership evidence shows nothing in this process still
 * runs it; otherwise it blocks as unverified. See classifyOlderOpenInbounds.
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
  reason:
    | 'stop_safe'
    | 'live_turns_in_flight'
    | 'older_turns_unverified'
    | 'missing_database'
    | 'preflight_error';
  quickCheck: 'ok' | 'not_applicable';
  liveTurns: {
    /**
     * Open inbounds received inside the window, plus older ones under a live
     * recovery or deferred claim — stopping now loses these.
     */
    inFlight: number;
    /** Older open inbounds with evidence that nothing in this process runs them: stale debt, not blocking. */
    staleIgnored: number;
    /** Older open inbounds with no such evidence: not proven dead, so they block. */
    olderUnverified: number;
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

function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

/**
 * #3703: classify open inbounds older than the liveness window from persisted
 * ownership evidence only (the same rows the #3560 ownership snapshot reads).
 *
 *  liveClaim  — an unexpired recovery-job claim or deferred-obligation claim
 *               runs it in this process now: stopping loses it.
 *  stale      — evidence that nothing in this process runs it: it already has
 *               a terminal record, a turn of a later inbound of the same
 *               conversation has a terminal record (turns of one conversation
 *               run in order, so this one is no longer being worked), or a
 *               pending recovery job / deferred obligation owns it durably and
 *               resumes it after the restart.
 *  unverified — none of the above. Age alone is not proof of death: a live
 *               turn can stay open past the window, so these block.
 *
 * Evidence a database lacks (older schema) is simply absent; it never turns
 * an unverified row into a stale one.
 */
function classifyOlderOpenInbounds(
  db: DatabaseSync,
  modifier: string,
): { liveClaim: number; stale: number; unverified: number } {
  const liveClaim: string[] = [];
  const stale: string[] = [];
  if (hasTable(db, 'turn_recovery_jobs')) {
    liveClaim.push(`EXISTS (SELECT 1 FROM turn_recovery_jobs j WHERE j.source_inbound_seq = o.seq
      AND j.state = 'claimed' AND j.claim_expires_at > datetime('now'))`);
    stale.push(`EXISTS (SELECT 1 FROM turn_recovery_jobs j WHERE j.source_inbound_seq = o.seq
      AND j.state = 'pending')`);
  }
  if (hasTable(db, 'deferred_turn_obligations')) {
    liveClaim.push(`EXISTS (SELECT 1 FROM deferred_turn_obligations d WHERE d.inbound_seq = o.seq
      AND d.status = 'claimed' AND d.claim_expires_at > datetime('now'))`);
    stale.push(`EXISTS (SELECT 1 FROM deferred_turn_obligations d WHERE d.inbound_seq = o.seq
      AND d.status = 'pending')`);
  }
  if (hasTable(db, 'turn_terminal_records')) {
    stale.push('EXISTS (SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq = o.seq)');
    // A later inbound of the same conversation that a turn actually ran. A
    // bare later `complete` is not enough: paused-chat and policy rows close
    // at receipt while an earlier turn is still running.
    if (hasColumn(db, 'inbound_events', 'conversation_key')) {
      stale.push(`EXISTS (SELECT 1 FROM turn_terminal_records t WHERE t.conversation_key = o.conversation_key
        AND t.inbound_seq > o.seq AND t.attempt_kind <> 'admission_rejected')`);
    }
  }
  const anyOf = (predicates: string[]): string => (predicates.length === 0 ? '0' : predicates.join(' OR '));
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN live THEN 1 ELSE 0 END), 0) AS live_claim,
      COALESCE(SUM(CASE WHEN NOT live AND proven THEN 1 ELSE 0 END), 0) AS stale,
      COALESCE(SUM(CASE WHEN NOT live AND NOT proven THEN 1 ELSE 0 END), 0) AS unverified
    FROM (
      SELECT (${anyOf(liveClaim)}) AS live, (${anyOf(stale)}) AS proven
      FROM inbound_events o
      WHERE o.processing_status IN (${sqlList(OPEN_INBOUND_STATUSES)})
        AND o.received_at < datetime('now', ?)
    )
  `).get(modifier) as { live_claim: number; stale: number; unverified: number };
  return { liveClaim: Number(row.live_claim), stale: Number(row.stale), unverified: Number(row.unverified) };
}

/**
 * Is it safe to STOP this instance right now? Read-only, and never throws on a
 * missing database — a database that does not exist cannot hold live work.
 *
 * Blocks on OPEN inbounds received within the liveness window, and on older
 * open inbounds not proven dead (classifyOlderOpenInbounds). Older rows proven
 * dead are reported in `staleIgnored` and never block, so wedge recovery by
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
      liveTurns: { inFlight: 0, staleIgnored: 0, olderUnverified: 0, windowSeconds },
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
    const older = classifyOlderOpenInbounds(db, modifier);

    const liveTurns = {
      inFlight: Number(inFlight.count) + older.liveClaim,
      staleIgnored: older.stale,
      olderUnverified: older.unverified,
      windowSeconds,
    };
    const reason: StopSafetyVerdict['reason'] = liveTurns.inFlight > 0
      ? 'live_turns_in_flight'
      : liveTurns.olderUnverified > 0 ? 'older_turns_unverified' : 'stop_safe';
    const blocked = reason !== 'stop_safe';
    return {
      schemaVersion: 1,
      ok: !blocked,
      decision: blocked ? 'block' : 'allow',
      reason,
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
