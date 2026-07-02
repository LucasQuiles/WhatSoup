/**
 * Epic #1447 Theme 4 (fallback/respawn state machine) — adversarial trace for
 * FallbackWindowState.
 *
 * The class is a pure field-relocation slice: it owns the six window-lifecycle
 * scalars the fallback machinery arms / extends / reverts together, plus the
 * ONE piece of read logic in the whole module — isActive(), the deadline-vs-now
 * check. All orchestration (arm / activate / deactivate / revert / probe /
 * restore) lives in AgentRuntime and pokes these fields directly, so the
 * class's own surface was previously exercised only indirectly through the
 * AgentRuntime integration harness (provider-fallback / transition-alerts /
 * health-snapshot). There was NO test isolating this class.
 *
 * isActive() is the CHECK side of the window-race the theme calls out: the
 * fallback machinery reads isActive() (check) before it decides to arm/extend
 * or clear (advance). Two invariants of that check matter and are adversarially
 * pinned here so a regression fails in this file, not deep in an integration
 * assertion:
 *
 *   1. Deadline is a STRICT upper bound: at the exact deadline (now ===
 *      activeUntil) the window is ALREADY expired (false). A off-by-one
 *      loosening of `<` to `<=` would leak an expired window past its deadline
 *      — the classic check-and-advance boundary bug.
 *   2. A null activeUntil short-circuits to false REGARDLESS of the clock —
 *      a null deadline must never be read as "0 < now → active". Dropping the
 *      null guard is a plausible bug (and would make every fresh/cleared window
 *      read active).
 *
 * We also pin the six field defaults and their documented preservation
 * contracts (activatedAt / armReason preserved across extension; activeEntry
 * carries the provider/model), and that isActive() reads live state each call
 * (mutating activeUntil across the deadline flips the answer without a new
 * instance).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FallbackWindowState } from '../../../src/runtimes/agent/fallback-window-state.ts';
import { type AgentFallbackEntry } from '../../../src/core/fallback-chain.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('FallbackWindowState', () => {
  it('constructs with every lifecycle scalar cleared (primary provider active)', () => {
    const s = new FallbackWindowState();
    expect(s.activeUntil).toBeNull();
    expect(s.activatedAt).toBeNull();
    expect(s.armReason).toBeNull();
    expect(s.resetAt).toBeNull();
    expect(s.recoveryProbeRequired).toBe(false);
    expect(s.activeEntry).toBeNull();
    // ...and with every scalar cleared the derived read is inactive.
    expect(s.isActive()).toBe(false);
  });

  it('isActive() is false on a fresh instance (null deadline short-circuits, clock irrelevant)', () => {
    vi.useFakeTimers();
    // Push "now" far into the future to prove the null guard, not the clock,
    // is what makes a fresh window inactive.
    vi.setSystemTime(new Date('2999-01-01T00:00:00.000Z'));
    const s = new FallbackWindowState();
    expect(s.activeUntil).toBeNull(); // the null deadline is what drives the result
    expect(s.isActive()).toBe(false); // ...not the (far-future) clock
  });

  it('isActive() null guard: a null activeUntil is inactive even when now is positive (never read as 0 < now)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-30T12:00:00.000Z')); // Date.now() > 0
    const s = new FallbackWindowState();
    s.activeUntil = null;
    expect(s.isActive()).toBe(false);
  });

  it('isActive() is true strictly BEFORE the deadline', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-06-30T12:00:00.000Z');
    vi.setSystemTime(now);
    const s = new FallbackWindowState();
    s.activeUntil = now + 1; // one ms of window left
    expect(s.isActive()).toBe(true);
  });

  it('isActive() boundary: at the EXACT deadline the window is already expired (strict <, not <=)', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-06-30T12:00:00.000Z');
    vi.setSystemTime(now);
    const s = new FallbackWindowState();
    s.activeUntil = now; // now === activeUntil
    // This is the check-and-advance boundary: at the tick the deadline is
    // reached the window must read expired so the machinery clears it and
    // does not extend a stale window. A `<=` regression would return true here.
    expect(s.isActive()).toBe(false);
  });

  it('isActive() is false strictly AFTER the deadline', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-06-30T12:00:00.000Z');
    vi.setSystemTime(now);
    const s = new FallbackWindowState();
    s.activeUntil = now - 1; // deadline already one ms in the past
    expect(s.isActive()).toBe(false);
  });

  it('isActive() reads LIVE state each call: advancing the clock across the deadline flips true→false on the same instance', () => {
    vi.useFakeTimers();
    const armAt = Date.parse('2026-06-30T12:00:00.000Z');
    vi.setSystemTime(armAt);
    const s = new FallbackWindowState();
    s.activeUntil = armAt + 60_000; // 60s window

    expect(s.isActive()).toBe(true); // inside the window
    vi.setSystemTime(armAt + 59_999);
    expect(s.isActive()).toBe(true); // 1ms before deadline
    vi.setSystemTime(armAt + 60_000);
    expect(s.isActive()).toBe(false); // AT the deadline → expired
    vi.setSystemTime(armAt + 120_000);
    expect(s.isActive()).toBe(false); // well past → still expired
  });

  it('isActive() reflects a re-armed deadline: clearing then re-setting activeUntil re-activates the same instance', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-06-30T12:00:00.000Z');
    vi.setSystemTime(now);
    const s = new FallbackWindowState();

    s.activeUntil = now + 1000;
    expect(s.isActive()).toBe(true);
    // Deactivate (machinery pokes the field to null).
    s.activeUntil = null;
    expect(s.isActive()).toBe(false);
    // Re-arm a fresh window on the same instance.
    s.activeUntil = now + 5000;
    expect(s.isActive()).toBe(true);
  });

  it('preserves activatedAt and armReason across an extension (extending activeUntil never overwrites origin fields)', () => {
    vi.useFakeTimers();
    const firstArm = Date.parse('2026-06-30T12:00:00.000Z');
    vi.setSystemTime(firstArm);
    const s = new FallbackWindowState();

    // First activation stamps origin scalars.
    s.activatedAt = firstArm;
    s.armReason = 'usage_limit';
    s.activeUntil = firstArm + 60_000;

    // Extension: the machinery pushes activeUntil forward but MUST NOT touch
    // activatedAt / armReason (documented preservation contract).
    const extendAt = firstArm + 30_000;
    vi.setSystemTime(extendAt);
    s.activeUntil = extendAt + 60_000;

    expect(s.activatedAt).toBe(firstArm); // original engagement time preserved
    expect(s.armReason).toBe('usage_limit'); // original root cause preserved
    expect(s.isActive()).toBe(true);
  });

  it('activeEntry carries the serving provider/model and is independent of the deadline scalars', () => {
    const s = new FallbackWindowState();
    const entry: AgentFallbackEntry = { provider: 'anthropic', model: 'some-model' };
    s.activeEntry = entry;
    expect(s.activeEntry).toEqual({ provider: 'anthropic', model: 'some-model' });
    // Setting the entry does not implicitly arm the window.
    expect(s.activeUntil).toBeNull();
    expect(s.isActive()).toBe(false);
  });

  it('resetAt and recoveryProbeRequired are independent flags not coupled to isActive()', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-06-30T12:00:00.000Z');
    vi.setSystemTime(now);
    const s = new FallbackWindowState();

    // A pending reset deadline / required probe must not, on its own, make the
    // window read active — only activeUntil vs now drives isActive().
    s.resetAt = now + 10_000;
    s.recoveryProbeRequired = true;
    expect(s.isActive()).toBe(false);

    // And an active window does not clear those flags.
    s.activeUntil = now + 10_000;
    expect(s.isActive()).toBe(true);
    expect(s.resetAt).toBe(now + 10_000);
    expect(s.recoveryProbeRequired).toBe(true);
  });

  it('instances are isolated: two windows carry independent deadlines and entries', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-06-30T12:00:00.000Z');
    vi.setSystemTime(now);
    const a = new FallbackWindowState();
    const b = new FallbackWindowState();

    a.activeUntil = now + 1000;
    a.activeEntry = { provider: 'openrouter' };
    expect(a.isActive()).toBe(true);
    // b is untouched by mutations to a.
    expect(b.activeUntil).toBeNull();
    expect(b.activeEntry).toBeNull();
    expect(b.isActive()).toBe(false);
  });
});
