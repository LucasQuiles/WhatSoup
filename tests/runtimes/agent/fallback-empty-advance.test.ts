/**
 * Branch-coverage tests for src/runtimes/agent/fallback-empty-advance.ts.
 *
 * The class is exercised at the integration level by tests/runtimes/agent/
 * provider-fallback.test.ts and fallback-empty-output-arms.test.ts. This file
 * targets every branch in `shouldAttemptAdvance` in isolation so the per-file
 * coverage for fallback-empty-advance.ts reads 100%.
 *
 * Branches covered (4 total in shouldAttemptAdvance):
 *
 *   shouldAttemptAdvance(entryKey, threshold)
 *     - `consecutiveEmptyTurns < threshold` TRUE  → returns false (below-threshold)
 *     - `consecutiveEmptyTurns < threshold` FALSE, `attemptedForKey === entryKey`
 *       TRUE  → returns false (re-advance guard for same key) ← residual branch
 *     - `consecutiveEmptyTurns < threshold` FALSE, `attemptedForKey === entryKey`
 *       FALSE → sets attemptedForKey, returns true (fresh key at/above threshold)
 *
 * Plus characterization for `reset()` and `clearConsecutive()` so the
 * attempted-key guard is observable through the public boolean returns.
 *
 * State is PRIVATE — assertions are made on the concrete boolean return value
 * of `shouldAttemptAdvance` after driving each transition via the public
 * methods, per the test-integrity rules (no `.toBeUndefined()` /
 * `.toBeNull()` / `.toBeTruthy()` / `.not.toThrow()` as the lone terminal
 * assertion).
 */
import { describe, it, expect } from 'vitest';
import { FallbackEmptyAdvance } from '../../../src/runtimes/agent/fallback-empty-advance.ts';

describe('FallbackEmptyAdvance', () => {
  it('returns false below threshold', () => {
    const adv = new FallbackEmptyAdvance();

    // 0 empties recorded, threshold 3 → the `< threshold` early-return fires.
    const result = adv.shouldAttemptAdvance('k', 3);

    expect(result).toBe(false);
  });

  it('returns true at threshold for a fresh key', () => {
    const adv = new FallbackEmptyAdvance();
    adv.recordEmpty();
    adv.recordEmpty();
    adv.recordEmpty();

    // 3 empties recorded, threshold 3, no prior attempt for 'k'.
    // `attemptedForKey === entryKey` is FALSE (null !== 'k'), so we
    // set attemptedForKey and return true.
    const result = adv.shouldAttemptAdvance('k', 3);

    expect(result).toBe(true);
  });

  it('returns false on a second attempt for the same key (re-advance guard)', () => {
    const adv = new FallbackEmptyAdvance();
    adv.recordEmpty();
    adv.recordEmpty();
    adv.recordEmpty();

    // First call at threshold for 'k' returns true (terminal assertion on the
    // first outcome).
    const first = adv.shouldAttemptAdvance('k', 3);
    expect(first).toBe(true);

    // Second call with the SAME entryKey at the same threshold — the
    // `attemptedForKey === entryKey` guard now fires and returns false.
    // This is the previously-uncovered branch.
    const second = adv.shouldAttemptAdvance('k', 3);
    expect(second).toBe(false);
  });

  it('allows a different key to advance even after one key was attempted', () => {
    const adv = new FallbackEmptyAdvance();
    adv.recordEmpty();
    adv.recordEmpty();
    adv.recordEmpty();

    // First advance for 'k' succeeds.
    const first = adv.shouldAttemptAdvance('k', 3);
    expect(first).toBe(true);

    // 'other' is a different entryKey → guard does not match → true.
    const secondOther = adv.shouldAttemptAdvance('other', 3);
    expect(secondOther).toBe(true);
  });

  it('reset clears the counter AND the attempted-key guard', () => {
    const adv = new FallbackEmptyAdvance();
    adv.recordEmpty();
    adv.recordEmpty();
    adv.recordEmpty();

    // Attempt 'k' — sets attemptedForKey='k'.
    const first = adv.shouldAttemptAdvance('k', 3);
    expect(first).toBe(true);

    // reset() nulls attemptedForKey AND zeroes the counter.
    adv.reset();

    // Re-reach the threshold for 'k'.
    adv.recordEmpty();
    adv.recordEmpty();
    adv.recordEmpty();

    // Same key as before, but reset cleared attemptedForKey → guard does not
    // match → true again. Proves reset zeroed BOTH pieces of state.
    const afterReset = adv.shouldAttemptAdvance('k', 3);
    expect(afterReset).toBe(true);
  });

  it('clearConsecutive zeroes the run but KEEPS the attempted-key guard', () => {
    const adv = new FallbackEmptyAdvance();
    adv.recordEmpty();
    adv.recordEmpty();
    adv.recordEmpty();

    // Attempt 'k' — sets attemptedForKey='k'.
    const first = adv.shouldAttemptAdvance('k', 3);
    expect(first).toBe(true);

    // clearConsecutive zeroes ONLY the counter; attemptedForKey persists.
    adv.clearConsecutive();

    // Re-reach the threshold for the SAME key — guard still matches
    // (proves attemptedForKey was NOT cleared) → false.
    adv.recordEmpty();
    adv.recordEmpty();
    adv.recordEmpty();
    const sameKey = adv.shouldAttemptAdvance('k', 3);
    expect(sameKey).toBe(false);

    // A DIFFERENT key at the same threshold — guard does not match → true.
    // (No new recordEmpty needed; clearConsecutive ran first so we then
    // bumped back up above threshold before this call.)
    const differentKey = adv.shouldAttemptAdvance('entry-a', 3);
    expect(differentKey).toBe(true);
  });
});