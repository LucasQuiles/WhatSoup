import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface CliArgs {
  instance: string;
  window: string;
  json: boolean;
}

interface TokenWindowRow {
  input_tokens: number | null;
  output_tokens: number | null;
  event_count: number;
  earliest_ts: number | null;
  latest_ts: number | null;
}

function fail(message: string): never {
  console.error(`token-window: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--instance':
        if (argv[i + 1] === undefined) fail('missing value for --instance');
        args.instance = argv[i + 1];
        i += 1;
        break;
      case '--window':
        if (argv[i + 1] === undefined) fail('missing value for --window');
        args.window = argv[i + 1];
        i += 1;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (!args.instance) fail('missing required --instance');
  if (!args.window) fail('missing required --window');
  if (!args.json) fail('missing required --json');

  return args as CliArgs;
}

export function parseWindowSeconds(windowArg: string): number {
  const match = /^([1-9]\d*)([smh])$/.exec(windowArg);
  if (!match) {
    throw new Error(`invalid window: ${windowArg}`);
  }

  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : 3600;
  return value * multiplier;
}

function assertInstanceDb(instancePath: string): string {
  if (!existsSync(instancePath) || !statSync(instancePath).isDirectory()) {
    fail(`missing instance directory: ${instancePath}`);
  }

  const dbPath = join(instancePath, 'bot.db');
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    fail(`missing bot.db: ${dbPath}`);
  }

  return dbPath;
}

function readTokenWindow(dbPath: string, windowSeconds: number): TokenWindowRow {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COUNT(*) AS event_count,
             MIN(timestamp) AS earliest_ts,
             MAX(timestamp) AS latest_ts
        FROM agent_token_events
       WHERE timestamp >= unixepoch('now') - ?
    `).get(windowSeconds);
    if (!row) fail('token-window query returned no row');
    return row as unknown as TokenWindowRow;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`failed to query bot.db: ${message}`);
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing useful to recover in a short-lived read-only CLI.
    }
  }
  throw new Error('unreachable');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let windowSeconds: number;
  try {
    windowSeconds = parseWindowSeconds(args.window);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  }

  const dbPath = assertInstanceDb(args.instance);
  const row = readTokenWindow(dbPath, windowSeconds);
  const inputTokens = Number(row.input_tokens ?? 0);
  const outputTokens = Number(row.output_tokens ?? 0);

  process.stdout.write(`${JSON.stringify({
    instance: basename(args.instance),
    window_seconds: windowSeconds,
    total_tokens: inputTokens + outputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    event_count: Number(row.event_count ?? 0),
    sources: {
      whatsoup_db: {
        available: true,
        earliest_ts: row.earliest_ts === null ? null : Number(row.earliest_ts),
        latest_ts: row.latest_ts === null ? null : Number(row.latest_ts),
      },
    },
  })}\n`);
}

main();
