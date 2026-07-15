/**
 * Bounded timeout that captures late settlements instead of leaking them as
 * unhandled rejections.
 *
 * A bare `Promise.race([work, timeout])` resolves/rejects with whichever
 * settles first, then stops watching the loser. If `work` later rejects, that
 * rejection has no handler and surfaces as a process-level unhandled rejection
 * — the kind of defect that can crash a host or mask the real failure during
 * incident triage. This utility keeps observing `work` after the timeout fires
 * so a late settlement is routed to an optional `onLateSettle` callback (and
 * never becomes an unhandled rejection, even when the callback is absent).
 *
 * Use for cleanup steps, graceful-shutdown drains, and any bounded wait where
 * the underlying work should still be allowed to settle for logging/diagnostics
 * even though the caller has already moved on.
 */

export interface LateSettleOk<T> {
  ok: true;
  value: T;
}

export interface LateSettleErr {
  ok: false;
  error: unknown;
}

export type LateSettleOutcome<T> = LateSettleOk<T> | LateSettleErr;

export interface WithBoundedTimeoutOptions {
  /**
   * Fired exactly once if the original promise settles AFTER the timeout fired.
   * Use to log late rejections for diagnostics. When omitted, late settlements
   * are silently handled (never unhandled) — strictly safer than a bare race,
   * but you lose observability of the late outcome.
   */
  onLateSettle?: (outcome: LateSettleOutcome<unknown>) => void;
}

/** Error thrown when the timeout fires before the wrapped promise settles. */
export class TimeoutError extends Error {
  readonly isTimeout = true;
  readonly timeoutMs: number;
  constructor(
    timeoutMs: number,
    message?: string,
  ) {
    super(message ?? `operation timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `run()` bounded by `timeoutMs`.
 *
 * - Resolves with the value if `run()` settles before the timeout.
 * - Rejects with the original error if `run()` rejects before the timeout.
 * - Rejects with {@link TimeoutError} if the timeout fires first.
 *
 * After a timeout, the original promise is STILL observed: when it eventually
 * settles, `onLateSettle` is invoked (if supplied). A handler is always
 * attached, so a late rejection NEVER becomes an unhandled rejection — even
 * when `onLateSettle` is absent.
 *
 * `timeoutMs <= 0` rejects immediately with {@link TimeoutError} (the operation
 * is given no time to run). A synchronous throw from `run()` is propagated
 * directly (not wrapped in TimeoutError) so callers see the real error.
 */
export function withBoundedTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  opts: WithBoundedTimeoutOptions = {},
): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new TimeoutError(timeoutMs));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let promise: Promise<T>;

    try {
      promise = run();
    } catch (syncErr) {
      // run() threw before returning a promise — propagate directly.
      reject(syncErr);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Keep observing the original promise so a late rejection has a handler
      // and can be surfaced via onLateSettle instead of crashing the process.
      promise.then(
        (value) => opts.onLateSettle?.({ ok: true, value }),
        (error) => opts.onLateSettle?.({ ok: false, error }),
      );
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        if (settled) return; // timeout already fired; late outcome observed above
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return; // timeout already fired; late outcome observed above
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
