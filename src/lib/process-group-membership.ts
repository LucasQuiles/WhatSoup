/**
 * Process-group membership probe shared by the harnesses that kill a whole process group.
 *
 * Issue 3568: after a group kill, macOS can answer kill(-pgid) with EPERM while every member
 * has exited but is not yet reaped. A caller that sees that EPERM asks this probe whether any
 * member can still run before it counts the group as reaped.
 *
 * `groupGone` applies the same rule to a liveness check. Linux, unlike macOS, delivers signal 0
 * to a zombie, so there kill(-pgid, 0) succeeds on a group that holds only zombies. A success
 * therefore cannot prove a live member either, and the probe decides after a success too.
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

/**
 * What `groupGone` found. `membership` is the probe's answer when the probe kept the group;
 * `error` is the code of an unexpected signal-0 error, never its message.
 */
export type GroupGoneAnswer =
  | { gone: true }
  | { gone: false; membership: 'live' | 'unknown' }
  | { gone: false; error: string };

/** The kill that `groupGone` sends signal 0 with. */
export type GroupSignalZero = (pid: number, signal: 0) => void;

/**
 * Whether process group `pgid` is proven gone. It sends signal 0 to the whole group:
 * - ESRCH: no process holds the group id, so the group is gone. The probe is not asked.
 * - Success or EPERM: the membership probe decides. `no-live-members` (zombies only, or empty)
 *   is gone, `live` is present, and `unknown` is not proven gone. A probe that throws counts
 *   as `unknown`.
 * - Any other error: not proven gone.
 * It never throws. `deps` are test seams; the defaults are `process.kill`, looked up at call
 * time, and `probeGroupMembership`.
 */
export function groupGone(
  pgid: number,
  deps: { kill?: GroupSignalZero; probeGroup?: (pgid: number) => GroupMembership } = {},
): GroupGoneAnswer {
  const kill = deps.kill ?? ((pid: number, signal: 0): void => { process.kill(pid, signal); });
  const probeGroup = deps.probeGroup ?? probeGroupMembership;
  try {
    kill(-pgid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    if (code === 'ESRCH') return { gone: true };
    if (code !== 'EPERM') return { gone: false, error: typeof code === 'string' ? code : 'no error code' };
  }
  let membership: GroupMembership;
  try {
    membership = probeGroup(pgid);
  } catch {
    membership = 'unknown';
  }
  return membership === 'no-live-members' ? { gone: true } : { gone: false, membership };
}
