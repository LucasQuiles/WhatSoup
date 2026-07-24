import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';
import {
  LOOP_LAG_SAMPLE_INTERVAL_MS,
  LOOP_LAG_STARVATION_THRESHOLD_MS,
  LOOP_LAG_WINDOW_SAMPLES,
  LoopLagSampler,
} from '../../src/lib/loop-lag-sampler.ts';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn(),
  clearAlertSource: vi.fn(() => true),
}));
const alertThrottleStore = vi.hoisted(() => ({
  loadAlertThrottleDetailed: vi.fn((): {
    entries: Map<string, string>;
    loadError: { file: string; code?: string; error: string } | null;
  } => ({ entries: new Map<string, string>(), loadError: null })),
  recordAlertThrottle: vi.fn(),
}));
const silenceManager = vi.hoisted(() => ({
  isInstanceSilenced: vi.fn(() => false),
}));
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: alertFns.emitAlert,
  emitAlertChecked: alertFns.emitAlert,
  clearAlertSourceChecked: alertFns.clearAlertSource,
}));
vi.mock('../../src/fleet/alert-throttle-store.ts', () => ({
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1_000,
  ...alertThrottleStore,
}));
vi.mock('../../src/fleet/silence-manager.ts', () => silenceManager);
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    ...logger,
    child: vi.fn().mockReturnThis(),
  }),
}));

describe('LoopLagSampler', () => {
  let nowMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createSampler(): LoopLagSampler {
    return new LoopLagSampler({ now: () => nowMs });
  }

  function recordLag(lagMs: number): void {
    nowMs += LOOP_LAG_SAMPLE_INTERVAL_MS + lagMs;
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
  }

  it('samples every 500ms and clamps early callbacks to zero lag', () => {
    const sampler = createSampler();
    sampler.start();

    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS - 1);
    expect(sampler.snapshot().sampleCount).toBe(0);

    nowMs = 100;
    vi.advanceTimersByTime(1);
    expect(sampler.snapshot()).toMatchObject({
      sampleCount: 1,
      p95LagMs: 0,
      locallyStarved: false,
    });

    sampler.stop();
  });

  it('does not treat a wall-clock jump as event-loop lag', () => {
    const sampler = new LoopLagSampler();
    sampler.start();

    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);

    expect(sampler.snapshot()).toEqual({
      sampleCount: 1,
      p95LagMs: 0,
      locallyStarved: false,
    });

    sampler.stop();
  });

  it('requires exactly 20 effective samples and uses nearest-rank p95', () => {
    const sampler = createSampler();
    sampler.start();

    for (let index = 0; index < LOOP_LAG_WINDOW_SAMPLES - 1; index += 1) {
      recordLag(LOOP_LAG_STARVATION_THRESHOLD_MS + 1);
    }
    expect(sampler.snapshot()).toEqual({
      sampleCount: 19,
      p95LagMs: 251,
      locallyStarved: false,
    });

    sampler.stop();
    sampler.start();
    for (let index = 0; index < LOOP_LAG_WINDOW_SAMPLES; index += 1) {
      recordLag(index === LOOP_LAG_WINDOW_SAMPLES - 1 ? 251 : 0);
    }
    expect(sampler.snapshot()).toEqual({
      sampleCount: 20,
      p95LagMs: 0,
      locallyStarved: false,
    });

    sampler.stop();
    sampler.start();
    for (let index = 0; index < LOOP_LAG_WINDOW_SAMPLES; index += 1) {
      recordLag(index >= LOOP_LAG_WINDOW_SAMPLES - 2 ? 251 : 0);
    }
    expect(sampler.snapshot()).toEqual({
      sampleCount: 20,
      p95LagMs: 251,
      locallyStarved: true,
    });

    sampler.stop();
    sampler.start();
    for (let index = 0; index < LOOP_LAG_WINDOW_SAMPLES; index += 1) {
      recordLag(LOOP_LAG_STARVATION_THRESHOLD_MS);
    }
    expect(sampler.snapshot()).toEqual({
      sampleCount: 20,
      p95LagMs: 250,
      locallyStarved: false,
    });

    sampler.stop();
  });

  it('evaluates exactly one provisional overdue sample without mutating the window', () => {
    const sampler = createSampler();
    sampler.start();
    for (let index = 0; index < LOOP_LAG_WINDOW_SAMPLES - 1; index += 1) recordLag(0);

    const internal = sampler as unknown as { samples: number[]; expectedAtMs: number | null };
    const completedBeforeSnapshot = [...internal.samples];
    const expectedBeforeSnapshot = internal.expectedAtMs;
    nowMs += 5_000;

    const first = sampler.snapshot();
    const second = sampler.snapshot();
    expect(first).toEqual({
      sampleCount: 20,
      p95LagMs: 0,
      locallyStarved: false,
    });
    expect(second).toEqual(first);
    expect(internal.samples).toEqual(completedBeforeSnapshot);
    expect(internal.expectedAtMs).toBe(expectedBeforeSnapshot);

    sampler.stop();
  });

  it('keeps only the trailing 20 samples', () => {
    const sampler = createSampler();
    sampler.start();

    for (let index = 0; index < LOOP_LAG_WINDOW_SAMPLES; index += 1) recordLag(251);
    expect(sampler.snapshot().locallyStarved).toBe(true);

    for (let index = 0; index < LOOP_LAG_WINDOW_SAMPLES; index += 1) recordLag(0);
    expect(sampler.snapshot()).toEqual({
      sampleCount: 20,
      p95LagMs: 0,
      locallyStarved: false,
    });

    sampler.stop();
  });

  it('starts and stops idempotently and resets its window across restarts', () => {
    const sampler = createSampler();
    const timersBeforeStart = vi.getTimerCount();

    sampler.start();
    sampler.start();
    expect(vi.getTimerCount()).toBe(timersBeforeStart + 1);
    for (let index = 0; index < LOOP_LAG_WINDOW_SAMPLES; index += 1) recordLag(251);
    expect(sampler.snapshot().locallyStarved).toBe(true);

    sampler.stop();
    sampler.stop();
    expect(vi.getTimerCount()).toBe(timersBeforeStart);
    expect(sampler.snapshot()).toEqual({
      sampleCount: 0,
      p95LagMs: null,
      locallyStarved: false,
    });

    sampler.start();
    expect(sampler.snapshot().sampleCount).toBe(0);
    sampler.stop();
  });

  it('unrefs its real interval so it cannot hold the process open', () => {
    vi.useRealTimers();
    const sampler = createSampler();

    sampler.start();
    const timer = (sampler as unknown as { timer: NodeJS.Timeout | null }).timer;
    expect(timer).not.toBeNull();
    expect(timer!.hasRef()).toBe(false);
    sampler.stop();
  });
});

interface FakeSamplerControl {
  sampler: LoopLagSampler;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setSnapshot(snapshot: {
    sampleCount: number;
    p95LagMs: number | null;
    locallyStarved: boolean;
  }): void;
}

function createFakeSampler(locallyStarved = false): FakeSamplerControl {
  let current = {
    sampleCount: locallyStarved ? 20 : 0,
    p95LagMs: locallyStarved ? 300 : null,
    locallyStarved,
  };
  const start = vi.fn();
  const stop = vi.fn();
  const sampler = {
    start,
    stop,
    snapshot: vi.fn(() => current),
  } as unknown as LoopLagSampler;
  return {
    sampler,
    start,
    stop,
    setSnapshot(snapshot) {
      current = snapshot;
    },
  };
}

function makeInstance(name: string, healthPort: number): InstanceHealth {
  return {
    name,
    type: 'chat',
    accessMode: 'open',
    healthPort,
    dbPath: '/tmp/whatsoup-test-instance.db',
    healthToken: null,
  };
}

function onlineHealth(instancePid?: number): Record<string, unknown> {
  return {
    status: 'healthy',
    generated_at: new Date().toISOString(),
    runtime: {},
    ...(instancePid === undefined ? {} : { instance: { pid: instancePid } }),
    whatsapp: {
      connected: true,
      account_jid: 'redacted-account@s.whatsapp.net',
      connection: {
        state: 'connected',
        reconnect_phase: null,
        reconnect_attempts: 0,
        auth_failure_class: 'none',
      },
    },
  };
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

function durableAlertResult(): AlertEmissionResult {
  return { ok: true, channel: 'outbox', status: 'durably_queued' };
}

type PollerPrivate = {
  poll(): Promise<void>;
  failureStartedAt: Map<string, number>;
  unreachableAlerted: Set<string>;
};

function privatePoll(poller: HealthPoller): Promise<void> {
  return (poller as unknown as PollerPrivate).poll();
}

function pollerState(poller: HealthPoller): PollerPrivate {
  return poller as unknown as PollerPrivate;
}

describe('HealthPoller probe liveness', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T16:00:00.000Z'));
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    alertFns.emitAlert.mockReset().mockReturnValue(durableAlertResult());
    alertFns.clearAlertSource.mockReset().mockReturnValue(true);
    alertThrottleStore.loadAlertThrottleDetailed.mockReset().mockReturnValue({
      entries: new Map<string, string>(),
      loadError: null,
    });
    alertThrottleStore.recordAlertThrottle.mockReset();
    silenceManager.isInstanceSilenced.mockReset().mockReturnValue(false);
    for (const fn of Object.values(logger)) fn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('owns one sampler lifecycle across idempotent start and stop calls', async () => {
    const sampler = createFakeSampler();
    const poller = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      1_000,
      sampler.sampler,
    );

    await poller.start();
    await poller.start();
    expect(sampler.start).toHaveBeenCalledTimes(1);

    poller.stop();
    poller.stop();
    expect(sampler.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      caseName: 'one overdue high sample after healthy lag history accrues a target failure',
      priorHighSamples: 0,
      expectedP95LagMs: 0,
      expectedLocallyStarved: false,
      expectedReason: 'health_poll_failed_transient',
      expectedConfidence: 'inferred',
    },
    {
      caseName: 'one prior high plus one overdue high sample suppresses escalation',
      priorHighSamples: 1,
      expectedP95LagMs: 300,
      expectedLocallyStarved: true,
      expectedReason: 'health_probe_timeout_under_proxy_load',
      expectedConfidence: 'ambiguous',
    },
  ])('uses the actual sampler when $caseName', async ({
    priorHighSamples,
    expectedP95LagMs,
    expectedLocallyStarved,
    expectedReason,
    expectedConfidence,
  }) => {
    let samplerNowMs = 0;
    let settleAbort: (() => void) | undefined;
    const sampler = new LoopLagSampler({ now: () => samplerNowMs });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth()) })
      .mockImplementation((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        const rejectAsAbort = (): void => reject(abortError());
        init?.signal?.addEventListener('abort', rejectAsAbort, { once: true });
        settleAbort = rejectAsAbort;
      }));
    const instances = new Map([
      ['remote-1', makeInstance('remote-1', 9100)],
    ]);
    const poller = new HealthPoller(
      () => instances,
      'self',
      vi.fn().mockReturnValue({}),
      60_000,
      sampler,
    );

    await poller.start();
    for (let index = 0; index < LOOP_LAG_WINDOW_SAMPLES - 1; index += 1) {
      const lagMs = index >= LOOP_LAG_WINDOW_SAMPLES - 1 - priorHighSamples ? 300 : 0;
      samplerNowMs += LOOP_LAG_SAMPLE_INTERVAL_MS + lagMs;
      vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    }

    // Advance the sampler's monotonic clock without running fake timers: the
    // interval is overdue, but its callback is still queued behind this abort.
    samplerNowMs += LOOP_LAG_SAMPLE_INTERVAL_MS + 300;
    const failingPoll = privatePoll(poller);
    expect(settleAbort).toBeTypeOf('function');
    settleAbort!();
    await failingPoll;

    expect(sampler.snapshot()).toEqual({
      sampleCount: 20,
      p95LagMs: expectedP95LagMs,
      locallyStarved: expectedLocallyStarved,
    });
    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      statusConfidence: expectedConfidence,
      statusReason: expectedReason,
      consecutiveFailures: 1,
      everReachable: true,
    });
    if (expectedLocallyStarved) {
      expect(poller.getStatus('remote-1')?.statusEvidence).toEqual(expect.arrayContaining([
        'event_loop_lag_p95_ms=300',
        'event_loop_lag_samples=20',
      ]));
    } else {
      expect(poller.getStatus('remote-1')?.error).toBe('The operation was aborted');
    }

    poller.stop();
  });

  it('escalates abort-before-connect failures normally without local starvation', async () => {
    const sampler = createFakeSampler(false);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth()) })
      .mockRejectedValue(abortError());
    const instances = new Map([
      ['remote-1', makeInstance('remote-1', 9100)],
    ]);
    const poller = new HealthPoller(
      () => instances,
      'self',
      vi.fn().mockReturnValue({}),
      15_000,
      sampler.sampler,
    );

    await poller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    const failureStartedAt = pollerState(poller).failureStartedAt.get('remote-1');
    expect(failureStartedAt).toBeTypeOf('number');
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'unreachable',
      statusConfidence: 'confirmed',
      statusReason: 'health_poll_failed_threshold',
      consecutiveFailures: 3,
      everReachable: true,
    });
    expect(pollerState(poller).failureStartedAt.get('remote-1')).toBe(failureStartedAt);
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      'whatsoup@remote-1 unreachable (3 consecutive poll failures)',
      expect.stringContaining('failure_age_ms=30000'),
      'critical',
      undefined,
    );

    poller.stop();
  });

  it('suppresses escalation during corroborated local starvation but preserves counters and age', async () => {
    const sampler = createFakeSampler(true);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth(5151)) })
      .mockRejectedValue(abortError());
    const instances = new Map([
      ['remote-1', makeInstance('remote-1', 9100)],
    ]);
    const poller = new HealthPoller(
      () => instances,
      'self',
      vi.fn().mockReturnValue({}),
      15_000,
      sampler.sampler,
    );

    await poller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    const failureStartedAt = pollerState(poller).failureStartedAt.get('remote-1');
    expect(failureStartedAt).toBeTypeOf('number');
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_probe_timeout_under_proxy_load',
      consecutiveFailures: 3,
      everReachable: true,
    });
    expect(poller.getStatus('remote-1')?.statusEvidence).toEqual(expect.arrayContaining([
      'event_loop_lag_p95_ms=300',
      'event_loop_lag_samples=20',
      'consecutive_failures=3',
      'target_pid=5151',
    ]));
    expect(pollerState(poller).failureStartedAt.get('remote-1')).toBe(failureStartedAt);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    sampler.setSnapshot({ sampleCount: 20, p95LagMs: 0, locallyStarved: false });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'unreachable',
      consecutiveFailures: 4,
    });
    expect(pollerState(poller).failureStartedAt.get('remote-1')).toBe(failureStartedAt);
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      'whatsoup@remote-1 unreachable (4 consecutive poll failures)',
      expect.stringContaining('failure_age_ms=45000'),
      'critical',
      undefined,
    );

    poller.stop();
  });

  it('clears preserved target failure age only after that same target succeeds', async () => {
    const sampler = createFakeSampler(true);
    let remoteOneHealthy = false;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes(':9101/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(onlineHealth()) });
      }
      return remoteOneHealthy
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(onlineHealth()) })
        : Promise.reject(abortError());
    });
    const instances = new Map([
      ['remote-1', makeInstance('remote-1', 9100)],
      ['remote-2', makeInstance('remote-2', 9101)],
    ]);
    const poller = new HealthPoller(
      () => instances,
      'self',
      vi.fn().mockReturnValue({}),
      1_000,
      sampler.sampler,
    );

    await privatePoll(poller);
    const failureStartedAt = pollerState(poller).failureStartedAt.get('remote-1');
    expect(failureStartedAt).toBeTypeOf('number');
    expect(pollerState(poller).failureStartedAt.has('remote-2')).toBe(false);

    vi.setSystemTime(Date.now() + 1_000);
    await privatePoll(poller);
    expect(pollerState(poller).failureStartedAt.get('remote-1')).toBe(failureStartedAt);
    expect(poller.getStatus('remote-2')?.status).toBe('online');

    remoteOneHealthy = true;
    vi.setSystemTime(Date.now() + 1_000);
    await privatePoll(poller);
    expect(pollerState(poller).failureStartedAt.has('remote-1')).toBe(false);
    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'online',
      consecutiveFailures: 0,
    });
  });

  it.each([
    [
      'durably queued',
      { ok: true, channel: 'outbox', status: 'durably_queued' } satisfies AlertEmissionResult,
      true,
    ],
    [
      'legacy accepted but unconfirmed',
      { ok: true, channel: 'legacy', status: 'legacy_accepted_unconfirmed' } satisfies AlertEmissionResult,
      false,
    ],
    [
      'failed',
      { ok: false, channel: 'none', status: 'failed' } satisfies AlertEmissionResult,
      false,
    ],
  ])('advances unreachable alert state only when emission is %s', async (_case, result, accepted) => {
    const sampler = createFakeSampler(false);
    alertFns.emitAlert.mockReturnValue(result);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth()) })
      .mockRejectedValue(abortError());
    const instances = new Map([
      ['remote-1', makeInstance('remote-1', 9100)],
    ]);
    const poller = new HealthPoller(
      () => instances,
      'self',
      vi.fn().mockReturnValue({}),
      1_000,
      sampler.sampler,
    );

    await privatePoll(poller);
    await privatePoll(poller);
    vi.setSystemTime(Date.now() + 30_000);
    await privatePoll(poller);
    await privatePoll(poller);

    expect(poller.getStatus('remote-1')?.status).toBe('unreachable');
    expect(pollerState(poller).unreachableAlerted.has('remote-1')).toBe(accepted);
    expect(poller.getStatus('remote-1')?.activeAlertSources.includes('instance_unreachable')).toBe(accepted);
    expect(poller.getStatus('remote-1')?.lastAlertAt === null).toBe(!accepted);
    expect(alertThrottleStore.recordAlertThrottle).toHaveBeenCalledTimes(accepted ? 1 : 0);
  });

  it('does not advance alert state when direct emission throws', async () => {
    const sampler = createFakeSampler(false);
    const emissionError = new Error('outbox unavailable');
    alertFns.emitAlert.mockImplementation(() => {
      throw emissionError;
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth()) })
      .mockRejectedValue(abortError());
    const instances = new Map([
      ['remote-1', makeInstance('remote-1', 9100)],
    ]);
    const poller = new HealthPoller(
      () => instances,
      'self',
      vi.fn().mockReturnValue({}),
      1_000,
      sampler.sampler,
    );

    await privatePoll(poller);
    await privatePoll(poller);
    vi.setSystemTime(Date.now() + 30_000);
    await privatePoll(poller);
    await privatePoll(poller);

    expect(poller.getStatus('remote-1')?.status).toBe('unreachable');
    expect(pollerState(poller).unreachableAlerted.has('remote-1')).toBe(false);
    expect(poller.getStatus('remote-1')?.activeAlertSources).not.toContain('instance_unreachable');
    expect(poller.getStatus('remote-1')?.lastAlertAt).toBeNull();
    expect(alertThrottleStore.recordAlertThrottle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { err: emissionError, name: 'remote-1', source: 'instance_unreachable' },
      'alert emission threw before durable acceptance',
    );
  });
});
