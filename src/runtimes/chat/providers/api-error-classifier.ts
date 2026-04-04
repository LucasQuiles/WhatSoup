/**
 * Classifies LLM API errors into structured categories for logging and alerting.
 * Also provides a shared handler for provider catch blocks.
 */
import type { Logger } from 'pino';
import { WhatSoupError as AppError } from '../../../errors.ts';
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

/**
 * Shared catch-block handler for LLM provider errors.
 *
 * Logs the error with provider context and throws the appropriate AppError.
 * Never returns — always throws.
 */
export function handleApiError(
  err: unknown,
  providerName: string,
  model: string,
  startMs: number,
  logger: Logger,
): never {
  const elapsed_ms = Date.now() - startMs;
  const errorType = classifyApiError(err);
  const statusCode = extractStatusCode(err);
  logger.error(
    { errorType, statusCode, provider: providerName, model, elapsed_ms, err },
    'llm_api_error',
  );
  if (errorType === 'timeout') {
    throw new AppError(`${providerName} request timed out`, 'LLM_TIMEOUT', err);
  }
  if (errorType === 'auth') {
    throw new AppError(`${providerName} auth failed`, 'LLM_AUTH_ERROR', err);
  }
  if (errorType === 'rate_limit') {
    throw new AppError(`${providerName} rate limited`, 'LLM_RATE_LIMITED', err);
  }
  throw new AppError(`${providerName} request failed`, 'LLM_UNAVAILABLE', err);
}
