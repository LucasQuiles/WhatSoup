/**
 * GET /health — the per-chat dispatch-ownership reasons across a REPAIR.
 *
 * The suites that exist test a degraded snapshot and a healthy snapshot
 * separately, each against a fresh instance. Nothing tested the transition, and
 * the transition is where the defect lived: both per-chat ownership reasons are
 * outside TURN_PROVABLE_STATUS_REASONS, so a latch carrying one could never be
 * released by the only release channel there is (a fresh primary-turn receipt).
 * One poll while the condition held, then a successful repair, and the top-level
 * status stayed `degraded` until the process restarted — while the runtime's own
 * snapshot read healthy. The health surface contradicted the runtime it reports.
 *
 * The fix is that these reasons never ARM the latch, because each one clears
 * itself when its condition is repaired, so no latch is needed to keep a real
 * problem visible. The two clear differently and the distinction matters: the
 * unowned reason is recomputed from live state every poll, while the abandoned
 * reason is backed by a retention map the repair path empties on rebuild.
 *
 * Scope, stated so these cases are not read as more than they are: the runtime
 * snapshot here is supplied by the fixture, so this file pins health.ts's LATCH
 * behaviour. That the RUNTIME actually reaches the clear state by repair is
 * proven in tests/runtimes/agent/runtime-secondhalf-branches.test.ts.
 *
 * Each case uses its OWN instanceName, and each opens ONE server it polls twice:
 * the latch map is scoped to the server instance, so a fresh server per poll
 * would reset the very state under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';

vi.mock('../../src/config.ts', () => ({
  config: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set(['admin-under-test']),
    controlPeers: new Map<string, string>(),
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-health-ownership/tmp',
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
  DIRECTLY_REPROBED_STATUS_REASONS,
  TURN_PROVABLE_STATUS_REASONS,
  startHealthServer,
  type HealthDeps,
} from '../../src/core/health.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

const TOKEN = 'test-health-token-ownership';

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

function makeDeps(
  db: Database,
  instanceName: string,
  readSnapshot: () => { status: string; details: Record<string, unknown> },
): HealthDeps {
  return {
    db,
    connectionManager: {
      // Obviously-fake, non-digit placeholders: this file asserts the payload
      // carries no conversation-key shape, so its own fixtures must not supply one.
      botJid: 'bot-under-test',
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
    instanceName,
    instanceType: 'agent',
    accessMode: 'allowlist',
    runtime: {
      getHealthSnapshot: () => readSnapshot(),
      getFallbackState: () => null,
    } as unknown as HealthDeps['runtime'],
  };
}

/** A runtime snapshot carrying the given degraded reasons and matching counters. */
function ownershipSnapshot(
  degradedReasons: string[],
  counts: { withoutOwner?: number; abandoned?: number } = {},
): { status: string; details: Record<string, unknown> } {
  return {
    status: degradedReasons.length > 0 ? 'degraded' : 'healthy',
    details: {
      degradedReasons,
      active: true,
      recentCrashes: 0,
      autoCompactActiveBackoffScopes: 0,
      providerExecution: { pressureActive: false },
      perChatSessionsWithoutOwner: counts.withoutOwner ?? 0,
      perChatRespawnAbandoned: counts.abandoned ?? 0,
    },
  };
}

describe('GET /health — per-chat ownership reasons across a repair', () => {
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

  /**
   * Opens ONE server whose runtime snapshot the caller can change between polls.
   *
   * This matters more than it looks: the degradation latch is scoped to the
   * SERVER instance, not the module — `health.ts` declares it inside
   * `startHealthServer` precisely so it cannot leak across server lifetimes. A
   * harness that builds a fresh server per poll therefore resets the state this
   * file exists to test, and every transition case would pass vacuously. A real
   * deployment has one long-lived server per process, which is why the defect
   * reads as "degraded until the process restarts".
   */
  async function openInstance(instanceName: string, initial: { status: string; details: Record<string, unknown> }): Promise<{
    poll: () => Promise<Record<string, any>>;
    setSnapshot: (next: { status: string; details: Record<string, unknown> }) => void;
  }> {
    let snapshot = initial;
    const built = await buildTestServer(makeDeps(db, instanceName, () => snapshot));
    server = built.server;
    return {
      poll: async () => {
        const { status, body } = await healthReq(built.port);
        expect(status).toBe(200);
        return JSON.parse(body);
      },
      setSnapshot: (next) => { snapshot = next; },
    };
  }

  it('neither ownership reason is turn-provable — the premise the latch defect rests on', () => {
    // Named as literals rather than imported from the fix, so this file asserts
    // behaviour and a pre-existing constant and can therefore run unchanged
    // against the tree before the fix — which is what makes its red meaningful.
    for (const reason of ['runtime.per_chat_session_without_owner', 'runtime.per_chat_respawn_abandoned']) {
      expect(TURN_PROVABLE_STATUS_REASONS.has(reason), `${reason} must not be turn-provable`).toBe(false);
    }
  });

  it('pins the exact membership of the non-arming set', () => {
    // The set is exported but was asserted nowhere outside health.ts, so a third
    // member could be admitted with nothing failing. Membership is the whole
    // safety property here: every member skips the silence latch, so admitting a
    // reason that does NOT self-clear on repair would be a real silence hole.
    // Test-owned literals, compared for equality rather than containment.
    expect([...DIRECTLY_REPROBED_STATUS_REASONS].sort()).toEqual([
      'runtime.per_chat_respawn_abandoned',
      'runtime.per_chat_session_without_owner',
    ]);
    // And the two sets must stay disjoint: a turn-provable reason has a release
    // channel and does not need the exemption.
    for (const reason of DIRECTLY_REPROBED_STATUS_REASONS) {
      expect(TURN_PROVABLE_STATUS_REASONS.has(reason), `${reason} in both sets`).toBe(false);
    }
  });

  it('an unowned session names its OWN cause, never the unclassified fall-through', async () => {
    const instance = await openInstance('cause-unowned', ownershipSnapshot(['per_chat_session_without_owner'], { withoutOwner: 1 }));
    const degraded = await instance.poll();
    expect(degraded.status).toBe('degraded');
    expect(degraded.status_reasons).toContain('runtime.per_chat_session_without_owner');
    expect(degraded.degradation_causes).toContain('per_chat_session_without_owner');
    // An operator grouping by cause must be able to separate this deliberate,
    // named condition from a genuine unknown.
    expect(degraded.degradation_causes).not.toContain('agent_runtime_degraded_unclassified');
  });

  it('an abandoned respawn names its OWN cause, never the unclassified fall-through', async () => {
    const instance = await openInstance('cause-abandoned', ownershipSnapshot(['per_chat_respawn_abandoned'], { abandoned: 1 }));
    const degraded = await instance.poll();
    expect(degraded.status).toBe('degraded');
    expect(degraded.status_reasons).toContain('runtime.per_chat_respawn_abandoned');
    expect(degraded.degradation_causes).toContain('per_chat_respawn_abandoned');
    expect(degraded.degradation_causes).not.toContain('agent_runtime_degraded_unclassified');
  });

  it('health does not latch an unowned-session reason once the runtime reports it clear', async () => {
    // Scope, stated honestly: this drives health.ts across two polls with the
    // runtime's snapshot supplied by the fixture, so it pins the LATCH
    // behaviour. It does not prove the runtime ever reaches the clear state by
    // repair — the runtime-side transition is proven in
    // tests/runtimes/agent/runtime-secondhalf-branches.test.ts.
    const instance = await openInstance('latch-unowned', ownershipSnapshot(['per_chat_session_without_owner'], { withoutOwner: 1 }));
    expect((await instance.poll()).status).toBe('degraded');

    // The runtime repaired itself: the map is clean and its snapshot is healthy.
    instance.setSnapshot(ownershipSnapshot([]));
    const repaired = await instance.poll();
    expect(repaired.status, 'a repaired instance must not stay latched degraded').toBe('healthy');
    expect(repaired.status_reasons).not.toContain('degradation_silence_unproven');
    expect(repaired.status_reasons).not.toContain('runtime.per_chat_session_without_owner');
  });

  it('health does not latch an abandoned-respawn reason once the runtime reports it clear', async () => {
    const instance = await openInstance('latch-abandoned', ownershipSnapshot(['per_chat_respawn_abandoned'], { abandoned: 1 }));
    expect((await instance.poll()).status).toBe('degraded');

    instance.setSnapshot(ownershipSnapshot([]));
    const repaired = await instance.poll();
    expect(repaired.status, 'a repaired instance must not stay latched degraded').toBe('healthy');
    expect(repaired.status_reasons).not.toContain('degradation_silence_unproven');
  });

  it('a silence-prone reason alongside a re-probed one still arms, so the fix removes no protection', async () => {
    // Only turn_queue_halted is silence-prone; the ownership reason is re-probed
    // every evaluation. Filtering the re-probed reason out of the latched set
    // must not stop the silence-prone one from arming.
    const instance = await openInstance(
      'latch-mixed',
      ownershipSnapshot(['per_chat_session_without_owner', 'turn_queue_halted'], { withoutOwner: 1 }),
    );
    const degraded = await instance.poll();
    expect(degraded.status).toBe('degraded');
    expect(degraded.status_reasons).toContain('runtime.per_chat_session_without_owner');
    expect(degraded.status_reasons).toContain('runtime.turn_queue_halted');

    // Both conditions clear from the runtime's point of view. The latch armed by
    // the silence-prone reason still stands and still keeps the instance
    // degraded — unchanged, pre-existing behaviour.
    instance.setSnapshot(ownershipSnapshot([]));
    const afterRepair = await instance.poll();
    expect(afterRepair.status, 'a silence-prone reason must still latch').toBe('degraded');
    expect(afterRepair.status_reasons).toContain('degradation_silence_unproven');
  });

  it('the ownership gauges reach the authenticated wire as counts, carrying no chat identity', async () => {
    const instance = await openInstance(
      'latch-gauges',
      ownershipSnapshot(['per_chat_session_without_owner', 'per_chat_respawn_abandoned'], { withoutOwner: 2, abandoned: 3 }),
    );
    const json = await instance.poll();
    expect(json.runtime.agent.perChatSessionsWithoutOwner).toBe(2);
    expect(json.runtime.agent.perChatRespawnAbandoned).toBe(3);
    // Counts only. The whole payload must carry no conversation-key shape.
    const body = JSON.stringify(json);
    expect(body).not.toMatch(/\d{9,}/);
    expect(body).not.toContain('@s.whatsapp.net');
  });
});
