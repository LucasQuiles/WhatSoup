/**
 * Bounds repeated-failure log storms.
 *
 * A permanent failure (e.g. `no such table`, or a per-chat session entry whose
 * dispatch ownership was lost) must not re-log on every poll forever — one
 * observed health-probe instance emitted 24,613 identical lines over 34 h,
 * another 40,005. The caller's SIGNAL still fires every tick; the LOG is
 * emitted on the 1st failure and then only at power-of-two counts, turning
 * O(polls) log lines into O(log polls) so a permanent error can never become an
 * unbounded storm.
 *
 * A leaf module on purpose: consumers include `src/core/health.ts`, whose own
 * import graph reaches the transport layer, and the agent runtime, which must
 * not pull that graph in just to bound a log line.
 */
export class ProbeErrorThrottle {
  private readonly failures = new Map<string, number>();

  /**
   * Record a failure for `key`. Returns the running failure count when this
   * occurrence should be logged (the 1st, then powers of two), or `null` to
   * suppress it.
   */
  onFailure(key: string): number | null {
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    // Powers of two (and 1) satisfy (n & (n - 1)) === 0.
    return (n & (n - 1)) === 0 ? n : null;
  }

  /**
   * Record a success for `key`. Returns the number of accumulated failures
   * cleared (0 when it was already healthy).
   */
  onSuccess(key: string): number {
    const n = this.failures.get(key) ?? 0;
    if (n > 0) this.failures.delete(key);
    return n;
  }

  reset(): void {
    this.failures.clear();
  }
}
