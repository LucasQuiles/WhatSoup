/** @vitest-environment node */
/**
 * calendar-utils — pure date helpers for the Calendar primitive. These own the
 * YearMonth math, the Monday-first 6×7 grid generation, and the datetime-local
 * <-> date bridging that preserves the time portion on a calendar pick.
 */
import { describe, expect, it } from 'vitest';
import {
  ymKey,
  ymFromDate,
  ymNext,
  ymPrev,
  dayKey,
  buildMonthGrid,
  todayLocalMidnight,
  parseDateOnly,
  setDateOnly,
  initialMonthFor,
  type YearMonth,
} from '../../console/src/components/primitives/calendar-utils';

const JUNE_2099: YearMonth = { year: 2099, month: 5 }; // month is 0-indexed

describe('YearMonth math', () => {
  it('ymKey zero-pads the 0-indexed month', () => {
    expect(ymKey(JUNE_2099)).toBe('2099-05');
    expect(ymKey({ year: 2099, month: 11 })).toBe('2099-11');
  });

  it('ymFromDate reads year + 0-indexed month from a Date', () => {
    expect(ymFromDate(new Date(2099, 5, 15))).toEqual(JUNE_2099);
  });

  it('ymNext rolls December over to the next January', () => {
    expect(ymNext({ year: 2099, month: 11 })).toEqual({ year: 2100, month: 0 });
    expect(ymNext(JUNE_2099)).toEqual({ year: 2099, month: 6 });
  });

  it('ymPrev rolls January back to the previous December', () => {
    expect(ymPrev({ year: 2099, month: 0 })).toEqual({ year: 2098, month: 11 });
    expect(ymPrev(JUNE_2099)).toEqual({ year: 2099, month: 4 });
  });
});

describe('dayKey', () => {
  it('formats a local date as YYYY-MM-DD (1-indexed month)', () => {
    expect(dayKey(new Date(2099, 5, 3))).toBe('2099-06-03');
  });
});

describe('buildMonthGrid', () => {
  const grid = buildMonthGrid(JUNE_2099);

  it('always produces a 42-cell (6×7) grid', () => {
    expect(grid).toHaveLength(42);
  });

  it('starts on the Monday on-or-before the 1st (Monday-first weeks)', () => {
    // June 1 2099 — the first cell must be a Monday (getDay() === 1).
    expect(grid[0].date.getDay()).toBe(1);
  });

  it('flags in-month cells for the displayed month only', () => {
    const inMonth = grid.filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(30); // June has 30 days
    expect(inMonth.every((c) => c.date.getMonth() === 5)).toBe(true);
    // Spillover cells exist on at least one side.
    expect(grid.some((c) => !c.inMonth)).toBe(true);
  });

  it('assigns sequential grid indices', () => {
    expect(grid.map((c) => c.gridIndex)).toEqual(grid.map((_, i) => i));
  });
});

describe('todayLocalMidnight', () => {
  it('returns a Date stripped to local midnight', () => {
    const t = todayLocalMidnight();
    expect(t.getHours()).toBe(0);
    expect(t.getMinutes()).toBe(0);
    expect(t.getSeconds()).toBe(0);
  });
});

describe('parseDateOnly', () => {
  it('parses the date portion of a datetime-local string', () => {
    const d = parseDateOnly('2099-06-15T09:30');
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2099);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(15);
  });

  it('returns undefined for empty or malformed input', () => {
    expect(parseDateOnly(undefined)).toBeUndefined();
    expect(parseDateOnly('')).toBeUndefined();
    expect(parseDateOnly('not-a-date')).toBeUndefined();
  });
});

describe('setDateOnly', () => {
  it('replaces the date portion while preserving the time', () => {
    expect(setDateOnly('2099-06-15T09:30', new Date(2099, 6, 20))).toBe('2099-07-20T09:30');
  });

  it('defaults to 09:00 when the source has no time portion', () => {
    expect(setDateOnly('2099-06-15', new Date(2099, 6, 20))).toBe('2099-07-20T09:00');
  });
});

describe('initialMonthFor', () => {
  it('opens on the month of a parseable value', () => {
    expect(initialMonthFor('2099-06-15T09:00')).toEqual(JUNE_2099);
  });

  it('falls back to the current month for empty input', () => {
    const now = new Date();
    expect(initialMonthFor(undefined)).toEqual({ year: now.getFullYear(), month: now.getMonth() });
  });
});
