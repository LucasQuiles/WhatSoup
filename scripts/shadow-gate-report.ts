/**
 * Shadow-gate measurement report (read-only).
 *
 *   node scripts/shadow-gate-report.ts --db <snapshot.db> --events <dir> --instance <id>
 *     --since <unix-seconds> --until <unix-seconds> [--lineage <databaseLineage>] [--json]
 *
 * `--db` must be a self-contained snapshot (SQLite backup API), never the live
 * database; `--events` is a copy of the shadow-gate segment directory.
 * Coverage prints first. Exit 0 on a completed report (even an inconclusive
 * one), 64 on a usage error, 65 on evidence that cannot be measured honestly
 * (unreadable input, an invalid interior line, a bound exceeded, an ambiguous
 * lineage).
 */

import { pathToFileURL } from 'node:url';
import { CliArgError, parseClosedOptions } from './lib/cli-args.ts';
import {
  buildShadowGateReport,
  readInboundWindow,
  readSegments,
  renderShadowGateReportText,
  ShadowGateEvidenceError,
} from './lib/shadow-gate-report.ts';
import { printErr } from '../src/lib/cli-print.ts';

const EX_OK = 0;
const EX_USAGE = 64;
const EX_DATAERR = 65;
const ID_CHARSET = /^[A-Za-z0-9._:-]{1,128}$/;
const UNIX_SECONDS = /^\d{1,12}$/;

export const USAGE = 'usage: shadow-gate-report --db <snapshot.db> --events <dir> --instance <id> '
  + '--since <unix-seconds> --until <unix-seconds> [--lineage <databaseLineage>] [--json]';

export interface ReportArgs {
  db: string;
  events: string;
  instance: string;
  since: number;
  until: number;
  lineage: string | null;
  json: boolean;
  help: boolean;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) throw new CliArgError(`${flag} is required`);
  return value;
}

function seconds(values: ReadonlyMap<string, string>, flag: string): number {
  const value = required(values, flag);
  if (!UNIX_SECONDS.test(value)) throw new CliArgError(`${flag} must be unix seconds (a non-negative integer)`);
  return Number(value);
}

export function parseArgs(argv: readonly string[]): ReportArgs {
  const parsed = parseClosedOptions(argv, {
    booleanOptions: ['--json', '--help'],
    valueOptions: ['--db', '--events', '--instance', '--since', '--until', '--lineage'],
  });
  if (parsed.error) throw new CliArgError(parsed.error);
  const help = parsed.flags.has('--help');
  if (help) {
    return { db: '', events: '', instance: '', since: 0, until: 0, lineage: null, json: false, help };
  }
  const instance = required(parsed.values, '--instance');
  if (!ID_CHARSET.test(instance)) throw new CliArgError('--instance must be a recorded instance id');
  const lineage = parsed.values.get('--lineage') ?? null;
  if (lineage !== null && !ID_CHARSET.test(lineage)) throw new CliArgError('--lineage must be a recorded databaseLineage');
  const since = seconds(parsed.values, '--since');
  const until = seconds(parsed.values, '--until');
  if (!(since < until)) throw new CliArgError('--since must be earlier than --until');
  return {
    db: required(parsed.values, '--db'),
    events: required(parsed.values, '--events'),
    instance,
    since,
    until,
    lineage,
    json: parsed.flags.has('--json'),
    help,
  };
}

export function runShadowGateReport(
  argv: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): number {
  let args: ReportArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof CliArgError)) throw err;
    printErr(`shadow-gate-report: ${err.message}`);
    printErr(USAGE);
    return EX_USAGE;
  }
  if (args.help) {
    write(`${USAGE}\n`);
    return EX_OK;
  }
  try {
    const rows = readInboundWindow(args.db, args.since, args.until);
    const segments = readSegments(args.events);
    const report = buildShadowGateReport(rows, segments, {
      instance: args.instance,
      since: args.since,
      until: args.until,
      lineage: args.lineage,
    });
    write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderShadowGateReportText(report));
    return EX_OK;
  } catch (err) {
    if (!(err instanceof ShadowGateEvidenceError)) throw err;
    printErr(`shadow-gate-report: invalid evidence: ${err.message}`);
    return EX_DATAERR;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runShadowGateReport(process.argv.slice(2));
}
