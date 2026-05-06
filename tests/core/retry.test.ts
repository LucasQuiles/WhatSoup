import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jitteredDelay, sleep as retrySleep } from '../../src/core/retry.ts';

describe('retry helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('exports sleep and jitteredDelay helpers', () => {
    expect(retrySleep).toBeTypeOf('function');
    expect(jitteredDelay).toBeTypeOf('function');
  });

  it('sleep resolves after the requested delay', async () => {
    let resolved = false;
    const pending = retrySleep(25).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it('jitteredDelay applies exponential backoff and caps before jitter', () => {
    const random = vi.spyOn(Math, 'random');

    random.mockReturnValueOnce(0);
    expect(jitteredDelay(100, 2)).toBe(300);

    random.mockReturnValueOnce(0.5);
    expect(jitteredDelay(100, 3, 500)).toBe(500);
  });
});
