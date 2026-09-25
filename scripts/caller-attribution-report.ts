// scripts/caller-attribution-report.ts
//
// #3421 step 1: a read-only report over the tool_calls caller-attribution
// columns added by migration 65. It answers the two questions step 2 needs:
//
//   1. How often does a caller outside the executing turn act while a turn is
//      executing? (turn_owned = 0 with actor_source = 'executing_turn'), with
//      the mid-turn total as the denominator.
//   2. Did any outside caller reach a sensitive tool, and was it admitted?
//      (outcome_code 'success' = admitted; failure_code 'authorization_denied'
//      = refused.)
//
// Retention deletes terminal tool_calls rows after 30 days, so the window is
// capped at 30 days. Rows written before migration 65 carry NULL attribution
// and are counted only in `toolCalls.total`.
//
// Usage:
//   bash scripts/run-with-pinned-node.sh scripts/caller-attribution-report.ts --db <bot.db> --out-dir <dir> [--window-days <1..30>]
//
// Writes <out-dir>/caller-attribution-<YYYY-MM-DD>.json and prints its path.
// The database is opened read-only; nothing is written to it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** tool_calls retention, in days. A longer window would silently undercount. */
export const CALLER_ATTRIBUTION_MAX_WINDOW_DAYS = 30;

export interface CallerAttributionArgs {
  dbPath: string;
  outDir: string;
  windowDays: number;
}

export interface MidTurnOutsideCallCount {
  day: string;
  clientName: string | null;
  count: number;
}

export interface MidTurnCallCount {
  day: string;
  count: number;
}

export interface SensitiveOutsideCallCount {
  toolName: string;
  outcomeCode: string;
  failureCode: string | null;
  count: number;
}

export interface CallerAttributionReport {
  report: 'caller-attribution';
  issue: 3421;
  generatedAt: string;
  windowDays: number;
  since: string;
  toolCalls: { total: number; attributed: number };
  midTurnOutsideCalls: MidTurnOutsideCallCount[];
  midTurnCalls: MidTurnCallCount[];
  sensitiveOutsideCalls: SensitiveOutsideCallCount[];
}

export function parseCallerAttributionArgs(argv: string[]): CallerAttributionArgs {
  let dbPath: string | undefined;
  let outDir: string | undefined;
  let windowDays = CALLER_ATTRIBUTION_MAX_WINDOW_DAYS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--db':
        dbPath = value;
        i += 1;
        break;
      case '--out-dir':
        outDir = value;
        i += 1;
        break;
      case '--window-days': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > CALLER_ATTRIBUTION_MAX_WINDOW_DAYS) {
          throw new Error(`--window-days must be an integer from 1 to ${CALLER_ATTRIBUTION_MAX_WINDOW_DAYS}`);
        }
        windowDays = parsed;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!dbPath) throw new Error('--db is required');
  if (!outDir) throw new Error('--out-dir is required');
  return { dbPath, outDir, windowDays };
}

/** SQLite `datetime('now')` text for an instant, so it compares with created_at. */
function toSqliteDateTime(instant: Date): string {
  return instant.toISOString().replace('T', ' ').slice(0, 19);
}

export function getMidTurnOutsideCallCounts(db: DatabaseSync, since: string): MidTurnOutsideCallCount[] {
  const rows = db.prepare(`
    SELECT date(created_at) AS day, caller_client_name AS clientName, COUNT(*) AS count
      FROM tool_calls
     WHERE created_at >= ?
       AND caller_turn_owned = 0
       AND caller_actor_source = 'executing_turn'
     GROUP BY day, clientName
     ORDER BY day, clientName
  `).all(since) as Array<{ day: string; clientName: string | null; count: number }>;
  return rows.map((row) => ({ day: row.day, clientName: row.clientName, count: Number(row.count) }));
}

export function getMidTurnCallCounts(db: DatabaseSync, since: string): MidTurnCallCount[] {
  const rows = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS count
      FROM tool_calls
     WHERE created_at >= ?
       AND caller_actor_source = 'executing_turn'
     GROUP BY day
     ORDER BY day
  `).all(since) as Array<{ day: string; count: number }>;
  return rows.map((row) => ({ day: row.day, count: Number(row.count) }));
}

export function getSensitiveOutsideCallCounts(db: DatabaseSync, since: string): SensitiveOutsideCallCount[] {
  const rows = db.prepare(`
    SELECT tool_name AS toolName, outcome_code AS outcomeCode, failure_code AS failureCode, COUNT(*) AS count
      FROM tool_calls
     WHERE created_at >= ?
       AND caller_turn_owned = 0
       AND tool_sensitive = 1
     GROUP BY toolName, outcomeCode, failureCode
     ORDER BY toolName, outcomeCode, failureCode
  `).all(since) as Array<{ toolName: string; outcomeCode: string; failureCode: string | null; count: number }>;
  return rows.map((row) => ({
    toolName: row.toolName,
    outcomeCode: row.outcomeCode,
    failureCode: row.failureCode,
    count: Number(row.count),
  }));
}

export function getToolCallAttributionCoverage(db: DatabaseSync, since: string): { total: number; attributed: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COUNT(caller_transport) AS attributed
      FROM tool_calls
     WHERE created_at >= ?
  `).get(since) as { total: number; attributed: number };
  return { total: Number(row.total), attributed: Number(row.attributed) };
}

export function buildCallerAttributionReport(
  db: DatabaseSync,
  options: { now: Date; windowDays: number },
): CallerAttributionReport {
  const since = toSqliteDateTime(new Date(options.now.getTime() - options.windowDays * 86_400_000));
  return {
    report: 'caller-attribution',
    issue: 3421,
    generatedAt: options.now.toISOString(),
    windowDays: options.windowDays,
    since,
    toolCalls: getToolCallAttributionCoverage(db, since),
    midTurnOutsideCalls: getMidTurnOutsideCallCounts(db, since),
    midTurnCalls: getMidTurnCallCounts(db, since),
    sensitiveOutsideCalls: getSensitiveOutsideCallCounts(db, since),
  };
}

/** Open the database read-only, build the report, and write the dated receipt. */
export function writeCallerAttributionReceipt(
  options: CallerAttributionArgs & { now?: Date },
): string {
  const now = options.now ?? new Date();
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  let report: CallerAttributionReport;
  try {
    report = buildCallerAttributionReport(db, { now, windowDays: options.windowDays });
  } finally {
    db.close();
  }
  mkdirSync(options.outDir, { recursive: true });
  const path = join(options.outDir, `caller-attribution-${now.toISOString().slice(0, 10)}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function main(): void {
  try {
    const args = parseCallerAttributionArgs(process.argv.slice(2));
    process.stdout.write(`${writeCallerAttributionReceipt(args)}\n`);
  } catch (err) {
    process.stderr.write(`caller-attribution-report: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
