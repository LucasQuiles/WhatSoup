import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProcessLock,
  getCurrentBootId,
  isProcessLockError,
  readProcessLockPayload,
  releaseProcessLock,
  resolveBootId,
} from '../../src/lib/process-lock.ts';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function makeLockPath(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-process-lock-'));
  return join(tmpRoot, 'bot.lock');
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('process lock ownership', () => {
  it('acquires with an unlogged token and releases only its own lock', () => {
    const lockPath = makeLockPath();

    const handle = acquireProcessLock(lockPath, {
      pid: 11111,
      token: 'owned-token',
      now: new Date('2026-06-13T00:00:00.000Z'),
      bootId: 'boot-current',
    });

    expect(handle).toEqual({ path: lockPath, pid: 11111, token: 'owned-token', reclaimedPreviousBoot: false });
    expect(readProcessLockPayload(lockPath)).toEqual({
      pid: 11111,
      token: 'owned-token',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-current',
    });

    expect(releaseProcessLock(handle)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not unlink a replacement lock written by another process', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, JSON.stringify({
      pid: 22222,
      token: 'other-token',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-current',
    }));

    const released = releaseProcessLock({ path: lockPath, pid: 11111, token: 'owned-token' });

    expect(released).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: 22222,
      token: 'other-token',
    });
  });

  it('does not unlink a lock replaced AFTER the ownership check (release race)', () => {
    const lockPath = makeLockPath();
    const handle = acquireProcessLock(lockPath, {
      pid: 11111,
      token: 'owned-token',
      now: new Date('2026-06-13T00:00:00.000Z'),
      bootId: 'boot-current',
    });

    // After we confirm ownership, a different holder replaces the lock before the
    // unlink. The identity-checked unlink must re-read and refuse to delete it.
    const released = releaseProcessLock(handle, {
      beforeReleaseUnlink: () => {
        writeFileSync(lockPath, JSON.stringify({
          pid: 22222,
          token: 'other-token',
          startedAt: '2026-06-13T00:05:00.000Z',
          bootId: 'boot-current',
        }), { flag: 'w' });
      },
    });

    expect(released).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: 22222,
      token: 'other-token',
    });
  });

  it('treats a non-positive, fractional, or unsafe pid as corrupt (null payload)', () => {
    const lockPath = makeLockPath();
    for (const badPid of [0, -1, 3.5, Number.MAX_SAFE_INTEGER + 1]) {
      writeFileSync(lockPath, JSON.stringify({
        pid: badPid,
        token: 'tok',
        startedAt: '2026-06-13T00:00:00.000Z',
        bootId: 'boot-current',
      }), { flag: 'w' });
      expect(readProcessLockPayload(lockPath)).toBeNull();
    }
    // A valid positive integer pid still parses.
    writeFileSync(lockPath, JSON.stringify({
      pid: 4321,
      token: 'tok',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-current',
    }), { flag: 'w' });
    expect(readProcessLockPayload(lockPath)?.pid).toBe(4321);
  });

  it('fails closed on a same-boot stale lock instead of deleting and stealing it', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, JSON.stringify({
      pid: 33333,
      token: 'stale-token',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-current',
    }));

    const err = catchError(() => acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'new-token',
      now: new Date('2026-06-13T00:10:00.000Z'),
      bootId: 'boot-current',
      isProcessAlive: () => false,
    }));

    expect(isProcessLockError(err)).toBe(true);
    if (!isProcessLockError(err)) throw new Error('expected process lock error');
    expect(err.reason).toBe('stale');
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: 33333,
      token: 'stale-token',
    });
  });

  it('fails closed on a corrupt existing lock instead of deleting it', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, 'not-json');

    const err = catchError(() => acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'new-token',
      now: new Date('2026-06-13T00:10:00.000Z'),
      bootId: 'boot-current',
    }));

    expect(isProcessLockError(err)).toBe(true);
    if (!isProcessLockError(err)) throw new Error('expected process lock error');
    expect(err.reason).toBe('corrupt');
    expect(readFileSync(lockPath, 'utf8')).toBe('not-json');
  });
});

describe('process lock boot-id reclaim', () => {
  it('reclaims a previous-boot lock when the holder process is dead', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, JSON.stringify({
      pid: 33333,
      token: 'prior-boot-token',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-A',
    }));

    const handle = acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'new-token',
      now: new Date('2026-06-21T00:00:00.000Z'),
      bootId: 'boot-B',
      isProcessAlive: () => false,
    });

    expect(handle).toEqual({ path: lockPath, pid: 44444, token: 'new-token', reclaimedPreviousBoot: true });
    expect(readProcessLockPayload(lockPath)).toEqual({
      pid: 44444,
      token: 'new-token',
      startedAt: '2026-06-21T00:00:00.000Z',
      bootId: 'boot-B',
    });
  });

  it('does not unlink a lock replaced during reclaim (concurrent post-reboot start)', () => {
    const lockPath = makeLockPath();
    // A prior-boot, dead-holder lock — eligible for reclaim.
    writeFileSync(lockPath, JSON.stringify({
      pid: 33333,
      token: 'prior-boot-token',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-A',
    }));

    // Simulate a concurrent same-instance starter that wins the reclaim and
    // installs its own LIVE lock between our read and our unlink. The
    // identity-checked unlink must NOT delete the winner's lock (that would be
    // split-brain); we must fail closed as active instead.
    let replaced = false;
    const err = catchError(() => acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'loser-token',
      bootId: 'boot-B',
      isProcessAlive: (pid) => pid === 55555,
      beforeReclaimUnlink: () => {
        if (replaced) return;
        replaced = true;
        writeFileSync(lockPath, JSON.stringify({
          pid: 55555,
          token: 'winner-token',
          startedAt: '2026-06-21T00:00:00.000Z',
          bootId: 'boot-B',
        }), { flag: 'w' });
      },
    }));

    expect(replaced).toBe(true);
    expect(isProcessLockError(err)).toBe(true);
    if (!isProcessLockError(err)) throw new Error('expected process lock error');
    expect(err.reason).toBe('active');
    expect(err.existingPid).toBe(55555);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: 55555,
      token: 'winner-token',
    });
  });

  it('reclaim identity check compares the full payload, not just token+bootId', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, JSON.stringify({
      pid: 33333,
      token: 'prior-boot-token',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-A',
    }));

    // Between read and unlink the lock is replaced by one sharing token+bootId but
    // differing in pid/startedAt. A token+bootId-only check would unlink it and
    // steal a LIVE holder's lock; full-identity comparison must refuse.
    let replaced = false;
    const err = catchError(() => acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'new-token',
      bootId: 'boot-B',
      isProcessAlive: (pid) => pid === 99999,
      beforeReclaimUnlink: () => {
        if (replaced) return;
        replaced = true;
        writeFileSync(lockPath, JSON.stringify({
          pid: 99999,
          token: 'prior-boot-token',
          startedAt: '2026-06-21T00:00:00.000Z',
          bootId: 'boot-A',
        }), { flag: 'w' });
      },
    }));

    expect(replaced).toBe(true);
    expect(isProcessLockError(err)).toBe(true);
    if (!isProcessLockError(err)) throw new Error('expected process lock error');
    expect(err.reason).toBe('active');
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: 99999 });
  });

  it('blocks as active when a previous-boot lock pid is still alive (liveness beats boot-id)', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, JSON.stringify({
      pid: 33333,
      token: 'prior-boot-token',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-A',
    }));

    const err = catchError(() => acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'new-token',
      bootId: 'boot-B',
      isProcessAlive: () => true,
    }));

    expect(isProcessLockError(err)).toBe(true);
    if (!isProcessLockError(err)) throw new Error('expected process lock error');
    expect(err.reason).toBe('active');
    expect(err.existingPid).toBe(33333);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: 33333,
      token: 'prior-boot-token',
    });
  });

  it('does not reclaim a legacy lock that has no bootId even when the pid is dead', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, JSON.stringify({
      pid: 33333,
      token: 'legacy-token',
      startedAt: '2026-06-13T00:00:00.000Z',
    }));

    const err = catchError(() => acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'new-token',
      bootId: 'boot-B',
      isProcessAlive: () => false,
    }));

    expect(isProcessLockError(err)).toBe(true);
    if (!isProcessLockError(err)) throw new Error('expected process lock error');
    expect(err.reason).toBe('stale');
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: 33333,
      token: 'legacy-token',
    });
  });

  it('uses the real liveness probe to block on a lock held by a live process', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      token: 'live-token',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-A',
    }));

    // No isProcessAlive injection -> exercises the default process.kill(pid, 0)
    // probe. This process is provably alive, so the lock must block as active
    // even though its recorded bootId differs from the current one.
    const err = catchError(() => acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'new-token',
      bootId: 'boot-B',
    }));

    expect(isProcessLockError(err)).toBe(true);
    if (!isProcessLockError(err)) throw new Error('expected process lock error');
    expect(err.reason).toBe('active');
    expect(err.existingPid).toBe(process.pid);
  });

  it('does not reclaim when the current boot id is unknown (empty)', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, JSON.stringify({
      pid: 33333,
      token: 'prior-boot-token',
      startedAt: '2026-06-13T00:00:00.000Z',
      bootId: 'boot-A',
    }));

    const err = catchError(() => acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'new-token',
      bootId: '',
      isProcessAlive: () => false,
    }));

    expect(isProcessLockError(err)).toBe(true);
    if (!isProcessLockError(err)) throw new Error('expected process lock error');
    expect(err.reason).toBe('stale');
  });
});

describe('getCurrentBootId', () => {
  it('reads a stable, non-empty boot id for the current OS', () => {
    const first = getCurrentBootId();
    const second = getCurrentBootId();
    expect(typeof first).toBe('string');
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});

describe('resolveBootId', () => {
  it('prefers the Linux boot id when present', () => {
    const id = resolveBootId({
      readLinuxBootId: () => '  linux-boot-uuid\n',
      readMacBootTime: () => 'should-not-be-used',
    });
    expect(id).toBe('linux-boot-uuid');
  });

  it('falls back to the macOS boot time when the Linux id is empty', () => {
    const id = resolveBootId({
      readLinuxBootId: () => '',
      readMacBootTime: () => '{ sec = 1782000000, usec = 0 }\n',
    });
    expect(id).toBe('{ sec = 1782000000, usec = 0 }');
  });

  it('falls back to the macOS boot time when the Linux probe throws', () => {
    const id = resolveBootId({
      readLinuxBootId: () => { throw new Error('no /proc'); },
      readMacBootTime: () => 'mac-boot-time',
    });
    expect(id).toBe('mac-boot-time');
  });

  it('returns an empty sentinel when both probes fail', () => {
    const id = resolveBootId({
      readLinuxBootId: () => { throw new Error('no /proc'); },
      readMacBootTime: () => { throw new Error('no sysctl'); },
    });
    expect(id).toBe('');
  });

  it('returns an empty sentinel when both probes are empty', () => {
    const id = resolveBootId({
      readLinuxBootId: () => '   ',
      readMacBootTime: () => '',
    });
    expect(id).toBe('');
  });
});
