/**
 * Tests for src/fleet/http-proxy.ts
 *
 * Integration tests using a real HTTP server to verify proxy forwarding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { proxyToInstance } from '../../src/fleet/http-proxy.ts';

// ---------------------------------------------------------------------------
// Echo server — reflects request details back as JSON
// ---------------------------------------------------------------------------

let server: Server;
let port: number;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);

    // Special route: simulate slow response for timeout tests
    if (req.url === '/slow') {
      await new Promise((r) => setTimeout(r, 3_000));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Special route: simulate server error
    if (req.url === '/error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal server error' }));
      return;
    }

    // Echo route — return request details
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body || null,
    }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// proxyToInstance
// ---------------------------------------------------------------------------

describe('proxyToInstance', () => {
  it('proxies a GET request and returns the response', async () => {
    const result = await proxyToInstance(port, '/health', 'GET', null, null);
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.method).toBe('GET');
    expect(parsed.url).toBe('/health');
  });

  it('proxies a POST request with body forwarded', async () => {
    const payload = JSON.stringify({ chatJid: '123@s.whatsapp.net', text: 'hello' });
    const result = await proxyToInstance(port, '/send', 'POST', payload, null);
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.method).toBe('POST');
    expect(parsed.url).toBe('/send');
    expect(parsed.body).toBe(payload);
  });

  it('forwards the Authorization header when a token is provided', async () => {
    const token = 'test-secret-token';
    const result = await proxyToInstance(port, '/health', 'GET', null, token);
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.headers['authorization']).toBe(`Bearer ${token}`);
  });

  it('does not send Authorization header when token is null', async () => {
    const result = await proxyToInstance(port, '/health', 'GET', null, null);
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.headers['authorization']).toBeUndefined();
  });

  it('returns server error status as-is', async () => {
    const result = await proxyToInstance(port, '/error', 'GET', null, null);
    expect(result.status).toBe(500);
    const parsed = JSON.parse(result.body);
    expect(parsed.error).toBe('internal server error');
  });

  it('returns 502 on timeout', async () => {
    const result = await proxyToInstance(port, '/slow', 'GET', null, null, 100);
    expect(result.status).toBe(502);
    const parsed = JSON.parse(result.body);
    expect(parsed.error).toMatch(/proxy error/);
  });

  it('returns 502 when connection is refused', async () => {
    const result = await proxyToInstance(59999, '/health', 'GET', null, null, 1_000);
    expect(result.status).toBe(502);
    const parsed = JSON.parse(result.body);
    expect(parsed.error).toMatch(/proxy error/);
  });

  it('correctly forwards path and method', async () => {
    const result = await proxyToInstance(port, '/access', 'POST', '{}', null);
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.method).toBe('POST');
    expect(parsed.url).toBe('/access');
  });

  it('does not send body on GET even if body is provided', async () => {
    const result = await proxyToInstance(port, '/health', 'GET', '{"ignored":true}', null);
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.body).toBeNull();
  });
});
