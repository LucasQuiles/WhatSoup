/**
 * Configurable reconnect policy with clamped backoff.
 *
 * Exponential backoff with positive jitter and a hard ceiling. All policy
 * parameters are clamped to safe ranges so misconfiguration cannot cause
 * harmful behavior:
 *  - `initialMs` >= 250 (avoid hammering)
 *  - `maxMs` >= `initialMs` (ceiling must be above floor)
 *  - `factor` in [1.1, 10] (sane growth rate)
 *  - `jitter` in [0, 1] (no negative or >100% spread)
 *  - `maxAttempts` >= 0 (integer)
 *
 * Pure functions — no I/O, no timers. The caller composes `computeBackoff()`
 * with `sleepWithAbort()` from `src/core/retry.ts` at the call site.
 */

/** Backoff parameters shared by retry and reconnect policies. */
export interface BackoffPolicy {
  /** Initial delay in ms. Clamped to >= 250. */
  initialMs: number;
  /** Maximum delay in ms. Clamped to >= initialMs. */
  maxMs: number;
  /** Exponential growth factor. Clamped to [1.1, 10]. */
  factor: number;
  /** Jitter fraction in [0, 1]. 0 = no jitter, 1 = full spread. */
  jitter: number;
}

/** Reconnect policy: backoff parameters + attempt cap. */
export interface ReconnectPolicy extends BackoffPolicy {
  /** Maximum reconnect attempts before giving up. Clamped to >= 0 (integer). */
  maxAttempts: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
};

export const DEFAULT_HEARTBEAT_SECONDS = 60;

/** Clamp a number to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Compute the backoff delay (in ms) for a given attempt, with positive jitter.
 *
 * Delay grows as `initialMs * factor^(attempt)` (attempt is 0-indexed: the
 * first retry uses `initialMs`). Capped at `maxMs`. Jitter spreads the delay
 * in `[delay * (1 - jitter), delay]` — always <= the unjittered value, so a
 * server's `Retry-After` floor is never undercut (use this together with
 * `jitteredDelayPositive` from `src/core/retry.ts` when honoring Retry-After).
 */
export function computeBackoff(policy: BackoffPolicy, attempt: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const raw = policy.initialMs * Math.pow(policy.factor, safeAttempt);
  const capped = Math.min(policy.maxMs, raw);
  if (policy.jitter <= 0) {
    return capped;
  }
  const spread = capped * policy.jitter;
  return capped - Math.random() * spread;
}

/**
 * Merge defaults, config overrides, and caller overrides into a single
 * reconnect policy, clamping every field to a safe range.
 */
export function resolveReconnectPolicy(
  configOverrides?: Partial<ReconnectPolicy>,
  callerOverrides?: Partial<ReconnectPolicy>,
): ReconnectPolicy {
  const merged: ReconnectPolicy = {
    ...DEFAULT_RECONNECT_POLICY,
    ...(configOverrides ?? {}),
    ...(callerOverrides ?? {}),
  };
  merged.initialMs = Math.max(250, merged.initialMs);
  merged.maxMs = Math.max(merged.initialMs, merged.maxMs);
  merged.factor = clamp(merged.factor, 1.1, 10);
  merged.jitter = clamp(merged.jitter, 0, 1);
  merged.maxAttempts = Math.max(0, Math.floor(merged.maxAttempts));
  return merged;
}

/**
 * Resolve the heartbeat interval (seconds). Falls back to default when the
 * supplied value is missing or non-positive.
 */
export function resolveHeartbeatSeconds(overrideSeconds?: number): number {
  if (typeof overrideSeconds === 'number' && overrideSeconds > 0) {
    return overrideSeconds;
  }
  return DEFAULT_HEARTBEAT_SECONDS;
}

/** True when `attempt` has reached or exceeded the policy's `maxAttempts`. */
export function isReconnectExhausted(policy: ReconnectPolicy, attempt: number): boolean {
  return attempt >= policy.maxAttempts;
}
