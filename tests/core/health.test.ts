/**
 * Tests for src/core/health.ts
 *
 * Tests the authorization logic in POST /send and the health endpoint
 * using real HTTP servers on ephemeral ports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock config and logger
// ---------------------------------------------------------------------------

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    // Q control peer: name 'q' → phone '15559998888' (control_peer wiring tests)
    controlPeers: new Map<string, string>([['q', '15559998888']]),
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

// health.ts's own logger ('health') is a stable shared instance (not a fresh
// object per call) so #1753's "logs a warning on starvation" test can assert
// against the one logger health.ts's module-level `createChildLogger('health')`
// actually holds. Every OTHER component (database.ts, chats-resolver.ts, ...)
// keeps a fresh throwaway logger per call, same as before — otherwise their
// unrelated warn/info calls (e.g. database.ts's WAL-journal-mode notice) would
// pollute mockHealthLogger and make its call history meaningless.
const mockHealthLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: (component: string) =>
    component === 'health'
      ? mockHealthLogger
      : { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The control_peer wiring tests drive heal.ts's emitHealReport directly; mock
// the alert sink so no real BOT ERRORS outbox event is written from a test.
vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';
import { recordContinuityGaps } from '../../src/core/continuity-gap-ledger.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { config } from '../../src/config.ts';
import { emitHealReport, resetDeliveryUnavailableLatch } from '../../src/core/heal.ts';
import type { Messenger } from '../../src/core/types.ts';
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
  let prevGitSha: string | undefined;
  let prevGitBranch: string | undefined;

  beforeEach(async () => {
    prevGitSha = process.env.WHATSOUP_GIT_SHA;
    prevGitBranch = process.env.WHATSOUP_GIT_BRANCH;
    delete process.env.WHATSOUP_GIT_SHA;
    delete process.env.WHATSOUP_GIT_BRANCH;
    db = makeDb();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    ({ server, port } = await buildTestServer(makeDeps(db)));
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevGitSha === undefined) delete process.env.WHATSOUP_GIT_SHA;
    else process.env.WHATSOUP_GIT_SHA = prevGitSha;
    if (prevGitBranch === undefined) delete process.env.WHATSOUP_GIT_BRANCH;
    else process.env.WHATSOUP_GIT_BRANCH = prevGitBranch;
  });

  it('returns 200 with healthy status when connected', async () => {
    const requestedAt = Date.now();
    const { status, body } = await httpReq(port, '/health', 'GET');
    const receivedAt = Date.now();
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('healthy');
    expect(json.whatsapp.connected).toBe(true);
    expect(typeof json.uptime_seconds).toBe('number');
    expect(typeof json.generated_at).toBe('string');
    const generatedAt = Date.parse(json.generated_at);
    expect(Number.isNaN(generatedAt)).toBe(false);
    expect(generatedAt).toBeGreaterThanOrEqual(requestedAt);
    expect(generatedAt).toBeLessThanOrEqual(receivedAt);
  });

  it('degrades and surfaces durability debt when an outbound delivery is stuck in maybe_sent past the stale window (#1865)', async () => {
    const db2 = makeDb();
    const durability = new DurabilityEngine(db2);
    const id = durability.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
    durability.markSending(id);
    durability.markSubmitted(id, 'WA_MSG_1865');
    durability.markMaybeSent(id, 'echo_timeout');
    // One hour unresolved — well past the stale window.
    db2.raw
      .prepare(`UPDATE outbound_ops SET submitted_at = datetime('now', '-3600 seconds') WHERE id = ?`)
      .run(id);

    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db2, { durability }));
    try {
      const { status, body } = await httpReq(port2, '/health', 'GET');
      const json = JSON.parse(body);
      // A connected instance is otherwise healthy; the stale maybe_sent must degrade it
      // rather than read green (#1865). Degraded still returns 200.
      expect(status).toBe(200);
      expect(json.status).toBe('degraded');
      expect(json.durability.maybeSentOutbound).toBe(1);
      expect(json.durability.oldestMaybeSentAt).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      db2.close();
    }
  });

  it('surfaces control-peer wiring under control_peer when the Q peer is configured', async () => {
    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.control_peer).toEqual({
      configured: true,
      suppressed_unavailable_alerts: 0,
    });
  });

  it('reflects a missing Q peer and the suppressed-alert count after latched heal reports', async () => {
    resetDeliveryUnavailableLatch();
    config.controlPeers.delete('q');
    try {
      const messenger: Messenger = {
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      };
      // Two distinct-class reports: the first fires the (mocked) critical and
      // arms the latch, the second is suppressed and counted.
      emitHealReport(db, messenger, null, { type: 'crash', stderr: 'HealthLatchA: boom' });
      emitHealReport(db, messenger, null, { type: 'crash', stderr: 'HealthLatchB: boom' });

      const { status, body } = await httpReq(port, '/health', 'GET');
      expect(status).toBe(200);
      const json = JSON.parse(body);
      expect(json.control_peer).toEqual({
        configured: false,
        suppressed_unavailable_alerts: 1,
      });
    } finally {
      config.controlPeers.set('q', '15559998888');
      resetDeliveryUnavailableLatch();
    }
  });

  it('surfaces safe ARC binding metadata from runtime health', async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-health-arc.'));
    mkdirSync(path.join(repoRoot, '.arc'));
    writeFileSync(path.join(repoRoot, '.arc', 'arc.toml'), [
      'arc_version = "0.1.0"',
      'consumer = "whatsoup"',
      'modules = ["app-runtime", "telemetry", "verification"]',
      'emits = ["verification-record"]',
      '',
      '[source]',
      'binding = "bindings/whatsoup.arc.json"',
      `payload_sha = "sha256:${'b'.repeat(64)}"`,
      'generated_by = "arc adopt"',
      '',
    ].join('\n'), 'utf8');
    const prev = process.env.WHATSOUP_REPO_ROOT;
    process.env.WHATSOUP_REPO_ROOT = repoRoot;
    try {
      const { status, body } = await httpReq(port, '/health', 'GET');
      expect(status).toBe(200);
      const json = JSON.parse(body);
      expect(json.arc).toEqual({
        loaded: true,
        consumer: 'whatsoup',
        arcVersion: '0.1.0',
        modules: ['app-runtime', 'telemetry', 'verification'],
        emits: ['verification-record'],
        binding: 'bindings/whatsoup.arc.json',
        payloadSha: `sha256:${'b'.repeat(64)}`,
      });
    } finally {
      if (prev === undefined) {
        delete process.env.WHATSOUP_REPO_ROOT;
      } else {
        process.env.WHATSOUP_REPO_ROOT = prev;
      }
    }
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

  it('marks a connected instance degraded and surfaces outbound_flood when a flood is active (T3.3)', async () => {
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
            count: 0, // no churn — only the flood should drive 'degraded'
            lastAt: null,
            lastReason: null,
            lastStatusCode: null,
            byReason: {},
          },
          outboundFlood: {
            windowMs: 300_000,
            threshold: 20,
            flooding: true,
            destCount: 1,
            worstDestHash: 'abc123def456',
            worstCount: 42,
          },
        }),
      } as unknown as ConnectionManager,
    })));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded'); // the active flood degrades health
    expect(json.whatsapp.connection.outbound_flood).toEqual({
      window_ms: 300_000,
      threshold: 20,
      flooding: true,
      dest_count: 1,
      worst_dest_hash: 'abc123def456', // redacted hash, never a raw number
      worst_count: 42,
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
              fileCount: 14,
              totalBytes: 1234,
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
            fileCount: 14,
            totalBytes: 1234,
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
      file_count: 14,
      total_bytes: 1234,
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
        fileCount: 14,
        totalBytes: 1234,
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

  it('publishes exact degradation causes for an otherwise-operational fallback', async () => {
    db.close();
    const db2 = makeDb();
    const activeUntil = Date.now() + 600_000;
    let retainedRetries = 0;
    let active: boolean | undefined;
    let fallbackChainExhausted = false;
    let failedEntryCount = 0;
    let modelUsable: boolean | null = false;
    let modelUsableStale = false;
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          recentCrashes: 0,
          ...(active === undefined ? {} : { active }),
          turnFinalizationRetainedRetries: retainedRetries,
          turnFinalizationDegradedScopes: 0,
          turnRecoveryOutstanding: 0,
          turnRecoveryExhausted: 0,
          turnRecoveryOpenRecoveries: 0,
          turnRecoveryCorruptLinks: 0,
          turnRecoveryEchoConflicts: 0,
          providerExecution: { pressureActive: false },
          turnCapability: {
            modelUsable,
            modelUsableStale,
            modelUsabilityStatus: 'provider-unavailable',
            lastSuccessfulTurnAt: Date.now() - 1_000,
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
          },
        },
      }),
      getFallbackState: () => ({
        effectiveProvider: 'opencode-cli',
        fallbackActiveUntil: activeUntil,
        fallbackReason: 'usage-limit',
        fallbackModel: 'configured/fallback',
        fallbackChainExhausted,
        failedEntryCount,
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
    expect(json.status).toBe('degraded');
    expect(json.degradation_causes).toEqual([
      'provider_fallback_active',
      'primary_model_unusable',
    ]);

    retainedRetries = 1;
    const withRetryDebt = JSON.parse((await httpReq(port, '/health', 'GET')).body);
    expect(withRetryDebt.degradation_causes).toEqual([
      'provider_fallback_active',
      'primary_model_unusable',
      'turn_finalization_degraded',
    ]);

    retainedRetries = 0;
    active = false;
    const withInactiveSession = JSON.parse((await httpReq(port, '/health', 'GET')).body);
    expect(withInactiveSession.degradation_causes).toEqual([
      'provider_fallback_active',
      'primary_model_unusable',
      'agent_session_inactive',
    ]);

    active = undefined;
    fallbackChainExhausted = true;
    failedEntryCount = 1;
    const withFallbackFailures = JSON.parse((await httpReq(port, '/health', 'GET')).body);
    expect(withFallbackFailures.degradation_causes).toEqual([
      'provider_fallback_active',
      'fallback_chain_exhausted',
      'fallback_entry_failures',
      'primary_model_unusable',
    ]);

    fallbackChainExhausted = false;
    failedEntryCount = 0;
    modelUsable = null;
    modelUsableStale = true;
    const withStalePrimaryEvidence = JSON.parse((await httpReq(port, '/health', 'GET')).body);
    expect(withStalePrimaryEvidence.degradation_causes).toEqual([
      'provider_fallback_active',
      'primary_model_evidence_stale',
    ]);
    db2.close();
  });

  it('threads #1392 modelUsableStale/modelUsableCheckedAt into runtime.agent and top-level turn_capability (F1)', async () => {
    // Regression for the half-deployed #1392: the freshness fields were exposed on
    // instance.turnCapability (via getFallbackState) but dropped from the core/health.ts
    // serializers feeding runtime.agent.turnCapability and the top-level snake-case
    // turn_capability — which is exactly what whatsoup-keychain-heal.sh reads, leaving a
    // stale-green blind spot. See FLEET-MATRIX F1.
    db.close();
    const db2 = makeDb();
    const checkedAt = 1_782_349_406_162;
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'healthy',
        details: {
          active: true,
          turnCapability: {
            modelUsable: null,
            modelUsableStale: true,
            modelUsableCheckedAt: checkedAt,
            modelUsabilityStatus: 'usable',
            lastSuccessfulTurnAt: null,
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
          },
        },
      }),
      getFallbackState: () => null,
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
    // runtime.agent.turnCapability (camelCase) must carry the freshness fields
    expect(json.runtime.agent.turnCapability.modelUsableStale).toBe(true);
    expect(json.runtime.agent.turnCapability.modelUsableCheckedAt).toBe(checkedAt);
    // top-level snake-case turn_capability (read by whatsoup-keychain-heal.sh) too
    expect(json.turn_capability.model_usable_stale).toBe(true);
    expect(json.turn_capability.model_usable_checked_at).toBe(checkedAt);
    // existing fields preserved
    expect(json.turn_capability.model_usable).toBe(null);
    db2.close();
  });

  it('degrades top-level status when model evidence is stale AND a turn was recently attempted (S-04a)', async () => {
    // Stale usability evidence WHILE the model was recently relied upon is a
    // genuine probe-refresh failure — it must not read as a healthy green. (A
    // never-turned idle bot with stale evidence stays healthy; that case is the
    // #1392 test above, which asserts field threading without a degrade.)
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'healthy',
        details: {
          active: true,
          turnCapability: {
            modelUsable: null,
            modelUsableStale: true,
            modelUsableCheckedAt: Date.now() - 60 * 60 * 1000,
            modelUsabilityStatus: 'usable',
            lastSuccessfulTurnAt: Date.now() - 60_000, // relied upon 1 min ago
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
          },
        },
      }),
      getFallbackState: () => null,
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
    expect(json.status).toBe('degraded');
    expect(json.turn_capability.model_usable_stale).toBe(true);
    db2.close();
  });

  it('propagates degraded runtime snapshots to the top-level health status', async () => {
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          activeSessions: 1,
          effectiveProvider: 'openai-api',
          fallbackActiveUntil: Date.now() + 600_000,
          fallbackReason: 'usage-limit',
        },
      }),
      getFallbackState: () => null,
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
    expect(json.status).toBe('degraded');
    expect(json.runtime.agent.effectiveProvider).toBe('openai-api');
    db2.close();
  });

  it('publishes turn-finalization recovery counters and degraded status', async () => {
    db.close();
    const db2 = makeDb();
    const recoveryHealth = {
      proactiveResumeIdentityRejects: 3,
      turnFinalizationRetainedRetries: 2,
      turnFinalizationDegradedScopes: 1,
      turnFinalizationRetryAttempts: 7,
      turnFinalizationRetryRecoveries: 4,
      turnFinalizationRetryExhaustions: 1,
    };
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: { activeSessions: 1, ...recoveryHealth },
      }),
      getFallbackState: () => null,
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
    expect(json.status).toBe('degraded');
    expect(json.runtime.agent).toMatchObject(recoveryHealth);
    db2.close();
  });

  it('propagates unhealthy runtime snapshots to the top-level health status', async () => {
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'unhealthy',
        details: {
          activeSessions: 0,
          lastTurnErrorClass: 'auth-required',
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.runtime.agent.lastTurnErrorClass).toBe('auth-required');
    db2.close();
  });

  it('includes instance block with expected fields', async () => {
    process.env.WHATSOUP_GIT_SHA = 'a'.repeat(40);
    process.env.WHATSOUP_GIT_BRANCH = 'main';

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.instance).toBeDefined();
    expect(json.instance.name).toBe('WhatSoup');
    expect(json.instance.mode).toBe('chat');
    expect(json.instance.accessMode).toBe('allowlist');
    expect(json.instance.pid).toBe(process.pid);
    expect(json.instance.commit).toBe('a'.repeat(40));
    expect(json.instance.branch).toBe('main');
  });

  it('returns instance.socketPath as null when not provided', async () => {
    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    expect(JSON.parse(body).instance).toEqual({
      name: 'WhatSoup',
      mode: 'chat',
      accessMode: 'allowlist',
      socketPath: null,
      commit: null,
      branch: null,
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

  it('keeps health degraded while external-history continuity gaps remain open', async () => {
    recordContinuityGaps(db.raw, [
      {
        ordinal: 1,
        classification: 'absent',
        receiptFingerprint: 'a'.repeat(64),
        destinationFingerprint: 'b'.repeat(64),
        manifestFingerprint: 'c'.repeat(64),
        evidenceFingerprint: 'd'.repeat(64),
      },
      {
        ordinal: 2,
        classification: 'ambiguous',
        receiptFingerprint: 'e'.repeat(64),
        destinationFingerprint: 'b'.repeat(64),
        manifestFingerprint: 'c'.repeat(64),
        evidenceFingerprint: 'd'.repeat(64),
      },
    ]);

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.degradation_causes).toContain('continuity_gap_open');
    expect(json.continuity).toEqual({
      readable: true,
      open: 2,
      unresolved: 1,
      ambiguous: 1,
    });
    expect(body).not.toContain('continuity-gap:v1:');
    expect(body).not.toContain('a'.repeat(64));
  });

  it('fails health closed when reserved continuity state has a foreign owner', async () => {
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES ('foreign-continuity-state', 'operator', 'other_recovery_owner',
              'Unrelated recovery work')
    `).run();
    db.raw.prepare(`
      INSERT INTO recovery_runs (trigger, recovery_plan_id, status)
      VALUES ('continuity_gap_absent', 'foreign-continuity-state', 'started')
    `).run();

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.degradation_causes).toContain('continuity_gap_unreadable');
    expect(json.continuity).toEqual({
      readable: false,
      open: 0,
      unresolved: 0,
      ambiguous: 0,
    });
    expect(body).not.toContain('foreign-continuity-state');
    expect(body).not.toContain('other_recovery_owner');
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

  it('reports unhealthy when the database schema is newer than this binary', async () => {
    db.raw.prepare('INSERT INTO schema_migrations(version) VALUES (?)')
      .run(CURRENT_SCHEMA_MIGRATION + 1);

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(503);
    expect(json.status).toBe('unhealthy');
    expect(json.sqlite.schema_migration_latest).toBe(CURRENT_SCHEMA_MIGRATION + 1);
    expect(json.sqlite.schema_migration_required).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_ready).toBe(false);
  });

  it('surfaces a queued Chat compatibility rejection in the health body', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'unhealthy',
          details: {
            queue: { activeChats: 0, queuedChats: 0 },
            databaseCompatibility: {
              reason: 'invalid_schema',
              observedMigration: 44,
              requiredMigration: 44,
              dbPath: '/private/runtime/bot.db',
              chatJid: '15551230008@s.whatsapp.net',
              message: 'private prompt text',
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(503);
    expect(json.status).toBe('unhealthy');
    expect(json.runtime.chat.database_compatibility).toEqual({
      reason: 'invalid_schema',
      observed_migration: 44,
      required_migration: 44,
    });
    expect(body).not.toContain('/private/runtime/bot.db');
    expect(body).not.toContain('15551230008@s.whatsapp.net');
    expect(body).not.toContain('private prompt text');
    db2.close();
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
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.runtime).toEqual({
      agent: { sessions: 2, compact: { lastError: 'timeout' } },
    });
    db2.close();
  });

  it('degrades agent health when turn capability reports a broken primary model', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: false,
              modelUsabilityStatus: 'model-unavailable',
              lastSuccessfulTurnAt: null,
              lastTurnErrorClass: 'model-unavailable',
              lastTurnErrorAt: 1_781_316_000_000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.turn_capability).toEqual({
      model_usable: false,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'model-unavailable',
      last_successful_turn_at: null,
      last_turn_error_class: 'model-unavailable',
      last_turn_error_at: 1_781_316_000_000,
    });
    db2.close();
  });

  it('keeps agent health healthy when turn capability has recovered', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: true,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: 1_781_316_030_000,
              lastTurnErrorClass: null,
              lastTurnErrorAt: null,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.turn_capability).toEqual({
      model_usable: true,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'usable',
      last_successful_turn_at: 1_781_316_030_000,
      last_turn_error_class: null,
      last_turn_error_at: null,
    });
    db2.close();
  });

  it('keeps agent health healthy on a boot empty-output artifact before the first successful turn', async () => {
    // Regression: the boot/recovery sequence stamps lastTurnErrorClass='empty-output'
    // ~1s after restart while the bot is idle. Because lastSuccessfulTurnAt stays null
    // (no real turn yet) the sticky flag never clears, falsely degrading the instance
    // forever. A genuinely-broken model is still caught independently via
    // model_usable===false (the usability probe), so empty-output before the first
    // proven turn must NOT degrade health.
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,            // probe not (yet) flagging the model
              modelUsabilityStatus: 'unknown',
              lastSuccessfulTurnAt: null,   // never proven a turn → boot artifact
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: 1_781_316_000_000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.turn_capability).toEqual({
      model_usable: null,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'unknown',
      last_successful_turn_at: null,
      last_turn_error_class: 'empty-output',
      last_turn_error_at: 1_781_316_000_000,
    });
    db2.close();
  });

  it('degrades agent health on a CURRENT, SUSTAINED empty-output stall after a successful turn (#1433)', async () => {
    // A real regression: a turn proved out, then empty-output came after it and has
    // persisted past the debounce but is still recent (within the staleness bound).
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 5 * 60 * 1000,
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: now - 3 * 60 * 1000, // 3m old: past 1m debounce, under 15m stale
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    db2.close();
  });

  it('keeps agent health healthy on a STALE idle empty-output after a successful turn (#1433 idle-stuck self-clear)', async () => {
    // rb-bot/mini7: one empty-output turn after a success, then the bot went idle.
    // With no further turns the trailing error never clears; previously this pinned
    // the instance to degraded forever. A stale (idle, >15m old) empty-output is a
    // benign artifact and must self-clear; a genuinely-broken model is still caught
    // independently via model_usable===false.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 92 * 60 * 1000,
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: now - 90 * 60 * 1000, // 90m idle → stale → benign
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    db2.close();
  });

  it('keeps agent health healthy when an empty-output is superseded by a later success (#1433 flap kill)', async () => {
    // ar-bot/mini2: empty/success turns alternate. Once a success lands AFTER the
    // empty-output, the model has recovered — health must not flap to degraded.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: true,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 30 * 1000, // success came AFTER the error
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: now - 90 * 1000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    db2.close();
  });

  it('keeps agent health healthy on a fresh empty-output within the debounce window (#1433 transient damp)', async () => {
    // A single just-now empty-output that has not yet persisted past the debounce
    // must not trip degraded — the next turn is given a chance to succeed.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 2 * 60 * 1000,
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: now - 10 * 1000, // 10s old: still inside the 1m debounce
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    db2.close();
  });

  it('keeps agent health healthy on a STALE transient-network blip with no successful turn since (B21-D)', async () => {
    // W1-T6 regression: adding 'transient-network' to HEALTH_TURN_ERROR_CLASSES
    // made a single self-resolved network blip degrade /health immediately and
    // indefinitely — an idle bot has no later turn to clear the trailing error.
    // failure-taxonomy documents transient-network as needing no provider-level
    // action; it must get the same staleness self-clear empty-output has.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 92 * 60 * 1000,
              lastTurnErrorClass: 'transient-network',
              lastTurnErrorAt: now - 90 * 60 * 1000, // 90m idle → stale → benign
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    // Visibility (the W1-T6 intent) is preserved: the class still surfaces.
    expect(json.turn_capability.last_turn_error_class).toBe('transient-network');
    db2.close();
  });

  it('keeps agent health healthy on a STALE server-error with no successful turn since (B21-D)', async () => {
    // Same W1-T6 regression for the second backfilled class: one 5xx blip must
    // not pin an idle instance degraded for hours.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 92 * 60 * 1000,
              lastTurnErrorClass: 'server-error',
              lastTurnErrorAt: now - 90 * 60 * 1000, // 90m idle → stale → benign
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.turn_capability.last_turn_error_class).toBe('server-error');
    db2.close();
  });

  it('degrades agent health on a CURRENT, SUSTAINED transient-network failure after a successful turn (B21-D parity)', async () => {
    // Parity with empty-output (#1433): a transient-network error that came after
    // a proven turn and persisted past the debounce but is still recent (inside
    // the staleness bound) is a live stall and must degrade.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 5 * 60 * 1000,
              lastTurnErrorClass: 'transient-network',
              lastTurnErrorAt: now - 3 * 60 * 1000, // 3m old: past 1m debounce, under 15m stale
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    db2.close();
  });

  it('keeps agent health healthy on a fresh transient-network error within the debounce window (B21-D damp)', async () => {
    // A single just-now network blip that has not yet persisted past the debounce
    // must not trip degraded — the next turn is given a chance to succeed.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 2 * 60 * 1000,
              lastTurnErrorClass: 'transient-network',
              lastTurnErrorAt: now - 10 * 1000, // 10s old: still inside the 1m debounce
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    db2.close();
  });

  it('degrades agent health on a non-transient error class even before the first successful turn', async () => {
    // The boot-grace relaxation is scoped to the transient self-clearing classes
    // (empty-output, transient-network, server-error) ONLY. A real provider
    // failure at boot (e.g. auth-required) must still degrade.
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'unknown',
              lastSuccessfulTurnAt: null,
              lastTurnErrorClass: 'auth-required',
              lastTurnErrorAt: 1_781_316_000_000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    db2.close();
  });

  it('sanitizes agent turn capability strings before exposing them in health', async () => {
    db.close();
    const db2 = makeDb();
    const rawProviderText = 'selected model raw provider diagnostic should not appear';
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: false,
              modelUsabilityStatus: rawProviderText,
              lastSuccessfulTurnAt: null,
              lastTurnErrorClass: rawProviderText,
              lastTurnErrorAt: 1_781_316_000_000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.turn_capability).toEqual({
      model_usable: false,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: null,
      last_successful_turn_at: null,
      last_turn_error_class: null,
      last_turn_error_at: 1_781_316_000_000,
    });
    expect(json.runtime.agent.turnCapability).toEqual({
      modelUsable: false,
      modelUsableStale: null,
      modelUsableCheckedAt: null,
      modelUsabilityStatus: null,
      lastSuccessfulTurnAt: null,
      lastTurnErrorClass: null,
      lastTurnErrorAt: 1_781_316_000_000,
    });
    expect(body).not.toContain(rawProviderText);
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
      { caller: 'health' }, // QR-086: admin /send tags itself a system caller
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
      { caller: 'health' }, // QR-086: admin /send tags itself a system caller
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

  it('returns a 500 JSON response when /heal persistence unexpectedly fails', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));
    db.raw.prepare('DROP TABLE pending_heal_reports').run();

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ reportId: 'report-db-failure', type: 'service_crash' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: 'internal error' });
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

  it('returns a 500 JSON response when /access persistence unexpectedly fails', async () => {
    const handleAccessDecision = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, { handleAccessDecision })));
    db.raw.prepare('DROP TABLE access_list').run();

    const { status, body } = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: '15551234567', action: 'allow' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: 'internal error' });
    expect(handleAccessDecision).not.toHaveBeenCalled();
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
    // `remote` reaches the HTTP body because the handler serialises the result
    // verbatim; no socket and no messages means there was no receipt to send.
    expect(JSON.parse(body)).toEqual({
      ok: true,
      jid: '15551234567@s.whatsapp.net',
      conversation_key: '15551234567',
      remote: 'nothing_to_ack',
    });
    const row = db.raw
      .prepare('SELECT unread_count FROM chats WHERE conversation_key = ?')
      .get('15551234567') as { unread_count: number };
    expect(row.unread_count).toBe(0);
  });

  it('returns a 500 JSON response when /mark-read persistence unexpectedly fails', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));
    db.raw.prepare('DROP TABLE chats').run();

    const { status, body } = await httpReq(
      port,
      '/mark-read',
      'POST',
      JSON.stringify({ conversation_key: '15551234567' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: 'internal error' });
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
    delete process.env.WHATSOUP_HEALTH_UNSAFE_REMOTE;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('defaults to 127.0.0.1 when HEALTH_BIND_ADDRESS is not set', async () => {
    delete process.env.HEALTH_BIND_ADDRESS;
    db = makeDb();
    ({ server, port } = await buildTestServer(makeDeps(db)));
    const addr = server.address();
    expect(typeof addr === 'object' && addr !== null ? addr.address : '').toBe('127.0.0.1');
  });

  it('binds to 0.0.0.0 when HEALTH_BIND_ADDRESS=0.0.0.0 AND WHATSOUP_HEALTH_UNSAFE_REMOTE=1', async () => {
    process.env.HEALTH_BIND_ADDRESS = '0.0.0.0';
    process.env.WHATSOUP_HEALTH_UNSAFE_REMOTE = '1'; // R7a: explicit opt-in required for a non-loopback bind
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

  it('R7a: refuses to start with HEALTH_BIND_ADDRESS=0.0.0.0 and no WHATSOUP_HEALTH_UNSAFE_REMOTE override', async () => {
    process.env.HEALTH_BIND_ADDRESS = '0.0.0.0';
    delete process.env.WHATSOUP_HEALTH_UNSAFE_REMOTE;
    db = makeDb();
    const { startHealthServer } = await import('../../src/core/health.ts');
    expect(() => startHealthServer(makeDeps(db))).toThrow(/non-loopback/i);
  });
});

// ---------------------------------------------------------------------------
// Additional branch coverage — uncovered paths
// ---------------------------------------------------------------------------

describe('GET /health — branch coverage: empty-body safeDbQuery fallbacks and null guards', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  afterEach(async () => {
    if (db) db.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('safeDbQuery returns fallback when the callback throws', async () => {
    // Drop schema_migrations so the COALESCE query still works but messages table breaks
    db.raw.exec('DROP TABLE messages');
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/health', 'GET');
    // Doesn't crash — returns fallback 0 for messages_total
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.sqlite.messages_total).toBe(0);
  });

  it('returns zero messages_total when messages table returns null row', async () => {
    // db is intact, just no messages
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    expect(JSON.parse(body).sqlite.messages_total).toBe(0);
  });

  it('classifies "cooldown" connection state as recovering (degraded not unhealthy)', async () => {
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
          state: 'cooldown',
          connected: false,
          reconnectAttempts: 5,
          reconnectPhase: 'cooldown',
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: '2026-06-09T12:00:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          recentDisconnects: {
            windowMs: 600_000,
            count: 0,
            lastAt: null,
            lastReason: null,
            lastStatusCode: null,
            byReason: {},
          },
          credentialLifecycle: null,
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('degraded');
    expect(JSON.parse(body).whatsapp.connection.state).toBe('cooldown');
    db2.close();
  });

  it('classifies device_removed reason as serverside_logout_irreversible', async () => {
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
          lastDisconnectReason: 'device_removed_all',
          lastStatusCode: null,
          recentDisconnects: {
            windowMs: 600_000,
            count: 0,
            lastAt: null,
            lastReason: null,
            lastStatusCode: null,
            byReason: {},
          },
          credentialLifecycle: null,
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.whatsapp.connection.auth_failure_class).toBe('serverside_logout_irreversible');
    db2.close();
  });

  it('classifies multidevice_mismatch disconnect when status code indicates it', async () => {
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
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: '2026-06-09T12:00:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: 'deviceReplaced',
          lastStatusCode: 411,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastQrAt: null,
            lastOpenAt: '2026-06-09T11:00:00.000Z',
          },
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connection.disconnect_class).toBe('multidevice_mismatch');
    db2.close();
  });

  it('exposes empty_hash true when auth bond creds sha256 matches the empty-file SHA', async () => {
    db.close();
    const db2 = makeDb();
    const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
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
            creds: {
              path: '/auth/creds.json',
              exists: true,
              mode: '600',
              size: 0,
              mtime: '2026-06-09T12:00:00.000Z',
              sha256: EMPTY_SHA256,
            },
          }),
          credentialLifecycle: { lastQrAt: null, lastOpenAt: '2026-06-09T12:00:00.000Z' },
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.whatsapp.auth_bond.creds.empty_hash).toBe(true);
    db2.close();
  });

  it('isFreshInvalidCredentialWriteInFlight returns false when creds have no mtime', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T12:00:05Z'));
    try {
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
              status: 'invalid',
              issues: ['creds_json_empty'],
              creds: {
                path: '/auth/creds.json',
                exists: true,
                mode: '600',
                size: 0,
                mtime: null, // no mtime — grace window cannot apply
                sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            }),
          }),
        },
      } as any);
      ({ server, port } = await buildTestServer(deps));

      const { status, body } = await httpReq(port, '/health', 'GET');
      const json = JSON.parse(body);
      // Not in grace window → classified as local_corruption (backup present → restorable)
      expect(status).toBe(200);
      expect(json.whatsapp.connection.auth_failure_class).toBe('local_corruption_restorable');
      db2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('isFreshInvalidCredentialWriteInFlight returns false when mtime is non-parseable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T12:00:05Z'));
    try {
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
              status: 'invalid',
              issues: ['creds_json_invalid_json'],
              creds: {
                path: '/auth/creds.json',
                exists: true,
                mode: '600',
                size: 2,
                mtime: 'not-a-date', // NaN from Date.parse
                sha256: 'a'.repeat(64),
              },
            }),
          }),
        },
      } as any);
      ({ server, port } = await buildTestServer(deps));

      const { status, body } = await httpReq(port, '/health', 'GET');
      const json = JSON.parse(body);
      // Non-finite mtime → not in grace window → local_corruption
      expect(status).toBe(200);
      expect(json.whatsapp.connection.auth_failure_class).toBe('local_corruption_restorable');
      db2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizeAgentTurnCapability returns null when details has no turnCapability key', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            // No turnCapability field
            activeSessions: 2,
          },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // No turnCapability → null
    expect(json.turn_capability).toBeNull();
    db2.close();
  });

  it('agentRuntimeDetailsForHealth passes through details unchanged when turnCapability is null', async () => {
    db.close();
    const db2 = makeDb();
    // Provide a runtime snapshot with a turnCapability key but non-record value
    // so normalizeAgentTurnCapability returns null, then agentRuntimeDetailsForHealth
    // substitutes null (the turnCapability: null branch)
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: 'not-a-record', // passes !isRecord → normalizeAgentTurnCapability returns null
            activeSessions: 1,
          },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.turn_capability).toBeNull();
    // turnCapability key present in details but non-record → substituted with null
    expect(json.runtime.agent.turnCapability).toBeNull();
    db2.close();
  });

  it('runtime snapshot degraded does NOT override an already-degraded status', async () => {
    // The snap.status === 'degraded' && status === 'healthy' branch:
    // if status is already 'degraded' (not 'healthy'), that branch is skipped
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      getEnrichmentStats: vi.fn().mockReturnValue({
        lastRun: '2000-01-01T00:00:00.000Z', // stale → status becomes 'degraded' before runtimeBlock
        unprocessed: 0,
        runtimeDegraded: false,
      }),
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'degraded',
          details: { turnCapability: null, activeSessions: 1 },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('degraded');
    db2.close();
  });

  it('chat runtime runtimeBlock uses zero when queue fields are absent', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'chat',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          // No queue key in details → activeChats/queuedChats both undefined
          details: {},
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.runtime.chat.queueDepth).toBe(0);
    db2.close();
  });

  it('fallbackState null fields resolve to null/false in instance block', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: { activeSessions: 1 },
        }),
        getFallbackState: () => ({
          effectiveProvider: 'claude',
          fallbackActiveUntil: null,
          fallbackReason: null,    // → null branch
          fallbackModel: null,     // → null branch
          fallbackResetAt: null,   // → null branch
          fallbackRecoveryProbeRequired: null, // → false branch
        }),
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.instance.effectiveProvider).toBe('claude');
    expect(json.instance.fallbackReason).toBeNull();
    expect(json.instance.fallbackModel).toBeNull();
    expect(json.instance.fallbackResetAt).toBeNull();
    expect(json.instance.fallbackRecoveryProbeRequired).toBe(false);
    db2.close();
  });
});

describe('server on("error") handler', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;

  afterEach(async () => {
    if (db) db.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('emits EADDRINUSE without crashing when the port is already bound', async () => {
    db = makeDb();
    // Bind a server on port 0 to hold an ephemeral port
    const blocker = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const blockerAddr = blocker.address() as { port: number };

    const { startHealthServer } = await import('../../src/core/health.ts');
    server = startHealthServer(makeDeps(db));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Re-listen on the already-occupied port — should emit 'error' with code EADDRINUSE
    let emittedError: Error | null = null;
    server.once('error', (err) => { emittedError = err; });
    await new Promise<void>((resolve) => {
      server.listen(blockerAddr.port, '127.0.0.1', () => resolve());
      // The error may fire before the listen callback
      server.once('error', () => resolve());
    });

    // Cleanup blocker
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    expect(emittedError).not.toBeNull();
    expect((emittedError as unknown as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
  });

  it('emits non-EADDRINUSE error events without crashing', async () => {
    db = makeDb();
    const { startHealthServer } = await import('../../src/core/health.ts');
    server = startHealthServer(makeDeps(db));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Emit a synthetic non-EADDRINUSE error through the server's event system
    let caught: Error | null = null;
    server.once('error', (err) => { caught = err; });
    const syntheticErr = Object.assign(new Error('synthetic network error'), { code: 'ECONNRESET' });
    server.emit('error', syntheticErr);

    expect(caught).toBe(syntheticErr);
  });
});

describe('POST /agent/compact — empty body treated as {}', () => {
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

  it('treats an empty body as {} and dispatches compact with default options', async () => {
    const handleAgentCommand = vi.fn().mockResolvedValue({ ok: true, command: 'compact' });
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: { handleAgentCommand } as any,
    })));

    // Send a truly empty body (no bytes)
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port,
        path: '/agent/compact',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': 'Bearer secret-token',
          'Content-Length': '0',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      req.end();
    });

    expect(result.status).toBe(200);
    expect(handleAgentCommand).toHaveBeenCalledWith({ command: 'compact', silent: true });
  });
});

describe('POST /heal — readBody error path', () => {
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

  it('returns 413 when /heal body exceeds the size limit via readBody', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ type: 'service_crash', pad: 'x'.repeat(70_000) }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(413);
    expect(JSON.parse(body)).toMatchObject({ error: 'request body too large' });
  });

  it('uses context field as fallback when errorHint is absent', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ type: 'service_crash', context: 'systemd-restart' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(202);
    const json = JSON.parse(body);
    expect(typeof json.reportId).toBe('string');
    expect(typeof json.errorClass).toBe('string');
  });

  it('generates a fresh UUID when reportId is absent', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ type: 'service_crash' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(202);
    const json = JSON.parse(body);
    // UUID v4 format
    expect(json.reportId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe('GET /health — normalizeBooleanOrNull and normalizeNumberOrNull non-type paths', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  afterEach(async () => {
    if (db) db.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('normalizes non-boolean modelUsable and non-finite lastSuccessfulTurnAt to null', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: 'yes',        // non-boolean → null
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: Infinity, // non-finite → null
              lastTurnErrorClass: null,
              lastTurnErrorAt: NaN,      // non-finite → null
            },
          },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.turn_capability).toEqual({
      model_usable: null,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'usable',
      last_successful_turn_at: null,
      last_turn_error_class: null,
      last_turn_error_at: null,
    });
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// health.ts lower-branch coverage (74-549)
// ---------------------------------------------------------------------------

describe('health.ts lower-branch coverage (74-549)', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  afterEach(async () => {
    if (db) db.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // --- line 273: getConnectionState() synthetic fallback, cfg.authDir falsy
  //     → creds.path === 'unknown' (the false branch of `cfg.authDir ? ... : 'unknown'`)
  it('reports creds.path "unknown" when connectionManager lacks getConnectionState and config has no authDir (line 273)', async () => {
    // connectionManager WITHOUT getConnectionState → triggers the synthetic state branch.
    // The mocked config (top of this file) does not set authDir, so cfg.authDir is undefined.
    const deps = makeDeps(db);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // currentAuthBond is nested under credential_lifecycle in the synthetic snapshot.
    expect(json.whatsapp.credential_lifecycle.currentAuthBond.status).toBe('missing');
    expect(json.whatsapp.credential_lifecycle.currentAuthBond.issues)
      .toEqual(['connection_manager_does_not_expose_auth_bond']);
    // The false branch of line 273's ternary — authDir is unset.
    expect(json.whatsapp.credential_lifecycle.currentAuthBond.creds.path).toBe('unknown');
    expect(json.whatsapp.credential_lifecycle.currentAuthBond.authDir.path).toBe('unknown');
  });

  // --- line 335: formatAuthBond hash nullish branch — creds.sha256 === null.
  //     Snapshot is connected so /health returns 200 (formatAuthBond is reached on
  //     every code path; the disconnected snapshot it was previously written with
  //     mapped to unhealthy/503, which is what the assertion under test cares about).
  it('renders auth_bond.creds.hash as null when creds.sha256 is null (line 335)', async () => {
    const deps = makeDeps(db, {
      connectionManager: {
        botJid: null,
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
          recentDisconnects: {
            windowMs: 600_000, count: 0, lastAt: null, lastReason: null, lastStatusCode: null, byReason: {},
          },
          authBond: makeAuthBond({
            creds: { path: '/auth/creds.json', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:00:00.000Z', sha256: null },
          }),
          credentialLifecycle: null,
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // Line 335 false branch: `authBond.creds.sha256?.slice(0, 20) ?? null` → null.
    expect(json.whatsapp.auth_bond.creds.hash).toBeNull();
    // empty_hash is `sha256 === EMPTY_SHA256`; null !== EMPTY_SHA256 so false.
    expect(json.whatsapp.auth_bond.creds.empty_hash).toBe(false);
  });

  // --- line 151: normalizeAgentTurnCapability(null) — the `if (!details) return null`
  //     branch. `details` is null when the agent runtime exposes no snapshot (no
  //     `deps.runtime`). We keep `instanceType: 'agent'` so line 909-910 reaches
  //     normalizeAgentTurnCapability with `runtimeSnapshot?.details ?? null` = null.
  it('nulls turn_capability when agent runtime exposes no details (line 151)', async () => {
    const deps = makeDeps(db, {
      instanceType: 'agent',
      // No `runtime` override → deps.runtime is undefined → runtimeSnapshot is null
      // → `runtimeSnapshot?.details ?? null` is null → line 151 `if (!details) return null`.
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // turnCapability is null → not degraded, and the field surfaces as null.
    expect(json.turn_capability).toBeNull();
    // Concrete shape check: the field is present-and-null (not absent), and the
    // handler still produced a well-formed 200 health payload with a string status.
    expect(json).toMatchObject({ turn_capability: null });
    expect(typeof json.status).toBe('string');
  });

  // --- line 431 is structurally unreachable: classifyDisconnect() calls
  //     decideDisconnectAction(statusCode) with NO context, so restartRequiredCount
  //     is always undefined → count 0 → never ≥ 10 → 'restart-required-flapping'
  //     is never returned. Documented below as a "lines not reached" item; we instead
  //     assert the reachable reconnect-classification paths through classifyDisconnect
  //     (line 427) to keep the suite honest without asserting unreachable behaviour.

  // --- line 427 + 431 reachable-coverage note: confirm restartRequired (515) maps to
  //     restart_required and that flapping can never be produced via /health.
  it('maps a restartRequired status code to restart_required (classifyDisconnect reconnect branch, line 427)', async () => {
    const deps = makeDeps(db, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'reconnecting',
          connected: false,
          reconnectAttempts: 1,
          reconnectPhase: 'retry',
          stateChangedAt: '2026-06-09T12:10:00.000Z',
          firstFailureAt: '2026-06-09T12:10:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: 'restartRequired',
          lastStatusCode: 515,
          recentDisconnects: {
            windowMs: 600_000, count: 0, lastAt: null, lastReason: null, lastStatusCode: null, byReason: {},
          },
          authBond: makeAuthBond(),
          credentialLifecycle: null,
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // Line 427 (action.type === 'reconnect') entered; line 430 (restart-required) returns.
    expect(json.whatsapp.connection.disconnect_class).toBe('restart_required');
  });
});

// ---------------------------------------------------------------------------
// health.ts upper-branch coverage (624-1020)
// ---------------------------------------------------------------------------

describe('health.ts upper-branch coverage (624-1020)', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    // Token is set so requireAuth() runs; each test chooses whether to send
    // the Authorization header.
    process.env.WHATSOUP_HEALTH_TOKEN = 'secret-token';
  });

  afterEach(async () => {
    if (db) db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // --- line 624: `if (!requireAuth(req, res)) return;` inside POST /heal.
  //     Token set, no Authorization header → 401 + no heal report stored.
  it('POST /heal rejects with 401 and stores nothing when auth is missing (line 624)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ type: 'service_crash' }),
    );

    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
    const cnt = db.raw
      .prepare('SELECT COUNT(*) AS c FROM pending_heal_reports')
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  // --- line 709: `if (!requireAuth(req, res)) return;` inside POST /access.
  it('POST /access rejects with 401 and writes no access_list row when auth is missing (line 709)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: '15550000001@s.whatsapp.net', action: 'allow' }),
    );

    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
    const cnt = db.raw
      .prepare('SELECT COUNT(*) AS c FROM access_list')
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  // --- line 801: `if (!requireAuth(req, res)) return;` inside POST /mark-read.
  it('POST /mark-read rejects with 401 when auth is missing (line 801)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/mark-read',
      'POST',
      JSON.stringify({ conversation_key: '15550000001@s.whatsapp.net' }),
    );

    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  // --- line 772: the `'blocked' as const` arm of
  //     `action === 'allow' ? 'allowed' as const : 'blocked' as const`.
  //     Existing tests only exercise `allow`; this hits the `block` path and
  //     confirms the access_list row is persisted as `blocked`.
  it('POST /access with action=block stores status "blocked" (line 772 block-branch)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'group', subjectId: '1111111000000000@g.us', action: 'block' }),
      { authorization: 'Bearer secret-token' },
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      ok: true,
      action: 'block',
      subjectType: 'group',
      subjectId: '1111111000000000@g.us',
      result: 'inserted',
    });
    const row = db.raw
      .prepare('SELECT subject_type, subject_id, status FROM access_list WHERE subject_id = ?')
      .get('1111111000000000@g.us');
    expect(row).toEqual({
      subject_type: 'group',
      subject_id: '1111111000000000@g.us',
      status: 'blocked',
    });
  });

  // --- lines 908 + 910: agent-instance path with a REAL runtime snapshot.
  //     `deps.instanceType === 'agent'` AND `deps.runtime` is set, so
  //     runtimeSnapshot is non-null and line 908 reads `runtimeSnapshot.status`
  //     while line 910 calls normalizeAgentTurnCapability(details) with real
  //     details. (The lower-coverage block only reaches 908/910 with a null
  //     snapshot; this exercises the truthy-snapshot branches.)
  it('GET /health surfaces agentRuntimeStatus and turn_capability from a healthy agent runtime snapshot (lines 908, 910, 1020)', async () => {
    const deps = makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: true,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: 1_700_000_000_000,
              lastTurnErrorClass: null,
              lastTurnErrorAt: null,
            },
          },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);

    // Line 908 truthy branch: agentRuntimeStatus === 'healthy' → overall
    // status stays 'healthy' (not unhealthy).
    expect(json.status).toBe('healthy');
    // Line 910 truthy branch: turn_capability was normalized from real details.
    expect(json.turn_capability).toEqual({
      model_usable: true,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'usable',
      last_successful_turn_at: 1_700_000_000_000,
      last_turn_error_class: null,
      last_turn_error_at: null,
    });
    // Line 1020 branch: agent runtime block was populated.
    expect(json.runtime).toMatchObject({
      agent: {
        turnCapability: {
          modelUsable: true,
          modelUsabilityStatus: 'usable',
          lastSuccessfulTurnAt: 1_700_000_000_000,
          lastTurnErrorClass: null,
          lastTurnErrorAt: null,
        },
      },
    });
  });

  // --- line 1006: `else if (snap.status === 'degraded' && status === 'healthy')`
  //     — a degraded runtime snapshot downgrades an otherwise-healthy instance
  //     to 'degraded'. Requires an agent/passive/chat instance that is connected
  //     (so the base status computes to 'healthy') plus a runtime reporting
  //     'degraded'.
  it('GET /health downgrades a healthy connection to degraded when the runtime snapshot is degraded (line 1006)', async () => {
    // Base status must compute to 'healthy' (connected socket + migrated db) so
    // that the line-1006 `&& status === 'healthy'` guard is satisfied and the
    // degraded runtime snapshot is what flips the overall status.
    // A 'chat' instance: agentRuntimeStatus is null (agent-only), so a degraded
    // runtime snapshot is NOT folded into the status during the main status
    // computation. The base status therefore stays 'healthy' until line 1006,
    // where snap.status === 'degraded' downgrades it.
    const deps = makeDeps(db, {
      instanceType: 'chat',
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
        }),
      } as unknown as ConnectionManager,
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'degraded',
          details: { queue: { activeChats: 0, queuedChats: 0 } },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    // 'degraded' is a 200, not a 503.
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // The connection itself is healthy; only the degraded runtime snapshot
    // downgrades the overall status via line 1006.
    expect(json.whatsapp.connected).toBe(true);
    expect(json.status).toBe('degraded');
    // Concrete: chat runtime block still populated via the line-1011 branch.
    expect(json.runtime).toMatchObject({ chat: { queueDepth: 0 } });
  });

  // --- line 1020 else: a runtime snapshot present but instanceType is none of
  //     passive/chat/agent leaves runtimeBlock as {} (no runtime block emitted).
  it('GET /health leaves runtimeBlock empty for an unrecognized instanceType (line 1020 else)', async () => {
    const deps = makeDeps(db, {
      instanceType: 'primary-line',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: { socket: 'ready' },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await httpReq(port, '/health', 'GET');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // None of passive/chat/agent matched, so runtime stays an empty object.
    expect(json.runtime).toEqual({});
  });

  // #1753 rem-1: in-process event-loop-lag self-probe. A wedged loop makes
  // /health unanswerable, so nothing in THIS handler can detect a wedge in
  // progress — the sampler's own timer gives it a memory of recent lag that
  // survives into whichever request the loop is next free enough to answer.
  // This describe follows the enclosing block's convention: beforeEach only
  // creates `db`; each test builds its own server explicitly.
  describe('#1753 rem-1: event-loop-lag self-probe', () => {
    // This describe's own beforeEach (line ~3674) doesn't clear mockHealthLogger —
    // it wasn't tracked before #1753. Clear it locally so each test here only
    // sees warn calls from its OWN request, not ones left over from a sibling.
    beforeEach(() => {
      mockHealthLogger.warn.mockClear();
    });

    function fakeLoopLagSampler(snapshot: { sampleCount: number; p95LagMs: number | null; locallyStarved: boolean }) {
      return {
        start: vi.fn(),
        stop: vi.fn(),
        snapshot: vi.fn().mockReturnValue(snapshot),
      };
    }

    it('exposes a well-shaped event_loop block with the real sampler by default', async () => {
      ({ server, port } = await buildTestServer(makeDeps(db)));

      const { status, body } = await httpReq(port, '/health', 'GET');
      expect(status).toBe(200);
      const json = JSON.parse(body);
      expect(json.event_loop).toMatchObject({
        sample_count: expect.any(Number),
        locally_starved: false,
        starvation_threshold_ms: 250,
      });
      expect(json.event_loop.lag_p95_ms === null || typeof json.event_loop.lag_p95_ms === 'number').toBe(true);
    });

    it('folds a starved sampler snapshot into the event_loop body and degrades status', async () => {
      const sampler = fakeLoopLagSampler({ sampleCount: 20, p95LagMs: 412, locallyStarved: true });
      const deps = makeDeps(db, { loopLagSampler: sampler as any });
      ({ server, port } = await buildTestServer(deps));

      const { status, body } = await httpReq(port, '/health', 'GET');
      const json = JSON.parse(body);
      expect(status).toBe(200); // degraded, not unhealthy — the connection itself is fine
      expect(json.status).toBe('degraded');
      expect(json.event_loop).toEqual({
        lag_p95_ms: 412,
        sample_count: 20,
        locally_starved: true,
        starvation_threshold_ms: 250,
      });
    });

    it('logs a warning when the sampler reports local starvation', async () => {
      const sampler = fakeLoopLagSampler({ sampleCount: 20, p95LagMs: 500, locallyStarved: true });
      const deps = makeDeps(db, { loopLagSampler: sampler as any });
      ({ server, port } = await buildTestServer(deps));

      await httpReq(port, '/health', 'GET');
      expect(mockHealthLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ p95LagMs: 500, sampleCount: 20, thresholdMs: 250 }),
        'event loop starvation detected during health check',
      );
    });

    it('does not log a starvation warning when the sampler is not starved', async () => {
      const sampler = fakeLoopLagSampler({ sampleCount: 3, p95LagMs: 10, locallyStarved: false });
      const deps = makeDeps(db, { loopLagSampler: sampler as any });
      ({ server, port } = await buildTestServer(deps));

      await httpReq(port, '/health', 'GET');
      expect(mockHealthLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'event loop starvation detected during health check',
      );
    });

    it('stops the injected sampler when the server closes', async () => {
      const sampler = fakeLoopLagSampler({ sampleCount: 0, p95LagMs: null, locallyStarved: false });
      const deps = makeDeps(db, { loopLagSampler: sampler as any });
      ({ server, port } = await buildTestServer(deps));
      expect(sampler.start).toHaveBeenCalled();

      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(sampler.stop).toHaveBeenCalled();
    });
  });

  // #1753 rem-2: MCP tool-call liveness. Exposition only — deliberately does
  // NOT affect `status` (no corroborated evidence yet for what "too long" is
  // for every tool), unlike the loop-lag block above.
  describe('#1753 rem-2: MCP liveness in /health', () => {
    it('exposes mcp_liveness as null for a non-agent instance', async () => {
      ({ server, port } = await buildTestServer(makeDeps(db)));

      const { status, body } = await httpReq(port, '/health', 'GET');
      expect(status).toBe(200);
      expect(JSON.parse(body).mcp_liveness).toBeNull();
    });

    it('exposes mcp_liveness as null when the agent runtime does not implement getMcpLivenessSnapshot', async () => {
      const deps = makeDeps(db, {
        instanceType: 'agent',
        runtime: {
          getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: { active: true } }),
        } as any,
      });
      ({ server, port } = await buildTestServer(deps));

      const { body } = await httpReq(port, '/health', 'GET');
      expect(JSON.parse(body).mcp_liveness).toBeNull();
    });

    it('surfaces pending_count/oldest_call_age_ms/oldest_call_tool from the agent runtime', async () => {
      const deps = makeDeps(db, {
        instanceType: 'agent',
        runtime: {
          getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: { active: true } }),
          getMcpLivenessSnapshot: () => ({
            pendingCount: 2,
            oldestCallAgeMs: 45_000,
            oldestCallTool: 'send_message',
          }),
        } as any,
      });
      ({ server, port } = await buildTestServer(deps));

      const { status, body } = await httpReq(port, '/health', 'GET');
      const json = JSON.parse(body);
      expect(status).toBe(200);
      expect(json.status).toBe('healthy');
      expect(json.mcp_liveness).toEqual({
        pending_count: 2,
        oldest_call_age_ms: 45_000,
        oldest_call_tool: 'send_message',
      });
    });

    it('does not degrade status on its own, however old the oldest in-flight call is (exposition only)', async () => {
      const deps = makeDeps(db, {
        instanceType: 'agent',
        runtime: {
          getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: { active: true } }),
          getMcpLivenessSnapshot: () => ({
            pendingCount: 1,
            oldestCallAgeMs: 6 * 60 * 60 * 1000, // 6h — pathological, still exposition-only
            oldestCallTool: 'send_message',
          }),
        } as any,
      });
      ({ server, port } = await buildTestServer(deps));

      const { body } = await httpReq(port, '/health', 'GET');
      expect(JSON.parse(body).status).toBe('healthy');
    });
  });
});
