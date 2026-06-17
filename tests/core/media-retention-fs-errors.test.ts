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
  const run = vi.fn().mockReturnValue({ changes: 0 });
  const prepare = vi.fn().mockReturnValue({ run });
  return {
    db: { raw: { prepare } },
    prepare,
    run,
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
    const { db, prepare } = makeDb();

    const result = await runCleanup('/media', db as never, retention);

    expect(result).toEqual({ deleted: 0, skipped: 1, bytesFreed: 0 });
    expect(prepare).not.toHaveBeenCalledWith(
      'UPDATE messages SET media_path = NULL WHERE media_path = ?',
    );
  });
});
