import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatChatTime,
  formatFullTime,
  formatLongDate,
  formatRelative,
  formatShortDate,
  formatTime,
  formatTimeWithSeconds,
} from '../../console/src/lib/format-time';

afterEach(() => {
  vi.useRealTimers();
});

describe('timestamp format helpers', () => {
  it('renders missing timestamps as an empty marker', () => {
    expect(formatRelative(null)).toBe('\u2014');
    expect(formatTime(null)).toBe('\u2014');
    expect(formatTimeWithSeconds(null)).toBe('\u2014');
    expect(formatChatTime(null)).toBe('\u2014');
  });

  it('renders unknown and blank timestamps as an empty marker', () => {
    expect(formatRelative('unknown')).toBe('\u2014');
    expect(formatTime('')).toBe('\u2014');
    expect(formatTimeWithSeconds('   ')).toBe('\u2014');
    expect(formatChatTime('not-a-date')).toBe('\u2014');
  });

  it('formats SQLite timestamp strings as UTC', () => {
    expect(formatTimeWithSeconds('2026-04-05 19:30:45')).toBe(
      formatTimeWithSeconds('2026-04-05T19:30:45Z'),
    );
  });

  it('formats epoch-second timestamps through the shared helpers', () => {
    const epochSeconds = Date.parse('2026-04-05T19:30:45Z') / 1000;
    expect(formatFullTime(epochSeconds)).toBe(formatFullTime('2026-04-05T19:30:45Z'));
    expect(formatTime(epochSeconds)).toBe(formatTime('2026-04-05T19:30:45Z'));
  });

  it('formats short and long date labels', () => {
    expect(formatShortDate('2026-04-05T00:00:00')).toBe('Apr 5');
    expect(formatLongDate('2026-04-05T00:00:00')).toBe('April 5, 2026');
  });

  it('returns empty markers for non-finite numeric timestamps and invalid date labels', () => {
    expect(formatFullTime(Number.POSITIVE_INFINITY)).toBe('\u2014');
    expect(formatShortDate('invalid-date')).toBe('\u2014');
    expect(formatLongDate('invalid-date')).toBe('\u2014');
  });

  it('formats relative timestamps across future, minute, hour, and day bands', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T20:00:00Z'));

    expect(formatRelative('2026-04-05T20:00:30Z')).toBe('just now');
    expect(formatRelative('2026-04-05T19:57:00Z')).toBe('3m ago');
    expect(formatRelative('2026-04-05T17:00:00Z')).toBe('3h ago');
    expect(formatRelative('2026-04-03T20:00:00Z')).toBe('2d ago');
  });

  it('formats chat timestamps for today, yesterday, and older dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T20:00:00Z'));

    expect(formatChatTime('2026-04-05T19:30:00Z')).toBe(formatTime('2026-04-05T19:30:00Z'));
    expect(formatChatTime('2026-04-04T19:30:00Z')).toBe('Yesterday');
    expect(formatChatTime('2026-04-01T19:30:00Z')).toBe('Apr 1');
  });
});
