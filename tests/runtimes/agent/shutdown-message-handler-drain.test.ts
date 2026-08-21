/**
 * First slice of E20: the message-handler drain during AgentRuntime.shutdown()
 * must be bounded by the same absolute deadline the turn coordinator and the
 * route-recycle lifecycle already honor. Before this, a single handler that
 * never settled kept `Promise.allSettled` pending forever and shutdown only
 * ended when main.ts hard-killed the process (#3315).
 *
 * The helper does NOT abort handlers (that is E20 proper); it races the join
 * against the remaining budget and reports a content-free receipt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../../src/lib/clock.ts';
import {
  MessageHandlerDrainTimeoutError,
  drainMessageHandlersForShutdown,
} from '../../../src/runtimes/agent/shutdown-message-handler-drain.ts';

const START = 1_786_000_000_000;

function settledFlag<T>(promise: Promise<T>): { readonly settled: boolean } {
  const flag = { settled: false };
  void promise.then(() => { flag.settled = true; }, () => { flag.settled = true; });
  return flag;
}

describe('drainMessageHandlersForShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('one never-resolving handler: resolves at the deadline with timedOut=true and blockers=1', async () => {
    const never = new Promise<void>(() => {});
    const deadlineAt = systemClock.now() + 2_000;
    const drain = drainMessageHandlersForShutdown([never], deadlineAt);
    const flag = settledFlag(drain);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(flag.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(flag.settled).toBe(true);

    expect(await drain).toEqual({ timedOut: true, blockers: 1, settled: [] });
  });

  it('control: all handlers settled -> no timeout, zero blockers, every outcome reported', async () => {
    const rejected = Promise.reject(new Error('handler failed'));
    const drain = drainMessageHandlersForShutdown(
      [Promise.resolve(), rejected],
      systemClock.now() + 2_000,
    );
    await vi.advanceTimersByTimeAsync(0);
    const result = await drain;
    expect(result.timedOut).toBe(false);
    expect(result.blockers).toBe(0);
    expect(result.settled.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
  });

  it('mixed: settled handlers are excluded from the blocker count', async () => {
    const never = new Promise<void>(() => {});
    const drain = drainMessageHandlersForShutdown(
      [Promise.resolve(), never, new Promise<void>(() => {})],
      systemClock.now() + 500,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(await drain).toEqual({ timedOut: true, blockers: 2, settled: [] });
  });

  it('a deadline already in the past still yields to pending handlers exactly once, then times out', async () => {
    const never = new Promise<void>(() => {});
    const drain = drainMessageHandlersForShutdown([never], systemClock.now() - 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(await drain).toEqual({ timedOut: true, blockers: 1, settled: [] });
  });

  it('empty handler set resolves immediately without arming a timer', async () => {
    const drain = drainMessageHandlersForShutdown([], systemClock.now() + 2_000);
    expect(await drain).toEqual({ timedOut: false, blockers: 0, settled: [] });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('drainMessageHandlersForShutdown — late settlement is a distinct outcome per kind', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('a handler that RESOLVES after the deadline: counted as a blocker at the deadline, result never revised', async () => {
    const late = deferred();
    const drain = drainMessageHandlersForShutdown([late.promise], systemClock.now() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await drain;
    expect(result).toEqual({ timedOut: true, blockers: 1, settled: [] });

    late.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(late.promise).resolves.toBeUndefined();
    expect(result).toEqual({ timedOut: true, blockers: 1, settled: [] });
  });

  it('a handler that REJECTS after the deadline: counted as a blocker at the deadline, rejection observed, never unhandled', async () => {
    const late = deferred();
    const drain = drainMessageHandlersForShutdown([late.promise], systemClock.now() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await drain;
    expect(result).toEqual({ timedOut: true, blockers: 1, settled: [] });

    late.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    await expect(late.promise).rejects.toThrow('late failure');
    expect(result).toEqual({ timedOut: true, blockers: 1, settled: [] });
  });

  it('before the deadline, a resolved and a rejected handler are reported as distinct outcomes', async () => {
    const ok = deferred();
    const bad = deferred();
    const drain = drainMessageHandlersForShutdown([ok.promise, bad.promise], systemClock.now() + 1_000);
    ok.resolve();
    bad.reject(new Error('handler failed'));
    await vi.advanceTimersByTimeAsync(0);
    const result = await drain;
    expect(result.timedOut).toBe(false);
    expect(result.blockers).toBe(0);
    expect(result.settled[0]).toEqual({ status: 'fulfilled', value: undefined });
    expect(result.settled[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'handler failed' }) });
  });
});

describe('MessageHandlerDrainTimeoutError', () => {
  it('is a typed, content-free Error carrying only the blocker count', () => {
    const error = new MessageHandlerDrainTimeoutError(2);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MessageHandlerDrainTimeoutError');
    expect(error.blockers).toBe(2);
    expect(error.message).not.toMatch(/@s\.whatsapp\.net|@g\.us|@lid/);
  });
});
