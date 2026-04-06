/** Shared chart utilities for recharts-based components. */

export const AXIS_TICK = {
  fontSize: 'var(--font-size-xs)',
  fill: 'var(--color-t4)',
};

export function formatBucketLabel(bucket: string): string {
  const d = new Date(bucket);
  return d.toLocaleTimeString([], { hour: 'numeric' });
}
