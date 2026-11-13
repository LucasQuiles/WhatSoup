import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { classifyGroupMembership, probeGroupMembership } from '../../src/lib/process-group-membership.ts';

describe('classifyGroupMembership', () => {
  it('reports a group with a running member as live', () => {
    expect(classifyGroupMembership('  101   100 S\n  102   100 Z\n  201   200 R+\n', 100)).toBe('live');
  });

  it('reports a group whose members are all zombies, or that has none, as having no live member', () => {
    expect(classifyGroupMembership('  101   100 Z\n  102   100 Z+\n  201   200 S\n', 100)).toBe('no-live-members');
    expect(classifyGroupMembership('  201   200 S\n', 100)).toBe('no-live-members');
  });

  it('never clears a group from an empty or malformed listing', () => {
    expect(classifyGroupMembership('', 100)).toBe('unknown');
    expect(classifyGroupMembership('\n  \n', 100)).toBe('unknown');
    expect(classifyGroupMembership('  101   100\n', 100)).toBe('unknown');
    expect(classifyGroupMembership('  pid   100 S\n', 100)).toBe('unknown');
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

  it('reads uppercase L (locked pages) on a zombie as no running thread', () => {
    expect(classifyGroupMembership(' 101   100 ZL\n 200   200 S\n', 100)).toBe('no-live-members');
  });
});

describe('probeGroupMembership', () => {
  it('reads this process group as live', () => {
    const listing = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 5_000 });
    const ownGroup = Number(listing.stdout.trim());
    // A missing group id must fail here: probing NaN would read as no-live-members.
    expect(Number.isSafeInteger(ownGroup) && ownGroup > 0).toBe(true);
    expect(probeGroupMembership(ownGroup)).toBe('live');
  });
});
