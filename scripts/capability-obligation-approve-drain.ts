/**
 * capability-obligation-approve-drain — the operator front-door for the AS-08
 * GROUP-drain approval (round-15 finding 3). `consumeGroupDrainApproval` was the
 * sole sanctioned `waiting_approval → waiting_capability` transition but had no
 * caller, so 7795/7799 could never leave `waiting_approval` without raw SQL.
 *
 * Safety by construction (mirrors capability-obligation-admin):
 *  - SCHEMA GUARD: refuses unless the DB is EXACTLY at the current schema.
 *  - DRY-RUN BY DEFAULT: records nothing unless `--confirm`; the preview reports
 *    the exact attestation-binding digest the approval WOULD carry.
 *  - DIGEST COMPUTED, NEVER TYPED: the approval's `attestation_digest` is derived
 *    via the SAME `buildCapabilityAttestationBinding` + `attestationBindingDigest`
 *    the supervisor uses at admission, so the approval is claimable under the
 *    r14-F1 rule. A hand-typed digest would produce an unclaimable approval.
 *  - GROUP + waiting_approval ONLY: the store refuses any other obligation.
 *  - `--run-id`/`--approver` are recorded as the audit actor.
 *
 * This tool only CREATES the approval record; it sends nothing and activates no
 * session. Draining the obligation is a separate, separately-gated step.
 *
 * Usage:
 *   capability-obligation-approve-drain --db PATH --obligation-id N \
 *     --release-sha SHA --provider PROVIDER \
 *     --skill-name NAME --skill-digest DIGEST --probe-version V --canary-id ID \
 *     --media-root PATH --manifest-digest DIGEST --drain-run-id ID \
 *     --approver WHO --valid-seconds N \
 *     [--skill-version V] [--resolver-digest D] [--dep name=version ...] \
 *     [--host H] [--runtime-user U] [--json] [--confirm]
 */
import { DatabaseSync } from 'node:sqlite';
import { hostname, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  attestationBindingDigest,
  buildCapabilityAttestationBinding,
  type AttestationSkillIdentity,
} from '../src/core/capability-attestation.ts';
import { CapabilityObligationStore } from '../src/core/capability-obligation-store.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';
import { Database } from '../src/core/database.ts';
import { resolveHarnessType } from '../src/runtimes/agent/capability-obligation-runtime.ts';

export interface ApproveDrainArgs {
  dbPath: string;
  obligationId: number;
  releaseSha: string;
  providerId: string;
  skill: AttestationSkillIdentity;
  mediaRoot: string;
  manifestDigest: string;
  drainRunId: string;
  approver: string;
  validForSeconds: number;
  hostId: string;
  runtimeUser: string;
  json: boolean;
  confirm: boolean;
}

const VALUE_FLAGS = new Set([
  '--db', '--obligation-id', '--release-sha', '--provider', '--skill-name', '--skill-version',
  '--skill-digest', '--resolver-digest', '--probe-version', '--canary-id', '--media-root',
  '--manifest-digest', '--drain-run-id', '--approver', '--valid-seconds', '--host', '--runtime-user',
]);

function positiveInt(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be a safe integer`);
  return n;
}

export function parseApproveDrainArgs(argv: readonly string[]): ApproveDrainArgs {
  const flags = new Map<string, string>();
  const deps: Record<string, string> = {};
  let json = false;
  let confirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--json') { json = true; continue; }
    if (token === '--confirm') { confirm = true; continue; }
    if (token === '--dep') {
      const kv = argv[i + 1];
      if (kv === undefined) throw new Error('--dep requires name=version');
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new Error(`--dep must be name=version, got: ${kv}`);
      deps[kv.slice(0, eq)] = kv.slice(eq + 1);
      i += 1;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) throw new Error(`unknown flag: ${token}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${token} requires a value`);
    flags.set(token, value);
    i += 1;
  }
  const need = (flag: string): string => {
    const v = flags.get(flag);
    if (v === undefined || v.length === 0) throw new Error(`${flag} is required`);
    return v;
  };
  return {
    dbPath: need('--db'),
    obligationId: positiveInt(need('--obligation-id'), '--obligation-id'),
    releaseSha: need('--release-sha'),
    providerId: need('--provider'),
    skill: {
      skillName: need('--skill-name'),
      skillVersion: flags.get('--skill-version') ?? null,
      skillDigest: need('--skill-digest'),
      resolverDigest: flags.get('--resolver-digest') ?? null,
      dependencyVersions: deps,
      probeVersion: need('--probe-version'),
      canaryId: need('--canary-id'),
    },
    mediaRoot: need('--media-root'),
    manifestDigest: need('--manifest-digest'),
    drainRunId: need('--drain-run-id'),
    approver: need('--approver'),
    validForSeconds: positiveInt(need('--valid-seconds'), '--valid-seconds'),
    hostId: flags.get('--host') ?? hostname(),
    runtimeUser: flags.get('--runtime-user') ?? userInfo().username,
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

export interface ApproveDrainIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Compute the approval's attestation digest for an obligation, or null if not a drainable group. */
export function approveDrain(
  store: CapabilityObligationStore,
  db: Database,
  args: ApproveDrainArgs,
): {
  ok: boolean;
  reason?: string;
  attestationDigest?: string;
  approvalId?: number;
  mode: 'dry-run' | 'confirm';
} {
  const obligation = db.raw
    .prepare(
      `SELECT is_group AS isGroup, state, delivery_jid AS deliveryJid,
              contract_version AS contractVersion, required_capability AS capability
       FROM capability_obligations WHERE id = ?`,
    )
    .get(args.obligationId) as
    | { isGroup: number; state: string; deliveryJid: string; contractVersion: string; capability: string }
    | undefined;
  const mode = args.confirm ? 'confirm' : 'dry-run';
  if (obligation === undefined) return { ok: false, reason: 'not_found', mode };
  if (obligation.isGroup !== 1 || obligation.state !== 'waiting_approval') {
    return { ok: false, reason: 'not_a_waiting_group', mode };
  }
  const binding = buildCapabilityAttestationBinding({
    liveFacts: {
      hostId: args.hostId,
      runtimeUser: args.runtimeUser,
      releaseSha: args.releaseSha,
      schemaVersion: CURRENT_SCHEMA_MIGRATION,
      providerId: args.providerId,
      harnessType: resolveHarnessType(args.providerId),
    },
    contractVersion: obligation.contractVersion,
    capability: obligation.capability,
    skill: args.skill,
    mediaRoot: args.mediaRoot,
  });
  const attestationDigest = attestationBindingDigest(binding);
  if (!args.confirm) return { ok: true, attestationDigest, mode };
  const recorded = store.recordGroupDrainApproval({
    obligationId: args.obligationId,
    destinationJid: obligation.deliveryJid,
    releaseSha: args.releaseSha,
    manifestDigest: args.manifestDigest,
    drainRunId: args.drainRunId,
    attestationDigest,
    approver: args.approver,
    validForSeconds: args.validForSeconds,
  });
  if (!recorded.recorded) return { ok: false, reason: recorded.reason, attestationDigest, mode };
  return { ok: true, attestationDigest, approvalId: recorded.approvalId, mode };
}

export function runApproveDrain(args: ApproveDrainArgs, io: ApproveDrainIo): number {
  assertSchemaCurrent(args.dbPath);
  const db = new Database(args.dbPath);
  db.open();
  try {
    const store = new CapabilityObligationStore(db);
    const result = approveDrain(store, db, args);
    io.out(args.json ? JSON.stringify(result) : (
      result.ok
        ? (args.confirm
          ? `APPROVED group drain for obligation #${args.obligationId}: approvalId=${result.approvalId} attDigest=${result.attestationDigest}`
          : `DRY-RUN approve #${args.obligationId}: WOULD record group approval with attDigest=${result.attestationDigest} — pass --confirm to apply`)
        : `refused #${args.obligationId}: ${result.reason}`
    ));
    return result.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    const args = parseApproveDrainArgs(process.argv.slice(2));
    process.exitCode = runApproveDrain(args, {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
