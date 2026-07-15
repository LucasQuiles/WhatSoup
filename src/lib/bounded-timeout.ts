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

import { createChildLogger } from '../logger.ts';

const log = createChildLogger('bounded-timeout');

/**
 * Platform ceiling for a 32-bit `setTimeout` delay. A delay above this silently
 * overflows and is clamped to `1ms` by the runtime, turning a "long timeout"
 * into an "immediate timeout" — so we reject rather than clamp.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

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
 * Deliver a late settlement to `onLateSettle` without ever leaking an unhandled
 * rejection. The callback is invoked from a fresh microtask so that BOTH a
 * synchronous throw AND a returned rejected promise (async-misuse of the
 * `=> void` contract) are captured by the trailing `.catch`. The diagnostic log
 * is itself guarded: `onLateSettle`'s whole purpose is late-shutdown
 * diagnostics, and the logger may already be torn down, so a failing log must
 * not re-throw.
 */
function invokeLateSettle(
  outcome: LateSettleOutcome<unknown>,
  onLateSettle: WithBoundedTimeoutOptions['onLateSettle'],
): void {
  if (!onLateSettle) return;
  Promise.resolve()
    .then(() => onLateSettle(outcome))
    .catch((err) => {
      try {
        log.error({ err }, 'onLateSettle callback threw — late settlement outcome dropped');
      } catch {
        // Logger torn down mid-shutdown (the documented use case): swallow.
      }
    });
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
 * Invalid `timeoutMs` is rejected rather than clamped:
 * - non-finite (`NaN`, `±Infinity`) rejects with {@link RangeError};
 * - a value above {@link MAX_TIMEOUT_MS} (the 32-bit timer ceiling) rejects with
 *   {@link RangeError}, since the runtime would otherwise clamp it to `1ms`;
 * - `timeoutMs <= 0` rejects immediately with {@link TimeoutError} (the
 *   operation is given no time to run).
 *
 * The non-finite check is applied first, so `-Infinity` yields a `RangeError`
 * (bad input) rather than a `TimeoutError`.
 *
 * A synchronous throw from `run()` is propagated directly (not wrapped in
 * TimeoutError) so callers see the real error. Any throw/rejection from
 * `onLateSettle` is caught and logged, never surfaced as an unhandled rejection.
 */
export function withBoundedTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  opts: WithBoundedTimeoutOptions = {},
): Promise<T> {
  if (!Number.isFinite(timeoutMs)) {
    return Promise.reject(new RangeError(`timeoutMs must be a finite number, got ${timeoutMs}`));
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return Promise.reject(
      new RangeError(`timeoutMs ${timeoutMs} exceeds the platform maximum of ${MAX_TIMEOUT_MS}ms`),
    );
  }
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
      // invokeLateSettle isolates any throw/rejection from the callback.
      promise.then(
        (value) => invokeLateSettle({ ok: true, value }, opts.onLateSettle),
        (error) => invokeLateSettle({ ok: false, error }, opts.onLateSettle),
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
