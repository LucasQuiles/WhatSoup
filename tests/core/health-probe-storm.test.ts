/**
 * Health-probe error-storm bounding — issue #1778, Defect B.
 *
 * A permanent schema error (`no such table: pending_polls`) hit by a health
 * probe was re-logged on every ~5 s poll forever (24,613 lines over 34 h in one
 * observed instance). These tests pin the bound: the probe still latches the
 * instance into `degraded`, but the log emission is throttled to O(log N) via a
 * power-of-two schedule instead of one-line-per-poll.
 */
import { createServer, request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock config + logger exactly like health.test.ts so health.ts imports ──
vi.mock('../../src/config.ts', () => ({
  config: {
    get healthBindAddress(): string {
      return process.env.HEALTH_BIND_ADDRESS ?? '127.0.0.1';
    },
    adminPhones: new Set(['15550100001']),
    controlPeers: new Map<string, string>(),
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-health-probe-storm/tmp',
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

const healthLogger = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));

vi.mock('../../src/logger.ts', async () => {
  const { componentLoggerMock, loggerMock } = await import('../helpers/logger-mock.ts');
  const { log, createChildLogger } = componentLoggerMock('health', () => loggerMock().createChildLogger());
  Object.assign(healthLogger, log);
  return { createChildLogger };
});

import { Database } from '../../src/core/database.ts';
import {
  resetProbeErrorThrottle,
  startHealthServer,
  type HealthDeps,
} from '../../src/core/health.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

// The ProbeErrorThrottle unit cases moved to tests/lib/probe-error-throttle.test.ts,
// which imports the leaf module directly instead of through this file's
// re-export. The integration cases below stay here: they are about health's
// probe storm behaviour, not the throttle in isolation.

// ---------------------------------------------------------------------------
// Integration — a missing table must degrade + bound the log, not storm it.
// ---------------------------------------------------------------------------

function httpGet(port: number, path: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { 'Content-Type': 'application/json', ...extraHeaders } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function makeDeps(db: Database): HealthDeps {
  return {
    db,
    connectionManager: {
      botJid: '15551230004@s.whatsapp.net',
      botLid: null,
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
    instanceName: 'WhatSoup',
    instanceType: 'chat',
    accessMode: 'allowlist',
  };
}

function buildTestServer(deps: HealthDeps): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
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

describe('GET /health with a missing probe table (#1778 Defect B)', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    resetProbeErrorThrottle();
    healthLogger.error.mockClear();
    db = new Database(':memory:');
    db.open();
    // #2515: diagnostic projection is bearer-gated; set a test token.
    process.env.WHATSOUP_HEALTH_TOKEN = 'storm-test-health-token-2515';
    // Simulate the observed drift AFTER open() self-heal, so the probe target is
    // genuinely absent for the duration of this test.
    db.raw.exec('DROP TABLE pending_polls');
    ({ server, port } = await buildTestServer(makeDeps(db)));
  });

  afterEach(async () => {
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('latches degraded on every poll but bounds the error log to O(log N)', async () => {
    const POLLS = 16;
    for (let i = 0; i < POLLS; i += 1) {
      const { body } = await httpGet(port, '/health', { Authorization: 'Bearer storm-test-health-token-2515' });
      const json = JSON.parse(body);
      // The degraded latch must survive on every poll — bounding the LOG must
      // not silence the SIGNAL.
      expect(json.status).toBe('degraded');
      expect(json.sqlite.pending_polls_readable).toBe(false);
    }

    const pendingPollErrors = healthLogger.error.mock.calls.filter(
      (call: unknown[]) => call[1] === 'failed to count pending polls',
    ).length;
    // 16 polls, all failing: powers of two ≤16 → {1,2,4,8,16} = 5 emissions.
    // Storm behaviour would be 16. Assert it is bounded well below the poll count.
    expect(pendingPollErrors).toBeLessThanOrEqual(5);
    expect(pendingPollErrors).toBeGreaterThan(0);
  });
});
