import { healthLogger, TEST_HEALTH_TOKEN, healthReq, buildTestServer, makeDb, makeDeps, makeAuthBond } from './_helpers/health.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';
import type { HealthDeps } from '../../src/core/health.ts';
import { HEALTH_DEGRADATION_CAUSE_REASON_TWINS, NO_REASON_TWIN } from '../../src/core/health.ts';
import { ConnectionManager, type ConnectionRecentDisconnects } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';
import { LOOP_LAG_WINDOW_SAMPLES } from '../../src/lib/loop-lag-sampler.ts';
import { OutboundFloodDetector } from '../../src/transport/outbound-flood-detector.ts';

// ---------------------------------------------------------------------------
// Degradation-classification symmetry.
//
// The health body carries two parallel classifications: `degradation_causes`
// (typed) and `status_reasons` (free-form). Two asymmetries between them:
//
//   1. `degradation_causes` has a catch-all safety net (non-healthy + no cause
//      => 'unclassified'); `status_reasons` had none, so a non-healthy status
//      could theoretically emit `status_reasons: []`. Closed by the exported
//      `ensureStatusReasonFloor` helper (mirrors the causes net).
//   2. The #2280 silence latch pushes a `status_reason`
//      ('degradation_silence_unproven') with no matching degradation cause, so a
//      silence-latched-but-otherwise-quiet instance classified as the catch-all
//      'unclassified' cause instead of naming the silence latch. Closed by a
//      dedicated 'degradation_silence_unproven' cause raised from the same latch.
// ---------------------------------------------------------------------------
describe('degradation classification symmetry', () => {
  describe('ensureStatusReasonFloor (asymmetry 1 — status_reasons safety net)', () => {
    it('adds an unclassified catch-all when a degraded status carries no reasons', async () => {
      const { ensureStatusReasonFloor } = await import('../../src/core/health.ts');
      const reasons: string[] = [];
      ensureStatusReasonFloor('degraded', reasons);
      expect(reasons).toEqual(['unclassified']);
    });

    it('applies the same floor to an unhealthy status', async () => {
      const { ensureStatusReasonFloor } = await import('../../src/core/health.ts');
      const reasons: string[] = [];
      ensureStatusReasonFloor('unhealthy', reasons);
      expect(reasons).toEqual(['unclassified']);
    });

    it('never adds a reason to a healthy status', async () => {
      const { ensureStatusReasonFloor } = await import('../../src/core/health.ts');
      const reasons: string[] = [];
      ensureStatusReasonFloor('healthy', reasons);
      expect(reasons).toEqual([]);
    });

    it('leaves an already-populated reason list untouched', async () => {
      const { ensureStatusReasonFloor } = await import('../../src/core/health.ts');
      const reasons = ['enrichment_stale'];
      ensureStatusReasonFloor('degraded', reasons);
      expect(reasons).toEqual(['enrichment_stale']);
    });
  });

  describe('silence-latch degradation cause (asymmetry 2 — #2280)', () => {
    let db: Database;
    let prevToken: string | undefined;

    beforeEach(() => {
      prevToken = process.env.WHATSOUP_HEALTH_TOKEN;
      process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
      db = makeDb();
    });

    afterEach(() => {
      db.close();
      if (prevToken === undefined) delete process.env.WHATSOUP_HEALTH_TOKEN;
      else process.env.WHATSOUP_HEALTH_TOKEN = prevToken;
    });

    it('classifies a silence-latched degradation with a dedicated cause, not unclassified', async () => {
      // A single server instance holds the recently-degraded set across
      // requests, which is what arms the #2280 latch.
      let enrichmentRuntimeDegraded = true;
      const deps = makeDeps(db, {
        getEnrichmentStats: () => ({
          lastRun: null,
          unprocessed: 0,
          runtimeDegraded: enrichmentRuntimeDegraded,
        }),
      });
      const { server, port } = await buildTestServer(deps);
      try {
        // Request 1: a real degradation signal seeds recentlyDegraded.
        const first = JSON.parse((await healthReq(port)).body);
        expect(first.status).toBe('degraded');
        expect(first.status_reasons).toContain('enrichment_runtime_degraded');

        // Request 2: every live signal is quiet, but the silence latch keeps
        // the instance degraded because recovery was never proven.
        enrichmentRuntimeDegraded = false;
        const second = JSON.parse((await healthReq(port)).body);
        expect(second.status).toBe('degraded');
        expect(second.status_reasons).toContain('degradation_silence_unproven');

        // The classification must name the silence latch, not collapse to the
        // catch-all — that is the asymmetry this fix closes.
        expect(second.degradation_causes).toContain('degradation_silence_unproven');
        expect(second.degradation_causes).not.toContain('unclassified');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// #2280 silence-latch release: explicit recovery proof.
//
// The silence latch (degradation_silence_unproven) keeps an instance degraded
// when every live signal goes quiet after a real degradation, because silence
// from child processes is not proof of recovery. Without a proof channel the
// latch held for the LIFE OF THE PROCESS — a genuinely recovered instance
// (live example: ph-bot, 2026-08-26) reported degraded forever.
//
// Recovery-proof contract under test: the latch releases ONLY when
//   (1) the health evaluation observes turn-capability evidence of a
//       successful PRIMARY-provider turn (primary identity is only known when
//       the fallback-state snapshot reports NO window: fallbackActiveUntil is
//       null; a non-null value — even one already past expiry by check time —
//       means the snapshot was taken under a window, so its effectiveProvider
//       is not the primary),
//   (2) the receipt is strictly newer than the latch point (which advances on
//       EVERY evaluation observing real degradation reasons — including the
//       unhealthy branches and the late-computed reasons such as
//       schema_future — so an episode after the receipt invalidates it;
//       strictly-newer is the ONLY temporal guard: a genuine receipt never
//       expires by wall clock), and
//   (3) every reason in the latched set is turn-provable
//       (TURN_PROVABLE_STATUS_REASONS): a turn proves the turn pipeline (turn
//       capability, agent runtime, the connection it rode in on, and — by
//       construction of the release guard — the end of a fallback window) —
//       never enrichment/memory/durability/etc. FULL-VISIBILITY evaluations
//       (the normal degraded path, which re-checks every reason source)
//       REPLACE the latched set with their reasons — a blip that cleared
//       before such an evaluation was observed clearing, so it is not
//       unproven silence and must not poison the latch; SHORT-CIRCUIT
//       evaluations (auth / not-connected / runtime-unhealthy) UNION their
//       observed reasons in, never removing members they had no visibility
//       to re-check. Only real EARLY-path reasons on the full-visibility
//       path ARM a new latch — late-source-only reasons are directly probed
//       every evaluation and never arm.
// Silence alone, elapsed time alone, an empty reason list alone, a stale
// receipt, or a non-primary receipt never release. The latch itself is
// process-lifetime (in-memory): a restart clears it by amnesia, a known
// pre-existing hazard, not a release channel. Reason/cause symmetry must hold
// in both states.
// ---------------------------------------------------------------------------
describe('silence-latch release on fresh primary-turn receipt (#2280)', () => {
  let db: Database;
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.WHATSOUP_HEALTH_TOKEN;
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    db = makeDb();
    // Only the two clocks are faked, Date (the wall clock) and performance (the
    // monotonic clock): every clock read agrees and moves only with
    // advanceClock or stepWallClock, while the HTTP server's timers stay real.
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (prevToken === undefined) delete process.env.WHATSOUP_HEALTH_TOKEN;
    else process.env.WHATSOUP_HEALTH_TOKEN = prevToken;
  });

  // Turn-class degradation seed: model_usable=false + a non-transient error
  // class produce the 'turn_capability_degraded' status reason.
  function degradedTurnCapability(): Record<string, unknown> {
    return {
      modelUsable: false,
      modelUsabilityStatus: 'model-unavailable',
      lastSuccessfulTurnAt: null,
      lastTurnErrorClass: 'model-unavailable',
      lastTurnErrorAt: Date.now(),
    };
  }

  // Recovered turn capability carrying a successful-turn receipt from the
  // still-current session on the provider-default primary route (no explicit
  // model on either side). Route/session overrides ride via object spread.
  function receiptTurnCapability(at: number, provider: string): Record<string, unknown> {
    return {
      modelUsable: true,
      modelUsabilityStatus: 'usable',
      lastSuccessfulTurnAt: at,
      lastSuccessfulTurnProvider: provider,
      lastSuccessfulTurnSessionCurrent: true,
      lastTurnErrorClass: null,
      lastTurnErrorAt: null,
    };
  }

  // Agent-instance harness (or a chat instance, by option): one mutable
  // non-turn degradation signal (enrichment runtime), mutable turn-capability
  // evidence, a mutable fallback-state snapshot (default: on primary
  // 'claude-cli', no window), and a mutable connection flag (false →
  // 'connection_disconnected', status unhealthy).
  async function buildLatchHarness(options: { instanceType?: 'agent' | 'chat' } = {}): Promise<{
    server: ReturnType<typeof createServer>;
    port: number;
    setRuntimeDegraded: (v: boolean) => void;
    setTurnCapability: (tc: Record<string, unknown> | null) => void;
    setFallbackState: (s: { effectiveProvider: string; fallbackActiveUntil: number | null } | null) => void;
    setConnected: (v: boolean) => void;
    setRuntimeSnapshot: (status: 'healthy' | 'degraded', degradedReasons: string[] | null) => void;
    setChatQueue: (queuedChats: number) => void;
    setAuthBond: (bond: Record<string, unknown> | null) => void;
    setConnectionExtras: (extras: Record<string, unknown>) => void;
    setLoopStarved: (starved: boolean) => void;
    stallLoop: () => void;
    refillLoop: (samples: number) => void;
    recordDisconnect: () => void;
    recordSends: (count: number, dest?: string) => void;
    setDeliveryDebt: (stale: boolean) => void;
    setRetentionFailed: (failed: boolean) => void;
    setBeforeConnectionRead: (hook: (() => void) | null) => void;
  }> {
    let authBond: Record<string, unknown> | null = null;
    let connectionExtras: Record<string, unknown> = {};
    let beforeConnectionRead: (() => void) | null = null;
    // The sampler's verdict contract (src/lib/loop-lag-sampler.ts): starved
    // only on a full 20-sample window; a stall over 10 s empties the window
    // and counts one discontinuity. `starved` is the lag of the samples that
    // do arrive. Like the sampler, every starved sample stamps
    // lastStarvedMonotonicMs on the monotonic clock, and so does the sample
    // that ends a starved window.
    const loop = {
      sampleCount: LOOP_LAG_WINDOW_SAMPLES,
      starved: false,
      discontinuityCount: 0,
      lastStarvedMonotonicMs: null as number | null,
    };
    const windowStarved = (): boolean => loop.sampleCount === LOOP_LAG_WINDOW_SAMPLES && loop.starved;
    // The connection manager's own record and prune-on-read code on a bare
    // instance with no socket, and the real flood detector, both on the
    // frozen clocks.
    const disconnects = Object.create(ConnectionManager.prototype) as {
      recentDisconnects: unknown[];
      recordDisconnect(statusCode: number | null, reason: string): void;
      getRecentDisconnectSnapshot(): ConnectionRecentDisconnects;
    };
    disconnects.recentDisconnects = [];
    const floodDetector = new OutboundFloodDetector();
    let deliveryDebt = false;
    let retentionFailed = false;
    let runtimeDegraded = false;
    let tc: Record<string, unknown> | null = null;
    let fallback: { effectiveProvider: string; fallbackActiveUntil: number | null } | null =
      { effectiveProvider: 'claude-cli', fallbackActiveUntil: null };
    let connected = true;
    let runtimeStatus: 'healthy' | 'degraded' = 'healthy';
    let runtimeReasons: string[] | null = null;
    let chatQueue: { activeChats: number; queuedChats: number } | null = null;
    const deps = makeDeps(db, {
      instanceType: options.instanceType ?? 'agent',
      getEnrichmentStats: () => ({ lastRun: null, unprocessed: 0, runtimeDegraded }),
      getDatabaseRetentionHealth: () => ({
        running: false,
        state: retentionFailed ? 'failed' : 'succeeded',
        consecutiveFailures: retentionFailed ? 1 : 0,
        failureCode: retentionFailed ? 'retention_failed' : null,
        lastRunAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastResult: null,
      }),
      connectionManager: {
        botJid: '15551230004@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: () => {
          beforeConnectionRead?.();
          const flood = floodDetector.stats();
          return {
            ...emptyConnectionStateSnapshot({
              connected,
              stateChangedAt: '2026-07-29T00:00:00.000Z',
              lastDisconnectReason: null,
            }),
            recentDisconnects: disconnects.getRecentDisconnectSnapshot(),
            outboundFlood: {
              windowMs: flood.windowMs,
              threshold: flood.threshold,
              flooding: flood.flooding,
              destCount: flood.destCount,
              worstDestHash: flood.worstKey === null ? null : 'abc123def456',
              worstCount: flood.worstCount,
              lastFloodingMonotonicMs: flood.lastFloodingMonotonicMs,
            },
            ...(authBond === null ? {} : { authBond }),
            ...connectionExtras,
          };
        },
      } as unknown as ConnectionManager,
      // A modelled window in place of the real sampler, so no case depends on
      // this host's actual loop lag.
      loopLagSampler: {
        start: vi.fn(),
        stop: vi.fn(),
        snapshot: () => {
          if (windowStarved()) loop.lastStarvedMonotonicMs = performance.now();
          return {
            sampleCount: loop.sampleCount,
            p95LagMs: loop.sampleCount === 0 ? null : loop.starved ? 1_008 : 2,
            locallyStarved: windowStarved(),
            discontinuityCount: loop.discontinuityCount,
            lastStarvedMonotonicMs: loop.lastStarvedMonotonicMs,
            // The modelled sampler never restarts, so a partial window after
            // any discontinuity is still refilling from it.
            refillingAfterDiscontinuity: loop.sampleCount < LOOP_LAG_WINDOW_SAMPLES && loop.discontinuityCount > 0,
            minLagMs: null,
            medianLagMs: null,
            maxLagMs: null,
            intervalSampleCount: loop.sampleCount,
            snapshotSampleCount: 0,
            lastEluUtilization: null,
            lastCpuDeltaMs: null,
            observerCostMs: 0,
          };
        },
        beginObserverSpan: vi.fn().mockReturnValue(() => {}),
        recordObserverSpan: vi.fn(),
        rawSamples: vi.fn().mockReturnValue([]),
        rawSamplePage: vi.fn().mockReturnValue({
          oldestSequence: null,
          latestSequence: null,
          nextAfter: 0,
          truncated: false,
          gap: null,
          samples: [],
        }),
      } as unknown as HealthDeps['loopLagSampler'],
      // One uncorroborated maybe_sent delivery older than the 30-minute stale
      // bound while deliveryDebt is set; a clean ledger otherwise.
      durability: {
        getHealthStats: () => ({
          oldestMaybeSentAt: null,
          deliveryAmbiguity: {
            readable: true,
            uncorroboratedAmbiguous: deliveryDebt ? 1 : 0,
            corroboratedRetained: 0,
            oldestUncorroboratedAt: deliveryDebt
              ? new Date(Date.now() - 31 * 60_000).toISOString().slice(0, 19).replace('T', ' ')
              : null,
          },
        }),
      } as unknown as NonNullable<HealthDeps['durability']>,
      runtime: {
        getHealthSnapshot: () => ({
          status: runtimeStatus,
          details: {
            ...(tc === null ? {} : { turnCapability: tc }),
            ...(runtimeReasons === null ? {} : { degradedReasons: runtimeReasons }),
            ...(chatQueue === null ? {} : { queue: chatQueue }),
          },
        }),
        getFallbackState: () => (fallback === null ? null : {
          ...fallback,
          fallbackTurnsServed: 0,
          fallbackTurnsEmpty: 0,
          lastFallbackTurnAt: null,
        }),
      } as unknown as HealthDeps['runtime'],
    });
    const { server, port } = await buildTestServer(deps);
    return {
      server,
      port,
      setRuntimeDegraded: (v: boolean) => { runtimeDegraded = v; },
      setTurnCapability: (next: Record<string, unknown> | null) => { tc = next; },
      setFallbackState: (s: { effectiveProvider: string; fallbackActiveUntil: number | null } | null) => { fallback = s; },
      setConnected: (v: boolean) => { connected = v; },
      setRuntimeSnapshot: (status: 'healthy' | 'degraded', degradedReasons: string[] | null) => {
        runtimeStatus = status;
        runtimeReasons = degradedReasons;
      },
      // A chat runtime reports degraded while chats queue (src/runtimes/chat).
      setChatQueue: (queuedChats: number) => {
        chatQueue = { activeChats: 1, queuedChats };
        runtimeStatus = queuedChats > 0 ? 'degraded' : 'healthy';
      },
      setAuthBond: (bond: Record<string, unknown> | null) => { authBond = bond; },
      setConnectionExtras: (extras: Record<string, unknown>) => { connectionExtras = extras; },
      setLoopStarved: (starved: boolean) => {
        if (windowStarved() && !starved) loop.lastStarvedMonotonicMs = performance.now();
        loop.starved = starved;
      },
      stallLoop: () => {
        if (windowStarved()) loop.lastStarvedMonotonicMs = performance.now();
        loop.sampleCount = 0;
        loop.discontinuityCount += 1;
      },
      refillLoop: (samples: number) => {
        loop.sampleCount = Math.min(LOOP_LAG_WINDOW_SAMPLES, loop.sampleCount + samples);
      },
      recordDisconnect: () => disconnects.recordDisconnect(440, 'connectionReplaced'),
      recordSends: (count: number, dest = FLOOD_DEST) => {
        for (let sent = 0; sent < count; sent += 1) floodDetector.record(dest);
      },
      setDeliveryDebt: (stale: boolean) => { deliveryDebt = stale; },
      setRetentionFailed: (failed: boolean) => { retentionFailed = failed; },
      setBeforeConnectionRead: (hook: (() => void) | null) => { beforeConnectionRead = hook; },
    };
  }

  function expectLatched(json: Record<string, unknown>): void {
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('degradation_silence_unproven');
    expect(json.degradation_causes).toContain('degradation_silence_unproven');
  }

  function expectReleased(json: Record<string, unknown>): void {
    expect(json.status).toBe('healthy');
    expect(json.status_reasons).not.toContain('degradation_silence_unproven');
    expect(json.degradation_causes).not.toContain('degradation_silence_unproven');
  }

  // Deterministic clocks: Date and performance are frozen per test
  // (beforeEach), so latch stamps, hold marks and receipt timestamps move only
  // here, and real elapsed time never decides a strictly-newer or
  // hold-boundary check. advanceClock is time passing: both clocks move.
  // stepWallClock moves only the wall clock, as a host clock step does.
  const advanceClock = (ms: number): void => { vi.advanceTimersByTime(ms); };
  const stepWallClock = (ms: number): void => { vi.setSystemTime(Date.now() + ms); };
  const harnessNow = (): number => Date.now();

  // Test-owned windows and holds; tests/core/health-reason-hold.test.ts pins
  // the holds to the source constants and the windows to their producers.
  const MINUTE_MS = 60_000;
  const CHURN_WINDOW_MS = 10 * 60_000;
  const FLOOD_WINDOW_MS = 5 * 60_000;
  const STARVATION_HOLD_MS = 5 * 60_000;
  const CHURN_HOLD_MS = 10 * 60_000;
  const FLOOD_HOLD_MS = 5 * 60_000;
  // The producers extend each hold by 1% of its window for clock drift.
  const CHURN_DRIFT_MS = 6_000;
  const FLOOD_DRIFT_MS = 3_000;
  const FLOOD_THRESHOLD = 20;
  const FLOOD_DEST = '15551230009@s.whatsapp.net';
  const SECOND_FLOOD_DEST = '15551230010@s.whatsapp.net';

  // Seed a turn-class latch (every latched reason turn-provable).
  async function seedTurnClassLatch(h: Awaited<ReturnType<typeof buildLatchHarness>>): Promise<void> {
    h.setTurnCapability(degradedTurnCapability());
    const first = JSON.parse((await healthReq(h.port)).body);
    expect(first.status).toBe('degraded');
    expect(first.status_reasons).toContain('turn_capability_degraded');
    h.setTurnCapability(null);
  }

  it('releases a turn-class latch on a fresh primary-turn receipt newer than the latch point', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const second = JSON.parse((await healthReq(h.port)).body);
      expectReleased(second);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a non-turn-class latch is not released by a turn receipt (a turn proves the turn pipeline only)', async () => {
    const h = await buildLatchHarness();
    try {
      h.setRuntimeDegraded(true);
      const first = JSON.parse((await healthReq(h.port)).body);
      expect(first.status).toBe('degraded');
      expect(first.status_reasons).toContain('enrichment_runtime_degraded');

      h.setRuntimeDegraded(false);
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const second = JSON.parse((await healthReq(h.port)).body);
      expectLatched(second);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a receipt under a fallback-window snapshot does not release even if the window expired mid-evaluation', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      advanceClock(1000);
      // The snapshot says a window exists (non-null expiry) but the expiry is
      // already behind the clock by the time the release check compares — the
      // race a wall-clock liveness test loses. The snapshot's
      // effectiveProvider is the FALLBACK provider and must not pass as
      // primary.
      h.setFallbackState({ effectiveProvider: 'openai-api', fallbackActiveUntil: Date.now() - 1 });
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'openai-api'));
      const second = JSON.parse((await healthReq(h.port)).body);
      expectLatched(second);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('an unhealthy episode advances the latch point: a receipt predating it does not release', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      // Receipt T1: newer than the seed latch, fresh, primary.
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      // Unhealthy episode T2 > T1: disconnected transport.
      advanceClock(1000);
      h.setConnected(false);
      const second = JSON.parse((await healthReq(h.port)).body);
      expect(second.status).toBe('unhealthy');
      expect(second.status_reasons).toContain('connection_disconnected');

      // Reconnect T3: every live signal quiet, but the only receipt predates
      // the unhealthy episode — recovery is NOT proven.
      h.setConnected(true);
      const third = JSON.parse((await healthReq(h.port)).body);
      expectLatched(third);

      // A receipt newer than the unhealthy episode proves the round trip and
      // releases (the connection classes ride the turn pipeline).
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const fourth = JSON.parse((await healthReq(h.port)).body);
      expectReleased(fourth);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a stale receipt older than the latch point does not release', async () => {
    const h = await buildLatchHarness();
    try {
      const staleAt = harnessNow() - 1000;
      await seedTurnClassLatch(h);
      h.setTurnCapability(receiptTurnCapability(staleAt, 'claude-cli'));
      const second = JSON.parse((await healthReq(h.port)).body);
      expectLatched(second);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('silence alone never releases: no receipt and empty reasons stay latched across evaluations', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      const second = JSON.parse((await healthReq(h.port)).body);
      expectLatched(second);
      // Elapsed time / repeated quiet evaluations alone must not release either.
      advanceClock(1000);
      const third = JSON.parse((await healthReq(h.port)).body);
      expectLatched(third);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a fresh receipt from a non-primary provider does not release', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'openai-api'));
      const second = JSON.parse((await healthReq(h.port)).body);
      expectLatched(second);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('after a release, a new degradation re-latches and only a NEWER fresh receipt releases again', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      advanceClock(1000);
      const firstReceiptAt = harnessNow();
      h.setTurnCapability(receiptTurnCapability(firstReceiptAt, 'claude-cli'));
      const second = JSON.parse((await healthReq(h.port)).body);
      expectReleased(second);

      // A NEW turn-class degradation re-latches normally...
      advanceClock(1000);
      h.setTurnCapability(degradedTurnCapability());
      const third = JSON.parse((await healthReq(h.port)).body);
      expect(third.status).toBe('degraded');
      expect(third.status_reasons).toContain('turn_capability_degraded');
      expect(third.status_reasons).not.toContain('degradation_silence_unproven');

      // ...and the receipt that released the FIRST latch predates the new
      // latch point, so it must not release this one.
      h.setTurnCapability(receiptTurnCapability(firstReceiptAt, 'claude-cli'));
      const fourth = JSON.parse((await healthReq(h.port)).body);
      expectLatched(fourth);

      // A receipt newer than the new latch point releases again.
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const fifth = JSON.parse((await healthReq(h.port)).body);
      expectReleased(fifth);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a non-provable blip that clears before the last real evaluation does not poison the latch', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      // A non-provable enrichment blip arrives WHILE the turn-class
      // degradation is still live...
      h.setTurnCapability(degradedTurnCapability());
      h.setRuntimeDegraded(true);
      const second = JSON.parse((await healthReq(h.port)).body);
      expect(second.status).toBe('degraded');
      expect(second.status_reasons).toContain('turn_capability_degraded');
      expect(second.status_reasons).toContain('enrichment_runtime_degraded');

      // ...and clears while a real evaluation still observes the turn-class
      // reason: the LAST real evaluation shows turn-class only, so the blip
      // was observed clearing — it is not unproven silence.
      h.setRuntimeDegraded(false);
      const third = JSON.parse((await healthReq(h.port)).body);
      expect(third.status).toBe('degraded');
      expect(third.status_reasons).toContain('turn_capability_degraded');
      expect(third.status_reasons).not.toContain('enrichment_runtime_degraded');

      h.setTurnCapability(null);
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const fourth = JSON.parse((await healthReq(h.port)).body);
      expectReleased(fourth);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('no release while the LAST real evaluation still shows a non-provable reason', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      // The final real evaluation before silence carries the enrichment
      // reason — the receipt cannot prove THAT recovered.
      h.setTurnCapability(degradedTurnCapability());
      h.setRuntimeDegraded(true);
      const second = JSON.parse((await healthReq(h.port)).body);
      expect(second.status).toBe('degraded');
      expect(second.status_reasons).toContain('enrichment_runtime_degraded');

      h.setRuntimeDegraded(false);
      h.setTurnCapability(null);
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const third = JSON.parse((await healthReq(h.port)).body);
      expectLatched(third);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a late-computed unhealthy episode (schema_future) advances the latch point', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      // Receipt T1: newer than the seed latch.
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      // T2: schema_future is computed AFTER the early status chain — only
      // latch maintenance that runs truly last can observe it.
      advanceClock(1000);
      db.raw.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(CURRENT_SCHEMA_MIGRATION + 1);
      const second = JSON.parse((await healthReq(h.port)).body);
      expect(second.status).toBe('unhealthy');
      expect(second.status_reasons).toContain('schema_future');

      // T3: episode over; the only receipt predates it — NOT proof.
      db.raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(CURRENT_SCHEMA_MIGRATION + 1);
      const third = JSON.parse((await healthReq(h.port)).body);
      expectLatched(third);

      // The episode's reason set {schema_future} is not turn-provable, so
      // even a FRESH receipt does not release — fail-closed by design; a
      // schema_future episode resolves through operator action + restart.
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const fourth = JSON.parse((await healthReq(h.port)).body);
      expectLatched(fourth);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('an unhealthy-only history never arms the latch: healthy immediately after recovery', async () => {
    const h = await buildLatchHarness();
    try {
      // No prior degraded evaluation — straight to unhealthy.
      h.setConnected(false);
      const first = JSON.parse((await healthReq(h.port)).body);
      expect(first.status).toBe('unhealthy');
      expect(first.status_reasons).toContain('connection_disconnected');

      h.setConnected(true);
      const second = JSON.parse((await healthReq(h.port)).body);
      expect(second.status).toBe('healthy');
      expect(second.status_reasons).not.toContain('degradation_silence_unproven');
      expect(second.degradation_causes).not.toContain('degradation_silence_unproven');
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a late-source-only transient blip never arms the latch', async () => {
    const h = await buildLatchHarness();
    try {
      // No early-path degradation ever. A late-source-only reason appears
      // (schema_not_ready is computed after the early status chain)...
      db.raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(CURRENT_SCHEMA_MIGRATION);
      const first = JSON.parse((await healthReq(h.port)).body);
      expect(first.status).toBe('degraded');
      expect(first.status_reasons).toContain('schema_not_ready');
      expect(first.status_reasons).not.toContain('degradation_silence_unproven');

      // ...and clears. Late-source reasons are directly probed every
      // evaluation — they are not silence-prone and need no silence latch.
      db.raw.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(CURRENT_SCHEMA_MIGRATION);
      const second = JSON.parse((await healthReq(h.port)).body);
      expect(second.status).toBe('healthy');
      expect(second.status_reasons).not.toContain('degradation_silence_unproven');
      expect(second.degradation_causes).not.toContain('degradation_silence_unproven');
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a fallback-window outage releases after revert on a fresh primary receipt', async () => {
    const h = await buildLatchHarness();
    try {
      // Outage: the runtime reports degraded with the window-derived reason
      // while a fallback window is live.
      h.setFallbackState({ effectiveProvider: 'openai-api', fallbackActiveUntil: Date.now() + 600_000 });
      h.setRuntimeSnapshot('degraded', ['provider_fallback_active']);
      const first = JSON.parse((await healthReq(h.port)).body);
      expect(first.status).toBe('degraded');
      expect(first.status_reasons).toContain('runtime.provider_fallback_active');

      // Revert: window over, primary serving again, fresh primary receipt.
      // The release guard only accepts a primary receipt while NO window is
      // live, so acceptance itself proves the window ended — the reason is
      // turn-provable by construction of the guard.
      h.setRuntimeSnapshot('healthy', null);
      h.setFallbackState({ effectiveProvider: 'claude-cli', fallbackActiveUntil: null });
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const second = JSON.parse((await healthReq(h.port)).body);
      expectReleased(second);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('an unhealthy-verdict evaluation never arms, even with real early-path reasons', async () => {
    const h = await buildLatchHarness();
    try {
      // Evaluation 1: a real EARLY-path reason (enrichment) is observed, but
      // a late block flips the final verdict to unhealthy — schema_future
      // even REPLACES the reason list, so an arm here would latch a set that
      // lost the early evidence entirely. Arming on an unhealthy verdict
      // contradicts the scoping that unhealthy verdicts advance/restore only.
      h.setRuntimeDegraded(true);
      db.raw.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(CURRENT_SCHEMA_MIGRATION + 1);
      const first = JSON.parse((await healthReq(h.port)).body);
      expect(first.status).toBe('unhealthy');
      expect(first.status_reasons).toContain('schema_future');

      // Evaluation 2: everything clear — no latch may have been armed. The
      // silence window this leaves is exactly base behavior for every
      // unhealthy verdict.
      h.setRuntimeDegraded(false);
      db.raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(CURRENT_SCHEMA_MIGRATION + 1);
      const second = JSON.parse((await healthReq(h.port)).body);
      expect(second.status).toBe('healthy');
      expect(second.status_reasons).not.toContain('degradation_silence_unproven');
      expect(second.degradation_causes).not.toContain('degradation_silence_unproven');

      // A later plain degraded evaluation arms normally.
      h.setRuntimeDegraded(true);
      const third = JSON.parse((await healthReq(h.port)).body);
      expect(third.status).toBe('degraded');
      expect(third.status_reasons).toContain('enrichment_runtime_degraded');
      h.setRuntimeDegraded(false);
      const fourth = JSON.parse((await healthReq(h.port)).body);
      expectLatched(fourth);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a same-provider receipt from a DIFFERENT model than the explicit primary does not release', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      advanceClock(1000);
      // Same provider, wrong model: a /model-pinned chat serving another
      // claude-cli model is NOT the primary route — its success proves that
      // route, not the one the latch is about.
      h.setTurnCapability({
        ...receiptTurnCapability(harnessNow(), 'claude-cli'),
        lastSuccessfulTurnModel: 'claude-haiku-4-5',
        lastSuccessfulTurnSessionCurrent: true,
        primaryModel: 'claude-opus-4-5',
      });
      const second = JSON.parse((await healthReq(h.port)).body);
      expectLatched(second);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('an explicit primary model with an UNKNOWN receipt model does not release', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      advanceClock(1000);
      // Fail closed: when the primary model is explicit, a receipt that
      // cannot name its serving model proves nothing about the primary route.
      h.setTurnCapability({
        ...receiptTurnCapability(harnessNow(), 'claude-cli'),
        lastSuccessfulTurnSessionCurrent: true,
        primaryModel: 'claude-opus-4-5',
      });
      const second = JSON.parse((await healthReq(h.port)).body);
      expectLatched(second);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a provider-default primary does not release on a model-pinned receipt', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      advanceClock(1000);
      // The pinned rule for a provider-default primary: the receipt's model
      // must be absent/default too — a model-pinned session's success is a
      // different route.
      h.setTurnCapability({
        ...receiptTurnCapability(harnessNow(), 'claude-cli'),
        lastSuccessfulTurnModel: 'claude-haiku-4-5',
        lastSuccessfulTurnSessionCurrent: true,
      });
      const second = JSON.parse((await healthReq(h.port)).body);
      expectLatched(second);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a receipt from a rotated or dead session does not release (session-current guard)', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      advanceClock(1000);
      // Explicitly not current: the success belongs to a session incarnation
      // that no longer exists — it says nothing about the live route.
      h.setTurnCapability({
        ...receiptTurnCapability(harnessNow(), 'claude-cli'),
        lastSuccessfulTurnSessionCurrent: false,
      });
      const second = JSON.parse((await healthReq(h.port)).body);
      expectLatched(second);

      // Unknown currency fails closed too.
      advanceClock(1000);
      h.setTurnCapability({
        ...receiptTurnCapability(harnessNow(), 'claude-cli'),
        lastSuccessfulTurnSessionCurrent: null,
      });
      const third = JSON.parse((await healthReq(h.port)).body);
      expectLatched(third);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a short-circuit evaluation must not launder a non-provable latch', async () => {
    const h = await buildLatchHarness();
    try {
      // Non-provable latch: enrichment-class.
      h.setRuntimeDegraded(true);
      const first = JSON.parse((await healthReq(h.port)).body);
      expect(first.status).toBe('degraded');
      expect(first.status_reasons).toContain('enrichment_runtime_degraded');
      h.setRuntimeDegraded(false);

      // A disconnect evaluation short-circuits before the enrichment probes
      // run — it has no visibility to re-check them, so it must UNION its
      // observed reason into the latch, never replace the set.
      h.setConnected(false);
      const second = JSON.parse((await healthReq(h.port)).body);
      expect(second.status).toBe('unhealthy');
      expect(second.status_reasons).toContain('connection_disconnected');

      h.setConnected(true);
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const third = JSON.parse((await healthReq(h.port)).body);
      expectLatched(third);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  // An auto-compact backoff is recomputed by the runtime on every snapshot and
  // suppresses only new compactions, never turns. Latching it gave the latch a
  // reason no turn receipt can prove, so a live agent instance that served
  // normally read degradation_silence_unproven until its process restarted.
  it('an auto-compact backoff episode, then a fresh primary turn: health reads healthy', async () => {
    const h = await buildLatchHarness();
    try {
      h.setRuntimeSnapshot('degraded', ['auto_compact_backoff']);
      const first = JSON.parse((await healthReq(h.port)).body);
      expect(first.status).toBe('degraded');
      expect(first.status_reasons).toContain('runtime.auto_compact_backoff');

      // The backoff window ends, then the instance serves a primary-route turn.
      h.setRuntimeSnapshot('healthy', null);
      await healthReq(h.port);
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const afterTurn = JSON.parse((await healthReq(h.port)).body);
      expectReleased(afterTurn);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a backoff-only evaluation does not replace a turn-class latch with a set no turn can prove', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      // A full-visibility evaluation replaces the latched set with the reasons
      // it observes. When the backoff is the ONLY reason, latching it would
      // swap a provable set for an unprovable one.
      h.setRuntimeSnapshot('degraded', ['auto_compact_backoff']);
      const second = JSON.parse((await healthReq(h.port)).body);
      expect(second.status).toBe('degraded');
      expect(second.status_reasons).toContain('runtime.auto_compact_backoff');
      expect(second.status_reasons).not.toContain('turn_capability_degraded');

      // Window over: the turn-class latch still stands, because nothing has
      // proven the turn pipeline yet...
      h.setRuntimeSnapshot('healthy', null);
      const third = JSON.parse((await healthReq(h.port)).body);
      expectLatched(third);

      // ...and a fresh primary receipt proves it and releases.
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const fourth = JSON.parse((await healthReq(h.port)).body);
      expectReleased(fourth);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a primary receipt that arrives DURING a backoff releases a turn-class latch once the window ends', async () => {
    const h = await buildLatchHarness();
    try {
      await seedTurnClassLatch(h);
      h.setRuntimeSnapshot('degraded', ['auto_compact_backoff']);
      const windowOpen = JSON.parse((await healthReq(h.port)).body);
      expect(windowOpen.status_reasons).toContain('runtime.auto_compact_backoff');

      // A primary-route turn completes while the window is still open. The
      // backoff is reported, so no release is attempted on this evaluation.
      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const receiptInWindow = JSON.parse((await healthReq(h.port)).body);
      expect(receiptInWindow.status).toBe('degraded');
      expect(receiptInWindow.status_reasons).toEqual(['runtime.auto_compact_backoff']);

      // The window ends. Backoff-only evaluations never advanced the latch
      // point, so the receipt from inside the window is newer than it and
      // releases the latch with no further turn.
      h.setRuntimeSnapshot('healthy', null);
      const windowEnded = JSON.parse((await healthReq(h.port)).body);
      expectReleased(windowEnded);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  // Never worse than base: every literal the agent runtime can put in
  // degradedReasons (getHealthSnapshot, both session-scope branches, plus the
  // account-identity reasons) is classified here on purpose. Directly
  // re-probed reasons never arm the latch; the fallback-window reason, provable
  // by construction of the release guard, latches and releases on a fresh
  // primary receipt; every other reason latches and a turn does not release it.
  // Test-owned literals: moving any reason between the sets fails its row, so
  // a membership change has to be a deliberate edit to this table. The
  // completeness test below fails when the runtime gains a reason this table
  // does not classify.
  const RELEASED_STATE = { status: 'healthy', silenceReason: false, silenceCause: false };
  const LATCHED_STATE = { status: 'degraded', silenceReason: true, silenceCause: true };
  const runtimeReasonLatchTable = [
    { reason: 'auto_compact_backoff', kind: 'directly re-probed', afterClear: RELEASED_STATE, afterReceipt: RELEASED_STATE },
    { reason: 'turn_finalization_debt', kind: 'directly re-probed', afterClear: RELEASED_STATE, afterReceipt: RELEASED_STATE },
    { reason: 'completed_delivery_identity_debt', kind: 'directly re-probed', afterClear: RELEASED_STATE, afterReceipt: RELEASED_STATE },
    { reason: 'per_chat_session_without_owner', kind: 'directly re-probed', afterClear: RELEASED_STATE, afterReceipt: RELEASED_STATE },
    { reason: 'per_chat_respawn_abandoned', kind: 'directly re-probed', afterClear: RELEASED_STATE, afterReceipt: RELEASED_STATE },
    { reason: 'agent_respawn_failed_clear_pending', kind: 'directly re-probed', afterClear: RELEASED_STATE, afterReceipt: RELEASED_STATE },
    { reason: 'provider_fallback_active', kind: 'turn-provable', afterClear: LATCHED_STATE, afterReceipt: RELEASED_STATE },
    { reason: 'session_inactive', kind: 'latched', afterClear: LATCHED_STATE, afterReceipt: LATCHED_STATE },
    { reason: 'recent_crashes', kind: 'latched', afterClear: LATCHED_STATE, afterReceipt: LATCHED_STATE },
    { reason: 'turn_queue_halted', kind: 'latched', afterClear: LATCHED_STATE, afterReceipt: LATCHED_STATE },
    { reason: 'outbound_queue_poisoned', kind: 'latched', afterClear: LATCHED_STATE, afterReceipt: LATCHED_STATE },
    { reason: 'provider_execution_pressure', kind: 'latched', afterClear: LATCHED_STATE, afterReceipt: LATCHED_STATE },
    { reason: 'poll_persistence_failure', kind: 'latched', afterClear: LATCHED_STATE, afterReceipt: LATCHED_STATE },
    { reason: 'offline_decision_retry_exhausted', kind: 'latched', afterClear: LATCHED_STATE, afterReceipt: LATCHED_STATE },
    { reason: 'credential_identity_mismatch', kind: 'latched', afterClear: LATCHED_STATE, afterReceipt: LATCHED_STATE },
    { reason: 'credential_identity_unverifiable', kind: 'latched', afterClear: LATCHED_STATE, afterReceipt: LATCHED_STATE },
  ];

  it('the runtime-reason table classifies every runtime reason the cause registry names', () => {
    // The registry's runtime.* twins are exactly the runtime's degradedReasons
    // literals: tests/core/health-cause-reason-twins.test.ts fails on a pushed
    // literal no cause names and on a twin the emitting source lacks. A new runtime
    // reason therefore fails here until it is given a row above.
    const registered = [...new Set(
      Object.values(HEALTH_DEGRADATION_CAUSE_REASON_TWINS)
        .flatMap((twins) => (twins === NO_REASON_TWIN ? [] : [...twins]))
        .filter((reason) => reason.startsWith('runtime.')),
    )].sort();
    expect(registered.length, 'no runtime reason twins found; the registry read is broken').toBeGreaterThanOrEqual(16);
    expect(runtimeReasonLatchTable.map(({ reason }) => `runtime.${reason}`).sort()).toEqual(registered);
  });

  function latchState(json: Record<string, unknown>): typeof RELEASED_STATE {
    return {
      status: json.status as string,
      silenceReason: (json.status_reasons as string[]).includes('degradation_silence_unproven'),
      silenceCause: (json.degradation_causes as string[]).includes('degradation_silence_unproven'),
    };
  }

  it.each(runtimeReasonLatchTable)(
    'runtime.$reason ($kind) across an episode, its clear and a fresh primary receipt',
    async ({ reason, afterClear, afterReceipt }) => {
      const h = await buildLatchHarness();
      try {
        h.setRuntimeSnapshot('degraded', [reason]);
        const episode = JSON.parse((await healthReq(h.port)).body);
        // No reason base reports is dropped: it is visible while it holds.
        expect(episode.status).toBe('degraded');
        expect(episode.status_reasons).toContain(`runtime.${reason}`);

        h.setRuntimeSnapshot('healthy', null);
        const cleared = JSON.parse((await healthReq(h.port)).body);
        expect(latchState(cleared)).toEqual(afterClear);

        advanceClock(1000);
        h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
        const receipted = JSON.parse((await healthReq(h.port)).body);
        expect(latchState(receipted)).toEqual(afterReceipt);
      } finally {
        await new Promise<void>((resolve) => h.server.close(() => resolve()));
      }
    },
  );

  // Start path. /health reads the auth-bond cache, which is empty until the
  // first tree walk since process start publishes; connect-time credential
  // writes supersede walks in flight. Until then the bond reads `unknown` with
  // the single issue auth_tree_unobserved, the class is auth_bond_at_risk, and
  // that reason armed a latch no turn can prove: a freshly restarted instance
  // read latch-only while it served turns. The reason is still REPORTED while
  // the first walk is pending; it only stays out of the latch.
  function treeProvenance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
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
      ...overrides,
    };
  }
  const NEVER_WALKED = { source: 'absent', ageMs: null, refreshInFlight: true, refreshCount: 0, lastRefreshKind: 'none', refreshAttemptCount: 1 };
  const firstWalkPendingBond = (): Record<string, unknown> => makeAuthBond({
    status: 'unknown',
    issues: ['auth_tree_unobserved'],
    treeHash: null,
    treeProvenance: treeProvenance({ ...NEVER_WALKED, firstWalkPending: true }),
  });
  const walkedCleanBond = (): Record<string, unknown> => makeAuthBond({ treeProvenance: treeProvenance() });

  it('a boot poll before the first auth-tree walk, the walk, then a primary turn: never latch-only', async () => {
    const h = await buildLatchHarness();
    try {
      h.setAuthBond(firstWalkPendingBond());
      const boot = JSON.parse((await healthReq(h.port)).body);
      // Reported exactly as base while pending.
      expect(boot.status).toBe('degraded');
      expect(boot.status_reasons).toContain('auth_failure.auth_bond_at_risk');
      expect(boot.status_reasons).not.toContain('degradation_silence_unproven');

      // The first walk publishes a clean tree.
      h.setAuthBond(walkedCleanBond());
      const walked = JSON.parse((await healthReq(h.port)).body);
      expectReleased(walked);

      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const afterTurn = JSON.parse((await healthReq(h.port)).body);
      expectReleased(afterTurn);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  // Never worse than base: every at-risk verdict that is not "first walk still
  // pending" latches exactly as before, and a turn does not release it.
  const authBondLatchTable = [
    {
      name: 'the first walk completes and finds the tree at risk',
      steps: [
        firstWalkPendingBond(),
        makeAuthBond({ issues: ['auth_mode_chmod_failed:creds.json:EPERM'], treeProvenance: treeProvenance() }),
      ],
    },
    {
      name: 'the first walk never completes within the stale-risk bound',
      steps: [
        firstWalkPendingBond(),
        makeAuthBond({
          status: 'unknown',
          issues: ['auth_tree_unobserved'],
          treeHash: null,
          treeProvenance: treeProvenance({ ...NEVER_WALKED, firstWalkPending: false }),
        }),
      ],
    },
    {
      name: 'a backup capture error while the first walk is pending',
      steps: [
        makeAuthBond({
          status: 'unknown',
          issues: ['auth_tree_unobserved'],
          treeHash: null,
          treeProvenance: treeProvenance({ ...NEVER_WALKED, firstWalkPending: true }),
          backup: { lastCaptureError: 'capture failed: disk full' },
        }),
      ],
    },
    {
      name: 'a backup restore error while the first walk is pending',
      steps: [
        makeAuthBond({
          status: 'unknown',
          issues: ['auth_tree_unobserved'],
          treeHash: null,
          treeProvenance: treeProvenance({ ...NEVER_WALKED, firstWalkPending: true }),
          backup: { lastRestoreError: 'restore failed: verification mismatch' },
        }),
      ],
    },
    {
      name: 'a published walk that aged past the stale-risk bound',
      steps: [
        makeAuthBond({
          status: 'unknown',
          issues: ['auth_tree_stale:130000'],
          treeProvenance: treeProvenance({ source: 'stale', ageMs: 130_000 }),
        }),
      ],
    },
    {
      name: 'a transient credential read after a completed walk',
      steps: [
        makeAuthBond({
          status: 'invalid',
          issues: ['creds_json_read_transient:EAGAIN'],
          treeProvenance: treeProvenance(),
          transientReadPersistent: false,
        }),
      ],
    },
    {
      name: 'a transient credential read while the first walk is pending',
      steps: [
        makeAuthBond({
          status: 'invalid',
          issues: ['creds_json_read_transient:EAGAIN'],
          treeHash: null,
          treeProvenance: treeProvenance({ ...NEVER_WALKED, firstWalkPending: true }),
          transientReadPersistent: false,
        }),
      ],
    },
  ];

  it.each(authBondLatchTable)('auth bond: $name latches as base', async ({ steps }) => {
    const h = await buildLatchHarness();
    try {
      for (const bond of steps) {
        h.setAuthBond(bond);
        const episode = JSON.parse((await healthReq(h.port)).body);
        expect(episode.status).toBe('degraded');
        expect(episode.status_reasons).toContain('auth_failure.auth_bond_at_risk');
      }

      h.setAuthBond(walkedCleanBond());
      const cleared = JSON.parse((await healthReq(h.port)).body);
      expect(latchState(cleared)).toEqual(LATCHED_STATE);

      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const receipted = JSON.parse((await healthReq(h.port)).body);
      expect(latchState(receipted)).toEqual(LATCHED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('the latch-set log line names the latched reason codes, sorted', async () => {
    const h = await buildLatchHarness();
    try {
      const callsBefore = healthLogger.info.mock.calls.length;
      // A re-probed reason in the same evaluation is reported but not latched,
      // so it must not appear in the logged set either.
      h.setRuntimeSnapshot('degraded', ['turn_queue_halted', 'auto_compact_backoff', 'recent_crashes']);
      const armed = JSON.parse((await healthReq(h.port)).body);
      expect(armed.status).toBe('degraded');

      const latchSetLines = healthLogger.info.mock.calls
        .slice(callsBefore)
        .filter((call) => call[1] === 'degradation silence latch set');
      expect(latchSetLines).toHaveLength(1);
      expect(latchSetLines[0]![0]).toEqual({
        instance: expect.any(String),
        reasons: ['runtime.recent_crashes', 'runtime.turn_queue_halted'],
      });
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  // Early reasons recomputed from live or durable state on every evaluation.
  // Each used to enter the latch, and none is turn-provable, so once the
  // condition cleared the instance read latch-only until restart: a live agent
  // instance did after a single starved health read. They now never enter the
  // latch and never open its arm gate. The three windowed ones (starvation,
  // churn, flood) stay reported until a hold has passed since the condition
  // last held, as the producer records it, so detection does not depend on
  // when /health is read; delivery debt has no hold. The holds run on the
  // monotonic clock. Every boundary below is exact: the frozen clocks make
  // real elapsed time irrelevant.
  type LatchHarness = Awaited<ReturnType<typeof buildLatchHarness>>;
  async function poll(h: LatchHarness): Promise<Record<string, unknown>> {
    return JSON.parse((await healthReq(h.port)).body) as Record<string, unknown>;
  }
  // Held, not latched: the reason itself is reported, never the silence reason.
  function expectHeld(json: Record<string, unknown>, reason: string): void {
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain(reason);
    expect(json.status_reasons).not.toContain('degradation_silence_unproven');
  }
  function disconnectCount(json: Record<string, unknown>): number {
    const whatsapp = json.whatsapp as { connection: { recent_disconnects: { count: number } } };
    return whatsapp.connection.recent_disconnects.count;
  }
  function latchSetReasons(callsBefore: number): string[][] {
    return healthLogger.info.mock.calls
      .slice(callsBefore)
      .filter((call) => call[1] === 'degradation silence latch set')
      .map((call) => (call[0] as { reasons: string[] }).reasons);
  }

  const reprobedEarlyReasonTable: Array<{
    reason: string;
    holdMs: number;
    begin: (h: LatchHarness) => void;
    // Ends the live condition and returns how long ago it last held: negative
    // while a producer's drift-extended held-until is still ahead.
    end: (h: LatchHarness) => number;
  }> = [
    {
      reason: 'event_loop_starvation',
      holdMs: STARVATION_HOLD_MS,
      begin: (h) => h.setLoopStarved(true),
      // A full window of on-time samples, with no discontinuity.
      end: (h) => { h.setLoopStarved(false); return 0; },
    },
    {
      reason: 'connection_churn',
      holdMs: CHURN_HOLD_MS,
      // Three disconnects hold churn until they leave the window, inclusive,
      // plus the drift extension.
      begin: (h) => {
        for (let n = 0; n < 3; n += 1) h.recordDisconnect();
      },
      end: () => { advanceClock(CHURN_WINDOW_MS + 1); return 1 - CHURN_DRIFT_MS; },
    },
    {
      reason: 'outbound_flood',
      holdMs: FLOOD_HOLD_MS,
      begin: (h) => h.recordSends(FLOOD_THRESHOLD),
      end: () => { advanceClock(FLOOD_WINDOW_MS + 1); return 1 - FLOOD_DRIFT_MS; },
    },
    {
      reason: 'durability_delivery_debt',
      holdMs: 0,
      begin: (h) => h.setDeliveryDebt(true),
      end: (h) => { h.setDeliveryDebt(false); return 0; },
    },
  ];

  it.each(reprobedEarlyReasonTable)(
    '$reason alone never strands the latch: healthy with no turn once its hold ($holdMs ms) has passed',
    async ({ reason, holdMs, begin, end }) => {
      const h = await buildLatchHarness();
      try {
        begin(h);
        // Reported exactly as base while it holds.
        expectHeld(await poll(h), reason);

        const sinceLastHeldMs = end(h);
        const cleared = await poll(h);
        if (holdMs > 0) {
          // Still reported once the live condition has ended, as the reason
          // itself and never as the silence reason, until exactly one hold
          // after the condition last held.
          expectHeld(cleared, reason);
          advanceClock(holdMs - sinceLastHeldMs - 1);
          expectHeld(await poll(h), reason);
          advanceClock(1);
          expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
        } else {
          expect(latchState(cleared)).toEqual(RELEASED_STATE);
        }

        advanceClock(1000);
        h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
        expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      } finally {
        await new Promise<void>((resolve) => h.server.close(() => resolve()));
      }
    },
  );

  it('recurring loop stalls over 10 s keep event_loop_starvation reported; it clears a hold after the last unreadable poll, with no turn', async () => {
    const h = await buildLatchHarness();
    try {
      // On-time samples between stalls: a full window reads clear.
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      let lastDetectionAtMs = 0;
      // A stall every 30 s for 6 minutes, longer than the hold, polled every
      // 5 s while 10 samples arrive per poll interval.
      for (let stall = 0; stall < 12; stall += 1) {
        h.stallLoop();
        // A discontinuity since the last poll: the emptied window is unreadable.
        expectHeld(await poll(h), 'event_loop_starvation');
        for (let step = 1; step <= 5; step += 1) {
          advanceClock(5_000);
          h.refillLoop(10);
          // Step 1 reads a partial window after the reset (unreadable, so the
          // condition holds); later steps read a full clean window, reported
          // from the hold.
          if (step === 1) lastDetectionAtMs = harnessNow();
          expectHeld(await poll(h), 'event_loop_starvation');
        }
        advanceClock(5_000);
      }

      advanceClock(lastDetectionAtMs + STARVATION_HOLD_MS - 1 - harnessNow());
      expectHeld(await poll(h), 'event_loop_starvation');
      advanceClock(1);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it.each([
    { period: '4 minutes', periodMs: 4 * MINUTE_MS, churnAtMinute8: true },
    { period: '4.9 minutes', periodMs: 4.9 * MINUTE_MS, churnAtMinute8: false },
  ])(
    'a connection flapping every $period reads connection_churn at sparse polls (minutes 8, 19, 31) and clears exactly one hold after it last held',
    async ({ periodMs, churnAtMinute8 }) => {
      const h = await buildLatchHarness();
      try {
        const startMs = harnessNow();
        const at = (offsetMs: number): void => advanceClock(startMs + offsetMs - harnessNow());
        const flaps: number[] = [];
        for (let t = 0; t <= 31 * MINUTE_MS; t += periodMs) flaps.push(t);
        const polls = [8, 19, 31].map((minute) => minute * MINUTE_MS);
        // A disconnect and a poll at the same instant: the disconnect first.
        const timeline = [
          ...flaps.map((t) => ({ t, flap: true })),
          ...polls.map((t) => ({ t, flap: false })),
        ].sort((a, b) => a.t - b.t || Number(b.flap) - Number(a.flap));
        let polledBelowThreshold = false;
        for (const { t, flap } of timeline) {
          at(t);
          if (flap) {
            h.recordDisconnect();
            continue;
          }
          const json = await poll(h);
          if (t === 8 * MINUTE_MS && !churnAtMinute8) {
            // Only two disconnects so far: no churn yet.
            expect(latchState(json)).toEqual(RELEASED_STATE);
            continue;
          }
          polledBelowThreshold ||= disconnectCount(json) < 3;
          expectHeld(json, 'connection_churn');
        }
        expect(polledBelowThreshold, 'every poll saw 3 in the window; the case tests nothing').toBe(true);

        // Churn last held until the third-newest disconnect left the window,
        // plus the drift extension.
        const lastHeldMs = flaps[flaps.length - 3]! + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
        at(lastHeldMs + CHURN_HOLD_MS - 1);
        expectHeld(await poll(h), 'connection_churn');
        at(lastHeldMs + CHURN_HOLD_MS);
        expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      } finally {
        await new Promise<void>((resolve) => h.server.close(() => resolve()));
      }
    },
  );

  it('a starved episode that begins and ends between two polls is reported at the next poll within the hold', async () => {
    const h = await buildLatchHarness();
    try {
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      advanceClock(MINUTE_MS);
      h.setLoopStarved(true);
      advanceClock(MINUTE_MS);
      h.setLoopStarved(false);
      const endedAtMs = harnessNow();
      advanceClock(2 * MINUTE_MS);
      expectHeld(await poll(h), 'event_loop_starvation');
      advanceClock(endedAtMs + STARVATION_HOLD_MS - 1 - harnessNow());
      expectHeld(await poll(h), 'event_loop_starvation');
      advanceClock(1);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a flood that begins and ends between two polls is reported at the next poll within the hold', async () => {
    const h = await buildLatchHarness();
    try {
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      advanceClock(MINUTE_MS);
      h.recordSends(FLOOD_THRESHOLD);
      // The burst floods until its sends leave the window, inclusive, plus the
      // drift extension.
      const endedAtMs = harnessNow() + FLOOD_WINDOW_MS + FLOOD_DRIFT_MS;
      advanceClock(7 * MINUTE_MS);
      expectHeld(await poll(h), 'outbound_flood');
      advanceClock(endedAtMs + FLOOD_HOLD_MS - 1 - harnessNow());
      expectHeld(await poll(h), 'outbound_flood');
      advanceClock(1);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  // Wall clock steps. A step does not move a hold already recorded on the
  // monotonic clock; it moves base's own wall-clock windows (count,
  // flooding), which alone decide whether churn or a flood exists.
  const windowedStepTable: Array<{
    reason: string;
    windowMs: number;
    holdMs: number;
    driftMs: number;
    begin: (h: LatchHarness) => void;
  }> = [
    {
      reason: 'connection_churn',
      windowMs: CHURN_WINDOW_MS,
      holdMs: CHURN_HOLD_MS,
      driftMs: CHURN_DRIFT_MS,
      begin: (h) => {
        for (let n = 0; n < 3; n += 1) h.recordDisconnect();
      },
    },
    {
      reason: 'outbound_flood',
      windowMs: FLOOD_WINDOW_MS,
      holdMs: FLOOD_HOLD_MS,
      driftMs: FLOOD_DRIFT_MS,
      begin: (h) => h.recordSends(FLOOD_THRESHOLD),
    },
  ];

  it.each(windowedStepTable)(
    '$reason that has cleared stays healthy at every poll after the wall clock steps back an hour',
    async ({ reason, windowMs, holdMs, driftMs, begin }) => {
      const h = await buildLatchHarness();
      try {
        begin(h);
        expectHeld(await poll(h), reason);
        advanceClock(windowMs + driftMs + holdMs + MINUTE_MS);
        expect(latchState(await poll(h))).toEqual(RELEASED_STATE);

        stepWallClock(-60 * MINUTE_MS);
        for (let minute = 0; minute <= 70; minute += 1) {
          expect(latchState(await poll(h)), `minute ${minute} after the step`).toEqual(RELEASED_STATE);
          advanceClock(MINUTE_MS);
        }
      } finally {
        await new Promise<void>((resolve) => h.server.close(() => resolve()));
      }
    },
  );

  it.each(windowedStepTable)(
    '$reason stays held through a forward wall step until one hold after its held-until',
    async ({ reason, windowMs, holdMs, driftMs, begin }) => {
      const h = await buildLatchHarness();
      try {
        begin(h);
        expectHeld(await poll(h), reason);
        // Base's wall-clock window drops the entries; the recorded hold does not.
        stepWallClock(60 * MINUTE_MS);
        expectHeld(await poll(h), reason);
        advanceClock(windowMs + driftMs + holdMs - 1);
        expectHeld(await poll(h), reason);
        advanceClock(1);
        expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      } finally {
        await new Promise<void>((resolve) => h.server.close(() => resolve()));
      }
    },
  );

  // A new episode after a backward step, read only once its window has
  // emptied, is held until one hold after its own held-until. The poller
  // reads right after the step, as it would every 5 s.
  it('a new churn episode after the wall clock steps back is held until one hold after its own held-until', async () => {
    const h = await buildLatchHarness();
    try {
      // 12:00: three disconnects, held until 12:10; healthy at 12:21.
      for (let n = 0; n < 3; n += 1) h.recordDisconnect();
      expectHeld(await poll(h), 'connection_churn');
      advanceClock(21 * MINUTE_MS);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      // Stepped back to 11:21; three new disconnects at 11:25.
      stepWallClock(-60 * MINUTE_MS);
      await poll(h);
      advanceClock(4 * MINUTE_MS);
      for (let n = 0; n < 3; n += 1) h.recordDisconnect();
      // 11:36: the new episode's window has emptied; it held until 11:35 plus
      // the drift extension.
      advanceClock(11 * MINUTE_MS);
      const emptied = await poll(h);
      expect(disconnectCount(emptied)).toBe(0);
      expectHeld(emptied, 'connection_churn');
      advanceClock(9 * MINUTE_MS + CHURN_DRIFT_MS - 1);
      expectHeld(await poll(h), 'connection_churn');
      advanceClock(1);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a new flood to another destination after the wall clock steps back is held until one hold after its own held-until', async () => {
    const h = await buildLatchHarness();
    try {
      // 12:00: a burst, flooding until 12:05; healthy at 12:11.
      h.recordSends(FLOOD_THRESHOLD);
      expectHeld(await poll(h), 'outbound_flood');
      advanceClock(11 * MINUTE_MS);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      // Stepped back to 11:11; a burst to another destination at 11:15.
      stepWallClock(-60 * MINUTE_MS);
      await poll(h);
      advanceClock(4 * MINUTE_MS);
      h.recordSends(FLOOD_THRESHOLD, SECOND_FLOOD_DEST);
      // 11:21: its sends have left the window; it flooded until 11:20 plus
      // the drift extension.
      advanceClock(6 * MINUTE_MS);
      expectHeld(await poll(h), 'outbound_flood');
      advanceClock(4 * MINUTE_MS + FLOOD_DRIFT_MS - 1);
      expectHeld(await poll(h), 'outbound_flood');
      advanceClock(1);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  // Base's count alone decides whether churn or a flood exists; the
  // monotonic clock only times the hold. With no step the two clocks still
  // disagree: Date.now() truncates to whole milliseconds while
  // performance.now() does not (a fractional tick moves only the latter), and
  // a pause can separate the two reads inside one record.
  const clockDisagreementTable = [
    {
      reason: 'connection_churn',
      windowMs: CHURN_WINDOW_MS,
      holdMs: CHURN_HOLD_MS,
      driftMs: CHURN_DRIFT_MS,
      record: (h: LatchHarness, count: number) => { for (let n = 0; n < count; n += 1) h.recordDisconnect(); },
      total: 3,
      baseHolds: (json: Record<string, unknown>) => disconnectCount(json) >= 3,
    },
    {
      reason: 'outbound_flood',
      windowMs: FLOOD_WINDOW_MS,
      holdMs: FLOOD_HOLD_MS,
      driftMs: FLOOD_DRIFT_MS,
      record: (h: LatchHarness, count: number) => h.recordSends(count),
      total: FLOOD_THRESHOLD,
      baseHolds: (json: Record<string, unknown>) =>
        (json.whatsapp as { connection: { outbound_flood: { flooding: boolean } } }).connection.outbound_flood.flooding,
    },
  ];

  it.each(clockDisagreementTable)(
    '$reason that base counted, 0.8 ms over one window on the monotonic clock, is held from the first poll after',
    async ({ reason, windowMs, holdMs, driftMs, record, total, baseHolds }) => {
      const h = await buildLatchHarness();
      try {
        // (wall, monotonic) offsets: (0, 0.1), then (W/2, W/2 + 0.5), then (W, W + 0.9).
        advanceClock(0.1);
        record(h, 1);
        advanceClock(windowMs / 2 + 0.4);
        record(h, total - 2);
        advanceClock(windowMs / 2 + 0.4);
        record(h, 1);
        advanceClock(1);
        const first = await poll(h);
        expect(baseHolds(first)).toBe(false);
        expectHeld(first, reason);
        // Held until one hold after the oldest entry (monotonic 0.1) left the
        // window plus the drift extension; the first poll is at W + 1.9.
        advanceClock(holdMs + driftMs - 2);
        expectHeld(await poll(h), reason);
        advanceClock(2);
        expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      } finally {
        await new Promise<void>((resolve) => h.server.close(() => resolve()));
      }
    },
  );

  // The first clock read inside `record` returns, then `pauseMs` pass before
  // the next read of either clock.
  function withPauseAfterFirstClockRead(pauseMs: number, record: () => void): void {
    const dateNow = Date.now.bind(Date);
    const perfNow = performance.now.bind(performance);
    let paused = false;
    const pauseAfter = (valueMs: number): number => {
      if (!paused) {
        paused = true;
        advanceClock(pauseMs);
      }
      return valueMs;
    };
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => pauseAfter(dateNow()));
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => pauseAfter(perfNow()));
    try {
      record();
    } finally {
      dateSpy.mockRestore();
      perfSpy.mockRestore();
    }
    expect(paused, 'record read no clock').toBe(true);
  }

  it.each(clockDisagreementTable)(
    '$reason completed by an entry with a 2 s pause between its wall and monotonic reads is held from the first poll after',
    async ({ reason, windowMs, holdMs, driftMs, record, total, baseHolds }) => {
      const h = await buildLatchHarness();
      try {
        // (wall, monotonic): (0, 0), (W/2, W/2), then (W, W + 2000).
        record(h, 1);
        advanceClock(windowMs / 2);
        record(h, total - 2);
        advanceClock(windowMs / 2);
        withPauseAfterFirstClockRead(2_000, () => record(h, 1));
        advanceClock(1);
        const first = await poll(h);
        expect(baseHolds(first)).toBe(false);
        expectHeld(first, reason);
        // Held until one hold after the oldest entry left the window plus the
        // drift extension; the first poll is at W + 2001.
        advanceClock(driftMs + holdMs - 2_002);
        expectHeld(await poll(h), reason);
        advanceClock(1);
        expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      } finally {
        await new Promise<void>((resolve) => h.server.close(() => resolve()));
      }
    },
  );

  // The handler's earlier work takes time before the connection read. The
  // hold reads the clock after the producers do, so a stamp is never later
  // than its now, and the hold runs from the held-until on that clock.
  it('a poll that reads the connection just after churn\'s held-until clears exactly one hold after it, on the producer\'s clock', async () => {
    const h = await buildLatchHarness();
    try {
      for (let n = 0; n < 3; n += 1) h.recordDisconnect();
      const heldUntilMs = harnessNow() + CHURN_WINDOW_MS + CHURN_DRIFT_MS;
      const skewMs = 5;
      h.setBeforeConnectionRead(() => advanceClock(skewMs));
      // Each poll starts skewMs before it reads the connection.
      const pollReadingAt = async (readAtMs: number): Promise<Record<string, unknown>> => {
        advanceClock(readAtMs - skewMs - harnessNow());
        return poll(h);
      };
      // Starts before the held-until and reads the connection after it. Each
      // later poll starts no earlier than the previous one read.
      expectHeld(await pollReadingAt(heldUntilMs + skewMs - 1), 'connection_churn');
      expectHeld(await pollReadingAt(heldUntilMs + CHURN_HOLD_MS - skewMs), 'connection_churn');
      expect(latchState(await pollReadingAt(heldUntilMs + CHURN_HOLD_MS))).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  // Only a reason the latch can hold opens its arm gate. A directly re-probed
  // reason, held or live, beside a late reason arms nothing: the late reason
  // never latched alone, and keeping a reason out of the latch must not turn
  // it into an arming trigger.
  it('held churn after a reconnect beside database_retention_failed arms no latch; healthy once both clear', async () => {
    const h = await buildLatchHarness();
    try {
      const callsBefore = healthLogger.info.mock.calls.length;
      h.setConnected(false);
      h.recordDisconnect();
      h.recordDisconnect();
      advanceClock(9 * MINUTE_MS);
      h.recordDisconnect();
      expect((await poll(h)).status).toBe('unhealthy');
      // Two minutes later the first two have left the window: churn is held.
      advanceClock(2 * MINUTE_MS);
      h.setConnected(true);
      h.setRetentionFailed(true);
      const both = await poll(h);
      expectHeld(both, 'connection_churn');
      expect(both.status_reasons).toContain('database_retention_failed');
      expect(disconnectCount(both)).toBe(1);

      h.setRetentionFailed(false);
      advanceClock(CHURN_HOLD_MS);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      expect(latchSetReasons(callsBefore)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('starvation held from a discontinuity beside the chat runtime\'s late runtime_degraded arms no latch', async () => {
    const h = await buildLatchHarness({ instanceType: 'chat' });
    try {
      const callsBefore = healthLogger.info.mock.calls.length;
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      // One stall over 10 s, refilled clean before the next poll.
      h.stallLoop();
      h.refillLoop(LOOP_LAG_WINDOW_SAMPLES);
      h.setChatQueue(2);
      const both = await poll(h);
      expectHeld(both, 'event_loop_starvation');
      expect(both.status_reasons).toContain('runtime_degraded');

      h.setChatQueue(0);
      advanceClock(STARVATION_HOLD_MS);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      expect(latchSetReasons(callsBefore)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('recovery_debt_blocking beside a late reason arms no latch', async () => {
    const h = await buildLatchHarness();
    try {
      const callsBefore = healthLogger.info.mock.calls.length;
      h.setDeliveryDebt(true);
      h.setRetentionFailed(true);
      const both = await poll(h);
      expect(both.status_reasons).toEqual(
        expect.arrayContaining(['recovery_debt_blocking', 'database_retention_failed']),
      );

      h.setDeliveryDebt(false);
      h.setRetentionFailed(false);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      expect(latchSetReasons(callsBefore)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a latch-worthy early reason beside a late reason still arms on both, as base', async () => {
    const h = await buildLatchHarness();
    try {
      const callsBefore = healthLogger.info.mock.calls.length;
      h.setTurnCapability(degradedTurnCapability());
      h.setRetentionFailed(true);
      expect((await poll(h)).status).toBe('degraded');
      expect(latchSetReasons(callsBefore)).toEqual([['database_retention_failed', 'turn_capability_degraded']]);

      h.setTurnCapability(null);
      h.setRetentionFailed(false);
      expect(latchState(await poll(h))).toEqual(LATCHED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a connection snapshot without its disconnect window reads connection_churn held, not clear', async () => {
    const h = await buildLatchHarness();
    try {
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      h.setConnectionExtras({ recentDisconnects: undefined });
      expectHeld(await poll(h), 'connection_churn');
      // Every unreadable poll refreshes the hold.
      advanceClock(CHURN_HOLD_MS);
      expectHeld(await poll(h), 'connection_churn');

      h.setConnectionExtras({});
      expectHeld(await poll(h), 'connection_churn');
      advanceClock(CHURN_HOLD_MS);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('a flood snapshot that goes missing after being supplied reads outbound_flood held; one never supplied reads clear', async () => {
    // A transport with no flood detector (the SMS bridge) never supplies one.
    const never = await buildLatchHarness();
    try {
      never.setConnectionExtras({ outboundFlood: undefined });
      expect(latchState(await poll(never))).toEqual(RELEASED_STATE);
      expect(latchState(await poll(never))).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => never.server.close(() => resolve()));
    }

    const h = await buildLatchHarness();
    try {
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
      h.setConnectionExtras({ outboundFlood: undefined });
      expectHeld(await poll(h), 'outbound_flood');

      h.setConnectionExtras({});
      advanceClock(FLOOD_HOLD_MS);
      expect(latchState(await poll(h))).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });

  it('starvation beside a turn-provable reason arms on the provable reason only, and a turn releases it', async () => {
    const h = await buildLatchHarness();
    try {
      const callsBefore = healthLogger.info.mock.calls.length;
      h.setLoopStarved(true);
      h.setTurnCapability(degradedTurnCapability());
      const episode = await poll(h);
      expect(episode.status_reasons).toEqual(
        expect.arrayContaining(['event_loop_starvation', 'turn_capability_degraded']),
      );
      const latchSetLines = healthLogger.info.mock.calls
        .slice(callsBefore)
        .filter((call) => call[1] === 'degradation silence latch set');
      expect(latchSetLines).toHaveLength(1);
      expect((latchSetLines[0]![0] as { reasons: string[] }).reasons).toEqual(['turn_capability_degraded']);

      h.setLoopStarved(false);
      h.setTurnCapability(null);
      // Starvation is still held, so the turn reason's latch waits beneath it.
      const cleared = await poll(h);
      expectHeld(cleared, 'event_loop_starvation');
      expect(cleared.status_reasons).not.toContain('turn_capability_degraded');
      advanceClock(STARVATION_HOLD_MS);
      expect(latchState(await poll(h))).toEqual(LATCHED_STATE);

      advanceClock(1000);
      h.setTurnCapability(receiptTurnCapability(harnessNow(), 'claude-cli'));
      const receipted = JSON.parse((await healthReq(h.port)).body);
      expect(latchState(receipted)).toEqual(RELEASED_STATE);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
    }
  });
});
