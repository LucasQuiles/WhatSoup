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
    adminPhones: new Set(['15550100001']),
    controlPeers: new Map<string, string>(),
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

import { Database } from '../../src/core/database.ts';
import {
  ProbeErrorThrottle,
  resetProbeErrorThrottle,
  startHealthServer,
  type HealthDeps,
} from '../../src/core/health.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// ProbeErrorThrottle — unit (clock-free, isolated instances, no singleton)
// ---------------------------------------------------------------------------

describe('ProbeErrorThrottle (#1778 Defect B)', () => {
  it('emits on the 1st failure then only at powers of two — O(log N), not O(N)', () => {
    const throttle = new ProbeErrorThrottle();
    const emitted: number[] = [];
    for (let i = 1; i <= 1000; i += 1) {
      const n = throttle.onFailure('probe-x');
      if (n !== null) emitted.push(n);
    }
    // {1,2,4,8,16,32,64,128,256,512} — 10 emissions for 1000 failures.
    expect(emitted).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512]);
  });

  it('keeps distinct probe keys independent', () => {
    const throttle = new ProbeErrorThrottle();
    expect(throttle.onFailure('a')).toBe(1);
    expect(throttle.onFailure('b')).toBe(1);
    expect(throttle.onFailure('a')).toBe(2);
    expect(throttle.onFailure('b')).toBe(2);
  });

  it('onSuccess reports and clears the accumulated failure count so the next storm re-alerts from 1', () => {
    const throttle = new ProbeErrorThrottle();
    for (let i = 0; i < 5; i += 1) throttle.onFailure('probe-y');
    expect(throttle.onSuccess('probe-y')).toBe(5);
    // Clean → nothing to clear.
    expect(throttle.onSuccess('probe-y')).toBe(0);
    // Re-alerts from 1 after recovery.
    expect(throttle.onFailure('probe-y')).toBe(1);
  });
});

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
    mockHealthLogger.error.mockClear();
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

    const pendingPollErrors = mockHealthLogger.error.mock.calls.filter(
      (call) => call[1] === 'failed to count pending polls',
    ).length;
    // 16 polls, all failing: powers of two ≤16 → {1,2,4,8,16} = 5 emissions.
    // Storm behaviour would be 16. Assert it is bounded well below the poll count.
    expect(pendingPollErrors).toBeLessThanOrEqual(5);
    expect(pendingPollErrors).toBeGreaterThan(0);
  });
});
