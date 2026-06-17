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
 *   - count: peek without consuming (used by the auto-compact next-turn gate, which
 *     only measures genuine user turns).
 *
 * The raw `counts` map is exposed (public readonly) so AgentRuntime's per-chat
 * cleanup / shutdown can drop or clear entries in line with the other per-chat
 * maps, mirroring the ImageCoalescer.buffers pattern. Behavior is identical to the
 * previous inline implementation — see the system-result characterization coverage
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

  /** A system turn is about to fire for this scope — increment. No-op for undefined. */
  mark(scopeKey: string | undefined): void {
    if (scopeKey === undefined) return;
    this.counts.set(scopeKey, (this.counts.get(scopeKey) ?? 0) + 1);
  }

  /**
   * Reverse a mark when the system turn's send failed and no result event will
   * arrive. Guarded so the counter never goes negative. No-op for undefined.
   */
  unmark(scopeKey: string | undefined): void {
    if (scopeKey === undefined) return;
    const pending = this.counts.get(scopeKey) ?? 0;
    if (pending > 0) this.counts.set(scopeKey, pending - 1);
  }

  /** Outstanding system-turn count for this scope (peek; does not consume). */
  count(scopeKey: string): number {
    return this.counts.get(scopeKey) ?? 0;
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
      return true;
    }
    return false;
  }
}
