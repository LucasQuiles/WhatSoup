import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Fault injection lives in its own file: the main process-lock suite is
// real-fs end-to-end, and a module-level node:fs mock there would leak into
// every test. Only fsyncSync is overridden; everything else stays real.
const fsyncFault = vi.hoisted(() => ({ enabled: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (fsyncFault.enabled) {
        throw Object.assign(new Error('EIO: injected fsync failure'), { code: 'EIO' });
      }
      return actual.fsyncSync(fd);
    },
  };
});

const { acquireProcessLock } = await import('../../src/lib/process-lock.ts');

let tmpRoot = '';

afterEach(() => {
  fsyncFault.enabled = false;
  if (tmpRoot !== '') rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('acquireProcessLock fsync failure (#2288 M7)', () => {
  it('propagates the original error and leaves no temp or lock file behind', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-lock-fsync-'));
    const lockPath = join(tmpRoot, 'bot.lock');

    fsyncFault.enabled = true;
    expect(() => acquireProcessLock(lockPath, {
      pid: 33333,
      token: 'fsync-fault-token',
      now: new Date('2026-08-05T00:00:00.000Z'),
      bootId: 'boot-current',
    })).toThrow(/injected fsync failure/);

    // The failed acquire must clean its temp file and must not create the lock:
    // a leftover .tmp would block the next acquire's 'wx' open with EEXIST, and
    // a present-but-unsynced lock is exactly the corruption M7 exists to prevent.
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('acquires normally once the fault clears', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-lock-fsync-'));
    const lockPath = join(tmpRoot, 'bot.lock');

    const handle = acquireProcessLock(lockPath, {
      pid: 44444,
      token: 'post-fault-token',
      now: new Date('2026-08-05T00:00:00.000Z'),
      bootId: 'boot-current',
    });

    expect(handle.pid).toBe(44444);
    expect(existsSync(lockPath)).toBe(true);
  });
});
