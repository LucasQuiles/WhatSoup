/**
 * Tests for src/core/health.ts
 *
 * Tests the authorization logic in POST /send and the health endpoint
 * using real HTTP servers on ephemeral ports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { request } from 'node:http';

// ---------------------------------------------------------------------------
// Mock config and logger
// ---------------------------------------------------------------------------

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['18459780919']),
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9999, // won't actually be used (tests override)
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import type { HealthDeps } from '../../src/core/health.ts';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function httpReq(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
        ...extraHeaders,
      },
    };
    const req = request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Build a real HTTP server using the health handler but on an ephemeral port.
// We do this by extracting the handler from startHealthServer and mounting it
// on a test server with port=0.
// ---------------------------------------------------------------------------

async function buildTestServer(deps: HealthDeps): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  // Import the module dynamically to get the handler
  const { startHealthServer } = await import('../../src/core/health.ts');

  return new Promise((resolve) => {
    // startHealthServer listens on config.healthPort (mocked to 9999),
    // but we need port 0. We intercept by monkey-patching the server's listen.
    const server = startHealthServer(deps);
    // The server is already listening on 9999 — close it and reopen on 0
    server.close(() => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ server, port });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeDeps(db: Database, overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    db,
    connectionManager: {
      botJid: '18455943112@s.whatsapp.net',
      botLid: null,
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    ({ server, port } = await buildTestServer(makeDeps(db)));
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 200 with healthy status when connected', async () => {
    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('healthy');
    expect(json.whatsapp.connected).toBe(true);
    expect(typeof json.uptime_seconds).toBe('number');
  });

  it('returns 503 with unhealthy status when disconnected', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null, // not connected
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      },
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    db2.close();
  });

  it('returns 404 for unknown routes', async () => {
    const { status } = await httpReq(port, '/unknown', 'GET');
    expect(status).toBe(404);
  });
});

describe('POST /send — Authorization header check', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    ({ server, port } = await buildTestServer(makeDeps(db)));
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 401 when WHATSOUP_HEALTH_TOKEN is set and Authorization header is missing', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '18459780919@s.whatsapp.net', text: 'hi' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when Bearer token does not match', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '18459780919@s.whatsapp.net', text: 'hi' });
    const { status } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer wrong-token',
    });
    expect(status).toBe(401);
  });

  it('proceeds (200) when correct Bearer token is provided', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '18459780919@s.whatsapp.net', text: 'hello' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });
    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
  });

  it('returns 401 when no WHATSOUP_HEALTH_TOKEN is set (fail-closed)', async () => {
    // WHATSOUP_HEALTH_TOKEN not set — endpoint must reject (fail-closed)
    const payload = JSON.stringify({ chatJid: '18459780919@s.whatsapp.net', text: 'hello' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 400 when chatJid or text is missing', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '18459780919@s.whatsapp.net' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).ok).toBe(false);
  });

  it('returns 400 for invalid JSON body', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const { status } = await httpReq(port, '/send', 'POST', 'not-json', {
      authorization: 'Bearer secret-token',
    });
    expect(status).toBe(400);
  });
});
