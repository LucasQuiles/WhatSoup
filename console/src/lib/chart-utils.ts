/** Shared chart utilities for recharts-based components. */

import type { MetricsRange } from '../types.js';

export const AXIS_TICK = {
  fontSize: 'var(--font-size-xs)',
  fill: 'var(--color-t4)',
};

/* eslint-disable no-restricted-syntax -- recharts margin accepts raw pixel offsets for SVG layout, not CSS tokens; expires 2026-12-31 */
export const CHART_MARGIN = { top: 4, right: 8, left: -16, bottom: 0 };
/* eslint-enable no-restricted-syntax */

export const TOOLTIP_STYLE = {
  background: 'var(--color-d3)',
  borderWidth: 'var(--bw)',
  borderStyle: 'solid' as const,
  borderColor: 'var(--b2)',
  borderRadius: 'var(--radius-md)',
  boxShadow: 'var(--shadow-md)',
  fontSize: 'var(--font-size-xs)',
};

export function formatBucketLabel(bucket: string, range?: MetricsRange): string {
  const d = new Date(bucket);
  if (range === '30d') {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  if (range === '7d') {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleTimeString([], { hour: 'numeric' });
}
