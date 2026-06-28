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
  /**
   * Per-scope epoch-ms crash timestamps, mirroring `counts` exactly (every
   * record/decrement/forget/rekey/clear keeps the two in lock-step, so
   * `crashTimes[s].length === counts[s]`). This adds a TIME-WINDOWED health view
   * (#1427 — {@link recentWithin}) on top of the cumulative `counts` (which keep
   * driving auto-respawn backoff/exhaustion) without changing any existing
   * decay/cleanup semantics.
   */
  private readonly crashTimes = new Map<string, number[]>();

  /** Record a crash for the scope, stamp lastCrashAt, and return the new count. */
  record(scopeKey: string): number {
    const count = (this.counts.get(scopeKey) ?? 0) + 1;
    this.counts.set(scopeKey, count);
    this._lastCrashAt = new Date().toISOString();
    const times = this.crashTimes.get(scopeKey) ?? [];
    times.push(Date.now());
    this.crashTimes.set(scopeKey, times);
    return count;
  }

  /** Current crash count for a scope (0 if unseen). */
  count(scopeKey: string): number {
    return this.counts.get(scopeKey) ?? 0;
  }

  /** Sum of crash counts across every scope (lifetime cumulative). */
  recentTotal(): number {
    let total = 0;
    for (const count of this.counts.values()) {
      total += count;
    }
    return total;
  }

  /**
   * Number of crashes recorded within the last `windowMs` (#1427 health decay).
   * Prunes aged-out entries in place so a transient crash stops counting once it
   * leaves the window — unlike {@link recentTotal}, which is a lifetime sum that
   * pins health=degraded forever. Use this for the health-degraded decision;
   * keep {@link count}/{@link recentTotal} for cumulative respawn bookkeeping.
   */
  recentWithin(windowMs: number, now: number = Date.now()): number {
    const cutoff = now - windowMs;
    let total = 0;
    for (const [scopeKey, times] of this.crashTimes) {
      let firstFresh = 0;
      while (firstFresh < times.length && times[firstFresh]! < cutoff) {
        firstFresh += 1;
      }
      if (firstFresh > 0) times.splice(0, firstFresh);
      if (times.length === 0) this.crashTimes.delete(scopeKey);
      else total += times.length;
    }
    return total;
  }

  /** Decrement a scope's count; remove the scope entirely once it reaches 1. */
  decrement(scopeKey: string): void {
    const count = this.counts.get(scopeKey) ?? 0;
    if (count <= 1) {
      this.counts.delete(scopeKey);
      this.crashTimes.delete(scopeKey);
      return;
    }
    this.counts.set(scopeKey, count - 1);
    const times = this.crashTimes.get(scopeKey);
    if (times && times.length > 0) {
      times.shift();
      if (times.length === 0) this.crashTimes.delete(scopeKey);
    }
  }

  /** Forget a scope's crash count entirely (per-chat state cleanup). */
  forget(scopeKey: string): void {
    this.counts.delete(scopeKey);
    this.crashTimes.delete(scopeKey);
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
    const times = this.crashTimes.get(oldKey);
    if (times !== undefined) {
      this.crashTimes.delete(oldKey);
      this.crashTimes.set(newKey, times);
    }
  }

  /** Clear all crash counts (shutdown/reset). lastCrashAt is left intact. */
  clear(): void {
    this.counts.clear();
    this.crashTimes.clear();
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
