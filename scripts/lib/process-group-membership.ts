/**
 * Process-group membership probe shared by the harnesses that kill a whole process group.
 *
 * Issue 3568: after a group kill, macOS can answer kill(-pgid) with EPERM while every member
 * has exited but is not yet reaped. A caller that sees that EPERM asks this probe whether any
 * member can still run before it counts the group as reaped.
 */
import { spawnSync } from 'node:child_process';

/**
 * What a process group holds. `no-live-members` means every member is a zombie, or the group
 * has none: nothing can still run. `unknown` means the probe could not tell, and is treated
 * exactly like `live`.
 */
export type GroupMembership = 'live' | 'no-live-members' | 'unknown';

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
