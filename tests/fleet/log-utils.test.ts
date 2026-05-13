/**
 * Direct unit coverage for src/fleet/log-utils.ts.
 *
 * Two helpers on the realtime-event-poller hot path:
 *   - findLatestLogFile(dir): pick the most recent .log file by mtime
 *   - readTailLines(path, max): best-effort tail of the last 64KB
 *
 * Existing tests mock these helpers; this is the first direct mirror.
 * Uses real tmp dirs / files (no fs mocks) — both helpers swallow errors
 * to null/[], so behavior is observable on real filesystem state.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLatestLogFile, readTailLines } from '../../src/fleet/log-utils.ts';

describe('findLatestLogFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-utils-find-'));
  });
  afterEach(() => {
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

  it('returns null when the path is a file, not a directory', () => {
    const f = join(dir, 'app.log');
    writeFileSync(f, 'x');
    // Pointing at a file rather than dir — readdirSync throws ENOTDIR → null
    expect(findLatestLogFile(f)).toBeNull();
  });
});

describe('readTailLines', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-utils-tail-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the last N lines from a small file', () => {
    const f = join(dir, 'a.log');
    writeFileSync(f, 'one\ntwo\nthree\nfour\nfive\n');
    expect(readTailLines(f, 2)).toEqual(['four', 'five']);
    expect(readTailLines(f, 3)).toEqual(['three', 'four', 'five']);
  });

  it('returns all lines when N exceeds file line count', () => {
    const f = join(dir, 'a.log');
    writeFileSync(f, 'a\nb\nc\n');
    expect(readTailLines(f, 99)).toEqual(['a', 'b', 'c']);
  });

  it('filters out empty lines from trailing newline / blank lines', () => {
    const f = join(dir, 'a.log');
    writeFileSync(f, 'x\n\ny\n\nz\n');
    // .filter(Boolean) drops empties, then tail last N
    expect(readTailLines(f, 5)).toEqual(['x', 'y', 'z']);
  });

  it('returns empty array for an empty file', () => {
    const f = join(dir, 'empty.log');
    writeFileSync(f, '');
    expect(readTailLines(f, 10)).toEqual([]);
  });

  it('returns empty array for a missing file (swallows error)', () => {
    expect(readTailLines(join(dir, 'missing.log'), 10)).toEqual([]);
  });

  it('reads from the final 64KB window when file is larger', () => {
    const f = join(dir, 'big.log');
    const longLine = 'old-prefix-' + 'x'.repeat(70_000);
    const tail = 'marker-1\nmarker-2\nmarker-3\n';
    writeFileSync(f, `${longLine}\n${tail}`);

    const lines = readTailLines(f, 4);

    expect(lines.slice(1)).toEqual(['marker-1', 'marker-2', 'marker-3']);
    expect(lines[0]).toBe('x'.repeat(65_536 - tail.length - 1));
  });

  it('returns empty array when path is a directory (swallows error)', () => {
    const subdir = join(dir, 'subdir');
    mkdirSync(subdir);
    // openSync on a directory throws EISDIR → caught → []
    expect(readTailLines(subdir, 10)).toEqual([]);
  });
});
