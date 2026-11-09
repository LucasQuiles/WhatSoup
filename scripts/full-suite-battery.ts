/**
 * full-suite-battery — an EXTERNALLY bounded full-suite runner (round-17 finding 5).
 *
 * WHY THIS EXISTS. A round-16 verification battery hung for ~72 minutes inside one
 * fixture's synchronous `execFileSync('git', …)` (a starved `git hash-object` blocked
 * on `index.lock` under concurrent load). Vitest's per-test timeout is ASYNC and
 * structurally CANNOT interrupt a synchronous `execFileSync` blocking a worker thread,
 * so the whole battery wedged and produced no truthful completion signal until a human
 * killed the stuck subprocess. The estate's global watchdog doctrine already covers
 * "kill a hung subprocess"; what was missing is enforcement in THIS repository's own
 * battery harness. This runner supplies it: a hard wall-clock bound around the vitest
 * child's PROCESS GROUP, so a single hung fixture converts a silent 72-minute wedge
 * into a fast, truthful, attributable non-zero exit.
 *
 * It deliberately does NOT touch the offending fixture: bounding the harness needs no
 * per-fixture change and is itself testable (a child that sleeps past the bound is
 * killed and reported), whereas a per-fixture `timeout` on a shared helper used by
 * dozens of unowned tests cannot be red-tested (git cannot be made to hang on demand).
 */
import { spawn, spawnSync, type StdioOptions } from 'node:child_process';
import { constants as osConstants } from 'node:os';

import { SIGNAL } from '../src/lib/signals.ts';
import {
  assertRepositoryInputUnchanged,
  captureRepositoryInputSnapshot,
  establishSourceMutationAnchor,
} from './lib/source-mutation.ts';

/**
 * The semantic outcome — kept DISTINCT from the exit code so an INCONCLUSIVE result
 * (the bound fired but the group could not be proven reaped) is never reportable as a
 * battery pass OR as a code failure (round-18 finding 3 / reviewer's timeout-as-
 * inconclusive alignment).
 */
export type BoundedBatteryOutcome = 'passed' | 'failed' | 'timedOut' | 'inconclusive';

export interface BoundedBatteryResult {
  /** Semantic outcome; the authoritative verdict a consumer must branch on. */
  outcome: BoundedBatteryOutcome;
  /** True iff the wall-clock bound fired. */
  timedOut: boolean;
  /** The child's real exit code, or null if it was signalled / timed out / inconclusive. */
  exitCode: number | null;
  /** The terminating signal, if any. */
  signal: NodeJS.Signals | null;
  /** Wall-clock milliseconds the child ran. */
  wallMs: number;
  /**
   * The exit code a caller should propagate: the child's own (or 128+signal when
   * signalled), 124 on timeout (GNU `timeout` convention), or 125 when INCONCLUSIVE
   * (the group kill failed with a non-ESRCH error and the child could not be proven
   * reaped; an EPERM on a group with no live member counts as reaped, issue 3568).
   */
  wrappedExit: number;
  /** Non-fatal group-reap diagnostics (e.g. an EPERM that made the result inconclusive). */
  reapError?: string;
}

export interface BoundedBatteryOptions {
  command: string;
  args: readonly string[];
  /** Hard wall-clock bound. An isolated child group is SIGKILLed; a verified nested child is fail-closed. */
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Share a verified enclosing battery group instead of making a new one. Callers must opt in:
   * a missing, malformed, stale, or unreadable ownership marker fails closed before spawning.
   */
  inheritOuterGroup?: boolean;
  /** Child stdio; diagnostic preserves child output on stderr for callers whose stdout is JSON. */
  stdio?: 'inherit' | 'ignore' | 'pipe' | 'diagnostic';
  /** Injected clock for testability (defaults to Date.now). */
  now?: () => number;
  /** Terminal-grace bound (ms) after a kill before declaring INCONCLUSIVE; overridable for tests. */
  graceMs?: number;
  /**
   * Injected kill function (defaults to `process.kill`). Isolated batteries receive a negative
   * group PID; validated nested batteries receive only their direct child PID. Present so a test
   * can force a reap FAILURE (e.g. EPERM) deterministically. Signature matches `process.kill`.
   */
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  /**
   * Injected group-membership probe, consulted only when the group kill fails with EPERM
   * (issue 3568). Defaults to `probeGroupMembership`, which reads `ps`.
   */
  probeGroup?: (pgid: number) => GroupMembership;
}

/**
 * What a process group holds. `no-live-members` means every member is a zombie, or the group
 * has none: nothing can still run. `unknown` means the probe could not tell, and is treated
 * exactly like `live`.
 */
export type GroupMembership = 'live' | 'no-live-members' | 'unknown';

/**
 * An outer battery marks children with its own PID. A nested battery accepts that marker only
 * when `ps` proves the current process is below a detached child group whose leader is a direct
 * child of that owner. A stale or arbitrary value fails the requested nested run before spawn;
 * it never authorizes a signal to the caller's shell group.
 */
const BATTERY_OWNER_PID_ENV = 'WHATSOUP_BOUNDED_BATTERY_OWNER_PID';

interface ProcessTopologyRow {
  pid: number;
  ppid: number;
  pgid: number;
}

interface VerifiedOuterBattery {
  ownerPid: number;
  groupLeaderPid: number;
}

interface OuterBatteryVerification {
  battery?: VerifiedOuterBattery;
  reason?: string;
}

function readProcessTopology(): Map<number, ProcessTopologyRow> | undefined {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (ps.error !== undefined || ps.status !== 0) return undefined;
  const rows = new Map<number, ProcessTopologyRow>();
  for (const line of ps.stdout.split('\n').map((value) => value.trim()).filter((value) => value !== '')) {
    const [pidField, ppidField, pgidField, ...rest] = line.split(/\s+/);
    if (rest.length !== 0 || !/^\d+$/.test(pidField ?? '') || !/^\d+$/.test(ppidField ?? '') || !/^\d+$/.test(pgidField ?? '')) return undefined;
    const row = { pid: Number(pidField), ppid: Number(ppidField), pgid: Number(pgidField) };
    if (row.pid <= 0 || row.pgid <= 0 || rows.has(row.pid)) return undefined;
    rows.set(row.pid, row);
  }
  return rows.size === 0 ? undefined : rows;
}

/**
 * Return the enclosing battery only after proving all of these live topology facts:
 * the marker names a live owner, that owner directly spawned the current group leader, and this
 * process descends from that leader. A raw inherited environment variable alone is never enough.
 */
function verifyOuterBattery(env: NodeJS.ProcessEnv): OuterBatteryVerification {
  const rawOwnerPid = env[BATTERY_OWNER_PID_ENV];
  if (rawOwnerPid === undefined) return { reason: `${BATTERY_OWNER_PID_ENV} is missing` };
  if (!/^[1-9]\d*$/.test(rawOwnerPid)) return { reason: `${BATTERY_OWNER_PID_ENV} is malformed` };
  const ownerPid = Number(rawOwnerPid);
  if (!Number.isSafeInteger(ownerPid)) return { reason: `${BATTERY_OWNER_PID_ENV} is outside the safe PID range` };

  const rows = readProcessTopology();
  if (rows === undefined) return { reason: 'cannot read process topology' };
  const current = rows?.get(process.pid);
  const groupLeader = current === undefined ? undefined : rows.get(current.pgid);
  const owner = rows?.get(ownerPid);
  if (
    current === undefined
    || groupLeader === undefined
    || owner === undefined
    || groupLeader.pid !== current.pgid
    || groupLeader.ppid !== ownerPid
    || owner.pgid === groupLeader.pid
  ) return { reason: 'owner PID, group leader, and current process do not form a live battery lineage' };

  // A matching PGID is insufficient: make the enclosing leader an actual ancestor, bounded to
  // prevent a malformed `ps` response from creating an unbounded walk.
  let cursor: ProcessTopologyRow | undefined = current;
  for (let hops = 0; cursor !== undefined && hops < 256; hops += 1) {
    if (cursor.pid === groupLeader.pid) return { battery: { ownerPid, groupLeaderPid: groupLeader.pid } };
    if (cursor.ppid === cursor.pid) return { reason: 'process ancestry loops before the claimed group leader' };
    cursor = rows.get(cursor.ppid);
  }
  return { reason: 'current process does not descend from the claimed group leader' };
}

/**
 * Establish the tripwire baseline in the wrapper before it launches test workers. The returned
 * environment replaces any caller-provided anchor with the digest just read from source.
 */
export function prepareBatteryChildEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const anchor = establishSourceMutationAnchor({
    cwd,
    suppliedAnchor: env.WHATSOUP_TRIPWIRE_MAIN_SHA256,
  });
  return { ...env, WHATSOUP_TRIPWIRE_MAIN_SHA256: anchor };
}

/**
 * Bind an outer battery result to the repository inputs that existed before its child launched.
 * The existing per-test src/main.ts tripwire remains responsible for locating in-suite writes.
 */
export async function runBatteryWithRepositoryInputCheck(
  options: BoundedBatteryOptions,
  report: (message: string) => void,
): Promise<BoundedBatteryResult> {
  const cwd = options.cwd ?? process.cwd();
  const snapshot = captureRepositoryInputSnapshot({ cwd });
  try {
    return await runBoundedBattery({ ...options, cwd });
  } finally {
    assertRepositoryInputUnchanged({ cwd, snapshot, stage: 'full-suite-battery', report });
  }
}

/**
 * Classify `ps -A -o pid=,pgid=,stat=` output for process group `pgid`. An empty or malformed
 * listing is `unknown`, never `no-live-members`: a probe that cannot be read must not clear a
 * group.
 */
export function classifyGroupMembership(psOutput: string, pgid: number): GroupMembership {
  const lines = psOutput.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return 'unknown';
  let live = false;
  for (const line of lines) {
    const [pidField, pgidField, stat] = line.split(/\s+/);
    if (stat === undefined || !/^\d+$/.test(pidField ?? '') || !/^\d+$/.test(pgidField ?? '')) return 'unknown';
    if (Number(pgidField) === pgid && !stat.startsWith('Z')) live = true;
  }
  return live ? 'live' : 'no-live-members';
}

/** Default membership probe: one bounded `ps` read. Any failure to read is `unknown`. */
export function probeGroupMembership(pgid: number): GroupMembership {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 5_000 });
  if (ps.error !== undefined || ps.status !== 0) return 'unknown';
  return classifyGroupMembership(ps.stdout, pgid);
}

/** How long to wait for the group to die after a kill before declaring the result inconclusive. */
const REAP_GRACE_MS = 5_000;

/**
 * Run `command args` under a hard wall-clock bound. An unmarked or unverified caller gets a
 * detached process group; a verified nested caller shares its enclosing battery group so an
 * outer cancellation cannot strand a second detached subtree.
 *
 * The ENTIRE group is SIGKILLed on the timeout AND reaped again on a NORMAL close, so a
 * grandchild that a naive runner would leave alive after the child's clean exit is swept
 * (round-18 finding 3). Group-kill errors are classified: `ESRCH` (nothing left to kill)
 * is success; `EPERM` is success only when the membership probe finds no live member
 * (issue 3568); any other error, or an `EPERM` on a live or unprobeable group, means the
 * group could NOT be proven reaped — the result is `inconclusive` (never a pass, never a code failure) after a bounded grace
 * timer, rather than an unbounded wait for a `close` that may never come. Signalled exits
 * map to `128 + signal`. A wrapper `SIGTERM`/`SIGINT` forwards a group kill so the detached
 * child does not outlive its parent. A validated nested timeout/cancellation cannot prove a
 * whole-group reap, so it reports INCONCLUSIVE (125) after force-stopping its direct child.
 */
export function runBoundedBattery(options: BoundedBatteryOptions): Promise<BoundedBatteryResult> {
  const clock = options.now ?? Date.now;
  const graceMs = options.graceMs ?? REAP_GRACE_MS;
  const started = clock();
  const suppliedEnv = options.env ?? process.env;
  const verification = options.inheritOuterGroup ? verifyOuterBattery(suppliedEnv) : undefined;
  if (options.inheritOuterGroup && verification?.battery === undefined) {
    return Promise.resolve({
      outcome: 'inconclusive',
      timedOut: false,
      exitCode: null,
      signal: null,
      wallMs: clock() - started,
      wrappedExit: 125,
      reapError: `nested battery ownership could not be verified: ${verification?.reason ?? 'unknown error'}`,
    });
  }
  return new Promise<BoundedBatteryResult>((resolvePromise, rejectPromise) => {
    const outerBattery = verification?.battery;
    const ownsProcessGroup = !options.inheritOuterGroup;
    // An isolated runner gives its descendants a verifiable owner. A validated nested runner
    // retains the ORIGINAL outer owner so deeper batteries stay in the same reaped group.
    const childEnv = {
      ...suppliedEnv,
      [BATTERY_OWNER_PID_ENV]: String(outerBattery?.ownerPid ?? process.pid),
    };
    const stdio: StdioOptions = options.stdio === 'diagnostic' ? ['inherit', 2, 2] : options.stdio ?? 'inherit';
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: childEnv,
      stdio,
      // A verified descendant shares the enclosing battery's group; a cancellation of that
      // outer owner can then reap this child before it becomes an independently detached leak.
      detached: ownsProcessGroup,
    });
    let timedOut = false;
    let settled = false;
    let reapError: string | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const pid = child.pid;

    // Kill the whole group. Returns true if the group is gone (killed now, or already
    // gone → ESRCH); false if the kill FAILED for another reason (EPERM/…), which the
    // caller must treat as inconclusive rather than silently swallow (the round-17 form
    // swallowed every error, turning an EPERM into an unbounded wait).
    const killSignal = options.kill ?? process.kill;
    const probeGroup = options.probeGroup ?? probeGroupMembership;
    const killTarget = (): boolean => {
      if (pid === undefined) return true;
      try {
        // Never negative-signal a shared group. The enclosing validated battery owns that group;
        // this nested runner may only force-stop its direct child and must report an unproven
        // nested timeout/cancellation as INCONCLUSIVE rather than claiming a full-tree reap.
        killSignal(ownsProcessGroup ? -pid : pid, 'SIGKILL');
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true; // nothing left in the group — success
        if (code === 'EPERM' && ownsProcessGroup) {
          // Issue 3568: after a SIGKILL, macOS can answer kill(-pgid) with EPERM while the
          // group's members have exited but are not yet reaped. Zombies cannot run, so a group
          // with no live member counts as reaped. A live member, or a probe that cannot tell,
          // stays a reap failure.
          const membership = probeGroup(pid);
          if (membership === 'no-live-members') {
            reapError = 'group kill failed: EPERM; the group has no live member (zombies only or empty), treated as reaped';
            return true;
          }
          reapError = `group kill failed: EPERM; group membership probe: ${membership}`;
          return false;
        }
        reapError = `${ownsProcessGroup ? 'group' : 'nested child'} kill failed: ${code ?? (err instanceof Error ? err.message : String(err))}`;
        return false;
      }
    };

    const finish = (outcome: BoundedBatteryOutcome, code: number | null, signal: NodeJS.Signals | null, wrappedExit: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      process.off(SIGNAL.TERM, onSignal);
      process.off(SIGNAL.INT, onSignal);
      process.off(SIGNAL.HUP, onSignal);
      resolvePromise({ outcome, timedOut, exitCode: code, signal, wallMs: clock() - started, wrappedExit, reapError });
    };

    // Arm a TERMINAL grace that force-resolves INCONCLUSIVE (exit 125) if `close` never
    // arrives after we killed the group (round-19 finding 4). Deliberately NOT `.unref()`'d:
    // an unref'd grace timer would let the event loop DRAIN with the promise unsettled, and
    // Node would exit 0 — a false pass, the exact failure the battery exists to prevent.
    // `finish` clears it, so a prompt `close` still wins and reports the real outcome.
    const armTerminalGrace = (why: string): void => {
      if (settled || graceTimer !== undefined) return;
      graceTimer = setTimeout(() => {
        if (reapError === undefined) reapError = why;
        finish('inconclusive', null, null, 125);
      }, graceMs);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTarget(); // the outer owner reaps a validated shared group; otherwise kill our group
      // round-19 finding 4: arm the terminal grace UNCONDITIONALLY — even a successful group
      // kill may not be followed by a `close` (e.g. an escaped descendant holding a stdio
      // pipe), so never wait forever for a `close` that may not come.
      armTerminalGrace('bound fired — awaiting group reap / close');
    }, options.timeoutMs);
    timer.unref?.();

    // Forward a wrapper termination to the detached child group so it cannot outlive us, then
    // arm the SAME terminal grace so the wrapper itself resolves non-zero rather than hanging
    // on a `close` that a failed/partial kill may never deliver (round-19 finding 4).
    let cancelled = false;
    const onSignal = (): void => {
      cancelled = true;
      killTarget();
      armTerminalGrace('wrapper received a termination signal — awaiting reap / close');
    };
    process.on(SIGNAL.TERM, onSignal);
    process.on(SIGNAL.INT, onSignal);
    // round-20 finding 5: SIGHUP (terminal hangup / parent death) must ALSO forward a group
    // kill. Without it a SIGHUP kills the wrapper (exit 129) while the detached child group
    // survives, reparented to PID 1 — an orphaned test run the battery exists to prevent.
    process.on(SIGNAL.HUP, onSignal);

    // Reap an owned group as soon as its leader exits, rather than waiting for a descendant that
    // still holds stdio open to delay `close`. `close` remains the verdict boundary below.
    child.once('exit', () => {
      if (ownsProcessGroup) killTarget();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      process.off(SIGNAL.TERM, onSignal);
      process.off(SIGNAL.INT, onSignal);
      process.off(SIGNAL.HUP, onSignal);
      rejectPromise(err);
    });

    child.on('close', (code, signal) => {
      // Reap the group on EVERY exit — a grandchild can survive the leader's clean exit.
      const reaped = ownsProcessGroup ? killTarget() : true;
      // round-20 finding 4: a REAP FAILURE dominates a timeout. If the group could not be
      // proven reaped (EPERM/…), a descendant may still be alive, so the result is
      // INCONCLUSIVE (125) — NEVER 124 — even when the bound also fired. The previous order
      // returned 124 on a timed-out-AND-EPERM close, hiding a surviving process behind an
      // ordinary-timeout verdict (reviewer's reproduced EPERM case). Check `!reaped` FIRST.
      if (!reaped) { finish('inconclusive', code, signal, 125); return; }
      // A nested runner cannot prove that sibling workers in its shared outer group are gone.
      // Its outer owner will reap that group; until then an internal timeout/cancellation is
      // explicitly INCONCLUSIVE (never a false ordinary timeout or pass).
      if (!ownsProcessGroup && (timedOut || cancelled)) {
        reapError ??= `nested battery shares outer group ${outerBattery?.groupLeaderPid ?? 'unknown'}; direct child stopped but full-group reap is owned by the enclosing battery`;
        finish('inconclusive', null, signal, 125);
        return;
      }
      if (timedOut) { finish('timedOut', null, signal, 124); return; }
      if (signal) { finish('failed', null, signal, 128 + (osConstants.signals[signal] ?? 0)); return; }
      const exitCode = code ?? 1;
      finish(exitCode === 0 ? 'passed' : 'failed', exitCode, null, exitCode);
    });
  });
}

/**
 * Build the `node … vitest run …` argv the battery spawns. `--pool=forks` is the battery's
 * DEFAULT pool, but any caller that already supplies its own `--pool`/`--pool=…` in the
 * passthrough MUST win: vitest's CAC parser rejects a duplicated single-value option
 * (`Error: Expected a single value for option "--pool <pool>", received ["forks","forks"]`)
 * and aborts before running a single test. When round-19 finding 5 rewired the canonical
 * `npm test` (and `coverage:check`) THROUGH this battery with `--pool=forks` hardcoded, every
 * existing gate/CI caller that ALSO passes `--pool=forks` — push-gate curated-tests +
 * coverage:check, `quality.yml` (`npm test -- … --pool=forks`, `coverage:check -- --pool=forks`),
 * `verify:semantic:shadow`, `test:design-guards` — would arg-crash. So add the default pool
 * ONLY when the caller named none; a caller-supplied pool passes through untouched, exactly once.
 *
 * `--poolOptions.*` is deliberately NOT treated as a pool selection (it configures a pool, it
 * does not choose one), so the forks default is still added alongside it.
 */
export function buildVitestArgs(passthrough: readonly string[]): string[] {
  const callerNamedPool = passthrough.some((arg) => arg === '--pool' || arg.startsWith('--pool='));
  return [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    'node_modules/vitest/vitest.mjs',
    'run',
    ...(callerNamedPool ? [] : ['--pool=forks']),
    ...passthrough,
  ];
}

/** GNU sysexits EX_USAGE — signals an invalid battery CONFIGURATION, distinct from a test failure. */
export const EX_USAGE = 64;
/**
 * Default wall-clock bound: 30 minutes. The original 20-minute bound was set
 * when the full suite ran ~8-10 min uncontended; the tree grew into it — on
 * 2026-08-15 a GREEN quality(24.x) coverage run measured wall=1193s of the
 * 1200s bound (0.6% margin), and the next roll on an unrelated diff was
 * SIGKILLed INCONCLUSIVE at the bound with zero failed tests. 30 minutes
 * restores real headroom (~1.5x the observed worst green) while staying far
 * inside the 60-minute job timeout, so a genuinely wedged fixture is still
 * attributed by this battery, not the job killer.
 */
export const DEFAULT_BATTERY_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resolve the wall-clock bound from WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS (round-20 gap). An ABSENT
 * env var uses the default. A PRESENT but non-finite-or-non-positive value is a CONFIGURATION
 * ERROR, never a 0ms bound: `Number('abc')` is NaN, `Number('')` is 0, `Number('-1')` is
 * negative, and `setTimeout` with any of those fires (or is clamped to fire) immediately — a
 * misleading instant "timeout" that reads as a wedged suite. Returns a discriminated result
 * so the CLI exits EX_USAGE with a truthful diagnostic instead of running with a bad bound.
 */
export function resolveBatteryTimeoutMs(raw: string | undefined): { ok: true; timeoutMs: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, timeoutMs: DEFAULT_BATTERY_TIMEOUT_MS };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return {
      ok: false,
      message: `WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS="${raw}" is not a positive finite number of milliseconds — refusing to run with an invalid bound (it would fire an immediate, misleading timeout).`,
    };
  }
  // round-21: setTimeout's delay is a 32-bit signed int; a value ABOVE 2^31-1 (TIMEOUT_MAX)
  // overflows and Node CLAMPS it to 1ms — the exact misleading-instant-timeout this guard exists
  // to prevent (WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS=2147483648 was accepted, then fired at 1ms). Require
  // an integer within [1, TIMEOUT_MAX]; a fractional or over-max value is a config error, not a bound.
  const TIMEOUT_MAX = 2_147_483_647; // 2^31 - 1, Node's setTimeout maximum
  if (!Number.isInteger(n) || n > TIMEOUT_MAX) {
    return {
      ok: false,
      message: `WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS="${raw}" must be an integer in [1, ${TIMEOUT_MAX}] ms — a larger or fractional value overflows setTimeout's 32-bit delay and is clamped to ~1ms (a misleading instant timeout).`,
    };
  }
  return { ok: true, timeoutMs: n };
}

const invokedPath = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === invokedPath || (process.argv[1] ?? '').endsWith('full-suite-battery.ts')) {
  void (async () => {
    // Override the default bound with WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS. An invalid value is a
    // config error (EX_USAGE), not a silent immediate timeout. Extra args after `--` pass
    // through to vitest.
    const timeoutResolution = resolveBatteryTimeoutMs(process.env.WHATSOUP_FULL_SUITE_BATTERY_TIMEOUT_MS);
    if (!timeoutResolution.ok) {
      process.stderr.write(`full-suite-battery: CONFIG ERROR — ${timeoutResolution.message}\n`);
      process.exit(EX_USAGE);
    }
    const timeoutMs = timeoutResolution.timeoutMs;
    const passthrough = process.argv.slice(2);
    let childEnv: NodeJS.ProcessEnv;
    try {
      childEnv = prepareBatteryChildEnv(process.cwd());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`full-suite-battery: TRIPWIRE CONFIG ERROR — ${detail}\n`);
      process.exit(EX_USAGE);
      return;
    }
    let result: BoundedBatteryResult;
    try {
      result = await runBatteryWithRepositoryInputCheck({
        command: process.execPath,
        args: buildVitestArgs(passthrough),
        timeoutMs,
        env: childEnv,
        // Only an enclosing battery supplies this marker. Its malformed/stale form is still an
        // explicit nested request and therefore fails closed in runBoundedBattery.
        inheritOuterGroup: process.env[BATTERY_OWNER_PID_ENV] !== undefined,
      }, (message) => process.stderr.write(`${message}\n`));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const exitCode = detail.startsWith('FINAL-SOURCE drift:') ? 1 : 125;
      process.stderr.write(`full-suite-battery: FINAL-SOURCE ${exitCode === 1 ? 'FAILURE' : 'INCONCLUSIVE'} — ${detail}\n`);
      process.exit(exitCode);
      return;
    }
    if (result.outcome === 'timedOut') {
      process.stderr.write(`full-suite-battery: INCONCLUSIVE (timed out) after ${result.wallMs}ms (bound ${timeoutMs}ms) — group SIGKILLed; a fixture likely blocked a worker synchronously. NOT a pass and NOT a code failure. exit=${result.wrappedExit}\n`);
    } else if (result.outcome === 'inconclusive') {
      process.stderr.write(`full-suite-battery: INCONCLUSIVE — the child could not be proven reaped (${result.reapError ?? 'unknown'}); a leaked process may survive. NOT a pass. exit=${result.wrappedExit}\n`);
    } else {
      process.stdout.write(`full-suite-battery: ${result.outcome} — vitest exited code=${result.exitCode} signal=${result.signal ?? 'none'} wall=${result.wallMs}ms exit=${result.wrappedExit}\n`);
    }
    process.exit(result.wrappedExit);
  })();
}
