import { describe, expect, it, vi } from 'vitest';

const { emitAlertMock, clearAlertMock } = vi.hoisted(() => ({
  emitAlertMock: vi.fn(),
  clearAlertMock: vi.fn(),
}));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: emitAlertMock,
  clearAlertSourceChecked: clearAlertMock,
}));

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

import {
  createProviderExecutionGate,
  ProviderExecutionGate,
} from '../../../src/runtimes/agent/provider-execution-gate.ts';
import {
  loadRecoveryMarkers,
  setRecoveryMarker,
} from '../../../src/lib/recovery-authority-store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ProviderExecutionGate', () => {
  it('admits one owner and preserves FIFO order across waiters', async () => {
    let now = 1_000;
    const gate = new ProviderExecutionGate({ now: () => now });

    const first = await gate.acquire();
    const order: string[] = [];
    const secondPromise = gate.acquire().then((lease) => {
      order.push('second');
      return lease;
    });
    const thirdPromise = gate.acquire().then((lease) => {
      order.push('third');
      return lease;
    });

    expect(gate.snapshot()).toMatchObject({ active: true, pending: 2, totalWaits: 2 });
    now = 1_250;
    first.release();
    const second = await secondPromise;
    expect(order).toEqual(['second']);
    expect(second.waitMs).toBe(250);

    second.release();
    const third = await thirdPromise;
    expect(order).toEqual(['second', 'third']);
    third.release();
    expect(gate.snapshot()).toMatchObject({ active: false, pending: 0 });
  });

  it('retains bounded work identity across FIFO handoff without exposing raw scope', async () => {
    const gate = new ProviderExecutionGate();

    const first = await gate.acquire({
      work: { kind: 'turn', scopeHash: 'aaaaaaaaaaaa' },
    });
    const secondPromise = gate.acquire({
      work: { kind: 'turn', scopeHash: 'bbbbbbbbbbbb' },
    });

    expect(gate.snapshot()).toMatchObject({
      activeWorkKind: 'turn',
      activeScopeHash: 'aaaaaaaaaaaa',
      oldestPendingWorkKind: 'turn',
      oldestPendingScopeHash: 'bbbbbbbbbbbb',
    });

    first.release();
    const second = await secondPromise;
    expect(gate.snapshot()).toMatchObject({
      activeWorkKind: 'turn',
      activeScopeHash: 'bbbbbbbbbbbb',
      oldestPendingWorkKind: null,
      oldestPendingScopeHash: null,
    });
    second.release();
    expect(gate.snapshot()).toMatchObject({
      activeWorkKind: null,
      activeScopeHash: null,
    });
  });

  it('fails closed when work identity is not a bounded hash', async () => {
    const gate = new ProviderExecutionGate();
    const lease = await gate.acquire({
      work: { kind: 'turn', scopeHash: 'raw-chat-scope@example.invalid' },
    });

    expect(gate.snapshot()).toMatchObject({
      activeWorkKind: null,
      activeScopeHash: null,
    });
    lease.release();
  });

  it('removes an aborted waiter without disturbing the active owner', async () => {
    const gate = new ProviderExecutionGate();
    const first = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire({ signal: controller.signal });

    controller.abort();
    await expect(waiting).rejects.toThrow('PROVIDER_EXECUTION_WAIT_ABORTED');
    expect(gate.snapshot()).toMatchObject({ active: true, pending: 0, abortedWaits: 1 });

    first.release();
    expect(gate.snapshot().active).toBe(false);
  });

  it('emits one pressure transition and clears it only after the queue drains', async () => {
    vi.useFakeTimers();
    try {
      const onPressure = vi.fn();
      const onRecovered = vi.fn();
      const gate = new ProviderExecutionGate({
        pressureAfterMs: 30_000,
        onPressure,
        onRecovered,
      });
      const first = await gate.acquire();
      const secondPromise = gate.acquire();
      const thirdPromise = gate.acquire();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onPressure).toHaveBeenCalledTimes(1);
      expect(onPressure).toHaveBeenCalledWith(expect.objectContaining({
        active: true,
        pending: 2,
        oldestWaitMs: 30_000,
      }));

      first.release();
      const second = await secondPromise;
      second.release();
      const third = await thirdPromise;
      expect(onRecovered).not.toHaveBeenCalled();
      third.release();
      expect(onRecovered).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes bounded queue pressure and recovery alerts for the runtime gate', async () => {
    vi.useFakeTimers();
    try {
      emitAlertMock.mockClear();
      clearAlertMock.mockClear();
      const gate = createProviderExecutionGate('pressure-test');
      const first = await gate.acquire({
        work: { kind: 'turn', scopeHash: 'aaaaaaaaaaaa' },
      });
      const secondPromise = gate.acquire({
        work: { kind: 'probe', scopeHash: 'bbbbbbbbbbbb' },
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(emitAlertMock).toHaveBeenCalledWith(
        'pressure-test',
        'provider_execution_queue_pressure',
        'OpenCode execution queue has waited at least 30 seconds',
        expect.stringContaining('limitation=external_opencode_processes_are_not_serialized'),
        'warning',
      );
      const evidence = emitAlertMock.mock.calls[0]?.[3] as string;
      expect(evidence).toContain('active_work_kind=turn');
      expect(evidence).toContain('active_scope_hash=aaaaaaaaaaaa');
      expect(evidence).toContain('oldest_pending_work_kind=probe');
      expect(evidence).toContain('oldest_pending_scope_hash=bbbbbbbbbbbb');
      first.release();
      const second = await secondPromise;
      second.release();
      expect(clearAlertMock).toHaveBeenCalledWith('pressure-test', 'provider_execution_queue_pressure');
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes lease release idempotent', async () => {
    const gate = new ProviderExecutionGate();
    const first = await gate.acquire();
    const secondPromise = gate.acquire();

    first.release();
    first.release();
    const second = await secondPromise;
    expect(gate.snapshot()).toMatchObject({ active: true, pending: 0 });
    second.release();
  });

  it('drains a 50-turn mixed abort stress queue in FIFO order with one active lease', async () => {
    const gate = new ProviderExecutionGate();
    const first = await gate.acquire();
    const admitted: number[] = [];
    let activeLeases = 0;
    let maxActiveLeases = 0;
    const controllers = Array.from({ length: 50 }, () => new AbortController());
    const aborted = new Set([3, 11, 19, 27, 35, 43]);
    const turns = controllers.map((controller, index) => gate.acquire({ signal: controller.signal })
      .then(async (lease) => {
        activeLeases += 1;
        maxActiveLeases = Math.max(maxActiveLeases, activeLeases);
        admitted.push(index);
        await Promise.resolve();
        activeLeases -= 1;
        lease.release();
        return 'admitted' as const;
      })
      .catch((error: Error) => {
        expect(error.message).toContain('PROVIDER_EXECUTION_WAIT_ABORTED');
        return 'aborted' as const;
      }));

    for (const index of aborted) controllers[index]!.abort();
    expect(gate.snapshot()).toMatchObject({
      active: true,
      pending: 50 - aborted.size,
      maxPending: 50,
      abortedWaits: aborted.size,
    });

    first.release();
    const results = await Promise.all(turns);
    expect(maxActiveLeases).toBe(1);
    expect(admitted).toEqual(
      Array.from({ length: 50 }, (_, index) => index).filter((index) => !aborted.has(index)),
    );
    expect(results.filter((result) => result === 'aborted')).toHaveLength(aborted.size);
    expect(gate.snapshot()).toMatchObject({
      active: false,
      pending: 0,
      totalWaits: 50,
      abortedWaits: aborted.size,
    });
  });

  // #2340: content-free active-holder age, phase, and progress freshness.
  it('exposes holder age, phase, and progress freshness from admit through idle reset', async () => {
    let now = 1_000;
    const gate = new ProviderExecutionGate({ now: () => now });

    const lease = await gate.acquire();
    expect(gate.snapshot()).toMatchObject({
      active: true,
      activeAgeMs: 0,
      activePhase: 'queued_to_spawn',
      progressAgeMs: 0,
    });

    now = 1_500;
    lease.setPhase('executing');
    expect(gate.snapshot()).toMatchObject({
      activeAgeMs: 500,
      activePhase: 'executing',
      progressAgeMs: 500,
    });

    now = 2_000;
    lease.markProgress();
    expect(gate.snapshot()).toMatchObject({
      activeAgeMs: 1_000,
      activePhase: 'executing',
      progressAgeMs: 0,
    });

    lease.release();
    expect(gate.snapshot()).toMatchObject({
      active: false,
      activeAgeMs: 0,
      activePhase: 'executing',
      progressAgeMs: 0,
    });
  });

  it('resets holder freshness for the FIFO successor and ignores stale lease calls', async () => {
    let now = 5_000;
    const gate = new ProviderExecutionGate({ now: () => now });

    const first = await gate.acquire();
    now = 6_000;
    first.setPhase('terminalizing');
    const secondPromise = gate.acquire();

    now = 9_000;
    first.release();
    const second = await secondPromise;
    expect(gate.snapshot()).toMatchObject({
      active: true,
      activeAgeMs: 0,
      activePhase: 'queued_to_spawn',
      progressAgeMs: 0,
    });

    // The released lease's generation is superseded: its calls must be no-ops
    // and must not touch the successor's phase or freshness.
    first.markProgress();
    first.setPhase('cleanup');
    expect(gate.snapshot()).toMatchObject({
      activeAgeMs: 0,
      activePhase: 'queued_to_spawn',
      progressAgeMs: 0,
    });

    now = 9_100;
    second.markProgress();
    second.setPhase('executing');
    expect(gate.snapshot()).toMatchObject({
      activeAgeMs: 100,
      activePhase: 'executing',
      progressAgeMs: 0,
    });
    second.release();
    expect(gate.snapshot()).toMatchObject({ active: false, activePhase: 'executing' });
  });

  it('distinguishes stalled-vs-advancing holders with identical queue counters (#2340 falsifier)', async () => {
    let nowAdvancing = 1_000;
    let nowStalled = 1_000;
    const advancingGate = new ProviderExecutionGate({ now: () => nowAdvancing });
    const stalledGate = new ProviderExecutionGate({ now: () => nowStalled });

    const advancingLease = await advancingGate.acquire();
    const stalledLease = await stalledGate.acquire();
    advancingGate.acquire();
    stalledGate.acquire();
    expect(advancingGate.snapshot()).toMatchObject({ pending: 1, totalWaits: 1 });
    expect(stalledGate.snapshot()).toMatchObject({ pending: 1, totalWaits: 1 });

    advancingLease.setPhase('executing');
    stalledLease.setPhase('terminalizing');
    nowAdvancing = 2_000;
    advancingLease.markProgress();
    nowAdvancing = 60_000;
    nowStalled = 60_000;

    const advancing = advancingGate.snapshot();
    const stalled = stalledGate.snapshot();
    // Identical legacy counters — the states the issue calls indistinguishable.
    expect(advancing.pending).toBe(stalled.pending);
    expect(advancing.oldestWaitMs).toBe(stalled.oldestWaitMs);
    expect(advancing.totalWaits).toBe(stalled.totalWaits);
    expect(advancing.pressureActive).toBe(stalled.pressureActive);
    // But the holder freshness now separates them.
    expect(advancing.activePhase).toBe('executing');
    expect(stalled.activePhase).toBe('terminalizing');
    expect(advancing.activeAgeMs).toBe(59_000);
    expect(stalled.activeAgeMs).toBe(59_000);
    expect(advancing.progressAgeMs).toBe(58_000);
    expect(stalled.progressAgeMs).toBe(59_000);

    advancingLease.release();
    stalledLease.release();
  });

  // #2340 spec item 1: the full 4-value phase lifecycle, each step with
  // fresh progress, on a real gate under an injected clock.
  it('walks the full holder phase lifecycle with fresh progress at each step', async () => {
    let now = 10_000;
    const gate = new ProviderExecutionGate({ now: () => now });
    const lease = await gate.acquire();

    // queued_to_spawn: admitted but the holder has not reported starting.
    expect(gate.snapshot()).toMatchObject({ activePhase: 'queued_to_spawn', progressAgeMs: 0 });

    now = 11_000;
    lease.setPhase('executing');
    lease.markProgress();
    expect(gate.snapshot()).toMatchObject({
      activePhase: 'executing',
      activeAgeMs: 1_000,
      progressAgeMs: 0,
    });

    now = 12_000;
    lease.setPhase('terminalizing');
    expect(gate.snapshot()).toMatchObject({ activePhase: 'terminalizing', progressAgeMs: 1_000 });

    now = 13_000;
    lease.setPhase('cleanup');
    lease.markProgress();
    expect(gate.snapshot()).toMatchObject({ activePhase: 'cleanup', progressAgeMs: 0, activeAgeMs: 3_000 });

    lease.release();
    expect(gate.snapshot()).toMatchObject({ active: false, activePhase: 'executing', activeAgeMs: 0 });
  });

  it('enriches pressure evidence with content-free holder freshness labels', async () => {
    vi.useFakeTimers();
    try {
      emitAlertMock.mockClear();
      clearAlertMock.mockClear();
      const gate = createProviderExecutionGate('pressure-freshness');
      const first = await gate.acquire({
        work: { kind: 'turn', scopeHash: 'aaaaaaaaaaaa' },
      });
      gate.acquire({ work: { kind: 'probe', scopeHash: 'bbbbbbbbbbbb' } });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(emitAlertMock).toHaveBeenCalledTimes(1);
      const evidence = emitAlertMock.mock.calls[0]?.[3] as string;
      expect(evidence).toContain('active_age_ms=30000');
      expect(evidence).toContain('active_phase=queued_to_spawn');
      expect(evidence).toContain('progress_age_ms=30000');

      first.release();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// #2394 (source 4): recovery-authority marker wiring for the pressure alert.
// Mirrors the model-advisor (#3091) template — marker set on durable emit,
// removed on durable clear, and reconciled at gate construction (a fresh gate
// is verifiably idle, which the issue contract treats as recovery authority).
// Uses the REAL marker store under a per-test BOT_ERRORS_STATE_DIR temp dir.
describe('provider_execution_queue_pressure recovery authority (#2394 source 4)', () => {
  const MARKER_KEY = 'provider_execution_queue_pressure:marker-test';

  async function withMarkerDir(fn: () => Promise<void> | void): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gate-recovery-'));
    const prior = process.env['BOT_ERRORS_STATE_DIR'];
    process.env['BOT_ERRORS_STATE_DIR'] = dir;
    emitAlertMock.mockReset();
    clearAlertMock.mockReset();
    emitAlertMock.mockReturnValue(true);
    clearAlertMock.mockReturnValue(true);
    try {
      await fn();
    } finally {
      if (prior === undefined) delete process.env['BOT_ERRORS_STATE_DIR'];
      else process.env['BOT_ERRORS_STATE_DIR'] = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('sets the marker on durable pressure emit and removes it on durable drain clear', async () => {
    await withMarkerDir(async () => {
      vi.useFakeTimers();
      try {
        const gate = createProviderExecutionGate('marker-test');
        const first = await gate.acquire();
        const secondPromise = gate.acquire();

        await vi.advanceTimersByTimeAsync(30_000);
        expect(emitAlertMock).toHaveBeenCalledTimes(1);
        expect(loadRecoveryMarkers().has(MARKER_KEY)).toBe(true);

        first.release();
        const second = await secondPromise;
        second.release();
        expect(clearAlertMock).toHaveBeenCalledWith('marker-test', 'provider_execution_queue_pressure');
        expect(loadRecoveryMarkers().has(MARKER_KEY)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('does not set the marker when the pressure emit is not durably accepted', async () => {
    await withMarkerDir(async () => {
      vi.useFakeTimers();
      try {
        emitAlertMock.mockReturnValue(false);
        const gate = createProviderExecutionGate('marker-test');
        const first = await gate.acquire();
        const secondPromise = gate.acquire();

        await vi.advanceTimersByTimeAsync(30_000);
        expect(emitAlertMock).toHaveBeenCalledTimes(1);
        expect(loadRecoveryMarkers().has(MARKER_KEY)).toBe(false);

        first.release();
        (await secondPromise).release();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('reconciles a prior-process marker at construction of a verified idle gate', async () => {
    await withMarkerDir(() => {
      setRecoveryMarker(MARKER_KEY);

      createProviderExecutionGate('marker-test');
      expect(clearAlertMock).toHaveBeenCalledTimes(1);
      expect(clearAlertMock).toHaveBeenCalledWith(
        'marker-test',
        'provider_execution_queue_pressure',
        'startup idle-gate reconcile (#2394 source 4)',
      );
      expect(loadRecoveryMarkers().has(MARKER_KEY)).toBe(false);

      // Idempotence: a second construction finds no marker and emits nothing.
      createProviderExecutionGate('marker-test');
      expect(clearAlertMock).toHaveBeenCalledTimes(1);
    });
  });

  it('emits no startup clear when no prior-process marker exists', async () => {
    await withMarkerDir(() => {
      createProviderExecutionGate('marker-test');
      expect(clearAlertMock).not.toHaveBeenCalled();
    });
  });

  it('keeps the marker when the startup clear is not durably accepted', async () => {
    await withMarkerDir(() => {
      setRecoveryMarker(MARKER_KEY);
      clearAlertMock.mockReturnValue(false);

      createProviderExecutionGate('marker-test');
      expect(clearAlertMock).toHaveBeenCalledTimes(1);
      expect(loadRecoveryMarkers().has(MARKER_KEY)).toBe(true);

      // The next startup retries the idempotent clear once accepted.
      clearAlertMock.mockReturnValue(true);
      createProviderExecutionGate('marker-test');
      expect(loadRecoveryMarkers().has(MARKER_KEY)).toBe(false);
    });
  });

  it('does not clear a different instance’s marker', async () => {
    await withMarkerDir(() => {
      setRecoveryMarker('provider_execution_queue_pressure:other-instance');

      createProviderExecutionGate('marker-test');
      expect(clearAlertMock).not.toHaveBeenCalled();
      expect(loadRecoveryMarkers().has('provider_execution_queue_pressure:other-instance')).toBe(true);
    });
  });
});
