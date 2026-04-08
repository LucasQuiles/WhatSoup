/** Shared chart utilities for recharts-based components. */

import type { MetricsRange } from '../types.js';

export const AXIS_TICK = {
  fontSize: 'var(--text-xs)',
  fill: 'var(--color-t4)',
};

/* eslint-disable no-restricted-syntax -- recharts margin accepts raw pixel offsets for SVG layout, not CSS tokens; expires 2026-12-31 */
export const CHART_MARGIN = { top: 4, right: 8, left: -12, bottom: 0 };
/* eslint-enable no-restricted-syntax */

/* eslint-disable no-restricted-syntax -- recharts Tooltip contentStyle is an inline style object; className not supported */
export const TOOLTIP_STYLE = {
  background: 'var(--color-d6)',
  color: 'var(--color-t2)',
  borderWidth: 'var(--bw)',
  borderStyle: 'solid' as const,
  borderColor: 'var(--b3)',
  borderRadius: 'var(--radius-sm)',
  boxShadow: 'var(--shadow-md)',
  fontSize: 'var(--text-xs)',
  fontFamily: 'var(--font-mono)',
  padding: 'var(--sp-2) var(--sp-3)',
};
/* eslint-enable no-restricted-syntax */

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

export function formatTooltipLabel(bucket: string, range?: MetricsRange): string {
  const d = new Date(bucket);
  if (isNaN(d.getTime())) return String(bucket);
  switch (range) {
    case '7d':
      return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    case '30d':
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    default:
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
