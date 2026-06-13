import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  boundedRetryAfterMs,
  MAX_RATE_LIMIT_RETRY_AFTER_MS,
  parseRetryAfterMs,
  waitForRateLimitRetry,
} from '../../../../src/runtimes/agent/providers/rate-limit-retry.ts';

describe('provider rate-limit Retry-After helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses numeric Retry-After seconds', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '3' }))).toBe(3000);
  });

  it('parses HTTP-date Retry-After values relative to the supplied clock', () => {
    const nowMs = Date.parse('2026-06-10T12:00:00Z');
    const retryAt = new Date(nowMs + 2500).toUTCString();

    expect(parseRetryAfterMs(new Headers({ 'retry-after': retryAt }), nowMs)).toBe(2000);
  });

  it('rejects invalid and over-budget Retry-After values', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'later' }))).toBeNull();
    expect(boundedRetryAfterMs(new Headers({ 'retry-after': '11' }))).toBeNull();
    expect(boundedRetryAfterMs(new Headers({ 'retry-after': '10' }))).toBe(MAX_RATE_LIMIT_RETRY_AFTER_MS);
  });

  it('waits for the requested retry delay and supports abort', async () => {
    vi.useFakeTimers();

    let settled = false;
    const wait = waitForRateLimitRetry(1000).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(settled).toBe(true);

    const controller = new AbortController();
    const aborted = waitForRateLimitRetry(1000, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/);
  });
});
