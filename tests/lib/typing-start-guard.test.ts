import { describe, expect, it, vi } from 'vitest';

import { createTypingStartGuard } from '../../src/lib/typing-start-guard.ts';

describe('createTypingStartGuard', () => {
  it('returns "started" when the callback succeeds', async () => {
    const guard = createTypingStartGuard({ isSealed: () => false });
    const start = vi.fn().mockResolvedValue(undefined);
    const result = await guard.run(start);
    expect(result).toBe('started');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('returns "skipped" when sealed', async () => {
    const guard = createTypingStartGuard({ isSealed: () => true });
    const start = vi.fn();
    const result = await guard.run(start);
    expect(result).toBe('skipped');
    expect(start).not.toHaveBeenCalled();
  });

  it('returns "skipped" when shouldBlock returns true', async () => {
    const guard = createTypingStartGuard({
      isSealed: () => false,
      shouldBlock: () => true,
    });
    const start = vi.fn();
    const result = await guard.run(start);
    expect(result).toBe('skipped');
    expect(start).not.toHaveBeenCalled();
  });

  it('returns "failed" on error (swallowed by default)', async () => {
    const onStartError = vi.fn();
    const guard = createTypingStartGuard({
      isSealed: () => false,
      onStartError,
    });
    const start = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await guard.run(start);
    expect(result).toBe('failed');
    expect(onStartError).toHaveBeenCalledTimes(1);
    expect(onStartError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('re-throws when rethrowOnError is true', async () => {
    const guard = createTypingStartGuard({
      isSealed: () => false,
      rethrowOnError: true,
    });
    const start = vi.fn().mockRejectedValue(new Error('rethrow me'));
    await expect(guard.run(start)).rejects.toThrow('rethrow me');
  });

  it('resets failure counter on success after a failure', async () => {
    const guard = createTypingStartGuard({
      isSealed: () => false,
      maxConsecutiveFailures: 3,
    });
    await guard.run(vi.fn().mockRejectedValue(new Error('1')));
    await guard.run(vi.fn().mockRejectedValue(new Error('2')));
    // Success resets the counter
    await guard.run(vi.fn().mockResolvedValue(undefined));
    // Two more failures should NOT trip (counter was reset)
    await guard.run(vi.fn().mockRejectedValue(new Error('3')));
    await guard.run(vi.fn().mockRejectedValue(new Error('4')));
    expect(guard.isTripped()).toBe(false);
  });

  it('trips after maxConsecutiveFailures', async () => {
    const onTrip = vi.fn();
    const guard = createTypingStartGuard({
      isSealed: () => false,
      maxConsecutiveFailures: 3,
      onTrip,
    });
    expect(await guard.run(vi.fn().mockRejectedValue(new Error('1')))).toBe('failed');
    expect(await guard.run(vi.fn().mockRejectedValue(new Error('2')))).toBe('failed');
    expect(await guard.run(vi.fn().mockRejectedValue(new Error('3')))).toBe('tripped');
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(guard.isTripped()).toBe(true);
  });

  it('returns "skipped" after tripping (no more calls)', async () => {
    const guard = createTypingStartGuard({
      isSealed: () => false,
      maxConsecutiveFailures: 1,
    });
    await guard.run(vi.fn().mockRejectedValue(new Error('boom')));
    expect(guard.isTripped()).toBe(true);
    const start = vi.fn().mockResolvedValue(undefined);
    const result = await guard.run(start);
    expect(result).toBe('skipped');
    expect(start).not.toHaveBeenCalled();
  });

  it('reset() clears the tripped state and failure counter', async () => {
    const guard = createTypingStartGuard({
      isSealed: () => false,
      maxConsecutiveFailures: 1,
    });
    await guard.run(vi.fn().mockRejectedValue(new Error('boom')));
    expect(guard.isTripped()).toBe(true);
    guard.reset();
    expect(guard.isTripped()).toBe(false);
    const result = await guard.run(vi.fn().mockResolvedValue(undefined));
    expect(result).toBe('started');
  });

  it('maxConsecutiveFailures: 0 or negative → no trip (retry forever)', async () => {
    const guard = createTypingStartGuard({
      isSealed: () => false,
      maxConsecutiveFailures: 0,
    });
    for (let i = 0; i < 10; i++) {
      const result = await guard.run(vi.fn().mockRejectedValue(new Error(`${i}`)));
      expect(result).toBe('failed');
    }
    expect(guard.isTripped()).toBe(false);
  });

  it('maxConsecutiveFailures: undefined → no trip (retry forever)', async () => {
    const guard = createTypingStartGuard({ isSealed: () => false });
    for (let i = 0; i < 10; i++) {
      const result = await guard.run(vi.fn().mockRejectedValue(new Error(`${i}`)));
      expect(result).toBe('failed');
    }
    expect(guard.isTripped()).toBe(false);
  });

  it('handles synchronous throws in the callback', async () => {
    const guard = createTypingStartGuard({ isSealed: () => false });
    const start = vi.fn(() => {
      throw new Error('sync throw');
    });
    const result = await guard.run(start);
    expect(result).toBe('failed');
  });

  it('handles synchronous void (non-promise) callback', async () => {
    const guard = createTypingStartGuard({ isSealed: () => false });
    let called = false;
    const result = await guard.run(() => {
      called = true;
    });
    expect(result).toBe('started');
    expect(called).toBe(true);
  });

  it('trips exactly at the threshold (boundary)', async () => {
    const guard = createTypingStartGuard({
      isSealed: () => false,
      maxConsecutiveFailures: 2,
    });
    // First failure: not tripped yet
    expect(await guard.run(vi.fn().mockRejectedValue(new Error('1')))).toBe('failed');
    expect(guard.isTripped()).toBe(false);
    // Second failure: trips
    expect(await guard.run(vi.fn().mockRejectedValue(new Error('2')))).toBe('tripped');
    expect(guard.isTripped()).toBe(true);
  });
});
