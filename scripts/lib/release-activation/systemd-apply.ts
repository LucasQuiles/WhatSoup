/**
 * Mutating half of `release:activate` on Linux (systemd --user). Order:
 * refuse from inside the target unit's cgroup; back up bot.db (quick_check
 * verified), every drop-in and the staged drop-in into a new 0700 directory;
 * write recovery.json and recovery.md bound to the running generation; read
 * that evidence back and validate it; recheck the candidate fence and the
 * generation; then write the drop-in, daemon-reload, restart and verify.
 * Every failure before the drop-in write is `refused` (exit 2) with no
 * daemon-reload, stop or restart.
 *
 * Automatic rollback never starts a predecessor that cannot run: the schema
 * level must be unchanged since the backup and within the predecessor's
 * proven support, and the predecessor must meet the candidate's refresh fence,
 * checked before the unit is stopped and again after. Otherwise the outcome is
 * `rollback-blocked-*`, the new release stays selected, and recovery.md in the
 * backup directory carries the manual steps. The tool never deletes the
 * backup directory.
 *
 * The #2481 binding sample is launchd-specific, so observations here stay
 * `binding: unobserved`; the verdict is report-only and never changes the
 * outcome.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { type ProcessLockHandle, releaseProcessLock } from '../../../src/lib/process-lock.ts';
import { backupSqliteConsistent } from '../sqlite-consistent-backup.ts';
import { readSchemaMigrationLevel } from '../sqlite-schema-level.ts';
import {
  type ApplyOutcome,
  checkSchemaLevel,
  type InstanceProbe,
  type SchemaMigrationRecord,
  type StepRecord,
  utcStamp,
  verifyInstance,
  writeAtomic,
} from './apply.ts';
import type { ActivationHost } from './host.ts';
import { acquireActivationLock } from './lock.ts';
import { bootstrapEntrypointFor, readManifestCommit, recheckCandidateRefreshRollbackFence, recheckRollbackRefreshFenceTarget, sha256 } from './plan.ts';
import { readReleaseSchemaSupport } from './schema-support.ts';
import {
  type AutomaticRollbackAdmission,
  cgroupInsideUnit,
  type DropInFile,
  listDropIns,
  readGeneration,
  readLoadedUnit,
  releaseRootsIn,
  rollbackAdmission,
  sameGeneration,
  type SystemdActivationContext,
  type SystemdGeneration,
  systemctl,
} from './systemd.ts';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
export const RECOVERY_JSON = 'recovery.json';
export const RECOVERY_MD = 'recovery.md';
const STOPPED_STATES = new Set(['inactive', 'failed']);

export interface SystemdApplyOutcome extends ApplyOutcome {
  manager: 'systemd-user';
  generation: SystemdGeneration;
  automaticRollback: AutomaticRollbackAdmission & { route: 'automatic' | 'manual-recovery-only' };
  recovery: { json: string | null; steps: string | null; validated: boolean };
  newDropIn: { name: string; sha256: string } | null;
}

/** What recovery.json records; recovery.md is rendered from exactly this. */
export interface RecoveryRecord {
  schemaVersion: 1;
  tool: 'release:activate';
  manager: 'systemd-user';
  instance: string;
  unit: string;
  backupPath: string;
  generation: {
    releaseRoot: string;
    manifestCommit: string;
    mainPid: number;
    dropInDir: string;
    effectiveDropIn: { name: string; sha256: string };
    dropIns: Array<{ name: string; sha256: string }>;
  };
  candidate: { releaseRoot: string; manifestCommit: string; dropIn: { name: string; sha256: string } };
  database: { livePath: string; backupPath: string; schemaLevel: number; quickCheck: 'ok' };
  automaticRollback: AutomaticRollbackAdmission;
}

function route(admission: AutomaticRollbackAdmission): 'automatic' | 'manual-recovery-only' {
  return admission.available ? 'automatic' : 'manual-recovery-only';
}

export function buildRecoveryRecord(
  context: SystemdActivationContext,
  backupPath: string,
  schemaLevel: number,
  admission: AutomaticRollbackAdmission,
): RecoveryRecord {
  const { generation, staged } = context;
  return {
    schemaVersion: 1,
    tool: 'release:activate',
    manager: 'systemd-user',
    instance: context.args.instance,
    unit: context.unit,
    backupPath,
    generation: {
      releaseRoot: generation.releaseRoot!,
      manifestCommit: generation.manifestCommit!,
      mainPid: generation.mainPid!,
      dropInDir: context.dropInDir,
      effectiveDropIn: { name: generation.effectiveDropIn!.name, sha256: generation.effectiveDropIn!.sha256 },
      dropIns: generation.dropIns.map((file) => ({ name: file.name, sha256: file.sha256 })),
    },
    candidate: {
      releaseRoot: context.args.release,
      manifestCommit: context.newCommit!,
      dropIn: { name: staged!.name, sha256: staged!.sha256 },
    },
    database: { livePath: context.dbPath, backupPath: path.join(backupPath, 'bot.db'), schemaLevel, quickCheck: 'ok' },
    automaticRollback: admission,
  };
}

/** The exact manual recovery steps for one generation, rendered from its record. */
export function renderRecoverySteps(record: RecoveryRecord): string {
  const { unit, generation, candidate, database } = record;
  const db = database.livePath;
  return [
    `# Manual recovery: ${unit} (release:activate, systemd --user)`,
    '',
    `Backup directory: ${record.backupPath} (never deleted by the tool)`,
    `Generation before activation: release ${generation.releaseRoot} (commit ${generation.manifestCommit}), MainPID ${generation.mainPid},`,
    `  effective drop-in ${generation.effectiveDropIn.name} (sha256 ${generation.effectiveDropIn.sha256})`,
    `Candidate: release ${candidate.releaseRoot} (commit ${candidate.manifestCommit}), drop-in ${candidate.dropIn.name} (sha256 ${candidate.dropIn.sha256})`,
    `Database backup: ${database.backupPath} (quick_check ok, schema migration ${database.schemaLevel})`,
    record.automaticRollback.available
      ? 'Automatic rollback: available at plan time.'
      : `Automatic rollback: UNAVAILABLE (${record.automaticRollback.reasons.join('; ')}). Manual recovery is the only route.`,
    '',
    'WARNING: restoring the database loses every message received after the backup; the moved-aside live database is then their only copy. Keep it.',
    '',
    'Only with approval for this instance:',
    '1. Stop the unit and confirm it is down:',
    `     systemctl --user stop ${unit}`,
    `     systemctl --user show ${unit} -p ActiveState -p MainPID   # inactive (or failed), MainPID=0`,
    '2. Restore the drop-in set:',
    `     rm -f ${path.join(generation.dropInDir, candidate.dropIn.name)}`,
    ...generation.dropIns.map((file) => `     install -m 600 ${path.join(record.backupPath, 'dropins', file.name)} ${path.join(generation.dropInDir, file.name)}`),
    `     ls -1 ${generation.dropInDir}   # exactly: ${generation.dropIns.map((file) => file.name).join(' ')}`,
    '3. Restore bot.db while the unit is stopped (move the live file and its sidecars aside together):',
    `     aside=${db}.pre-restore-$(date -u +%Y%m%dT%H%M%SZ); mkdir -m 700 "$aside"`,
    `     mv ${db} ${db}-wal ${db}-shm "$aside"/   # -wal/-shm may be absent`,
    `     cp ${database.backupPath} ${db} && chmod 600 ${db}`,
    '4. Reload the manager:',
    '     systemctl --user daemon-reload',
    `     systemctl --user show ${unit} -p NeedDaemonReload -p ExecStart   # NeedDaemonReload=no; ExecStart names ${generation.releaseRoot}/deploy/whatsoup`,
    '5. Start the unit:',
    `     systemctl --user start ${unit}`,
    `6. Verify from the running process: /proc/<MainPID>/cmdline names ${bootstrapEntrypointFor(generation.releaseRoot)}; authenticated health reports commit ${generation.manifestCommit} and a connected session.`,
    'See docs/runbooks/release-deployment.md, "Activating a release".',
    '',
  ].join('\n');
}

function privateNode(target: string, kind: 'file' | 'dir'): string | null {
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) return `${target} is a symlink`;
    if (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()) return `${target} is not a ${kind === 'dir' ? 'directory' : 'regular file'}`;
    if ((stat.mode & 0o077) !== 0) return `${target} is not private (mode ${(stat.mode & 0o777).toString(8)})`;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return `${target} is not owned by this user`;
    return null;
  } catch (error) {
    return `${target}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function quickCheckReadOnly(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    return rows.length === 1 ? String(Object.values(rows[0] ?? {})[0]) : `rows=${rows.length}`;
  } finally {
    db.close();
  }
}

/**
 * Read the recovery evidence back and prove it: private files, a backup that
 * passes quick_check at the recorded schema level, drop-in copies with the
 * plan's digests, and recovery files that name exactly this generation.
 * Returns why it is invalid, or null.
 */
export function validateRecoveryEvidence(context: SystemdActivationContext, expected: RecoveryRecord): string | null {
  const backupPath = expected.backupPath;
  const nodes: Array<[string, 'file' | 'dir']> = [
    [backupPath, 'dir'],
    [path.join(backupPath, 'dropins'), 'dir'],
    [path.join(backupPath, 'staged'), 'dir'],
    [expected.database.backupPath, 'file'],
    [path.join(backupPath, RECOVERY_JSON), 'file'],
    [path.join(backupPath, RECOVERY_MD), 'file'],
    ...expected.generation.dropIns.map((file): [string, 'file'] => [path.join(backupPath, 'dropins', file.name), 'file']),
    [path.join(backupPath, 'staged', expected.candidate.dropIn.name), 'file'],
  ];
  for (const [target, kind] of nodes) {
    const problem = privateNode(target, kind);
    if (problem !== null) return problem;
  }
  try {
    const verdict = quickCheckReadOnly(expected.database.backupPath);
    if (verdict !== 'ok') return `backup quick_check: ${verdict}`;
    const level = readSchemaMigrationLevel(expected.database.backupPath);
    if (level !== expected.database.schemaLevel) return `backup schema level ${level} differs from recorded ${expected.database.schemaLevel}`;
  } catch (error) {
    return `backup database unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  for (const file of expected.generation.dropIns) {
    if (sha256(readFileSync(path.join(backupPath, 'dropins', file.name))) !== file.sha256) return `drop-in copy ${file.name} differs from the plan`;
  }
  if (sha256(readFileSync(path.join(backupPath, 'staged', expected.candidate.dropIn.name))) !== context.staged!.sha256) {
    return 'staged drop-in copy differs from the plan';
  }
  let recorded: unknown;
  try {
    recorded = JSON.parse(readFileSync(path.join(backupPath, RECOVERY_JSON), 'utf8'));
  } catch {
    return `${RECOVERY_JSON} is not JSON`;
  }
  if (JSON.stringify(recorded) !== JSON.stringify(expected)) return `${RECOVERY_JSON} is not bound to this generation and backup`;
  if (readFileSync(path.join(backupPath, RECOVERY_MD), 'utf8') !== renderRecoverySteps(expected)) {
    return `${RECOVERY_MD} does not carry the steps for this generation and backup`;
  }
  return null;
}

function systemdProbe(host: ActivationHost, context: SystemdActivationContext): InstanceProbe {
  return {
    pid: async () => (await readLoadedUnit(host, context.unit))?.mainPid ?? null,
    argvLine: async (pid) => host.readProcessCmdline?.(pid)?.join(' ') ?? null,
  };
}

/** Drop-in names and digests now, against the plan's set plus (optionally) the staged drop-in. */
function dropInSetFailure(context: SystemdActivationContext, withStaged: boolean): string | null {
  const now = listDropIns(context.dropInDir);
  if (now === null) return 'drop-in directory unreadable';
  const expected: Array<Pick<DropInFile, 'name' | 'sha256'>> = [...context.generation.dropIns];
  if (withStaged) expected.push({ name: context.staged!.name, sha256: context.staged!.sha256 });
  const key = (files: ReadonlyArray<Pick<DropInFile, 'name' | 'sha256'>>): string =>
    files.map((file) => `${file.name} ${file.sha256}`).sort().join('\n');
  return key(now) === key(expected) ? null : 'drop-in set changed outside this activation';
}

/** After daemon-reload: the manager must have loaded the files and select `root`. */
async function loadedSelects(host: ActivationHost, context: SystemdActivationContext, root: string): Promise<string | null> {
  const loaded = await readLoadedUnit(host, context.unit);
  if (loaded === null) return 'systemctl show failed after daemon-reload';
  if (loaded.needDaemonReload !== false) return 'NeedDaemonReload is not "no" after daemon-reload';
  const roots = releaseRootsIn(loaded.execStart.join('\n'), context.releasesDir);
  return roots.length === 1 && roots[0] === root ? null : `loaded ExecStart names ${roots.join(', ') || 'no release root'}, not ${root}`;
}

async function stopUnit(host: ActivationHost, context: SystemdActivationContext): Promise<string | null> {
  const stop = await systemctl(host, 'stop', context.unit);
  if (stop.code !== 0) return `systemctl stop exited ${stop.code}`;
  const loaded = await readLoadedUnit(host, context.unit);
  if (loaded === null || loaded.mainPid !== null || !STOPPED_STATES.has(loaded.activeState ?? '')) {
    return `${context.unit} is not stopped after systemctl stop`;
  }
  return null;
}

/** The predecessor opens the database only at the backup level and within its proven support. Unknown is blocked. */
function rollbackSchemaGate(context: SystemdActivationContext, before: number): { blocked: boolean; after: number | null; afterError: string | null; detail: string } {
  const level = checkSchemaLevel(context.dbPath, before);
  const target = readManifestCommit(context.args.expectCurrent);
  const support = readReleaseSchemaSupport(context.args.expectCurrent, target.error === null ? target.manifest : null);
  const withinSupport = level.after !== null && support.max !== null && level.after <= support.max;
  return {
    blocked: level.changed || !withinSupport,
    after: level.after,
    afterError: level.afterError ?? (support.max === null ? support.detail : null),
    detail: `schema migration ${before} -> ${level.after ?? 'unreadable'}; rollback target ${support.detail}`,
  };
}

export async function applySystemdActivation(host: ActivationHost, context: SystemdActivationContext): Promise<SystemdApplyOutcome> {
  const base = {
    manager: 'systemd-user' as const,
    generation: context.generation,
    automaticRollback: { ...context.automaticRollback, route: route(context.automaticRollback) },
    recovery: { json: null, steps: null, validated: false },
    newDropIn: context.staged === null ? null : { name: context.staged.name, sha256: context.staged.sha256 },
  };
  let lock: ProcessLockHandle;
  try {
    lock = acquireActivationLock(context.home);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return {
      ...base, outcome: 'refused', backupPath: null, steps: [{ step: 'acquire-activation-lock', ok: false, detail: failure }],
      failure, verification: null, schemaMigration: { before: null, after: null, afterError: null, blockedAt: null }, rollback: null,
    };
  }
  try {
    return await applyHoldingLock(host, context, base);
  } finally {
    try { releaseProcessLock(lock); } catch { /* the outcome stands */ }
  }
}

type OutcomeBase = Pick<SystemdApplyOutcome, 'manager' | 'generation' | 'automaticRollback' | 'recovery' | 'newDropIn'>;

async function applyHoldingLock(host: ActivationHost, context: SystemdActivationContext, base: OutcomeBase): Promise<SystemdApplyOutcome> {
  const steps: StepRecord[] = [];
  const { args, staged } = context;
  const schemaMigration: SchemaMigrationRecord = { before: null, after: null, afterError: null, blockedAt: null };
  const outcome = (fields: Pick<SystemdApplyOutcome, 'outcome' | 'backupPath' | 'failure' | 'verification' | 'rollback'>): SystemdApplyOutcome => ({
    ...base, ...fields, steps, schemaMigration,
  });
  const refuse = (failure: string, backupPath: string | null): SystemdApplyOutcome =>
    outcome({ outcome: 'refused', backupPath, failure, verification: null, rollback: null });

  // ---- never from inside the unit this run stops ----
  const inside = cgroupInsideUnit(host.readSelfCgroup?.() ?? null, context.unit);
  steps.push({ step: 'refuse-inside-target-cgroup', ok: inside === false, detail: context.cgroup.detail });
  if (inside !== false) return refuse(`--apply must run outside ${context.unit} (own cgroup ${inside === null ? 'unknown' : 'inside it'})`, null);

  // ---- recovery evidence (no live change) ----
  const backupPath = path.join(args.backupDir!, `activation-${context.newCommit!.slice(0, 12)}-${utcStamp(host.now())}`);
  let record: RecoveryRecord | null = null;
  try {
    mkdirSync(args.backupDir!, { recursive: true, mode: PRIVATE_DIR_MODE });
    mkdirSync(backupPath, { mode: PRIVATE_DIR_MODE });
    const dirProblem = privateNode(backupPath, 'dir');
    if (dirProblem !== null) return refuse(dirProblem, backupPath);
    steps.push({ step: 'create-backup-dir', ok: true });
    const db = await backupSqliteConsistent(context.dbPath, path.join(backupPath, 'bot.db'));
    steps.push({ step: 'backup-database', ok: true, detail: `quick_check ${db.quickCheck}, ${db.pages} pages` });
    const before = readSchemaMigrationLevel(db.backupPath);
    schemaMigration.before = before;
    steps.push({ step: 'record-schema-level', ok: true, detail: `schema migration ${before}` });
    mkdirSync(path.join(backupPath, 'dropins'), { mode: PRIVATE_DIR_MODE });
    for (const file of context.generation.dropIns) {
      const bytes = readFileSync(file.path);
      if (sha256(bytes) !== file.sha256) return refuse(`${file.name} changed since the plan`, backupPath);
      const copy = path.join(backupPath, 'dropins', file.name);
      writeFileSync(copy, bytes, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
      chmodSync(copy, PRIVATE_FILE_MODE);
    }
    mkdirSync(path.join(backupPath, 'staged'), { mode: PRIVATE_DIR_MODE });
    writeFileSync(path.join(backupPath, 'staged', staged!.name), staged!.contents, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    steps.push({ step: 'backup-dropins', ok: true, detail: `${context.generation.dropIns.length} drop-ins` });
    // The backup level, not the plan's read, decides both admissions.
    if (context.schema.candidate.max === null || before > context.schema.candidate.max) {
      return refuse(`database schema ${before} is above candidate support (${context.schema.candidate.detail})`, backupPath);
    }
    const admission = rollbackAdmission(context, before);
    base.automaticRollback = { ...admission, route: route(admission) };
    record = buildRecoveryRecord(context, backupPath, before, admission);
    writeAtomic(path.join(backupPath, RECOVERY_JSON), `${JSON.stringify(record, null, 2)}\n`, PRIVATE_FILE_MODE);
    writeAtomic(path.join(backupPath, RECOVERY_MD), renderRecoverySteps(record), PRIVATE_FILE_MODE);
    base.recovery = { json: path.join(backupPath, RECOVERY_JSON), steps: path.join(backupPath, RECOVERY_MD), validated: false };
    steps.push({ step: 'write-recovery', ok: true });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error), existsSync(backupPath) ? backupPath : null);
  }
  if (record === null) return refuse('recovery record was not written', backupPath);
  let invalid: string | null;
  try {
    invalid = validateRecoveryEvidence(context, record);
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error);
  }
  steps.push(invalid === null ? { step: 'validate-recovery-evidence', ok: true } : { step: 'validate-recovery-evidence', ok: false, detail: invalid });
  if (invalid !== null) return refuse(`recovery evidence invalid: ${invalid}`, backupPath);
  base.recovery.validated = true;

  // ---- prechecks against the live generation ----
  const fence = recheckCandidateRefreshRollbackFence(context);
  steps.push({ step: 'recheck-refresh-rollback-fence-requirement-before-switch', ok: fence.ok, detail: fence.detail });
  if (!fence.ok) return refuse('refresh rollback fence requirement changed or cannot be revalidated before switch', backupPath);
  const now = await readGeneration(host, {
    unit: context.unit, dropInDir: context.dropInDir, releasesDir: context.releasesDir,
    expectCurrent: args.expectCurrent, manifestCommit: context.oldCommit,
  });
  const sameLive = now.checks.every((entry) => entry.ok) && sameGeneration(now.generation, context.generation);
  steps.push({ step: 'recheck-generation-before-switch', ok: sameLive, detail: sameLive ? 'unchanged' : now.checks.filter((entry) => !entry.ok).map((entry) => entry.detail).join('; ') || 'generation changed since the plan' });
  if (!sameLive) return refuse('the running generation changed since the plan', backupPath);

  // ---- switch ----
  let failure: string | null = null;
  let restartIssued = false;
  try {
    writeAtomic(staged!.path, staged!.contents, PRIVATE_FILE_MODE);
    steps.push({ step: 'write-dropin', ok: true, detail: staged!.name });
    const reload = await systemctl(host, 'daemon-reload');
    steps.push({ step: 'daemon-reload', ok: reload.code === 0, ...(reload.code === 0 ? {} : { detail: `exited ${reload.code}` }) });
    if (reload.code !== 0) failure = `daemon-reload exited ${reload.code}`;
    if (failure === null) {
      failure = await loadedSelects(host, context, args.release);
      steps.push(failure === null ? { step: 'verify-loaded-unit', ok: true } : { step: 'verify-loaded-unit', ok: false, detail: failure });
    }
    if (failure === null) {
      restartIssued = true;
      const restart = await systemctl(host, 'restart', context.unit);
      steps.push({ step: 'restart', ok: restart.code === 0, ...(restart.code === 0 ? {} : { detail: `exited ${restart.code}` }) });
      if (restart.code !== 0) failure = `systemctl restart exited ${restart.code}`;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    steps.push({ step: 'switch', ok: false, detail: failure });
  }

  let verification: SystemdApplyOutcome['verification'] = null;
  if (failure === null) {
    const result = await verifyInstance(host, context, systemdProbe(host, context), {
      entrypoint: bootstrapEntrypointFor(args.release),
      commit: context.newCommit,
      previousPid: context.generation.mainPid,
    });
    verification = result.observation;
    steps.push({ step: 'verify-instance', ok: result.ok });
    if (!result.ok) failure = 'instance verification failed: argv, pid, commit, or connection did not match the new release';
  }
  if (failure === null) {
    failure = dropInSetFailure(context, true);
    steps.push(failure === null ? { step: 'verify-dropin-set', ok: true } : { step: 'verify-dropin-set', ok: false, detail: failure });
  }
  if (failure === null) return outcome({ outcome: 'activated', backupPath, failure: null, verification, rollback: null });

  if (!restartIssued) {
    // The predecessor never stopped: removing the drop-in is the whole rollback.
    const rolled = await restoreDropIns(host, context, []);
    const stillRunning = await readGeneration(host, {
      unit: context.unit, dropInDir: context.dropInDir, releasesDir: context.releasesDir,
      expectCurrent: args.expectCurrent, manifestCommit: context.oldCommit,
    });
    const verified = rolled.every((entry) => entry.ok) && stillRunning.checks.every((entry) => entry.ok)
      && stillRunning.generation.mainPid === context.generation.mainPid;
    rolled.push({ step: 'verify-generation-restored', ok: verified });
    return outcome({
      outcome: verified ? 'rolled-back' : 'rollback-unverified', backupPath, failure, verification,
      rollback: { steps: rolled, verified, observation: null, refreshFenceBlockedAt: null },
    });
  }
  return rollbackAfterRestart(host, context, { backupPath, failure, verification, schemaMigration, outcome });
}

/** Remove this run's drop-in (only if it is still exactly ours), daemon-reload, and confirm the manager selects the predecessor. */
async function restoreDropIns(host: ActivationHost, context: SystemdActivationContext, steps: StepRecord[]): Promise<StepRecord[]> {
  const staged = context.staged!;
  try {
    if (existsSync(staged.path)) {
      if (sha256(readFileSync(staged.path)) !== staged.sha256) {
        steps.push({ step: 'remove-dropin', ok: false, detail: `${staged.name} changed outside this activation` });
        return steps;
      }
      unlinkSync(staged.path);
    }
    steps.push({ step: 'remove-dropin', ok: true, detail: staged.name });
  } catch (error) {
    steps.push({ step: 'remove-dropin', ok: false, detail: error instanceof Error ? error.message : String(error) });
    return steps;
  }
  const setFailure = dropInSetFailure(context, false);
  steps.push(setFailure === null ? { step: 'verify-dropin-set-restored', ok: true } : { step: 'verify-dropin-set-restored', ok: false, detail: setFailure });
  if (setFailure !== null) return steps;
  const reload = await systemctl(host, 'daemon-reload');
  steps.push({ step: 'daemon-reload', ok: reload.code === 0, ...(reload.code === 0 ? {} : { detail: `exited ${reload.code}` }) });
  if (reload.code !== 0) return steps;
  const selects = await loadedSelects(host, context, context.args.expectCurrent);
  steps.push(selects === null ? { step: 'verify-loaded-unit', ok: true } : { step: 'verify-loaded-unit', ok: false, detail: selects });
  return steps;
}

async function rollbackAfterRestart(
  host: ActivationHost,
  context: SystemdActivationContext,
  state: {
    backupPath: string;
    failure: string;
    verification: SystemdApplyOutcome['verification'];
    schemaMigration: SchemaMigrationRecord;
    outcome: (fields: Pick<SystemdApplyOutcome, 'outcome' | 'backupPath' | 'failure' | 'verification' | 'rollback'>) => SystemdApplyOutcome;
  },
): Promise<SystemdApplyOutcome> {
  const { backupPath, failure, verification, schemaMigration, outcome } = state;
  const before = schemaMigration.before!;
  const finish = (
    result: SystemdApplyOutcome['outcome'],
    rollback: SystemdApplyOutcome['rollback'],
  ): SystemdApplyOutcome => outcome({ outcome: result, backupPath, failure, verification, rollback });

  // Never start a predecessor that cannot open the database or meet the fence: checked before the stop.
  const gate = rollbackSchemaGate(context, before);
  schemaMigration.after = gate.after;
  schemaMigration.afterError = gate.afterError;
  if (gate.blocked) {
    schemaMigration.blockedAt = 'before-rollback';
    return finish('rollback-blocked-migrated', null);
  }
  const steps: StepRecord[] = [];
  const beforeStop = recheckRollbackRefreshFenceTarget(context);
  steps.push({ step: 'recheck-refresh-rollback-fence-before-instance-stop', ok: beforeStop.ok, detail: beforeStop.detail });
  if (!beforeStop.ok) {
    return finish('rollback-blocked-refresh-fence', { steps, verified: false, observation: null, refreshFenceBlockedAt: 'before-instance-stop' });
  }
  const foreign = dropInSetFailure(context, true);
  steps.push(foreign === null ? { step: 'recheck-dropin-set-before-instance-stop', ok: true } : { step: 'recheck-dropin-set-before-instance-stop', ok: false, detail: foreign });
  if (foreign !== null) return finish('rollback-unverified', { steps, verified: false, observation: null, refreshFenceBlockedAt: null });

  const stopFailure = await stopUnit(host, context);
  steps.push(stopFailure === null ? { step: `stop:${context.unit}`, ok: true } : { step: `stop:${context.unit}`, ok: false, detail: stopFailure });
  if (stopFailure !== null) return finish('rollback-unverified', { steps, verified: false, observation: null, refreshFenceBlockedAt: null });
  // A migration can commit while the new process shuts down.
  const afterStop = rollbackSchemaGate(context, before);
  steps.push({ step: 'recheck-schema-level', ok: !afterStop.blocked, detail: afterStop.detail });
  if (afterStop.blocked) {
    schemaMigration.after = afterStop.after;
    schemaMigration.afterError = afterStop.afterError;
    schemaMigration.blockedAt = 'after-instance-stop';
    return finish('rollback-blocked-migrated', { steps, verified: false, observation: null, refreshFenceBlockedAt: null });
  }
  const afterStopFence = recheckRollbackRefreshFenceTarget(context);
  steps.push({ step: 'recheck-refresh-rollback-fence-after-instance-stop', ok: afterStopFence.ok, detail: afterStopFence.detail });
  if (!afterStopFence.ok) {
    return finish('rollback-blocked-refresh-fence', { steps, verified: false, observation: null, refreshFenceBlockedAt: 'after-instance-stop' });
  }
  await restoreDropIns(host, context, steps);
  if (steps.every((entry) => entry.ok)) {
    const start = await systemctl(host, 'start', context.unit);
    steps.push({ step: `start:${context.unit}`, ok: start.code === 0, ...(start.code === 0 ? {} : { detail: `exited ${start.code}` }) });
  }
  let observation: SystemdApplyOutcome['verification'] = null;
  if (steps.every((entry) => entry.ok)) {
    const result = await verifyInstance(host, context, systemdProbe(host, context), {
      entrypoint: bootstrapEntrypointFor(context.args.expectCurrent),
      commit: context.oldCommit,
      previousPid: null,
    });
    observation = result.observation;
    steps.push({ step: 'verify-instance', ok: result.ok });
  }
  const verified = steps.every((entry) => entry.ok);
  return finish(verified ? 'rolled-back' : 'rollback-unverified', { steps, verified, observation, refreshFenceBlockedAt: null });
}

/** stderr guidance for a blocked rollback: where the steps are, then the steps themselves. */
export function systemdBlockedRollbackMessage(applied: SystemdApplyOutcome): string {
  let steps = '';
  try {
    steps = applied.recovery.steps === null ? '' : readFileSync(applied.recovery.steps, 'utf8');
  } catch {
    steps = '';
  }
  const why = applied.outcome === 'rollback-blocked-migrated'
    ? 'the database schema is changed, unreadable, or above what the previous release opens'
    : 'the previous release cannot meet the candidate refresh rollback fence';
  return [
    '',
    `release:activate: ROLLBACK BLOCKED — ${why}. The previous release was NOT started; the new drop-in stays in place.`,
    `Recovery steps: ${applied.recovery.steps ?? 'not written'}`,
    '',
    steps,
  ].join('\n');
}
