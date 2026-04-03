import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// We test the fleet server shell (auth gating, 404, static serving) by
// importing the low-level http utilities and rebuilding a minimal server that
// mirrors createFleetServer's request handling. This avoids needing the route
// handler modules (which may not exist yet) while still validating the wiring
// logic we care about.
// ---------------------------------------------------------------------------

import { jsonResponse, checkBearerAuth, parseRoute } from '../../src/lib/http.ts';
import { createStaticHandler } from '../../src/fleet/static.ts';
import { loadOrCreateFleetToken } from '../../src/fleet/index.ts';

const TEST_TOKEN = 'test-fleet-token-' + crypto.randomBytes(8).toString('hex');

// ---------------------------------------------------------------------------
// Minimal fleet-like server for testing
// ---------------------------------------------------------------------------

const ROUTES = [
  { method: 'GET', path: /^\/api\/lines$/, handler: 'getLines' },
  { method: 'GET', path: /^\/api\/lines\/(?<name>[^/]+)$/, handler: 'getLine' },
] as const;

function createTestServer(distDir: string) {
  const staticHandler = createStaticHandler(distDir);

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];

    if (pathname.startsWith('/api/')) {
      if (!checkBearerAuth(req, TEST_TOKEN)) {
        jsonResponse(res, 401, { error: 'unauthorized' });
        return;
      }

      for (const route of ROUTES) {
        const params = parseRoute(method, url, route);
        if (params) {
          // Stub handler: echo the matched handler name + params
          jsonResponse(res, 200, { handler: route.handler, params });
          return;
        }
      }

      jsonResponse(res, 404, { error: 'not found' });
      return;
    }

    if (!staticHandler(req, res)) {
      jsonResponse(res, 404, { error: 'not found' });
    }
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      try { jsonResponse(res, 500, { error: 'internal error' }); } catch { /* noop */ }
    });
  });

  return server;
}

// ---------------------------------------------------------------------------
// Test setup — start server on random port
// ---------------------------------------------------------------------------

let server: ReturnType<typeof createTestServer>;
let baseUrl: string;
let tmpDir: string;
let distDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-index-test-'));
  distDir = path.join(tmpDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html><body>fleet</body></html>');
  fs.writeFileSync(path.join(distDir, 'app.js'), 'console.log("ok")');

  server = createTestServer(distDir);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected address type');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet server — startup', () => {
  it('responds to requests on the listening port', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('fleet server — API auth gating', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/lines`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 with wrong token', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with malformed Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('all /api/* paths require auth, not just known routes', async () => {
    const res = await fetch(`${baseUrl}/api/unknown/path`);
    expect(res.status).toBe(401);
  });
});

describe('fleet server — API route matching', () => {
  it('returns 404 for unknown /api/ routes with valid auth', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not found');
  });

  it('matches /api/lines and dispatches to getLines handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = await res.json();
    expect(body.handler).toBe('getLines');
  });

  it('matches /api/lines/:name and extracts the name param', async () => {
    const res = await fetch(`${baseUrl}/api/lines/my-instance`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = await res.json();
    expect(body.handler).toBe('getLine');
    expect(body.params.name).toBe('my-instance');
  });

  it('does not match GET /api/lines/:name for POST method', async () => {
    const res = await fetch(`${baseUrl}/api/lines/my-instance`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('fleet server — static file serving', () => {
  it('serves index.html for root path', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('fleet');
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves static JS files', async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('console.log("ok")');
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  it('returns 404 for non-existent static files with extensions', async () => {
    const res = await fetch(`${baseUrl}/no-such-file.css`);
    // Falls through static handler, gets 404
    expect(res.status).toBe(404);
  });

  it('SPA fallback: extensionless non-API paths serve index.html', async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('fleet');
  });
});

describe('loadOrCreateFleetToken', () => {
  let tokenDir: string;
  let tokenPath: string;
  let savedEnv: string | undefined;

  beforeAll(() => {
    tokenDir = path.join(tmpDir, 'config-token-test');
    savedEnv = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tokenDir;
  });

  afterAll(() => {
    if (savedEnv === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedEnv;
    }
  });

  it('creates a new token when none exists', async () => {
    tokenPath = path.join(tokenDir, 'whatsoup', 'fleet-token');
    // Ensure no pre-existing token
    try { fs.unlinkSync(tokenPath); } catch { /* fine */ }

    const token = await loadOrCreateFleetToken();
    expect(token).toHaveLength(64); // 32 bytes hex
    expect(fs.existsSync(tokenPath)).toBe(true);
  });

  it('returns the existing token on subsequent calls', async () => {
    const first = await loadOrCreateFleetToken();
    const second = await loadOrCreateFleetToken();
    expect(first).toBe(second);
  });

  it('trims whitespace from stored token', async () => {
    tokenPath = path.join(tokenDir, 'whatsoup', 'fleet-token');
    const validToken = 'a'.repeat(64);
    fs.writeFileSync(tokenPath, `  ${validToken}  \n`, { mode: 0o600 });
    const token = await loadOrCreateFleetToken();
    expect(token).toBe(validToken);
  });
});
