import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findLatestLogFile, readTailLines } from '../../src/fleet/log-utils.ts';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'whatsoup-log-utils-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('fleet log utils', () => {
  it('finds the newest .log file by mtime', () => withTempDir((dir) => {
    const oldLog = join(dir, 'old.log');
    const newLog = join(dir, 'new.log');
    const ignored = join(dir, 'notes.txt');
    writeFileSync(oldLog, 'old');
    writeFileSync(newLog, 'new');
    writeFileSync(ignored, 'ignored');

    const oldTime = new Date('2026-01-01T00:00:00Z');
    const newTime = new Date('2026-01-02T00:00:00Z');
    utimesSync(oldLog, oldTime, oldTime);
    utimesSync(newLog, newTime, newTime);
    utimesSync(ignored, new Date('2026-01-03T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));

    const latest = findLatestLogFile(dir);
    expect(latest?.path).toBe(newLog);
    expect(latest?.mtimeMs).toBe(newTime.getTime());
  }));

  it('returns null when the directory has no readable log files', () => withTempDir((dir) => {
    writeFileSync(join(dir, 'only.txt'), 'not a log');
    expect(findLatestLogFile(dir)).toBeNull();
    expect(findLatestLogFile(join(dir, 'missing'))).toBeNull();
  }));

  it('reads only the requested trailing non-empty lines', () => withTempDir((dir) => {
    const logPath = join(dir, 'app.log');
    writeFileSync(logPath, 'one\n\ntwo\nthree\nfour\n');

    expect(readTailLines(logPath, 2)).toEqual(['three', 'four']);
  }));

  it('returns an empty array when the log file cannot be read', () => withTempDir((dir) => {
    expect(readTailLines(join(dir, 'missing.log'), 10)).toEqual([]);
  }));
});
