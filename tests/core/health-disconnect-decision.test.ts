/**
 * Authenticated /health carries the transport's disconnect decision and maps
 * it to auth_failure_class / disconnect_class without inventing confirmation.
 *
 *   confirmed_device_removed          -> serverside_logout_irreversible, 503
 *   ambiguous_401_reconnecting        -> auth_401_ambiguous_retrying, 200 degraded
 *   ambiguous_401_parked              -> auth_401_ambiguous_parked, 503
 *   uninspected_401_conservative_exit -> auth_401_uninspected_exit, 503
 *   field absent (legacy transport)   -> conservative legacy rule (any 401 irreversible)
 *
 * The public envelope never carries the decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';

vi.mock('../../src/config.ts', () => ({
  config: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set(['15550100001']),
    controlPeers: new Map<string, string>(),
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-health-disconnect-decision/tmp',
    botName: 'ddbot',
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
import { startHealthServer, type HealthDeps } from '../../src/core/health.ts';
import type { ConnectionManager, ConnectionStateSnapshot } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';
import type { DisconnectDecisionRecord } from '../../src/lib/disconnect-classification.ts';

const TOKEN = 'test-health-token-disconnect-decision';

function healthReq(port: number, token: string | null = TOKEN): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const req = request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
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

function record(overrides: Partial<DisconnectDecisionRecord>): DisconnectDecisionRecord {
  return {
    version: 1,
    classification: 'ambiguous_401_reconnecting',
    decision: 'reconnect:auth-401-unclassified',
    action: 'reconnect',
    reason: 'auth-401-unclassified',
    basis: null,
    statusCode: 401,
    conflictInspected: true,
    conflictType: null,
    unclassified401RetrySpent: false,
    observedAt: '2026-09-25T03:00:00.000Z',
    ...overrides,
  };
}

function snapshot(
  state: ConnectionStateSnapshot['state'],
  decision: DisconnectDecisionRecord | null | undefined,
): ConnectionStateSnapshot {
  const base = emptyConnectionStateSnapshot({
    connected: false,
    stateChangedAt: '2026-09-25T03:00:00.000Z',
    lastDisconnectReason: 'loggedOut',
  });
  const out: ConnectionStateSnapshot = { ...base, state, lastStatusCode: 401 };
  if (decision !== undefined) out.disconnectDecision = decision;
  return out;
}

function makeDeps(db: Database, state: ConnectionStateSnapshot): HealthDeps {
  return {
    db,
    connectionManager: {
      botJid: null,
      botLid: null,
      sendMessage: vi.fn(),
      sendMedia: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      getConnectionState: vi.fn(() => state),
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'ddbot',
    instanceType: 'passive',
    accessMode: 'allowlist',
  };
}

describe('GET /health — carried disconnect decision', () => {
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

  async function read(state: ConnectionStateSnapshot, token: string | null = TOKEN) {
    let port: number;
    ({ server, port } = await buildTestServer(makeDeps(db, state)));
    const { status, body } = await healthReq(port, token);
    return { status, json: JSON.parse(body) };
  }

  it('confirmed device_removed keeps serverside_logout_irreversible and 503', async () => {
    const { status, json } = await read(snapshot('disconnected', record({
      classification: 'confirmed_device_removed',
      decision: 'exit:logged-out:device_removed',
      action: 'exit',
      reason: 'logged-out',
      basis: 'device_removed',
      conflictType: 'device_removed',
    })));
    expect(status).toBe(503);
    expect(json.whatsapp.connection.auth_failure_class).toBe('serverside_logout_irreversible');
    expect(json.whatsapp.connection.disconnect_class).toBe('serverside_logout_irreversible');
    expect(json.whatsapp.connection.disconnect_decision).toEqual({
      version: 1,
      classification: 'confirmed_device_removed',
      decision: 'exit:logged-out:device_removed',
      action: 'exit',
      reason: 'logged-out',
      basis: 'device_removed',
      status_code: 401,
      conflict_inspected: true,
      conflict_type: 'device_removed',
      unclassified_401_retry_spent: false,
      observed_at: '2026-09-25T03:00:00.000Z',
    });
  });

  it('an ambiguous 401 inside its bounded retry is degraded, not irreversible', async () => {
    const { status, json } = await read(snapshot('reconnecting', record({})));
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connection.auth_failure_class).toBe('auth_401_ambiguous_retrying');
    expect(json.whatsapp.connection.disconnect_class).toBe('auth_401_ambiguous_retrying');
  });

  it('a parked ambiguous 401 is unhealthy under its own class, never serverside_logout_irreversible', async () => {
    const { status, json } = await read(snapshot('disconnected', record({
      classification: 'ambiguous_401_parked',
      decision: 'exit:logged-out:ambiguous_401_repeated',
      action: 'exit',
      reason: 'logged-out',
      basis: 'ambiguous_401_repeated',
      unclassified401RetrySpent: true,
    })));
    expect(status).toBe(503);
    expect(json.status_reasons).toContain('auth_failure.auth_401_ambiguous_parked');
    expect(json.whatsapp.connection.auth_failure_class).toBe('auth_401_ambiguous_parked');
  });

  it('an uninspected 401 is unhealthy and labelled uninspected', async () => {
    const { status, json } = await read(snapshot('disconnected', record({
      classification: 'uninspected_401_conservative_exit',
      decision: 'exit:logged-out:uninspected',
      action: 'exit',
      reason: 'logged-out',
      basis: 'uninspected',
      conflictInspected: false,
    })));
    expect(status).toBe(503);
    expect(json.whatsapp.connection.auth_failure_class).toBe('auth_401_uninspected_exit');
    expect(json.whatsapp.connection.disconnect_decision.conflict_inspected).toBe(false);
  });

  it('legacy fallback: a transport without the field keeps the conservative irreversible reading and omits the key', async () => {
    const { status, json } = await read(snapshot('disconnected', undefined));
    expect(status).toBe(503);
    expect(json.whatsapp.connection.auth_failure_class).toBe('serverside_logout_irreversible');
    expect('disconnect_decision' in json.whatsapp.connection).toBe(false);
  });

  it('a null decision serializes as null and is not read as a 401 class', async () => {
    const state = snapshot('reconnecting', null);
    state.lastStatusCode = null;
    state.lastDisconnectReason = null;
    const { json } = await read(state);
    expect(json.whatsapp.connection.disconnect_decision).toBeNull();
    expect(json.whatsapp.connection.auth_failure_class).toBe('none');
  });

  it('the unauthenticated public envelope never carries the decision', async () => {
    const { json } = await read(snapshot('disconnected', record({ classification: 'ambiguous_401_parked' })), null);
    expect(json.schema_version).toBe('health.public.v1');
    expect(JSON.stringify(json)).not.toContain('disconnect_decision');
    expect(JSON.stringify(json)).not.toContain('ambiguous_401');
  });
});
