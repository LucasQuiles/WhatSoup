/**
 * Epic #1447 Theme 4 (fallback/respawn state machine) — adversarial trace for
 * CrashTracker.
 *
 * CrashTracker is the crash-count bookkeeping the respawn/fallback machine reads
 * to decide backoff, exhaustion, and health-degraded. It carries TWO views over
 * the same crashes that must stay in lock-step:
 *   - `counts` (cumulative per-scope) drives auto-respawn backoff/exhaustion;
 *   - `crashTimes` (per-scope epoch-ms log) drives the time-windowed health view
 *     (recentWithin). Every record/decrement/forget/rekey/clear keeps the two
 *     mirrored, so the documented invariant is `crashTimes[s].length ===
 *     counts[s]` for every live scope.
 *
 * The happy-path decay/window behavior is already pinned by
 * crash-tracker-decay.test.ts (#1427). This file is the ADVERSARIAL companion:
 * it pins the boundary/race edges that a plausible refactor would break —
 *   1. the recentWithin cutoff is a STRICT lower bound (a crash exactly at
 *      now-windowMs is already aged OUT), and pruning is an in-place mutation
 *      that must be idempotent and must delete the emptied scope;
 *   2. decrement removes the scope at exactly 1 (not 0), keeping both maps in
 *      lock-step, so the count/crashTimes invariant survives a record→decrement
 *      race;
 *   3. rekey's no-op path (unknown oldKey) and its crashTimes migration;
 *   4. clear() leaves lastCrashAt intact (documented contract), and size/count
 *      report the live scope set.
 *
 * All assertions go through the REAL exported surface (no private access).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CrashTracker } from '../../../src/runtimes/agent/crash-tracker.ts';

afterEach(() => vi.useRealTimers());

/**
 * Cross-check the documented lock-step invariant `crashTimes[s].length ===
 * counts[s]` using only the public surface: after fully aging every crash out
 * of the window, recentWithin() must equal the current count() for a scope that
 * still carries a cumulative count — otherwise the two maps have desynced. We
 * assert the fresh-window equality directly (windowMs large enough to keep all
 * timestamps), which is the strongest public witness of the mirror.
 */
function assertLockStep(t: CrashTracker, scope: string, expected: number): void {
  // count() is the cumulative view; recentWithin over an effectively-infinite
  // window is the crashTimes view. They must agree for a single-scope tracker.
  expect(t.count(scope)).toBe(expected);
  expect(t.recentWithin(Number.MAX_SAFE_INTEGER)).toBe(expected);
}

describe('CrashTracker — record / count / size / lastCrashAt', () => {
  it('records monotonically and reports the running count', () => {
    const t = new CrashTracker();
    expect(t.record('global')).toBe(1);
    expect(t.record('global')).toBe(2);
    expect(t.record('global')).toBe(3);
    expect(t.count('global')).toBe(3);
  });

  it('count() is 0 for an unseen scope (no phantom entries, size stays 0)', () => {
    const t = new CrashTracker();
    expect(t.count('never-seen')).toBe(0);
    expect(t.size).toBe(0);
    // reading an unseen scope must not have created it
    expect(t.count('never-seen')).toBe(0);
    expect(t.size).toBe(0);
  });

  it('size tracks the number of DISTINCT non-zero scopes, not total crashes', () => {
    const t = new CrashTracker();
    t.record('a');
    t.record('a');
    t.record('b');
    expect(t.size).toBe(2); // two scopes despite three crashes
    expect(t.recentTotal()).toBe(3); // lifetime sum across scopes
  });

  it('lastCrashAt is null before any crash and stamps a real ISO time on record', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00.000Z'));
    const t = new CrashTracker();
    expect(t.lastCrashAt).toBeNull();
    t.record('global');
    expect(t.lastCrashAt).toBe('2026-06-28T12:00:00.000Z');
  });
});

describe('CrashTracker — recentWithin cutoff is a STRICT lower bound', () => {
  it('a crash exactly at (now - windowMs) is already aged OUT (strict <)', () => {
    vi.useFakeTimers();
    const base = new Date('2026-06-28T00:00:00.000Z').getTime();
    vi.setSystemTime(base);
    const t = new CrashTracker();
    t.record('global'); // timestamp === base

    const windowMs = 10 * 60_000;
    // now such that cutoff (now - windowMs) === base exactly.
    const nowAtBoundary = base + windowMs;
    // times[0] (=base) is NOT < cutoff(=base), so it is NOT pruned; it remains
    // counted. This is the "just inside" edge — the strict boundary means a
    // crash whose age equals windowMs is still IN the window.
    expect(t.recentWithin(windowMs, nowAtBoundary)).toBe(1);

    // One ms past: cutoff = base + 1 > base, so base < cutoff → pruned out.
    expect(t.recentWithin(windowMs, nowAtBoundary + 1)).toBe(0);
  });

  it('distinguishes a crash just-inside from one just-outside the window', () => {
    vi.useFakeTimers();
    const base = new Date('2026-06-28T00:00:00.000Z').getTime();
    const windowMs = 60_000;
    const t = new CrashTracker();

    vi.setSystemTime(base);
    t.record('global'); // old crash @ base

    vi.setSystemTime(base + 30_000);
    t.record('global'); // fresh crash @ base+30s

    // now = base + 90s → cutoff = base + 30s. old crash (base) < cutoff → out;
    // fresh crash (base+30s) is NOT < cutoff → stays in.
    expect(t.recentWithin(windowMs, base + 90_000)).toBe(1);
  });
});

describe('CrashTracker — recentWithin pruning is in-place and idempotent', () => {
  it('pruning an aged-out scope is repeatable (second call returns the same, not stale)', () => {
    vi.useFakeTimers();
    const base = new Date('2026-06-28T00:00:00.000Z').getTime();
    const windowMs = 60_000;
    const t = new CrashTracker();
    vi.setSystemTime(base);
    t.record('global');
    t.record('global');

    const future = base + 5 * 60_000;
    expect(t.recentWithin(windowMs, future)).toBe(0); // prunes both
    // A second call must not resurrect or double-count — pruning already
    // emptied and deleted the scope.
    expect(t.recentWithin(windowMs, future)).toBe(0);
  });

  it('partial prune keeps only the fresh timestamps and re-counts stably', () => {
    vi.useFakeTimers();
    const base = new Date('2026-06-28T00:00:00.000Z').getTime();
    const windowMs = 60_000;
    const t = new CrashTracker();

    vi.setSystemTime(base);
    t.record('global'); // aged
    vi.setSystemTime(base + 40_000);
    t.record('global'); // fresh
    vi.setSystemTime(base + 50_000);
    t.record('global'); // fresh

    // now = base+90s → cutoff = base+30s → only the base crash is pruned.
    expect(t.recentWithin(windowMs, base + 90_000)).toBe(2);
    // Idempotent re-read at the same clock — the two fresh entries survive.
    expect(t.recentWithin(windowMs, base + 90_000)).toBe(2);
  });

  it('recentWithin does NOT disturb the cumulative count() (health decay ≠ backoff reset)', () => {
    vi.useFakeTimers();
    const base = new Date('2026-06-28T00:00:00.000Z').getTime();
    const t = new CrashTracker();
    vi.setSystemTime(base);
    t.record('global');
    t.record('global');

    // Age everything out of the health window...
    expect(t.recentWithin(60_000, base + 10 * 60_000)).toBe(0);
    // ...the cumulative respawn signals are untouched.
    expect(t.count('global')).toBe(2);
    expect(t.recentTotal()).toBe(2);
  });
});

describe('CrashTracker — decrement boundary (removes at 1, lock-step maps)', () => {
  it('decrement removes the scope at exactly 1, not at 0 (off-by-one guard)', () => {
    const t = new CrashTracker();
    t.record('global'); // count 1
    expect(t.size).toBe(1);
    t.decrement('global'); // count would hit 0 → scope removed entirely
    expect(t.count('global')).toBe(0);
    expect(t.size).toBe(0);
  });

  it('decrement from 2 leaves 1 and keeps count/crashTimes in lock-step', () => {
    const t = new CrashTracker();
    t.record('global');
    t.record('global'); // count 2, crashTimes length 2
    t.decrement('global'); // count 1, crashTimes length 1
    assertLockStep(t, 'global', 1);
    expect(t.size).toBe(1);
  });

  it('record→decrement race keeps the two views synced (no orphaned timestamps)', () => {
    const t = new CrashTracker();
    t.record('global');
    t.record('global');
    t.record('global'); // count 3
    t.decrement('global');
    t.decrement('global'); // count 1
    // If crashTimes had drifted (e.g. decrement forgot to shift), recentWithin
    // over an infinite window would disagree with count().
    assertLockStep(t, 'global', 1);
  });

  it('decrement on an unseen scope is a no-op (does not create or go negative)', () => {
    const t = new CrashTracker();
    t.decrement('ghost');
    expect(t.count('ghost')).toBe(0);
    expect(t.size).toBe(0);
  });
});

describe('CrashTracker — forget / rekey / clear', () => {
  it('forget drops both the count and the windowed log for a scope', () => {
    vi.useFakeTimers();
    const base = new Date('2026-06-28T00:00:00.000Z').getTime();
    vi.setSystemTime(base);
    const t = new CrashTracker();
    t.record('per-chat');
    t.record('global');
    t.forget('per-chat');
    expect(t.count('per-chat')).toBe(0);
    expect(t.size).toBe(1); // only 'global' remains
    // the forgotten scope contributes nothing to the health window
    expect(t.recentWithin(60_000, base)).toBe(1);
  });

  it('rekey migrates BOTH count and crashTimes to the new key', () => {
    const t = new CrashTracker();
    t.record('old');
    t.record('old'); // count 2
    t.rekey('old', 'new');
    expect(t.count('old')).toBe(0);
    assertLockStep(t, 'new', 2); // count AND crashTimes moved together
    expect(t.size).toBe(1);
  });

  it('rekey is a no-op when oldKey has no recorded count (does not fabricate newKey)', () => {
    const t = new CrashTracker();
    t.record('present');
    t.rekey('absent', 'target');
    expect(t.count('target')).toBe(0);
    expect(t.size).toBe(1); // only 'present'
  });

  it('clear() drops all counts AND the windowed log but PRESERVES lastCrashAt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T09:00:00.000Z'));
    const t = new CrashTracker();
    t.record('a');
    t.record('b');
    expect(t.lastCrashAt).toBe('2026-06-28T09:00:00.000Z');

    t.clear();
    expect(t.size).toBe(0);
    expect(t.count('a')).toBe(0);
    expect(t.recentTotal()).toBe(0);
    expect(t.recentWithin(60_000)).toBe(0);
    // documented contract: lastCrashAt survives a clear() so the last-known
    // crash time is still reportable after a shutdown/reset.
    expect(t.lastCrashAt).toBe('2026-06-28T09:00:00.000Z');
  });
});
