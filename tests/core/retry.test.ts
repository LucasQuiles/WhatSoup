import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortSleepError,
  jitteredDelay,
  jitteredDelayPositive,
  sleep as retrySleep,
  sleepWithAbort,
} from '../../src/core/retry.ts';

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

describe('jitteredDelayPositive', () => {
  it('never undercuts the un-jittered exponential floor (random = 0)', () => {
    const random = vi.spyOn(Math, 'random');
    // floor = min(100 * 2^2, 30000) = 400; random 0 → exactly 400.
    random.mockReturnValueOnce(0);
    expect(jitteredDelayPositive(100, 2)).toBe(400);
  });

  it('applies additive jitter up to jitterFraction above the floor (random = 1)', () => {
    const random = vi.spyOn(Math, 'random');
    // floor 400, default jitterFraction 0.25, random 1 → 400 * 1.25 = 500.
    random.mockReturnValueOnce(1);
    expect(jitteredDelayPositive(100, 2)).toBe(500);
  });

  it('caps the base component at maxMs before adding jitter', () => {
    const random = vi.spyOn(Math, 'random');
    // floor = min(100 * 2^3, 500) = 500; random 1 → 500 * 1.25 = 625.
    random.mockReturnValueOnce(1);
    expect(jitteredDelayPositive(100, 3, 500)).toBe(625);
    // random 0 → exactly the capped floor.
    random.mockReturnValueOnce(0);
    expect(jitteredDelayPositive(100, 3, 500)).toBe(500);
  });

  it('honors a custom jitterFraction', () => {
    const random = vi.spyOn(Math, 'random');
    // floor 400, jitterFraction 0.5, random 1 → 400 * 1.5 = 600.
    random.mockReturnValueOnce(1);
    expect(jitteredDelayPositive(100, 2, 30_000, 0.5)).toBe(600);
  });

  it('over 1000 samples with real random, every value is >= floor and <= floor*(1+fraction)', () => {
    // floor for (100, 2) is 400; default fraction 0.25 → range [400, 500].
    for (let i = 0; i < 1000; i++) {
      const v = jitteredDelayPositive(100, 2);
      expect(v).toBeGreaterThanOrEqual(400);
      expect(v).toBeLessThanOrEqual(500);
    }
  });
});

describe('jitteredDelayPositive — input validation (clamps)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clamps a negative baseMs to a 0 floor (never returns negative)', () => {
    // Broken: -100 * 2^2 = -400 → capped -400 → a negative delay.
    expect(jitteredDelayPositive(-100, 2)).toBe(0);
  });

  it('treats NaN baseMs as 0 (never returns NaN)', () => {
    // Broken: NaN * 2^2 = NaN → returns NaN.
    expect(jitteredDelayPositive(NaN, 2)).toBe(0);
  });

  it('clamps a negative attempt to 0 (floor = baseMs)', () => {
    // safeAttempt = max(-3, 0) = 0 → exp = 100 * 2^0 = 100; random 0 → 100.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(jitteredDelayPositive(100, -3)).toBe(100);
  });

  it('treats NaN attempt as 0 (floor = baseMs)', () => {
    // Broken: 2^NaN = NaN → NaN result. Fixed: attempt clamped to 0 → floor 100.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(jitteredDelayPositive(100, NaN)).toBe(100);
  });

  it('degrades Infinity baseMs to maxMs, not to 0', () => {
    // Guard against a naive isFinite(baseMs) fix that would map Infinity → 0.
    // Infinity * 2^2 = Infinity, capped at maxMs (30000); random 0 → 30000.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(jitteredDelayPositive(Infinity, 2)).toBe(30_000);
  });

  it('guards a NaN maxMs (result is a finite number, never NaN)', () => {
    // Broken: min(400, NaN) = NaN → returns NaN. Fixed: falls back to the 30000 default.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const v = jitteredDelayPositive(100, 2, NaN);
    expect(Number.isNaN(v)).toBe(false);
    expect(v).toBe(400);
  });

  it('floors a negative jitterFraction to 0 (never undercuts the exponential floor)', () => {
    // Broken: 400 * (1 + 1 * -0.5) = 200 — BELOW the 400 floor. Fixed: floor preserved.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(jitteredDelayPositive(100, 2, 30_000, -0.5)).toBe(400);
  });
});

describe('sleepWithAbort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves immediately when ms <= 0 (no timer scheduled)', async () => {
    let resolved = false;
    await sleepWithAbort(0);
    await sleepWithAbort(-5);
    resolved = true;
    expect(resolved).toBe(true);
  });

  it('resolves after the requested delay when no signal is supplied', async () => {
    let resolved = false;
    const pending = sleepWithAbort(25).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it('resolves after the requested delay when signal is not aborted', async () => {
    const controller = new AbortController();
    let resolved = false;
    const pending = sleepWithAbort(25, controller.signal).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    expect(resolved).toBe(true);
  });

  it('rejects with AbortSleepError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(25, controller.signal)).rejects.toBeInstanceOf(AbortSleepError);
  });

  it('rejects when already aborted even at ms = 0 (abort check precedes the ms<=0 fast-path)', async () => {
    // Defect: if the ms<=0 fast-path runs before the abort check, an already-aborted
    // signal resolves instead of rejecting — a retry loop would then run another attempt.
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(0, controller.signal)).rejects.toBeInstanceOf(AbortSleepError);
  });

  it('rejects when already aborted even at negative ms', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(-5, controller.signal)).rejects.toBeInstanceOf(AbortSleepError);
  });

  it('resolves at ms = 0 when a signal is present but NOT aborted (fast-path still works)', async () => {
    const controller = new AbortController();
    await expect(sleepWithAbort(0, controller.signal)).resolves.toBeUndefined();
  });

  it('rejects with AbortSleepError when the signal aborts mid-sleep', async () => {
    const controller = new AbortController();
    const pending = sleepWithAbort(50, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortSleepError);
  });

  it('does not double-resolve if the timer fires after an abort (timer is cleared)', async () => {
    const controller = new AbortController();
    let rejected = false;
    sleepWithAbort(50, controller.signal).catch((err: unknown) => {
      expect(err).toBeInstanceOf(AbortSleepError);
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    // Advance well past the original timer — the reject must NOT be undone.
    await vi.advanceTimersByTimeAsync(100);
    expect(rejected).toBe(true);
  });

  it('AbortSleepError carries the requested ms and a stable name', async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await sleepWithAbort(123, controller.signal);
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AbortSleepError);
      expect((err as AbortSleepError).requestedMs).toBe(123);
      expect((err as AbortSleepError).name).toBe('AbortSleepError');
    }
  });

  it('removes the abort listener after normal completion (no leak)', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = sleepWithAbort(10, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    // The completion path removes the abort listener exactly once.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    // Aborting after completion must NOT cause an unhandled rejection.
    controller.abort();
  });
});
