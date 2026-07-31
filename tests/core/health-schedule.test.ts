/**
 * Tests for POST /schedule handler in src/core/health.ts (Sprint 5E-0).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, request } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9998,
    models: { conversation: 'claude-opus-4-5', extraction: 'claude-haiku-4-5', validation: 'claude-haiku-4-5', fallback: 'claude-sonnet-4-5' },
  },
}));
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { Database } from '../../src/core/database.ts';
import type { HealthDeps } from '../../src/core/health.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

function httpReq(port: number, path: string, method: 'POST', body?: string, extraHeaders?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}), ...extraHeaders },
    };
    const req = request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

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

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeDeps(db: Database, overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    db,
    connectionManager: {
      botJid: '15551230004@s.whatsapp.net', botLid: null,
      getSocket: vi.fn().mockReturnValue(null),
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getConnectionState: vi.fn(() => emptyConnectionStateSnapshot({
        connected: true,
        stateChangedAt: '2026-07-30T00:00:00.000Z',
        lastDisconnectReason: null,
      })),
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'WhatSoup', instanceType: 'chat', accessMode: 'allowlist',
    ...overrides,
  };
}

function countRows(db: Database): number {
  return (db.raw.prepare('SELECT COUNT(*) AS n FROM scheduled_messages').get() as { n: number }).n;
}

const AUTH_TOKEN = 'test-token';
const AUTH_HEADER = { authorization: `Bearer ${AUTH_TOKEN}` };
const CHAT = 'fixture-schedule@g.us';

describe('POST /schedule', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;
  let root: string;

  async function start(overrides: Partial<HealthDeps> = {}) {
    ({ server, port } = await buildTestServer(makeDeps(db, { scheduleAllowedRoot: root, ...overrides })));
  }

  beforeEach(() => {
    process.env.WHATSOUP_HEALTH_TOKEN = AUTH_TOKEN;
    db = makeDb();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sched-route-')));
  });
  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    rmSync(root, { recursive: true, force: true });
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('returns 401 when Authorization is missing', async () => {
    await start();
    const { status } = await httpReq(port, '/schedule', 'POST', JSON.stringify({ chatJid: CHAT, text: 'hi' }));
    expect(status).toBe(401);
    expect(countRows(db)).toBe(0);
  });

  it('enqueues a media file within the configured root and returns 200 with an id', async () => {
    await start();
    const pdf = join(root, 'issue.pdf');
    writeFileSync(pdf, Buffer.from('%PDF-1.4 test'));
    const { status, body } = await httpReq(port, '/schedule', 'POST', JSON.stringify({ chatJid: CHAT, filePath: pdf, caption: 'synopsis', mediaType: 'document' }), AUTH_HEADER);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.ok).toBe(true);
    expect(typeof json.id).toBe('number');
    expect(json.status).toBe('pending');
    expect(json.contentType).toBe('document');
    expect(countRows(db)).toBe(1);
  });

  it('defaults scheduled_at to roughly now + lead when scheduledAt is omitted', async () => {
    await start();
    const before = Math.floor(Date.now() / 1000);
    const { status, body } = await httpReq(port, '/schedule', 'POST', JSON.stringify({ chatJid: CHAT, text: 'hi' }), AUTH_HEADER);
    expect(status).toBe(200);
    const { scheduledAt } = JSON.parse(body);
    expect(scheduledAt).toBeGreaterThan(before);
    expect(scheduledAt).toBeLessThanOrEqual(before + 10);
  });

  it('returns 400 when filePath is outside the configured root and inserts nothing', async () => {
    await start();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')));
    const pdf = join(outside, 'x.pdf');
    writeFileSync(pdf, Buffer.from('%PDF-1.4'));
    const { status, body } = await httpReq(port, '/schedule', 'POST', JSON.stringify({ chatJid: CHAT, filePath: pdf }), AUTH_HEADER);
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/Path outside workspace/);
    expect(countRows(db)).toBe(0);
    rmSync(outside, { recursive: true, force: true });
  });

  it('returns 400 when chatJid is missing', async () => {
    await start();
    const { status, body } = await httpReq(port, '/schedule', 'POST', JSON.stringify({ text: 'hi' }), AUTH_HEADER);
    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/chatJid/);
  });

  it('returns 409 when the route is not configured (no scheduleAllowedRoot)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db))); // no scheduleAllowedRoot
    const { status, body } = await httpReq(port, '/schedule', 'POST', JSON.stringify({ chatJid: CHAT, text: 'hi' }), AUTH_HEADER);
    expect(status).toBe(409);
    expect(JSON.parse(body).error).toMatch(/not configured/);
    expect(countRows(db)).toBe(0);
  });
});
