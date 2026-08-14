/**
 * capability-obligation-drain-now — the operator front-door for the round-22
 * AE1 drain-now trigger. Writes a drop-file request that the LIVE instance's
 * obligation scan services within one scan interval (30s): the runtime
 * consumes the request, re-checks every gate (`waiting_capability`, live AS-08
 * approval for groups, attestation candidate), activates the per-chat session
 * (fresh spawn, no resume side effects), and runs one supervisor tick.
 *
 * Safety by construction (mirrors capability-obligation-approve-drain):
 *  - SCHEMA GUARD: refuses unless the DB is EXACTLY at the current schema.
 *  - DRY-RUN BY DEFAULT: writes nothing unless `--confirm`; the preview
 *    reports the obligation's state, the group-approval liveness, and the
 *    exact request path that WOULD be written.
 *  - ADVISORY PRE-CHECKS ONLY: this tool re-reads the same gates the runtime
 *    enforces so an operator does not drop a request that is certain to be
 *    refused — but the RUNTIME's own `drainObligationNow` gates remain the
 *    authoritative decision; nothing here bypasses them.
 *  - The request file itself grants nothing: it names an obligation id; every
 *    approval/attestation gate is evaluated by the live instance at service
 *    time, and the request expires after 15 minutes.
 *
 * This tool sends nothing and activates no session itself.
 *
 * Usage:
 *   capability-obligation-drain-now --db PATH --obligation-id N \
 *     --requested-by WHO [--json] [--confirm]
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';
import {
  DRAIN_NOW_REQUEST_TTL_SECONDS,
  drainNowRequestDirForDbPath,
  writeDrainNowRequest,
} from '../src/runtimes/agent/capability-obligation-drain-now-service.ts';

export interface DrainNowCliArgs {
  dbPath: string;
  obligationId: number;
  requestedBy: string;
  json: boolean;
  confirm: boolean;
}

const VALUE_FLAGS = new Set(['--db', '--obligation-id', '--requested-by']);

export function parseDrainNowArgs(argv: readonly string[]): DrainNowCliArgs {
  const flags = new Map<string, string>();
  let json = false;
  let confirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--confirm') { confirm = true; continue; }
    if (!VALUE_FLAGS.has(arg)) throw new Error(`unknown flag: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    flags.set(arg, value);
    i += 1;
  }
  const need = (flag: string): string => {
    const v = flags.get(flag);
    if (v === undefined || v.length === 0) throw new Error(`${flag} is required`);
    return v;
  };
  const idRaw = need('--obligation-id');
  if (!/^[1-9]\d*$/.test(idRaw)) throw new Error('--obligation-id must be a positive integer');
  const obligationId = Number(idRaw);
  if (!Number.isSafeInteger(obligationId) || obligationId > 2_147_483_647) {
    throw new Error('--obligation-id out of range');
  }
  return {
    dbPath: need('--db'),
    obligationId,
    requestedBy: need('--requested-by'),
    json,
    confirm,
  };
}

function assertSchemaCurrent(dbPath: string): void {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let version = 0;
    try {
      version = Number((raw.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(message)) throw new Error(`could not read schema version from ${dbPath}: ${message}`);
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

export interface DrainNowCliResult {
  ok: boolean;
  mode: 'dry-run' | 'confirm';
  reason?: string;
  obligation?: {
    state: string;
    isGroup: boolean;
    deliveryJid: string;
    attemptCount: number;
    groupApprovalLive?: boolean;
  };
  requestDir?: string;
  requestPath?: string;
  ttlSeconds?: number;
}

/** Read-only advisory preview + (on --confirm) the request-file write. */
export function runDrainNowCli(args: DrainNowCliArgs): DrainNowCliResult {
  assertSchemaCurrent(args.dbPath);
  const mode = args.confirm ? 'confirm' : 'dry-run';
  const requestDir = drainNowRequestDirForDbPath(args.dbPath);
  if (requestDir === null) return { ok: false, mode, reason: 'in_memory_db_has_no_drop_dir' };

  const raw = new DatabaseSync(args.dbPath, { readOnly: true });
  let obligation: DrainNowCliResult['obligation'];
  try {
    const row = raw
      .prepare(
        `SELECT state, is_group AS isGroup, delivery_jid AS deliveryJid,
                attempt_count AS attemptCount, drain_approval_id AS drainApprovalId
         FROM capability_obligations WHERE id = ?`,
      )
      .get(args.obligationId) as
      | { state: string; isGroup: number; deliveryJid: string; attemptCount: number; drainApprovalId: number | null }
      | undefined;
    if (row === undefined) return { ok: false, mode, reason: 'not_found', requestDir };
    obligation = {
      state: row.state,
      isGroup: row.isGroup === 1,
      deliveryJid: row.deliveryJid,
      attemptCount: row.attemptCount,
    };
    if (row.isGroup === 1) {
      // Same liveness predicate drainObligationNow applies — advisory here.
      const approval = row.drainApprovalId === null
        ? undefined
        : (raw
            .prepare(
              `SELECT 1 AS ok FROM capability_drain_approvals
               WHERE id = ? AND obligation_id = ? AND scope = 'group'
                 AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')`,
            )
            .get(row.drainApprovalId, args.obligationId) as { ok: number } | undefined);
      obligation.groupApprovalLive = approval !== undefined;
    }
    if (row.state !== 'waiting_capability') {
      return { ok: false, mode, reason: 'not_drainable', obligation, requestDir };
    }
    if (row.isGroup === 1 && obligation.groupApprovalLive !== true) {
      return { ok: false, mode, reason: 'group_approval_required', obligation, requestDir };
    }
  } finally {
    raw.close();
  }

  if (!args.confirm) {
    return {
      ok: true,
      mode,
      obligation,
      requestDir,
      requestPath: `${requestDir}/${args.obligationId}.json`,
      ttlSeconds: DRAIN_NOW_REQUEST_TTL_SECONDS,
    };
  }
  const requestPath = writeDrainNowRequest(requestDir, {
    obligationId: args.obligationId,
    requestedAtUnixSec: Math.floor(Date.now() / 1000),
    requestedBy: args.requestedBy,
    nonce: randomUUID(),
  });
  return { ok: true, mode, obligation, requestDir, requestPath, ttlSeconds: DRAIN_NOW_REQUEST_TTL_SECONDS };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    const args = parseDrainNowArgs(process.argv.slice(2));
    const result = runDrainNowCli(args);
    const line = args.json
      ? JSON.stringify(result)
      : (result.ok
        ? (args.confirm
          ? `REQUESTED drain-now for obligation #${args.obligationId}: ${result.requestPath} (the live instance services it within one scan interval; expires after ${result.ttlSeconds}s)`
          : `DRY-RUN drain-now #${args.obligationId}: WOULD write ${result.requestPath} — pass --confirm to apply`)
        : `refused #${args.obligationId}: ${result.reason}`);
    process.stdout.write(`${line}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
