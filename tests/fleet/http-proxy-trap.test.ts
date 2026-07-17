/**
 * Tests for src/fleet/http-proxy.ts — HTTP proxy to instance health servers
 *
 * Tests proxying requests to instance health servers with timeout, auth,
 * error handling, and redirect prevention (bearer token security).
 *
 * Typecheck fix during the 2026-07-17 wave-8 land: proxyToInstance's 5th
 * parameter (healthToken: string | null) is required and was already required
 * at the wave-8 branch point a36b52e3f (not source drift) — several call
 * sites were just missing it. Appended `null` (no-token) to preserve intent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { proxyToInstance } from '../../src/fleet/http-proxy.ts';

describe('proxyToInstance HTTP traps', () => {
  let targetPort: number;
  let targetServer: ReturnType<typeof createServer>;

  beforeEach(async () => {
    targetServer = createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy' }));
      } else if (req.url === '/health' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, received: body }));
        });
      } else if (req.url === '/auth-required') {
        const auth = req.headers['authorization'];
        if (auth === 'Bearer secret-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ authenticated: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
      } else if (req.url === '/error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      } else if (req.url === '/redirect') {
        res.writeHead(301, { 'Location': 'http://evil.com/phishing' });
        res.end();
      } else if (req.url === '/not-found') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      } else if (req.url === '/forbidden') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
      } else {
        res.writeHead(400);
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        const addr = targetServer.address() as any;
        targetPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      targetServer.close(() => resolve());
    });
  });

  describe('success paths (200-299)', () => {
    it('proxies GET request and preserves 200 status', async () => {
      const result = await proxyToInstance(targetPort, '/health', 'GET', null, null);
      expect(result.status).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.status).toBe('healthy');
    });

    it('proxies POST request with JSON body', async () => {
      const body = JSON.stringify({ action: 'compact' });
      const result = await proxyToInstance(targetPort, '/health', 'POST', body, null);
      expect(result.status).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.ok).toBe(true);
      expect(parsed.received).toBe(body);
    });

    it('forwards Bearer token in Authorization header', async () => {
      const result = await proxyToInstance(targetPort, '/auth-required', 'GET', null, 'secret-token');
      expect(result.status).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.authenticated).toBe(true);
    });
  });

  describe('client errors (401, 403)', () => {
    it('returns 401 when Authorization fails', async () => {
      const result = await proxyToInstance(targetPort, '/auth-required', 'GET', null, 'bad-token');
      expect(result.status).toBe(401);
      const parsed = JSON.parse(result.body);
      expect(parsed.error).toBe('Unauthorized');
    });

    it('returns 403 Forbidden status', async () => {
      const result = await proxyToInstance(targetPort, '/forbidden', 'GET', null, null);
      expect(result.status).toBe(403);
      const parsed = JSON.parse(result.body);
      expect(parsed).toHaveProperty('error');
    });

    it('returns 404 Not Found status', async () => {
      const result = await proxyToInstance(targetPort, '/not-found', 'GET', null, null);
      expect(result.status).toBe(404);
      const parsed = JSON.parse(result.body);
      expect(parsed).toHaveProperty('error');
    });
  });

  describe('server errors (500)', () => {
    it('returns 500 Internal Server Error', async () => {
      const result = await proxyToInstance(targetPort, '/error', 'GET', null, null);
      expect(result.status).toBe(500);
      const parsed = JSON.parse(result.body);
      expect(parsed).toHaveProperty('error');
    });
  });

  describe('timeout trap', () => {
    it('times out and returns 502 on request hang', async () => {
      const slowServer = createServer((req, res) => {
        // Never respond — simulate hung request
      });
      await new Promise<void>((resolve) => {
        slowServer.listen(0, '127.0.0.1', resolve);
      });
      const addr = slowServer.address() as any;
      const result = await proxyToInstance(addr.port, '/health', 'GET', null, null, 100);
      expect(result.status).toBe(502);
      expect(result.body).toContain('error');
      slowServer.close();
    });

    it('respects custom timeout duration', async () => {
      const slowServer = createServer((req, res) => {
        // Never respond
      });
      await new Promise<void>((resolve) => {
        slowServer.listen(0, '127.0.0.1', resolve);
      });
      const addr = slowServer.address() as any;
      const start = Date.now();
      const result = await proxyToInstance(addr.port, '/health', 'GET', null, null, 200);
      const elapsed = Date.now() - start;
      expect(result.status).toBe(502);
      expect(elapsed).toBeLessThan(1000);
      slowServer.close();
    });
  });

  describe('redirect trap (security)', () => {
    it('rejects 3xx redirect to prevent bearer token leakage', async () => {
      const result = await proxyToInstance(targetPort, '/redirect', 'GET', null, 'secret-token');
      expect(result.status).toBe(502);
      expect(result.body).toContain('error');
    });
  });

  describe('connection error trap (502)', () => {
    it('returns 502 on connection refused', async () => {
      const result = await proxyToInstance(65432, '/health', 'GET', null, null);
      expect(result.status).toBe(502);
      expect(result.body).toContain('error');
    });

    it('returns 502 Bad Gateway with error message', async () => {
      const result = await proxyToInstance(65432, '/health', 'GET', null, null);
      expect(result.status).toBe(502);
      const parsed = JSON.parse(result.body);
      expect(parsed).toHaveProperty('error');
      expect(parsed.error).toContain('proxy error');
    });
  });

  describe('request body handling', () => {
    it('omits body for GET requests', async () => {
      const result = await proxyToInstance(targetPort, '/health', 'GET', 'this-should-be-ignored', null);
      expect(result.status).toBe(200);
    });

    it('includes body for POST requests', async () => {
      const body = JSON.stringify({ data: 'important' });
      const result = await proxyToInstance(targetPort, '/health', 'POST', body, null);
      expect(result.status).toBe(200);
      const parsed = JSON.parse(result.body);
      expect(parsed.received).toBe(body);
    });

    it('handles null body for POST', async () => {
      const result = await proxyToInstance(targetPort, '/health', 'POST', null, null);
      expect(result.status).toBe(200);
    });
  });

  describe('response body capture', () => {
    it('captures and returns full response body', async () => {
      const result = await proxyToInstance(targetPort, '/health', 'GET', null, null);
      expect(result.body).toContain('healthy');
    });

    it('handles large response bodies', async () => {
      const largeServer = createServer((req, res) => {
        const largeBody = 'x'.repeat(100000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: largeBody }));
      });
      await new Promise<void>((resolve) => {
        largeServer.listen(0, '127.0.0.1', resolve);
      });
      const addr = largeServer.address() as any;
      const result = await proxyToInstance(addr.port, '/health', 'GET', null, null);
      expect(result.status).toBe(200);
      expect(result.body.length).toBeGreaterThan(90000);
      largeServer.close();
    });
  });

  describe('header handling', () => {
    it('sets Content-Type header in outbound request', async () => {
      const capturingServer = createServer((req, res) => {
        expect(req.headers['content-type']).toBe('application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ received: true }));
      });
      await new Promise<void>((resolve) => {
        capturingServer.listen(0, '127.0.0.1', resolve);
      });
      const addr = capturingServer.address() as any;
      await proxyToInstance(addr.port, '/test', 'GET', null, null);
      capturingServer.close();
    });

    it('includes Bearer Authorization header when provided', async () => {
      const capturingServer = createServer((req, res) => {
        expect(req.headers['authorization']).toBe('Bearer mytoken');
        res.writeHead(200);
        res.end(JSON.stringify({ received: true }));
      });
      await new Promise<void>((resolve) => {
        capturingServer.listen(0, '127.0.0.1', resolve);
      });
      const addr = capturingServer.address() as any;
      await proxyToInstance(addr.port, '/test', 'GET', null, 'mytoken');
      capturingServer.close();
    });

    it('omits Authorization header when token is null', async () => {
      const capturingServer = createServer((req, res) => {
        expect(req.headers['authorization']).toBeUndefined();
        res.writeHead(200);
        res.end(JSON.stringify({ received: true }));
      });
      await new Promise<void>((resolve) => {
        capturingServer.listen(0, '127.0.0.1', resolve);
      });
      const addr = capturingServer.address() as any;
      await proxyToInstance(addr.port, '/test', 'GET', null, null);
      capturingServer.close();
    });
  });
});
