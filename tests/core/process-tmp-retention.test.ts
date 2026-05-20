import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  DEFAULT_PROCESS_TMP_RETENTION,
  ProcessTmpRetentionTimer,
  runProcessTmpCleanup,
} from '../../src/core/process-tmp-retention.ts';

const roots: string[] = [];

function makeRoot(): string {
  const root = join(tmpdir(), `process-tmp-retention-${randomBytes(4).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function makeFile(dir: string, name: string, content = 'data'): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return filePath;
}

function setAge(filePath: string, ageMs: number): void {
  const time = new Date(Date.now() - ageMs);
  utimesSync(filePath, time, time);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe('runProcessTmpCleanup', () => {
  it('deletes old process tmp files and preserves recent files', () => {
    const root = makeRoot();
    const oldFile = makeFile(root, 'document123-enc', 'old-data');
    const recentFile = makeFile(root, 'image123-enc', 'recent-data');
    setAge(oldFile, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs + 1_000);
    setAge(recentFile, 1_000);

    const result = runProcessTmpCleanup(root, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs);

    expect(result).toEqual({ deleted: 1, skipped: 0, bytesFreed: 8 });
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recentFile)).toBe(true);
  });

  it('skips directories inside process tmp', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'nested'));

    const result = runProcessTmpCleanup(root, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs);

    expect(result).toEqual({ deleted: 0, skipped: 0, bytesFreed: 0 });
    expect(existsSync(join(root, 'nested'))).toBe(true);
  });

  it('returns zeros when the process tmp directory does not exist', () => {
    const root = join(makeRoot(), 'missing');

    expect(runProcessTmpCleanup(root, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs)).toEqual({
      deleted: 0,
      skipped: 0,
      bytesFreed: 0,
    });
  });
});

describe('ProcessTmpRetentionTimer', () => {
  it('runs cleanup immediately and schedules later cleanup', () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const oldFile = makeFile(root, 'video123-enc', 'old');
    setAge(oldFile, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs + 1_000);
    const timer = new ProcessTmpRetentionTimer(root);

    timer.start();

    expect(existsSync(oldFile)).toBe(false);
    timer.stop();
  });
});
