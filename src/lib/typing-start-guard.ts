/**
 * Circuit breaker for typing-indicator ("composing" presence) calls.
 *
 * Wraps channel typing-start calls in a guard that tracks consecutive
 * failures. After `maxConsecutiveFailures`, the breaker trips and all
 * subsequent calls return `"skipped"` without hitting the channel backend.
 * This prevents failed typing indicators from repeatedly delaying reply
 * delivery when a channel's backend starts rejecting start calls.
 *
 * The breaker can be reset (e.g., on reconnection) to give the channel a
 * fresh chance.
 */

/** Discriminated result of a guarded typing-start attempt. */
export type TypingStartResult = 'started' | 'skipped' | 'failed' | 'tripped';

export interface TypingStartGuard {
  /**
   * Run a typing-start callback through the guard.
   * Returns the outcome without throwing (unless `rethrowOnError` is set).
   */
  run: (start: () => Promise<void> | void) => Promise<TypingStartResult>;
  /** Reset the failure counter and clear the tripped state. */
  reset: () => void;
  /** Whether the breaker is currently tripped. */
  isTripped: () => boolean;
}

export interface CreateTypingStartGuardParams {
  /** Returns true when the session/channel is sealed (no more messages expected). */
  isSealed: () => boolean;
  /** Optional additional block condition (e.g., turn not in progress). */
  shouldBlock?: () => boolean;
  /** Called when a typing-start attempt throws (for logging). */
  onStartError?: (err: unknown) => void;
  /** Consecutive failures before tripping. Default: no trip (retry forever). */
  maxConsecutiveFailures?: number;
  /** Called when the breaker trips. */
  onTrip?: () => void;
  /** Re-throw the error instead of swallowing it. Default: false. */
  rethrowOnError?: boolean;
}

/**
 * Creates a circuit breaker for channel typing-start calls.
 */
export function createTypingStartGuard(
  params: CreateTypingStartGuardParams,
): TypingStartGuard {
  const maxConsecutiveFailures =
    typeof params.maxConsecutiveFailures === 'number' && params.maxConsecutiveFailures > 0
      ? Math.floor(params.maxConsecutiveFailures)
      : undefined;
  let consecutiveFailures = 0;
  let tripped = false;

  const isBlocked = (): boolean => {
    if (params.isSealed()) return true;
    if (tripped) return true;
    return params.shouldBlock?.() === true;
  };

  const run: TypingStartGuard['run'] = async (start) => {
    if (isBlocked()) return 'skipped';
    try {
      await start();
      consecutiveFailures = 0;
      return 'started';
    } catch (err) {
      consecutiveFailures += 1;
      params.onStartError?.(err);
      if (params.rethrowOnError) throw err;
      if (maxConsecutiveFailures && consecutiveFailures >= maxConsecutiveFailures) {
        tripped = true;
        params.onTrip?.();
        return 'tripped';
      }
      return 'failed';
    }
  };

  return {
    run,
    reset: () => {
      consecutiveFailures = 0;
      tripped = false;
    },
    isTripped: () => tripped,
  };
}
