/**
 * Tests for src/lib/http.ts
 *
 * Unit tests for shared HTTP utilities using mock streams.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  readBody,
  jsonResponse,
  checkBearerAuth,
  parseRoute,
  parseQueryString,
  asyncHandler,
} from '../../src/lib/http.ts';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockRequest(headers: Record<string, string> = {}): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  (stream as any).headers = headers;
  return stream;
}

function mockResponse(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    },
    end(data?: string) {
      if (data) res._body = data;
    },
  };
  return res as any;
}

// ---------------------------------------------------------------------------
// readBody
// ---------------------------------------------------------------------------

describe('readBody', () => {
  it('reads a normal request body', async () => {
    const req = mockRequest();
    const promise = readBody(req);
    (req as unknown as PassThrough).write('hello ');
    (req as unknown as PassThrough).write('world');
    (req as unknown as PassThrough).end();
    const body = await promise;
    expect(body).toBe('hello world');
  });

  it('rejects with 413 when body exceeds maxBytes', async () => {
    const req = mockRequest();
    const promise = readBody(req, 10);
    (req as unknown as PassThrough).write('this is way too large for the limit');
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
    (req as unknown as PassThrough).end();
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
// checkBearerAuth
// ---------------------------------------------------------------------------

describe('checkBearerAuth', () => {
  it('returns true for valid Bearer token', () => {
    const req = mockRequest({ authorization: 'Bearer my-secret' });
    expect(checkBearerAuth(req, 'my-secret')).toBe(true);
  });

  it('returns false for wrong token', () => {
    const req = mockRequest({ authorization: 'Bearer wrong' });
    expect(checkBearerAuth(req, 'my-secret')).toBe(false);
  });

  it('returns false when authorization header is missing', () => {
    const req = mockRequest();
    expect(checkBearerAuth(req, 'my-secret')).toBe(false);
  });

  it('returns false for non-Bearer scheme', () => {
    const req = mockRequest({ authorization: 'Basic abc123' });
    expect(checkBearerAuth(req, 'abc123')).toBe(false);
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
    expect(result).toBeNull();
  });

  it('returns null for non-matching path', () => {
    const result = parseRoute('GET', '/unknown', { method: 'GET', path: /^\/health$/ });
    expect(result).toBeNull();
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
    await new Promise((r) => setTimeout(r, 10));
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
    await new Promise((r) => setTimeout(r, 10));
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
    await new Promise((r) => setTimeout(r, 10));
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: 'not found' });
  });
});
