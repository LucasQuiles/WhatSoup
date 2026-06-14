import { describe, expect, it } from 'vitest';
import {
  formatChatTime,
  formatFullTime,
  formatLongDate,
  formatRelative,
  formatShortDate,
  formatTime,
  formatTimeWithSeconds,
} from '../../console/src/lib/format-time';

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
});
