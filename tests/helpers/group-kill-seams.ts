/**
 * Injected group-kill functions for harnesses that kill a whole process group (issue 3568).
 *
 * After a group kill, macOS can answer kill(-pgid) with EPERM while every member has exited but
 * is not yet reaped. A real EPERM cannot be arranged in-process, so tests inject the group kill.
 * Every helper here signals only a negative group id below -1, never 0 or -1.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { GroupMembership } from '../../src/lib/process-group-membership.ts';

export type GroupSignalSeam = (target: number, signal: NodeJS.Signals) => void;
/** The membership probe's answer; the one definition lives in src/lib. */
export type GroupMembershipAnswer = GroupMembership;

export function groupKillError(code: 'EPERM' | 'ESRCH' | 'EINVAL'): NodeJS.ErrnoException {
  const error = new Error(`kill ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = 'kill';
  return error;
}

/**
 * The macOS shape of issue 3568: the signal reaches the group, then kill(-pgid) answers with an
 * error. Delivering first keeps the fixture group from leaking.
 */
export function deliverThenThrow(code: 'EPERM' | 'ESRCH', targets: number[]): GroupSignalSeam {
  return (target, signal) => {
    targets.push(target);
    if (target < -1) {
      try { process.kill(target, signal); } catch { /* the group may already be gone */ }
    }
    throw groupKillError(code);
  };
}

/** No signal reaches the group, so a live member stays live for the real `ps` probe. */
export function throwOnly(code: 'EPERM' | 'EINVAL', targets: number[]): GroupSignalSeam {
  return (target) => {
    targets.push(target);
    throw groupKillError(code);
  };
}

/**
 * The leader dies and a member survives: the first call SIGKILLs only the group leader (the
 * positive pid), then every call answers EPERM. A later call signals nothing, because by then the
 * leader may have been reaped and its pid reused.
 */
export function killLeaderOnceThenEperm(targets: number[]): GroupSignalSeam {
  let leaderSignalled = false;
  return (target, signal) => {
    targets.push(target);
    if (!leaderSignalled && target < -1) {
      leaderSignalled = true;
      try { process.kill(-target, signal); } catch { /* the leader may already be gone */ }
    }
    throw groupKillError('EPERM');
  };
}

/**
 * Kills a fixture group that a test left alive on purpose. Call it only while a member is known
 * to be alive: a live member keeps the group id allocated, so it cannot have been reused.
 */
export function reapFixtureGroups(targets: readonly number[]): void {
  for (const target of new Set(targets)) {
    if (target >= -1) continue;
    try { process.kill(target, 'SIGKILL'); } catch { /* the group is already gone */ }
  }
}

/**
 * How long a fixture grandchild lives if its test's teardown never kills it. It only stops a leak:
 * every test kills its grandchild in teardown, long before this.
 */
const FIXTURE_LEAK_NET_MS = 60_000;

/**
 * Source for a resolver that spawns one grandchild and writes the grandchild's pid to `pidFile`
 * before it prints anything. So the pid is known before any group kill or membership probe runs.
 * - `holdStdio`: the grandchild inherits the resolver's stdout and stderr, so `close` cannot fire
 *   while it lives.
 * - `setsid`: the grandchild is spawned `detached: true`, so it leaves the resolver's process group.
 * - `block`: the resolver keeps running after its output, so only the watchdog ends it.
 */
export function grandchildResolverSource(
  pidFile: string,
  shape: { holdStdio: boolean; setsid: boolean; block: boolean },
): string {
  const hold = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${FIXTURE_LEAK_NET_MS})`;
  const options = `{stdio:${shape.holdStdio ? '["ignore","inherit","inherit"]' : '"ignore"'},detached:${shape.setsid}}`;
  return [
    'const cp=require("node:child_process");const fs=require("node:fs");',
    `const gc=cp.spawn(process.execPath,["-e",${JSON.stringify(hold)}],${options});`,
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(gc.pid));gc.unref();`,
    'process.stdout.write("processed "+process.argv[2]+" with a grandchild\\n");',
    // The block ends at the leak net too, so a resolver whose watchdog never fires cannot live forever.
    shape.block ? `setTimeout(function(){},${FIXTURE_LEAK_NET_MS});` : '',
  ].join('');
}

/** The pid a fixture resolver wrote, or undefined when the file is missing or unreadable. */
export function readFixturePid(pidFile: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when `ps` reports `pid` as a zombie. A killed fixture grandchild is an orphan that only
 * PID 1 reaps; where PID 1 does not reap orphans (some CI containers), it stays a zombie, and
 * kill(pid, 0) still succeeds on Linux.
 */
function isZombie(pid: number): boolean {
  // Its own short bound, so one hung `ps` cannot stretch a teardown much past waitForPidGone's bound.
  const listing = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1_000 });
  // macOS appends flag characters to the state letter, so only the first character counts.
  return listing.status === 0 && typeof listing.stdout === 'string' && listing.stdout.trim().startsWith('Z');
}

/**
 * Structured timing exemption (test-integrity `js-sleep-in-test`): a fixture process killed in
 * teardown exits on the kernel's schedule, and only polling kill(pid, 0) observes that. The poll
 * has its own bound, so a teardown never waits on the test timeout. ESRCH, or a `Z` state from
 * `ps`, means the pid is gone: a zombie runs nothing. Any other answer, EPERM included, means the
 * pid is still present.
 */
export async function waitForPidGone(pid: number, boundMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (isZombie(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Structured timing exemption (test-integrity `js-sleep-in-test`): bounds a run that must settle
 * by itself. A hang then fails the test with `message` before the test timeout, and the test's
 * own teardown still runs.
 */
export function settleWithin<T>(promise: Promise<T>, boundMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), boundMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
