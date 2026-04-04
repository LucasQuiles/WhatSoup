/**
 * Classifies LLM API errors into structured categories for logging and alerting.
 */
export type ApiErrorType = 'auth' | 'rate_limit' | 'timeout' | 'server' | 'network' | 'unknown';

/**
 * Extract HTTP status code from an API SDK error, if present.
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (error != null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/**
 * Classify an API error into a structured category.
 *
 * Checks:
 *  - 401 → 'auth'
 *  - 429 → 'rate_limit'
 *  - 408 / AbortError → 'timeout'
 *  - 500, 502, 503 → 'server'
 *  - ECONNREFUSED, ENOTFOUND → 'network'
 *  - else → 'unknown'
 */
export function classifyApiError(error: unknown): ApiErrorType {
  const statusCode = extractStatusCode(error);

  if (statusCode === 401) return 'auth';
  if (statusCode === 429) return 'rate_limit';
  if (statusCode === 408) return 'timeout';
  if (statusCode !== undefined && (statusCode === 500 || statusCode === 502 || statusCode === 503)) return 'server';

  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'timeout';
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'network';
    // Some SDK errors embed the cause
    if ('cause' in error && error.cause instanceof Error) {
      const causeCode = (error.cause as NodeJS.ErrnoException).code;
      if (causeCode === 'ECONNREFUSED' || causeCode === 'ENOTFOUND') return 'network';
    }
  }

  return 'unknown';
}
