/**
 * #3722: authenticated /health carries the transport's last reconnect-state
 * reset so the fleet poller can tell a fresh reconnect from a silent logout.
 *
 *   marker present, not connected -> reconnect_reset = { reason, at }
 *   marker null                    -> reconnect_reset = null
 *   connected                      -> reconnect_reset = null (disconnect metadata hidden)
 *   field absent (other transport) -> key omitted
 *
 * The public envelope never carries it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';

vi.mock('../../src/config.ts', () => ({
  config: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set(['15550100001']),
    controlPeers: new Map<string, string>(),
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-health-reconnect-reset/tmp',
    botName: 'rrbot',
    accessMode: 'allowlist',
    healthPort: 9999,
    healthBindAddress: '127.0.0.1',
    agentProvider: 'provider-a',
    models: { conversation: 'model-a', extraction: 'model-b', validation: 'model-b', fallback: 'model-c' },
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

const TOKEN = 'test-health-token-reconnect-reset';
const MARKER = { reason: 'exhaustion_cycle_retry', at: '2026-09-30T03:00:00.000Z' };

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

function snapshot(
  opts: { connected: boolean; state: ConnectionStateSnapshot['state'] },
  reset: ConnectionStateSnapshot['reconnectReset'] | undefined,
): ConnectionStateSnapshot {
  const base = emptyConnectionStateSnapshot({
    connected: opts.connected,
    stateChangedAt: '2026-09-30T03:00:00.000Z',
    lastDisconnectReason: opts.connected ? null : 'connectionClosed',
  });
  const out: ConnectionStateSnapshot = {
    ...base,
    state: opts.state,
    lastStatusCode: opts.connected ? null : 428,
    reconnectPhase: 'backoff',
    reconnectAttempts: 0,
  };
  if (reset !== undefined) out.reconnectReset = reset;
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
    instanceName: 'rrbot',
    instanceType: 'passive',
    accessMode: 'allowlist',
  };
}

describe('GET /health — reconnect_reset (#3722)', () => {
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

  it('a reconnecting transport with a reset marker carries it verbatim', async () => {
    const { json } = await read(snapshot({ connected: false, state: 'reconnecting' }, MARKER));
    expect(json.whatsapp.connection.reconnect_reset).toEqual(MARKER);
  });

  it('a null marker serializes as null with the key present', async () => {
    const { json } = await read(snapshot({ connected: false, state: 'reconnecting' }, null));
    expect(json.whatsapp.connection).toHaveProperty('reconnect_reset', null);
  });

  it('a connected transport hides the marker like the other disconnect metadata', async () => {
    const { json } = await read(snapshot({ connected: true, state: 'connected' }, MARKER));
    expect(json.whatsapp).toMatchObject({
      connected: true,
      connection: { state: 'connected', last_disconnect_reason: null, last_status_code: null, reconnect_reset: null },
    });
  });

  it('a transport without the field omits the key', async () => {
    const { json } = await read(snapshot({ connected: false, state: 'reconnecting' }, undefined));
    expect('reconnect_reset' in json.whatsapp.connection).toBe(false);
  });

  it('the unauthenticated public envelope never carries the marker', async () => {
    const { json } = await read(snapshot({ connected: false, state: 'reconnecting' }, MARKER), null);
    expect(json.schema_version).toBe('health.public.v1');
    expect(JSON.stringify(json)).not.toContain('reconnect_reset');
    expect(JSON.stringify(json)).not.toContain('exhaustion_cycle_retry');
  });
});
