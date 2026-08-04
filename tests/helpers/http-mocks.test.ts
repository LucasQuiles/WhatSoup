import { describe, expect, it, vi } from 'vitest';

import { makeDeps, mockReq, mockRes, mockSseRes } from './http-mocks.ts';
import type { FeedDeps } from '../../src/fleet/routes/feed.ts';

describe('http test helpers', () => {
  it('creates an IncomingMessage-like request with async body delivery', async () => {
    const req = mockReq({ body: 'payload', method: 'PATCH', url: '/config', headers: { authorization: 'Bearer token' } });
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('/config');
    expect(req.headers).toEqual({ authorization: 'Bearer token' });
    expect(Buffer.concat(chunks).toString()).toBe('payload');
  });

  it('captures response status, headers, and body', () => {
    const res = mockRes();

    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{"ok":true}');

    expect(res._status).toBe(201);
    expect(res._headers).toEqual({ 'content-type': 'application/json' });
    expect(res._body).toBe('{"ok":true}');
  });

  // #2869: ServerResponse is an EventEmitter; createSSEWriter (src/fleet/sse-helpers.ts)
  // attaches an 'error' listener via res.on(#2292 L7), so a mockRes without `on` is an
  // incomplete fake for any consumer that constructs an SSE writer around it.
  it('exposes a no-op .on() so an SSE writer can attach its error listener', () => {
    const res = mockRes();

    expect(() => res.on('error', () => {})).not.toThrow();
  });

  it('returns itself from .on() for chaining, matching writeHead/setHeader/end', () => {
    const res = mockRes();

    expect(res.on('error', () => {})).toBe(res);
  });

  it('accumulates chunks across multiple write() calls on mockSseRes', () => {
    const res = mockSseRes();

    res.write('data: {"a":1}\n\n');
    res.write('data: {"b":2}\n\n');

    expect(res._chunks).toEqual(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']);
  });

  it('sets _ended on mockSseRes.end()', () => {
    const res = mockSseRes();

    expect(res._ended).toBe(false);
    res.write('data: {"a":1}\n\n');
    res.end();
    expect(res._ended).toBe(true);
  });

  it('accumulates data passed to end() and marks _ended on mockSseRes', () => {
    const res = mockSseRes();

    res.write('data: {"a":1}\n\n');
    res.end('data: done\n\n');

    expect(res._chunks).toEqual(['data: {"a":1}\n\n', 'data: done\n\n']);
    expect(res._ended).toBe(true);
  });

  it('exposes a no-op .on() on mockSseRes so an SSE writer can attach its error listener', () => {
    const res = mockSseRes();

    expect(() => res.on('error', () => {})).not.toThrow();
  });

  it('returns itself from mockSseRes.on() for chaining', () => {
    const res = mockSseRes();

    expect(res.on('error', () => {})).toBe(res);
  });

  it('builds common fleet route deps with override support', () => {
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => new Map([['line-a', { name: 'line-a' }]])) },
    });

    expect(deps.discovery.getInstance('missing')).toBeUndefined();
    expect(Array.from(deps.discovery.getInstances().keys())).toEqual(['line-a']);
    expect(deps.realtime.publish).not.toHaveBeenCalled();
    expect(deps.serviceManager.restart).not.toHaveBeenCalled();
  });

  it('keeps base helpers available when typed with a route dependency shape', () => {
    const deps = makeDeps<FeedDeps>({
      healthPoller: { getStatus: vi.fn(() => undefined) } as unknown as FeedDeps['healthPoller'],
      dbReader: {
        getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
        getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
      } as unknown as FeedDeps['dbReader'],
    });

    expect(deps.discovery.getInstance('missing')).toBeUndefined();
    expect(deps.healthPoller.getStatus('line-a')).toBeUndefined();
    expect(deps.dbReader.getMessagesByIds('line-a', '/tmp/test.db', [])).toEqual({ ok: true, data: [] });
    expect(deps.realtime.publish).not.toHaveBeenCalled();
  });

  it('makeDeps discovery.scan defaults to an empty Map', () => {
    const deps = makeDeps();
    expect(deps.discovery.scan()).toBeInstanceOf(Map);
    expect(deps.discovery.scan().size).toBe(0);
  });

  it('makeDeps serviceManager.startFire auto-invokes the completion callback with null error', () => {
    const deps = makeDeps();
    const cb = vi.fn();
    deps.serviceManager.startFire('service-a', cb);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('makeDeps serviceManager.startFire tolerates no completion callback', () => {
    const deps = makeDeps();
    expect(() => deps.serviceManager.startFire('service-a')).not.toThrow();
  });
});
