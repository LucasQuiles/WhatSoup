/**
 * capability-obligation-admin — operator inspect/list/cancel/adjudicate over the
 * capability-obligation ledger (migration 58).
 *
 * Safety by construction:
 *  - SCHEMA GUARD: the target DB must already be EXACTLY at the current schema
 *    version. This CLI never migrates a live database — pointing it at an
 *    older instance (e.g. a bot still on a pre-58 schema) refuses cleanly
 *    instead of silently upgrading it.
 *  - DRY-RUN BY DEFAULT: `cancel`/`adjudicate` only preview unless `--confirm`
 *    is passed; the preview reports whether a real run WOULD apply.
 *  - GUARDED TRANSITIONS: cancel/requeue go through the store's guarded state
 *    machine (the migration-58 transition whitelist), never raw SQL.
 *  - IDEMPOTENT: an already-in-target obligation is a no-op success; `--run-id`
 *    is recorded as the audit actor and `--idempotency-key` in the audit detail.
 *
 * Usage:
 *   capability-obligation-admin inspect    --db PATH --id N [--json]
 *   capability-obligation-admin list       --db PATH [--state S] [--limit N] [--json]
 *   capability-obligation-admin cancel     --db PATH --id N --reason CODE --run-id ID \
 *                                          [--expect-state S] [--idempotency-key K] [--json] [--confirm]
 *   capability-obligation-admin adjudicate --db PATH --id N --action cancel|requeue \
 *                                          --reason CODE --run-id ID [--expect-state S] \
 *                                          [--idempotency-key K] [--json] [--confirm]
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';
import { Database } from '../src/core/database.ts';
import {
  CapabilityObligationStore,
  type OperatorAdjudicationParams,
} from '../src/core/capability-obligation-store.ts';

export type AdminSubcommand = 'inspect' | 'list' | 'cancel' | 'adjudicate';

export interface AdminArgs {
  subcommand: AdminSubcommand;
  dbPath: string;
  id?: number;
  state?: string;
  action?: 'cancel' | 'requeue';
  expectState?: string;
  reason?: string;
  runId?: string;
  idempotencyKey?: string;
  limit: number;
  json: boolean;
  confirm: boolean;
}

const VALUE_FLAGS = new Set([
  '--db', '--id', '--state', '--action', '--expect-state', '--reason', '--run-id', '--idempotency-key', '--limit',
]);

function positiveInt(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be a safe integer`);
  return n;
}

export function parseAdminArgs(argv: readonly string[]): AdminArgs {
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'inspect' && subcommand !== 'list' && subcommand !== 'cancel' && subcommand !== 'adjudicate') {
    throw new Error('first argument must be one of: inspect | list | cancel | adjudicate');
  }
  const flags = new Map<string, string>();
  let json = false;
  let confirm = false;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token === '--json') { json = true; continue; }
    if (token === '--confirm') { confirm = true; continue; }
    if (!VALUE_FLAGS.has(token)) throw new Error(`unknown flag: ${token}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${token} requires a value`);
    flags.set(token, value);
    i += 1;
  }
  const dbPath = flags.get('--db');
  if (dbPath === undefined || dbPath.length === 0) throw new Error('--db PATH is required');
  const args: AdminArgs = {
    subcommand,
    dbPath,
    limit: flags.has('--limit') ? positiveInt(flags.get('--limit')!, '--limit') : 50,
    json,
    confirm,
  };
  if (flags.has('--id')) args.id = positiveInt(flags.get('--id')!, '--id');
  if (flags.has('--state')) args.state = flags.get('--state');
  if (flags.has('--expect-state')) args.expectState = flags.get('--expect-state');
  if (flags.has('--reason')) args.reason = flags.get('--reason');
  if (flags.has('--run-id')) args.runId = flags.get('--run-id');
  if (flags.has('--idempotency-key')) args.idempotencyKey = flags.get('--idempotency-key');
  const action = flags.get('--action');
  if (action !== undefined) {
    if (action !== 'cancel' && action !== 'requeue') throw new Error('--action must be cancel or requeue');
    args.action = action;
  }
  return args;
}

/** Refuse unless the DB is EXACTLY at the current schema — never migrate here. */
function assertSchemaCurrent(dbPath: string): void {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let version = 0;
    try {
      version = Number((raw.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v);
    } catch (err) {
      // A genuinely ABSENT ledger table means "not a migrated instance DB"
      // (version 0 → the schema-mismatch refusal below). Any OTHER read error —
      // most importantly a busy/locked database (the bot is running) or a
      // corrupt file — MUST surface distinctly and never be misread as a stale
      // schema, or an operator would "fix" a running bot instead of retrying.
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(message)) {
        throw new Error(`could not read schema version from ${dbPath}: ${message}`);
      }
      version = 0;
    }
    if (version !== CURRENT_SCHEMA_MIGRATION) {
      throw new Error(
        `refusing to operate: database is at schema ${version}, expected ${CURRENT_SCHEMA_MIGRATION}. `
        + 'Run this tool from the release whose schema matches the instance; it never migrates a live database.',
      );
    }
  } finally {
    raw.close();
  }
}

export interface AdminIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export function runCapabilityObligationAdmin(args: AdminArgs, io: AdminIo): number {
  assertSchemaCurrent(args.dbPath);
  const db = new Database(args.dbPath);
  db.open();
  try {
    const store = new CapabilityObligationStore(db);
    const emit = (payload: Record<string, unknown>, human: () => string): void => {
      io.out(args.json ? JSON.stringify(payload) : human());
    };

    if (args.subcommand === 'inspect') {
      if (args.id === undefined) throw new Error('inspect requires --id');
      const view = store.operatorInspectObligation(args.id);
      if (view === null) {
        emit({ found: false, id: args.id }, () => `obligation ${args.id} not found`);
        return 1;
      }
      emit({ found: true, ...view }, () =>
        [
          `obligation ${args.id}: state=${view.obligation.state} capability=${view.obligation.required_capability}`,
          `  events: ${view.events.map((e) => e.action).join(', ')}`,
          `  receipts: ${view.receipts.length}`,
        ].join('\n'),
      );
      return 0;
    }

    if (args.subcommand === 'list') {
      const rows = store.operatorListObligations({ state: args.state, limit: args.limit });
      emit({ count: rows.length, obligations: rows }, () =>
        rows.length === 0
          ? '(no obligations)'
          : rows.map((r) => `#${r.id} ${r.state} ${r.required_capability} attempts=${r.attempt_count}`).join('\n'),
      );
      return 0;
    }

    // cancel / adjudicate — mutating, dry-run unless --confirm.
    if (args.id === undefined) throw new Error(`${args.subcommand} requires --id`);
    if (args.reason === undefined) throw new Error(`${args.subcommand} requires --reason`);
    if (args.runId === undefined) throw new Error(`${args.subcommand} requires --run-id (audit actor)`);
    const action: 'cancel' | 'requeue' = args.subcommand === 'cancel' ? 'cancel' : (() => {
      if (args.action === undefined) throw new Error('adjudicate requires --action cancel|requeue');
      return args.action;
    })();

    const params: OperatorAdjudicationParams = {
      action,
      reasonCode: args.reason,
      actorId: args.runId,
      dryRun: !args.confirm,
    };
    if (args.expectState !== undefined) params.expectedState = args.expectState;
    if (args.idempotencyKey !== undefined) params.idempotencyKey = args.idempotencyKey;

    const result = store.operatorAdjudicateObligation(args.id, params);
    emit({ mode: args.confirm ? 'confirm' : 'dry-run', action, id: args.id, ...result }, () =>
      args.confirm
        ? `${action} #${args.id}: applied=${result.applied} state=${result.currentState}`
          + (result.refusedReason ? ` refused=${result.refusedReason}` : '')
          + (result.alreadyInTarget ? ' (already in target)' : '')
        : `DRY-RUN ${action} #${args.id}: wouldApply=${result.wouldApply} state=${result.currentState}`
          + (result.refusedReason ? ` refused=${result.refusedReason}` : '')
          + (result.alreadyInTarget ? ' (already in target)' : '')
          + ' — pass --confirm to apply',
    );
    // Exit non-zero on a refusal (precondition/illegal/not-found); a no-op
    // (already in target) and a successful/would-apply run are exit 0.
    return result.refusedReason === null ? 0 : 1;
  } finally {
    db.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    const args = parseAdminArgs(process.argv.slice(2));
    process.exitCode = runCapabilityObligationAdmin(args, {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
