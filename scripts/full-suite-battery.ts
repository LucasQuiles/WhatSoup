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
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

import { SIGNAL } from '../src/lib/signals.ts';

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
   * (the group kill failed with a non-ESRCH error and the child could not be reaped).
   */
  wrappedExit: number;
  /** Non-fatal group-reap diagnostics (e.g. an EPERM that made the result inconclusive). */
  reapError?: string;
}

export interface BoundedBatteryOptions {
  command: string;
  args: readonly string[];
  /** Hard wall-clock bound. When exceeded the child's whole process group is SIGKILLed. */
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Child stdio; defaults to 'inherit' so a human sees live output. Tests pass 'ignore'/'pipe'. */
  stdio?: 'inherit' | 'ignore' | 'pipe';
  /** Injected clock for testability (defaults to Date.now). */
  now?: () => number;
  /** Terminal-grace bound (ms) after a kill before declaring INCONCLUSIVE; overridable for tests. */
  graceMs?: number;
  /**
   * Injected group-signal function (defaults to `process.kill`). Present so a test can force a
   * reap FAILURE (e.g. EPERM) deterministically — a real EPERM needs a privilege boundary that
   * cannot be arranged in-process (round-20 finding 4). Signature matches `process.kill`.
   */
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
}

/** How long to wait for the group to die after a kill before declaring the result inconclusive. */
const REAP_GRACE_MS = 5_000;

/**
 * Run `command args` as a detached PROCESS GROUP under a hard wall-clock bound.
 *
 * The ENTIRE group is SIGKILLed on the timeout AND reaped again on a NORMAL close, so a
 * grandchild that a naive runner would leave alive after the child's clean exit is swept
 * (round-18 finding 3). Group-kill errors are classified: `ESRCH` (nothing left to kill)
 * is success; any other error (e.g. `EPERM`) means the group could NOT be proven reaped —
 * the result is `inconclusive` (never a pass, never a code failure) after a bounded grace
 * timer, rather than an unbounded wait for a `close` that may never come. Signalled exits
 * map to `128 + signal`. A wrapper `SIGTERM`/`SIGINT` forwards a group kill so the detached
 * child does not outlive its parent.
 */
export function runBoundedBattery(options: BoundedBatteryOptions): Promise<BoundedBatteryResult> {
  const clock = options.now ?? Date.now;
  const graceMs = options.graceMs ?? REAP_GRACE_MS;
  const started = clock();
  return new Promise<BoundedBatteryResult>((resolvePromise, rejectPromise) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'inherit',
      detached: true, // own process group, so we can kill the whole tree
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
    const killGroup = (): boolean => {
      if (pid === undefined) return true;
      try {
        killSignal(-pid, 'SIGKILL'); // negative pid → the whole group
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true; // nothing left in the group — success
        reapError = `group kill failed: ${code ?? (err instanceof Error ? err.message : String(err))}`;
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
      killGroup(); // kill the whole tree; a successful kill normally makes `close` fire
      // round-19 finding 4: arm the terminal grace UNCONDITIONALLY — even a successful group
      // kill may not be followed by a `close` (e.g. an escaped descendant holding a stdio
      // pipe), so never wait forever for a `close` that may not come.
      armTerminalGrace('bound fired — awaiting group reap / close');
    }, options.timeoutMs);
    timer.unref?.();

    // Forward a wrapper termination to the detached child group so it cannot outlive us, then
    // arm the SAME terminal grace so the wrapper itself resolves non-zero rather than hanging
    // on a `close` that a failed/partial kill may never deliver (round-19 finding 4).
    const onSignal = (): void => {
      killGroup();
      armTerminalGrace('wrapper received a termination signal — awaiting reap / close');
    };
    process.on(SIGNAL.TERM, onSignal);
    process.on(SIGNAL.INT, onSignal);
    // round-20 finding 5: SIGHUP (terminal hangup / parent death) must ALSO forward a group
    // kill. Without it a SIGHUP kills the wrapper (exit 129) while the detached child group
    // survives, reparented to PID 1 — an orphaned test run the battery exists to prevent.
    process.on(SIGNAL.HUP, onSignal);

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
      const reaped = killGroup();
      // round-20 finding 4: a REAP FAILURE dominates a timeout. If the group could not be
      // proven reaped (EPERM/…), a descendant may still be alive, so the result is
      // INCONCLUSIVE (125) — NEVER 124 — even when the bound also fired. The previous order
      // returned 124 on a timed-out-AND-EPERM close, hiding a surviving process behind an
      // ordinary-timeout verdict (reviewer's reproduced EPERM case). Check `!reaped` FIRST.
      if (!reaped) { finish('inconclusive', code, signal, 125); return; }
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
 * Resolve the wall-clock bound from FULL_SUITE_BATTERY_TIMEOUT_MS (round-20 gap). An ABSENT
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
      message: `FULL_SUITE_BATTERY_TIMEOUT_MS="${raw}" is not a positive finite number of milliseconds — refusing to run with an invalid bound (it would fire an immediate, misleading timeout).`,
    };
  }
  // round-21: setTimeout's delay is a 32-bit signed int; a value ABOVE 2^31-1 (TIMEOUT_MAX)
  // overflows and Node CLAMPS it to 1ms — the exact misleading-instant-timeout this guard exists
  // to prevent (FULL_SUITE_BATTERY_TIMEOUT_MS=2147483648 was accepted, then fired at 1ms). Require
  // an integer within [1, TIMEOUT_MAX]; a fractional or over-max value is a config error, not a bound.
  const TIMEOUT_MAX = 2_147_483_647; // 2^31 - 1, Node's setTimeout maximum
  if (!Number.isInteger(n) || n > TIMEOUT_MAX) {
    return {
      ok: false,
      message: `FULL_SUITE_BATTERY_TIMEOUT_MS="${raw}" must be an integer in [1, ${TIMEOUT_MAX}] ms — a larger or fractional value overflows setTimeout's 32-bit delay and is clamped to ~1ms (a misleading instant timeout).`,
    };
  }
  return { ok: true, timeoutMs: n };
}

const invokedPath = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === invokedPath || (process.argv[1] ?? '').endsWith('full-suite-battery.ts')) {
  void (async () => {
    // Override the default bound with FULL_SUITE_BATTERY_TIMEOUT_MS. An invalid value is a
    // config error (EX_USAGE), not a silent immediate timeout. Extra args after `--` pass
    // through to vitest.
    const timeoutResolution = resolveBatteryTimeoutMs(process.env.FULL_SUITE_BATTERY_TIMEOUT_MS);
    if (!timeoutResolution.ok) {
      process.stderr.write(`full-suite-battery: CONFIG ERROR — ${timeoutResolution.message}\n`);
      process.exit(EX_USAGE);
    }
    const timeoutMs = timeoutResolution.timeoutMs;
    const passthrough = process.argv.slice(2);
    const result = await runBoundedBattery({
      command: process.execPath,
      args: buildVitestArgs(passthrough),
      timeoutMs,
    });
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
