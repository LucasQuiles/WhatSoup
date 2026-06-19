/**
 * Tests for src/lib/http.ts
 *
 * Unit tests for shared HTTP utilities using mock streams.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  readBody,
  jsonResponse,
  parseRoute,
  parseQueryString,
  asyncHandler,
  extractBearer,
  requireInstance,
  parseIntParam,
} from '../../src/lib/http.ts';
import { mockReq as mockRequest, mockRes as mockResponse } from '../helpers/http-mocks.ts';
import type { PassThrough } from 'node:stream';

// ---------------------------------------------------------------------------
// readBody
// ---------------------------------------------------------------------------

describe('readBody', () => {
  it('reads a normal request body', async () => {
    const req = mockRequest({ body: 'hello world' });
    const promise = readBody(req);
    const body = await promise;
    expect(body).toBe('hello world');
  });

  it('rejects with 413 when body exceeds maxBytes', async () => {
    const req = mockRequest({ body: 'this is way too large for the limit' });
    const promise = readBody(req, 10);
    try {
      await promise;
      expect.fail('should have rejected');
    } catch (err: any) {
      expect(err.message).toBe('request body too large');
      expect(err.statusCode).toBe(413);
    }
  });

  it('resolves empty string for empty body', async () => {
    const req = mockRequest();
    const promise = readBody(req);
    const body = await promise;
    expect(body).toBe('');
  });
});

// ---------------------------------------------------------------------------
// jsonResponse
// ---------------------------------------------------------------------------

describe('jsonResponse', () => {
  it('sends JSON with correct Content-Type and status', () => {
    const res = mockResponse();
    jsonResponse(res, 200, { ok: true });
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(res._body)).toEqual({ ok: true });
  });

  it('serializes arrays', () => {
    const res = mockResponse();
    jsonResponse(res, 201, [1, 2, 3]);
    expect(JSON.parse(res._body)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// parseRoute
// ---------------------------------------------------------------------------

describe('parseRoute', () => {
  it('returns params for matching route', () => {
    const result = parseRoute('GET', '/users/42', { method: 'GET', path: /^\/users\/(?<id>\d+)$/ });
    expect(result).toEqual({ id: '42' });
  });

  it('returns empty object for route without captures', () => {
    const result = parseRoute('GET', '/health', { method: 'GET', path: /^\/health$/ });
    expect(result).toEqual({});
  });

  it('returns null for wrong method', () => {
    const result = parseRoute('POST', '/health', { method: 'GET', path: /^\/health$/ });
    expect({ result }).toEqual({ result: null });
  });

  it('returns null for non-matching path', () => {
    const result = parseRoute('GET', '/unknown', { method: 'GET', path: /^\/health$/ });
    expect({ result }).toEqual({ result: null });
  });

  it('strips query string before matching', () => {
    const result = parseRoute('GET', '/health?foo=bar', { method: 'GET', path: /^\/health$/ });
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseQueryString
// ---------------------------------------------------------------------------

describe('parseQueryString', () => {
  it('extracts query params', () => {
    const result = parseQueryString('/path?foo=bar&baz=qux');
    expect(result).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('returns empty object when no query string', () => {
    expect(parseQueryString('/path')).toEqual({});
  });

  it('returns empty object for undefined URL', () => {
    expect(parseQueryString(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parseQueryString('')).toEqual({});
  });

  it('handles URL-encoded values', () => {
    const result = parseQueryString('/path?msg=hello%20world');
    expect(result).toEqual({ msg: 'hello world' });
  });
});

// ---------------------------------------------------------------------------
// asyncHandler
// ---------------------------------------------------------------------------

describe('asyncHandler', () => {
  it('calls the wrapped function and does nothing on success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const handler = asyncHandler(fn);
    const req = mockRequest();
    const res = mockResponse();
    handler(req as any, res as any);
    expect(fn).toHaveBeenCalledWith(req, res);
    // No error response written
    expect(res._status).toBe(0);
  });

  it('returns 500 for unhandled errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const handler = asyncHandler(fn);
    const req = mockRequest();
    const res = mockResponse();
    handler(req as any, res as any);
    await vi.waitFor(() => {
      expect(res._status).toBe(500);
    });
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toEqual({ error: 'boom' });
  });

  it('uses statusCode from error when available', async () => {
    const err = Object.assign(new Error('not found'), { statusCode: 404 });
    const fn = vi.fn().mockRejectedValue(err);
    const handler = asyncHandler(fn);
    const req = mockRequest();
    const res = mockResponse();
    handler(req as any, res as any);
    await vi.waitFor(() => {
      expect(res._status).toBe(404);
    });
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: 'not found' });
  });
});

// ---------------------------------------------------------------------------
// readBody — stream error path
// ---------------------------------------------------------------------------

describe('readBody error path', () => {
  it('rejects when the request stream emits an error', async () => {
    const req = mockRequest();
    const promise = readBody(req);
    (req as unknown as PassThrough).emit('error', new Error('socket reset'));
    await expect(promise).rejects.toThrow('socket reset');
  });
});

// ---------------------------------------------------------------------------
// extractBearer
// ---------------------------------------------------------------------------

describe('extractBearer', () => {
  it('returns the credential from a Bearer authorization header', () => {
    const req = mockRequest({ headers: { authorization: 'Bearer secret-xyz' } });
    expect(extractBearer(req)).toBe('secret-xyz');
  });

  it('returns null when the authorization header is absent', () => {
    expect(extractBearer(mockRequest())).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    const req = mockRequest({ headers: { authorization: 'Basic abc123' } });
    expect(extractBearer(req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requireInstance
// ---------------------------------------------------------------------------

describe('requireInstance', () => {
  it('returns the instance when discovery finds it', () => {
    const instance = { name: 'alpha' };
    const discovery = { getInstance: () => instance } as unknown as Parameters<typeof requireInstance>[0];
    const res = mockResponse();
    expect(requireInstance(discovery, 'alpha', res)).toBe(instance);
    expect(res._status).toBe(0); // no error response written
  });

  it('writes 404 and returns null when the instance is missing', () => {
    const discovery = { getInstance: () => undefined } as unknown as Parameters<typeof requireInstance>[0];
    const res = mockResponse();
    expect(requireInstance(discovery, 'ghost', res)).toBeNull();
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: "instance 'ghost' not found" });
  });
});

// ---------------------------------------------------------------------------
// parseIntParam
// ---------------------------------------------------------------------------

describe('parseIntParam', () => {
  it('parses a valid in-bounds integer', () => {
    expect(parseIntParam({ limit: '50' }, 'limit', 10, 1, 100)).toBe(50);
  });

  it('clamps above the max', () => {
    expect(parseIntParam({ limit: '999' }, 'limit', 10, 1, 100)).toBe(100);
  });

  it('clamps below the min', () => {
    // parseInt('-5') is truthy-negative so it reaches Math.max, which clamps to min.
    expect(parseIntParam({ limit: '-5' }, 'limit', 10, 1, 100)).toBe(1);
  });

  it('falls back to the default for a missing or non-numeric value', () => {
    expect(parseIntParam({}, 'limit', 10, 1, 100)).toBe(10);
    expect(parseIntParam({ limit: 'abc' }, 'limit', 10, 1, 100)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// parseRoute & asyncHandler edges
// ---------------------------------------------------------------------------

describe('parseRoute & asyncHandler edges', () => {
  it('parseRoute treats an undefined url as an empty path', () => {
    expect(parseRoute('GET', undefined as unknown as string, { method: 'GET', path: /^\/x$/ })).toBeNull();
  });

  it('asyncHandler falls back to a generic message when the error has none', async () => {
    const fn = vi.fn().mockRejectedValue({}); // no message, no statusCode
    const handler = asyncHandler(fn);
    const res = mockResponse();
    handler(
      mockRequest() as unknown as Parameters<typeof handler>[0],
      res as unknown as Parameters<typeof handler>[1],
    );
    await vi.waitFor(() => expect(res._status).toBe(500));
    expect(JSON.parse(res._body)).toEqual({ error: 'internal error' });
  });
});
