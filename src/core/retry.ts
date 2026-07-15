/** Simple promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter: delay = base * 2^attempt * random(0.75, 1.25), capped at maxMs */
export function jitteredDelay(baseMs: number, attempt: number, maxMs = 30_000): number {
  const exp = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exp, maxMs);
  return capped * (0.75 + Math.random() * 0.5);
}

/**
 * Error thrown by {@link sleepWithAbort} when the abort signal fires before the
 * timer completes. Carries the requested duration so callers can log how much
 * of the wait was cut short.
 */
export class AbortSleepError extends Error {
  readonly isAbortSleep = true;
  readonly requestedMs: number;
  constructor(requestedMs: number) {
    super(`sleep of ${requestedMs}ms aborted`);
    this.name = 'AbortSleepError';
    this.requestedMs = requestedMs;
  }
}

/**
 * Promise-based sleep that rejects with {@link AbortSleepError} if the signal
 * aborts before the timer fires. The timer is `unref()`'d so it does not keep
 * an otherwise-idle process alive, and the abort listener is removed on both
 * completion and abort so there is no listener leak.
 *
 * Use this instead of bare {@link sleep} wherever the wait should be cancelable:
 * retry loops, graceful-shutdown drains, rate-limit waits. The stable error
 * class lets callers distinguish a deliberate cancel from an unexpected failure.
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new AbortSleepError(ms));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal!.removeEventListener('abort', onAbort);
      reject(new AbortSleepError(ms));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Positive-only (additive) jittered exponential delay.
 *
 * Unlike {@link jitteredDelay} (symmetric 0.75–1.25×, which can fall *below*
 * the un-jittered floor), this NEVER returns less than the exponential floor.
 * Use it when honoring a server-supplied `Retry-After`: a client that undercuts
 * the server's stated minimum can trigger escalation (thundering-herd to the
 * same rate-limited endpoint). With no server contract, prefer symmetric
 * {@link jitteredDelay} to spread load.
 *
 * `delay = min(base * 2^attempt, maxMs) * (1 + random() * jitterFraction)`
 *
 * The result is therefore in `[floor, floor * (1 + jitterFraction)]`, where
 * `floor = min(base * 2^attempt, maxMs)`. Default jitterFraction (0.25) bounds
 * overhead to 25% above the floor.
 */
export function jitteredDelayPositive(
  baseMs: number,
  attempt: number,
  maxMs = 30_000,
  jitterFraction = 0.25,
): number {
  const exp = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exp, maxMs);
  return capped * (1 + Math.random() * jitterFraction);
}
