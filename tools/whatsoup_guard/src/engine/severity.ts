import type { Severity } from '../types.ts';

const RANK: Record<Severity, number> = {
  crit: 4,
  high: 3,
  med: 2,
  low: 1,
  info: 0,
};

const HOUR_MS = 60 * 60 * 1000;

const DEDUP_WINDOW_MS: Record<Severity, number> = {
  crit: 0,
  high: 6 * HOUR_MS,
  med: 12 * HOUR_MS,
  low: 24 * HOUR_MS,
  info: 0,
};

export function severityRank(severity: Severity): number {
  return RANK[severity];
}

export function dedupWindowMs(severity: Severity): number {
  return DEDUP_WINDOW_MS[severity];
}
