import { describe, expect, it, vi } from 'vitest';

import {
  computeBackoffMs,
  createTypingGuard,
  DEFAULT_AUTH_BACKOFF,
  isAuthFailureError,
  isTransientError,
  readRetryAfterMs,
  TypingSuspendedError,
  TypingTransientCooldownError,
  type TypingGuardOptions,
} from '../../src/lib/typing-backoff-hardened.ts';

// ── isAuthFailureError ─────────────────────────────────────────────────────

describe('isAuthFailureError', () => {
  it('returns true for structured status=401', () => {
    expect(isAuthFailureError({ status: 401 })).toBe(true);
  });

  it('returns true for structured error_code=401', () => {
    expect(isAuthFailureError({ error_code: 401 })).toBe(true);
  });

  it('returns false for structured status=429 (NOT a 401)', () => {
    expect(isAuthFailureError({ status: 429 })).toBe(false);
  });

  it('returns false for structured status=500', () => {
    expect(isAuthFailureError({ status: 500 })).toBe(false);
  });

  it('returns true for Error with "unauthorized" in message', () => {
    expect(isAuthFailureError(new Error('Unauthorized access'))).toBe(true);
    expect(isAuthFailureError(new Error('401 UNAUTHORIZED'))).toBe(true);
  });

  it('returns FALSE for "401" in message WITHOUT "unauthorized" (the retry_after=401 bug)', () => {
    // A 429 with retry_after=401 renders as "retry after 401" — must NOT trip
    expect(isAuthFailureError(new Error('Too Many Requests: retry after 401'))).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(isAuthFailureError(new Error('network timeout'))).toBe(false);
    expect(isAuthFailureError(null)).toBe(false);
    expect(isAuthFailureError(undefined)).toBe(false);
    expect(isAuthFailureError('')).toBe(false);
  });

  it('prefers structured status over message substring', () => {
    // Even if message says "unauthorized", structured status=200 wins
    const err = { status: 200, message: 'unauthorized' };
    expect(isAuthFailureError(err)).toBe(false);
  });
});

// ── isTransientError ───────────────────────────────────────────────────────

describe('isTransientError', () => {
  it('returns true for 429 rate limit', () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ error_code: 429 })).toBe(true);
  });

  it('returns true for 5xx server errors', () => {
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ status: 502 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ error_code: 500 })).toBe(true);
  });

  it('returns false for 401 (that is an auth error, not transient)', () => {
    expect(isTransientError({ status: 401 })).toBe(false);
  });

  it('returns false for 404', () => {
    expect(isTransientError({ status: 404 })).toBe(false);
  });

  it('returns true for network error codes', () => {
    expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isTransientError({ code: 'EAI_AGAIN' })).toBe(true);
  });

  it('returns false for unknown error codes', () => {
    expect(isTransientError({ code: 'EUNKNOWN' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

// ── readRetryAfterMs ───────────────────────────────────────────────────────

describe('readRetryAfterMs', () => {
  it('reads retry_after from top level (seconds → ms)', () => {
    expect(readRetryAfterMs({ retry_after: 30 })).toBe(30_000);
  });

  it('reads retry_after from parameters object', () => {
    expect(readRetryAfterMs({ parameters: { retry_after: 5 } })).toBe(5_000);
  });

  it('returns undefined when no retry_after', () => {
    expect(readRetryAfterMs({ status: 429 })).toBeUndefined();
    expect(readRetryAfterMs(null)).toBeUndefined();
    expect(readRetryAfterMs(undefined)).toBeUndefined();
  });

  it('returns undefined for zero or negative', () => {
    expect(readRetryAfterMs({ retry_after: 0 })).toBeUndefined();
    expect(readRetryAfterMs({ retry_after: -1 })).toBeUndefined();
  });
});

// ── computeBackoffMs ───────────────────────────────────────────────────────

describe('computeBackoffMs', () => {
  it('returns initialMs for attempt 1', () => {
    expect(computeBackoffMs(DEFAULT_AUTH_BACKOFF, 1)).toBeGreaterThanOrEqual(900);
    expect(computeBackoffMs(DEFAULT_AUTH_BACKOFF, 1)).toBeLessThanOrEqual(1100);
  });

  it('doubles for attempt 2', () => {
    const noJitter: typeof DEFAULT_AUTH_BACKOFF = { ...DEFAULT_AUTH_BACKOFF, jitter: 0 };
    expect(computeBackoffMs(noJitter, 1)).toBe(1_000);
    expect(computeBackoffMs(noJitter, 2)).toBe(2_000);
    expect(computeBackoffMs(noJitter, 3)).toBe(4_000);
    expect(computeBackoffMs(noJitter, 4)).toBe(8_000);
  });

  it('caps at maxMs', () => {
    const noJitter: typeof DEFAULT_AUTH_BACKOFF = { ...DEFAULT_AUTH_BACKOFF, jitter: 0 };
    expect(computeBackoffMs(noJitter, 20)).toBe(300_000);
  });

  it('handles attempt 0 gracefully', () => {
    expect(computeBackoffMs(DEFAULT_AUTH_BACKOFF, 0)).toBeGreaterThan(0);
  });
});

// ── createTypingGuard ──────────────────────────────────────────────────────

function makeGuard(
  overrides: Partial<TypingGuardOptions> = {},
): ReturnType<typeof createTypingGuard> & {
  sendTypingFn: ReturnType<typeof vi.fn>;
  logFn: ReturnType<typeof vi.fn>;
  sleepFn: ReturnType<typeof vi.fn>;
} {
  const sendTypingFn = vi.fn();
  const logFn = vi.fn();
  const sleepFn = vi.fn().mockResolvedValue(undefined);
  const guard = createTypingGuard({
    sendTyping: sendTypingFn,
    onLog: logFn,
    sleep: sleepFn,
    ...overrides,
  });
  return Object.assign(guard, { sendTypingFn, logFn, sleepFn });
}

describe('createTypingGuard — success path', () => {
  it('calls sendTyping on success', async () => {
    const guard = makeGuard();
    guard.sendTypingFn.mockResolvedValue(undefined);
    await guard.send('chat1');
    expect(guard.sendTypingFn).toHaveBeenCalledWith('chat1');
  });

  it('resets auth failure count on success after failures', async () => {
    const guard = makeGuard({ maxConsecutiveAuthFailures: 5 });
    guard.sendTypingFn
      .mockRejectedValueOnce({ status: 401 })
      .mockResolvedValueOnce(undefined);
    await guard.send('chat1').catch(() => {});
    await guard.send('chat1');
    expect(guard.getConsecutiveAuthFailures()).toBe(0);
  });
});

describe('createTypingGuard — auth failure backoff', () => {
  it('counts consecutive auth failures', async () => {
    const guard = makeGuard({ maxConsecutiveAuthFailures: 5 });
    guard.sendTypingFn.mockRejectedValue({ status: 401 });
    for (let i = 0; i < 3; i++) {
      await guard.send('chat1').catch(() => {});
    }
    expect(guard.getConsecutiveAuthFailures()).toBe(3);
    expect(guard.isSuspended()).toBe(false);
  });

  it('suspends after max consecutive auth failures', async () => {
    const guard = makeGuard({ maxConsecutiveAuthFailures: 3 });
    guard.sendTypingFn.mockRejectedValue({ status: 401 });
    for (let i = 0; i < 3; i++) {
      await guard.send('chat1').catch(() => {});
    }
    expect(guard.isSuspended()).toBe(true);
    expect(guard.logFn).toHaveBeenCalledWith(
      expect.stringContaining('CRITICAL'),
      'critical',
    );
  });

  it('throws TypingSuspendedError when suspended', async () => {
    const guard = makeGuard({ maxConsecutiveAuthFailures: 1 });
    guard.sendTypingFn.mockRejectedValue({ status: 401 });
    await guard.send('chat1').catch(() => {});
    expect(guard.isSuspended()).toBe(true);
    await expect(guard.send('chat1')).rejects.toThrow(TypingSuspendedError);
  });

  it('applies backoff delay before retry after auth failure', async () => {
    const guard = makeGuard({ maxConsecutiveAuthFailures: 10 });
    guard.sendTypingFn
      .mockRejectedValueOnce({ status: 401 })
      .mockResolvedValueOnce(undefined);
    await guard.send('chat1').catch(() => {});
    await guard.send('chat1');
    expect(guard.sleepFn).toHaveBeenCalled();
    expect(guard.logFn).toHaveBeenCalledWith(
      expect.stringContaining('backoff'),
      'warn',
    );
  });
});

describe('createTypingGuard — transient cooldown', () => {
  it('throws TypingTransientCooldownError on subsequent call within cooldown', async () => {
    let fakeNow = 0;
    const guard = makeGuard({ now: () => fakeNow });
    guard.sendTypingFn.mockRejectedValue({ status: 429 });
    // First call: throws the original 429 error
    await guard.send('chat1').catch(() => {});
    // Second call within cooldown: throws TypingTransientCooldownError
    fakeNow = 100;
    await expect(guard.send('chat1')).rejects.toThrow(TypingTransientCooldownError);
  });

  it('honors retry_after from error', async () => {
    let fakeNow = 0;
    const guard = makeGuard({ now: () => fakeNow });
    guard.sendTypingFn.mockRejectedValue({ status: 429, retry_after: 30 });
    await guard.send('chat1').catch(() => {});
    // Second call should be in cooldown
    fakeNow = 1_000;
    await expect(guard.send('chat1')).rejects.toThrow(TypingTransientCooldownError);
  });

  it('clears transient cooldown on success', async () => {
    let fakeNow = 0;
    const guard = makeGuard({ now: () => fakeNow });
    guard.sendTypingFn
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce(undefined);
    await guard.send('chat1').catch(() => {});
    // Wait for cooldown to pass
    fakeNow = 999_999;
    await guard.send('chat1');
    // No error means cooldown was cleared
  });
});

describe('createTypingGuard — per-key coalescing', () => {
  it('silently skips when within minIntervalMs for same target', async () => {
    let fakeNow = 0;
    const guard = makeGuard({ minIntervalMs: 1000, now: () => fakeNow });
    guard.sendTypingFn.mockResolvedValue(undefined);
    await guard.send('chat1');
    fakeNow = 500;
    await guard.send('chat1'); // should be skipped
    expect(guard.sendTypingFn).toHaveBeenCalledTimes(1);
  });

  it('allows different targets independently', async () => {
    let fakeNow = 0;
    const guard = makeGuard({ minIntervalMs: 1000, now: () => fakeNow });
    guard.sendTypingFn.mockResolvedValue(undefined);
    await guard.send('chat1');
    await guard.send('chat2');
    expect(guard.sendTypingFn).toHaveBeenCalledTimes(2);
  });

  it('allows same target after interval passes', async () => {
    let fakeNow = 0;
    const guard = makeGuard({ minIntervalMs: 1000, now: () => fakeNow });
    guard.sendTypingFn.mockResolvedValue(undefined);
    await guard.send('chat1');
    fakeNow = 1001;
    await guard.send('chat1');
    expect(guard.sendTypingFn).toHaveBeenCalledTimes(2);
  });
});

describe('createTypingGuard — reset', () => {
  it('clears all state', async () => {
    const guard = makeGuard({ maxConsecutiveAuthFailures: 3 });
    guard.sendTypingFn.mockRejectedValue({ status: 401 });
    await guard.send('chat1').catch(() => {});
    await guard.send('chat1').catch(() => {});
    expect(guard.getConsecutiveAuthFailures()).toBe(2);

    guard.reset();
    expect(guard.getConsecutiveAuthFailures()).toBe(0);
    expect(guard.isSuspended()).toBe(false);
  });

  it('clears suspension', async () => {
    const guard = makeGuard({ maxConsecutiveAuthFailures: 1 });
    guard.sendTypingFn.mockRejectedValue({ status: 401 });
    await guard.send('chat1').catch(() => {});
    expect(guard.isSuspended()).toBe(true);
    guard.reset();
    expect(guard.isSuspended()).toBe(false);
  });
});

describe('createTypingGuard — unknown errors', () => {
  it('rethrows unknown errors without incrementing counters', async () => {
    const guard = makeGuard();
    guard.sendTypingFn.mockRejectedValue(new Error('unknown error'));
    await expect(guard.send('chat1')).rejects.toThrow('unknown error');
    expect(guard.getConsecutiveAuthFailures()).toBe(0);
  });
});
