import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import {
  extractStatusCode,
  classifyApiError,
  handleApiError,
} from '../../../../src/runtimes/chat/providers/api-error-classifier.ts';
import { WhatSoupError } from '../../../../src/errors.ts';

function makeStatusError(status: number): Error & { status: number } {
  const err = new Error(`http ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

function makeErrnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`errno ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function makeLogger(): Logger {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: () => makeLogger(),
  } as unknown as Logger;
}

describe('extractStatusCode', () => {
  it('returns numeric status from error.status', () => {
    expect(extractStatusCode(makeStatusError(401))).toBe(401);
    expect(extractStatusCode(makeStatusError(429))).toBe(429);
  });

  it('returns undefined when error has no status field', () => {
    expect(extractStatusCode(new Error('no status'))).toBeUndefined();
  });

  it('returns undefined when status is non-numeric', () => {
    const err = new Error('bad') as Error & { status: string };
    err.status = '500';
    expect(extractStatusCode(err)).toBeUndefined();
  });

  it('returns undefined for null, undefined, and primitives', () => {
    expect(extractStatusCode(null)).toBeUndefined();
    expect(extractStatusCode(undefined)).toBeUndefined();
    expect(extractStatusCode('error')).toBeUndefined();
    expect(extractStatusCode(42)).toBeUndefined();
  });
});

describe('classifyApiError', () => {
  it.each([
    { status: 400, expected: 'bad_request' as const },
    { status: 413, expected: 'bad_request' as const }, // request_too_large
    { status: 401, expected: 'auth' as const },
    { status: 403, expected: 'auth' as const },
    { status: 408, expected: 'timeout' as const },
    { status: 429, expected: 'rate_limit' as const },
    { status: 500, expected: 'server' as const },
    { status: 502, expected: 'server' as const },
    { status: 503, expected: 'server' as const },
    { status: 504, expected: 'server' as const },
    { status: 529, expected: 'server' as const }, // overloaded_error
  ])('maps HTTP $status to $expected', ({ status, expected }) => {
    expect(classifyApiError(makeStatusError(status))).toBe(expected);
  });

  it('returns "unknown" for unrecognized HTTP status codes', () => {
    expect(classifyApiError(makeStatusError(418))).toBe('unknown');
  });

  it('classifies AbortError name as timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyApiError(err)).toBe('timeout');
  });

  it('classifies ECONNREFUSED and ENOTFOUND as network', () => {
    expect(classifyApiError(makeErrnoError('ECONNREFUSED'))).toBe('network');
    expect(classifyApiError(makeErrnoError('ENOTFOUND'))).toBe('network');
  });

  it('classifies wrapped cause with ECONNREFUSED as network', () => {
    const cause = makeErrnoError('ECONNREFUSED');
    const wrapper = new Error('fetch failed', { cause });
    expect(classifyApiError(wrapper)).toBe('network');
  });

  it('returns "unknown" when cause exists but does not match a known errno', () => {
    const cause = makeErrnoError('EOTHER');
    const wrapper = new Error('fetch failed', { cause });
    expect(classifyApiError(wrapper)).toBe('unknown');
  });

  it('returns "unknown" for a plain Error with no recognized signals', () => {
    expect(classifyApiError(new Error('mystery'))).toBe('unknown');
  });

  it('returns "unknown" for null, undefined, and primitives', () => {
    expect(classifyApiError(null)).toBe('unknown');
    expect(classifyApiError(undefined)).toBe('unknown');
    expect(classifyApiError('string')).toBe('unknown');
  });
});

describe('handleApiError', () => {
  it.each([
    { status: 400, code: 'LLM_BAD_REQUEST', message: 'bad request (malformed payload)' },
    { status: 401, code: 'LLM_AUTH_ERROR', message: 'auth failed' },
    { status: 403, code: 'LLM_AUTH_ERROR', message: 'auth failed' },
    { status: 408, code: 'LLM_TIMEOUT', message: 'timed out' },
    { status: 429, code: 'LLM_RATE_LIMITED', message: 'rate limited' },
    { status: 500, code: 'LLM_UNAVAILABLE', message: 'request failed' },
  ])('throws WhatSoupError $code for HTTP $status', ({ status, code, message }) => {
    const logger = makeLogger();
    expect(() => handleApiError(makeStatusError(status), 'provider', 'model-x', Date.now(), logger))
      .toThrowError(WhatSoupError);
    let captured: WhatSoupError | undefined;
    try {
      handleApiError(makeStatusError(status), 'provider', 'model-x', Date.now(), logger);
    } catch (e) {
      captured = e as WhatSoupError;
    }
    expect(captured).toBeDefined();
    expect(captured!.code).toBe(code);
    expect(captured!.message).toContain(message);
  });

  it('throws LLM_UNAVAILABLE for unrecognized errors', () => {
    const logger = makeLogger();
    let captured: WhatSoupError | undefined;
    try {
      handleApiError(new Error('mystery'), 'provider', 'model-x', Date.now(), logger);
    } catch (e) {
      captured = e as WhatSoupError;
    }
    expect(captured!.code).toBe('LLM_UNAVAILABLE');
  });

  it('passes the original error into WhatSoupError cause', () => {
    const logger = makeLogger();
    const original = makeStatusError(401);
    let captured: WhatSoupError | undefined;
    try {
      handleApiError(original, 'anthropic', 'opus', Date.now(), logger);
    } catch (e) {
      captured = e as WhatSoupError;
    }
    expect((captured as unknown as { cause?: unknown }).cause).toBe(original);
  });

  it('logs the error with provider context and elapsed time before throwing', () => {
    const logger = makeLogger();
    const startMs = Date.now() - 250;
    try {
      handleApiError(makeStatusError(429), 'openai', 'gpt-x', startMs, logger);
    } catch {
      /* expected */
    }
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [meta, msg] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toBe('llm_api_error');
    expect(meta.errorType).toBe('rate_limit');
    expect(meta.statusCode).toBe(429);
    expect(meta.provider).toBe('openai');
    expect(meta.model).toBe('gpt-x');
    expect(typeof meta.elapsed_ms).toBe('number');
    expect((meta.elapsed_ms as number) >= 0).toBe(true);
    expect(meta).not.toHaveProperty('err');
  });

  it('never includes raw provider exception bytes in structured logs', () => {
    const logger = makeLogger();
    const forbidden = 'private-raw-provider-exception';
    try {
      handleApiError(new Error(forbidden), 'provider', 'model-x', Date.now(), logger);
    } catch {
      /* expected */
    }

    expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain(forbidden);
  });

  it('embeds the provider name in the thrown error message', () => {
    const logger = makeLogger();
    let captured: WhatSoupError | undefined;
    try {
      handleApiError(makeStatusError(401), 'gemini', 'flash', Date.now(), logger);
    } catch (e) {
      captured = e as WhatSoupError;
    }
    expect(captured!.message).toMatch(/^gemini auth failed/);
  });
});
