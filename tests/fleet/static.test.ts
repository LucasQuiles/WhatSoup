/**
 * Tests for src/fleet/static.ts
 *
 * Uses a temporary dist directory to verify static file serving, SPA fallback,
 * MIME types, cache headers, and path traversal prevention.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createStaticHandler } from '../../src/fleet/static.ts';

// ---------------------------------------------------------------------------
// Test fixture: temporary dist directory
// ---------------------------------------------------------------------------

let distDir: string;
let server: Server;
let port: number;

beforeAll(async () => {
  // Create temp dist directory with test files
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-test-'));
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });

  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><body>app</body></html>',
  );
  fs.writeFileSync(
    path.join(distDir, 'assets', 'main.abc123.js'),
    'console.log("hello");',
  );
  fs.writeFileSync(
    path.join(distDir, 'assets', 'style.def456.css'),
    'body { margin: 0; }',
  );
  fs.writeFileSync(path.join(distDir, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));

  // Stand up a real HTTP server that uses the static handler
  const handler = createStaticHandler(distDir);

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!handler(req, res)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
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
  fs.rmSync(distDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchLocal(urlPath: string, method = 'GET'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, { method });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('static file handler', () => {
  it('serves existing files with correct MIME type', async () => {
    const res = await fetchLocal('/assets/main.abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/javascript; charset=utf-8',
    );
    const body = await res.text();
    expect(body).toBe('console.log("hello");');
  });

  it('serves CSS with correct MIME type', async () => {
    const res = await fetchLocal('/assets/style.def456.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('serves index.html for directory requests', async () => {
    const res = await fetchLocal('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await res.text();
    expect(body).toContain('app');
  });

  it('SPA fallback: /dashboard serves index.html', async () => {
    const res = await fetchLocal('/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await res.text();
    expect(body).toContain('app');
  });

  it('SPA fallback does NOT apply to /api/ routes', async () => {
    const res = await fetchLocal('/api/lines');
    expect(res.status).toBe(404);
  });

  it('prevents path traversal', async () => {
    const res = await fetchLocal('/../etc/passwd');
    // Should either 404 or serve index.html via SPA fallback — never serve /etc/passwd
    const body = await res.text();
    expect(body).not.toContain('root:');
  });

  it('returns 404 for missing files with extensions', async () => {
    const res = await fetchLocal('/assets/nonexistent.js');
    expect(res.status).toBe(404);
  });

  it('HEAD requests return 200 for existing files', async () => {
    const res = await fetchLocal('/favicon.ico', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/x-icon');
  });

  it('HTML files get no-cache header', async () => {
    const res = await fetchLocal('/');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('JS assets get immutable cache header', async () => {
    const res = await fetchLocal('/assets/main.abc123.js');
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('non-GET/HEAD methods return 404 (handler returns false)', async () => {
    const res = await fetchLocal('/index.html', 'POST');
    expect(res.status).toBe(404);
  });
});
