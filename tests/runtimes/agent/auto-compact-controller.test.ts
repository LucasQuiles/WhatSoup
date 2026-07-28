/**
 * Branch-coverage tests for src/runtimes/agent/auto-compact-controller.ts.
 *
 * The class is exercised at the happy-path level by tests/runtimes/agent/
 * runtime.test.ts; this file targets the UNCOVERED residual guard branches
 * the integration suite misses:
 *
 *   - isSilentCompact / clearSilentCompact with scopeKey === undefined
 *     early-returns.
 *   - finishAutoCompact with no waiter (early return).
 *   - recordAutoCompactRapidRearm dedupe guard (early return), the
 *     `next > consecutiveRapidRearmsMax` false path, and the
 *     `Math.min(next, AUTO_COMPACT_BACKOFF_TIERS_MS.length - 1)` clamp
 *     when next > length-1.
 *   - recordAutoCompactNextTurnIfNeeded: constructor inputTokens undefined
 *     (disabled); scope not in measureNextTurn; inputTokens undefined OR
 *     <= threshold with consumeWhenNotOverThreshold both true and false;
 *     over-threshold path that increments nextTurnOverThreshold and
 *     either calls recordAutoCompactRapidRearm (recent lastSuccessAt)
 *     or skips it (no lastSuccessAt).
 *   - rekey: both the populated (each of 5 maps moves) and the empty
 *     (every `if` false) path.
 *   - cleanupScope and shutdown with both empty and populated maps,
 *     including the in-flight waiters and the silent-compact timers.
 *
 * All bookkeeping is exposed as `readonly` public Map/Set fields plus
 * mutable health counters — assertions are made directly against those
 * (concrete map.get/has/size, concrete counter values), per the
 * test-integrity rules.
 *
 * Tech: vi.useFakeTimers + vi.setSystemTime for deterministic Date.now()
 * and timer advancement; vi.advanceTimersByTime drives the silent-compact
 * TTL expiry callback. Waiters are inserted directly into the waiters
 * map with a captured resolve fn so finishAutoCompact/shutdown can
 * resolve them and the assertion can await the promise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AutoCompactController,
  SILENT_COMPACT_TTL_MS,
  AUTO_COMPACT_BACKOFF_TIERS_MS,
  AUTO_COMPACT_RAPID_REARM_WINDOW_MS,
} from '../../../src/runtimes/agent/auto-compact-controller.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Insert a fake in-flight waiter into the controller's waiters map so we
 * can drive finishAutoCompact / shutdown / cleanupScope's
 * resolve-and-clear path without a real auto-compact in flight.
 */
function installFakeWaiter(
  controller: AutoCompactController,
  scopeKey: string,
): { resolve: () => void; promise: Promise<void> } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  // Use a real (fake-clock) timer so clearTimeout is meaningful and
  // shutdown/finishAutoCompact can clear it.
  const timer = setTimeout(() => {
    // Should never fire in the test — finishAutoCompact/shutdown resolve
    // us first. If it does fire, the test is broken.
  }, 1_000);
  timer.unref?.();
  // The class only reads .timer and .resolve, so duck-typing is enough.
  controller.waiters.set(scopeKey, {
    promise,
    resolve: resolveFn,
    timer,
  });
  return { resolve: resolveFn, promise };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  // Pin the wall clock at a known epoch so Date.now() is deterministic.
  vi.setSystemTime(new Date(0));
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Construction / public surface ───────────────────────────────────────────

describe('AutoCompactController — construction', () => {
  it('initialises every public map/set/field to empty defaults', () => {
    const c = new AutoCompactController(1000);

    expect(c.silentCompactScopes.size).toBe(0);
    expect(c.compactBoundaryScopes.size).toBe(0);
    expect(c.cooldownUntil.size).toBe(0);
    expect(c.lastSuccessAt.size).toBe(0);
    expect(c.rapidRearmRecordedForSuccessAt.size).toBe(0);
    expect(c.consecutiveRapidRearms.size).toBe(0);
    expect(c.measureNextTurn.size).toBe(0);
    expect(c.waiters.size).toBe(0);
    expect(c.ineffective).toBe(0);
    expect(c.consecutiveRapidRearmsMax).toBe(0);
    expect(c.nextTurnOverThreshold).toBe(0);
  });
});

describe('AutoCompactController — healthSnapshot', () => {
  it('reports idle with no active scopes', () => {
    const c = new AutoCompactController(1000);

    expect(c.healthSnapshot()).toEqual({
      state: 'idle',
      activeBackoffScopes: 0,
      worstCurrentBackoffTier: 0,
    });
  });

  it('aggregates active scopes and caps the worst current tier without exposing identities', () => {
    const c = new AutoCompactController(1000);
    c.consecutiveRapidRearms.set('scope-a', 1);
    c.cooldownUntil.set('scope-a', 10_000);
    c.consecutiveRapidRearms.set('scope-b', AUTO_COMPACT_BACKOFF_TIERS_MS.length + 8);
    c.cooldownUntil.set('scope-b', 20_000);

    const snapshot = c.healthSnapshot(5_000);

    expect(snapshot).toEqual({
      state: 'backoff',
      activeBackoffScopes: 2,
      worstCurrentBackoffTier: AUTO_COMPACT_BACKOFF_TIERS_MS.length - 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain('scope-');
  });

  it('ignores zero-count, missing-cooldown, and expired scopes', () => {
    const c = new AutoCompactController(1000);
    c.consecutiveRapidRearms.set('zero-count', 0);
    c.cooldownUntil.set('zero-count', 10_000);
    c.consecutiveRapidRearms.set('missing-cooldown', 2);
    c.consecutiveRapidRearms.set('expired', 3);
    c.cooldownUntil.set('expired', 5_000);

    expect(c.healthSnapshot(5_000)).toEqual({
      state: 'idle',
      activeBackoffScopes: 0,
      worstCurrentBackoffTier: 0,
    });
  });

  it('clears current state on scope cleanup while preserving lifetime counters', () => {
    const c = new AutoCompactController(1000);
    c.recordAutoCompactRapidRearm('scope-a', 100, 1_000);
    expect(c.healthSnapshot(2_000).state).toBe('backoff');

    c.cleanupScope('scope-a');

    expect(c.healthSnapshot(2_000).state).toBe('idle');
    expect(c.ineffective).toBe(1);
    expect(c.consecutiveRapidRearmsMax).toBe(1);
  });

  it('clears current state on shutdown while preserving lifetime counters', () => {
    const c = new AutoCompactController(1000);
    c.recordAutoCompactRapidRearm('scope-a', 100, 1_000);
    expect(c.healthSnapshot(2_000).state).toBe('backoff');

    c.shutdown();

    expect(c.healthSnapshot(2_000).state).toBe('idle');
    expect(c.ineffective).toBe(1);
    expect(c.consecutiveRapidRearmsMax).toBe(1);
  });
});

// ─── silent-compact: begin / is / clear ──────────────────────────────────────

describe('AutoCompactController — silent compact', () => {
  it('beginSilentCompact adds the scope and isSilentCompact returns true', () => {
    const c = new AutoCompactController(1000);
    c.beginSilentCompact('scope-a');

    expect(c.silentCompactScopes.has('scope-a')).toBe(true);
    expect(c.isSilentCompact('scope-a')).toBe(true);
  });

  it('isSilentCompact returns false when scopeKey is undefined', () => {
    const c = new AutoCompactController(1000);
    c.beginSilentCompact('scope-a');

    expect(c.isSilentCompact(undefined)).toBe(false);
  });

  it('isSilentCompact returns false for an unknown scope', () => {
    const c = new AutoCompactController(1000);

    expect(c.isSilentCompact('unknown-scope')).toBe(false);
  });

  it('clearSilentCompact removes the entry and clears its TTL timer', () => {
    const c = new AutoCompactController(1000);
    c.beginSilentCompact('scope-a');
    const timer = c.silentCompactScopes.get('scope-a');
    expect(timer).toBeDefined();

    c.clearSilentCompact('scope-a');

    expect(c.silentCompactScopes.has('scope-a')).toBe(false);
    expect(c.isSilentCompact('scope-a')).toBe(false);
  });

  it('clearSilentCompact is a no-op when scopeKey is undefined', () => {
    const c = new AutoCompactController(1000);
    c.beginSilentCompact('scope-a');

    c.clearSilentCompact(undefined);

    // The pre-existing scope must still be present.
    expect(c.silentCompactScopes.has('scope-a')).toBe(true);
  });

  it('beginSilentCompact replaces a previous timer for the same scope', () => {
    const c = new AutoCompactController(1000);
    c.beginSilentCompact('scope-a');
    const firstTimer = c.silentCompactScopes.get('scope-a');
    c.beginSilentCompact('scope-a');
    const secondTimer = c.silentCompactScopes.get('scope-a');

    expect(secondTimer).toBeDefined();
    expect(secondTimer).not.toBe(firstTimer);
    expect(c.silentCompactScopes.size).toBe(1);
  });

  it('the TTL timer callback auto-removes the scope after SILENT_COMPACT_TTL_MS', () => {
    const c = new AutoCompactController(1000);
    c.beginSilentCompact('scope-a');
    expect(c.silentCompactScopes.has('scope-a')).toBe(true);

    vi.advanceTimersByTime(SILENT_COMPACT_TTL_MS);

    expect(c.silentCompactScopes.has('scope-a')).toBe(false);
  });
});

// ─── finishAutoCompact ───────────────────────────────────────────────────────

describe('AutoCompactController — finishAutoCompact', () => {
  it('returns immediately when no waiter exists for the scope', () => {
    const c = new AutoCompactController(1000);

    // Must not throw and must not create a phantom waiter.
    expect(() => c.finishAutoCompact('no-such-scope')).not.toThrow();
    expect(c.waiters.has('no-such-scope')).toBe(false);
    expect(c.waiters.size).toBe(0);
  });

  it('resolves and clears an in-flight waiter', async () => {
    const c = new AutoCompactController(1000);
    const { promise } = installFakeWaiter(c, 'scope-a');

    c.finishAutoCompact('scope-a');

    expect(c.waiters.has('scope-a')).toBe(false);
    // Awaiting must not hang: the resolve has already fired.
    await promise;
    expect(c.waiters.size).toBe(0);
  });
});

// ─── compact-boundary consumption ────────────────────────────────────────────

describe('AutoCompactController — consumeCompactBoundary', () => {
  it('returns true and clears the boundary when present', () => {
    const c = new AutoCompactController(1000);
    c.compactBoundaryScopes.add('scope-a');

    const result = c.consumeCompactBoundary('scope-a');

    expect(result).toBe(true);
    expect(c.compactBoundaryScopes.has('scope-a')).toBe(false);
  });

  it('returns false when no boundary is present', () => {
    const c = new AutoCompactController(1000);

    const result = c.consumeCompactBoundary('scope-a');

    expect(result).toBe(false);
    expect(c.compactBoundaryScopes.size).toBe(0);
  });
});

// ─── recordAutoCompactSuccess ────────────────────────────────────────────────

describe('AutoCompactController — recordAutoCompactSuccess', () => {
  it('sets lastSuccessAt, adds to measureNextTurn, and opens a cooldown', () => {
    const c = new AutoCompactController(1000);
    c.recordAutoCompactSuccess('scope-a');

    expect(c.lastSuccessAt.get('scope-a')).toBe(0);
    expect(c.rapidRearmRecordedForSuccessAt.has('scope-a')).toBe(false);
    expect(c.measureNextTurn.has('scope-a')).toBe(true);
    // Cooldown = Date.now() (0) + AUTO_COMPACT_SUCCESS_COOLDOWN_MS.
    expect(c.cooldownUntil.get('scope-a')).toBe(0 + 5 * 60 * 1000);
  });
});

// ─── recordAutoCompactRapidRearm ─────────────────────────────────────────────

describe('AutoCompactController — recordAutoCompactRapidRearm', () => {
  it('returns early when the dedupe guard matches the recorded lastSuccessAt', () => {
    const c = new AutoCompactController(1000);
    // Seed the dedupe guard with the same value the next call will pass.
    c.rapidRearmRecordedForSuccessAt.set('scope-a', 100);

    c.recordAutoCompactRapidRearm('scope-a', 100, 1_000);

    // No bookkeeping should advance because the early return fired.
    expect(c.consecutiveRapidRearms.has('scope-a')).toBe(false);
    expect(c.ineffective).toBe(0);
    expect(c.consecutiveRapidRearmsMax).toBe(0);
    expect(c.cooldownUntil.has('scope-a')).toBe(false);
  });

  it('counts the first rapid rearm (nullish-coalesce falsy branch), sets tier 0 cooldown, and advances max', () => {
    const c = new AutoCompactController(1000);

    c.recordAutoCompactRapidRearm('scope-a', 100, 5_000);

    expect(c.consecutiveRapidRearms.get('scope-a')).toBe(1);
    expect(c.ineffective).toBe(1);
    expect(c.consecutiveRapidRearmsMax).toBe(1);
    // Math.min(1, 3) = 1 → AUTO_COMPACT_BACKOFF_TIERS_MS[1] = 15 min.
    expect(c.cooldownUntil.get('scope-a')).toBe(5_000 + AUTO_COMPACT_BACKOFF_TIERS_MS[1]);
  });

  it('does NOT advance max when the next count does not exceed the high-water mark', () => {
    const c = new AutoCompactController(1000);
    // Drive scope-a to max=1 first.
    c.recordAutoCompactRapidRearm('scope-a', 100, 1_000);
    expect(c.consecutiveRapidRearmsMax).toBe(1);

    // Now drive scope-b: its next starts from 0+1=1, so 1 > 1 is FALSE
    // and the high-water mark must NOT advance.
    c.recordAutoCompactRapidRearm('scope-b', 200, 2_000);

    expect(c.consecutiveRapidRearms.get('scope-b')).toBe(1);
    expect(c.consecutiveRapidRearmsMax).toBe(1);
    expect(c.ineffective).toBe(2);
  });

  it('increments from an existing non-zero count (nullish-coalesce truthy branch)', () => {
    const c = new AutoCompactController(1000);
    c.consecutiveRapidRearms.set('scope-a', 2);
    c.rapidRearmRecordedForSuccessAt.set('scope-a', 50); // different dedupe value

    c.recordAutoCompactRapidRearm('scope-a', 100, 3_000);

    // next = 2 + 1 = 3; tier = Math.min(3, 3) = 3 (60 min).
    expect(c.consecutiveRapidRearms.get('scope-a')).toBe(3);
    expect(c.consecutiveRapidRearmsMax).toBe(3);
    expect(c.cooldownUntil.get('scope-a')).toBe(3_000 + AUTO_COMPACT_BACKOFF_TIERS_MS[3]);
  });

  it('clamps the backoff tier when next exceeds AUTO_COMPACT_BACKOFF_TIERS_MS.length - 1', () => {
    const c = new AutoCompactController(1000);
    // Pre-set consecutiveRapidRearms to length so the first non-deduped
    // call drives next = length, exercising Math.min(length, length-1).
    c.consecutiveRapidRearms.set('scope-a', AUTO_COMPACT_BACKOFF_TIERS_MS.length);

    c.recordAutoCompactRapidRearm('scope-a', 100, 4_000);

    const next = AUTO_COMPACT_BACKOFF_TIERS_MS.length + 1;
    expect(c.consecutiveRapidRearms.get('scope-a')).toBe(next);
    // Clamped: Math.min(next, length-1) = length-1.
    expect(c.cooldownUntil.get('scope-a')).toBe(
      4_000 + AUTO_COMPACT_BACKOFF_TIERS_MS[AUTO_COMPACT_BACKOFF_TIERS_MS.length - 1],
    );
  });
});

// ─── recordAutoCompactNextTurnIfNeeded ───────────────────────────────────────

describe('AutoCompactController — recordAutoCompactNextTurnIfNeeded', () => {
  it('returns early when the controller was constructed with inputTokens=undefined', () => {
    const c = new AutoCompactController(undefined);
    c.measureNextTurn.add('scope-a');

    c.recordAutoCompactNextTurnIfNeeded('scope-a', 999_999);

    expect(c.nextTurnOverThreshold).toBe(0);
    expect(c.measureNextTurn.has('scope-a')).toBe(true);
  });

  it('returns early when the scope is not flagged in measureNextTurn', () => {
    const c = new AutoCompactController(1000);

    c.recordAutoCompactNextTurnIfNeeded('scope-a', 999_999);

    expect(c.nextTurnOverThreshold).toBe(0);
    expect(c.measureNextTurn.has('scope-a')).toBe(false);
  });

  it('consumes measureNextTurn when inputTokens is undefined and consumeWhenNotOverThreshold=true', () => {
    const c = new AutoCompactController(1000);
    c.measureNextTurn.add('scope-a');

    c.recordAutoCompactNextTurnIfNeeded('scope-a', undefined, true);

    expect(c.measureNextTurn.has('scope-a')).toBe(false);
    expect(c.nextTurnOverThreshold).toBe(0);
  });

  it('preserves measureNextTurn when inputTokens is undefined and consumeWhenNotOverThreshold=false', () => {
    const c = new AutoCompactController(1000);
    c.measureNextTurn.add('scope-a');

    c.recordAutoCompactNextTurnIfNeeded('scope-a', undefined, false);

    expect(c.measureNextTurn.has('scope-a')).toBe(true);
    expect(c.nextTurnOverThreshold).toBe(0);
  });

  it('consumes measureNextTurn when inputTokens <= threshold and consumeWhenNotOverThreshold=true', () => {
    const c = new AutoCompactController(1000);
    c.measureNextTurn.add('scope-a');

    c.recordAutoCompactNextTurnIfNeeded('scope-a', 1_000, true);

    expect(c.measureNextTurn.has('scope-a')).toBe(false);
    expect(c.nextTurnOverThreshold).toBe(0);
  });

  it('preserves measureNextTurn when inputTokens <= threshold and consumeWhenNotOverThreshold=false', () => {
    const c = new AutoCompactController(1000);
    c.measureNextTurn.add('scope-a');

    c.recordAutoCompactNextTurnIfNeeded('scope-a', 1_000, false);

    expect(c.measureNextTurn.has('scope-a')).toBe(true);
    expect(c.nextTurnOverThreshold).toBe(0);
  });

  it('over-threshold with no lastSuccessAt recorded: increments nextTurnOverThreshold and does NOT trigger rapid rearm', () => {
    const c = new AutoCompactController(1_000);
    c.measureNextTurn.add('scope-a');
    // Intentionally do NOT call recordAutoCompactSuccess — lastSuccessAt stays undefined.

    c.recordAutoCompactNextTurnIfNeeded('scope-a', 9_999);

    expect(c.nextTurnOverThreshold).toBe(1);
    expect(c.measureNextTurn.has('scope-a')).toBe(false);
    // The "no lastSuccessAt" branch must NOT have called recordAutoCompactRapidRearm.
    expect(c.ineffective).toBe(0);
    expect(c.consecutiveRapidRearmsMax).toBe(0);
  });

  it('over-threshold with a recent lastSuccessAt: triggers a rapid rearm', () => {
    const c = new AutoCompactController(1_000);
    c.recordAutoCompactSuccess('scope-a');
    // lastSuccessAt is now 0 (the pinned system time). Date.now() is also 0,
    // so now - lastSuccessAt = 0 < AUTO_COMPACT_RAPID_REARM_WINDOW_MS.

    c.recordAutoCompactNextTurnIfNeeded('scope-a', 9_999);

    expect(c.nextTurnOverThreshold).toBe(1);
    expect(c.measureNextTurn.has('scope-a')).toBe(false);
    // The nested call landed: scope-a is counted, max advanced, ineffective bumped.
    expect(c.consecutiveRapidRearms.get('scope-a')).toBe(1);
    expect(c.ineffective).toBe(1);
    expect(c.consecutiveRapidRearmsMax).toBe(1);
    // Dedupe guard now recorded for the same lastSuccessAt.
    expect(c.rapidRearmRecordedForSuccessAt.get('scope-a')).toBe(0);
  });

  it('over-threshold with a stale lastSuccessAt: increments but does NOT trigger rapid rearm', () => {
    const c = new AutoCompactController(1_000);
    c.recordAutoCompactSuccess('scope-a');
    // Advance the fake clock past the rapid-rearm window so the time
    // difference exceeds AUTO_COMPACT_RAPID_REARM_WINDOW_MS.
    vi.setSystemTime(new Date(AUTO_COMPACT_RAPID_REARM_WINDOW_MS + 60_000));

    c.recordAutoCompactNextTurnIfNeeded('scope-a', 9_999);

    expect(c.nextTurnOverThreshold).toBe(1);
    expect(c.measureNextTurn.has('scope-a')).toBe(false);
    // The stale-success short-circuit fired: rapid rearm is NOT recorded.
    expect(c.ineffective).toBe(0);
    expect(c.consecutiveRapidRearms.has('scope-a')).toBe(false);
    expect(c.rapidRearmRecordedForSuccessAt.has('scope-a')).toBe(false);
  });
});

// ─── cleanupScope ────────────────────────────────────────────────────────────

describe('AutoCompactController — cleanupScope', () => {
  it('is a no-op on a fresh controller', () => {
    const c = new AutoCompactController(1000);

    c.cleanupScope('scope-a');

    expect(c.silentCompactScopes.size).toBe(0);
    expect(c.compactBoundaryScopes.size).toBe(0);
    expect(c.cooldownUntil.size).toBe(0);
    expect(c.lastSuccessAt.size).toBe(0);
    expect(c.rapidRearmRecordedForSuccessAt.size).toBe(0);
    expect(c.consecutiveRapidRearms.size).toBe(0);
    expect(c.measureNextTurn.size).toBe(0);
    expect(c.waiters.size).toBe(0);
  });

  it('clears every per-scope entry, resolves the waiter, and clears the silent-compact timer', async () => {
    const c = new AutoCompactController(1000);
    c.compactBoundaryScopes.add('scope-a');
    c.cooldownUntil.set('scope-a', 1);
    c.lastSuccessAt.set('scope-a', 2);
    c.rapidRearmRecordedForSuccessAt.set('scope-a', 3);
    c.consecutiveRapidRearms.set('scope-a', 4);
    c.measureNextTurn.add('scope-a');
    c.beginSilentCompact('scope-a');
    const { promise } = installFakeWaiter(c, 'scope-a');

    c.cleanupScope('scope-a');

    expect(c.compactBoundaryScopes.has('scope-a')).toBe(false);
    expect(c.cooldownUntil.has('scope-a')).toBe(false);
    expect(c.lastSuccessAt.has('scope-a')).toBe(false);
    expect(c.rapidRearmRecordedForSuccessAt.has('scope-a')).toBe(false);
    expect(c.consecutiveRapidRearms.has('scope-a')).toBe(false);
    expect(c.measureNextTurn.has('scope-a')).toBe(false);
    expect(c.silentCompactScopes.has('scope-a')).toBe(false);
    expect(c.waiters.has('scope-a')).toBe(false);
    // The in-flight waiter was resolved.
    await promise;
  });
});

// ─── rekey ───────────────────────────────────────────────────────────────────

describe('AutoCompactController — rekey', () => {
  it('is a no-op when the controller has no entries for oldKey', () => {
    const c = new AutoCompactController(1000);

    c.rekey('old', 'new');

    expect(c.cooldownUntil.size).toBe(0);
    expect(c.lastSuccessAt.size).toBe(0);
    expect(c.rapidRearmRecordedForSuccessAt.size).toBe(0);
    expect(c.consecutiveRapidRearms.size).toBe(0);
    expect(c.measureNextTurn.size).toBe(0);
  });

  it('moves every per-scope entry from oldKey to newKey', () => {
    const c = new AutoCompactController(1000);
    c.cooldownUntil.set('old', 1_000);
    c.lastSuccessAt.set('old', 2_000);
    c.rapidRearmRecordedForSuccessAt.set('old', 3_000);
    c.consecutiveRapidRearms.set('old', 4);
    c.measureNextTurn.add('old');

    c.rekey('old', 'new');

    expect(c.cooldownUntil.has('old')).toBe(false);
    expect(c.lastSuccessAt.has('old')).toBe(false);
    expect(c.rapidRearmRecordedForSuccessAt.has('old')).toBe(false);
    expect(c.consecutiveRapidRearms.has('old')).toBe(false);
    expect(c.measureNextTurn.has('old')).toBe(false);

    expect(c.cooldownUntil.get('new')).toBe(1_000);
    expect(c.lastSuccessAt.get('new')).toBe(2_000);
    expect(c.rapidRearmRecordedForSuccessAt.get('new')).toBe(3_000);
    expect(c.consecutiveRapidRearms.get('new')).toBe(4);
    expect(c.measureNextTurn.has('new')).toBe(true);
  });
});

// ─── shutdown ────────────────────────────────────────────────────────────────

describe('AutoCompactController — shutdown', () => {
  it('is a no-op on a fresh controller', () => {
    const c = new AutoCompactController(1000);

    c.shutdown();

    expect(c.silentCompactScopes.size).toBe(0);
    expect(c.waiters.size).toBe(0);
    expect(c.compactBoundaryScopes.size).toBe(0);
    expect(c.cooldownUntil.size).toBe(0);
    expect(c.lastSuccessAt.size).toBe(0);
    expect(c.rapidRearmRecordedForSuccessAt.size).toBe(0);
    expect(c.consecutiveRapidRearms.size).toBe(0);
    expect(c.measureNextTurn.size).toBe(0);
  });

  it('clears every silent-compact timer, resolves every waiter, and empties every per-scope map', async () => {
    const c = new AutoCompactController(1000);
    c.beginSilentCompact('scope-a');
    c.beginSilentCompact('scope-b');
    c.compactBoundaryScopes.add('scope-a');
    c.cooldownUntil.set('scope-a', 100);
    c.lastSuccessAt.set('scope-a', 200);
    c.rapidRearmRecordedForSuccessAt.set('scope-a', 200);
    c.consecutiveRapidRearms.set('scope-a', 1);
    c.measureNextTurn.add('scope-a');
    const waiterA = installFakeWaiter(c, 'scope-a');
    const waiterB = installFakeWaiter(c, 'scope-b');

    c.shutdown();

    expect(c.silentCompactScopes.size).toBe(0);
    expect(c.waiters.size).toBe(0);
    expect(c.compactBoundaryScopes.size).toBe(0);
    expect(c.cooldownUntil.size).toBe(0);
    expect(c.lastSuccessAt.size).toBe(0);
    expect(c.rapidRearmRecordedForSuccessAt.size).toBe(0);
    expect(c.consecutiveRapidRearms.size).toBe(0);
    expect(c.measureNextTurn.size).toBe(0);

    // Both waiters resolved.
    await waiterA.promise;
    await waiterB.promise;
  });

  it('preserves cumulative health counters across shutdown', () => {
    const c = new AutoCompactController(1000);
    c.ineffective = 7;
    c.consecutiveRapidRearmsMax = 3;
    c.nextTurnOverThreshold = 5;

    c.shutdown();

    expect(c.ineffective).toBe(7);
    expect(c.consecutiveRapidRearmsMax).toBe(3);
    expect(c.nextTurnOverThreshold).toBe(5);
  });
});
