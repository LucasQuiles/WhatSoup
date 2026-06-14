import { describe, it, expect } from 'vitest';
import {
  statusColor,
  statusLabel,
  contentTypeLabel,
  cronToHuman,
} from '../../console/src/components/line-detail/scheduled-utils.ts';

describe('scheduled-utils statusColor', () => {
  it('maps every known ScheduledMessage status to its design-system color token', () => {
    expect(statusColor('pending')).toBe('var(--status-warn-solid)');
    expect(statusColor('processing')).toBe('var(--mode-chat-solid)');
    expect(statusColor('sent')).toBe('var(--status-ok-solid)');
    expect(statusColor('failed')).toBe('var(--status-crit-solid)');
    expect(statusColor('cancelled')).toBe('var(--text-2)');
  });

  it('falls back to neutral text-2 for unknown / empty / case-mismatched statuses', () => {
    expect(statusColor('unknown')).toBe('var(--text-2)');
    expect(statusColor('')).toBe('var(--text-2)');
    expect(statusColor('Pending')).toBe('var(--text-2)');
    expect(statusColor('SENT')).toBe('var(--text-2)');
  });
});

describe('scheduled-utils statusLabel', () => {
  it('capitalizes the first character of each known status', () => {
    expect(statusLabel('pending')).toBe('Pending');
    expect(statusLabel('processing')).toBe('Processing');
    expect(statusLabel('sent')).toBe('Sent');
    expect(statusLabel('failed')).toBe('Failed');
    expect(statusLabel('cancelled')).toBe('Cancelled');
  });

  it('handles empty / already-capitalized / single-character inputs without throwing', () => {
    expect(statusLabel('')).toBe('');
    expect(statusLabel('Sent')).toBe('Sent');
    expect(statusLabel('x')).toBe('X');
  });
});

describe('scheduled-utils contentTypeLabel', () => {
  it('maps every known content type to its display label', () => {
    expect(contentTypeLabel('text')).toBe('Text');
    expect(contentTypeLabel('image')).toBe('Image');
    expect(contentTypeLabel('video')).toBe('Video');
    expect(contentTypeLabel('audio')).toBe('Audio');
    expect(contentTypeLabel('document')).toBe('Document');
    expect(contentTypeLabel('location')).toBe('Location');
    expect(contentTypeLabel('contact')).toBe('Contact');
    expect(contentTypeLabel('poll')).toBe('Poll');
    expect(contentTypeLabel('sticker')).toBe('Sticker');
  });

  it('passes unknown / empty / cased values through verbatim as the default branch', () => {
    expect(contentTypeLabel('reaction')).toBe('reaction');
    expect(contentTypeLabel('')).toBe('');
    expect(contentTypeLabel('Text')).toBe('Text');
    expect(contentTypeLabel('IMAGE')).toBe('IMAGE');
  });
});

describe('scheduled-utils cronToHuman — structural fallback', () => {
  it('returns the input verbatim when the expression does not have exactly five fields', () => {
    expect(cronToHuman('')).toBe('');
    expect(cronToHuman('   ')).toBe('   ');
    expect(cronToHuman('* * * *')).toBe('* * * *');
    expect(cronToHuman('* * * * * *')).toBe('* * * * * *');
    expect(cronToHuman('not-a-cron')).toBe('not-a-cron');
    expect(cronToHuman('@daily')).toBe('@daily');
  });

  it('tolerates surrounding whitespace and irregular spacing when splitting fields', () => {
    expect(cronToHuman('  */5 * * * *  ')).toBe('Every 5 minutes');
    expect(cronToHuman('*/5\t*\t*\t*\t*')).toBe('Every 5 minutes');
    expect(cronToHuman('0   9   *   *   *')).toBe('Daily at 09:00');
  });
});

describe('scheduled-utils cronToHuman — every-N-minutes branch', () => {
  it('formats the */N minute pattern at typical step sizes (5, 10, 15, 30)', () => {
    expect(cronToHuman('*/5 * * * *')).toBe('Every 5 minutes');
    expect(cronToHuman('*/10 * * * *')).toBe('Every 10 minutes');
    expect(cronToHuman('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronToHuman('*/30 * * * *')).toBe('Every 30 minutes');
  });

  it('singularizes the */1 step to "Every minute" and keeps */N plural otherwise', () => {
    expect(cronToHuman('*/1 * * * *')).toBe('Every minute');
    expect(cronToHuman('*/2 * * * *')).toBe('Every 2 minutes');
  });

  it('does not apply the */N-minute branch when dom or dow is set (hr=* blocks specific-time too)', () => {
    // dom non-wildcard → first branch fails; specific-time also fails (hr='*') → Cron fallback
    expect(cronToHuman('*/5 * 1 * *')).toBe('Cron: */5 * 1 * *');
    // dow non-wildcard → same path
    expect(cronToHuman('*/5 * * * 1')).toBe('Cron: */5 * * * 1');
  });
});

describe('scheduled-utils cronToHuman — daily-at-time branch', () => {
  it('formats a daily schedule with zero-padded HH:MM', () => {
    expect(cronToHuman('0 9 * * *')).toBe('Daily at 09:00');
    expect(cronToHuman('30 14 * * *')).toBe('Daily at 14:30');
    expect(cronToHuman('0 0 * * *')).toBe('Daily at 00:00');
    expect(cronToHuman('59 23 * * *')).toBe('Daily at 23:59');
  });

  it('keeps two-digit fields intact and pads single-digit fields', () => {
    expect(cronToHuman('5 8 * * *')).toBe('Daily at 08:05');
    expect(cronToHuman('15 7 * * *')).toBe('Daily at 07:15');
  });
});

describe('scheduled-utils cronToHuman — weekly-on-day branch', () => {
  it('maps every numeric weekday (0..6) to its name when only dow is set', () => {
    expect(cronToHuman('0 0 * * 0')).toBe('Weekly on Sunday at 00:00');
    expect(cronToHuman('0 9 * * 1')).toBe('Weekly on Monday at 09:00');
    expect(cronToHuman('0 9 * * 2')).toBe('Weekly on Tuesday at 09:00');
    expect(cronToHuman('0 9 * * 3')).toBe('Weekly on Wednesday at 09:00');
    expect(cronToHuman('0 9 * * 4')).toBe('Weekly on Thursday at 09:00');
    expect(cronToHuman('30 17 * * 5')).toBe('Weekly on Friday at 17:30');
    expect(cronToHuman('0 12 * * 6')).toBe('Weekly on Saturday at 12:00');
  });

  it('falls back to the generic Cron label when the weekday is out of the 0..6 range', () => {
    expect(cronToHuman('0 9 * * 7')).toBe('Cron: 0 9 * * 7');
    expect(cronToHuman('0 9 * * -1')).toBe('Cron: 0 9 * * -1');
  });

  it('does not interpret named weekdays as the weekly branch (only numeric is supported)', () => {
    // Named weekday is not numeric → parseInt yields NaN → falls through to generic fallback
    expect(cronToHuman('0 9 * * MON')).toBe('Cron: 0 9 * * MON');
    expect(cronToHuman('0 9 * * SUN')).toBe('Cron: 0 9 * * SUN');
  });
});

describe('scheduled-utils cronToHuman — monthly-on-day branch', () => {
  it('formats a monthly schedule on a specific day with the given HH:MM', () => {
    expect(cronToHuman('0 0 1 * *')).toBe('Monthly on day 1 at 00:00');
    expect(cronToHuman('0 9 15 * *')).toBe('Monthly on day 15 at 09:00');
    expect(cronToHuman('30 6 28 * *')).toBe('Monthly on day 28 at 06:30');
  });

  it('does not split the day-of-month field — it is rendered verbatim', () => {
    // Even though "31" is two digits, the function does not zero-pad dom
    expect(cronToHuman('0 0 31 * *')).toBe('Monthly on day 31 at 00:00');
  });
});

describe('scheduled-utils cronToHuman — generic Cron fallback', () => {
  it('falls back to "Cron: <expr>" for list / range / step combinations the formatter does not specialize', () => {
    // List in minute field
    expect(cronToHuman('1,15,30 * * * *')).toBe('Cron: 1,15,30 * * * *');
    // List in hour field
    expect(cronToHuman('0 9,17 * * *')).toBe('Cron: 0 9,17 * * *');
    // Range in minute field (not a recognized branch)
    expect(cronToHuman('0-30 * * * *')).toBe('Cron: 0-30 * * * *');
    // Multiple weekdays
    expect(cronToHuman('0 9 * * 1,3,5')).toBe('Cron: 0 9 * * 1,3,5');
    // List in dom
    expect(cronToHuman('0 9 1,15 * *')).toBe('Cron: 0 9 1,15 * *');
  });

  it('falls back when both dom and dow are non-wildcards (no branch matches that combination)', () => {
    expect(cronToHuman('0 9 15 * 1')).toBe('Cron: 0 9 15 * 1');
  });

  it('falls back when min or hr contains a wildcard but the other field is concrete', () => {
    expect(cronToHuman('* 9 * * *')).toBe('Cron: * 9 * * *');
    expect(cronToHuman('0 * * * *')).toBe('Cron: 0 * * * *');
  });
});
