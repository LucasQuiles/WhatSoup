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
