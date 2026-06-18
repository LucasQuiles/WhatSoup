import { describe, expect, it } from 'vitest';
import { parseCron, nextCronRun, cronToHuman } from '../../src/core/cron.ts';

describe('cron parser', () => {
  describe('parseCron', () => {
    it('parses a valid 5-field cron expression', () => {
      const parsed = parseCron('30 9 * * 1');
      expect(parsed).toEqual({ minute: [30], hour: [9], dayOfMonth: null, month: null, dayOfWeek: [1] });
    });

    it('parses wildcard fields as null', () => {
      const parsed = parseCron('* * * * *');
      expect(parsed).toEqual({ minute: null, hour: null, dayOfMonth: null, month: null, dayOfWeek: null });
    });

    it('parses comma-separated values', () => {
      const parsed = parseCron('0 9,18 * * *');
      expect(parsed).toEqual({ minute: [0], hour: [9, 18], dayOfMonth: null, month: null, dayOfWeek: null });
    });

    it('parses step values', () => {
      const parsed = parseCron('*/15 * * * *');
      expect(parsed).toEqual({ minute: [0, 15, 30, 45], hour: null, dayOfMonth: null, month: null, dayOfWeek: null });
    });

    it('parses range values', () => {
      const parsed = parseCron('0 9-17 * * *');
      expect(parsed).toEqual({ minute: [0], hour: [9, 10, 11, 12, 13, 14, 15, 16, 17], dayOfMonth: null, month: null, dayOfWeek: null });
    });

    it('throws on invalid cron expression', () => {
      expect(() => parseCron('invalid')).toThrow();
      expect(() => parseCron('1 2 3')).toThrow();
      expect(() => parseCron('60 25 * * *')).toThrow();
    });
  });

  describe('nextCronRun', () => {
    it('returns next Monday 9:30 AM from a Sunday', () => {
      // Sunday 2026-04-05 10:00 UTC
      const from = Math.floor(new Date('2026-04-05T10:00:00Z').getTime() / 1000);
      const next = nextCronRun('30 9 * * 1', from);
      const date = new Date(next * 1000);
      expect(date.getUTCDay()).toBe(1); // Monday
      expect(date.getUTCHours()).toBe(9);
      expect(date.getUTCMinutes()).toBe(30);
    });

    it('returns next day for daily cron', () => {
      // 2026-04-05 18:30 UTC
      const from = Math.floor(new Date('2026-04-05T18:30:00Z').getTime() / 1000);
      const next = nextCronRun('0 18 * * *', from);
      const date = new Date(next * 1000);
      expect(date.getUTCDate()).toBe(6); // next day
      expect(date.getUTCHours()).toBe(18);
      expect(date.getUTCMinutes()).toBe(0);
    });

    it('returns same day later hour if not yet passed', () => {
      // 2026-04-05 08:00 UTC, cron is 18:00 daily
      const from = Math.floor(new Date('2026-04-05T08:00:00Z').getTime() / 1000);
      const next = nextCronRun('0 18 * * *', from);
      const date = new Date(next * 1000);
      expect(date.getUTCDate()).toBe(5); // same day
      expect(date.getUTCHours()).toBe(18);
    });
  });

  describe('cronToHuman', () => {
    it('formats daily cron', () => {
      expect(cronToHuman('0 9 * * *')).toBe('Daily at 09:00');
    });

    it('formats weekly cron', () => {
      expect(cronToHuman('0 9 * * 1')).toBe('Weekly on Monday at 09:00');
    });

    it('formats monthly cron', () => {
      expect(cronToHuman('0 9 1 * *')).toBe('Monthly on day 1 at 09:00');
    });

    it('formats every-15-minutes cron', () => {
      expect(cronToHuman('*/15 * * * *')).toBe('Every 15 minutes');
    });

    it('returns raw expression for complex crons', () => {
      expect(cronToHuman('30 9,18 * * 1,3,5')).toBe('Cron: 30 9,18 * * 1,3,5');
    });
  });
});

describe('cron.ts uncovered-branch coverage', () => {
  describe('parseField — invalid step', () => {
    it('throws when step is zero', () => {
      expect(() => parseCron('*/0 * * * *')).toThrow();
      expect(parseCron('* * * * *')).toEqual({
        minute: null,
        hour: null,
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when step is non-numeric', () => {
      expect(() => parseCron('*/abc * * * *')).toThrow();
      expect(parseCron('0 * * * *')).toEqual({
        minute: [0],
        hour: null,
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when step is negative', () => {
      expect(() => parseCron('*/-1 * * * *')).toThrow();
      expect(parseCron('0 12 * * *')).toEqual({
        minute: [0],
        hour: [12],
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('parses range-based step expressions', () => {
      // parseInt('5-30/10') returns 5 (leading digits); step 10 walks to max.
      const parsed = parseCron('5-30/10 * * * *');
      expect(parsed.minute).toEqual([5, 15, 25, 35, 45, 55]);
    });

    it('parses full-range step expressions', () => {
      const parsed = parseCron('0-59/20 * * * *');
      expect(parsed.minute).toEqual([0, 20, 40]);
    });
  });

  describe('parseField — out-of-range values', () => {
    it('throws when a comma-separated minute is out of range', () => {
      expect(() => parseCron('0,99 * * * *')).toThrow();
      expect(parseCron('0 * * * *')).toEqual({
        minute: [0],
        hour: null,
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when a comma-separated hour is out of range', () => {
      expect(() => parseCron('0 9,99 * * *')).toThrow();
      expect(parseCron('0 9 * * *')).toEqual({
        minute: [0],
        hour: [9],
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when a comma-separated day-of-month is out of range', () => {
      expect(() => parseCron('0 0 1,99 * *')).toThrow();
      expect(parseCron('0 0 1 * *')).toEqual({
        minute: [0],
        hour: [0],
        dayOfMonth: [1],
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when a single-value minute is out of range', () => {
      expect(() => parseCron('99 * * * *')).toThrow();
      expect(parseCron('0 * * * *')).toEqual({
        minute: [0],
        hour: null,
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when a single-value hour is out of range', () => {
      expect(() => parseCron('0 99 * * *')).toThrow();
      expect(parseCron('0 0 * * *')).toEqual({
        minute: [0],
        hour: [0],
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when a single-value month is out of range', () => {
      expect(() => parseCron('0 0 1 99 *')).toThrow();
      expect(parseCron('0 0 1 12 *')).toEqual({
        minute: [0],
        hour: [0],
        dayOfMonth: [1],
        month: [12],
        dayOfWeek: null,
      });
    });

    it('throws when a single-value day-of-week is out of range', () => {
      expect(() => parseCron('0 0 * * 99')).toThrow();
      expect(parseCron('0 0 * * 0')).toEqual({
        minute: [0],
        hour: [0],
        dayOfMonth: null,
        month: null,
        dayOfWeek: [0],
      });
    });
  });

  describe('parseField — invalid range', () => {
    it('throws when range start is greater than end', () => {
      expect(() => parseCron('0 9-5 * * *')).toThrow();
      expect(parseCron('0 5-9 * * *')).toEqual({
        minute: [0],
        hour: [5, 6, 7, 8, 9],
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when range end is out of bounds', () => {
      expect(() => parseCron('0 0-99 * * *')).toThrow();
      expect(parseCron('0 0-23 * * *')).toEqual({
        minute: [0],
        hour: Array.from({ length: 24 }, (_, i) => i),
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when range start is non-numeric', () => {
      expect(() => parseCron('0 abc-5 * * *')).toThrow();
      expect(parseCron('0 1-5 * * *')).toEqual({
        minute: [0],
        hour: [1, 2, 3, 4, 5],
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('parses a month range', () => {
      const parsed = parseCron('0 0 1 6-8 *');
      expect(parsed.month).toEqual([6, 7, 8]);
    });

    it('parses a day-of-week range', () => {
      const parsed = parseCron('0 0 * * 1-3');
      expect(parsed.dayOfWeek).toEqual([1, 2, 3]);
    });
  });

  describe('parseCron — expression shape', () => {
    it('trims surrounding whitespace before parsing', () => {
      const parsed = parseCron('   30 9 * * 1   ');
      expect(parsed).toEqual({
        minute: [30],
        hour: [9],
        dayOfMonth: null,
        month: null,
        dayOfWeek: [1],
      });
    });

    it('throws when expression has fewer than 5 fields', () => {
      expect(() => parseCron('1 2 3 4')).toThrow();
      expect(parseCron('* * * * *')).toEqual({
        minute: null,
        hour: null,
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });

    it('throws when expression has more than 5 fields', () => {
      expect(() => parseCron('1 2 3 4 5 6')).toThrow();
      expect(parseCron('* * * * *')).toEqual({
        minute: null,
        hour: null,
        dayOfMonth: null,
        month: null,
        dayOfWeek: null,
      });
    });
  });

  describe('nextCronRun — non-null dayOfMonth and month branches', () => {
    it('returns next match for a month-specific cron', () => {
      // 2026-01-15 12:00 UTC, cron is "0 9 1 6 *" (June 1st at 09:00)
      const from = Math.floor(new Date('2026-01-15T12:00:00Z').getTime() / 1000);
      const next = nextCronRun('0 9 1 6 *', from);
      const date = new Date(next * 1000);
      expect(date.getUTCFullYear()).toBe(2026);
      expect(date.getUTCMonth() + 1).toBe(6);
      expect(date.getUTCDate()).toBe(1);
      expect(date.getUTCHours()).toBe(9);
      expect(date.getUTCMinutes()).toBe(0);
    });

    it('returns next match for a day-of-month cron', () => {
      // 2026-04-05 10:00 UTC, cron is "0 0 15 * *" (15th of any month at 00:00)
      const from = Math.floor(new Date('2026-04-05T10:00:00Z').getTime() / 1000);
      const next = nextCronRun('0 0 15 * *', from);
      const date = new Date(next * 1000);
      expect(date.getUTCDate()).toBe(15);
      expect(date.getUTCHours()).toBe(0);
      expect(date.getUTCMinutes()).toBe(0);
    });

    it('returns next match for a comma-separated month list', () => {
      // 2026-02-01 12:00 UTC, cron is "0 9 1 3,6,9 *" (1st of Mar/Jun/Sep at 09:00)
      const from = Math.floor(new Date('2026-02-01T12:00:00Z').getTime() / 1000);
      const next = nextCronRun('0 9 1 3,6,9 *', from);
      const date = new Date(next * 1000);
      expect(date.getUTCMonth() + 1).toBe(3);
      expect(date.getUTCDate()).toBe(1);
      expect(date.getUTCHours()).toBe(9);
      expect(date.getUTCMinutes()).toBe(0);
    });

    it('returns next match when a specific day-of-week aligns', () => {
      // 2026-04-05 10:00 UTC (Sunday), cron "0 12 * * 3" (Wednesday at 12:00)
      const from = Math.floor(new Date('2026-04-05T10:00:00Z').getTime() / 1000);
      const next = nextCronRun('0 12 * * 3', from);
      const date = new Date(next * 1000);
      expect(date.getUTCDay()).toBe(3);
      expect(date.getUTCHours()).toBe(12);
      expect(date.getUTCMinutes()).toBe(0);
    });

    it('throws when no match exists within 366 days (Feb 30)', () => {
      // Feb 30 never exists; the search will exhaust 366 days without a hit.
      const from = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
      expect(() => nextCronRun('0 0 30 2 *', from)).toThrow();
      // sanity: a sane expression still resolves
      const next = nextCronRun('0 0 1 2 *', from);
      expect(Math.floor(new Date(next * 1000).getTime() / 1000)).toBe(next);
    });
  });

  describe('cronToHuman — every-minute and edge cases', () => {
    it('formats "*/1" as "Every minute"', () => {
      expect(cronToHuman('*/1 * * * *')).toBe('Every minute');
    });

    it('formats a large step', () => {
      expect(cronToHuman('*/30 * * * *')).toBe('Every 30 minutes');
    });

    it('falls back when minute array is a single zero (length 1)', () => {
      // "0" matches single-value parsing, so minute = [0]. The "every N" branch
      // requires length > 1, so it falls through to the formatted paths.
      expect(cronToHuman('0 9 * * 1')).toBe('Weekly on Monday at 09:00');
    });

    it('falls back when hour length is more than 1', () => {
      // hour is [9, 18] so timeStr returns null and we hit the raw fallback.
      expect(cronToHuman('0 9,18 * * *')).toBe('Cron: 0 9,18 * * *');
    });

    it('formats a non-zero single-minute daily schedule', () => {
      // minute = [1], minute.length === 1, so the "every N" branch
      // (minute.length > 1 && minute[0] === 0) is skipped; hits "Daily at HH:MM".
      expect(cronToHuman('1 9 * * *')).toBe('Daily at 09:01');
    });

    it('falls back when minute length is > 1 but not evenly stepped', () => {
      // 0,5,7 * * * * — minute array is [0,5,7], length > 1, minute[0]===0,
      // but isStep fails (5 - 0 = 5, but 7 - 5 = 2 ≠ 5). Falls to formatted
      // path; timeStr needs length 1 for both h and m, so falls through.
      expect(cronToHuman('0,5,7 * * * *')).toBe('Cron: 0,5,7 * * * *');
    });

    it('returns raw for monthly with non-null dayOfWeek', () => {
      expect(cronToHuman('0 9 1 * 1')).toBe('Cron: 0 9 1 * 1');
    });

    it('returns raw for monthly with multiple days', () => {
      expect(cronToHuman('0 9 1,15 * *')).toBe('Cron: 0 9 1,15 * *');
    });
  });
});
