/**
 * capability-obligation-as01-rehearsal — AS-01 old-binary / schema rehearsal
 * harness (candidate §5, coupled evidence-gated rollback).
 *
 * EXECUTION IS OWNER-GATED. This authors the runnable harness; it does not run a
 * migration or an old binary on its own. Two guarantees make it an artifact, not
 * a loaded gun:
 *
 *  1. Commands are NEVER guessed. The startup / schema-guard command is read at
 *     RUNTIME from the OLD release's OWN package.json scripts (`--release-dir`
 *     + `--script-name`); an unknown script name is refused.
 *  2. It only ever touches a CLONE. `--clone-db` must resolve INSIDE the
 *     operator-designated `--rehearsal-dir` sandbox; a target outside it (a live
 *     instance DB) is refused. And it is DRY-RUN by default — it prints the
 *     resolved plan and executes nothing unless `--confirm` is passed.
 *
 * The rehearsal answers candidate §5: does the OLD binary accept / reject /
 * find-inconclusive the target-schema clone. A reject/inconclusive makes binary
 * rollback a COUPLED pre-migration DB restore — that decision stays with the
 * owner; this harness only produces the observation.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { Database } from '../src/core/database.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';

export type As01RefusedReason =
  | 'clone_is_symlink'
  | 'clone_not_regular_file'
  | 'clone_unreadable'
  | 'clone_outside_rehearsal_dir'
  | 'clone_not_sqlite'
  | 'release_package_json_unreadable'
  | 'unknown_script_name';

export interface As01RehearsalPlan {
  ok: boolean;
  refusedReason: As01RefusedReason | null;
  releaseDir: string;
  cloneDb: string;
  scriptName: string;
  /** The command string the release itself defines for `scriptName` (never guessed). */
  resolvedCommand: string | null;
  dbEnvVar: string;
}

/** True when `child` resolves to `parent` or a path inside it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The first 16 bytes of a SQLite database file. */
function isSqliteFile(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    return buf.toString('latin1').startsWith('SQLite format 3');
  } finally {
    closeSync(fd);
  }
}

export function planAs01Rehearsal(params: {
  releaseDir: string;
  cloneDb: string;
  rehearsalDir: string;
  scriptName: string;
  dbEnvVar: string;
}): As01RehearsalPlan {
  const base: As01RehearsalPlan = {
    ok: false,
    refusedReason: null,
    releaseDir: resolve(params.releaseDir),
    cloneDb: resolve(params.cloneDb),
    scriptName: params.scriptName,
    resolvedCommand: null,
    dbEnvVar: params.dbEnvVar,
  };
  // Clone-only guard (canonical, not lexical). A symlink named clone.db pointing
  // at a live DB must NOT be accepted, so: reject a symlink or non-regular file
  // outright, then CANONICALISE both paths (realpath resolves any symlink in the
  // ancestry) and require containment on the REAL paths, then confirm the target
  // is actually a SQLite database.
  let realClone: string;
  let realRehearsal: string;
  try {
    const st = lstatSync(params.cloneDb);
    if (st.isSymbolicLink()) return { ...base, refusedReason: 'clone_is_symlink' };
    if (!st.isFile()) return { ...base, refusedReason: 'clone_not_regular_file' };
    realClone = realpathSync(params.cloneDb);
    realRehearsal = realpathSync(params.rehearsalDir);
  } catch {
    return { ...base, refusedReason: 'clone_unreadable' };
  }
  if (!isInside(realRehearsal, realClone)) {
    return { ...base, cloneDb: realClone, refusedReason: 'clone_outside_rehearsal_dir' };
  }
  try {
    if (!isSqliteFile(realClone)) return { ...base, cloneDb: realClone, refusedReason: 'clone_not_sqlite' };
  } catch {
    return { ...base, cloneDb: realClone, refusedReason: 'clone_unreadable' };
  }
  base.cloneDb = realClone;
  // Commands come from the OLD release's OWN package.json — never guessed.
  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(readFileSync(resolve(params.releaseDir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return { ...base, refusedReason: 'release_package_json_unreadable' };
  }
  const command = scripts[params.scriptName];
  if (typeof command !== 'string' || command.length === 0) {
    return { ...base, refusedReason: 'unknown_script_name' };
  }
  return { ...base, ok: true, resolvedCommand: command };
}

export interface As01MigrationRehearsal {
  ok: boolean;
  reason: string | null;
  startSchema: number;
  targetSchema: number;
  integrityBefore: string;
  integrityAfter: string;
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
  /** sha256 of the migrated clone — the baseline for the old-binary write-delta. */
  migratedCloneHash: string;
  readOnlySmokeOk: boolean;
}

const DEFAULT_KEY_TABLES = ['messages', 'inbound_events', 'outbound_ops', 'turn_terminal_records'];

function schemaVersion(dbPath: string): number {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((raw.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v);
  } finally {
    raw.close();
  }
}

function rowCounts(dbPath: string, tables: readonly string[]): Record<string, number> {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const out: Record<string, number> = {};
    for (const t of tables) {
      try {
        out[t] = Number((raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
      } catch {
        out[t] = -1; // table absent at this schema
      }
    }
    return out;
  } finally {
    raw.close();
  }
}

function integrityCheck(dbPath: string): string {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return String((raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check);
  } finally {
    raw.close();
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Migrate a backup-API CLONE forward from `startSchema` to the target
 * (CURRENT_SCHEMA_MIGRATION) using the current release's OWN migration engine,
 * with integrity + row-count + read-only-smoke evidence. This MUTATES the clone
 * — that IS the rehearsal — so it must only ever run on a clone (the caller
 * guards via planAs01Rehearsal). It performs NO network I/O and never opens a
 * WhatsApp session (no-send by construction).
 */
export function rehearseCloneMigration(
  cloneDb: string,
  opts: { startSchema: number; keyTables?: readonly string[] },
): As01MigrationRehearsal {
  const keyTables = opts.keyTables ?? DEFAULT_KEY_TABLES;
  const empty: As01MigrationRehearsal = {
    ok: false, reason: null, startSchema: opts.startSchema, targetSchema: CURRENT_SCHEMA_MIGRATION,
    integrityBefore: '', integrityAfter: '', countsBefore: {}, countsAfter: {}, migratedCloneHash: '', readOnlySmokeOk: false,
  };
  const actual = schemaVersion(cloneDb);
  if (actual !== opts.startSchema) {
    return { ...empty, reason: `clone_schema_${actual}_not_start_${opts.startSchema}` };
  }
  const integrityBefore = integrityCheck(cloneDb);
  const countsBefore = rowCounts(cloneDb, keyTables);
  // Forward migration via the current release's engine (no-op if already target).
  const db = new Database(cloneDb);
  db.open();
  db.close();
  const targetSchema = schemaVersion(cloneDb);
  const integrityAfter = integrityCheck(cloneDb);
  const countsAfter = rowCounts(cloneDb, keyTables);
  let readOnlySmokeOk = false;
  try {
    const raw = new DatabaseSync(cloneDb, { readOnly: true });
    try {
      raw.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get();
      readOnlySmokeOk = true;
    } finally {
      raw.close();
    }
  } catch {
    readOnlySmokeOk = false;
  }
  return {
    ok: integrityAfter === 'ok' && readOnlySmokeOk,
    reason: null,
    startSchema: opts.startSchema,
    targetSchema,
    integrityBefore,
    integrityAfter,
    countsBefore,
    countsAfter,
    migratedCloneHash: sha256File(cloneDb),
    readOnlySmokeOk,
  };
}

function usage(): string {
  return [
    'Usage: capability-obligation-as01-rehearsal --release-dir DIR --clone-db PATH \\',
    '         --rehearsal-dir DIR --script-name NAME --start-schema N \\',
    '         [--db-env WHATSOUP_DB_PATH] [--confirm] [--network-isolated]',
    '',
    'EXECUTION IS OWNER-GATED. Dry-run by default (prints the plan, mutates nothing).',
    '--clone-db must be a real SQLite file inside --rehearsal-dir; symlinks, a live',
    'DB, or a non-SQLite file are refused (canonical realpath, not lexical).',
    '',
    'With --confirm it migrates the CLONE startSchema -> target using the current',
    'engine (this MUTATES the clone — the rehearsal), with integrity_check, key-table',
    'row counts before/after, and a read-only smoke.',
    '',
    'The OLD-binary schema check (the release\'s OWN package.json script NAME, never',
    'guessed) additionally requires --network-isolated: this harness provides no-SEND',
    'by construction (it never opens a WhatsApp session) but CANNOT itself guarantee',
    'network isolation on this OS — the operator must supply it externally and affirm',
    'it. It then hashes the clone before/after to prove whether the old binary wrote.',
  ].join('\n');
}

export interface As01Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export function runAs01RehearsalCli(argv: readonly string[], io: As01Io): number {
  const flags = new Map<string, string>();
  let confirm = false;
  let networkIsolated = false;
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (t === '--confirm') { confirm = true; continue; }
    if (t === '--network-isolated') { networkIsolated = true; continue; }
    if (t === '--help') { io.out(usage()); return 0; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${t} requires a value`);
    flags.set(t, v);
    i += 1;
  }
  const releaseDir = flags.get('--release-dir');
  const cloneDb = flags.get('--clone-db');
  const rehearsalDir = flags.get('--rehearsal-dir');
  const scriptName = flags.get('--script-name');
  const startSchemaRaw = flags.get('--start-schema');
  const dbEnvVar = flags.get('--db-env') ?? 'WHATSOUP_DB_PATH';
  if (!releaseDir || !cloneDb || !rehearsalDir || !scriptName || !startSchemaRaw) {
    throw new Error(`missing required flag.\n${usage()}`);
  }
  if (!/^[0-9]+$/.test(startSchemaRaw)) throw new Error('--start-schema must be a non-negative integer');
  const startSchema = Number(startSchemaRaw);

  const plan = planAs01Rehearsal({ releaseDir, cloneDb, rehearsalDir, scriptName, dbEnvVar });
  if (!plan.ok) {
    io.err(`AS-01 rehearsal refused: ${plan.refusedReason}`);
    return 1;
  }
  io.out(`AS-01 rehearsal plan:`);
  io.out(`  release-dir : ${plan.releaseDir}`);
  io.out(`  clone-db    : ${plan.cloneDb}`);
  io.out(`  script      : ${plan.scriptName} => ${plan.resolvedCommand}`);
  io.out(`  start-schema: ${startSchema} -> target ${CURRENT_SCHEMA_MIGRATION}`);
  if (!confirm) {
    io.out('DRY-RUN — nothing migrated or executed. --confirm migrates the clone; --network-isolated additionally runs the old-binary check.');
    return 0;
  }

  // Migrate the clone forward (mutates the CLONE — the rehearsal). No network, no send.
  const migration = rehearseCloneMigration(plan.cloneDb, { startSchema });
  if (migration.reason !== null) {
    io.err(`AS-01 migration rehearsal refused: ${migration.reason}`);
    return 1;
  }
  io.out(`  migrated    : ${migration.startSchema} -> ${migration.targetSchema}`);
  io.out(`  integrity   : before=${migration.integrityBefore} after=${migration.integrityAfter}`);
  io.out(`  counts      : ${JSON.stringify(migration.countsBefore)} -> ${JSON.stringify(migration.countsAfter)}`);
  io.out(`  smoke(ro)   : ${migration.readOnlySmokeOk}`);
  io.out(`  clone-hash  : ${migration.migratedCloneHash}`);

  // OLD-binary schema check — additionally gated on operator-attested network
  // isolation (this harness cannot itself isolate the network on this OS).
  if (!networkIsolated) {
    io.out('OLD-BINARY STEP SKIPPED — pass --network-isolated to run the old release schema check (operator must supply external network isolation; this harness only guarantees no-send).');
    return migration.ok ? 0 : 1;
  }
  const childEnv: Record<string, string> = { [plan.dbEnvVar]: plan.cloneDb };
  for (const key of ['PATH', 'HOME'] as const) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  const result = spawnSync('npm', ['run', plan.scriptName], {
    cwd: plan.releaseDir, env: childEnv, encoding: 'utf8', timeout: 600_000,
  });
  const hashAfterOldBinary = sha256File(plan.cloneDb);
  const wrote = hashAfterOldBinary !== migration.migratedCloneHash;
  io.out(`  old-binary  : exit=${result.status ?? 'signal'} wrote=${wrote}`);
  if (result.stdout) io.out(result.stdout.slice(-2048));
  if (result.stderr) io.err(result.stderr.slice(-2048));
  // The exit code + write-delta are the OBSERVATION (accept/reject, and whether
  // the old binary mutated the clone); coupled rollback is the owner's decision.
  return result.status === 0 && !wrote ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = runAs01RehearsalCli(process.argv.slice(2), {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
