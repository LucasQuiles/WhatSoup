import { describe, expect, it, vi } from 'vitest';

import { makeDeps, mockReq, mockRes } from './http-mocks.ts';

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

  it('builds common fleet route deps with override support', () => {
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => new Map([['line-a', { name: 'line-a' }]])) },
    });

    expect(deps.discovery.getInstance('missing')).toBeUndefined();
    expect(Array.from(deps.discovery.getInstances().keys())).toEqual(['line-a']);
    expect(deps.realtime.publish).not.toHaveBeenCalled();
    expect(deps.serviceManager.restart).not.toHaveBeenCalled();
  });
});
