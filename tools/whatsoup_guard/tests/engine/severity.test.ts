import { describe, expect, it } from 'vitest';
import { dedupWindowMs, severityRank } from '../../src/engine/severity.ts';
import { Severity } from '../../src/types.ts';

describe('severity', () => {
  it('orders crit > high > med > low > info', () => {
    expect(severityRank('crit')).toBeGreaterThan(severityRank('high'));
    expect(severityRank('high')).toBeGreaterThan(severityRank('med'));
    expect(severityRank('med')).toBeGreaterThan(severityRank('low'));
    expect(severityRank('low')).toBeGreaterThan(severityRank('info'));
  });

  it('declares dedup windows per severity', () => {
    expect(dedupWindowMs('crit')).toBe(0);
    expect(dedupWindowMs('high')).toBe(6 * 60 * 60 * 1000);
    expect(dedupWindowMs('med')).toBe(12 * 60 * 60 * 1000);
    expect(dedupWindowMs('low')).toBe(24 * 60 * 60 * 1000);
    expect(dedupWindowMs('info')).toBe(0);
  });

  it('has a table entry for every schema severity', () => {
    for (const severity of Severity.options) {
      expect(severityRank(severity)).toEqual(expect.any(Number));
      expect(dedupWindowMs(severity)).toEqual(expect.any(Number));
    }
  });

  it('lets the schema reject unknown severities before helper use', () => {
    expect(() => Severity.parse('urgent')).toThrow();
  });
});
