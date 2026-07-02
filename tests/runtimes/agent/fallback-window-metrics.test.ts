/**
 * QR-020 — dedicated unit tests for FallbackWindowMetrics.
 *
 * The class owns the accumulate-only provider-fallback counters and the
 * per-window delta arithmetic the revert alert depends on (windowDeltas =
 * lifetime totals minus the arm-time snapshot). The behaviour was previously
 * exercised only indirectly through the AgentRuntime integration harness
 * (fallback-cost-accumulation/transition-alerts/empty-turn/provider-fallback/
 * health-snapshot tests) — there was NO test isolating the class's own
 * increment/snapshot/delta logic. These pin that logic directly so a regression
 * in the delta math (which drives "THIS window's turns" in the alert) fails
 * here, not only deep in an integration assertion.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FallbackWindowMetrics } from '../../../src/runtimes/agent/fallback-window-metrics.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('FallbackWindowMetrics', () => {
  it('initializes every counter to zero and lastTurnAt to null', () => {
    const m = new FallbackWindowMetrics();
    expect(m.turnsServed).toBe(0);
    expect(m.turnsEmpty).toBe(0);
    expect(m.turnsServedAtArm).toBe(0);
    expect(m.turnsEmptyAtArm).toBe(0);
    expect(m.lastTurnAt).toBeNull();
    expect(m.activations).toBe(0);
    expect(m.reverts).toBe(0);
    expect(m.replays).toBe(0);
    expect(m.windowCostUsd).toBe(0);
  });

  it('recordServedTurn bumps turnsServed and stamps lastTurnAt with the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-30T12:00:00.000Z'));
    const m = new FallbackWindowMetrics();

    m.recordServedTurn();
    expect(m.turnsServed).toBe(1);
    expect(m.lastTurnAt).toBe(Date.parse('2026-06-30T12:00:00.000Z'));

    vi.setSystemTime(new Date('2026-06-30T12:05:00.000Z'));
    m.recordServedTurn();
    expect(m.turnsServed).toBe(2);
    expect(m.lastTurnAt).toBe(Date.parse('2026-06-30T12:05:00.000Z'));
  });

  it('recordEmptyTurn bumps only turnsEmpty (served is a separate counter)', () => {
    const m = new FallbackWindowMetrics();
    m.recordServedTurn();
    m.recordEmptyTurn();
    expect(m.turnsEmpty).toBe(1);
    expect(m.turnsServed).toBe(1);
  });

  it('addWindowCost accumulates provider-reported cost (never resets within the process)', () => {
    const m = new FallbackWindowMetrics();
    m.addWindowCost(0.0125);
    m.addWindowCost(0.5);
    expect(m.windowCostUsd).toBeCloseTo(0.5125, 10);
  });

  it('windowDeltas reports served/empty since the last arm snapshot, not lifetime totals', () => {
    const m = new FallbackWindowMetrics();
    // Accrue some lifetime history BEFORE arming this window.
    m.recordServedTurn();
    m.recordServedTurn();
    m.recordEmptyTurn();
    expect(m.windowDeltas()).toEqual({ served: 2, empty: 1 }); // no snapshot yet → baseline 0

    m.snapshotAtArm();
    expect(m.windowDeltas()).toEqual({ served: 0, empty: 0 }); // immediately after arm

    // Serve more turns within THIS window.
    m.recordServedTurn();
    m.recordServedTurn();
    m.recordServedTurn();
    m.recordEmptyTurn();
    expect(m.windowDeltas()).toEqual({ served: 3, empty: 1 });
    // Lifetime totals still accrue across the window boundary.
    expect(m.turnsServed).toBe(5);
    expect(m.turnsEmpty).toBe(2);
  });

  it('re-arming snapshots the new baseline so a second window starts at zero deltas', () => {
    const m = new FallbackWindowMetrics();
    m.snapshotAtArm();
    m.recordServedTurn();
    m.recordServedTurn();
    expect(m.windowDeltas()).toEqual({ served: 2, empty: 0 });

    // Second window arm: baseline moves to current lifetime totals.
    m.snapshotAtArm();
    expect(m.turnsServedAtArm).toBe(2);
    expect(m.windowDeltas()).toEqual({ served: 0, empty: 0 });

    m.recordServedTurn();
    expect(m.windowDeltas()).toEqual({ served: 1, empty: 0 }); // only this window's turn
  });

  it('activation/revert/replay counters are independent and accumulate-only', () => {
    const m = new FallbackWindowMetrics();
    m.recordActivation();
    m.recordActivation();
    m.recordRevert();
    m.recordReplay();
    m.recordReplay();
    m.recordReplay();
    expect(m.activations).toBe(2);
    expect(m.reverts).toBe(1);
    expect(m.replays).toBe(3);
    // bumping one never moves another
    m.recordActivation();
    expect(m.reverts).toBe(1);
    expect(m.replays).toBe(3);
  });
});
