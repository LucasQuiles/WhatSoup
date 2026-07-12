/**
 * PendingSystemResultTracker — per-scope counter of in-flight "system" turns
 * (context injection, continuation, auto-compact /compact) whose result events
 * must NOT consume a user inbound seq.
 *
 * Extracted from AgentRuntime as a god-class slice. Owns the per-scope counter map
 * and the small set of invariants around it:
 *   - mark: a system turn is about to fire (increment).
 *   - unmark: a system turn's send failed and no result will arrive — reverse the
 *     increment so a later genuine user-turn result is not misclassified as a
 *     system result. Floored at zero so the counter never goes negative.
 *   - consumeIfPending: a result arrived; if a system turn is outstanding, consume
 *     one (it belongs to that system turn) and report true, else report false (the
 *     result belongs to a user turn).
 *   - releaseBlockingMark: a timed-out system turn stops blocking later dispatch,
 *     but keeps its FIFO classification slot until its late result arrives.
 *   - count: peek without consuming (used by the auto-compact next-turn gate, which
 *     only measures genuine user turns).
 *
 * The raw `counts` map is exposed (public readonly) so AgentRuntime's per-chat
 * cleanup / shutdown can drop or clear entries in line with the other per-chat
 * maps, mirroring the ImageCoalescer.buffers pattern. See the system-result coverage
 * in tests/runtimes/agent/runtime.test.ts and fallback-empty-turn.test.ts
 * (system-result suppression on result/token_usage, GLOBAL-scope shared-mode path,
 * unmark-on-send-failure, cleanup).
 */
export class PendingSystemResultTracker {
  /**
   * scopeKey → count of outstanding system turns. Public readonly so AgentRuntime's
   * cleanupPerChatState / shutdown can delete/clear entries alongside the sibling
   * per-chat maps; all increment/decrement logic goes through the methods below.
   */
  readonly counts = new Map<string, number>();
  private readonly blockingCounts = new Map<string, number>();
  private readonly releasedResultCounts = new Map<string, number>();
  private readonly waiters = new Map<string, Set<{ maxPending: number; resolve: () => void }>>();

  private settleEligibleWaiters(scopeKey: string): void {
    const waiters = this.waiters.get(scopeKey);
    if (!waiters) return;
    const pending = this.blockingCount(scopeKey);
    for (const waiter of waiters) {
      if (pending > waiter.maxPending) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
    if (waiters.size === 0) this.waiters.delete(scopeKey);
  }

  /** A system turn is about to fire for this scope — increment. No-op for undefined. */
  mark(scopeKey: string | undefined): void {
    if (scopeKey === undefined) return;
    this.counts.set(scopeKey, (this.counts.get(scopeKey) ?? 0) + 1);
    this.blockingCounts.set(scopeKey, this.blockingCount(scopeKey) + 1);
  }

  /**
   * Reverse a mark when the system turn's send failed and no result event will
   * arrive. Guarded so the counter never goes negative. No-op for undefined.
   */
  unmark(scopeKey: string | undefined): void {
    if (scopeKey === undefined) return;
    const pending = this.counts.get(scopeKey) ?? 0;
    if (pending > 0) this.counts.set(scopeKey, pending - 1);
    const blocking = this.blockingCount(scopeKey);
    if (blocking > 0) {
      this.blockingCounts.set(scopeKey, blocking - 1);
    } else {
      const released = this.releasedResultCounts.get(scopeKey) ?? 0;
      if (released > 0) this.releasedResultCounts.set(scopeKey, released - 1);
    }
    this.settleEligibleWaiters(scopeKey);
  }

  /** Outstanding system-turn count for this scope (peek; does not consume). */
  count(scopeKey: string): number {
    return this.counts.get(scopeKey) ?? 0;
  }

  /** Outstanding system turns that still block dispatch of a following turn. */
  blockingCount(scopeKey: string): number {
    return this.blockingCounts.get(scopeKey) ?? 0;
  }

  /**
   * Release the oldest system turn as a dispatch barrier while retaining its
   * result-classification slot. FIFO result consumption removes that released
   * slot before touching any later blocking mark.
   */
  releaseBlockingMark(scopeKey: string): void {
    const blocking = this.blockingCount(scopeKey);
    if (blocking === 0) return;
    this.blockingCounts.set(scopeKey, blocking - 1);
    this.releasedResultCounts.set(
      scopeKey,
      (this.releasedResultCounts.get(scopeKey) ?? 0) + 1,
    );
    this.settleEligibleWaiters(scopeKey);
  }

  /** Cancel a previously released result slot without touching newer blocking marks. */
  unmarkReleased(scopeKey: string): boolean {
    const released = this.releasedResultCounts.get(scopeKey) ?? 0;
    if (released === 0) return false;
    this.releasedResultCounts.set(scopeKey, released - 1);
    const pending = this.count(scopeKey);
    if (pending > 0) this.counts.set(scopeKey, pending - 1);
    this.settleEligibleWaiters(scopeKey);
    return true;
  }

  /**
   * A result arrived for this scope. If a system turn is outstanding, consume one
   * and return true (the result belongs to that system turn, not a user turn);
   * otherwise return false.
   */
  consumeIfPending(scopeKey: string): boolean {
    const pending = this.counts.get(scopeKey) ?? 0;
    if (pending > 0) {
      this.counts.set(scopeKey, pending - 1);
      const released = this.releasedResultCounts.get(scopeKey) ?? 0;
      if (released > 0) {
        this.releasedResultCounts.set(scopeKey, released - 1);
      } else {
        const blocking = this.blockingCount(scopeKey);
        if (blocking > 0) this.blockingCounts.set(scopeKey, blocking - 1);
      }
      this.settleEligibleWaiters(scopeKey);
      return true;
    }
    return false;
  }

  /** Wait until every blocking system turn has a result, failed send, or explicit timeout release. */
  waitForDrain(scopeKey: string): Promise<void> {
    return this.waitForCountAtMost(scopeKey, 0);
  }

  /** Wait while earlier system turns drain, allowing the caller's own existing mark. */
  waitForCountAtMost(scopeKey: string, maxPending: number): Promise<void> {
    if (this.blockingCount(scopeKey) <= maxPending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.waiters.get(scopeKey)
        ?? new Set<{ maxPending: number; resolve: () => void }>();
      waiters.add({ maxPending, resolve });
      this.waiters.set(scopeKey, waiters);
    });
  }

  /** Drop one dead/replaced scope and release callers that were waiting on its old child. */
  clearScope(scopeKey: string): void {
    this.counts.delete(scopeKey);
    this.blockingCounts.delete(scopeKey);
    this.releasedResultCounts.delete(scopeKey);
    this.settleEligibleWaiters(scopeKey);
  }

  clear(): void {
    for (const scopeKey of new Set([
      ...this.counts.keys(),
      ...this.blockingCounts.keys(),
      ...this.releasedResultCounts.keys(),
      ...this.waiters.keys(),
    ])) {
      this.clearScope(scopeKey);
    }
  }
}
