/**
 * Tests for createStaticHandler token deferral behavior (Issue #316).
 *
 * When fleetToken is supplied as a function (lazy lookup), it must only be
 * invoked on HTML-serving paths — never on JS/CSS/asset/404 paths. This
 * prevents a corrupt token file from breaking the entire static handler.
 *
 * Coverage:
 *   - Throwing token function does NOT break /assets/main.js (RED before fix)
 *   - Throwing token function does NOT break 404 path
 *   - Working token function is NOT invoked for JS requests
 *   - Working token function IS invoked for HTML requests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createStaticHandler } from '../../src/fleet/static.ts';

const HTML_CONTENT = '<!doctype html><html><head><title>T</title></head><body>app</body></html>';
const JS_CONTENT = 'console.log("ok");';

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

let distDir: string;

beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-deferral-test-'));
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), HTML_CONTENT);
  fs.writeFileSync(path.join(distDir, 'assets', 'main.js'), JS_CONTENT);
});

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('createStaticHandler — token resolution deferred to HTML branch', () => {
  it('serves /assets/main.js even when token function throws (corrupt token file)', async () => {
    const throwingToken = () => {
      throw new Error('fleet-tokens.json corrupt');
    };
    const handler = createStaticHandler(distDir, throwingToken, () => 'v1');
    const { server, port } = await startServer(handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/assets/main.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('javascript');
      const body = await res.text();
      expect(body).toBe(JS_CONTENT);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('returns 404 (not 500) for missing asset when token function throws', async () => {
    const throwingToken = () => {
      throw new Error('fleet-tokens.json corrupt');
    };
    const handler = createStaticHandler(distDir, throwingToken, () => 'v1');
    const { server, port } = await startServer(handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/assets/nope.js`);
      // Path has an extension, so handler should decline; outer wrapper returns 404
      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does NOT invoke token function for JS asset requests', async () => {
    let calls = 0;
    const spyToken = () => {
      calls += 1;
      return 'tok123';
    };
    const handler = createStaticHandler(distDir, spyToken, () => 'v1');
    const { server, port } = await startServer(handler);
    try {
      await fetch(`http://127.0.0.1:${port}/assets/main.js`);
      expect(calls).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('DOES invoke token function for HTML requests (meta injection)', async () => {
    let calls = 0;
    const spyToken = () => {
      calls += 1;
      return 'tok123';
    };
    const handler = createStaticHandler(distDir, spyToken, () => 'v1');
    const { server, port } = await startServer(handler);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = await res.text();
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(body).toContain('fleet-token');
      expect(body).toContain('tok123');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
