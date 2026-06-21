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

    expect(handle).toEqual({ path: lockPath, pid: 11111, token: 'owned-token' });
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

    expect(handle).toEqual({ path: lockPath, pid: 44444, token: 'new-token' });
    expect(readProcessLockPayload(lockPath)).toEqual({
      pid: 44444,
      token: 'new-token',
      startedAt: '2026-06-21T00:00:00.000Z',
      bootId: 'boot-B',
    });
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
