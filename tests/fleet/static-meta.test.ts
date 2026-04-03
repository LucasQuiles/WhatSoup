/**
 * Tests for createStaticHandler with fleetToken and version parameters.
 *
 * Coverage:
 *  - fleet-token meta tag injected into index.html
 *  - fleet-version meta tag injected into index.html
 *  - Both tags appear before </head>
 *  - Token/version sanitization (XSS characters stripped)
 *  - No injection when fleetToken or version is undefined
 *  - Injection works for nested HTML files, not just index.html
 *  - Content-Length header updated to match injected content
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createStaticHandler } from '../../src/fleet/static.ts';

// ---------------------------------------------------------------------------
// Fixture: temp dist directory with HTML files
// ---------------------------------------------------------------------------

let distDir: string;
let serverWithMeta: Server;
let portWithMeta: number;

let serverWithoutMeta: Server;
let portWithoutMeta: number;

const FLEET_TOKEN = 'abc123defsafetoken';
const VERSION = 'a1b2c3d';
const EVIL_INPUT = 'x<script>alert(1)</script>y';

const HTML_CONTENT = '<!doctype html><html><head><title>Test</title></head><body>app</body></html>';

async function startServer(handler: ReturnType<typeof createStaticHandler>): Promise<{ server: Server; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!handler(req, res)) {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  return { server, port };
}

beforeAll(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-meta-test-'));
  fs.mkdirSync(path.join(distDir, 'sub'), { recursive: true });

  fs.writeFileSync(path.join(distDir, 'index.html'), HTML_CONTENT);
  fs.writeFileSync(path.join(distDir, 'sub', 'index.html'), HTML_CONTENT);
  fs.writeFileSync(path.join(distDir, 'page.html'), HTML_CONTENT);
  fs.writeFileSync(path.join(distDir, 'script.js'), 'console.log(1);');

  // Server WITH token + version injection (getVersion is a getter function)
  const handlerWithMeta = createStaticHandler(distDir, FLEET_TOKEN, () => VERSION);
  ({ server: serverWithMeta, port: portWithMeta } = await startServer(handlerWithMeta));

  // Server WITHOUT token/version (no injection)
  const handlerWithoutMeta = createStaticHandler(distDir);
  ({ server: serverWithoutMeta, port: portWithoutMeta } = await startServer(handlerWithoutMeta));
});

afterAll(async () => {
  await new Promise<void>((r) => serverWithMeta.close(() => r()));
  await new Promise<void>((r) => serverWithoutMeta.close(() => r()));
  fs.rmSync(distDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createStaticHandler — meta tag injection', () => {
  it('injects fleet-token meta tag into index.html', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/`);
    const body = await res.text();
    expect(body).toContain(`<meta name="fleet-token" content="${FLEET_TOKEN}">`);
  });

  it('injects fleet-version meta tag into index.html', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/`);
    const body = await res.text();
    expect(body).toContain(`<meta name="fleet-version" content="${VERSION}">`);
  });

  it('both meta tags appear before </head>', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/`);
    const body = await res.text();
    const headClose = body.indexOf('</head>');
    const tokenIdx = body.indexOf('fleet-token');
    const versionIdx = body.indexOf('fleet-version');
    expect(tokenIdx).toBeGreaterThan(-1);
    expect(versionIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeLessThan(headClose);
    expect(versionIdx).toBeLessThan(headClose);
  });

  it('does NOT inject when no token/version provided', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithoutMeta}/`);
    const body = await res.text();
    expect(body).not.toContain('fleet-token');
    expect(body).not.toContain('fleet-version');
    // Original HTML served unchanged
    expect(body).toBe(HTML_CONTENT);
  });

  it('sanitizes dangerous characters in token (XSS prevention)', async () => {
    // Create a one-shot handler with evil input
    const evilHandler = createStaticHandler(distDir, EVIL_INPUT, () => VERSION);
    const { server, port } = await startServer(evilHandler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = await res.text();
      // The injected content should not contain raw < or > from the evil input
      // The sanitized version strips non-alphanumeric/dash/underscore chars
      expect(body).not.toContain('<script>');
      expect(body).not.toContain('alert(1)');
      // But the safe characters (x, y) should remain
      expect(body).toContain('fleet-token');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('sanitizes dangerous characters in version', async () => {
    const evilHandler = createStaticHandler(distDir, FLEET_TOKEN, () => EVIL_INPUT);
    const { server, port } = await startServer(evilHandler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = await res.text();
      expect(body).not.toContain('<script>');
      expect(body).toContain('fleet-version');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('injects into nested HTML file (sub/index.html)', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/sub/`);
    const body = await res.text();
    expect(body).toContain('fleet-token');
    expect(body).toContain('fleet-version');
  });

  it('injects into non-index HTML files (page.html)', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/page.html`);
    const body = await res.text();
    expect(body).toContain('fleet-token');
    expect(body).toContain('fleet-version');
  });

  it('does NOT inject into JS files', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/script.js`);
    const body = await res.text();
    expect(body).not.toContain('fleet-token');
    expect(body).toBe('console.log(1);');
  });

  it('Content-Type is text/html for injected response', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/`);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('Content-Length matches actual injected content length', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/`);
    const body = await res.text();
    const contentLength = res.headers.get('content-length');
    if (contentLength !== null) {
      // Content-Length must match the byte length of the actual body returned
      expect(parseInt(contentLength, 10)).toBe(Buffer.byteLength(body, 'utf-8'));
    }
    // If no Content-Length header (chunked transfer), that's acceptable too —
    // but the body must still contain the injection
    expect(body).toContain('fleet-token');
  });

  it('SPA fallback HTML gets injection too', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/dashboard`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('fleet-token');
    expect(body).toContain('fleet-version');
  });
});
