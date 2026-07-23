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

  it('recursively removes a stale directory (orphaned browser/profile temp) and counts its bytes', () => {
    const root = makeRoot();
    const staleDir = join(root, 'com.google.Chrome.chrome_url_fetcher_.stale');
    mkdirSync(staleDir);
    const inner = makeFile(staleDir, 'blob', 'chrome-scratch'); // 14 bytes
    // Age both the dir and its contents past maxAge.
    setAge(inner, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs + 10_000);
    setAge(staleDir, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs + 10_000);

    const result = runProcessTmpCleanup(root, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs);

    expect(result).toEqual({ deleted: 1, skipped: 0, bytesFreed: 14 });
    expect(existsSync(staleDir)).toBe(false);
  });

  it('preserves a directory with a recently-touched child (in-use temp)', () => {
    const root = makeRoot();
    const liveDir = join(root, 'playwright_chromiumdev_profile-live');
    mkdirSync(liveDir);
    const oldInner = makeFile(liveDir, 'old', 'x');
    const freshInner = makeFile(liveDir, 'fresh', 'y');
    // Directory + one child are old, but a live browser just touched a file.
    setAge(liveDir, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs + 10_000);
    setAge(oldInner, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs + 10_000);
    setAge(freshInner, 1_000);

    const result = runProcessTmpCleanup(root, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs);

    expect(result).toEqual({ deleted: 0, skipped: 0, bytesFreed: 0 });
    expect(existsSync(liveDir)).toBe(true);
  });

  it('preserves a wholly-recent directory', () => {
    const root = makeRoot();
    const recentDir = join(root, 'recent');
    mkdirSync(recentDir);
    setAge(makeFile(recentDir, 'file', 'z'), 1_000);
    setAge(recentDir, 1_000);

    const result = runProcessTmpCleanup(root, DEFAULT_PROCESS_TMP_RETENTION.maxAgeMs);

    expect(result).toEqual({ deleted: 0, skipped: 0, bytesFreed: 0 });
    expect(existsSync(recentDir)).toBe(true);
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
  it('start() is a no-op when already started — no second interval is created', () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const timer = new ProcessTmpRetentionTimer(root);
    const runSpy = vi.spyOn(timer, 'runCleanup');

    timer.start(1000);
    expect(runSpy).toHaveBeenCalledTimes(1); // immediate run

    timer.start(1000); // second start must be a no-op
    expect(runSpy).toHaveBeenCalledTimes(1); // no second immediate run

    vi.advanceTimersByTime(1000);
    expect(runSpy).toHaveBeenCalledTimes(2); // one interval tick, not two

    timer.stop();
    vi.advanceTimersByTime(5000);
    expect(runSpy).toHaveBeenCalledTimes(2); // stop() cleared the only interval
  });

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
