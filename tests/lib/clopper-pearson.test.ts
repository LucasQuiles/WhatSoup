import { describe, expect, it } from 'vitest';
import { clopperPearsonUpper } from '../../src/lib/clopper-pearson.ts';

describe('clopperPearsonUpper', () => {
  it('returns null when there are no trials', () => {
    expect(clopperPearsonUpper(0, 0)).toBeNull();
  });

  it('uses the closed form 1 - alpha^(1/n) when x = 0', () => {
    expect(Math.abs(clopperPearsonUpper(0, 1000)! - 0.002991)).toBeLessThan(1e-6);
    expect(clopperPearsonUpper(0, 1)).toBeCloseTo(0.95, 12);
  });

  it('returns 1 when every trial is a success', () => {
    expect(clopperPearsonUpper(7, 7)).toBe(1);
  });

  it.each([
    [1, 100, 0.04656],
    [5, 50, 0.198833],
    [10, 1000, 0.016903],
  ])('matches the exact binomial reference for x=%i, n=%i', (x, n, reference) => {
    const upper = clopperPearsonUpper(x, n)!;
    // References are printed to 5–6 decimals; the tolerance is the rounding.
    expect(Math.abs(upper - reference)).toBeLessThan(5e-6);
  });

  it('is the p at which P(X <= x) equals alpha', () => {
    // Independent check by direct summation for a small case: at the bound,
    // P(X <= 1; n = 10, p) must equal 0.05.
    const p = clopperPearsonUpper(1, 10)!;
    const cdf = (1 - p) ** 10 + 10 * p * (1 - p) ** 9;
    expect(cdf).toBeCloseTo(0.05, 9);
  });

  it('honours a custom alpha', () => {
    expect(clopperPearsonUpper(0, 10, 0.1)).toBeCloseTo(1 - 0.1 ** 0.1, 12);
  });

  it('rejects impossible inputs', () => {
    expect(() => clopperPearsonUpper(3, 2)).toThrow(RangeError);
    expect(() => clopperPearsonUpper(-1, 2)).toThrow(RangeError);
    expect(() => clopperPearsonUpper(1.5, 2)).toThrow(RangeError);
    expect(() => clopperPearsonUpper(0, 5, 0)).toThrow(RangeError);
  });
});
