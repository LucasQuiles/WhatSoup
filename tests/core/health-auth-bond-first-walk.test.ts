/**
 * The auth-bond first-walk window and the #2280 silence latch.
 *
 * GET /health reads the auth bond from the off-request cache. Until the first
 * tree walk since process start publishes, that cache is empty and the bond
 * reads `unknown` (issue `auth_tree_unobserved`), which /health classifies as
 * `auth_bond_at_risk`. Connect-time credential writes supersede walks in
 * flight, so a freshly started instance could be polled inside that window,
 * arm the silence latch on a reason no turn can prove, and read latch-only
 * after the walk landed while it served turns normally.
 *
 * These cases run the REAL AuthBondGuard: the producer's `firstWalkPending`
 * flag, its bound (the guard's own stale-risk bound, measured on its monotonic
 * clock from construction), and the cold-then-warm read through the real
 * health server. Latch contract cases with synthetic snapshots and turn
 * receipts live in tests/core/health.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.ts', () => ({
  config: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set(['15550100001']),
    controlPeers: new Map<string, string>(),
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-health-first-walk/tmp',
    botName: 'firstwalk',
    accessMode: 'allowlist',
    healthPort: 9999,
    healthBindAddress: '127.0.0.1',
    agentProvider: 'claude-cli',
    models: { conversation: 'test-model-a', extraction: 'test-model-b', validation: 'test-model-b', fallback: 'test-model-c' },
  },
}));

const lookupCredentialMock = vi.hoisted(() => vi.fn(
  (service: string) => service === 'whatsoup-health-token' ? process.env.WHATSOUP_HEALTH_TOKEN ?? null : null,
));
vi.mock('../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: lookupCredentialMock };
});
vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return { createChildLogger: () => loggerMock().createChildLogger() };
});
vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { Database } from '../../src/core/database.ts';
import { startHealthServer, type HealthDeps } from '../../src/core/health.ts';
import { AuthBondGuard } from '../../src/transport/auth-bond.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

const TOKEN = 'test-health-token-first-walk';
const MAX_AGE_MS = 30_000;
/** The guard's stale-risk bound: four max-age periods (TREE_STALE_RISK_MULTIPLE). */
const STALE_RISK_MS = 4 * MAX_AGE_MS;

const fixtureRoots: string[] = [];

function makeFixture(): { authDir: string; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-first-walk-'));
  fixtureRoots.push(root);
  const authDir = join(root, 'auth');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
    me: { id: '15550100001:1@s.whatsapp.net' },
    registrationId: 1,
  }), { mode: 0o600 });
  for (let i = 0; i < 20; i += 1) {
    writeFileSync(join(authDir, `pre-key-${i}.json`), JSON.stringify({ keyId: i }), { mode: 0o600 });
  }
  return { authDir, stateRoot: join(root, 'state') };
}

function healthReq(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function buildTestServer(deps: HealthDeps): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    const server = startHealthServer(deps);
    server.close(() => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
      });
    });
  });
}

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

describe('AuthBondGuard firstWalkPending', () => {
  it('is true on a cold cache and false once the first walk publishes', async () => {
    const fx = makeFixture();
    const guard = new AuthBondGuard({ ...fx, instanceName: 'first-walk-cold' });

    const cold = guard.inspectCached();
    expect(cold.status).toBe('unknown');
    expect(cold.issues).toEqual(['auth_tree_unobserved']);
    expect(cold.treeProvenance?.source).toBe('absent');
    expect(cold.treeProvenance?.firstWalkPending).toBe(true);

    await guard.warmTreeCache();
    const walked = guard.inspectCached();
    expect(walked.status).toBe('present');
    expect(walked.treeProvenance?.firstWalkPending).toBe(false);
  });

  it('ends at the stale-risk bound when the first walk has not completed', async () => {
    const fx = makeFixture();
    let clockMs = 5_000;
    const guard = new AuthBondGuard({
      ...fx,
      instanceName: 'first-walk-bound',
      monotonicNow: () => clockMs,
      treeCacheMaxAgeMs: MAX_AGE_MS,
    });

    // Both reads run before anything yields, so the walk the first read starts
    // cannot have published: this is the never-completed first walk.
    expect(guard.inspectCached().treeProvenance?.firstWalkPending).toBe(true);
    clockMs += STALE_RISK_MS - 1;
    expect(guard.inspectCached().treeProvenance?.firstWalkPending).toBe(true);
    clockMs += 1;
    const expired = guard.inspectCached();
    expect(expired.treeProvenance?.source).toBe('absent');
    expect(expired.status).toBe('unknown');
    expect(expired.treeProvenance?.firstWalkPending).toBe(false);

    await guard.warmTreeCache();
  });

  it('stays false for a published walk that later ages past the bound', async () => {
    const fx = makeFixture();
    let clockMs = 5_000;
    const guard = new AuthBondGuard({
      ...fx,
      instanceName: 'first-walk-aged',
      monotonicNow: () => clockMs,
      treeCacheMaxAgeMs: MAX_AGE_MS,
      treeRefreshMinIntervalMs: 0,
    });
    await guard.warmTreeCache();

    clockMs += STALE_RISK_MS + 10_000;
    const aged = guard.inspectCached();
    expect(aged.status).toBe('unknown');
    expect(aged.issues.some((issue) => issue.startsWith('auth_tree_stale:'))).toBe(true);
    expect(aged.treeProvenance?.firstWalkPending).toBe(false);

    await guard.warmTreeCache();
  });
});

describe('GET /health — the first auth-tree walk does not arm the silence latch', () => {
  let db: Database;
  let server: ReturnType<typeof createServer> | null = null;

  beforeEach(() => {
    process.env.WHATSOUP_HEALTH_TOKEN = TOKEN;
    db = new Database(':memory:');
    db.open();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  it('a poll before the first walk reports at risk, and the walk then reads healthy', async () => {
    const fx = makeFixture();
    const guard = new AuthBondGuard({ ...fx, instanceName: 'first-walk-health' });
    const connectionState = () => ({
      ...emptyConnectionStateSnapshot({
        connected: true,
        stateChangedAt: '2026-10-09T00:00:00.000Z',
        lastDisconnectReason: null,
      }),
      authBond: guard.inspectCached(),
    });
    const built = await buildTestServer({
      db,
      connectionManager: {
        botJid: '15551230004@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn(),
        sendMedia: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        getConnectionState: connectionState,
        getHealthConnectionState: connectionState,
      } as unknown as ConnectionManager,
      startedAt: Date.now() - 1_000,
      getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
      instanceName: 'firstwalk',
      instanceType: 'agent',
      accessMode: 'allowlist',
      // A healthy runtime with complete recovery evidence: missing fields fail
      // closed as recovery_debt_blocking, which is not what this case tests.
      runtime: {
        getHealthSnapshot: () => ({
          status: 'healthy',
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
            active: true,
          },
        }),
        getFallbackState: () => null,
      } as unknown as HealthDeps['runtime'],
    });
    server = built.server;

    const boot = JSON.parse((await healthReq(built.port)).body);
    expect(boot.status).toBe('degraded');
    expect(boot.status_reasons).toEqual(['auth_failure.auth_bond_at_risk']);

    await guard.warmTreeCache();
    const walked = JSON.parse((await healthReq(built.port)).body);
    expect(walked.status, 'the first walk must not leave the instance latch-only').toBe('healthy');
    expect(walked.status_reasons).not.toContain('degradation_silence_unproven');
  });
});
