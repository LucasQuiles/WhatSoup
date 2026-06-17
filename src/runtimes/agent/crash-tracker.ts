/**
 * CrashTracker — per-scope crash-count bookkeeping for AgentRuntime.
 *
 * Extracted from AgentRuntime as the first slice of the god-class decomposition.
 * Owns the crash-count map and the last-crash timestamp; AgentRuntime's
 * recordCrash/getCrashCount/getRecentCrashCount/decrementCrashCount privates now
 * delegate here, and the prior direct map manipulations (cleanup delete, JID-alias
 * re-key, shutdown clear) are explicit methods.
 *
 * Behavior is identical to the previous inline implementation — see
 * tests/runtimes/agent/crash-count-tracking.test.ts (the characterization suite
 * that locks it).
 *
 * Scope-key DERIVATION (global vs per_chat vs sandbox workspace) intentionally
 * stays in AgentRuntime: it depends on runtime config (sessionScope / sandboxPerChat
 * / cwd), not on crash-count state.
 */
export class CrashTracker {
  private readonly counts = new Map<string, number>();
  private _lastCrashAt: string | null = null;

  /** Record a crash for the scope, stamp lastCrashAt, and return the new count. */
  record(scopeKey: string): number {
    const count = (this.counts.get(scopeKey) ?? 0) + 1;
    this.counts.set(scopeKey, count);
    this._lastCrashAt = new Date().toISOString();
    return count;
  }

  /** Current crash count for a scope (0 if unseen). */
  count(scopeKey: string): number {
    return this.counts.get(scopeKey) ?? 0;
  }

  /** Sum of crash counts across every scope. */
  recentTotal(): number {
    let total = 0;
    for (const count of this.counts.values()) {
      total += count;
    }
    return total;
  }

  /** Decrement a scope's count; remove the scope entirely once it reaches 1. */
  decrement(scopeKey: string): void {
    const count = this.counts.get(scopeKey) ?? 0;
    if (count <= 1) {
      this.counts.delete(scopeKey);
      return;
    }
    this.counts.set(scopeKey, count - 1);
  }

  /** Forget a scope's crash count entirely (per-chat state cleanup). */
  forget(scopeKey: string): void {
    this.counts.delete(scopeKey);
  }

  /**
   * Migrate a scope's crash count from oldKey to newKey (JID-alias change).
   * No-op when oldKey has no recorded count, preserving the prior inline behavior.
   */
  rekey(oldKey: string, newKey: string): void {
    const count = this.counts.get(oldKey);
    if (count === undefined) return;
    this.counts.delete(oldKey);
    this.counts.set(newKey, count);
  }

  /** Clear all crash counts (shutdown/reset). lastCrashAt is left intact. */
  clear(): void {
    this.counts.clear();
  }

  /** ISO timestamp of the most recent recorded crash, or null if none. */
  get lastCrashAt(): string | null {
    return this._lastCrashAt;
  }

  /** Number of scopes currently carrying a non-zero crash count. */
  get size(): number {
    return this.counts.size;
  }
}
