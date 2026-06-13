import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProcessLock,
  isProcessLockError,
  readProcessLockPayload,
  releaseProcessLock,
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
    });

    expect(handle).toEqual({ path: lockPath, pid: 11111, token: 'owned-token' });
    expect(readProcessLockPayload(lockPath)).toEqual({
      pid: 11111,
      token: 'owned-token',
      startedAt: '2026-06-13T00:00:00.000Z',
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
    }));

    const released = releaseProcessLock({ path: lockPath, pid: 11111, token: 'owned-token' });

    expect(released).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({
      pid: 22222,
      token: 'other-token',
    });
  });

  it('fails closed on a stale existing lock instead of deleting and stealing it', () => {
    const lockPath = makeLockPath();
    writeFileSync(lockPath, JSON.stringify({
      pid: 33333,
      token: 'stale-token',
      startedAt: '2026-06-13T00:00:00.000Z',
    }));

    const err = catchError(() => acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'new-token',
      now: new Date('2026-06-13T00:10:00.000Z'),
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
    }));

    expect(isProcessLockError(err)).toBe(true);
    if (!isProcessLockError(err)) throw new Error('expected process lock error');
    expect(err.reason).toBe('corrupt');
    expect(readFileSync(lockPath, 'utf8')).toBe('not-json');
  });
});
