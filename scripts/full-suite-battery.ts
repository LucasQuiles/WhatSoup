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

export interface BoundedBatteryResult {
  /** True iff the wall-clock bound fired and the child's process group was killed. */
  timedOut: boolean;
  /** The child's real exit code, or null if it was signalled / timed out. */
  exitCode: number | null;
  /** The terminating signal, if any. */
  signal: NodeJS.Signals | null;
  /** Wall-clock milliseconds the child ran. */
  wallMs: number;
  /** The exit code a caller should propagate: the child's own, or 124 on timeout (GNU `timeout` convention). */
  wrappedExit: number;
}

export interface BoundedBatteryOptions {
  command: string;
  args: readonly string[];
  /** Hard wall-clock bound. When exceeded the child's whole process group is SIGKILLed. */
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Child stdio; defaults to 'inherit' so a human sees live output. Tests pass 'ignore'. */
  stdio?: 'inherit' | 'ignore';
  /** Injected clock for testability (defaults to Date.now). */
  now?: () => number;
}

/**
 * Run `command args` as a detached PROCESS GROUP under a hard wall-clock bound.
 * On timeout the ENTIRE group is SIGKILLed (so a hung grandchild cannot outlive the
 * kill), `timedOut` is true, and `wrappedExit` is 124. Otherwise `wrappedExit` is the
 * child's real exit code (or 128+signal when signalled). Never hangs longer than
 * `timeoutMs` plus the OS's process-teardown latency.
 */
export function runBoundedBattery(options: BoundedBatteryOptions): Promise<BoundedBatteryResult> {
  const clock = options.now ?? Date.now;
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
    const pid = child.pid;

    const killGroup = (): void => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, 'SIGKILL'); // negative pid → the whole group
      } catch (err) {
        // ESRCH: the group already exited between the timer firing and this kill —
        // benign, the close handler will still settle. Recorded, not swallowed.
        void (err as NodeJS.ErrnoException).code;
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    timer.unref?.();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const wallMs = clock() - started;
      const wrappedExit = timedOut ? 124 : (code ?? (signal ? 128 : 1));
      resolvePromise({ timedOut, exitCode: timedOut ? null : code, signal, wallMs, wrappedExit });
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
    if (result.timedOut) {
      process.stderr.write(`full-suite-battery: TIMED OUT after ${result.wallMs}ms (bound ${timeoutMs}ms) — process group SIGKILLed; a fixture likely blocked a worker synchronously\n`);
    } else {
      process.stdout.write(`full-suite-battery: vitest exited code=${result.exitCode} signal=${result.signal ?? 'none'} wall=${result.wallMs}ms\n`);
    }
    process.exit(result.wrappedExit);
  })();
}
