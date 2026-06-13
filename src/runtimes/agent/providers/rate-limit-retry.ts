export const MAX_RATE_LIMIT_RETRY_AFTER_MS = 10_000;

export function parseRetryAfterMs(
  headers: Pick<Headers, 'get'>,
  nowMs = Date.now(),
): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

export function boundedRetryAfterMs(
  headers: Pick<Headers, 'get'>,
  maxMs = MAX_RATE_LIMIT_RETRY_AFTER_MS,
): number | null {
  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs === null) return null;
  return retryAfterMs <= maxMs ? retryAfterMs : null;
}

export function waitForRateLimitRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error('rate-limit retry aborted'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('rate-limit retry aborted'));
    }, { once: true });
  });
}
