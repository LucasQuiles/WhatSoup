import { describe, expect, it, vi } from 'vitest';

import { AbortSleepError } from '../../src/core/retry.ts';
import { retryAsync, type RetryOptions } from '../../src/lib/retry-runner.ts';

/** Fast, deterministic delays so the suite stays under a second. */
function rejectAfter<T = never>(ms: number, error: unknown): Promise<T> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(error), ms));
}
function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('retryAsync', () => {
  it('returns the value on first success (no retry needed)', async () => {
    const run = vi.fn().mockResolvedValue('first-ok');
    const result = await retryAsync(run, { retries: 3, baseMs: 1 });
    expect(result).toBe('first-ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds when a later attempt passes', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('boom-1'))
      .mockRejectedValueOnce(new Error('boom-2'))
      .mockResolvedValueOnce('third-ok');
    const result = await retryAsync(run, { retries: 5, baseMs: 1 });
    expect(result).toBe('third-ok');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after retries are exhausted', async () => {
    const lastErr = new Error('final-boom');
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('boom-1'))
      .mockRejectedValueOnce(new Error('boom-2'))
      .mockRejectedValueOnce(lastErr);
    await expect(retryAsync(run, { retries: 2, baseMs: 1 })).rejects.toBe(lastErr);
    expect(run).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('respects retries: 0 (no retries — throws on first failure)', async () => {
    const err = new Error('no-retry');
    const run = vi.fn().mockRejectedValue(err);
    await expect(retryAsync(run, { retries: 0, baseMs: 1 })).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('respects shouldRetry returning false (throws immediately, no retry)', async () => {
    const err = new Error('non-retryable');
    const run = vi.fn().mockRejectedValue(err);
    const shouldRetry = vi.fn().mockReturnValue(false);
    await expect(
      retryAsync(run, { retries: 5, baseMs: 1, shouldRetry }),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(err, 0);
  });

  it('shouldRetry receives the correct attempt index on each failure', async () => {
    const attempts: number[] = [];
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValueOnce('ok');
    await retryAsync(run, {
      retries: 5,
      baseMs: 1,
      shouldRetry: (err, attempt) => { attempts.push(attempt); return true; },
    });
    // Attempts 0 and 1 failed (shouldRetry called for each); attempt 2 succeeded.
    expect(attempts).toEqual([0, 1]);
  });

  it('passes the attempt number to run()', async () => {
    const seen: number[] = [];
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValueOnce('ok');
    await retryAsync(run, {
      retries: 5,
      baseMs: 1,
      shouldRetry: () => true,
    });
    for (const call of run.mock.calls) seen.push(call[0] as number);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('uses getRetryAfterMs to override the delay (server Retry-After honored)', async () => {
    const onRetry = vi.fn();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('rate-limited'))
      .mockResolvedValueOnce('ok');
    const getRetryAfterMs = vi.fn().mockReturnValue(15);
    await retryAsync(run, {
      retries: 3,
      baseMs: 1000, // large — would be very slow if getRetryAfterMs were ignored
      getRetryAfterMs,
      onRetry,
    });
    expect(getRetryAfterMs).toHaveBeenCalled();
    // onRetry's delayMs should be ~15 (the server value + positive jitter up to +25%).
    const delayMs = onRetry.mock.calls[0]![0].delayMs;
    expect(delayMs).toBeGreaterThanOrEqual(15);
    expect(delayMs).toBeLessThanOrEqual(15 * 1.25);
  });

  it('falls back to baseMs exponential when getRetryAfterMs returns null', async () => {
    const onRetry = vi.fn();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');
    await retryAsync(run, {
      retries: 3,
      baseMs: 10,
      maxMs: 50,
      getRetryAfterMs: () => null,
      onRetry,
    });
    // baseMs 10, attempt 0 → exp 10, jittered symmetric → [7.5, 12.5].
    const delayMs = onRetry.mock.calls[0]![0].delayMs;
    expect(delayMs).toBeGreaterThanOrEqual(7.5);
    expect(delayMs).toBeLessThanOrEqual(12.5);
  });

  it('calls onRetry with attempt, delayMs, error, and retryAfterMs', async () => {
    const err = new Error('boom');
    const onRetry = vi.fn();
    const run = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');
    await retryAsync(run, {
      retries: 3,
      baseMs: 5,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    const info = onRetry.mock.calls[0]![0];
    expect(info.attempt).toBe(0);
    expect(info.error).toBe(err);
    expect(info.retryAfterMs).toBeNull();
    expect(typeof info.delayMs).toBe('number');
  });

  it('aborts when the signal fires during the retry sleep', async () => {
    const controller = new AbortController();
    const run = vi.fn().mockRejectedValue(new Error('always-fails'));
    const pending = retryAsync(run, {
      retries: 5,
      baseMs: 1000, // long sleep so the abort lands mid-wait
      signal: controller.signal,
      shouldRetry: () => true,
    });
    // Abort shortly after the first failure schedules the long sleep.
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toBeInstanceOf(AbortSleepError);
  });

  it('does not call run again after an abort', async () => {
    const controller = new AbortController();
    const run = vi.fn().mockRejectedValue(new Error('fail'));
    const pending = retryAsync(run, {
      retries: 5,
      baseMs: 500,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toBeInstanceOf(AbortSleepError);
    // Only the initial attempt ran; the retry sleep was aborted before run() could be called again.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('honors a custom jitterFraction via options', async () => {
    const onRetry = vi.fn();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce('ok');
    await retryAsync(run, {
      retries: 3,
      baseMs: 100,
      getRetryAfterMs: () => 20, // server floor 20
      jitterFraction: 0.5,
      onRetry,
    });
    // Positive jitter above server floor 20, fraction 0.5 → [20, 30].
    const delayMs = onRetry.mock.calls[0]![0].delayMs;
    expect(delayMs).toBeGreaterThanOrEqual(20);
    expect(delayMs).toBeLessThanOrEqual(30);
  });
});
