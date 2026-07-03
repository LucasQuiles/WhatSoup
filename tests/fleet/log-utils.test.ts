/**
 * Direct unit coverage for src/fleet/log-utils.ts.
 *
 * Helpers on the realtime-event-poller hot path:
 *   - findLatestLogFile(dir): pick the most recent .log file by mtime
 *   - readTailLinesDetailed(path, max): tail with explicit failure reason
 *
 * Uses real tmp dirs / files (no fs mocks) — helpers surface errors
 * explicitly, so behavior is observable on real filesystem state.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatestLogFile,
  inspectLatestLogFile,
  readTailLinesDetailed,
} from '../../src/fleet/log-utils.ts';

describe('findLatestLogFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-utils-find-'));
  });
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for an empty directory', () => {
    expect(findLatestLogFile(dir)).toBeNull();
  });

  it('returns null for a non-existent directory', () => {
    const missing = join(dir, 'does-not-exist');
    expect(findLatestLogFile(missing)).toBeNull();
  });

  it('finds a single .log file and reports its mtime', () => {
    const f = join(dir, 'app.log');
    writeFileSync(f, 'line1\n');
    const result = findLatestLogFile(dir);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(f);
    expect(typeof result!.mtimeMs).toBe('number');
    expect(result!.mtimeMs).toBeGreaterThan(0);
  });

  it('picks the most recent .log when multiple exist (sorted by mtime desc)', () => {
    const older = join(dir, '1.log');
    const newer = join(dir, '2.log');
    writeFileSync(older, 'a');
    writeFileSync(newer, 'b');
    const olderTime = new Date('2026-05-12T10:00:00.000Z');
    const newerTime = new Date('2026-05-12T11:00:00.000Z');
    utimesSync(older, olderTime, olderTime);
    utimesSync(newer, newerTime, newerTime);
    const result = findLatestLogFile(dir);
    expect(result!.path).toBe(newer);
  });

  it('ignores non-.log files', () => {
    writeFileSync(join(dir, 'notes.txt'), 'no');
    writeFileSync(join(dir, 'config.json'), '{}');
    expect(findLatestLogFile(dir)).toBeNull();
  });

  it('skips a .log entry that vanishes between directory scan and stat', () => {
    symlinkSync(join(dir, 'missing.log'), join(dir, 'rotated.log'));

    expect(inspectLatestLogFile(dir)).toEqual({ ok: true, file: null });
  });

  it('preserves a non-transient .log stat failure for callers', () => {
    symlinkSync('loop.log', join(dir, 'loop.log'));

    const result = inspectLatestLogFile(dir);

    expect(result).toMatchObject({
      ok: false,
      path: join(dir, 'loop.log'),
      code: 'ELOOP',
    });
  });

  it('returns null when the path is a file, not a directory', () => {
    const f = join(dir, 'app.log');
    writeFileSync(f, 'x');
    // Pointing at a file rather than dir — readdirSync throws ENOTDIR → null
    expect(findLatestLogFile(f)).toBeNull();
  });

  it('preserves the scan failure reason for callers that must not report false quiet', () => {
    const f = join(dir, 'app.log');
    writeFileSync(f, 'x');

    const result = inspectLatestLogFile(f);

    expect(result).toMatchObject({
      ok: false,
      path: f,
      code: 'ENOTDIR',
    });
  });

  it('preserves scan failures that do not carry a Node error code', async () => {
    vi.doMock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        readdirSync: vi.fn(() => {
          throw new Error('scan exploded');
        }),
      };
    });
    const { inspectLatestLogFile: inspectWithMockedFs } = await import('../../src/fleet/log-utils.ts');

    expect(inspectWithMockedFs(dir)).toEqual({
      ok: false,
      path: dir,
      error: 'scan exploded',
    });
  });

  it('treats a missing directory as an empty log source, not a scan failure', () => {
    const missing = join(dir, 'missing');

    expect(inspectLatestLogFile(missing)).toEqual({ ok: true, file: null });
  });
});

describe('readTailLinesDetailed', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-utils-tail-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves the tail failure reason for callers that must not report false quiet', () => {
    const subdir = join(dir, 'subdir');
    mkdirSync(subdir);

    const result = readTailLinesDetailed(subdir, 10);

    expect(result).toMatchObject({
      ok: false,
      path: subdir,
      code: 'EISDIR',
    });
  });

  it('treats a vanished log file as an empty transient tail during rotation', () => {
    expect(readTailLinesDetailed(join(dir, 'missing.log'), 10)).toEqual({ ok: true, lines: [] });
  });
});
