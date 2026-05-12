/**
 * Direct unit coverage for src/core/post-connect-recovery.ts.
 *
 * `waitForHistorySyncThenRecover` orchestrates the post-reconnect recovery
 * sequence: wait for `historySyncComplete` (or a timeout), then sleep an
 * echo-grace period, then invoke the recover callback.
 *
 * Tests use a fake EventEmitter for the connectionManager and fake timers
 * to control delay() and the timeout race. All tests provide explicit
 * historySyncTimeoutMs so they stay under vitest's wall-clock test timeout.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { waitForHistorySyncThenRecover } from '../../src/core/post-connect-recovery.ts';

describe('waitForHistorySyncThenRecover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls recover() after historySyncComplete fires + echoGrace elapses', async () => {
    const emitter = new EventEmitter();
    const recover = vi.fn();
    const promise = waitForHistorySyncThenRecover({
      connectionManager: emitter,
      recover,
      historySyncTimeoutMs: 5_000,
      echoGraceMs: 2_000,
    });

    // Fire the event immediately
    emitter.emit('historySyncComplete');
    // Recover should not be called yet — echo grace must elapse first
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('falls back to timeout path when historySyncComplete never fires, then waits echoGrace', async () => {
    const emitter = new EventEmitter();
    const recover = vi.fn();
    const promise = waitForHistorySyncThenRecover({
      connectionManager: emitter,
      recover,
      historySyncTimeoutMs: 3_000,
      echoGraceMs: 1_000,
    });

    // Advance past timeout — recover still NOT called (echoGrace pending)
    await vi.advanceTimersByTimeAsync(3_000);
    expect(recover).not.toHaveBeenCalled();
    // Advance the remaining echoGrace
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('returns a Promise<void> that resolves AFTER recover() is called', async () => {
    const emitter = new EventEmitter();
    const recover = vi.fn();
    const promise = waitForHistorySyncThenRecover({
      connectionManager: emitter,
      recover,
      historySyncTimeoutMs: 1_000,
      echoGraceMs: 500,
    });

    emitter.emit('historySyncComplete');
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result).toBeUndefined();
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('event-path wins the race when both are racing — recover still called exactly once', async () => {
    const emitter = new EventEmitter();
    const recover = vi.fn();
    const promise = waitForHistorySyncThenRecover({
      connectionManager: emitter,
      recover,
      historySyncTimeoutMs: 10_000,
      echoGraceMs: 1_000,
    });

    // Fire event at t=0 and also advance past timeout — Promise.race resolves
    // on whichever happens first, and the `.once()` listener prevents
    // double-handling on the event side.
    emitter.emit('historySyncComplete');
    await vi.advanceTimersByTimeAsync(10_000); // past timeout but already resolved
    await vi.advanceTimersByTimeAsync(1_000); // echoGrace
    await promise;
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('uses `once` not `on` to listen — repeat events do not double-invoke recovery', async () => {
    const emitter = new EventEmitter();
    const recover = vi.fn();
    const promise = waitForHistorySyncThenRecover({
      connectionManager: emitter,
      recover,
      historySyncTimeoutMs: 5_000,
      echoGraceMs: 100,
    });

    // Emit twice — listener is `once`, so only the first event ends the race
    emitter.emit('historySyncComplete');
    emitter.emit('historySyncComplete');
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('historySyncTimeoutMs and echoGraceMs are independently configurable', async () => {
    // Two scenarios with different timeout/echoGrace combos that each
    // exercise the timeout path. This pins both knobs as truly configurable.
    const recoverA = vi.fn();
    const promiseA = waitForHistorySyncThenRecover({
      connectionManager: new EventEmitter(),
      recover: recoverA,
      historySyncTimeoutMs: 100,
      echoGraceMs: 50,
    });
    await vi.advanceTimersByTimeAsync(150);
    await promiseA;
    expect(recoverA).toHaveBeenCalledTimes(1);

    const recoverB = vi.fn();
    const promiseB = waitForHistorySyncThenRecover({
      connectionManager: new EventEmitter(),
      recover: recoverB,
      historySyncTimeoutMs: 200,
      echoGraceMs: 100,
    });
    await vi.advanceTimersByTimeAsync(300);
    await promiseB;
    expect(recoverB).toHaveBeenCalledTimes(1);
  });
});
