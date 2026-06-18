/**
 * FallbackEmptyAdvance — accounting for advancing past a structurally-dead fallback
 * entry that connects but returns empty output on every turn.
 *
 * Fourth slice of the provider-fallback subsystem decomposition. Owns the two pieces
 * of state behind the empty-output advance trigger: the count of consecutive empty
 * turns served by the CURRENT active fallback entry, and the entry key the last
 * advance was attempted for (the guard that stops re-advancing — and re-alerting —
 * the same entry when no alternate exists).
 *
 * The advance ACTION stays in AgentRuntime (recordFallbackTurnOutcome): it owns the
 * threshold trigger's side effects — re-selecting the next eligible entry via
 * activateProviderFallbackAfterTerminalResult, the alert, and reading
 * activeFallbackEntry. This class only tracks the counter + attempted-key and answers
 * the predicate "should an advance be attempted now".
 *
 * Behavior is identical to the previous inline fields — see the empty-advance
 * characterization coverage (fallback-empty-output-arms.test.ts, provider-fallback.test.ts).
 */
export class FallbackEmptyAdvance {
  /** Consecutive empty (no-text, no-tool) turns served by the current active entry. */
  private consecutiveEmptyTurns = 0;
  /** Entry key the last advance was attempted for (null until first attempt). */
  private attemptedForKey: string | null = null;

  /**
   * Reset all empty-advance accounting. Called when a window arms/reverts and when a
   * fallback turn produces real output (the active entry proved healthy).
   */
  reset(): void {
    this.consecutiveEmptyTurns = 0;
    this.attemptedForKey = null;
  }

  /** An empty fallback turn was served by the current entry — bump the run counter. */
  recordEmpty(): void {
    this.consecutiveEmptyTurns += 1;
  }

  /**
   * True when the current entry has produced enough consecutive empty turns to
   * advance past it AND an advance has not already been attempted for this entry key.
   * Marks the key as attempted as a side effect (mirrors the prior inline guard:
   * set attemptedForKey before attempting the advance), so a failed advance does not
   * re-fire every subsequent empty turn.
   */
  shouldAttemptAdvance(entryKey: string, threshold: number): boolean {
    if (this.consecutiveEmptyTurns < threshold) return false;
    if (this.attemptedForKey === entryKey) return false;
    this.attemptedForKey = entryKey;
    return true;
  }

  /**
   * Clear only the consecutive-empty run (not the attempted key) after a successful
   * advance — the new entry starts from zero while the attempted-key guard still
   * tracks the prior (dead) key.
   */
  clearConsecutive(): void {
    this.consecutiveEmptyTurns = 0;
  }
}
