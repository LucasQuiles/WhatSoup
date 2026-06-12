/**
 * Tests for createStaticHandler metadata injection (B1 closure).
 *
 * Coverage:
 *  - fleet-version and fleet-auth-mode meta tags injected into HTML
 *  - SECURITY PIN: served HTML never contains a fleet-token meta tag — the
 *    root token must not appear in unauthenticated responses (the console
 *    unlocks via POST /api/console-session instead)
 *  - Version sanitization (XSS characters stripped)
 *  - No injection when version is unavailable or the getter throws
 *  - Injection works for nested HTML files and the SPA fallback
 *  - Content-Length header matches injected content
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createStaticHandler } from '../../src/fleet/static.ts';

let distDir: string;
let serverWithMeta: Server;
let portWithMeta: number;

let serverWithoutMeta: Server;
let portWithoutMeta: number;

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

  const handlerWithMeta = createStaticHandler(distDir, () => VERSION);
  ({ server: serverWithMeta, port: portWithMeta } = await startServer(handlerWithMeta));

  const handlerWithoutMeta = createStaticHandler(distDir);
  ({ server: serverWithoutMeta, port: portWithoutMeta } = await startServer(handlerWithoutMeta));
});

afterAll(async () => {
  await new Promise<void>((r) => serverWithMeta.close(() => r()));
  await new Promise<void>((r) => serverWithoutMeta.close(() => r()));
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('createStaticHandler — metadata injection (no secrets)', () => {
  it('injects fleet-version and fleet-auth-mode meta tags before </head>', async () => {
    const body = await fetch(`http://127.0.0.1:${portWithMeta}/`).then((r) => r.text());
    const headClose = body.indexOf('</head>');
    expect(body).toContain(`<meta name="fleet-version" content="${VERSION}">`);
    expect(body).toContain('<meta name="fleet-auth-mode" content="session">');
    expect(body.indexOf('fleet-version')).toBeLessThan(headClose);
    expect(body.indexOf('fleet-auth-mode')).toBeLessThan(headClose);
  });

  it('SECURITY: never serves a fleet-token meta tag in any HTML path', async () => {
    for (const p of ['/', '/sub/', '/page.html', '/dashboard']) {
      const body = await fetch(`http://127.0.0.1:${portWithMeta}${p}`).then((r) => r.text());
      expect(body).not.toContain('fleet-token');
    }
  });

  it('does NOT inject when no version getter is provided', async () => {
    const body = await fetch(`http://127.0.0.1:${portWithoutMeta}/`).then((r) => r.text());
    expect(body).not.toContain('fleet-version');
    expect(body).not.toContain('fleet-auth-mode');
    expect(body).toBe(HTML_CONTENT);
  });

  it('serves HTML without metadata when the version getter throws', async () => {
    const { server, port } = await startServer(
      createStaticHandler(distDir, () => { throw new Error('boom'); }),
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(HTML_CONTENT);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('sanitizes dangerous characters in version (XSS prevention)', async () => {
    const { server, port } = await startServer(createStaticHandler(distDir, () => EVIL_INPUT));
    try {
      const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
      expect(body).not.toContain('<script>');
      expect(body).not.toContain('alert(1)');
      expect(body).toContain('fleet-version');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('injects into nested HTML file (sub/index.html)', async () => {
    const body = await fetch(`http://127.0.0.1:${portWithMeta}/sub/`).then((r) => r.text());
    expect(body).toContain('fleet-version');
  });

  it('injects into non-index HTML files (page.html)', async () => {
    const body = await fetch(`http://127.0.0.1:${portWithMeta}/page.html`).then((r) => r.text());
    expect(body).toContain('fleet-version');
  });

  it('does NOT inject into JS files', async () => {
    const body = await fetch(`http://127.0.0.1:${portWithMeta}/script.js`).then((r) => r.text());
    expect(body).not.toContain('fleet-version');
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
      expect(parseInt(contentLength, 10)).toBe(Buffer.byteLength(body, 'utf-8'));
    }
    expect(body).toContain('fleet-version');
  });

  it('SPA fallback HTML gets metadata too', async () => {
    const res = await fetch(`http://127.0.0.1:${portWithMeta}/dashboard`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('fleet-version');
    expect(body).toContain('fleet-auth-mode');
  });
});
