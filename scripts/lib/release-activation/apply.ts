/**
 * Mutating half of `release:activate`: back up, switch the wrapper symlink and
 * the staged plists as one step, reload every label, verify from the executing
 * process, and roll back automatically on any failure.
 *
 * The rollback starts the OLD binary, which refuses a database the new
 * release already migrated. So the schema migration level is recorded before
 * the switch and read again before any restore; if it changed, or cannot be
 * read, the rollback stops with the new release in place and the operator
 * restores the database backup by hand (`rollback-blocked-migrated`).
 *
 * Verification never reads configuration. The instance passes only when its
 * NEW pid's argv names `<release>/src/bootstrap.ts` AND authenticated health
 * reports the release manifest's commit and a live WhatsApp connection. A
 * WorkingDirectory-only change produces a healthy process whose argv still
 * names the old release; this check exists to catch exactly that.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  isTransientLaunchdBootstrapError,
  LAUNCHD_BOOTSTRAP_RETRY_DELAY_MS,
  LAUNCHD_BOOTSTRAP_RETRY_LIMIT,
} from '../../../src/fleet/platform.ts';
import { resolveLaunchdReleaseSelection } from '../launchd-release-selector.ts';
import { backupSqliteConsistent } from '../sqlite-consistent-backup.ts';
import { readSchemaMigrationLevel } from '../sqlite-schema-level.ts';
import {
  type ActivationHost,
  classifyAuthenticatedHealth,
  type ExecResult,
  type HealthObservation,
  type RecordedHealth,
} from './host.ts';
import { type Binding, type BindingEvidence, type ProcessSample, resolveBinding } from './invariants.ts';
import {
  type ActivationContext,
  bootstrapEntrypointFor,
  countRenderDriftLines,
  wrapperTargetFor,
} from './plan.ts';

export const VERIFY_POLL_INTERVAL_MS = 3_000;
const EXIT_POLL_INTERVAL_MS = 1_000;
const PRIVATE_FILE_MODE = 0o600;
const PLIST_MODE = 0o644;

export interface StepRecord {
  step: string;
  ok: boolean;
  detail?: string;
}

/** An instance observation as the receipt and stdout record it. */
export interface InstanceObservation {
  pid: number | null;
  argvMatches: boolean;
  health: RecordedHealth | null;
  /**
   * #2481: whether the body is bound to one process generation (see
   * invariants.ts `resolveBinding`). `applyActivation` leaves it `unobserved`;
   * `resolveOutcomeBindings` sets it once the outcome is final. The pids and
   * times behind it are transient. Not part of the pass predicate.
   */
  binding: Binding;
}

/** One poll's observation: the pass predicate's inputs plus the transient binding evidence. */
interface PolledObservation {
  pid: number | null;
  argvMatches: boolean;
  health: HealthObservation | null;
  /** `host.now()` read immediately before the health request was sent; null when none was sent or the clock failed. */
  requestedAtMs: number | null;
}

/** Upper bound on every exec the #2481 binding makes (its own timeout, then SIGKILL). */
export const BINDING_EXEC_TIMEOUT_MS = 5_000;

/** `ps -o lstart=` prints local time in the locale's words: pin both so the text is UTC in English. */
const START_TIME_ENV = { TZ: 'UTC0', LC_ALL: 'C' } as const;

/**
 * The deciding poll's evidence behind each recorded observation, keyed by the
 * observation object. Never recorded: `resolveOutcomeBindings` reads it once
 * the activation outcome is final.
 */
const BINDING_EVIDENCE = new WeakMap<InstanceObservation, { evidence: BindingEvidence; entrypoint: string }>();

/**
 * Schema migration level of the database before activation (read from the
 * backup copy, which is exactly what a restore would put back) and, after a
 * failure, of the live database. The old binary refuses a database above its
 * own ceiling, so any change blocks the automatic rollback.
 */
export interface SchemaMigrationRecord {
  before: number | null;
  after: number | null;
  afterError: string | null;
  /** Where the rollback stopped because the level changed or could not be read. */
  blockedAt: 'before-rollback' | 'after-instance-stop' | null;
}

export interface ApplyOutcome {
  outcome: 'activated' | 'refused' | 'rolled-back' | 'rollback-unverified' | 'rollback-blocked-migrated';
  backupPath: string | null;
  steps: StepRecord[];
  failure: string | null;
  verification: InstanceObservation | null;
  schemaMigration: SchemaMigrationRecord;
  rollback: { steps: StepRecord[]; verified: boolean; observation: InstanceObservation | null } | null;
}

function utcStamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Replace `filePath` with `contents` through a same-directory rename. */
function writeAtomic(filePath: string, contents: string, mode: number): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.activate-${process.pid}`);
  writeFileSync(temporary, contents, { encoding: 'utf8', mode });
  chmodSync(temporary, mode);
  renameSync(temporary, filePath);
}

/** `ln -sfn` without a window where the link is absent. */
function repointSymlink(link: string, target: string): void {
  const temporary = path.join(path.dirname(link), `.${path.basename(link)}.activate-${process.pid}`);
  try { unlinkSync(temporary); } catch { /* no stale temporary link */ }
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

/** Does `argvLine` (ps `command=` output) carry `entry` as a whole argument? */
export function argvNamesEntrypoint(argvLine: string, entry: string): boolean {
  let from = 0;
  for (;;) {
    const index = argvLine.indexOf(entry, from);
    if (index < 0) return false;
    const before = index === 0 ? ' ' : argvLine[index - 1]!;
    const after = argvLine[index + entry.length] ?? ' ';
    if (/\s/.test(before) && /\s/.test(after)) return true;
    from = index + 1;
  }
}

const PID_LINE = /^\tpid = (\d+)$/m;

export async function launchdState(host: ActivationHost, domain: string, label: string):
  Promise<{ loaded: boolean; pid: number | null; definition: string }> {
  const result = await host.exec('launchctl', ['print', `${domain}/${label}`]);
  if (result.code !== 0) return { loaded: false, pid: null, definition: '' };
  const match = PID_LINE.exec(result.stdout);
  return { loaded: true, pid: match ? Number(match[1]) : null, definition: result.stdout };
}

/** bootout → bounded wait for the old pid to exit. Returns a failure string, or null once it is gone. */
async function stopLabel(host: ActivationHost, context: ActivationContext, label: string): Promise<string | null> {
  const { domain } = context;
  const before = await launchdState(host, domain, label);
  if (before.loaded) {
    const bootout = await host.exec('launchctl', ['bootout', `${domain}/${label}`]);
    if (bootout.code !== 0) return `${label}: bootout exited ${bootout.code}`;
  }
  if (before.pid !== null) {
    const deadline = host.now() + context.args.exitTimeoutSeconds * 1_000;
    while (host.isProcessAlive(before.pid) && host.now() < deadline) {
      await host.sleep(EXIT_POLL_INTERVAL_MS);
    }
    if (host.isProcessAlive(before.pid)) {
      return `${label}: old pid ${before.pid} still running ${context.args.exitTimeoutSeconds}s after bootout; refusing to bootstrap`;
    }
  }
  return null;
}

/**
 * bootout → bounded wait for the old pid → bootstrap with bounded retry on the
 * transient error → kickstart -k. Returns a failure string, or null on success.
 */
export async function reloadLabel(
  host: ActivationHost,
  context: ActivationContext,
  label: string,
  plistPath: string,
): Promise<string | null> {
  const { domain } = context;
  const stopFailure = await stopLabel(host, context, label);
  if (stopFailure !== null) return stopFailure;
  for (let attempt = 1; ; attempt += 1) {
    const bootstrap = await host.exec('launchctl', ['bootstrap', domain, plistPath]);
    if (bootstrap.code === 0) break;
    const transient = isTransientLaunchdBootstrapError({ code: bootstrap.code, stderr: bootstrap.stderr });
    if (!transient || attempt >= LAUNCHD_BOOTSTRAP_RETRY_LIMIT) {
      return `${label}: bootstrap exited ${bootstrap.code} after ${attempt} attempt(s)`;
    }
    await host.sleep(LAUNCHD_BOOTSTRAP_RETRY_DELAY_MS);
  }
  const kickstart = await host.exec('launchctl', ['kickstart', '-k', `${domain}/${label}`]);
  if (kickstart.code !== 0) return `${label}: kickstart -k exited ${kickstart.code}`;
  return null;
}

type BoundedExecResult = { kind: 'done'; result: ExecResult } | { kind: 'timeout' } | { kind: 'error' };

/**
 * A #2481 binding exec: bounded by its own timeout (the host kills the child
 * with SIGKILL) and by a timer here, so no host seam can hold the caller past
 * BINDING_EXEC_TIMEOUT_MS. A timeout, a throw and a completed run (whatever
 * its exit code) are told apart.
 */
async function boundedExec(
  host: ActivationHost,
  file: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<BoundedExecResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<BoundedExecResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), BINDING_EXEC_TIMEOUT_MS);
  });
  const run = Promise.resolve()
    .then(() => host.exec(file, args, { timeoutMs: BINDING_EXEC_TIMEOUT_MS, ...(env === undefined ? {} : { env }) }))
    .then(
      (result): BoundedExecResult => (result.timedOut === true ? { kind: 'timeout' } : { kind: 'done', result }),
      (): BoundedExecResult => ({ kind: 'error' }),
    );
  try {
    return await Promise.race([run, expired]);
  } finally {
    clearTimeout(timer);
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * `ps -o lstart=` text under TZ=UTC0 and LC_ALL=C (`Thu Jan  1 00:00:00 2026`)
 * as UTC epoch ms at second resolution; null for anything else, including a
 * date that does not exist or a weekday that does not match it.
 */
export function parseProcessStartTime(text: string): number | null {
  const match = LSTART.exec(text.trim());
  if (match === null) return null;
  const [, weekday, monthName, day, hours, minutes, seconds, year] = match;
  const month = MONTHS.indexOf(monthName!);
  if (month < 0) return null;
  const [d, h, m, s, y] = [day, hours, minutes, seconds, year].map(Number) as [number, number, number, number, number];
  if (h > 23 || m > 59 || s > 59) return null;
  const ms = Date.UTC(y, month, d, h, m, s);
  const date = new Date(ms);
  if (date.getUTCDate() !== d || date.getUTCMonth() !== month || WEEKDAYS[date.getUTCDay()] !== weekday) return null;
  return ms;
}

/** The raw post-outcome sample; argv is matched per observation, against its own release. */
interface RawProcessSample {
  pid: number | null;
  argvLine: string | null;
  startedAtMs: number | null;
}

/**
 * The #2481 sample: launchd pid, argv and start time, every exec bounded,
 * each attempted once. Null when the pid or argv read timed out or threw; a
 * start time that timed out or failed is null and never retried. Called only
 * by `resolveOutcomeBindings`, after the outcome is final.
 */
async function sampleInstanceProcess(host: ActivationHost, context: ActivationContext): Promise<RawProcessSample | null> {
  const print = await boundedExec(host, 'launchctl', ['print', `${context.domain}/${context.instanceLabel}`]);
  if (print.kind !== 'done') return null;
  const match = print.result.code === 0 ? PID_LINE.exec(print.result.stdout) : null;
  if (match === null) return { pid: null, argvLine: null, startedAtMs: null };
  const pid = Number(match[1]);
  const ps = await boundedExec(host, 'ps', ['-p', String(pid), '-o', 'command=']);
  if (ps.kind !== 'done') return null;
  const argvLine = ps.result.code === 0 ? ps.result.stdout.trim() : null;
  const lstart = await boundedExec(host, 'ps', ['-p', String(pid), '-o', 'lstart='], START_TIME_ENV);
  const startedAtMs = lstart.kind === 'done' && lstart.result.code === 0 ? parseProcessStartTime(lstart.result.stdout) : null;
  return { pid, argvLine, startedAtMs };
}

/** Would a sample decide anything for this evidence? Only a passing observation with a diagnostic response. */
function worthSampling(evidence: BindingEvidence): boolean {
  return evidence.pid !== null && evidence.argvMatches && evidence.passed
    && evidence.health?.projection === 'diagnostic' && evidence.requestedAtMs !== null;
}

/**
 * #2481: set the binding of every recorded observation. Call only once the
 * activation outcome and exit code are final: it takes at most one shared
 * sample (three bounded execs, at most 3 x BINDING_EXEC_TIMEOUT_MS), and only
 * when some observation passed with a diagnostic response. An observation that
 * did not pass is never sampled and stays `unobserved`. It changes nothing but
 * the `binding` fields of the copies it returns.
 */
export async function resolveOutcomeBindings(
  host: ActivationHost,
  context: ActivationContext,
  outcome: ApplyOutcome,
): Promise<ApplyOutcome> {
  const pending = [outcome.verification, outcome.rollback?.observation ?? null]
    .map((observation) => (observation === null ? undefined : BINDING_EVIDENCE.get(observation)));
  const raw = pending.some((entry) => entry !== undefined && worthSampling(entry.evidence))
    ? await sampleInstanceProcess(host, context)
    : null;
  const bind = (observation: InstanceObservation | null): InstanceObservation | null => {
    if (observation === null) return null;
    const entry = BINDING_EVIDENCE.get(observation);
    if (entry === undefined) return observation;
    const sample: ProcessSample | null = raw === null ? null : {
      pid: raw.pid,
      argvMatches: raw.argvLine !== null && argvNamesEntrypoint(raw.argvLine, entry.entrypoint),
      startedAtMs: raw.startedAtMs,
    };
    return { ...observation, binding: resolveBinding(entry.evidence, sample) };
  };
  return {
    ...outcome,
    verification: bind(outcome.verification),
    rollback: outcome.rollback === null ? null : { ...outcome.rollback, observation: bind(outcome.rollback.observation) },
  };
}

async function observeInstance(
  host: ActivationHost,
  context: ActivationContext,
  entrypoint: string,
): Promise<PolledObservation> {
  const state = await launchdState(host, context.domain, context.instanceLabel);
  if (state.pid === null) return { pid: null, argvMatches: false, health: null, requestedAtMs: null };
  const ps = await host.exec('ps', ['-p', String(state.pid), '-o', 'command=']);
  const argvMatches = ps.code === 0 && argvNamesEntrypoint(ps.stdout.trim(), entrypoint);
  let health: HealthObservation | null = null;
  let requestedAtMs: number | null = null;
  if (context.healthPort !== null && context.healthToken !== null) {
    // #2481: a synchronous clock read immediately before the request, the only
    // binding work inside the poll. Its own try: a clock fault leaves the
    // binding unobserved and never touches the health read below.
    try {
      requestedAtMs = host.now();
    } catch {
      requestedAtMs = null;
    }
    try {
      const response = await host.fetchHealth(context.healthPort, context.healthToken);
      health = classifyAuthenticatedHealth(response.status, response.body);
    } catch {
      health = {
        projection: 'unobserved', httpStatus: null, commit: null, connected: null, responderPid: null, invariants: null,
      };
    }
  }
  return { pid: state.pid, argvMatches, health, requestedAtMs };
}

/**
 * Record the deciding observation. No exec and no await: the producer-reported
 * pid and the request time go only into the transient binding evidence, and
 * the binding itself is resolved after the outcome (`resolveOutcomeBindings`).
 */
function recordObservation(polled: PolledObservation, passed: boolean, entrypoint: string): InstanceObservation {
  const { health } = polled;
  // Field by field, so nothing added to HealthObservation later reaches the receipt unreviewed.
  const recorded: RecordedHealth | null = health === null ? null : {
    projection: health.projection,
    httpStatus: health.httpStatus,
    commit: health.commit,
    connected: health.connected,
    invariants: health.invariants,
  };
  const observation: InstanceObservation = {
    pid: polled.pid,
    argvMatches: polled.argvMatches,
    health: recorded,
    binding: 'unobserved',
  };
  BINDING_EVIDENCE.set(observation, {
    evidence: {
      pid: polled.pid,
      argvMatches: polled.argvMatches,
      passed,
      health: health === null ? null : { projection: health.projection, responderPid: health.responderPid },
      requestedAtMs: polled.requestedAtMs,
    },
    entrypoint,
  });
  return observation;
}

function instancePasses(
  observation: PolledObservation,
  expected: { commit: string | null; previousPid: number | null },
): boolean {
  if (observation.pid === null || !observation.argvMatches) return false;
  if (expected.previousPid !== null && observation.pid === expected.previousPid) return false;
  const health = observation.health;
  if (health === null || health.projection !== 'diagnostic' || health.connected !== true) return false;
  return expected.commit === null || health.commit === expected.commit;
}

/** Poll until the instance passes or the verify timeout elapses, then record the final observation. */
async function verifyInstance(
  host: ActivationHost,
  context: ActivationContext,
  expected: { entrypoint: string; commit: string | null; previousPid: number | null },
): Promise<{ ok: boolean; observation: InstanceObservation }> {
  const deadline = host.now() + context.args.verifyTimeoutSeconds * 1_000;
  let ok: boolean;
  let polled: PolledObservation;
  for (;;) {
    polled = await observeInstance(host, context, expected.entrypoint);
    if (instancePasses(polled, expected)) { ok = true; break; }
    if (host.now() >= deadline) { ok = false; break; }
    await host.sleep(VERIFY_POLL_INTERVAL_MS);
  }
  return { ok, observation: recordObservation(polled, ok, expected.entrypoint) };
}

async function verifyAuxDefinitions(
  host: ActivationHost,
  context: ActivationContext,
  onRoot: string,
  offRoot: string,
): Promise<string | null> {
  for (const entry of context.staged) {
    if (entry.role !== 'aux') continue;
    const state = await launchdState(host, context.domain, entry.label);
    if (!state.loaded) return `${entry.label}: not loaded after reload`;
    if (!state.definition.includes(`${onRoot}/`) || state.definition.includes(`${offRoot}/`)) {
      return `${entry.label}: loaded definition does not select ${onRoot}`;
    }
  }
  return null;
}

interface SchemaLevelCheck {
  after: number | null;
  afterError: string | null;
  /** True when the level differs from `before` OR could not be read: unknown fails closed. */
  changed: boolean;
}

function checkSchemaLevel(dbPath: string, before: number): SchemaLevelCheck {
  try {
    const after = readSchemaMigrationLevel(dbPath);
    return { after, afterError: null, changed: after !== before };
  } catch (error) {
    return { after: null, afterError: error instanceof Error ? error.message : String(error), changed: true };
  }
}

/**
 * Stop the new instance, then restore and reload. The schema level is read
 * again once the new process has exited, because a migration can commit
 * between the caller's pre-rollback read and bootout; if it changed, nothing
 * is restored and the old binary is never started (`blocked`).
 */
async function rollback(
  host: ActivationHost,
  context: ActivationContext,
  backupPath: string,
  schemaBefore: number,
): Promise<NonNullable<ApplyOutcome['rollback']> & { blocked: SchemaLevelCheck | null }> {
  const steps: StepRecord[] = [];
  const attempt = async (step: string, action: () => Promise<string | null> | string | null): Promise<void> => {
    try {
      const failure = await action();
      steps.push(failure === null ? { step, ok: true } : { step, ok: false, detail: failure });
    } catch (error) {
      steps.push({ step, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  await attempt(`stop:${context.instanceLabel}`, () => stopLabel(host, context, context.instanceLabel));
  if (!steps[0]!.ok) return { steps, verified: false, observation: null, blocked: null };
  const recheck = checkSchemaLevel(context.dbPath, schemaBefore);
  steps.push({
    step: 'recheck-schema-level',
    ok: !recheck.changed,
    detail: recheck.afterError ?? `schema migration ${schemaBefore} -> ${recheck.after}`,
  });
  if (recheck.changed) return { steps, verified: false, observation: null, blocked: recheck };
  await attempt('restore-symlink', () => {
    repointSymlink(context.wrapperLink, readFileSync(path.join(backupPath, 'symlink.before'), 'utf8'));
    return null;
  });
  for (const entry of context.staged) {
    await attempt(`restore-plist:${entry.label}`, () => {
      writeAtomic(entry.plistPath, readFileSync(path.join(backupPath, `${entry.label}.plist`), 'utf8'), PLIST_MODE);
      return null;
    });
  }
  for (const entry of context.staged) {
    await attempt(`reload:${entry.label}`, () => reloadLabel(host, context, entry.label, entry.plistPath));
  }
  const verification = await verifyInstance(host, context, {
    entrypoint: bootstrapEntrypointFor(context.args.expectCurrent),
    commit: context.oldCommit,
    previousPid: null,
  });
  steps.push({ step: 'verify-instance', ok: verification.ok });
  const auxFailure = await verifyAuxDefinitions(host, context, context.args.expectCurrent, context.args.release);
  steps.push(auxFailure === null ? { step: 'verify-aux', ok: true } : { step: 'verify-aux', ok: false, detail: auxFailure });
  return {
    steps,
    verified: steps.every((entry) => entry.ok),
    observation: verification.observation,
    blocked: null,
  };
}

/**
 * Execute an activation whose context already passed every precondition.
 * The only effects before the switch are writes inside the new backup
 * directory; a failure there is a refusal with no live change.
 */
export async function applyActivation(host: ActivationHost, context: ActivationContext): Promise<ApplyOutcome> {
  const steps: StepRecord[] = [];
  const { args } = context;
  const backupPath = path.join(
    args.backupDir!,
    `activation-${context.newCommit!.slice(0, 12)}-${utcStamp(host.now())}`,
  );
  const schemaMigration: SchemaMigrationRecord = { before: null, after: null, afterError: null, blockedAt: null };
  const refuse = (failure: string, recordedBackup: string | null): ApplyOutcome => ({
    outcome: 'refused', backupPath: recordedBackup, steps, failure, verification: null, schemaMigration, rollback: null,
  });

  // ---- backups and staged files (no live change) ----
  try {
    mkdirSync(args.backupDir!, { recursive: true, mode: 0o700 });
    mkdirSync(backupPath, { mode: 0o700 });
    steps.push({ step: 'create-backup-dir', ok: true });
    const db = await backupSqliteConsistent(context.dbPath, path.join(backupPath, 'bot.db'));
    steps.push({ step: 'backup-database', ok: true, detail: `quick_check ${db.quickCheck}, ${db.pages} pages` });
    schemaMigration.before = readSchemaMigrationLevel(db.backupPath);
    steps.push({ step: 'record-schema-level', ok: true, detail: `schema migration ${schemaMigration.before}` });
    writeFileSync(path.join(backupPath, 'symlink.before'), readlinkSync(context.wrapperLink), { mode: PRIVATE_FILE_MODE });
    steps.push({ step: 'record-symlink', ok: true });
    for (const entry of context.staged) {
      const copy = path.join(backupPath, `${entry.label}.plist`);
      copyFileSync(entry.plistPath, copy);
      chmodSync(copy, PRIVATE_FILE_MODE);
      const stagedPath = path.join(backupPath, `${entry.label}.staged.plist`);
      writeFileSync(stagedPath, entry.staged!, { mode: PRIVATE_FILE_MODE });
      const lint = await host.exec('plutil', ['-lint', stagedPath]);
      if (lint.code !== 0) return refuse(`${entry.label}: staged plist failed plutil -lint`, backupPath);
      if (entry.role === 'aux') {
        const selection = resolveLaunchdReleaseSelection(stagedPath);
        if (selection.releasePath !== args.release) {
          return refuse(`${entry.label}: staged plist selects ${selection.releasePath}, not the new release`, backupPath);
        }
      }
      const installed = readFileSync(copy, 'utf8');
      writeFileSync(path.join(backupPath, `${entry.label}.render-drift.txt`), [
        `render drift lines: ${countRenderDriftLines(installed, entry.staged!, args.expectCurrent, args.release)}`,
        '--- installed', installed, '+++ staged', entry.staged!,
      ].join('\n'), { mode: PRIVATE_FILE_MODE });
    }
    steps.push({ step: 'stage-plists', ok: true });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error), existsSync(backupPath) ? backupPath : null);
  }

  const previous = await launchdState(host, context.domain, context.instanceLabel);

  // ---- coordinated switch ----
  let failure: string | null = null;
  try {
    repointSymlink(context.wrapperLink, wrapperTargetFor(args.release));
    steps.push({ step: 'switch-symlink', ok: true });
    for (const entry of context.staged) writeAtomic(entry.plistPath, entry.staged!, PLIST_MODE);
    steps.push({ step: 'install-plists', ok: true });
    for (const entry of context.staged) {
      const reloadFailure = await reloadLabel(host, context, entry.label, entry.plistPath);
      steps.push(reloadFailure === null
        ? { step: `reload:${entry.label}`, ok: true }
        : { step: `reload:${entry.label}`, ok: false, detail: reloadFailure });
      if (reloadFailure !== null) {
        failure = reloadFailure;
        break;
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    steps.push({ step: 'switch', ok: false, detail: failure });
  }

  // ---- verify from the executing process ----
  let verification: InstanceObservation | null = null;
  if (failure === null) {
    const result = await verifyInstance(host, context, {
      entrypoint: bootstrapEntrypointFor(args.release),
      commit: context.newCommit,
      previousPid: previous.pid,
    });
    verification = result.observation;
    steps.push({ step: 'verify-instance', ok: result.ok });
    if (!result.ok) failure = 'instance verification failed: argv, pid, commit, or connection did not match the new release';
  }
  if (failure === null) {
    const auxFailure = await verifyAuxDefinitions(host, context, args.release, args.expectCurrent);
    steps.push(auxFailure === null ? { step: 'verify-aux', ok: true } : { step: 'verify-aux', ok: false, detail: auxFailure });
    failure = auxFailure;
  }

  if (failure === null) {
    return { outcome: 'activated', backupPath, steps, failure: null, verification, schemaMigration, rollback: null };
  }

  // ---- roll back only onto a database the old binary will accept ----
  const schemaBefore = schemaMigration.before!;
  const gate = checkSchemaLevel(context.dbPath, schemaBefore);
  schemaMigration.after = gate.after;
  schemaMigration.afterError = gate.afterError;
  if (gate.changed) {
    schemaMigration.blockedAt = 'before-rollback';
    return { outcome: 'rollback-blocked-migrated', backupPath, steps, failure, verification, schemaMigration, rollback: null };
  }
  const { blocked, ...rolledBack } = await rollback(host, context, backupPath, schemaBefore);
  if (blocked !== null) {
    schemaMigration.after = blocked.after;
    schemaMigration.afterError = blocked.afterError;
    schemaMigration.blockedAt = 'after-instance-stop';
    return { outcome: 'rollback-blocked-migrated', backupPath, steps, failure, verification, schemaMigration, rollback: rolledBack };
  }
  return {
    outcome: rolledBack.verified ? 'rolled-back' : 'rollback-unverified',
    backupPath,
    steps,
    failure,
    verification,
    schemaMigration,
    rollback: rolledBack,
  };
}
