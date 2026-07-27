import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const logInfo = vi.hoisted(() => vi.fn());

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
    info: logInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  ProcessTmpRetentionTimer,
  runProcessTmpCleanup,
} from '../../src/core/process-tmp-retention.ts';

describe('process tmp retention filesystem error handling', () => {
  beforeEach(() => {
    fsMock.readdirSync.mockReset();
    fsMock.statSync.mockReset();
    fsMock.unlinkSync.mockReset();
    logInfo.mockClear();
  });

  it('skips a file that disappears between directory scan and stat', () => {
    fsMock.readdirSync.mockReturnValue([{ name: 'gone.tmp', isFile: () => true }]);
    fsMock.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = runProcessTmpCleanup('/process-tmp', 10);

    expect(result).toEqual({ deleted: 0, skipped: 0, bytesFreed: 0 });
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it('counts an old file as skipped and logs cleanup when unlink fails', () => {
    fsMock.readdirSync.mockReturnValue([{ name: 'locked.tmp', isFile: () => true }]);
    fsMock.statSync.mockReturnValue({ mtimeMs: 0, size: 42 });
    fsMock.unlinkSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const timer = new ProcessTmpRetentionTimer('/process-tmp', {
      intervalMs: 1_000,
      maxAgeMs: 10,
    });

    const result = timer.runCleanup();

    expect(result).toEqual({ deleted: 0, skipped: 1, bytesFreed: 0 });
    expect(logInfo).toHaveBeenCalledWith(
      result,
      'process tmp retention: cleanup run complete',
    );
  });

  // #2162: the log line used to be gated on `deleted > 0 || skipped > 0`, so a
  // run that reclaimed nothing produced no output — indistinguishable from the
  // timer not running. That quiet case is also the steady state of a healthy
  // directory, so the gate silenced the reclaimer exactly when it worked.

  it('logs the completion line even when the run reclaims nothing', () => {
    fsMock.readdirSync.mockReturnValue([]);
    const timer = new ProcessTmpRetentionTimer('/process-tmp', {
      intervalMs: 1_000,
      maxAgeMs: 10,
    });

    const result = timer.runCleanup();

    expect(result).toEqual({ deleted: 0, skipped: 0, bytesFreed: 0 });
    expect(logInfo).toHaveBeenCalledWith(
      result,
      'process tmp retention: cleanup run complete',
    );
  });

  it('logs a nothing-to-do run whose entries all exist but are recent', () => {
    // Distinct from the empty-directory case: entries are present and simply
    // too new to reclaim, which is the healthy steady state the old gate
    // silenced.
    fsMock.readdirSync.mockReturnValue([{ name: 'fresh.tmp', isFile: () => true }]);
    fsMock.statSync.mockReturnValue({ mtimeMs: Date.now(), size: 10 });
    const timer = new ProcessTmpRetentionTimer('/process-tmp', {
      intervalMs: 1_000,
      maxAgeMs: 60_000,
    });

    const result = timer.runCleanup();

    expect(result).toEqual({ deleted: 0, skipped: 0, bytesFreed: 0 });
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it('logs exactly once per run, not once per reclaimed entry', () => {
    fsMock.readdirSync.mockReturnValue([
      { name: 'a.tmp', isFile: () => true },
      { name: 'b.tmp', isFile: () => true },
    ]);
    fsMock.statSync.mockReturnValue({ mtimeMs: 0, size: 5 });
    const timer = new ProcessTmpRetentionTimer('/process-tmp', {
      intervalMs: 1_000,
      maxAgeMs: 10,
    });

    timer.runCleanup();

    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it('stop is a no-op before the timer starts', () => {
    const timer = new ProcessTmpRetentionTimer('/process-tmp');

    expect(() => timer.stop()).not.toThrow();
  });
});
