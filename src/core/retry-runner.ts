/**
 * Generic, composable async retry runner.
 *
 * Consolidates the retry loop pattern that is otherwise duplicated inline
 * across send paths, provider calls, and connection management. This is an
 * opt-in utility — existing inline retry callers are unchanged. New code can
 * adopt it to get a single, well-tested retry primitive.
 *
 * Composes three primitives from this codebase:
 *  - {@link jitteredDelay} / {@link jitteredDelayPositive} — bounded exponential
 *    backoff. When a server `Retry-After` is supplied via `getRetryAfterMs`,
 *    positive-only jitter is used so the client never undercuts the server's
 *    stated floor (prevents thundering-herd escalation). Otherwise symmetric
 *    jitter spreads load.
 *  - {@link sleepWithAbort} — cancelable sleep. An abort signal interrupts the
 *    wait AND prevents further attempts; the AbortSleepError propagates to the
 *    caller so a graceful-shutdown drain cancels cleanly.
 *  - `shouldRetry` predicate — caller-controlled retryability (default: retry
 *    all errors, since narrowing belongs at the call site that knows which
 *    errors are transient for its domain).
 */

import {
  AbortSleepError,
  jitteredDelay,
  jitteredDelayPositive,
  sleepWithAbort,
} from './retry.ts';

export interface RetryOptions {
  /** Maximum retry attempts after the initial try (0 = no retry). */
  retries: number;
  /** Base delay in ms for exponential backoff. Default 1000. */
  baseMs?: number;
  /** Cap on the computed delay. Default 30000. */
  maxMs?: number;
  /**
   * Ceiling (ms) on a server-supplied `Retry-After`. Default 300000 (5 min).
   *
   * When a server `Retry-After` is honored (`getRetryAfterMs` returns non-null),
   * this — NOT `maxMs` — bounds the wait: the full server value is honored up to
   * this ceiling (never clamped down to `maxMs`, which would re-send inside the
   * server's stated window). If the server asks for longer than this ceiling,
   * the runner STOPS retrying: it fires `onRetry` with `delayMs: null` and then
   * surfaces the real error, rather than truncating the wait. `maxMs` still caps
   * the exponential-backoff path (when no server `Retry-After` is present).
   */
  maxRetryAfterMs?: number;
  /**
   * Jitter fraction (0–1). When honoring a server Retry-After, jitter is
   * additive above the floor: delay = floor * (1 + random()*fraction).
   * Default 0.25.
   */
  jitterFraction?: number;
  /**
   * Extract a server-supplied Retry-After (ms) from the error, or null to fall
   * back to exponential backoff. When non-null, positive-only jitter is applied
   * so the client never retries before the server's stated minimum.
   */
  getRetryAfterMs?: (error: unknown) => number | null;
  /** Abort signal — aborting interrupts the current sleep and stops retries. */
  signal?: AbortSignal;
  /**
   * Predicate deciding whether to retry after a failure. Receives the error and
   * the 0-indexed attempt that just failed. Default: retry all errors.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /**
   * Observation hook fired before each retry sleep. `delayMs` is `null` when the
   * runner is giving up because a server `Retry-After` exceeded
   * `maxRetryAfterMs` (no sleep follows; the real error is thrown next).
   */
  onRetry?: (info: {
    attempt: number;
    delayMs: number | null;
    error: unknown;
    retryAfterMs: number | null;
  }) => void;
}

/**
 * Run `run` with bounded retries and exponential backoff.
 *
 * `run` receives the 0-indexed attempt number. On rejection, `shouldRetry`
 * decides whether to retry; if retrying, the runner sleeps (cancelable) and
 * tries again, up to `retries` additional attempts. The caller sees either the
 * successful value or the final rejection.
 *
 * An abort signal interrupting the sleep rejects with {@link AbortSleepError}
 * and no further attempt is made.
 */
export async function retryAsync<T>(
  run: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const retries = opts.retries;
  // Guard the loop bound up front: a negative or non-integer (incl. NaN) count
  // makes `attempt <= retries` false from the start, so the loop never runs and
  // the runner would `throw undefined`. Fail fast with a clear error instead.
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError(
      `retryAsync: retries must be a non-negative integer, received ${String(retries)}`,
    );
  }
  const baseMs = opts.baseMs ?? 1000;
  const maxMs = opts.maxMs ?? 30_000;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 300_000;
  const jitterFraction = opts.jitterFraction ?? 0.25;
  const getRetryAfterMs = opts.getRetryAfterMs;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  const onRetry = opts.onRetry;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      if (!shouldRetry(err, attempt)) break;

      const retryAfterMs = getRetryAfterMs?.(err) ?? null;

      if (retryAfterMs !== null && retryAfterMs > maxRetryAfterMs) {
        // The server asked us to wait longer than we are willing to. Truncating
        // the wait would re-send inside the server's stated window (the very
        // thundering-herd this path exists to prevent), so instead STOP retrying
        // and surface the real error. Signal the decision to observers first.
        onRetry?.({ attempt, delayMs: null, error: err, retryAfterMs });
        break;
      }

      // When a server floor is supplied, use POSITIVE jitter so the client
      // never undercuts the server's stated minimum, and cap at maxRetryAfterMs
      // (already confirmed >= retryAfterMs above) so the full server value is
      // honored — NOT clamped down to maxMs. Otherwise symmetric jitter with the
      // exponential-backoff cap (maxMs) spreads load across concurrent callers.
      const delayMs = retryAfterMs !== null
        ? jitteredDelayPositive(retryAfterMs, 0, maxRetryAfterMs, jitterFraction)
        : jitteredDelay(baseMs, attempt, maxMs);

      onRetry?.({ attempt, delayMs, error: err, retryAfterMs });
      // sleepWithAbort rejects with AbortSleepError on signal abort; that
      // propagates and stops the loop (no further run() call).
      await sleepWithAbort(delayMs, opts.signal);
    }
  }
  // Exhausted retries or shouldRetry declined — surface the last failure.
  throw lastError;
}

// Re-export so consumers can catch the abort without a second import.
export { AbortSleepError };
