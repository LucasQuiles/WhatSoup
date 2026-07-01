/**
 * fallback-eligibility-cache.ts - TTL-memoised credential-presence resolver for
 * the idle fallback snapshot.
 *
 * The steady-state (pre-selection) fallback snapshot reported by getFallbackState
 * feeds the /health endpoint, which is polled frequently. Resolving real
 * credential presence means a keyring lookup (a subprocess on macOS/Linux with a
 * multi-second timeout), so calling it per entry per poll would add unbounded
 * synchronous IO - and up to a multi-second stall when the keychain is slow or
 * locked - to the health path. This memoises the resolver per entry key with a
 * TTL so the keyring is consulted at most once per entry per window, while still
 * picking up a credential that is provisioned (or rotated) while the process runs.
 *
 * The clock is injected so the TTL is deterministically testable.
 */
import type { AgentFallbackEntry } from '../../core/fallback-chain.ts';

/** Default refresh window for idle eligibility - credentials change rarely. */
export const IDLE_FALLBACK_ELIGIBILITY_TTL_MS = 5 * 60 * 1000;

function entryKey(entry: AgentFallbackEntry): string {
  return [entry.provider, entry.model ?? ''].join('|');
}

/**
 * Wrap a credential-presence resolver with per-entry TTL memoisation.
 *
 * @param resolve  underlying resolver (e.g. keyring lookup); may be costly.
 * @param now      monotonic-ish clock in ms (injected for testability).
 * @param ttlMs    cache lifetime per entry.
 */
export function makeIdleEligibilityResolver(
  resolve: (entry: AgentFallbackEntry) => boolean | null,
  now: () => number,
  ttlMs: number = IDLE_FALLBACK_ELIGIBILITY_TTL_MS,
): (entry: AgentFallbackEntry) => boolean | null {
  const cache = new Map<string, { value: boolean | null; at: number }>();
  return (entry: AgentFallbackEntry): boolean | null => {
    const key = entryKey(entry);
    const t = now();
    const hit = cache.get(key);
    if (hit !== undefined && t - hit.at < ttlMs) {
      return hit.value;
    }
    const value = resolve(entry);
    cache.set(key, { value, at: t });
    return value;
  };
}
