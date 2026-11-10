import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import * as membershipModule from '../../src/lib/process-group-membership.ts';
import { classifyGroupMembership, type GroupMembership } from '../../src/lib/process-group-membership.ts';
import { FIXTURE_LEAK_NET_MS, groupKillError, waitForPidGone } from '../helpers/group-kill-seams.ts';

type GroupGoneAnswer =
  | { gone: true }
  | { gone: false; membership: 'live' | 'unknown' }
  | { gone: false; error: string };
type GroupGoneApi = {
  groupGone?: (
    pgid: number,
    deps?: { kill?: (pid: number, signal: 0) => void; probeGroup?: (pgid: number) => GroupMembership },
  ) => GroupGoneAnswer;
};
// Read through the namespace, so a missing export fails its own assertion instead of the import.
const api = membershipModule as unknown as GroupGoneApi;

/** Above every pid limit (Linux 4194304, macOS 99999), so no real process group can hold this id. */
const NO_SUCH_GROUP = 4_194_305;

/** A signal-0 seam that records each call and either returns or throws `error`. */
function signalZero(calls: Array<[number, number | string]>, error?: NodeJS.ErrnoException | Error) {
  return (pid: number, signal: 0): void => {
    calls.push([pid, signal]);
    if (error !== undefined) throw error;
  };
}

describe('groupGone (issue 3568: one liveness rule for a whole process group)', () => {
  it('reads ESRCH from the signal-0 check as gone, without asking the membership probe', () => {
    expect(typeof api.groupGone).toBe('function');
    if (!api.groupGone) return;
    const calls: Array<[number, number | string]> = [];
    let probeCalls = 0;
    const answer = api.groupGone(NO_SUCH_GROUP, {
      kill: signalZero(calls, groupKillError('ESRCH')),
      probeGroup: () => { probeCalls += 1; return 'live'; },
    });
    expect(answer).toEqual({ gone: true });
    expect(calls).toEqual([[-NO_SUCH_GROUP, 0]]);
    expect(probeCalls).toBe(0);
  });

  it.each([
    ['succeeds', 'no-live-members', { gone: true }],
    ['succeeds', 'live', { gone: false, membership: 'live' }],
    ['succeeds', 'unknown', { gone: false, membership: 'unknown' }],
    ['answers EPERM', 'no-live-members', { gone: true }],
    ['answers EPERM', 'live', { gone: false, membership: 'live' }],
    ['answers EPERM', 'unknown', { gone: false, membership: 'unknown' }],
  ] as const)('when the signal-0 check %s and the probe answers %s, the membership probe decides', (check, membership, expected) => {
    expect(typeof api.groupGone).toBe('function');
    if (!api.groupGone) return;
    const calls: Array<[number, number | string]> = [];
    const probed: number[] = [];
    // Linux delivers signal 0 to a zombie, so a success cannot tell a zombie-only group from a live one.
    const answer = api.groupGone(NO_SUCH_GROUP, {
      kill: signalZero(calls, check === 'succeeds' ? undefined : groupKillError('EPERM')),
      probeGroup: (pgid) => { probed.push(pgid); return membership; },
    });
    expect(answer).toEqual(expected);
    expect(calls).toEqual([[-NO_SUCH_GROUP, 0]]);
    expect(probed).toEqual([NO_SUCH_GROUP]);
  });

  it('reads any other signal-0 error as not proven gone, names only its code, and never asks the probe', () => {
    expect(typeof api.groupGone).toBe('function');
    if (!api.groupGone) return;
    let probeCalls = 0;
    const probeGroup = (): GroupMembership => { probeCalls += 1; return 'no-live-members'; };
    expect(api.groupGone(NO_SUCH_GROUP, { kill: signalZero([], groupKillError('EINVAL')), probeGroup }))
      .toEqual({ gone: false, error: 'EINVAL' });
    // An error without a code is named by a fixed text, never by its message.
    expect(api.groupGone(NO_SUCH_GROUP, { kill: signalZero([], new Error('/private/path in a message')), probeGroup }))
      .toEqual({ gone: false, error: 'no error code' });
    expect(probeCalls).toBe(0);
  });

  it('reads a membership probe that throws as unknown, never as gone', () => {
    expect(typeof api.groupGone).toBe('function');
    if (!api.groupGone) return;
    const answer = api.groupGone(NO_SUCH_GROUP, {
      kill: signalZero([], groupKillError('EPERM')),
      probeGroup: () => { throw new Error('ps failed'); },
    });
    expect(answer).toEqual({ gone: false, membership: 'unknown' });
  });

  it('with the default kill and ps probe, reads a missing group as gone and a live group as live', async () => {
    expect(typeof api.groupGone).toBe('function');
    if (!api.groupGone) return;
    expect(api.groupGone(NO_SUCH_GROUP)).toEqual({ gone: true });
    // A real group with one live member: the default probe must read it as live on every CI platform.
    // The member's own lifetime is the leak net, in case this test's teardown never runs.
    const child = spawn('sleep', [String(FIXTURE_LEAK_NET_MS / 1_000)], { detached: true, stdio: 'ignore' });
    const pid = await new Promise<number | undefined>((resolve) => {
      child.once('spawn', () => resolve(child.pid));
      child.once('error', () => resolve(undefined));
    });
    try {
      expect(pid).toBeDefined();
      expect(api.groupGone(pid!)).toEqual({ gone: false, membership: 'live' });
    } finally {
      // The member is alive until this kill, so its group id is still allocated.
      if (pid !== undefined) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already gone */ }
      }
      const gone = pid === undefined ? true : await waitForPidGone(pid);
      expect(gone).toBe(true);
    }
  });
});

describe('classifyGroupMembership (a multithreaded zombie can still run)', () => {
  // On Linux, a thread-group leader whose main thread exited while its other threads run shows as
  // `Zl` or `Zsl`. The `l` flag marks a multithreaded process, and those other threads can still run.
  it.each([
    ['Zl', 'live'],
    ['Zsl', 'live'],
    ['Z', 'no-live-members'],
    ['Z+', 'no-live-members'],
    ['Zs', 'no-live-members'],
  ] as const)('reads a group member in state %s as %s', (stat, expected) => {
    expect(classifyGroupMembership(` 101   100 ${stat}\n 200   200 S\n`, 100)).toBe(expected);
  });
});

type LiveMembersApi = {
  liveGroupMembers?: (psOutput: string, pgid: number) => number[] | undefined;
  probeGroupMembers?: (pgid: number) => number[] | undefined;
};
// Read through the namespace, so a missing export fails its own assertion instead of the import.
const membersApi = membershipModule as unknown as LiveMembersApi;

describe('liveGroupMembers (the members a refused group kill is checked against)', () => {
  it('lists the live member pids of the group: running rows and Zl count; Z rows and other groups do not', () => {
    expect(typeof membersApi.liveGroupMembers).toBe('function');
    if (!membersApi.liveGroupMembers) return;
    const listing = [
      ' 101   100 S',
      ' 102   100 Z',
      ' 103   100 Zl',
      ' 104   100 R+',
      ' 105   100 Zs',
      ' 200   200 S',
      ' 201   200 Zl',
      '',
    ].join('\n');
    expect(membersApi.liveGroupMembers(listing, 100)).toEqual([101, 103, 104]);
  });

  it('lists no pid for a group that holds only zombies, or that has no row in the listing', () => {
    expect(typeof membersApi.liveGroupMembers).toBe('function');
    if (!membersApi.liveGroupMembers) return;
    const listing = ' 101   100 Z\n 200   200 S\n';
    expect(membersApi.liveGroupMembers(listing, 100)).toEqual([]);
    expect(membersApi.liveGroupMembers(listing, 300)).toEqual([]);
  });

  it.each([
    ['an empty listing', ''],
    ['a blank listing', '\n   \n'],
    ['a listing with a non-numeric pid', ' 101   100 S\nabc   100 S\n'],
    ['a listing with a row that has no state', ' 101   100 S\n 102   100\n'],
  ] as const)('reads %s as unreadable, never as a group with no live member', (_case, listing) => {
    expect(typeof membersApi.liveGroupMembers).toBe('function');
    if (!membersApi.liveGroupMembers) return;
    expect(membersApi.liveGroupMembers(listing, 100)).toBe(undefined);
  });

  it('with the default ps probe, lists this test process among the live members of its own group', () => {
    expect(typeof membersApi.probeGroupMembers).toBe('function');
    if (!membersApi.probeGroupMembers) return;
    // This process is running while it asks, so its own group always holds it as a live member.
    const listing = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 5_000 });
    expect(listing.status).toBe(0);
    const pgid = Number(listing.stdout.trim());
    expect(Number.isInteger(pgid) && pgid > 0).toBe(true);
    expect(membersApi.probeGroupMembers(pgid)).toContain(process.pid);
  });
});
