/**
 * #3562: the #2280 silence latch on instances with no primary-turn receipt.
 *
 * The only release channel the latch had was a fresh exact-primary agent-turn
 * receipt. Turn capability exists only for agent mode, so a passive (or chat)
 * instance that armed a latch read `degradation_silence_unproven` until the
 * process restarted, with its transport connected and its auth bond present.
 *
 * The release added for that case is a DIRECT RE-PROBE: every latched reason
 * must be backed by a positive read of the state it names on a quiet
 * evaluation, held across the observation window. Silence (a source that
 * stopped reporting), elapsed time alone and an empty reason list alone still
 * release nothing. A reason with no direct probe still needs its old proof.
 *
 * Each case opens ONE server and polls it repeatedly: the latch map belongs to
 * the server instance, so a fresh server per poll would reset the state under
 * test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';

vi.mock('../../src/config.ts', () => ({
  config: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set(['admin-under-test']),
    controlPeers: new Map<string, string>(),
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-health-latch-reprobe/tmp',
    botName: 'reprobe',
    accessMode: 'allowlist',
    healthPort: 9999,
    healthBindAddress: '127.0.0.1',
    agentProvider: 'claude-cli',
    models: { conversation: 'test-model-a', extraction: 'test-model-b', validation: 'test-model-b', fallback: 'test-model-c' },
  },
}));

const healthLogger = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));
const lookupCredentialMock = vi.hoisted(() => vi.fn(
  (service: string) => service === 'whatsoup-health-token' ? process.env.WHATSOUP_HEALTH_TOKEN ?? null : null,
));
vi.mock('../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: lookupCredentialMock };
});
vi.mock('../../src/logger.ts', async () => {
  const { componentLoggerMock, loggerMock } = await import('../helpers/logger-mock.ts');
  const { log, createChildLogger } = componentLoggerMock('health', () => loggerMock().createChildLogger());
  Object.assign(healthLogger, log);
  return { createChildLogger };
});
vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { Database } from '../../src/core/database.ts';
import * as health from '../../src/core/health.ts';
import { startHealthServer, type DegradationLatchEntry, type HealthDeps } from '../../src/core/health.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

const TOKEN = 'test-health-token-latch-reprobe';
// Test-owned literal for the observation window; a test below pins it to the
// source constant, so a change to either has to be deliberate.
const WINDOW_MS = 60_000;

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

/** A walked auth bond: clean by default, at risk when it carries an issue. */
function authBond(issues: string[] = []): Record<string, unknown> {
  return {
    status: 'present',
    issues,
    authDir: { path: '/auth', exists: true, mode: '700', size: 128, mtime: '2026-10-01T00:00:00.000Z', sha256: null },
    creds: { path: '/auth/creds.json', exists: true, mode: '600', size: 512, mtime: '2026-10-01T00:00:00.000Z', sha256: 'a'.repeat(64) },
    meHash: 'b'.repeat(20),
    treeHash: 'c'.repeat(64),
    treeProvenance: {
      source: 'cached',
      ageMs: 1_000,
      refreshInFlight: false,
      refreshCount: 1,
      lastInvalidationReason: null,
      lastRefreshKind: 'fresh',
      lastRefreshReason: null,
      refreshScheduled: false,
      nextRefreshEligibleInMs: null,
      refreshAttemptCount: 1,
      firstWalkPending: false,
    },
    backup: {
      root: '/state/auth-bond-backups/test',
      latest: '/state/auth-bond-backups/test/history/latest',
      latestAt: '2026-10-01T00:00:00.000Z',
      latestReason: 'connection-open',
      latestTreeHash: 'c'.repeat(64),
      lastCaptureAt: '2026-10-01T00:00:00.000Z',
      lastCaptureReason: 'connection-open',
      lastCaptureError: null,
      lastCaptureDeferredAt: null,
      lastCaptureDeferredReason: null,
      lastCaptureDeferredAgeMs: null,
      lastRestoreAt: null,
      lastRestoreSource: null,
      lastRestoreError: null,
    },
  };
}
const AT_RISK_ISSUE = 'auth_mode_chmod_failed:creds.json:EPERM';

interface PassiveInstance {
  poll: () => Promise<Record<string, any>>;
  setBond: (bond: Record<string, unknown> | null) => void;
  setEnrichment: (stats: { lastRun: string | null; runtimeDegraded?: boolean }) => void;
}

function latchSetLines(callsBefore: number): unknown[] {
  return healthLogger.info.mock.calls.slice(callsBefore)
    .filter((call) => call[1] === 'degradation silence latch set')
    .map((call) => call[0]);
}
function latchReleasedLines(callsBefore: number): unknown[] {
  return healthLogger.info.mock.calls.slice(callsBefore)
    .filter((call) => typeof call[1] === 'string' && (call[1] as string).startsWith('degradation silence latch released'))
    .map((call) => [call[0], call[1]]);
}

function expectLatched(json: Record<string, any>): void {
  expect(json.status).toBe('degraded');
  expect(json.status_reasons).toEqual(['degradation_silence_unproven']);
  expect(json.degradation_causes).toContain('degradation_silence_unproven');
}
function expectReleased(json: Record<string, any>): void {
  expect(json.status).toBe('healthy');
  expect(json.status_reasons).toEqual([]);
  expect(json.degradation_causes).not.toContain('degradation_silence_unproven');
}

describe('GET /health — passive silence latch released by direct re-probe (#3562)', () => {
  let db: Database;
  let server: ReturnType<typeof createServer> | null = null;

  beforeEach(() => {
    process.env.WHATSOUP_HEALTH_TOKEN = TOKEN;
    db = new Database(':memory:');
    db.open();
    // Only the clocks are faked; the HTTP server's timers stay real.
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    vi.useRealTimers();
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
  });

  const advance = (ms: number): void => { vi.advanceTimersByTime(ms); };

  async function openPassive(instanceName: string): Promise<PassiveInstance> {
    let bond: Record<string, unknown> | null = authBond();
    let enrichment: { lastRun: string | null; runtimeDegraded?: boolean } = { lastRun: null };
    const connectionState = () => ({
      ...emptyConnectionStateSnapshot({
        connected: true,
        stateChangedAt: '2026-10-01T00:00:00.000Z',
        lastDisconnectReason: null,
      }),
      ...(bond === null ? {} : { authBond: bond }),
    });
    const built = await buildTestServer({
      db,
      connectionManager: {
        botJid: 'bot-under-test',
        botLid: null,
        sendMessage: vi.fn(),
        sendMedia: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        getConnectionState: connectionState,
        getHealthConnectionState: connectionState,
      } as unknown as ConnectionManager,
      startedAt: Date.now() - 1_000,
      getEnrichmentStats: () => ({ unprocessed: 0, ...enrichment }),
      instanceName,
      instanceType: 'passive',
      accessMode: 'allowlist',
      runtime: {
        getHealthSnapshot: () => ({ status: 'healthy', details: {} }),
      } as unknown as HealthDeps['runtime'],
    });
    server = built.server;
    return {
      poll: async () => {
        const { status, body } = await healthReq(built.port);
        expect(status).toBe(200);
        return JSON.parse(body);
      },
      setBond: (next) => { bond = next; },
      setEnrichment: (next) => { enrichment = next; },
    };
  }

  it('pins the observation window to the source constant', () => {
    expect(health.LATCH_REPROBE_OBSERVATION_MS).toBe(WINDOW_MS);
  });

  it('(c) a passive at-risk auth bond, walked clean and re-probed across the window, releases with no turn', async () => {
    const p = await openPassive('passive-auth-bond');
    const callsBefore = healthLogger.info.mock.calls.length;
    p.setBond(authBond([AT_RISK_ISSUE]));
    const episode = await p.poll();
    expect(episode.status).toBe('degraded');
    expect(episode.status_reasons).toEqual(['auth_failure.auth_bond_at_risk']);

    // The originating reason cleared: the next walk finds the tree clean.
    p.setBond(authBond());
    expectLatched(await p.poll());
    advance(WINDOW_MS - 1);
    expectLatched(await p.poll());
    advance(1);
    expectReleased(await p.poll());
    // Stays released: nothing re-arms on a quiet instance.
    advance(WINDOW_MS);
    expectReleased(await p.poll());
    expect(latchReleasedLines(callsBefore)).toHaveLength(1);
  });

  it('(c) a passive stale enrichment latch releases once a fresh run is re-probed across the window', async () => {
    const p = await openPassive('passive-enrichment');
    p.setEnrichment({ lastRun: new Date(Date.now() - 11 * 60_000).toISOString() });
    const episode = await p.poll();
    expect(episode.status_reasons).toEqual(['enrichment_stale']);

    p.setEnrichment({ lastRun: new Date(Date.now()).toISOString() });
    expectLatched(await p.poll());
    advance(WINDOW_MS);
    expectReleased(await p.poll());
  });

  it('(b) the latch-set line names the latched reasons; the release line names them and the proof', async () => {
    const p = await openPassive('passive-log-lines');
    const callsBefore = healthLogger.info.mock.calls.length;
    p.setBond(authBond([AT_RISK_ISSUE]));
    await p.poll();
    expect(latchSetLines(callsBefore)).toEqual([
      { instance: 'passive-log-lines', reasons: ['auth_failure.auth_bond_at_risk'] },
    ]);

    p.setBond(authBond());
    await p.poll();
    advance(WINDOW_MS);
    expectReleased(await p.poll());
    expect(latchReleasedLines(callsBefore)).toEqual([[
      { instance: 'passive-log-lines', reasons: ['auth_failure.auth_bond_at_risk'], proof: 'direct_reprobe' },
      'degradation silence latch released: direct re-probe',
    ]]);
  });

  it('(d) elapsed time alone does not release: the window needs a re-probe at both ends', async () => {
    const p = await openPassive('passive-elapsed');
    p.setBond(authBond([AT_RISK_ISSUE]));
    await p.poll();
    p.setBond(authBond());
    // Hours pass with no evaluation at all; the first quiet re-probe only
    // opens the window.
    advance(6 * 60 * 60_000);
    expectLatched(await p.poll());
    advance(WINDOW_MS);
    expectReleased(await p.poll());
  });

  it('(d) a recurrence inside the window restarts it', async () => {
    const p = await openPassive('passive-flap');
    p.setBond(authBond([AT_RISK_ISSUE]));
    await p.poll();
    p.setBond(authBond());
    expectLatched(await p.poll());

    advance(WINDOW_MS / 2);
    p.setBond(authBond([AT_RISK_ISSUE]));
    expect((await p.poll()).status_reasons).toEqual(['auth_failure.auth_bond_at_risk']);
    p.setBond(authBond());
    expectLatched(await p.poll());
    advance(WINDOW_MS / 2);
    expectLatched(await p.poll());
    advance(WINDOW_MS / 2);
    expectReleased(await p.poll());
  });

  it('(d) a latch whose reason is still active does not release', async () => {
    const p = await openPassive('passive-still-active');
    p.setBond(authBond([AT_RISK_ISSUE]));
    for (let i = 0; i < 4; i += 1) {
      const json = await p.poll();
      expect(json.status).toBe('degraded');
      expect(json.status_reasons).toEqual(['auth_failure.auth_bond_at_risk']);
      advance(WINDOW_MS);
    }
  });

  it('(d) silence is not a re-probe: a bond that stops reporting keeps the latch', async () => {
    const p = await openPassive('passive-bond-silent');
    p.setBond(authBond([AT_RISK_ISSUE]));
    await p.poll();
    // No bond read at all: the class reads 'none' by absence, not by a clean walk.
    p.setBond(null);
    expectLatched(await p.poll());
    advance(WINDOW_MS);
    expectLatched(await p.poll());
    advance(WINDOW_MS);
    expectLatched(await p.poll());
  });

  it('(d) a reason with no direct probe still needs its proof (enrichment runtime, child-reported)', async () => {
    // May pass on base: base never releases this latch at all.
    const p = await openPassive('passive-no-probe');
    p.setEnrichment({ lastRun: null, runtimeDegraded: true });
    expect((await p.poll()).status_reasons).toEqual(['enrichment_runtime_degraded']);
    p.setEnrichment({ lastRun: null, runtimeDegraded: false });
    expectLatched(await p.poll());
    advance(WINDOW_MS);
    expectLatched(await p.poll());
    advance(WINDOW_MS);
    expectLatched(await p.poll());
  });
});

describe('releaseDegradationLatchOnReprobe — the re-probe release contract', () => {
  const NAME = 'unit-instance';
  const T0 = 1_000_000;
  const CLEAN = {
    connected: true,
    authBondClear: true,
    enrichmentFresh: true,
    memoryReadinessClear: true,
    memoryContextClear: true,
    memoryConsolidationClear: true,
  };
  const latch = (reasons: string[]): Map<string, DegradationLatchEntry> =>
    new Map([[NAME, { latchedAtMs: T0, reasons: new Set(reasons) }]]);

  it('(a) a latch holding only runtime.auto_compact_backoff releases once the backoff has ended', () => {
    // Directly re-probed: the runtime recomputes the backoff from its own
    // cooldown deadlines every snapshot, so a quiet evaluation (evidence
    // non-null) proves the cooldown has passed.
    const map = latch(['runtime.auto_compact_backoff']);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1 + WINDOW_MS)).toBe(true);
    expect(map.has(NAME)).toBe(false);
  });

  it('(a) a still-active backoff keeps the latch (the evaluation is not quiet)', () => {
    const map = latch(['runtime.auto_compact_backoff']);
    for (let t = T0 + 1; t < T0 + 5 * WINDOW_MS; t += WINDOW_MS) {
      expect(health.releaseDegradationLatchOnReprobe(map, NAME, null, t)).toBe(false);
    }
    expect(map.has(NAME)).toBe(true);
  });

  it('every directly re-probed reason is cleared by a quiet evaluation', () => {
    const map = latch([...health.DIRECTLY_REPROBED_STATUS_REASONS]);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1 + WINDOW_MS)).toBe(true);
  });

  it('(d) turn-pipeline and unprobed reasons keep needing their own proof', () => {
    for (const reason of [
      'turn_capability_degraded',
      'agent_runtime_degraded',
      'runtime.provider_fallback_active',
      'runtime.recent_crashes',
      'runtime.credential_identity_mismatch',
      'enrichment_runtime_degraded',
      'runtime_degraded',
      'database_retention_failed',
    ]) {
      const map = latch([reason]);
      expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1)).toBe(false);
      expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1 + WINDOW_MS), reason).toBe(false);
      expect(map.has(NAME)).toBe(true);
    }
  });

  it('a mixed latch releases only when every reason is witnessed', () => {
    const map = latch(['auth_failure.auth_bond_at_risk', 'enrichment_stale', 'connection_disconnected']);
    const noFreshRun = { ...CLEAN, enrichmentFresh: false };
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, noFreshRun, T0 + 1)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, noFreshRun, T0 + 1 + WINDOW_MS)).toBe(false);
    // Witnessed from here on: the window starts now, not at the first quiet read.
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 2 + WINDOW_MS)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1 + 2 * WINDOW_MS)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 2 + 2 * WINDOW_MS)).toBe(true);
  });

  it('an unwitnessed evaluation inside the window restarts it', () => {
    const map = latch(['auth_failure.auth_bond_at_risk']);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, null, T0 + 2)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1 + WINDOW_MS)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(map, NAME, CLEAN, T0 + 1 + 2 * WINDOW_MS)).toBe(true);
  });

  it('an empty latched set or a missing latch never releases', () => {
    const empty = latch([]);
    expect(health.releaseDegradationLatchOnReprobe(empty, NAME, CLEAN, T0 + 1)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(empty, NAME, CLEAN, T0 + 1 + WINDOW_MS)).toBe(false);
    expect(health.releaseDegradationLatchOnReprobe(new Map(), NAME, CLEAN, T0 + WINDOW_MS)).toBe(false);
  });
});
