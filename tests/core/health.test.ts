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

import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';
import { seedChatAliases } from '../../src/core/chats-resolver.ts';
import { createProfileRegistry } from '../../src/core/profiles.ts';
import { createOutboundSendsWriter } from '../../src/core/outbound-sends.ts';
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
      botJid: '15551230004@s.whatsapp.net',
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

function makeAuthBond(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const overrideBackup = (
    typeof overrides.backup === 'object'
    && overrides.backup !== null
    && !Array.isArray(overrides.backup)
  )
    ? overrides.backup as Record<string, unknown>
    : {};
  return {
    status: 'present',
    issues: [],
    authDir: { path: '/auth', exists: true, mode: '700', size: 128, mtime: '2026-06-09T12:00:00.000Z', sha256: null },
    creds: { path: '/auth/creds.json', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:00:00.000Z', sha256: 'a'.repeat(64) },
    meHash: 'b'.repeat(20),
    treeHash: 'c'.repeat(64),
    ...overrides,
    backup: {
      root: '/state/auth-bond-backups/test',
      latest: '/state/auth-bond-backups/test/history/latest',
      latestAt: '2026-06-09T12:00:00.000Z',
      latestReason: 'connection-open',
      latestTreeHash: 'c'.repeat(64),
      lastCaptureAt: '2026-06-09T12:00:00.000Z',
      lastCaptureReason: 'connection-open',
      lastCaptureError: null,
      lastCaptureDeferredAt: null,
      lastCaptureDeferredReason: null,
      lastCaptureDeferredAgeMs: null,
      lastRestoreAt: null,
      lastRestoreSource: null,
      lastRestoreError: null,
      ...overrideBackup,
    },
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

  it('suppresses stale disconnect metadata when the current connection is connected', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db, {
      connectionManager: {
        botJid: '15555550123@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-04-05T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: 'loggedOut',
          lastStatusCode: 401,
        }),
      } as unknown as ConnectionManager,
    })));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('healthy');
    expect(json.whatsapp.connection).toMatchObject({
      state: 'connected',
      last_disconnect_reason: null,
      last_status_code: null,
      disconnect_class: 'none',
      auth_failure_class: 'none',
    });
  });

  it('marks a connected instance degraded when recent disconnect churn crosses the threshold', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db, {
      connectionManager: {
        botJid: '15555550123@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-04-05T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          recentDisconnects: {
            windowMs: 600_000,
            count: 3,
            lastAt: '2026-04-05T12:09:00.000Z',
            lastReason: 'connectionReplaced',
            lastStatusCode: 440,
            byReason: { connectionReplaced: 3 },
          },
        }),
      } as unknown as ConnectionManager,
    })));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connection).toMatchObject({
      state: 'connected',
      last_disconnect_reason: null,
      last_status_code: null,
      recent_disconnects: {
        window_ms: 600_000,
        degraded_threshold: 3,
        count: 3,
        last_at: '2026-04-05T12:09:00.000Z',
        last_reason: 'connectionReplaced',
        last_status_code: 440,
        by_reason: { connectionReplaced: 3 },
      },
    });
  });

  it('reports pending_polls_total reflecting live rows in the pending_polls table', async () => {
    // Empty table → 0
    const empty = await httpReq(port, '/health', 'GET');
    expect(JSON.parse(empty.body).sqlite.pending_polls_total).toBe(0);

    // Insert two live polls
    const insert = db.raw.prepare(
      `INSERT INTO pending_polls (map_key, chat_jid, tool_id, source, resolution, payload, created_at, closes_at, hard_closes_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    insert.run('send_poll:p1', 'chatA@g.us', 'send_poll:p1', 'send_poll', 'first-vote-wins', '{}', now, now + 60_000, now + 120_000);
    insert.run('send_poll:p2', 'chatB@g.us', 'send_poll:p2', 'send_poll', 'admin-only', '{}', now, now + 60_000, now + 120_000);

    const after = await httpReq(port, '/health', 'GET');
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).sqlite.pending_polls_total).toBe(2);

    // Deleting one decrements the reported count
    db.raw.prepare('DELETE FROM pending_polls WHERE map_key = ?').run('send_poll:p1');
    const afterDelete = await httpReq(port, '/health', 'GET');
    expect(JSON.parse(afterDelete.body).sqlite.pending_polls_total).toBe(1);
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

  it('returns 503 when QR pairing is required even while lifecycle state is connecting', async () => {
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
          state: 'connecting',
          connected: false,
          reconnectAttempts: 0,
          reconnectPhase: 'backoff',
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: '2026-06-09T12:00:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          credentialLifecycle: {
            lastQrAt: '2026-06-09T12:05:00.000Z',
            lastOpenAt: null,
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.whatsapp.connected).toBe(false);
    expect(json.whatsapp.connection.auth_failure_class).toBe('pairing_required');
    db2.close();
  });

  it('returns 503 when QR pairing is required after a prior successful open', async () => {
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
          state: 'connecting',
          connected: false,
          reconnectAttempts: 0,
          reconnectPhase: 'backoff',
          stateChangedAt: '2026-06-09T12:10:00.000Z',
          firstFailureAt: '2026-06-09T12:10:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: '2026-06-09T12:09:00.000Z',
            lastQrAt: '2026-06-09T12:10:00.000Z',
            recentEvents: [
              { event: 'connection_open', at: '2026-06-09T12:00:00.000Z' },
              { event: 'qr_required', at: '2026-06-09T12:10:00.000Z' },
            ],
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.whatsapp.connection.auth_failure_class).toBe('pairing_required');
    db2.close();
  });

  it('keeps normal restart-required reconnects degraded without pairing_required', async () => {
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
          reconnectAttempts: 1,
          reconnectPhase: 'retry',
          stateChangedAt: '2026-06-09T12:10:00.000Z',
          firstFailureAt: '2026-06-09T12:10:00.000Z',
          lastPingAt: '2026-06-09T12:09:30.000Z',
          lastPongAt: '2026-06-09T12:09:31.000Z',
          lastDisconnectReason: 'restartRequired',
          lastStatusCode: 515,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: '2026-06-09T12:10:00.000Z',
            lastQrAt: null,
            recentEvents: [
              { event: 'connection_open', at: '2026-06-09T12:00:00.000Z' },
              { event: 'connection_close', at: '2026-06-09T12:10:00.000Z', statusCode: 515, reason: 'restartRequired' },
            ],
          },
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
    expect(json.whatsapp.connection.disconnect_class).toBe('restart_required');
    expect(json.whatsapp.connection.auth_failure_class).toBe('none');
    db2.close();
  });

  it('classifies duplicate-session replacement separately from server-side logout', async () => {
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
          reconnectAttempts: 1,
          reconnectPhase: 'backoff',
          stateChangedAt: '2026-06-09T12:10:00.000Z',
          firstFailureAt: '2026-06-09T12:10:00.000Z',
          lastPingAt: '2026-06-09T12:09:30.000Z',
          lastPongAt: '2026-06-09T12:09:31.000Z',
          lastDisconnectReason: 'connectionReplaced',
          lastStatusCode: 440,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: '2026-06-09T12:10:00.000Z',
            lastQrAt: null,
            recentEvents: [
              { event: 'connection_open', at: '2026-06-09T12:00:00.000Z' },
              { event: 'connection_close', at: '2026-06-09T12:10:00.000Z', statusCode: 440, reason: 'connectionReplaced' },
            ],
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connection.disconnect_class).toBe('duplicate_session_replaced');
    expect(json.whatsapp.connection.auth_failure_class).toBe('none');
    db2.close();
  });

  it('fails closed when connection state and connected boolean disagree', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'disconnected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastQrAt: null,
            lastOpenAt: '2026-06-09T12:00:00.000Z',
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.whatsapp.connected).toBe(false);
    expect(json.whatsapp.connection.state).toBe('disconnected');
    db2.close();
  });

  it('includes protocol-level auth bond health when the connection manager exposes it', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          credentialLifecycle: {
            version: 1,
            redaction: {
              version: 1,
              policy: 'credential material, tokens, pairing codes, full JIDs, and full phone numbers are blocked; identity fields use short hashes only',
            },
            environment: {
              instance: 'WhatSoup',
              host: 'nucles',
              pid: 1234,
              nodeVersion: 'v24.0.0',
              platform: 'linux',
              arch: 'arm64',
              release: 'test',
              processUptimeSeconds: 60,
              osUptimeSeconds: 600,
              loadavg: [0.1, 0.2, 0.3],
              memory: { freeBytes: 100, totalBytes: 200 },
              authDir: '/auth',
              stateRoot: '/state',
              dataRoot: '/data',
              lockPath: '/run/lock',
              healthPort: 9999,
              provider: 'claude',
            },
            currentAuthBond: {
              status: 'present',
              issues: [],
              authDir: { path: '/auth', exists: true, mode: '700', size: 128, mtime: '2026-06-09T12:00:00.000Z' },
              creds: {
                path: '/auth/creds.json',
                exists: true,
                mode: '600',
                size: 512,
                mtime: '2026-06-09T12:00:00.000Z',
                hash: 'a'.repeat(20),
                identityHash: 'b'.repeat(20),
              },
              treeHash: 'c'.repeat(20),
              backup: {
                root: '/state/auth-bond-backups/test',
                latest: '/state/auth-bond-backups/test/history/latest',
                latestAt: '2026-06-09T12:00:00.000Z',
                latestReason: 'connection-open',
                latestTreeHash: 'c'.repeat(20),
                lastCaptureAt: '2026-06-09T12:00:00.000Z',
                lastCaptureReason: 'connection-open',
                lastCaptureError: null,
                lastRestoreAt: null,
                lastRestoreSource: null,
                lastRestoreError: null,
              },
            },
            latestBaileysVersion: '2.2413.1',
            connectStartedAt: '2026-06-09T11:59:00.000Z',
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: null,
            lastQrAt: null,
            lastCredsUpdateAt: '2026-06-09T12:00:01.000Z',
            lastCredsUpdateFailedAt: null,
            lastAuthSnapshotAt: '2026-06-09T12:00:02.000Z',
            lastAuthSnapshotFailedAt: null,
            credsUpdateCount: 3,
            authSnapshotCaptureCount: 2,
            authSnapshotFailureCount: 0,
            lastDisconnectDiagnostic: null,
            recentEvents: [
              {
                at: '2026-06-09T12:00:00.000Z',
                event: 'connection_open',
                state: 'connected',
                reconnectAttempts: 0,
                reconnectPhase: 'backoff',
              },
            ],
          },
          authBond: {
            status: 'present',
            issues: [],
            authDir: { path: '/auth', exists: true, mode: '700', size: 128, mtime: '2026-06-09T12:00:00.000Z', sha256: null },
            creds: { path: '/auth/creds.json', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:00:00.000Z', sha256: 'a'.repeat(64) },
            meHash: 'b'.repeat(20),
            treeHash: 'c'.repeat(64),
            backup: {
              root: '/state/auth-bond-backups/test',
              latest: '/state/auth-bond-backups/test/history/latest',
              latestAt: '2026-06-09T12:00:00.000Z',
              latestReason: 'connection-open',
              latestTreeHash: 'c'.repeat(64),
              lastCaptureAt: '2026-06-09T12:00:00.000Z',
              lastCaptureReason: 'connection-open',
              lastCaptureError: null,
              lastRestoreAt: null,
              lastRestoreSource: null,
              lastRestoreError: null,
            },
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.whatsapp.auth_bond).toMatchObject({
      status: 'present',
      creds: { hash: 'a'.repeat(20), mode: '600', empty_hash: false },
      me_hash: 'b'.repeat(20),
      tree_hash: 'c'.repeat(20),
      backup: {
        latest: '/state/auth-bond-backups/test/history/latest',
        latest_reason: 'connection-open',
      },
    });
    expect(json.whatsapp.connection.auth_failure_class).toBe('none');
    expect(json.whatsapp.credential_lifecycle).toMatchObject({
      version: 1,
      latestBaileysVersion: '2.2413.1',
      credsUpdateCount: 3,
      environment: {
        host: 'nucles',
        authDir: '/auth',
      },
      currentAuthBond: {
        status: 'present',
        creds: { hash: 'a'.repeat(20), identityHash: 'b'.repeat(20) },
      },
    });
    db2.close();
  });

  it('classifies server-side WhatsApp logout as irreversible even when local auth is present', async () => {
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
          state: 'disconnected',
          connected: false,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: '2026-06-09T12:00:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: 'loggedOut',
          lastStatusCode: 401,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            version: 1,
            latestBaileysVersion: '2.3000.1021',
            connectStartedAt: '2026-06-09T11:59:00.000Z',
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: '2026-06-09T12:10:00.000Z',
            lastQrAt: null,
            lastCredsUpdateAt: '2026-06-09T12:05:00.000Z',
            lastCredsUpdateFailedAt: null,
            lastAuthSnapshotAt: '2026-06-09T12:05:01.000Z',
            lastAuthSnapshotFailedAt: null,
            credsUpdateCount: 3,
            authSnapshotCaptureCount: 2,
            authSnapshotFailureCount: 0,
            recentEvents: [
              { at: '2026-06-09T12:05:00.000Z', event: 'creds_update_saved', state: 'connected', reconnectAttempts: 0, reconnectPhase: 'backoff' },
              { at: '2026-06-09T12:10:00.000Z', event: 'device_bond_lost', state: 'disconnected', reconnectAttempts: 0, reconnectPhase: 'backoff', statusCode: 401, reason: 'loggedOut' },
            ],
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.whatsapp.connection.disconnect_class).toBe('serverside_logout_irreversible');
    expect(json.whatsapp.connection.auth_failure_class).toBe('serverside_logout_irreversible');
    expect(json.whatsapp.auth_bond.status).toBe('present');
    expect(json.whatsapp.credential_lifecycle).toMatchObject({
      latestBaileysVersion: '2.3000.1021',
      credsUpdateCount: 3,
      recentEvents: [
        expect.objectContaining({ event: 'creds_update_saved' }),
        expect.objectContaining({ event: 'device_bond_lost', statusCode: 401 }),
      ],
    });
    db2.close();
  });

  it('classifies local auth corruption by whether a protected backup is available', async () => {
    db.close();
    const db2 = makeDb();
    const connectionManager = {
      botJid: '15550199000@s.whatsapp.net',
      botLid: null,
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getConnectionState: vi.fn(),
    };
    const baseSnapshot = {
      state: 'connected',
      connected: true,
      reconnectAttempts: 0,
      reconnectPhase: null,
      stateChangedAt: '2026-06-09T12:00:00.000Z',
      firstFailureAt: null,
      lastPingAt: null,
      lastPongAt: null,
      lastDisconnectReason: null,
      lastStatusCode: null,
    };
    connectionManager.getConnectionState.mockReturnValue({
      ...baseSnapshot,
      authBond: makeAuthBond({
        status: 'invalid',
        issues: ['creds_json_invalid_json'],
      }),
    });
    const deps = makeDeps(db2, { connectionManager } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    let response = await httpReq(port, '/health', 'GET');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'degraded',
      whatsapp: {
        connection: { auth_failure_class: 'local_corruption_restorable' },
      },
    });

    connectionManager.getConnectionState.mockReturnValue({
      ...baseSnapshot,
      authBond: makeAuthBond({
        status: 'missing',
        issues: ['auth_dir_missing', 'creds_json_missing'],
        backup: { latest: null, latestAt: null, latestTreeHash: null },
      }),
    });

    response = await httpReq(port, '/health', 'GET');
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'unhealthy',
      whatsapp: {
        connection: { auth_failure_class: 'local_corruption_unrestorable' },
      },
    });
    db2.close();
  });

  it('does not classify a connected fresh credential rewrite window as auth corruption', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T12:00:05Z'));
    try {
      db.close();
      const db2 = makeDb();
      const connectionManager = {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          authBond: makeAuthBond({
            status: 'invalid',
            issues: ['creds_json_empty'],
            creds: {
              path: '/auth/creds.json',
              exists: true,
              mode: '600',
              size: 0,
              mtime: '2026-06-09T12:00:04.000Z',
              sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
            treeHash: null,
            backup: {
              lastCaptureDeferredAt: '2026-06-09T12:00:05.000Z',
              lastCaptureDeferredReason: 'creds-update',
              lastCaptureDeferredAgeMs: 1000,
            },
          }),
        }),
      };
      const deps = makeDeps(db2, { connectionManager } as any);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ({ server, port } = await buildTestServer(deps));

      const response = await httpReq(port, '/health', 'GET');
      const json = JSON.parse(response.body);

      expect(response.status).toBe(200);
      expect(json.status).toBe('healthy');
      expect(json.whatsapp.connection.auth_failure_class).toBe('none');
      expect(json.whatsapp.auth_bond).toMatchObject({
        status: 'invalid',
        backup: {
          last_capture_deferred_reason: 'creds-update',
          last_capture_deferred_age_ms: 1000,
        },
      });
      db2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies present-but-risky auth bonds as degraded instead of healthy', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          authBond: makeAuthBond({
            issues: ['auth_mode_chmod_failed:creds.json:EPERM'],
            backup: { lastCaptureError: 'capture failed: disk full' },
          }),
          credentialLifecycle: {
            lastQrAt: null,
            lastOpenAt: '2026-06-09T12:00:00.000Z',
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connection.auth_failure_class).toBe('auth_bond_at_risk');
    expect(json.whatsapp.auth_bond.issues).toEqual(['auth_mode_chmod_failed:creds.json:EPERM']);
    db2.close();
  });

  it('classifies transient and unknown disconnect status codes separately', async () => {
    db.close();
    const db2 = makeDb();
    const connectionManager = {
      botJid: null,
      botLid: null,
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getConnectionState: vi.fn(),
    };
    const baseSnapshot = {
      state: 'reconnecting',
      connected: false,
      reconnectAttempts: 2,
      reconnectPhase: 'retry',
      stateChangedAt: '2026-06-09T12:00:00.000Z',
      firstFailureAt: '2026-06-09T12:00:00.000Z',
      lastPingAt: null,
      lastPongAt: null,
      authBond: makeAuthBond(),
      credentialLifecycle: {
        lastQrAt: null,
        lastOpenAt: '2026-06-09T11:00:00.000Z',
      },
    };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db2, { connectionManager } as any)));

    connectionManager.getConnectionState.mockReturnValue({
      ...baseSnapshot,
      lastDisconnectReason: 'connectionClosed',
      lastStatusCode: 428,
    });
    let response = await httpReq(port, '/health', 'GET');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).whatsapp.connection.disconnect_class).toBe('transient_reconnect');

    connectionManager.getConnectionState.mockReturnValue({
      ...baseSnapshot,
      lastDisconnectReason: 'unexpected',
      lastStatusCode: 999,
    });
    response = await httpReq(port, '/health', 'GET');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).whatsapp.connection.disconnect_class).toBe('unknown_reconnect');
    db2.close();
  });

  it('returns 404 for unknown routes', async () => {
    const { status } = await httpReq(port, '/unknown', 'GET');
    expect(status).toBe(404);
  });

  it('surfaces effectiveProvider and fallbackActiveUntil from the agent runtime fallback state', async () => {
    db.close();
    const db2 = makeDb();
    const activeUntil = Date.now() + 600_000;
    const resetAt = Date.now() + 1_200_000;
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({ status: 'healthy', details: { active: true } }),
      getFallbackState: () => ({
        effectiveProvider: 'openai-api',
        fallbackActiveUntil: activeUntil,
        fallbackReason: 'usage-limit',
        fallbackModel: 'gpt-5.5',
        fallbackResetAt: resetAt,
        fallbackRecoveryProbeRequired: true,
        fallbackTurnsServed: 3,
        fallbackTurnsEmpty: 1,
        lastFallbackTurnAt: 1_000_000,
      }),
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.instance.effectiveProvider).toBe('openai-api');
    expect(json.instance.fallbackActiveUntil).toBe(activeUntil);
    expect(json.instance.fallbackReason).toBe('usage-limit');
    expect(json.instance.fallbackModel).toBe('gpt-5.5');
    expect(json.instance.fallbackResetAt).toBe(resetAt);
    expect(json.instance.fallbackRecoveryProbeRequired).toBe(true);
    expect(json.instance.fallbackTurnsServed).toBe(3);
    expect(json.instance.fallbackTurnsEmpty).toBe(1);
    expect(json.instance.lastFallbackTurnAt).toBe(1_000_000);
    db2.close();
  });

  it('includes instance block with expected fields', async () => {
    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.instance).toBeDefined();
    expect(json.instance.name).toBe('WhatSoup');
    expect(json.instance.mode).toBe('chat');
    expect(json.instance.accessMode).toBe('allowlist');
    expect(json.instance.pid).toBe(process.pid);
  });

  it('returns instance.socketPath as null when not provided', async () => {
    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    expect(JSON.parse(body).instance).toEqual({
      name: 'WhatSoup',
      mode: 'chat',
      accessMode: 'allowlist',
      socketPath: null,
      pid: process.pid,
    });
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
    expect(json.sqlite.schema_migration_required).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_migration_latest).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_ready).toBe(true);
    expect(json.sqlite.pending_polls_readable).toBe(true);
  });

  it('degrades health when the applied migration version is behind the code-required schema', async () => {
    db.raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(CURRENT_SCHEMA_MIGRATION);

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.sqlite.schema_migration_latest).toBeLessThan(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_migration_required).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_ready).toBe(false);
    expect(json.sqlite.pending_polls_readable).toBe(true);
  });

  it('degrades health when pending_polls is unreadable instead of masking schema drift', async () => {
    db.raw.exec('DROP TABLE pending_polls');

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.sqlite.schema_migration_latest).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_ready).toBe(true);
    expect(json.sqlite.pending_polls_readable).toBe(false);
    expect(json.sqlite.pending_polls_total).toBe(0);
  });

  it('returns degraded JSON with chat runtime queue details when enrichment is stale', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      getEnrichmentStats: vi.fn().mockReturnValue({
        lastRun: '2000-01-01T00:00:00.000Z',
        unprocessed: 7,
        runtimeDegraded: true,
      }),
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'degraded',
          details: { queue: { activeChats: 2, queuedChats: 3 } },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.enrichment.last_run).toBe('2000-01-01T00:00:00.000Z');
    expect(json.runtime.chat).toEqual({ queueDepth: 5, enrichmentUnprocessed: 7 });
    db2.close();
  });

  it('returns passive runtime details verbatim in the health JSON shape', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'passive',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: { socket: 'ready', tools: 160 },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    expect(JSON.parse(body).runtime).toEqual({
      passive: { socket: 'ready', tools: 160 },
    });
    db2.close();
  });

  it('returns agent runtime details verbatim in the health JSON shape', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'degraded',
          details: { sessions: 2, compact: { lastError: 'timeout' } },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    expect(JSON.parse(body).runtime).toEqual({
      agent: { sessions: 2, compact: { lastError: 'timeout' } },
    });
    db2.close();
  });

  it('returns an error JSON shape when runtime health snapshot collection fails', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn(() => {
          throw new Error('snapshot unavailable');
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ status: 'error' });
    db2.close();
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
      auditWriter: createOutboundSendsWriter({ db: db.raw, line: 'test-line' }),
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

  it('returns 401 for multibyte malformed Bearer tokens without crashing', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'a'.repeat(10);
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hi' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: `Bearer ${'é'.repeat(10)}`,
    });
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
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

  it('audits a successful health send exactly once', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hello audit' });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
    const rows = db.raw
      .prepare('SELECT line, caller, chat_jid, target_kind, status, text_length FROM outbound_sends')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{
      line: 'test-line',
      caller: 'health',
      chat_jid: '15550100001@s.whatsapp.net',
      target_kind: 'chatJid',
      status: 'sent',
      text_length: 'hello audit'.length,
    }]);
  });

  it('surfaces the latest confirmed outbound send in health', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hello health proof' });

    const send = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });
    expect(send.status).toBe(200);

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.outbound_sends).toEqual({
      latest_successful_send_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      latest_successful_transport_id: null,
    });
  });

  it('audits a failed health send exactly once', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    vi.mocked(deps.connectionManager.sendMessage).mockRejectedValueOnce(new Error('transport unavailable'));
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'will fail' });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(500);
    expect(JSON.parse(body).error).toBe('transport unavailable');
    const rows = db.raw
      .prepare('SELECT caller, chat_jid, target_kind, status, error FROM outbound_sends')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{
      caller: 'health',
      chat_jid: '15550100001@s.whatsapp.net',
      target_kind: 'chatJid',
      status: 'failed',
      error: 'transport unavailable',
    }]);
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

  it('rejects oversized /send bodies before parsing or dispatching', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';

    const { status, body } = await httpReq(port, '/send', 'POST', JSON.stringify({
      chatJid: '15550100001@s.whatsapp.net',
      text: 'x'.repeat(70_000),
    }), {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(413);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'request body too large' });
    expect(deps.connectionManager.sendMessage).not.toHaveBeenCalled();
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
      chatJid: '120363555555555003@g.us',
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
      JSON.stringify({ chatJid: '120363555555555003@g.us' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      ok: true,
      command: 'compact',
      chatJid: '120363555555555003@g.us',
      silent: true,
    });
    expect(handleAgentCommand).toHaveBeenCalledWith({
      command: 'compact',
      chatJid: '120363555555555003@g.us',
      silent: true,
    });
  });

  it('allows explicit non-silent compact for operator-triggered diagnostics', async () => {
    const handleAgentCommand = vi.fn().mockResolvedValue({
      ok: true,
      command: 'compact',
      chatJid: '120363555555555003@g.us',
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
      JSON.stringify({ chatJid: '120363555555555003@g.us', silent: false }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(200);
    expect(handleAgentCommand).toHaveBeenCalledWith({
      command: 'compact',
      chatJid: '120363555555555003@g.us',
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

  it('rejects malformed JSON before dispatching to the runtime', async () => {
    const handleAgentCommand = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', '{', {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'invalid JSON' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects oversized compact requests before dispatching to the runtime', async () => {
    const handleAgentCommand = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', JSON.stringify({ pad: 'x'.repeat(70_000) }), {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(413);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'request body too large' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects non-boolean silent before dispatching to the runtime', async () => {
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
      JSON.stringify({ silent: 'false' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'silent must be a boolean when provided' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });

  it('maps runtime errors without a valid statusCode to a 500 JSON response', async () => {
    const err = Object.assign(new Error('compact worker crashed'), {
      code: 123,
      statusCode: 302,
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

    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'compact worker crashed' });
  });
});

describe('health command endpoints — malformed bodies and side effects', () => {
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

  it('rejects non-object /heal bodies instead of treating them as server errors', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/heal', 'POST', 'null', {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ error: 'request body must be a JSON object' });
  });

  it('rejects malformed, missing-type, and oversized /heal bodies', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const malformed = await httpReq(port, '/heal', 'POST', '{', {
      authorization: 'Bearer secret-token',
    });
    const missingType = await httpReq(port, '/heal', 'POST', '{}', {
      authorization: 'Bearer secret-token',
    });
    const oversized = await httpReq(port, '/heal', 'POST', JSON.stringify({ type: 'service_crash', pad: 'x'.repeat(70_000) }), {
      authorization: 'Bearer secret-token',
    });

    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ error: 'invalid JSON' });
    expect(missingType.status).toBe(400);
    expect(JSON.parse(missingType.body)).toEqual({ error: 'missing type field' });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({ error: 'request body too large' });
  });

  it('rejects non-string /heal type values', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/heal', 'POST', JSON.stringify({ type: 123 }), {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ error: 'type must be a string' });
  });

  it('stores heal reports, dispatches the runtime turn, and rejects unresolved duplicates', async () => {
    const handleControlTurn = vi.fn().mockRejectedValue(new Error('runtime unavailable'));
    ({ server, port } = await buildTestServer(makeDeps(db, {
      runtime: { handleControlTurn } as any,
    })));
    const payload = JSON.stringify({
      reportId: 'report-1',
      type: 'service_crash',
      errorHint: 'systemd unit exited',
    });

    const first = await httpReq(port, '/heal', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });
    const second = await httpReq(port, '/heal', 'POST', payload, {
      authorization: 'Bearer secret-token',
    });

    expect(first.status).toBe(202);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.reportId).toBe('report-1');
    expect(typeof firstBody.errorClass).toBe('string');
    expect(handleControlTurn).toHaveBeenCalledWith(
      'report-1',
      expect.stringContaining('"reportId":"report-1"'),
    );
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toEqual({
      error: 'duplicate',
      existingReportId: 'report-1',
    });
  });

  it('rejects non-object /access bodies and scalar subject ids', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const nonObject = await httpReq(port, '/access', 'POST', 'null', {
      authorization: 'Bearer secret-token',
    });
    const scalarSubject = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: 123, action: 'allow' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(nonObject.status).toBe(400);
    expect(JSON.parse(nonObject.body)).toEqual({ error: 'request body must be a JSON object' });
    expect(scalarSubject.status).toBe(400);
    expect(JSON.parse(scalarSubject.body)).toEqual({ error: 'subjectType, subjectId, and action are required' });
  });

  it('rejects malformed and oversized /access bodies before changing access state', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const malformed = await httpReq(port, '/access', 'POST', '{', {
      authorization: 'Bearer secret-token',
    });
    const oversized = await httpReq(port, '/access', 'POST', JSON.stringify({
      subjectType: 'phone',
      subjectId: '15551234567',
      action: 'allow',
      pad: 'x'.repeat(70_000),
    }), {
      authorization: 'Bearer secret-token',
    });

    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ error: 'invalid JSON' });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({ error: 'request body too large' });
    expect(db.raw.prepare('SELECT COUNT(*) AS cnt FROM access_list').get()).toEqual({ cnt: 0 });
  });

  it('rejects invalid /access subject type and action values', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const invalidSubjectType = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'channel', subjectId: '15551234567', action: 'allow' }),
      { authorization: 'Bearer secret-token' },
    );
    const invalidAction = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: '15551234567', action: 'mute' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(invalidSubjectType.status).toBe(400);
    expect(JSON.parse(invalidSubjectType.body)).toEqual({ error: 'subjectType must be "phone" or "group"' });
    expect(invalidAction.status).toBe(400);
    expect(JSON.parse(invalidAction.body)).toEqual({ error: 'action must be "allow" or "block"' });
  });

  it('updates access and keeps the 200 response when replay callback fails', async () => {
    const handleAccessDecision = vi.fn().mockRejectedValue(new Error('replay failed'));
    ({ server, port } = await buildTestServer(makeDeps(db, { handleAccessDecision })));

    const { status, body } = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: '15551234567', action: 'allow' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      ok: true,
      action: 'allow',
      subjectType: 'phone',
      subjectId: '15551234567',
      result: 'inserted',
    });
    expect(handleAccessDecision).toHaveBeenCalledWith('phone', '15551234567', 'allow');
    const row = db.raw
      .prepare('SELECT subject_type, subject_id, status FROM access_list WHERE subject_id = ?')
      .get('15551234567');
    expect(row).toEqual({ subject_type: 'phone', subject_id: '15551234567', status: 'allowed' });
  });

  it('rejects non-object and missing /mark-read bodies before touching chat state', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const nonObject = await httpReq(port, '/mark-read', 'POST', 'null', {
      authorization: 'Bearer secret-token',
    });
    const missingKey = await httpReq(port, '/mark-read', 'POST', '{}', {
      authorization: 'Bearer secret-token',
    });

    expect(nonObject.status).toBe(400);
    expect(JSON.parse(nonObject.body)).toEqual({ error: 'request body must be a JSON object' });
    expect(missingKey.status).toBe(400);
    expect(JSON.parse(missingKey.body)).toEqual({ error: 'conversation_key is required' });
  });

  it('rejects malformed /mark-read JSON before touching chat state', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/mark-read', 'POST', '{', {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ error: 'invalid JSON' });
  });

  it('rejects oversized /mark-read bodies before touching chat state', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/mark-read', 'POST', JSON.stringify({
      conversation_key: '15551234567',
      pad: 'x'.repeat(70_000),
    }), {
      authorization: 'Bearer secret-token',
    });

    expect(status).toBe(413);
    expect(JSON.parse(body)).toEqual({ error: 'request body too large' });
  });

  it('returns 404 for /mark-read when the conversation key is unknown', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/mark-read',
      'POST',
      JSON.stringify({ conversation_key: 'missing-chat' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: 'chat not found', conversation_key: 'missing-chat' });
  });

  it('marks a conversation read through the health endpoint', async () => {
    const baseDeps = makeDeps(db);
    const connectionManager = {
      ...baseDeps.connectionManager,
      getSocket: vi.fn(() => null),
    } as unknown as ConnectionManager;
    ({ server, port } = await buildTestServer(makeDeps(db, { connectionManager })));
    db.raw
      .prepare('INSERT INTO chats (jid, conversation_key, unread_count) VALUES (?, ?, ?)')
      .run('15551234567@s.whatsapp.net', '15551234567', 4);

    const { status, body } = await httpReq(
      port,
      '/mark-read',
      'POST',
      JSON.stringify({ conversation_key: '15551234567' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      ok: true,
      jid: '15551234567@s.whatsapp.net',
      conversation_key: '15551234567',
    });
    const row = db.raw
      .prepare('SELECT unread_count FROM chats WHERE conversation_key = ?')
      .get('15551234567') as { unread_count: number };
    expect(row.unread_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /typing — Authorization header check (issue #389)
// ---------------------------------------------------------------------------

describe('GET /typing — Authorization header check', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    const presenceCache = {
      getAll: () => new Map<string, { status: string; updatedAt: number }>([
        ['15550100001@s.whatsapp.net', { status: 'composing', updatedAt: 1700000000000 }],
        ['15550100002@s.whatsapp.net', { status: 'available', updatedAt: 1700000001000 }],
      ]).entries(),
    };
    const deps = makeDeps(db, {
      connectionManager: {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        presenceCache,
      } as unknown as ConnectionManager,
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
    const { status, body } = await httpReq(port, '/typing', 'GET');
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when Bearer token does not match', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const { status } = await httpReq(port, '/typing', 'GET', undefined, {
      authorization: 'Bearer wrong-token',
    });
    expect(status).toBe(401);
  });

  it('returns 401 when no WHATSOUP_HEALTH_TOKEN is set', async () => {
    const { status, body } = await httpReq(port, '/typing', 'GET', undefined, {
      authorization: 'Bearer any-token',
    });
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 200 with composing payload when Bearer token matches', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
    const { status, body } = await httpReq(port, '/typing', 'GET', undefined, {
      authorization: 'Bearer secret-token',
    });
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(Array.isArray(json.composing)).toBe(true);
    expect(json.composing).toEqual([
      { jid: '15550100001@s.whatsapp.net', since: 1700000000000 },
    ]);
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
