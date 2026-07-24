import { describe, expect, it, vi } from 'vitest';

const { emitAlertMock, clearAlertMock } = vi.hoisted(() => ({
  emitAlertMock: vi.fn(),
  clearAlertMock: vi.fn(),
}));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: emitAlertMock,
  clearAlertSourceChecked: clearAlertMock,
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  createProviderExecutionGate,
  ProviderExecutionGate,
} from '../../../src/runtimes/agent/provider-execution-gate.ts';

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
});
