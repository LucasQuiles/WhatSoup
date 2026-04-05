import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Mock logger
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { MediaRetentionTimer, runCleanup, DEFAULT_RETENTION } from '../../src/core/media-retention.ts';
import type { RetentionConfig } from '../../src/core/media-retention.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `retention-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeFile(dir: string, name: string, content = 'data'): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function setMtime(filePath: string, ageMs: number): void {
  const ts = new Date(Date.now() - ageMs);
  utimesSync(filePath, ts, ts);
}

function makeDb(updatedPaths: string[] = []): any {
  return {
    raw: {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockImplementation((path: string) => {
          updatedPaths.push(path);
        }),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DEFAULT_RETENTION', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_RETENTION.intervalMs).toBe(6 * 60 * 60 * 1000);
    expect(DEFAULT_RETENTION.tempMaxAgeMs).toBe(72 * 60 * 60 * 1000);
    expect(DEFAULT_RETENTION.cacheMaxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('runCleanup — tmp directory', () => {
  let baseDir: string;
  let tmpDir: string;
  let cacheDir: string;

  beforeEach(() => {
    baseDir = makeTempDir();
    tmpDir = join(baseDir, 'tmp');
    cacheDir = join(baseDir, 'cache');
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
  });

  it('deletes old files in tmp/ beyond tempMaxAgeMs', async () => {
    const oldFile = makeFile(tmpDir, 'old.jpg');
    setMtime(oldFile, 80 * 60 * 60 * 1000); // 80 hours old

    const db = makeDb();
    const retention: RetentionConfig = {
      ...DEFAULT_RETENTION,
      tempMaxAgeMs: 72 * 60 * 60 * 1000,
    };

    const result = await runCleanup(baseDir, db, retention);

    expect(result.deleted).toBe(1);
    expect(result.bytesFreed).toBe(4); // 'data' = 4 bytes
    expect(result.skipped).toBe(0);
  });

  it('preserves recent files in tmp/ within tempMaxAgeMs', async () => {
    const recentFile = makeFile(tmpDir, 'recent.jpg');
    setMtime(recentFile, 10 * 60 * 60 * 1000); // 10 hours old

    const db = makeDb();
    const retention: RetentionConfig = {
      ...DEFAULT_RETENTION,
      tempMaxAgeMs: 72 * 60 * 60 * 1000,
    };

    const result = await runCleanup(baseDir, db, retention);

    expect(result.deleted).toBe(0);
    expect(result.bytesFreed).toBe(0);
  });

  it('deletes multiple old files and sums bytes freed', async () => {
    const f1 = makeFile(tmpDir, 'a.jpg', 'hello');
    const f2 = makeFile(tmpDir, 'b.jpg', 'world!');
    setMtime(f1, 80 * 60 * 60 * 1000);
    setMtime(f2, 90 * 60 * 60 * 1000);

    const db = makeDb();
    const result = await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(result.deleted).toBe(2);
    expect(result.bytesFreed).toBe(5 + 6); // 'hello' = 5, 'world!' = 6
  });

  it('skips directories inside tmp/', async () => {
    const subDir = join(tmpDir, 'subdir');
    mkdirSync(subDir, { recursive: true });

    const db = makeDb();
    const result = await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe('runCleanup — cache directory', () => {
  let baseDir: string;
  let tmpDir: string;
  let cacheDir: string;

  beforeEach(() => {
    baseDir = makeTempDir();
    tmpDir = join(baseDir, 'tmp');
    cacheDir = join(baseDir, 'cache');
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
  });

  it('deletes old files in cache/ beyond cacheMaxAgeMs', async () => {
    const oldCacheFile = makeFile(cacheDir, 'thumb.webp', 'thumbnail data');
    setMtime(oldCacheFile, 8 * 24 * 60 * 60 * 1000); // 8 days old

    const db = makeDb();
    const result = await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(result.deleted).toBe(1);
    expect(result.bytesFreed).toBe(14); // 'thumbnail data' = 14 bytes
  });

  it('preserves recent files in cache/ within cacheMaxAgeMs', async () => {
    const recentCacheFile = makeFile(cacheDir, 'thumb.webp', 'thumbnail data');
    setMtime(recentCacheFile, 3 * 24 * 60 * 60 * 1000); // 3 days old

    const db = makeDb();
    const result = await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(result.deleted).toBe(0);
  });

  it('applies different retention to tmp/ and cache/', async () => {
    // tmp file: 80 hours old (beyond 72h) — should be deleted
    const tmpFile = makeFile(tmpDir, 'a.jpg');
    setMtime(tmpFile, 80 * 60 * 60 * 1000);

    // cache file: 3 days old (within 7d) — should be kept
    const cacheFile = makeFile(cacheDir, 'b.webp');
    setMtime(cacheFile, 3 * 24 * 60 * 60 * 1000);

    const db = makeDb();
    const result = await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(result.deleted).toBe(1); // only the tmp file
  });

  it('can delete files from both tmp/ and cache/ in one run', async () => {
    const tmpFile = makeFile(tmpDir, 'a.jpg');
    const cacheFile = makeFile(cacheDir, 'b.webp');
    setMtime(tmpFile, 80 * 60 * 60 * 1000);  // beyond 72h
    setMtime(cacheFile, 8 * 24 * 60 * 60 * 1000); // beyond 7d

    const db = makeDb();
    const result = await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(result.deleted).toBe(2);
  });
});

describe('runCleanup — DB nullification', () => {
  let baseDir: string;
  let tmpDir: string;
  let cacheDir: string;

  beforeEach(() => {
    baseDir = makeTempDir();
    tmpDir = join(baseDir, 'tmp');
    cacheDir = join(baseDir, 'cache');
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
  });

  it('nullifies media_path in DB for each deleted file', async () => {
    const f1 = makeFile(tmpDir, 'a.jpg');
    const f2 = makeFile(tmpDir, 'b.jpg');
    setMtime(f1, 80 * 60 * 60 * 1000);
    setMtime(f2, 80 * 60 * 60 * 1000);

    const nullifiedPaths: string[] = [];
    const db = makeDb(nullifiedPaths);

    await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(db.raw.prepare).toHaveBeenCalledWith(
      'UPDATE messages SET media_path = NULL WHERE media_path = ?',
    );
    expect(nullifiedPaths).toContain(f1);
    expect(nullifiedPaths).toContain(f2);
  });

  it('does not call DB when no files are deleted', async () => {
    const recentFile = makeFile(tmpDir, 'recent.jpg');
    setMtime(recentFile, 5 * 60 * 60 * 1000); // 5 hours old

    const db = makeDb();
    await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(db.raw.prepare).not.toHaveBeenCalled();
  });
});

describe('runCleanup — missing directories', () => {
  it('returns zeros when baseDir has no tmp/ or cache/', async () => {
    const baseDir = makeTempDir(); // exists but no subdirs
    const db = makeDb();

    const result = await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.bytesFreed).toBe(0);
  });

  it('returns zeros when only tmp/ exists (cache/ missing)', async () => {
    const baseDir = makeTempDir();
    mkdirSync(join(baseDir, 'tmp'), { recursive: true });
    const db = makeDb();

    const result = await runCleanup(baseDir, db, DEFAULT_RETENTION);

    expect(result.deleted).toBe(0);
  });
});

describe('MediaRetentionTimer', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = makeTempDir();
    mkdirSync(join(baseDir, 'tmp'), { recursive: true });
    mkdirSync(join(baseDir, 'cache'), { recursive: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() with intervalMs fires cleanup on interval', async () => {
    const db = makeDb();
    const timer = new MediaRetentionTimer(baseDir, db);

    const runSpy = vi.spyOn(timer, 'runCleanup');
    timer.start(1000);
    expect(runSpy).toHaveBeenCalledTimes(1); // immediate run

    await vi.advanceTimersByTimeAsync(1000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(runSpy).toHaveBeenCalledTimes(3);

    timer.stop();
  });

  it('stop() prevents further cleanup runs', async () => {
    const db = makeDb();
    const timer = new MediaRetentionTimer(baseDir, db);
    const runSpy = vi.spyOn(timer, 'runCleanup');

    timer.start(1000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    timer.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runSpy).toHaveBeenCalledTimes(1); // no more calls
  });

  it('runCleanup() deletes old files and returns result', async () => {
    vi.useRealTimers();
    const tmpDir = join(baseDir, 'tmp');
    const oldFile = makeFile(tmpDir, 'old.jpg');
    setMtime(oldFile, 80 * 60 * 60 * 1000);

    const db = makeDb();
    const timer = new MediaRetentionTimer(baseDir, db);
    const result = await timer.runCleanup();

    expect(result.deleted).toBe(1);
    expect(result.bytesFreed).toBe(4);
  });

  it('uses custom retention config passed to constructor', async () => {
    vi.useRealTimers();
    const tmpDir = join(baseDir, 'tmp');
    const file = makeFile(tmpDir, 'medium.jpg');
    setMtime(file, 25 * 60 * 60 * 1000); // 25 hours old

    // Custom: only keep files for 12 hours
    const customRetention: RetentionConfig = {
      ...DEFAULT_RETENTION,
      tempMaxAgeMs: 12 * 60 * 60 * 1000,
    };

    const db = makeDb();
    const timer = new MediaRetentionTimer(baseDir, db, customRetention);
    const result = await timer.runCleanup();

    expect(result.deleted).toBe(1);
  });

  it('stop() is idempotent — calling twice does not throw', () => {
    const db = makeDb();
    const timer = new MediaRetentionTimer(baseDir, db);
    timer.start(1000);
    expect(() => {
      timer.stop();
      timer.stop();
    }).not.toThrow();
  });
});
