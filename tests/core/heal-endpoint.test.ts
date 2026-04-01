/**
 * Tests for POST /heal in src/core/health.ts
 *
 * Validates: auth, body validation, deduplication, errorClass normalization,
 * and runtime dispatch via a real HTTP server on an ephemeral port.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { request } from 'node:http';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9999,
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
import type { Runtime } from '../../src/runtimes/types.ts';

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
// Test server builder
// ---------------------------------------------------------------------------

async function buildTestServer(deps: HealthDeps): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const { startHealthServer } = await import('../../src/core/health.ts');
  return new Promise((resolve) => {
    const server = startHealthServer(deps);
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

function makeRuntime(handleControlTurn?: (...args: unknown[]) => Promise<void>): Partial<Runtime> {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setDurability: vi.fn(),
    handleControlTurn: handleControlTurn ?? vi.fn().mockResolvedValue(undefined),
  };
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
    } as any,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — POST /heal
// ---------------------------------------------------------------------------

describe('POST /heal', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;
  const TOKEN = 'test-heal-token';

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = TOKEN;
    ({ server, port } = await buildTestServer(makeDeps(db, { runtime: makeRuntime() as Runtime })));
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── 7.2.1  valid request ────────────────────────────────────────────────

  it('returns 202 with reportId and errorClass for a valid request', async () => {
    const payload = JSON.stringify({
      type: 'service_crash',
      errorHint: 'ECONNREFUSED at 127.0.0.1:3000',
    });
    const { status, body } = await httpReq(port, '/heal', 'POST', payload, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(202);
    const json = JSON.parse(body) as { reportId: string; errorClass: string };
    expect(typeof json.reportId).toBe('string');
    expect(json.reportId.length).toBeGreaterThan(0);
    expect(typeof json.errorClass).toBe('string');
    expect(json.errorClass.startsWith('service_crash__')).toBe(true);
  });

  // ── 7.2.2  auth — missing header ────────────────────────────────────────

  it('returns 401 when Authorization header is absent', async () => {
    const payload = JSON.stringify({ type: 'service_crash' });
    const { status, body } = await httpReq(port, '/heal', 'POST', payload);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'unauthorized' });
  });

  // ── 7.2.3  auth — wrong token ───────────────────────────────────────────

  it('returns 401 when Bearer token is incorrect', async () => {
    const payload = JSON.stringify({ type: 'service_crash' });
    const { status, body } = await httpReq(port, '/heal', 'POST', payload, {
      authorization: 'Bearer wrong-token',
    });
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'unauthorized' });
  });

  // ── 7.2.4  dedupe ────────────────────────────────────────────────────────

  it('returns 409 with existingReportId when same error_class already pending', async () => {
    const payload = JSON.stringify({
      type: 'service_crash',
      errorHint: 'SomeError: connection refused',
    });
    const auth = { authorization: `Bearer ${TOKEN}` };

    // First request: should succeed
    const first = await httpReq(port, '/heal', 'POST', payload, auth);
    expect(first.status).toBe(202);
    const firstJson = JSON.parse(first.body) as { reportId: string; errorClass: string };

    // Second request with the same type+hint: should be rejected as duplicate
    const second = await httpReq(port, '/heal', 'POST', payload, auth);
    expect(second.status).toBe(409);
    const secondJson = JSON.parse(second.body) as { error: string; existingReportId: string };
    expect(secondJson.error).toBe('duplicate');
    expect(secondJson.existingReportId).toBe(firstJson.reportId);
  });

  // ── 7.2.5  missing type field ────────────────────────────────────────────

  it('returns 400 when "type" field is missing', async () => {
    const payload = JSON.stringify({ errorHint: 'something broke' });
    const { status, body } = await httpReq(port, '/heal', 'POST', payload, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ error: 'missing type field' });
  });

  // ── 7.2.6  errorClass is server-computed ────────────────────────────────

  it('computes errorClass server-side regardless of body content', async () => {
    const payload = JSON.stringify({
      type: 'crash',
      errorHint: 'TypeError: cannot read property of undefined',
      errorClass: 'attacker_supplied_class',  // should be ignored
    });
    const { status, body } = await httpReq(port, '/heal', 'POST', payload, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(202);
    const json = JSON.parse(body) as { reportId: string; errorClass: string };
    // errorClass must be computed from type + errorHint, not the body field
    expect(json.errorClass).not.toBe('attacker_supplied_class');
    expect(json.errorClass.startsWith('crash__')).toBe(true);
  });

  // ── 7.2.7  invalid JSON ──────────────────────────────────────────────────

  it('returns 400 for malformed JSON body', async () => {
    const { status, body } = await httpReq(port, '/heal', 'POST', 'not-json', {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ error: 'invalid JSON' });
  });

  // ── 7.2.8  runtime dispatch ──────────────────────────────────────────────

  it('calls handleControlTurn on the runtime when present', async () => {
    const handleControlTurn = vi.fn().mockResolvedValue(undefined);
    const runtime = makeRuntime(handleControlTurn) as Runtime;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(makeDb(), { runtime })));

    const payload = JSON.stringify({ type: 'service_crash', errorHint: 'test crash' });
    const { status } = await httpReq(port, '/heal', 'POST', payload, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(status).toBe(202);
    expect(handleControlTurn).toHaveBeenCalledOnce();
    const [callReportId, callPayload] = handleControlTurn.mock.calls[0] as [string, string];
    expect(typeof callReportId).toBe('string');
    const parsedPayload = JSON.parse(callPayload) as { errorClass: string };
    expect(parsedPayload.errorClass.startsWith('service_crash__')).toBe(true);
  });
});
