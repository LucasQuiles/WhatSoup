/**
 * Tests for POST /poll-decision (D-4 console approval queue, instance side):
 * the health endpoint that delivers a console decision to the owning
 * runtime's poll-resolution path. Mirrors the health-mark-read harness:
 * config.ts + logger.ts mocked (off the re2 chain), real in-memory DB,
 * real HTTP against an ephemeral port.
 *
 * Design: docs/proposals/2026-07-19-approval-queue.md — the endpoint
 * NEVER writes the pending_polls row itself; it delegates to the injected
 * resolvePollDecision dep (wired to AgentRuntime.resolvePollDecisionFromConsole
 * in main.ts; absent on chat/passive → honest 503).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';

vi.mock('../../src/config.ts', () => ({
  config: {
    botName: 'test-bot',
    instanceType: 'agent',
    healthPort: 0,
    healthBindAddress: '127.0.0.1',
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { Database } from '../../src/core/database.ts';
import type { HealthDeps } from '../../src/core/health.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

const AUTH_TOKEN = 'test-token';
const AUTH_HEADER = { authorization: `Bearer ${AUTH_TOKEN}` };

function createDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeDeps(db: Database, overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    db,
    connectionManager: {
      botJid: '15551230004@s.whatsapp.net',
      botLid: null,
      getSocket: vi.fn().mockReturnValue(null),
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'WhatSoup',
    instanceType: 'agent',
    accessMode: 'allowlist',
    ...overrides,
  };
}

async function startServer(deps: HealthDeps): Promise<{ server: ReturnType<typeof import('node:http').createServer>; port: number }> {
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

function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const DECISION = { mapKey: 'agent:chat:1', questionIndex: 0, selectedOptions: ['Deploy now'] };

describe('POST /poll-decision (D-4)', () => {
  let db: Database;

  beforeEach(() => {
    process.env.WHATSOUP_HEALTH_TOKEN = AUTH_TOKEN;
    db = createDb();
  });

  afterEach(async () => {
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    db.close();
  });

  it('200 + {ok:true} when the runtime accepts the decision (dep called verbatim)', async () => {
    const resolvePollDecision = vi.fn().mockReturnValue({ ok: true });
    const { server, port } = await startServer(makeDeps(db, { resolvePollDecision }));
    const res = await post(port, '/poll-decision', JSON.stringify(DECISION), AUTH_HEADER);
    server.close();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(resolvePollDecision).toHaveBeenCalledWith(DECISION);
  });

  it('401 without a valid bearer token', async () => {
    const resolvePollDecision = vi.fn();
    const { server, port } = await startServer(makeDeps(db, { resolvePollDecision }));
    const res = await post(port, '/poll-decision', JSON.stringify(DECISION));
    server.close();
    expect(res.status).toBe(401);
    expect(resolvePollDecision).not.toHaveBeenCalled();
  });

  it('400 on a malformed body (missing selectedOptions)', async () => {
    const resolvePollDecision = vi.fn();
    const { server, port } = await startServer(makeDeps(db, { resolvePollDecision }));
    const res = await post(port, '/poll-decision', JSON.stringify({ mapKey: 'x', questionIndex: 0 }), AUTH_HEADER);
    server.close();
    expect(res.status).toBe(400);
    expect(resolvePollDecision).not.toHaveBeenCalled();
  });

  it('maps runtime verdicts: 404 not_found / 409 stale / 400 invalid', async () => {
    for (const [code, expected] of [['not_found', 404], ['stale', 409], ['invalid', 400]] as const) {
      const resolvePollDecision = vi.fn().mockReturnValue({ ok: false, error: `e-${code}`, code });
      const { server, port } = await startServer(makeDeps(db, { resolvePollDecision }));
      const res = await post(port, '/poll-decision', JSON.stringify(DECISION), AUTH_HEADER);
      server.close();
      expect(res.status).toBe(expected);
      expect(JSON.parse(res.body).ok).toBe(false);
    }
  });

  it('503 honestly when the runtime has no poll machinery (chat/passive — no callback wired)', async () => {
    const { server, port } = await startServer(makeDeps(db)); // no resolvePollDecision
    const res = await post(port, '/poll-decision', JSON.stringify(DECISION), AUTH_HEADER);
    server.close();
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/does not accept poll decisions/);
  });
});
