/**
 * capability-obligation-as01-rehearsal — AS-01 old-binary / schema rehearsal
 * harness (candidate §5, coupled evidence-gated rollback).
 *
 * EXECUTION IS OWNER-GATED. This authors the runnable harness; it does not run a
 * migration or an old binary on its own. Guarantees that make it an artifact,
 * not a loaded gun:
 *
 *  1. Commands are NEVER guessed. The startup / schema-guard command is read at
 *     RUNTIME from the OLD release's OWN package.json scripts (`--release-dir`
 *     + `--script-name`); an unknown script name is refused.
 *  2. It only ever touches a CLONE. `--clone-db` must resolve INSIDE the
 *     operator-designated `--rehearsal-dir` sandbox (canonical realpath, not
 *     lexical — a symlink to a live DB is refused). Dry-run by default.
 *  3. The old binary runs in an ISOLATED environment — a sandbox HOME and npm
 *     cache (so it cannot load the operator's live config), only PATH inherited.
 *  4. Network isolation is a CHECKED precondition, not an assertion: an egress
 *     probe runs first and REFUSES if egress is reachable. The probe can only
 *     DISPROVE isolation (reachable ⇒ not isolated); a failed probe is
 *     consistent-with-isolation but never proof, so `--network-isolated` remains
 *     an operator attestation the probe merely fails-closed against.
 *
 * The rehearsal answers candidate §5 by OBSERVING one of four outcomes when the
 * old binary meets the target-schema clone, and — on the expected rejection —
 * proving the COUPLED pre-migration DB restore (byte-exact + integrity). The
 * exit code distinguishes every outcome so a skipped or inconclusive step can
 * never read as a pass (F4/F5).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { Database } from '../src/core/database.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';

/** AS-01 rehearsal exit codes — every outcome is distinguishable (F4/F5). */
export const AS01_EXIT = {
  /** Expected rejection observed AND coupled restore proven — safe to proceed. */
  PASS: 0,
  /** Inconclusive (missing npm, crash, signal, timeout, unrecognized failure) or a hard error. */
  INCONCLUSIVE: 1,
  /** Decisive old-binary step was SKIPPED (no --network-isolated) — NOT a pass. */
  INCOMPLETE: 2,
  /** Old binary ACCEPTED the new schema (no write) — a different rollback branch; owner decision. */
  ACCEPTED: 3,
  /** Old binary WROTE to the clone — dangerous; coupled restore is mandatory. */
  WROTE_DANGEROUS: 4,
} as const;

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
  /** file-set sha256 of the migrated clone — the baseline for the old-binary write-delta. */
  migratedCloneHash: string;
  readOnlySmokeOk: boolean;
  /** Trigger name-sets before/after (F4 — a migration must not lose triggers). */
  triggersBefore: string[];
  triggersAfter: string[];
  /** True when no key-table row count decreased and no trigger disappeared. */
  countsPreserved: boolean;
  triggersPreserved: boolean;
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
  try {
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return String((raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check);
    } finally {
      raw.close();
    }
  } catch {
    return 'unreadable';
  }
}

/**
 * sha256 over the SQLite CONTENT file set (main || -wal), absent component =
 * empty (F1, WAL-aware). Hashing ONLY the main file misses a write the old
 * binary lands in the write-ahead log; the -wal carries those frames, so hashing
 * it makes any WAL write visible without opening (and possibly checkpointing)
 * the database. `-shm` is deliberately excluded — it is transient shared memory
 * (an index into the -wal), not durable content, and hashing it invites spurious
 * mismatches from a merely-opened connection.
 */
function dbFileSetHash(path: string): string {
  const h = createHash('sha256');
  for (const suffix of ['', '-wal']) {
    try {
      h.update(readFileSync(`${path}${suffix}`));
    } catch { /* absent component contributes nothing */ }
    h.update('\0');
  }
  return h.digest('hex');
}

/** Trigger name → definition SQL (F4 — a migration must not drop OR redefine a trigger). */
function triggerDefs(dbPath: string): Map<string, string> {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string; sql: string | null }>;
    return new Map(rows.map((r) => [r.name, r.sql ?? '']));
  } finally {
    raw.close();
  }
}

/**
 * A COHERENT single-file snapshot of a SQLite DB via `VACUUM INTO`. SQLite reads
 * the database through its OWN read snapshot and writes a fresh, defragmented file,
 * so ALL committed content — including frames still living in the WAL — is captured
 * even when another connection holds a read transaction. `wal_checkpoint(TRUNCATE)`
 * + a main-file copy is NOT sufficient: under a pinned reader the checkpoint returns
 * `{busy:1, checkpointed:0}` and SILENTLY leaves committed WAL frames out of the copy
 * (F1 r12 — the reviewer reproduced source=1 / snapshot=0). VACUUM INTO fails if the
 * destination already exists, so a stale dest file-set is removed first. The produced
 * file is byte-different from a raw copy (defragmented) but content-identical for all
 * committed rows, which is what the coupled-restore file-set hash is taken over.
 */
export function snapshotDbCoherent(src: string, dest: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(`${dest}${suffix}`); } catch { /* absent dest component: nothing to remove */ }
  }
  const raw = new DatabaseSync(src);
  try {
    raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    raw.close();
  }
  // VERIFY the capture rather than trust the API returned void: the produced
  // snapshot must be a structurally valid SQLite DB. Fail-closed — a corrupt or
  // unreadable snapshot must never be handed to the coupled restore as a baseline.
  // (Full row-parity against the live source is deferred to the owner-gated real
  // run, where the source is quiescent; the reader-held falsifier proves committed
  // WAL content is captured.)
  const integrity = integrityCheck(dest);
  if (integrity !== 'ok') {
    throw new Error(`snapshotDbCoherent: VACUUM INTO produced an invalid snapshot (integrity_check=${integrity})`);
  }
}

function fsyncDir(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
    triggersBefore: [], triggersAfter: [], countsPreserved: false, triggersPreserved: false,
  };
  const actual = schemaVersion(cloneDb);
  if (actual !== opts.startSchema) {
    return { ...empty, reason: `clone_schema_${actual}_not_start_${opts.startSchema}` };
  }
  const integrityBefore = integrityCheck(cloneDb);
  const countsBefore = rowCounts(cloneDb, keyTables);
  const defsBefore = triggerDefs(cloneDb);
  // Forward migration via the current release's engine (no-op if already target).
  const db = new Database(cloneDb);
  db.open();
  db.close();
  const targetSchema = schemaVersion(cloneDb);
  const integrityAfter = integrityCheck(cloneDb);
  const countsAfter = rowCounts(cloneDb, keyTables);
  const defsAfter = triggerDefs(cloneDb);
  const triggersBefore = [...defsBefore.keys()];
  const triggersAfter = [...defsAfter.keys()];
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
  // No key-table row count may DECREASE (a table present before must not lose
  // rows or vanish); no trigger name present before may disappear.
  // Non-decreasing (a real 44→current migration may backfill rows, e.g. migration
  // 45); the before→after delta is reported in the CLI output so an increase is
  // visible and attributable rather than silently allowed.
  const countsPreserved = keyTables.every((t) => {
    const before = countsBefore[t] ?? -1;
    const after = countsAfter[t] ?? -1;
    return before < 0 || (after >= 0 && after >= before);
  });
  // Every trigger present before must still exist WITH THE SAME DEFINITION — this
  // catches a trigger being dropped OR redefined, not just renamed away.
  const triggersPreserved = [...defsBefore].every(([name, sql]) => defsAfter.get(name) === sql);
  return {
    ok: integrityAfter === 'ok' && readOnlySmokeOk && countsPreserved && triggersPreserved
      && targetSchema === CURRENT_SCHEMA_MIGRATION,
    reason: null,
    startSchema: opts.startSchema,
    targetSchema,
    integrityBefore,
    integrityAfter,
    countsBefore,
    countsAfter,
    migratedCloneHash: dbFileSetHash(cloneDb),
    readOnlySmokeOk,
    triggersBefore,
    triggersAfter,
    countsPreserved,
    triggersPreserved,
  };
}

export interface As01CoupledRestore {
  ok: boolean;
  backupHash: string;
  restoredHash: string;
  integrityAfter: string;
}

/**
 * Coupled rollback rehearsal (candidate §5): when the old binary rejects the
 * migrated schema, binary rollback is only safe if the pre-migration DB can be
 * restored crash-safely and completely (F2). The restore ordering is:
 *   write temp ← backup → fsync temp → integrity_check temp
 *   → UNLINK clone -wal/-shm → rename(temp, main) → fsync directory.
 * The `-wal`/`-shm` are discarded BEFORE the rename, never after (the r12 defect
 * was rename-then-unlink): a stale write-ahead log left by the old binary must not
 * survive to replay its (possibly injected) frames onto the freshly restored main
 * on the next open. With unlink-first, every crash boundary leaves a RECOVERABLE
 * file-set — either the un-restored migrated clone, or the restored backup — never
 * a restored-backup main paired with a stale WAL. `backupPath` is a COHERENT
 * snapshot (see snapshotDbCoherent), so valid WAL content of the pre-migration DB
 * was captured, not lost. Proves the restored FILE-SET equals the backup and passes
 * integrity_check. `opts.onStep` is a test seam: it fires after each durable step
 * ('temp-written' | 'sidecars-unlinked' | 'main-renamed') so a falsifier can
 * simulate a crash at that exact boundary by throwing.
 */
export function rehearseCoupledRestore(
  cloneDb: string,
  backupPath: string,
  opts: { onStep?: (step: 'temp-written' | 'sidecars-unlinked' | 'main-renamed') => void } = {},
): As01CoupledRestore {
  const backupHash = dbFileSetHash(backupPath);
  const temp = `${cloneDb}.restore.tmp`;
  copyFileSync(backupPath, temp);
  // Flush the temp bytes before the rename — a rename of unflushed bytes is not durable.
  const tempFd = openSync(temp, 'r+');
  try {
    fsyncSync(tempFd);
  } finally {
    closeSync(tempFd);
  }
  const integrityTemp = integrityCheck(temp);
  if (integrityTemp !== 'ok') {
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    return { ok: false, backupHash, restoredHash: '', integrityAfter: integrityTemp };
  }
  opts.onStep?.('temp-written');
  // Discard the clone's stale write-ahead log BEFORE replacing main. A crash here
  // leaves the migrated clone with no -wal — still valid, restore simply re-runs.
  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(`${cloneDb}${suffix}`);
    } catch { /* absent component: nothing to discard */ }
  }
  // Make the sidecar removal DURABLE before the rename: unlink and rename are both
  // directory-metadata ops and may be reordered on a power-loss crash. fsyncing the
  // directory here guarantees the -wal/-shm are gone before main is replaced, so no
  // crash can leave the restored-backup main paired with a surviving stale -wal.
  fsyncDir(dirname(cloneDb));
  opts.onStep?.('sidecars-unlinked');
  renameSync(temp, cloneDb); // atomic main-file replacement, no stale -wal to replay
  opts.onStep?.('main-renamed');
  fsyncDir(dirname(cloneDb));
  const restoredHash = dbFileSetHash(cloneDb);
  const integrityAfter = integrityCheck(cloneDb);
  return {
    ok: restoredHash === backupHash && integrityAfter === 'ok',
    backupHash,
    restoredHash,
    integrityAfter,
  };
}

export type OldBinaryOutcome = 'rejected_no_write' | 'accepted' | 'wrote_dangerous' | 'inconclusive';

/**
 * Classify the old binary's observation. The EXPECTED behavior (candidate §5) is
 * a REJECTION of the future schema with a DatabaseCompatibilityError and no
 * write — that is the ONLY pass path. Anything else is a distinct outcome; a
 * missing npm / crash / timeout / unrelated failure is `inconclusive`, never
 * conflated with the designed rejection.
 */
export function classifyOldBinaryOutcome(obs: {
  status: number | null;
  signal: string | null;
  spawnError: boolean;
  stdout: string;
  stderr: string;
  wrote: boolean;
}): OldBinaryOutcome {
  if (obs.wrote) return 'wrote_dangerous';
  if (obs.spawnError || obs.signal !== null) return 'inconclusive';
  if (obs.status === 0) return 'accepted';
  // 126/127 are shell/exec-not-found codes (a missing script/binary), never a
  // schema rejection.
  if (obs.status === 126 || obs.status === 127) return 'inconclusive';
  const text = `${obs.stdout}\n${obs.stderr}`;
  // Tooling / environment failures that merely MENTION the reason string are not a
  // schema rejection (e.g. `npm ERR! missing script: future_schema`).
  if (/npm ERR!|missing script|command not found|MODULE_NOT_FOUND|[Cc]annot find module/.test(text)) {
    return 'inconclusive';
  }
  // The expected rejection is the old binary's DatabaseCompatibilityError contract:
  // the error CLASS and the `future_schema` reason together (AND, not OR). The
  // EXACT string/ceiling contract is confirmable only at the owner-gated real run
  // against the pinned old release; this is the strongest gate provable in-harness.
  if (/DatabaseCompatibilityError/.test(text) && /future_schema/.test(text)) {
    return 'rejected_no_write';
  }
  return 'inconclusive';
}

/**
 * Default egress probe (synchronous). Attempts a short TCP connect to a public
 * resolver; a successful connect proves egress is reachable → NOT isolated.
 * Runs a child `node -e` so the whole CLI stays synchronous. Only ever called on
 * the `--network-isolated` path; tests inject a deterministic stub.
 */
function defaultProbeEgress(): boolean {
  const probe = "const s=require('net').connect({host:'1.1.1.1',port:53});"
    + "s.setTimeout(1500);"
    + "s.on('connect',()=>{s.destroy();process.exit(0)});"
    + "s.on('timeout',()=>{s.destroy();process.exit(1)});"
    + "s.on('error',()=>process.exit(1));";
  const r = spawnSync(process.execPath, ['-e', probe], { timeout: 5000 });
  return r.status === 0; // connected ⇒ egress reachable ⇒ not isolated
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
    'With --confirm it migrates the CLONE startSchema -> target (integrity, counts,',
    'read-only smoke). The DECISIVE old-binary schema check additionally requires',
    '--network-isolated; WITHOUT it the run is INCOMPLETE (exit 2), never a pass.',
    '',
    'The old binary runs in a sandbox HOME + npm cache (no live config), with an',
    'egress probe that REFUSES if the network is reachable (isolation can be',
    'disproven, never proven). Exit codes: 0 expected-rejection+restore-proven,',
    '1 inconclusive, 2 incomplete(skipped), 3 accepted(owner decision), 4 wrote(danger).',
  ].join('\n');
}

export interface As01Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface OldBinaryObservation {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: boolean;
  stdout: string;
  stderr: string;
}

/** Default old-binary runner: the release's OWN `npm run <script>` (real transport). */
function defaultRunOldBinary(spec: { scriptName: string; releaseDir: string; env: Record<string, string> }): OldBinaryObservation {
  const r: SpawnSyncReturns<string> = spawnSync('npm', ['run', spec.scriptName], {
    cwd: spec.releaseDir, env: spec.env, encoding: 'utf8', timeout: 600_000,
  });
  return { status: r.status, signal: r.signal ?? null, error: r.error !== undefined, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export interface As01Options {
  /** Injected egress prober (tests). Returns true when egress is reachable. */
  probeEgress?: () => boolean;
  /**
   * Injected old-binary runner. Default runs the release's `npm run <script>`;
   * tests inject a runner that spawns the fake directly (no npm subprocess tree),
   * keeping the write-delta observation real while removing npm from the suite.
   */
  runOldBinary?: (spec: { command: string; scriptName: string; releaseDir: string; env: Record<string, string> }) => OldBinaryObservation;
}

export function runAs01RehearsalCli(argv: readonly string[], io: As01Io, opts: As01Options = {}): number {
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
    return AS01_EXIT.INCONCLUSIVE;
  }
  io.out(`AS-01 rehearsal plan:`);
  io.out(`  release-dir : ${plan.releaseDir}`);
  io.out(`  clone-db    : ${plan.cloneDb}`);
  io.out(`  script      : ${plan.scriptName} => ${plan.resolvedCommand}`);
  io.out(`  start-schema: ${startSchema} -> target ${CURRENT_SCHEMA_MIGRATION}`);
  if (!confirm) {
    io.out('DRY-RUN — nothing migrated or executed. --confirm migrates the clone; --network-isolated additionally runs the decisive old-binary check.');
    return AS01_EXIT.PASS;
  }

  // Snapshot the clone BEFORE migration — the coupled-restore baseline (the
  // migration mutates in place, so the pre-migration bytes must be captured now).
  // A COHERENT snapshot (VACUUM INTO) captures committed WAL content (F1/r12). The
  // dest is harness-derived (fixed name inside the rehearsal sandbox), never an
  // operator argv path, so snapshotDbCoherent's unconditional dest unlink is safe.
  const backupPath = join(realpathSync(rehearsalDir), 'pre-migration.bak');
  snapshotDbCoherent(plan.cloneDb, backupPath);

  // Migrate the clone forward (mutates the CLONE — the rehearsal). No network, no send.
  const migration = rehearseCloneMigration(plan.cloneDb, { startSchema });
  io.out(`  migrated    : ${migration.startSchema} -> ${migration.targetSchema}`);
  io.out(`  integrity   : before=${migration.integrityBefore} after=${migration.integrityAfter}`);
  io.out(`  counts      : ${JSON.stringify(migration.countsBefore)} -> ${JSON.stringify(migration.countsAfter)} preserved=${migration.countsPreserved}`);
  io.out(`  triggers    : before=${migration.triggersBefore.length} after=${migration.triggersAfter.length} preserved=${migration.triggersPreserved}`);
  io.out(`  smoke(ro)   : ${migration.readOnlySmokeOk}`);
  io.out(`  clone-hash  : ${migration.migratedCloneHash}`);
  // F4 — the CLI must HONOR the migration verdict, not just `reason`. A migration
  // that ended not-ok (integrity/smoke/counts/triggers/target-schema) never
  // proceeds to the decisive old-binary step.
  if (migration.reason !== null || !migration.ok || migration.targetSchema !== CURRENT_SCHEMA_MIGRATION) {
    io.err(`AS-01 migration rehearsal refused: reason=${migration.reason ?? 'not_ok'} `
      + `ok=${migration.ok} target=${migration.targetSchema} countsPreserved=${migration.countsPreserved} `
      + `triggersPreserved=${migration.triggersPreserved}`);
    return AS01_EXIT.INCONCLUSIVE;
  }

  // The DECISIVE old-binary step requires operator-attested network isolation.
  // WITHOUT it, the rehearsal is INCOMPLETE — not a pass (F4).
  if (!networkIsolated) {
    io.out('OLD-BINARY STEP INCOMPLETE — pass --network-isolated to run the decisive old-release schema check. This run does NOT pass.');
    return AS01_EXIT.INCOMPLETE;
  }

  // Network isolation is a CHECKED precondition (fail-closed): a reachable egress
  // DISPROVES isolation. A failed probe is consistent-with-isolation, not proof.
  const probeEgress = opts.probeEgress ?? defaultProbeEgress;
  if (probeEgress()) {
    io.err('AS-01 refused: egress is reachable — --network-isolated is contradicted (isolation can be disproven, not proven).');
    return AS01_EXIT.INCONCLUSIVE;
  }

  // Isolate the old binary: a sandbox HOME + npm cache so it cannot load the
  // operator's live config; only PATH is inherited.
  const sandboxHome = join(realpathSync(rehearsalDir), 'old-binary-home');
  const npmCache = join(sandboxHome, '.npm');
  mkdirSync(npmCache, { recursive: true });
  const childEnv: Record<string, string> = { [plan.dbEnvVar]: plan.cloneDb, HOME: sandboxHome, npm_config_cache: npmCache };
  const pathValue = process.env.PATH;
  if (pathValue !== undefined) childEnv.PATH = pathValue;

  const runOldBinary = opts.runOldBinary ?? defaultRunOldBinary;
  const result = runOldBinary({ command: plan.resolvedCommand!, scriptName: plan.scriptName, releaseDir: plan.releaseDir, env: childEnv });
  // F1 — WAL-aware write-delta: the file-SET hash makes a WAL-only write visible.
  const hashAfterOldBinary = dbFileSetHash(plan.cloneDb);
  const wrote = hashAfterOldBinary !== migration.migratedCloneHash;
  const outcome = classifyOldBinaryOutcome({
    status: result.status,
    signal: result.signal,
    spawnError: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
    wrote,
  });
  io.out(`  old-binary  : exit=${result.status ?? 'signal'} wrote=${wrote} outcome=${outcome}`);
  if (result.stdout) io.out(result.stdout.slice(-2048));
  if (result.stderr) io.err(result.stderr.slice(-2048));

  switch (outcome) {
    case 'rejected_no_write': {
      // Expected: prove the coupled restore branch before calling it a pass.
      const restore = rehearseCoupledRestore(plan.cloneDb, backupPath);
      io.out(`  restore     : ok=${restore.ok} integrity=${restore.integrityAfter} hash=${restore.restoredHash === restore.backupHash}`);
      if (!restore.ok) {
        io.err('AS-01 INCONCLUSIVE — old binary rejected as expected but the coupled restore could not be proven.');
        return AS01_EXIT.INCONCLUSIVE;
      }
      io.out('AS-01 PASS — old binary rejected the future schema with no write, and the coupled restore is byte-exact.');
      return AS01_EXIT.PASS;
    }
    case 'accepted':
      io.out('AS-01 ACCEPTED — old binary ran on the new schema without writing. Rollback is a binary swap; owner must decide (not the expected rejection).');
      return AS01_EXIT.ACCEPTED;
    case 'wrote_dangerous':
      io.err('AS-01 DANGEROUS — old binary WROTE to the migrated clone. A live rollback would require a coupled DB restore.');
      return AS01_EXIT.WROTE_DANGEROUS;
    case 'inconclusive':
    default:
      io.err('AS-01 INCONCLUSIVE — the old-binary observation could not be classified (missing npm, crash, timeout, or unrecognized failure).');
      return AS01_EXIT.INCONCLUSIVE;
  }
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
    process.exitCode = AS01_EXIT.INCOMPLETE;
  }
}
