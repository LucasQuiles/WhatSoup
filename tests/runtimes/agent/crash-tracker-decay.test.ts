import { describe, it, expect, vi, afterEach } from 'vitest';
import { CrashTracker } from '../../../src/runtimes/agent/crash-tracker.ts';

// #1427: a transient crash must not pin health=degraded forever. The health
// view of crashes is time-windowed (recentWithin) and decays, while the
// cumulative per-scope count() — which drives auto-respawn backoff/exhaustion —
// is unchanged.
describe('CrashTracker — time-windowed recentWithin (#1427 health decay)', () => {
  afterEach(() => vi.useRealTimers());

  it('counts crashes inside the window and decays them out after it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
    const t = new CrashTracker();
    t.record('global');
    t.record('global');

    // Both crashes are recent → counted.
    expect(t.recentWithin(10 * 60_000)).toBe(2);

    // 10 min + 1 s later → both have aged past the window → decayed to 0,
    // so a recovered instance stops reporting degraded.
    vi.setSystemTime(new Date('2026-06-28T00:10:01.000Z'));
    expect(t.recentWithin(10 * 60_000)).toBe(0);
  });

  it('keeps cumulative count() and recentTotal() intact (respawn backoff unaffected)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
    const t = new CrashTracker();
    t.record('global');
    t.record('global');
    vi.setSystemTime(new Date('2026-06-28T01:00:00.000Z'));

    // Health view has decayed, but the cumulative respawn-backoff signals have not.
    expect(t.recentWithin(10 * 60_000)).toBe(0);
    expect(t.count('global')).toBe(2);
    expect(t.recentTotal()).toBe(2);
  });

  it('a fresh crash after a quiet window re-degrades (window is sliding, not latched-off)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
    const t = new CrashTracker();
    t.record('global');
    vi.setSystemTime(new Date('2026-06-28T00:20:00.000Z'));
    expect(t.recentWithin(10 * 60_000)).toBe(0); // old crash decayed
    t.record('global'); // new crash now
    expect(t.recentWithin(10 * 60_000)).toBe(1);
  });

  it('clear() drops the windowed crash log too', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00.000Z'));
    const t = new CrashTracker();
    t.record('global');
    t.clear();
    expect(t.recentWithin(10 * 60_000)).toBe(0);
  });
});
