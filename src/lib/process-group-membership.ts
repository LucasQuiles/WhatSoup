import { spawnSync } from 'node:child_process';

/**
 * What a process group holds. `no-live-members` means every member is a zombie with no running
 * thread, or the group has none: nothing can still run. `unknown` means the probe could not
 * tell, and is treated exactly like `live`.
 *
 * Darwin answers a group kill with EPERM, not ESRCH, when every member left is an unreaped
 * zombie, so EPERM alone cannot prove a group still runs (issue 3568).
 */
export type GroupMembership = 'live' | 'no-live-members' | 'unknown';

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * The live member pids of process group `pgid` in `ps -A -o pid=,pgid=,stat=` output, or
 * undefined when the listing is empty or malformed: a listing that cannot be read never shows a
 * group without live members. A zombie that carries the `l` (multithreaded) flag, such as `Zl` or
 * `Zsl`, is live.
 */
export function liveGroupMembers(psOutput: string, pgid: number): number[] | undefined {
  const lines = psOutput.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return undefined;
  const live: number[] = [];
  for (const line of lines) {
    const [pidField, pgidField, stat] = line.split(/\s+/);
    if (stat === undefined || !/^\d+$/.test(pidField ?? '') || !/^\d+$/.test(pgidField ?? '')) return undefined;
    // Linux shows a thread-group leader whose main thread exited while its other threads run as
    // `Zl`: those threads can still run. Only lowercase `l` counts; uppercase `L` means locked pages.
    const zombie = stat.startsWith('Z') && !stat.slice(1).includes('l');
    if (Number(pgidField) === pgid && !zombie) live.push(Number(pidField));
  }
  return live;
}

/**
 * Classify `ps -A -o pid=,pgid=,stat=` output for process group `pgid`, with the rules of
 * `liveGroupMembers`. An empty or malformed listing is `unknown`, never `no-live-members`: a probe
 * that cannot be read must not clear a group.
 */
export function classifyGroupMembership(psOutput: string, pgid: number): GroupMembership {
  const live = liveGroupMembers(psOutput, pgid);
  if (live === undefined) return 'unknown';
  return live.length > 0 ? 'live' : 'no-live-members';
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
