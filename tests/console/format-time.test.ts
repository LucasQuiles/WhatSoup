import { describe, expect, it } from 'vitest';
import { formatChatTime, formatRelative, formatTime, formatTimeWithSeconds } from '../../console/src/lib/format-time';

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
});
