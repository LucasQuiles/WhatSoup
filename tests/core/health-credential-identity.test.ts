/**
 * /health surface for the ratified-row account-identity verification.
 *
 * The agent runtime publishes `accountIdentity` (status classes + digest
 * prefixes) and the degradedReasons literals `credential_identity_mismatch`
 * / `credential_identity_unverifiable`; health must turn those into the
 * matching `runtime.<reason>` status_reasons AND named degradation_causes
 * (never the `agent_runtime_degraded_unclassified` fall-through), keep the
 * reasons OUT of TURN_PROVABLE_STATUS_REASONS (a turn proves the credential
 * works, not whose it is), and expose no raw identifier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';

vi.mock('../../src/config.ts', () => ({
  config: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set(['15550100001']),
    controlPeers: new Map<string, string>(),
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-health-identity/tmp',
    botName: 'phbot',
    accessMode: 'allowlist',
    healthPort: 9999,
    healthBindAddress: '127.0.0.1',
    agentProvider: 'claude-cli',
    models: { conversation: 'claude-opus-4-5', extraction: 'claude-haiku-4-5', validation: 'claude-haiku-4-5', fallback: 'claude-sonnet-4-5' },
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
import {
  HEALTH_DEGRADATION_CAUSES,
  HEALTH_DEGRADATION_CAUSE_REASON_TWINS,
  TURN_PROVABLE_STATUS_REASONS,
  releaseDegradationLatchOnRecoveryProof,
  startHealthServer,
  type HealthDeps,
} from '../../src/core/health.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

const TOKEN = 'test-health-token-identity';
const EMAIL = 'owner.example@example.test';

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

function makeDeps(db: Database, runtimeSnapshot: { status: string; details: Record<string, unknown> }): HealthDeps {
  return {
    db,
    connectionManager: {
      botJid: '15551230004@s.whatsapp.net',
      botLid: null,
      sendMessage: vi.fn(),
      sendMedia: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      getConnectionState: vi.fn(() => emptyConnectionStateSnapshot({
        connected: true, stateChangedAt: '2026-08-28T00:00:00.000Z', lastDisconnectReason: null,
      })),
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'phbot',
    instanceType: 'agent',
    accessMode: 'allowlist',
    runtime: {
      getHealthSnapshot: () => runtimeSnapshot,
      getFallbackState: () => null,
    } as unknown as HealthDeps['runtime'],
  };
}

function identityDetails(
  status: 'match' | 'mismatch' | 'unverifiable' | 'pending' | 'disabled',
  reason: string | null,
  degradedReasons: string[],
): { status: string; details: Record<string, unknown> } {
  return {
    status: degradedReasons.length > 0 ? 'degraded' : 'healthy',
    details: {
      degradedReasons,
      active: true,
      recentCrashes: 0,
      autoCompactActiveBackoffScopes: 0,
      providerExecution: { pressureActive: false },
      accountIdentity: {
        status,
        reason,
        stale: false,
        checkedAt: 1_790_000_000_000,
        expectedDigestPrefix: 'aaaaaaaaaaaa',
        observedDigestPrefix: status === 'mismatch' ? 'bbbbbbbbbbbb' : status === 'match' ? 'aaaaaaaaaaaa' : null,
      },
    },
  };
}

describe('GET /health — credential identity (task-21)', () => {
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

  async function fetchHealth(snapshot: { status: string; details: Record<string, unknown> }): Promise<Record<string, any>> {
    const built = await buildTestServer(makeDeps(db, snapshot));
    server = built.server;
    const { status, body } = await healthReq(built.port);
    expect(status).toBe(200);
    expect(body).not.toContain(EMAIL);
    expect(body).not.toContain('@example');
    return JSON.parse(body);
  }

  it('mismatch: degraded with the named cause and its runtime.<reason> twin, never the unclassified fall-through', async () => {
    const json = await fetchHealth(identityDetails('mismatch', null, ['credential_identity_mismatch']));
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('runtime.credential_identity_mismatch');
    expect(json.degradation_causes).toContain('credential_identity_mismatch');
    expect(json.degradation_causes).not.toContain('agent_runtime_degraded_unclassified');
    expect(json.degradation_causes).not.toContain('unclassified');
    expect(json.runtime.agent.accountIdentity).toMatchObject({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' });
  });

  it('unverifiable: degraded with its own distinct cause/reason pair and the bounded reason exposed', async () => {
    const json = await fetchHealth(identityDetails('unverifiable', 'not-logged-in', ['credential_identity_unverifiable']));
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('runtime.credential_identity_unverifiable');
    expect(json.degradation_causes).toContain('credential_identity_unverifiable');
    expect(json.degradation_causes).not.toContain('credential_identity_mismatch');
    expect(json.degradation_causes).not.toContain('agent_runtime_degraded_unclassified');
    expect(json.runtime.agent.accountIdentity).toMatchObject({ status: 'unverifiable', reason: 'not-logged-in', observedDigestPrefix: null });
  });

  it('match / pending / disabled: quiet — no identity reason, no identity cause', async () => {
    for (const [status, reason] of [['match', null], ['pending', null], ['disabled', null]] as const) {
      const json = await fetchHealth(identityDetails(status, reason, []));
      expect(json.status).toBe('healthy');
      expect(json.status_reasons.filter((r: string) => r.includes('credential_identity'))).toEqual([]);
      expect(json.degradation_causes.filter((c: string) => c.includes('credential_identity'))).toEqual([]);
      expect(json.runtime.agent.accountIdentity.status).toBe(status);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('cause registry: both identity causes are registered with their runtime.<reason> twins', () => {
    expect(HEALTH_DEGRADATION_CAUSES).toContain('credential_identity_mismatch');
    expect(HEALTH_DEGRADATION_CAUSES).toContain('credential_identity_unverifiable');
    expect(HEALTH_DEGRADATION_CAUSE_REASON_TWINS.credential_identity_mismatch).toEqual(['runtime.credential_identity_mismatch']);
    expect(HEALTH_DEGRADATION_CAUSE_REASON_TWINS.credential_identity_unverifiable).toEqual(['runtime.credential_identity_unverifiable']);
  });

  it('a turn cannot prove identity: the reasons are not turn-provable and a latched identity reason never releases on a turn receipt', () => {
    expect(TURN_PROVABLE_STATUS_REASONS.has('runtime.credential_identity_mismatch')).toBe(false);
    expect(TURN_PROVABLE_STATUS_REASONS.has('runtime.credential_identity_unverifiable')).toBe(false);
    for (const reason of ['runtime.credential_identity_mismatch', 'runtime.credential_identity_unverifiable']) {
      const latch = new Map([['phbot', { latchedAtMs: 1_000, reasons: new Set(['turn_capability_degraded', reason]) }]]);
      const released = releaseDegradationLatchOnRecoveryProof(
        latch,
        'phbot',
        {
          last_successful_turn_at: 5_000,
          last_successful_turn_provider: 'claude-cli',
          last_successful_turn_model: null,
          last_successful_turn_session_current: true,
        },
        { providerId: 'claude-cli', modelRef: null },
      );
      expect(released, reason).toBe(false);
      expect(latch.has('phbot')).toBe(true);
    }
  });
});
