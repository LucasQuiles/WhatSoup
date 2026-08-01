import { describe, expect, it } from 'vitest';

import {
  MS_PER_SECOND,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
  MS_PER_WEEK,
} from '../../src/lib/time-units.ts';

describe('time-units', () => {
  it('MS_PER_* values are exact', () => {
    expect(MS_PER_SECOND).toBe(1_000);
    expect(MS_PER_MINUTE).toBe(60_000);
    expect(MS_PER_HOUR).toBe(3_600_000);
    expect(MS_PER_DAY).toBe(86_400_000);
    expect(MS_PER_WEEK).toBe(604_800_000);
  });

  it('every constant is a safe integer millisecond count', () => {
    for (const value of [MS_PER_SECOND, MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY, MS_PER_WEEK]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('each unit is the exact multiple of the previous', () => {
    expect(MS_PER_MINUTE).toBe(60 * MS_PER_SECOND);
    expect(MS_PER_HOUR).toBe(60 * MS_PER_MINUTE);
    expect(MS_PER_DAY).toBe(24 * MS_PER_HOUR);
    expect(MS_PER_WEEK).toBe(7 * MS_PER_DAY);
  });
});
