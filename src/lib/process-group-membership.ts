import { spawnSync } from 'node:child_process';

/**
 * What a process group holds. `no-live-members` means every member is a zombie, or the group
 * has none: nothing can still run. `unknown` means the probe could not tell, and is treated
 * exactly like `live`.
 *
 * Darwin answers a group kill with EPERM, not ESRCH, when every member left is an unreaped
 * zombie, so EPERM alone cannot prove a group still runs (issue 3568).
 */
export type GroupMembership = 'live' | 'no-live-members' | 'unknown';

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

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

/**
 * Default membership probe: one bounded `ps` read of the pid, group and state columns only
 * (never arguments). Any failure to read is `unknown`. It blocks the caller for at most
 * `timeoutMs`, so callers use it only on the rare EPERM path. The absolute path keeps a
 * `PATH` entry from substituting a `ps` that reports a live group as reaped.
 */
export function probeGroupMembership(pgid: number, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): GroupMembership {
  const ps = spawnSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: timeoutMs });
  if (ps.error !== undefined || ps.status !== 0) return 'unknown';
  return classifyGroupMembership(ps.stdout, pgid);
}
