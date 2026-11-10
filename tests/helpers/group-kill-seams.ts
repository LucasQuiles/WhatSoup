/**
 * Injected group-kill functions for harnesses that kill a whole process group (issue 3568).
 *
 * After a group kill, macOS can answer kill(-pgid) with EPERM while every member has exited but
 * is not yet reaped. A real EPERM cannot be arranged in-process, so tests inject the group kill.
 * Every helper here signals only a negative group id below -1, never 0 or -1.
 */

export type GroupSignalSeam = (target: number, signal: NodeJS.Signals) => void;
export type GroupMembershipAnswer = 'live' | 'no-live-members' | 'unknown';

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
 * Kills a fixture group that a test left alive on purpose. Call it only while a member is known
 * to be alive: a live member keeps the group id allocated, so it cannot have been reused.
 */
export function reapFixtureGroups(targets: readonly number[]): void {
  for (const target of new Set(targets)) {
    if (target >= -1) continue;
    try { process.kill(target, 'SIGKILL'); } catch { /* the group is already gone */ }
  }
}
