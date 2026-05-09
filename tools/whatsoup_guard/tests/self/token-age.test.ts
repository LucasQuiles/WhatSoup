import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTokenAge } from '../../src/self/token-age.ts';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-05-08T12:00:00.000Z');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tokenFile(daysOld: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-token-'));
  dirs.push(dir);
  const file = join(dir, 'token');
  writeFileSync(file, 'token');
  const timestampSeconds = (NOW - daysOld * DAY_MS) / 1000;
  utimesSync(file, timestampSeconds, timestampSeconds);
  return file;
}

describe('checkTokenAge', () => {
  it('reports a fresh token as not aging', () => {
    const file = tokenFile(10);

    const result = checkTokenAge(file, 90, NOW);

    expect(result.aging).toBe(false);
    expect(result.ageDays).toBe(10);
  });

  it('reports an old token as aging', () => {
    const file = tokenFile(120);

    const result = checkTokenAge(file, 90, NOW);

    expect(result).toEqual({ aging: true, ageDays: 120 });
  });

  it('does not report aging at the exact threshold', () => {
    const file = tokenFile(90);

    const result = checkTokenAge(file, 90, NOW);

    expect(result).toEqual({ aging: false, ageDays: 90 });
  });

  it('reports future token mtimes as not aging with a clock-skew reason', () => {
    const file = tokenFile(-1);

    const result = checkTokenAge(file, 90, NOW);

    expect(result).toEqual({ aging: false, ageDays: -1, reason: 'token mtime is in the future' });
  });

  it('reports missing token metadata as aging with a missing reason', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'wg-token-missing-')), 'token');

    const result = checkTokenAge(missing, 90, NOW);

    expect(result).toEqual({ aging: true, ageDays: Infinity, reason: 'token file missing or unreadable' });
  });
});
