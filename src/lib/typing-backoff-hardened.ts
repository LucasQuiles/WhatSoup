/**
 * Hardened typing-indicator guard with auth-failure backoff and transient
 * cooldown.
 *
 * Prevents the infinite-typing-loop class of bug that gets bots banned or
 * deleted by the platform. Three layers of protection:
 *
 * 1. Auth-failure (401) backoff + suspend: when the platform rejects typing
 *    with an auth error, exponential backoff is applied (1s -> 2s -> ... -> cap).
 *    After N consecutive auth failures (default 10), ALL typing is suspended
 *    until reset() is called. An infinite typing loop caused a platform to
 *    DELETE a bot (real-world incident).
 *
 * 2. Transient cooldown: for rate-limit (429), server-error (5xx), and network
 *    errors, a cooldown period is enforced before retrying. If the error
 *    carries a `retry_after` field (in seconds), that value is honored.
 *
 * 3. Per-key min-interval coalescing: to avoid hammering the platform with
 *    redundant typing requests, each (target, action) pair is rate-limited
 *    to minIntervalMs.
 *
 * CRITICAL: the 401 detection is precise. When a structured `status` field
 * is present, it is trusted exclusively. For unstructured errors, the string
 * "unauthorized" is matched case-insensitively — but bare "401" substring
 * matching is NEVER used, because a 429 response with `retry_after=401`
 * renders as "retry after 401" and would falsely trip the auth path.
 *
 * The guard THROWS a TypingTransientCooldownError on transient failures
 * (rather than swallowing them) so the caller's keepalive loop can count
 * the failure and stop, rather than silently hammering the platform.
 */

export interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
}

export const DEFAULT_AUTH_BACKOFF: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 300_000,
  factor: 2,
  jitter: 0.1,
};

export interface TypingGuardOptions {
  /** The underlying typing-start function. */
  sendTyping: (target: string) => Promise<void>;
  /** Max consecutive auth failures before suspending. Default: 10. */
  maxConsecutiveAuthFailures?: number;
  /** Min interval between typing requests for the same target, in ms. Default: 0 (disabled). */
  minIntervalMs?: number;
  /** Auth-failure backoff policy. */
  authBackoff?: BackoffPolicy;
  /** Called for log/diagnostic messages. */
  onLog?: (message: string, level: 'info' | 'warn' | 'critical') => void;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable sleep (for backoff delays). */
  sleep?: (ms: number) => Promise<void>;
}

export class TypingSuspendedError extends Error {
  constructor() {
    super('Typing indicator suspended due to consecutive auth failures');
    this.name = 'TypingSuspendedError';
  }
}

export class TypingTransientCooldownError extends Error {
  constructor(public remainingMs: number) {
    super(`Typing transient cooldown active for ${Math.ceil(remainingMs)}ms`);
    this.name = 'TypingTransientCooldownError';
  }
}

export interface TypingGuard {
  /** Send a typing indicator with full backoff/cooldown/suspend protection. */
  send: (target: string) => Promise<void>;
  /** Whether typing is suspended due to auth failures. */
  isSuspended: () => boolean;
  /** Reset all failure counters, cooldowns, and suspension state. */
  reset: () => void;
  /** Get current consecutive auth failure count. */
  getConsecutiveAuthFailures: () => number;
}

// ─── Error classification ──────────────────────────────────────────────────

/**
 * Determine if an error represents an auth failure (HTTP 401).
 *
 * CRITICAL: when a structured `status` field is present, trust it exclusively.
 * For unstructured errors, match "unauthorized" case-insensitively, but NEVER
 * use bare "401" substring matching — a 429 response with retry_after=401
 * renders as "retry after 401" and would falsely trip this path.
 */
export function isAuthFailureError(error: unknown): boolean {
  if (!error) return false;

  // Structured status: trust exclusively
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status === 401;
  }

  // Structured error_code field
  if (
    typeof error === 'object' &&
    error !== null &&
    'error_code' in error &&
    typeof (error as { error_code: unknown }).error_code === 'number'
  ) {
    return (error as { error_code: number }).error_code === 401;
  }

  // Fallback for unstructured errors: match "unauthorized" but NOT bare "401"
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('unauthorized');
}

/**
 * Determine if an error is transient (rate-limit, server error, network).
 * These warrant a cooldown rather than the auth-failure backoff path.
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;

  // Structured status codes
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    const status = (error as { status: number }).status;
    return status === 429 || (status >= 500 && status < 600);
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'error_code' in error &&
    typeof (error as { error_code: unknown }).error_code === 'number'
  ) {
    const code = (error as { error_code: number }).error_code;
    return code === 429 || (code >= 500 && code < 600);
  }

  // Network error codes
  const NET_ERR_CODES = [
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETDOWN', 'ETIMEDOUT',
    'ESOCKETTIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND',
    'EAI_AGAIN', 'ECONNABORTED', 'ERR_NETWORK',
  ];
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return NET_ERR_CODES.includes((error as { code: string }).code);
  }

  return false;
}

/**
 * Extract retry_after from an error, in milliseconds.
 * Platforms return this in seconds; we convert to ms.
 */
export function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  // Check common locations for retry_after
  const candidates = [
    (error as Record<string, unknown>).retry_after,
    (error as Record<string, unknown>).parameters &&
      typeof (error as { parameters: Record<string, unknown> }).parameters === 'object'
      ? (error as { parameters: Record<string, unknown> }).parameters.retry_after
      : undefined,
  ];

  for (const c of candidates) {
    if (typeof c === 'number' && c > 0) {
      return c * 1_000; // seconds → ms
    }
  }
  return undefined;
}

// ─── Backoff computation ───────────────────────────────────────────────────

/**
 * Compute exponential backoff delay with optional jitter.
 */
export function computeBackoffMs(policy: BackoffPolicy, attempt: number): number {
  const base = Math.min(
    policy.initialMs * Math.pow(policy.factor, Math.max(0, attempt - 1)),
    policy.maxMs,
  );
  if (policy.jitter > 0) {
    const jitterAmount = base * policy.jitter;
    const jitter = (Math.random() - 0.5) * 2 * jitterAmount;
    return Math.max(0, Math.round(base + jitter));
  }
  return Math.round(base);
}

// ─── TypingGuard implementation ────────────────────────────────────────────

export function createTypingGuard(options: TypingGuardOptions): TypingGuard {
  const sendTyping = options.sendTyping;
  const maxAuthFailures = options.maxConsecutiveAuthFailures ?? 10;
  const minIntervalMs = options.minIntervalMs ?? 0;
  const authBackoff = options.authBackoff ?? DEFAULT_AUTH_BACKOFF;
  const onLog = options.onLog ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let consecutiveAuthFailures = 0;
  let consecutiveTransientFailures = 0;
  let suspended = false;
  let transientCooldownUntilMs = 0;
  const blockedUntilByKey = new Map<string, number>();

  const reset: TypingGuard['reset'] = () => {
    consecutiveAuthFailures = 0;
    consecutiveTransientFailures = 0;
    suspended = false;
    transientCooldownUntilMs = 0;
    blockedUntilByKey.clear();
  };

  const send: TypingGuard['send'] = async (target) => {
    if (suspended) {
      throw new TypingSuspendedError();
    }

    const attemptedAt = now();

    // Transient cooldown check — throw so callers can count the failure
    const remainingCooldown = transientCooldownUntilMs - attemptedAt;
    if (remainingCooldown > 0) {
      throw new TypingTransientCooldownError(remainingCooldown);
    }

    // Per-key min-interval coalescing
    const key = minIntervalMs > 0 ? target : undefined;
    if (key) {
      const blockedUntil = blockedUntilByKey.get(key);
      if (blockedUntil !== undefined && attemptedAt < blockedUntil) {
        return; // silently skip — within coalesce window
      }
      blockedUntilByKey.set(key, Number.POSITIVE_INFINITY);
    }

    // Auth-failure backoff: wait before retrying
    if (consecutiveAuthFailures > 0) {
      const backoffMs = computeBackoffMs(authBackoff, consecutiveAuthFailures);
      onLog(
        `typing backoff: waiting ${backoffMs}ms before retry (failure ${consecutiveAuthFailures}/${maxAuthFailures})`,
        'warn',
      );
      await sleep(backoffMs);
    }

    try {
      await sendTyping(target);

      // Success: reset counters
      if (consecutiveAuthFailures > 0) {
        onLog(`typing recovered after ${consecutiveAuthFailures} consecutive auth failures`, 'info');
        consecutiveAuthFailures = 0;
      }
      consecutiveTransientFailures = 0;
      transientCooldownUntilMs = 0;
    } catch (error) {
      if (isAuthFailureError(error)) {
        // Auth failure path
        transientCooldownUntilMs = 0;
        consecutiveTransientFailures = 0;
        consecutiveAuthFailures++;

        if (consecutiveAuthFailures >= maxAuthFailures) {
          suspended = true;
          onLog(
            `CRITICAL: typing suspended after ${consecutiveAuthFailures} consecutive auth failures. ` +
              `Credentials are likely invalid. The platform may DELETE the bot if requests continue.`,
            'critical',
          );
        } else {
          onLog(
            `typing auth failure (${consecutiveAuthFailures}/${maxAuthFailures}). Retrying with exponential backoff.`,
            'warn',
          );
        }
      } else if (isTransientError(error)) {
        // Transient error path
        consecutiveTransientFailures++;
        const retryAfter = readRetryAfterMs(error);
        const cooldownMs = retryAfter ?? computeBackoffMs(authBackoff, consecutiveTransientFailures);
        const cooldownStartedAt = now();
        transientCooldownUntilMs = cooldownStartedAt + cooldownMs;
        onLog(
          `typing transient error (${consecutiveTransientFailures}). Cooling down ${cooldownMs}ms.`,
          'warn',
        );
      } else {
        // Unknown error: reset transient state
        consecutiveTransientFailures = 0;
        transientCooldownUntilMs = 0;
      }
      throw error;
    } finally {
      if (key) {
        blockedUntilByKey.set(key, attemptedAt + minIntervalMs);
      }
    }
  };

  return {
    send,
    isSuspended: () => suspended,
    reset,
    getConsecutiveAuthFailures: () => consecutiveAuthFailures,
  };
}
