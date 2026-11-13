import { vi } from 'vitest';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { Database } from '../../../src/core/database.ts';
import type { HealthDeps } from '../../../src/core/health.ts';
import type { StartupNotificationHealth } from '../../../src/core/startup-notification-controller.ts';
import { ConnectionManager } from '../../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../../src/transport/twilio/connection-snapshot.ts';

// ---------------------------------------------------------------------------
// Mock config and logger
// ---------------------------------------------------------------------------

vi.mock('../../../src/config.ts', () => ({
  config: {
    // #2192 s4b: provider-fallback tunables live on config (defaults mirror the retired IIFEs).
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set(['15550100001']),
    // Q control peer: name 'q' → phone '15559998888' (control_peer wiring tests)
    controlPeers: new Map<string, string>([['q', '15559998888']]),
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-health/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 0, // Independent files must never contend for a fixed listener port.
    // Getter, not a literal: the R7a bind tests mutate HEALTH_BIND_ADDRESS at
    // runtime and re-import health.ts; the real config reads env at its own
    // eval, which a fresh-import test observes through this same chain (#2192).
    get healthBindAddress(): string {
      return process.env.HEALTH_BIND_ADDRESS ?? '127.0.0.1';
    },
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
// pollute healthLogger and make its call history meaningless.
const healthLogger = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));

const lookupCredentialMock = vi.hoisted(() => vi.fn(
  (service: string) => service === 'whatsoup-health-token'
    ? process.env.WHATSOUP_HEALTH_TOKEN ?? null
    : null,
));

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: lookupCredentialMock };
});

vi.mock('../../../src/logger.ts', async () => {
  const { componentLoggerMock, loggerMock } = await import('../../helpers/logger-mock.ts');
  const { log, createChildLogger } = componentLoggerMock('health', () => loggerMock().createChildLogger());
  Object.assign(healthLogger, log);
  return { createChildLogger };
});

// The control_peer wiring tests drive heal.ts's emitHealReport directly; mock
// the alert sink so no real BOT ERRORS outbox event is written from a test.
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

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
// #2515 — Authenticated health-request helper.
//
// GET /health now splits a public liveness envelope (unauthenticated) from the
// full diagnostic projection (bearer-token gated). Existing diagnostic tests
// must present a valid token to reach the diagnostic body. The token is set in
// beforeEach via WHATSOUP_HEALTH_TOKEN and mirrored here.
// ---------------------------------------------------------------------------

const TEST_HEALTH_TOKEN = 'test-health-token-2515';

function healthReq(p: number): Promise<{ status: number; body: string }> {
  return httpReq(p, '/health', 'GET', undefined, { Authorization: `Bearer ${TEST_HEALTH_TOKEN}` });
}

// ---------------------------------------------------------------------------
// Build a real HTTP server using the health handler but on an ephemeral port.
// We do this by extracting the handler from startHealthServer and mounting it
// on a test server with port=0.
// ---------------------------------------------------------------------------

async function buildTestServer(deps: HealthDeps): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  // Import the module dynamically to get the handler
  const { startHealthServer } = await import('../../../src/core/health.ts');

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

function makeDeps(db: Database, overrides: Partial<HealthDeps> = {}): HealthDeps {
  const deps: HealthDeps = {
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
        stateChangedAt: '2026-07-29T00:00:00.000Z',
        lastDisconnectReason: null,
      })),
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'WhatSoup',
    instanceType: 'chat',
    accessMode: 'allowlist',
    ...overrides,
  };
  if (deps.instanceType === 'agent' && deps.runtime?.getHealthSnapshot) {
    const runtime = deps.runtime;
    const getHealthSnapshot = runtime.getHealthSnapshot.bind(runtime);
    deps.runtime = {
      ...runtime,
      getHealthSnapshot: () => {
        const snapshot = getHealthSnapshot();
        return {
          ...snapshot,
          details: {
            degradedReasons: [],
            recoveryBlockingReasons: [],
            recoveryDebtReasons: [],
            turnRecoveryBlockingOutstanding: 0,
            turnRecoveryRetainedTerminal: 0,
            turnRecoveryOpenRecoveries: 0,
            turnRecoveryCorroboratedRetained: 0,
            completedDeliveryIdentityBlocking: 0,
            completedDeliveryIdentityRetained: 0,
            completedDeliveryIdentityAdmissions: { nextAction: null },
            ...snapshot.details,
          },
        };
      },
    };
  }
  if (deps.instanceType === 'agent' && !deps.durability) {
    deps.durability = {
      getHealthStats: () => ({
        oldestMaybeSentAt: null,
        deliveryAmbiguity: {
          readable: true,
          uncorroboratedAmbiguous: 0,
          corroboratedRetained: 0,
          oldestUncorroboratedAt: null,
        },
      }),
    } as unknown as NonNullable<HealthDeps['durability']>;
  }
  return deps;
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

const STARTUP_NOTIFICATION_KEYS = [
  'state',
  'policy',
  'stabilitySeconds',
  'bootCountSinceNotification',
  'lastBootAt',
  'lastNotifiedAt',
  'nextEligibleAt',
  'lastSendAt',
] as const;

function startupNotificationHealth(
  overrides: Partial<Pick<StartupNotificationHealth, 'state' | 'policy'>> = {},
): StartupNotificationHealth {
  return {
    state: overrides.state ?? 'waiting_stability',
    policy: overrides.policy ?? 'generic',
    stabilitySeconds: 600,
    bootCountSinceNotification: 2,
    lastBootAt: 1_753_825_600_000,
    lastNotifiedAt: 1_753_825_000_000,
    nextEligibleAt: 1_753_826_200_000,
    lastSendAt: null,
  };
}

export { healthLogger, lookupCredentialMock, httpReq, TEST_HEALTH_TOKEN, healthReq, buildTestServer, makeDb, makeDeps, makeAuthBond, STARTUP_NOTIFICATION_KEYS, startupNotificationHealth };
