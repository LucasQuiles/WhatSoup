/**
 * GUI-5 freshness derivation for polled query planes (metrics, fleet metrics).
 *
 * The fleet health plane already carries a server-stamped observed/stale
 * contract (`LineInstance.healthObservedAt` / `stale`). Polled react-query
 * planes get the same fail-closed semantics client-side from the query's own
 * `dataUpdatedAt`: a surface showing data older than the threshold — or kept
 * after a failed refetch — must be labeled stale, never silently green.
 *
 * Stale only labels; it never hides the payload (inconclusive ≠ invisible).
 */

export interface Freshness {
  /** Epoch ms of the last successful observation, or null when never fetched. */
  observedAt: number | null;
  /** True when the visible data is not a current observation. */
  stale: boolean;
}

/** Metrics planes poll every 60 s; two missed intervals means carried data. */
export const METRICS_STALE_AFTER_MS = 2 * 60_000;

export function queryFreshness(args: {
  /** react-query `dataUpdatedAt` (0 when the query has never succeeded). */
  dataUpdatedAt: number;
  /** True when a refetch failed and the shown data is carried forward. */
  refetchFailed: boolean;
  /** Injectable clock (defaults to Date.now()) for deterministic tests. */
  now?: number;
  /** Override the stale threshold (defaults to METRICS_STALE_AFTER_MS). */
  staleAfterMs?: number;
}): Freshness {
  const { dataUpdatedAt, refetchFailed } = args;
  const now = args.now ?? Date.now();
  const staleAfterMs = args.staleAfterMs ?? METRICS_STALE_AFTER_MS;

  if (dataUpdatedAt <= 0) {
    // First load in flight: nothing shown yet, so nothing can be stale.
    return { observedAt: null, stale: false };
  }
  const agedOut = now - dataUpdatedAt > staleAfterMs;
  return { observedAt: dataUpdatedAt, stale: refetchFailed || agedOut };
}
