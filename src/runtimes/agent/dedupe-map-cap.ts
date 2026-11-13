// Moved verbatim out of runtime.ts to keep that file under its recorded size ceiling.
import { MAX_TOOL_FAILURE_ALERT_DEDUP_KEYS } from './runtime-tunables.ts';

/**
 * Bound an evict-oldest dedup map. Mirrors the recentToolFailureAlerts cap so
 * window-pruned maps can't grow without limit between prunes (e.g. one entry per
 * distinct chat that never recurs within the window).
 */
export function capDedupeMap(map: Map<string, unknown>, max = MAX_TOOL_FAILURE_ALERT_DEDUP_KEYS): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
