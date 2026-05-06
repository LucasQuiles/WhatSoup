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
    adminPhones: new Set(['15550100001']),
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
import { seedChatAliases } from '../../src/core/chats-resolver.ts';
import { createProfileRegistry } from '../../src/core/profiles.ts';
import type { HealthDeps } from '../../src/core/health.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

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
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'WhatSoup',
    instanceType: 'chat',
    accessMode: 'allowlist',
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
      } as unknown as ConnectionManager,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    db2.close();
  });

  it('returns 200 with degraded status and connection state while reconnecting', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'reconnecting',
          connected: false,
          reconnectAttempts: 3,
          reconnectPhase: 'retry',
          lastPingAt: '2026-04-05T12:00:00.000Z',
          lastPongAt: '2026-04-05T11:59:30.000Z',
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connected).toBe(false);
    expect(json.whatsapp.connection).toMatchObject({
      state: 'reconnecting',
      reconnect_attempts: 3,
      reconnect_phase: 'retry',
      last_ping_at: '2026-04-05T12:00:00.000Z',
      last_pong_at: '2026-04-05T11:59:30.000Z',
    });
    db2.close();
  });

  it('returns 404 for unknown routes', async () => {
    const { status } = await httpReq(port, '/unknown', 'GET');
    expect(status).toBe(404);
  });

  it('includes instance block with expected fields', async () => {
    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.instance).toBeDefined();
    expect(json.instance.name).toBe('WhatSoup');
    expect(json.instance.mode).toBe('chat');
    expect(json.instance.accessMode).toBe('allowlist');
  });

  it('returns instance.socketPath as null when not provided', async () => {
    const { body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(json.instance.socketPath).toBeNull();
  });

  it('returns instance.socketPath when provided in deps', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, { socketPath: '/run/whatsoup/test.sock' });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(json.instance.socketPath).toBe('/run/whatsoup/test.sock');
    db2.close();
  });

  it('returns sqlite.schema_version as a number >= 0', async () => {
    const { body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(typeof json.sqlite.schema_version).toBe('number');
    expect(json.sqlite.schema_version).toBeGreaterThanOrEqual(0);
  });
});

describe('POST /send — Authorization header check', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;
  let deps: HealthDeps;

  beforeEach(async () => {
    db = makeDb();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    deps = makeDeps(db, {
      profiles: createProfileRegistry({
        satellite: { prefix: '[SAT] ', tag: ' #satellite' },
      }),
    });
    ({ server, port } = await buildTestServer(deps));
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 401 when WHATSOUP_HEALTH_TOKEN is set and Authorization header is missing', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hi' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when Bearer token does not match', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hi' });
    const { status } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer wrong-token',
    });
    expect(status).toBe(401);
  });

  it('proceeds (200) when correct Bearer token is provided', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hello' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });
    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
  });

  it('returns 401 when no WHATSOUP_HEALTH_TOKEN is set (fail-closed)', async () => {
    // WHATSOUP_HEALTH_TOKEN not set — endpoint must reject (fail-closed)
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hello' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 400 when chatJid or text is missing', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net' });
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

  it('resolves aliases through the send pipeline before sending', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    seedChatAliases(db.raw, { ops: '15550100002@s.whatsapp.net' });
    const payload = JSON.stringify({ to: 'ops', text: 'hello alias' });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
    expect(deps.connectionManager.sendMessage).toHaveBeenCalledWith(
      '15550100002@s.whatsapp.net',
      'hello alias',
    );
  });

  it('applies a named profile before sending', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({
      chatJid: '15550100001@s.whatsapp.net',
      text: 'hello',
      profile: 'satellite',
    });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
    expect(deps.connectionManager.sendMessage).toHaveBeenCalledWith(
      '15550100001@s.whatsapp.net',
      '[SAT] hello #satellite',
    );
  });

  it('returns unknown profile without sending', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({
      chatJid: '15550100001@s.whatsapp.net',
      text: 'hello',
      profile: 'missing',
    });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body).error).toBe('unknown profile: missing');
    expect(deps.connectionManager.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects both chatJid and to without sending', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    seedChatAliases(db.raw, { ops: '15550100002@s.whatsapp.net' });
    const payload = JSON.stringify({
      chatJid: '15550100001@s.whatsapp.net',
      to: 'ops',
      text: 'hello',
    });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/mutually exclusive/);
    expect(deps.connectionManager.sendMessage).not.toHaveBeenCalled();
  });
});

describe('POST /agent/compact', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('requires the health bearer token', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand: vi.fn(),
      } as any,
    })));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', '{}');

    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('routes compact directly to the agent runtime and defaults to silent mode', async () => {
    const handleAgentCommand = vi.fn().mockResolvedValue({
      ok: true,
      command: 'compact',
      chatJid: '120363410094619161@g.us',
      silent: true,
    });
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(
      port,
      '/agent/compact',
      'POST',
      JSON.stringify({ chatJid: '120363410094619161@g.us' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      ok: true,
      command: 'compact',
      chatJid: '120363410094619161@g.us',
      silent: true,
    });
    expect(handleAgentCommand).toHaveBeenCalledWith({
      command: 'compact',
      chatJid: '120363410094619161@g.us',
      silent: true,
    });
  });

  it('allows explicit non-silent compact for operator-triggered diagnostics', async () => {
    const handleAgentCommand = vi.fn().mockResolvedValue({
      ok: true,
      command: 'compact',
      chatJid: '120363410094619161@g.us',
      silent: false,
    });
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status } = await httpReq(
      port,
      '/agent/compact',
      'POST',
      JSON.stringify({ chatJid: '120363410094619161@g.us', silent: false }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(200);
    expect(handleAgentCommand).toHaveBeenCalledWith({
      command: 'compact',
      chatJid: '120363410094619161@g.us',
      silent: false,
    });
  });

  it('rejects non-agent instances', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', '{}', {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: 'agent commands are only available on agent instances',
    });
  });

  it('maps runtime command errors to HTTP status and code', async () => {
    const err = Object.assign(new Error('agent session is not active'), {
      code: 'session_inactive',
      statusCode: 409,
    });
    const handleAgentCommand = vi.fn().mockRejectedValue(err);
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', '{}', {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: 'agent session is not active',
      code: 'session_inactive',
    });
  });

  it('validates request body types before dispatching to the runtime', async () => {
    const handleAgentCommand = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(
      port,
      '/agent/compact',
      'POST',
      JSON.stringify({ chatJid: 123 }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: 'chatJid must be a string when provided' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects non-object JSON bodies before dispatching to the runtime', async () => {
    const handleAgentCommand = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(
      port,
      '/agent/compact',
      'POST',
      'null',
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: 'request body must be a JSON object' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HEALTH_BIND_ADDRESS env var
// ---------------------------------------------------------------------------

describe('HEALTH_BIND_ADDRESS env var', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  afterEach(async () => {
    if (db) db.close();
    delete process.env.HEALTH_BIND_ADDRESS;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('defaults to 127.0.0.1 when HEALTH_BIND_ADDRESS is not set', async () => {
    delete process.env.HEALTH_BIND_ADDRESS;
    db = makeDb();
    ({ server, port } = await buildTestServer(makeDeps(db)));
    const addr = server.address();
    expect(typeof addr === 'object' && addr !== null ? addr.address : '').toBe('127.0.0.1');
  });

  it('binds to 0.0.0.0 when HEALTH_BIND_ADDRESS=0.0.0.0', async () => {
    process.env.HEALTH_BIND_ADDRESS = '0.0.0.0';
    db = makeDb();
    // Need a fresh import to pick up the env change in the closure
    const { startHealthServer } = await import('../../src/core/health.ts');
    const testServer = startHealthServer(makeDeps(db));
    server = testServer;
    // The server initially listens on config.healthPort with the env bind address.
    // Close and re-listen on port 0 to verify the bind was respected.
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
    await new Promise<void>((resolve) => {
      testServer.listen(0, '0.0.0.0', () => resolve());
    });
    const addr = testServer.address();
    expect(typeof addr === 'object' && addr !== null ? addr.address : '').toBe('0.0.0.0');
  });
});
