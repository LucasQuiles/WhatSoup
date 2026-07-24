import { describe, it, expect } from 'vitest';
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_BUSY_TIMEOUT_PRAGMA } from '../../src/lib/sqlite-constants.ts';

describe('sqlite-constants', () => {
  it('SQLITE_BUSY_TIMEOUT_MS is a positive integer', () => {
    expect(SQLITE_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(SQLITE_BUSY_TIMEOUT_MS)).toBe(true);
  });

  it('PRAGMA string embeds the constant', () => {
    expect(SQLITE_BUSY_TIMEOUT_PRAGMA).toBe(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  });

  it('PRAGMA string is well-formed', () => {
    expect(SQLITE_BUSY_TIMEOUT_PRAGMA).toMatch(/^PRAGMA busy_timeout = \d+$/);
  });
});
