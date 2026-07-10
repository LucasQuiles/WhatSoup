import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: fsMock.readdirSync,
    statSync: fsMock.statSync,
    unlinkSync: fsMock.unlinkSync,
  };
});

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { runCleanup, type RetentionConfig } from '../../src/core/media-retention.ts';

function makeDb() {
  const updateRun = vi.fn().mockReturnValue({ changes: 0 });
  const purgeRun = vi.fn().mockReturnValue({ changes: 0 });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    run: sql.includes('UPDATE messages SET media_path') ? updateRun : purgeRun,
  }));
  return {
    db: { raw: { prepare } },
    prepare,
    updateRun,
    purgeRun,
  };
}

const retention: RetentionConfig = {
  intervalMs: 1_000,
  tempMaxAgeMs: 10,
  cacheMaxAgeMs: 10,
};

describe('runCleanup filesystem error handling', () => {
  beforeEach(() => {
    fsMock.readdirSync.mockReset();
    fsMock.statSync.mockReset();
    fsMock.unlinkSync.mockReset();
  });

  it('skips a file that disappears between directory scan and stat', async () => {
    fsMock.readdirSync.mockImplementation((dir: string) =>
      dir.endsWith('/tmp') ? [{ name: 'vanished.jpg', isFile: () => true }] : []);
    fsMock.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const { db } = makeDb();

    const result = await runCleanup('/media', db as never, retention);

    expect(result).toEqual({ deleted: 0, skipped: 0, bytesFreed: 0 });
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('counts an old file as skipped when unlink fails', async () => {
    fsMock.readdirSync.mockImplementation((dir: string) =>
      dir.endsWith('/tmp') ? [{ name: 'locked.jpg', isFile: () => true }] : []);
    fsMock.statSync.mockReturnValue({ mtimeMs: 0, size: 42 });
    fsMock.unlinkSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const { db, prepare, updateRun } = makeDb();

    const result = await runCleanup('/media', db as never, retention);

    expect(result).toEqual({ deleted: 0, skipped: 1, bytesFreed: 0 });
    expect(prepare).toHaveBeenCalledWith(
      'UPDATE messages SET media_path = NULL WHERE media_path = ?',
    );
    expect(updateRun).toHaveBeenCalledWith('/media/tmp/locked.jpg');
    expect(updateRun.mock.invocationCallOrder[0]).toBeLessThan(
      fsMock.unlinkSync.mock.invocationCallOrder[0],
    );
  });

  it('fails closed before filesystem mutation inside an outer database transaction', async () => {
    fsMock.readdirSync.mockImplementation((dir: string) =>
      dir.endsWith('/tmp') ? [{ name: 'stale.jpg', isFile: () => true }] : []);
    fsMock.statSync.mockReturnValue({ mtimeMs: 0, size: 42 });
    const prepare = vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1 }),
    });
    const db = { raw: { isTransaction: true, prepare } };

    await expect(runCleanup('/media', db as never, retention)).rejects.toThrow(
      'active database transaction',
    );

    expect(prepare).not.toHaveBeenCalled();
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('does not yield between the transaction guard and cleanup mutations', async () => {
    fsMock.readdirSync.mockImplementation((dir: string) =>
      dir.endsWith('/cache') ? [{ name: 'stale.jpg', isFile: () => true }] : []);
    fsMock.statSync.mockReturnValue({ mtimeMs: 0, size: 42 });
    let inTransaction = false;
    const updateTransactionStates: boolean[] = [];
    const purgeTransactionStates: boolean[] = [];
    const prepare = vi.fn().mockImplementation((sql: string) => ({
      run: vi.fn().mockImplementation(() => {
        const states = sql.includes('UPDATE messages SET media_path')
          ? updateTransactionStates
          : purgeTransactionStates;
        states.push(inTransaction);
        return { changes: 1 };
      }),
    }));
    const db = {
      raw: {
        get isTransaction() {
          return inTransaction;
        },
        prepare,
      },
    };

    const cleanup = runCleanup('/media', db as never, retention);
    inTransaction = true;
    await cleanup;

    expect(updateTransactionStates).toEqual([false]);
    expect(purgeTransactionStates).toEqual([false]);
  });

  it('preserves an old file when media_path nullification fails', async () => {
    fsMock.readdirSync.mockImplementation((dir: string) =>
      dir.endsWith('/tmp') ? [{ name: 'stale.jpg', isFile: () => true }] : []);
    fsMock.statSync.mockReturnValue({ mtimeMs: 0, size: 42 });

    const updateRun = vi.fn().mockImplementation(() => {
      throw new Error('injected media_path update failure');
    });
    const purgeRun = vi.fn().mockReturnValue({ changes: 0 });
    const prepare = vi.fn().mockImplementation((sql: string) => ({
      run: sql.includes('UPDATE messages SET media_path') ? updateRun : purgeRun,
    }));
    const db = { raw: { prepare } };

    const result = await runCleanup('/media', db as never, retention);

    expect(result).toEqual({ deleted: 0, skipped: 1, bytesFreed: 0 });
    expect(updateRun).toHaveBeenCalledWith('/media/tmp/stale.jpg');
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('continues cleanup after one media_path nullification fails', async () => {
    fsMock.readdirSync.mockImplementation((dir: string) =>
      dir.endsWith('/tmp')
        ? [
            { name: 'blocked.jpg', isFile: () => true },
            { name: 'deletable.jpg', isFile: () => true },
          ]
        : []);
    fsMock.statSync.mockImplementation((path: string) => ({
      mtimeMs: 0,
      size: path.endsWith('/deletable.jpg') ? 20 : 10,
    }));

    const updateRun = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith('/blocked.jpg')) {
        throw new Error('injected media_path update failure');
      }
      return { changes: 1 };
    });
    const purgeRun = vi.fn().mockReturnValue({ changes: 0 });
    const prepare = vi.fn().mockImplementation((sql: string) => ({
      run: sql.includes('UPDATE messages SET media_path') ? updateRun : purgeRun,
    }));
    const db = { raw: { prepare } };

    const result = await runCleanup('/media', db as never, retention);

    expect(result).toEqual({ deleted: 1, skipped: 1, bytesFreed: 20 });
    expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
    expect(fsMock.unlinkSync).toHaveBeenCalledWith('/media/tmp/deletable.jpg');
  });
});
