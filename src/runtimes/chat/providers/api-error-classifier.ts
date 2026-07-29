/**
 * Classifies LLM API errors into structured categories for logging and alerting.
 * Also provides a shared handler for provider catch blocks.
 */
import type { Logger } from 'pino';
import { WhatSoupError as AppError } from '../../../errors.ts';
export type ApiErrorType = 'auth' | 'rate_limit' | 'bad_request' | 'timeout' | 'server' | 'network' | 'unknown';

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
 *  - 400, 413 → 'bad_request'
 *  - 401, 403 → 'auth'
 *  - 429 → 'rate_limit'
 *  - 408 / AbortError → 'timeout'
 *  - 5xx (incl. 529 overloaded) → 'server'
 *  - ECONNREFUSED, ENOTFOUND → 'network'
 *  - else → 'unknown'
 */
export function classifyApiError(error: unknown): ApiErrorType {
  const statusCode = extractStatusCode(error);

  // 400 invalid_request_error / 413 request_too_large — both non-retryable
  // client errors with a malformed/oversized payload.
  if (statusCode === 400 || statusCode === 413) return 'bad_request';
  if (statusCode === 401 || statusCode === 403) return 'auth';
  if (statusCode === 429) return 'rate_limit';
  if (statusCode === 408) return 'timeout';
  // 5xx covers Anthropic 500 api_error and 529 overloaded_error (both retryable).
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) return 'server';

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
    { errorType, statusCode, provider: providerName, model, elapsed_ms },
    'llm_api_error',
  );
  if (errorType === 'bad_request') {
    throw new AppError(`${providerName} bad request (malformed payload)`, 'LLM_BAD_REQUEST', err);
  }
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
