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
    const killGroup = (): boolean => {
      if (pid === undefined) return true;
      try {
        process.kill(-pid, 'SIGKILL'); // negative pid → the whole group
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
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
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
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      rejectPromise(err);
    });

    child.on('close', (code, signal) => {
      // Reap the group on EVERY exit — a grandchild can survive the leader's clean exit.
      const reaped = killGroup();
      if (timedOut) { finish('timedOut', null, signal, 124); return; }
      if (!reaped) { finish('inconclusive', code, signal, 125); return; }
      if (signal) { finish('failed', null, signal, 128 + (osConstants.signals[signal] ?? 0)); return; }
      const exitCode = code ?? 1;
      finish(exitCode === 0 ? 'passed' : 'failed', exitCode, null, exitCode);
    });
  });
}

const invokedPath = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === invokedPath || (process.argv[1] ?? '').endsWith('full-suite-battery.ts')) {
  void (async () => {
    // Default bound: 20 minutes. The full suite runs in ~8-10 min uncontended; 20 min
    // absorbs load without ever approaching the 72-minute wedge. Override with
    // FULL_SUITE_BATTERY_TIMEOUT_MS. Extra args after `--` pass through to vitest.
    const timeoutMs = Number(process.env.FULL_SUITE_BATTERY_TIMEOUT_MS ?? 20 * 60 * 1000);
    const passthrough = process.argv.slice(2);
    const result = await runBoundedBattery({
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', '--experimental-strip-types',
        'node_modules/vitest/vitest.mjs', 'run', '--pool=forks', ...passthrough],
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
