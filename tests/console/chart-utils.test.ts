/**
 * Direct unit coverage for console/src/lib/chart-utils.ts.
 *
 * The module ships three style constants used by recharts components and two
 * date-formatting helpers used for axis + tooltip labels.
 *
 * Assertion strategy: the formatters call `Date.prototype.toLocaleDateString`
 * and `.toLocaleTimeString` with an empty locale array — output depends on
 * the Node runtime locale and ICU data. To stay deterministic, this file
 * pins:
 *   - exact shape of the style constants
 *   - the NaN-date guard branch (locale-independent)
 *   - cross-range BEHAVIOR (different `range` params → different non-empty
 *     output for the same bucket) without asserting exact locale strings
 */
import { describe, expect, it } from 'vitest';
import {
  AXIS_TICK,
  CHART_MARGIN,
  LEGEND_STYLE,
  MESSAGE_VOLUME_SERIES_COLORS,
  TOOLTIP_STYLE,
  formatBucketLabel,
  formatTooltipLabel,
} from '../../console/src/lib/chart-utils';

describe('chart style constants', () => {
  it('AXIS_TICK exposes fontSize + fill', () => {
    expect(AXIS_TICK).toEqual({ fontSize: 'var(--text-xs)', fill: 'var(--text-2)' });
  });

  it('CHART_MARGIN exposes the recharts-style { top, right, left, bottom } shape', () => {
    expect(CHART_MARGIN).toEqual({ top: 4, right: 8, left: -12, bottom: 0 });
  });

  it('LEGEND_STYLE exposes the shared recharts legend typography style', () => {
    expect(LEGEND_STYLE).toEqual({ fontSize: 'var(--text-xs)' });
  });

  it('TOOLTIP_STYLE exposes the full inline-style block including required CSS-token references', () => {
    expect(TOOLTIP_STYLE).toEqual({
      background: 'var(--color-d6)',
      color: 'var(--color-t2)',
      borderWidth: 'var(--bw)',
      borderStyle: 'solid',
      borderColor: 'var(--b3)',
      borderRadius: 'var(--radius-sm)',
      boxShadow: 'var(--shadow-md)',
      fontSize: 'var(--text-xs)',
      fontFamily: 'var(--font-mono)',
      padding: 'var(--sp-2) var(--sp-3)',
    });
  });

  it('MESSAGE_VOLUME_SERIES_COLORS maps aggregate message dimensions to data tokens', () => {
    expect(MESSAGE_VOLUME_SERIES_COLORS).toEqual({
      inbound: 'var(--data-inbound-solid)',
      outbound: 'var(--data-outbound-solid)',
      media: 'var(--data-media-solid)',
    });
    for (const color of Object.values(MESSAGE_VOLUME_SERIES_COLORS)) {
      expect(color).toMatch(/^var\(--data-/);
      expect(color).not.toMatch(/--(?:color-[ms]-|provider-|status-|mode-)/);
    }
  });
});

describe('formatBucketLabel', () => {
  const validIso = '2026-05-12T13:00:00Z';

  it('returns a non-empty string for each supported range', () => {
    expect(formatBucketLabel(validIso, '7d')).not.toBe('');
    expect(formatBucketLabel(validIso, '30d')).not.toBe('');
    expect(formatBucketLabel(validIso, undefined)).not.toBe('');
  });

  it('produces different output for the three different range branches', () => {
    const sevenDay = formatBucketLabel(validIso, '7d');
    const thirtyDay = formatBucketLabel(validIso, '30d');
    const noRange = formatBucketLabel(validIso, undefined);
    // 7d uses weekday only; 30d uses month+day; no-range uses hour-only —
    // pairwise these MUST differ for the same input.
    expect(sevenDay).not.toBe(thirtyDay);
    expect(sevenDay).not.toBe(noRange);
    expect(thirtyDay).not.toBe(noRange);
  });
});

describe('formatTooltipLabel', () => {
  const validIso = '2026-05-12T13:00:00Z';

  it('falls back to the raw bucket string when the date is unparseable', () => {
    expect(formatTooltipLabel('not-a-date', '7d')).toBe('not-a-date');
    expect(formatTooltipLabel('', '30d')).toBe('');
    // Non-string raw bucket coerces through String(...) in the guard branch
    expect(formatTooltipLabel('unparseable', undefined)).toBe('unparseable');
  });

  it('returns a non-empty string for each supported range with a valid date', () => {
    expect(formatTooltipLabel(validIso, '7d')).not.toBe('');
    expect(formatTooltipLabel(validIso, '30d')).not.toBe('');
    expect(formatTooltipLabel(validIso, undefined)).not.toBe('');
  });

  it('produces different output for the three different range branches', () => {
    const sevenDay = formatTooltipLabel(validIso, '7d');
    const thirtyDay = formatTooltipLabel(validIso, '30d');
    const noRange = formatTooltipLabel(validIso, undefined);
    // 7d adds weekday; 30d does month+day; default adds time-of-day — pairwise distinct.
    expect(sevenDay).not.toBe(thirtyDay);
    expect(thirtyDay).not.toBe(noRange);
    expect(sevenDay).not.toBe(noRange);
  });

  it('default-range output is longer than the 30d output (carries appended time-of-day)', () => {
    const thirtyDay = formatTooltipLabel(validIso, '30d');
    const noRange = formatTooltipLabel(validIso, undefined);
    expect(noRange.length).toBeGreaterThan(thirtyDay.length);
  });
});
