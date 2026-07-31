/**
 * Bounds alert-suppression logging to state transitions (#2355).
 *
 * The poller re-observes an unchanged condition on every tick. Before this
 * suite, `maybeEmitAlert` wrote one info record per suppressed observation, so
 * a single 15-minute throttle window emitted ~180 identical records at the 5s
 * default cadence (900_000 / 5_000), and a silenced instance was unbounded.
 *
 * The pre-existing coverage in `health-poller.test.ts` asserts the diagnostic
 * OCCURRED (`toHaveBeenCalledWith`), which passes at 1 record and at 180 alike.
 * Every assertion here is a COUNT, because the count is the defect: an
 * occurrence assertion cannot fail against the unfixed code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';
import type { SilenceStoreReadResult } from '../../src/fleet/silence-manager.ts';
import {
  createSilenceRegistryEpisodeStore,
  SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS,
  silenceRegistryEpisodeFailoverPath,
  silenceRegistryEpisodePath,
} from '../../src/fleet/silence-registry-episode-store.ts';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn((): AlertEmissionResult => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  clearAlertSource: vi.fn((): AlertEmissionResult => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
}));
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const alertThrottleStore = vi.hoisted(() => ({
  loadAlertThrottle: vi.fn(() => new Map<string, string>()),
  loadAlertThrottleDetailed: vi.fn((): {
    entries: Map<string, string>;
    loadError: { file: string; code?: string; error: string } | null;
  } => ({ entries: new Map<string, string>(), loadError: null })),
  recordAlertThrottle: vi.fn(),
}));
const silenceManager = vi.hoisted(() => ({
  isInstanceSilenced: vi.fn((_name: string): boolean | null => false),
  getSilenceStoreObservation: vi.fn((): SilenceStoreReadResult => ({
    availability: 'observed',
    readBasis: 'current',
    rules: [],
    observedAt: NOW,
    revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  })),
}));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  ...alertFns,
  emitAlertChecked: alertFns.emitAlert,
  clearAlertSourceChecked: alertFns.clearAlertSource,
}));

vi.mock('../../src/fleet/alert-throttle-store.ts', () => ({
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1000,
  ...alertThrottleStore,
}));

vi.mock('../../src/fleet/silence-manager.ts', () => silenceManager);

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ ...logger, child: vi.fn().mockReturnThis() }),
}));

const RATE_LIMIT_MSG = 'alert suppressed — rate limit (15min)';
const SILENCED_MSG = 'alert suppressed — instance is silenced';
const EPISODE_END_MSG = 'alert suppression episode ended';
const SILENCE_REGISTRY_SOURCE = 'silence_registry_unavailable';

const POLL_MS = 1_000;
const NOW = '2026-05-20T12:00:00.000Z';

/**
 * `handleFailure` classifies an instance `unreachable` only at `failures >= 3`
 * (`src/fleet/health-poller.ts`), and `maybeEmitAlert` is not called before
 * that. `start()` polls once immediately, so the first two polls of a run never
 * reach the suppression branch and are not suppressed observations.
 */
const POLLS_BEFORE_FIRST_SUPPRESSION = 2;

function makeInstance(overrides: Partial<InstanceHealth> = {}): InstanceHealth {
  return {
    name: 'remote-1',
    type: 'chat',
    accessMode: 'open',
    healthPort: 9100,
    dbPath: '/tmp/whatsoup-suppression-episodes.db',
    healthToken: null,
    ...overrides,
  };
}

/** Every `log.info` call whose message equals `msg`. */
function infoCallsWith(msg: string): unknown[][] {
  return logger.info.mock.calls.filter((call) => call[1] === msg);
}

/** The structured field object of the single `log.info` call for `msg`. */
function soleInfoFields(msg: string): Record<string, unknown> {
  const calls = infoCallsWith(msg);
  expect(calls).toHaveLength(1);
  return calls[0][0] as Record<string, unknown>;
}

describe('#2355 alert-suppression episodes', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let episodeStateRoot: string;

  beforeEach(() => {
    mockFetch = vi.fn();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
    alertFns.emitAlert.mockReset();
    alertFns.emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    alertFns.clearAlertSource.mockReset();
    alertFns.clearAlertSource.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    alertThrottleStore.loadAlertThrottle.mockReset();
    alertThrottleStore.loadAlertThrottle.mockReturnValue(new Map());
    alertThrottleStore.loadAlertThrottleDetailed.mockReset();
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({ entries: new Map(), loadError: null });
    alertThrottleStore.recordAlertThrottle.mockReset();
    silenceManager.isInstanceSilenced.mockReset();
    silenceManager.isInstanceSilenced.mockReturnValue(false);
    silenceManager.getSilenceStoreObservation.mockReset();
    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'observed',
      readBasis: 'current',
      rules: [],
      observedAt: NOW,
      revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    });
    episodeStateRoot = mkdtempSync(join(tmpdir(), 'whatsoup-silence-episode-poller-'));
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(episodeStateRoot, { recursive: true, force: true });
  });

  function registryEpisodeStore() {
    return createSilenceRegistryEpisodeStore(silenceRegistryEpisodePath(episodeStateRoot));
  }

  /** A never-reachable instance polled every second. */
  function startFailingPoller(): HealthPoller {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    return poller;
  }

  /** Pins the throttle for `remote-1:instance_never_reachable` at `at`. */
  function throttledSince(at: string): void {
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
      entries: new Map([['remote-1:instance_never_reachable', at]]),
      loadError: null,
    });
  }

  /** Advances the clock until exactly `count` suppressed observations have occurred. */
  async function advanceSuppressedPolls(count: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(0); // the immediate start() poll
    for (let i = 0; i < count + POLLS_BEFORE_FIRST_SUPPRESSION - 1; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
  }

  it('logs the rate-limit diagnostic ONCE across many suppressed polls', async () => {
    throttledSince('2026-05-20T11:55:00.000Z');
    const poller = startFailingPoller();
    await advanceSuppressedPolls(12);

    // 12 suppressed observations, 1 record. The unfixed code writes 12.
    expect(infoCallsWith(RATE_LIMIT_MSG)).toHaveLength(1);

    poller.stop();
  });

  it('preserves the entry record fields so existing operator greps still match', async () => {
    throttledSince('2026-05-20T11:55:00.000Z');
    const poller = startFailingPoller();
    await advanceSuppressedPolls(3);

    const fields = soleInfoFields(RATE_LIMIT_MSG);
    expect(fields.name).toBe('remote-1');
    expect(fields.source).toBe('instance_never_reachable');
    // `elapsed` is the field the pre-#2355 per-poll record carried.
    expect(typeof fields.elapsed).toBe('number');

    poller.stop();
  });

  it('does not deliver an alert while the episode is open — the throttle is unchanged', async () => {
    throttledSince('2026-05-20T11:55:00.000Z');
    const poller = startFailingPoller();
    await advanceSuppressedPolls(5);

    expect(alertFns.emitAlert).not.toHaveBeenCalled();
    expect(alertThrottleStore.recordAlertThrottle).not.toHaveBeenCalled();

    poller.stop();
  });

  it('summarises the episode with an exact suppressed-observation count on stop', async () => {
    throttledSince('2026-05-20T11:55:00.000Z');
    const poller = startFailingPoller();
    await advanceSuppressedPolls(8);
    poller.stop();

    const summary = soleInfoFields(EPISODE_END_MSG);
    expect(summary.suppressedObservations).toBe(8);
    expect(summary.name).toBe('remote-1');
    expect(summary.source).toBe('instance_never_reachable');
    expect(summary.reason).toBe(RATE_LIMIT_MSG);
    // First suppressed observation was 2 polls in; 7 further ticks followed it.
    expect(summary.episodeDurationMs).toBe(7 * POLL_MS);
  });

  it('emits NO summary for a single suppressed observation', async () => {
    throttledSince('2026-05-20T11:55:00.000Z');
    const poller = startFailingPoller();
    await advanceSuppressedPolls(1);
    poller.stop();

    expect(infoCallsWith(RATE_LIMIT_MSG)).toHaveLength(1);
    // A summary here would restore the two-records-per-observation shape this
    // change exists to remove.
    expect(infoCallsWith(EPISODE_END_MSG)).toHaveLength(0);
  });

  it('bounds the silenced-instance diagnostic, which has no 15-minute ceiling', async () => {
    silenceManager.isInstanceSilenced.mockReturnValue(true);
    const poller = startFailingPoller();
    await advanceSuppressedPolls(10);

    expect(infoCallsWith(SILENCED_MSG)).toHaveLength(1);

    poller.stop();
    expect(soleInfoFields(EPISODE_END_MSG).suppressedObservations).toBe(10);
  });

  it('does not put silence-registry failure details into unrelated instance alert evidence', async () => {
    silenceManager.isInstanceSilenced.mockReturnValue(null);
    const poller = startFailingPoller();
    await advanceSuppressedPolls(1);

    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);
    const call = alertFns.emitAlert.mock.calls[0] as unknown as [string, string, string, string];
    expect(call[3]).not.toContain('silence_registry');

    poller.stop();
  });

  it('opens one independent registry incident and clears it only after a fresh observed read', async () => {
    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      observedAt: NOW,
      reasonClass: 'permission_denied',
    });
    const poller = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      POLL_MS,
      undefined,
      null,
      registryEpisodeStore(),
    );
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);

    const alertCalls = alertFns.emitAlert.mock.calls as unknown as unknown[][];
    const onsetCalls = alertCalls.filter((call) => call[1] === SILENCE_REGISTRY_SOURCE);
    expect(onsetCalls).toHaveLength(1);
    expect(onsetCalls[0]).toMatchObject([
      'self',
      SILENCE_REGISTRY_SOURCE,
      'silence registry unavailable',
      'availability=unavailable reason_class=permission_denied read_basis=none',
      'warning',
    ]);

    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'observed',
      readBasis: 'current',
      rules: [],
      observedAt: '2026-05-20T12:00:06.000Z',
      revision: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    const clearCalls = alertFns.clearAlertSource.mock.calls as unknown as unknown[][];
    const recoveryCalls = clearCalls.filter((call) => call[1] === SILENCE_REGISTRY_SOURCE);
    expect(recoveryCalls).toHaveLength(1);
    expect(recoveryCalls[0]).toMatchObject([
      'self',
      SILENCE_REGISTRY_SOURCE,
      'recovery=fresh_observed',
    ]);

    poller.stop();
  });

  it('uses the durable registry episode to avoid a second onset after restart and clear once on recovery', async () => {
    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      observedAt: NOW,
      reasonClass: 'permission_denied',
    });
    const episodeStore = registryEpisodeStore();
    const first = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      POLL_MS,
      undefined,
      null,
      episodeStore,
    );
    first.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);
    expect(episodeStore.read()).toMatchObject({ status: 'available', phase: 'open' });
    first.stop();

    const restarted = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      POLL_MS,
      undefined,
      null,
      createSilenceRegistryEpisodeStore(silenceRegistryEpisodePath(episodeStateRoot)),
    );
    restarted.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);

    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'observed',
      readBasis: 'current',
      rules: [],
      observedAt: '2026-05-20T12:00:01.000Z',
      revision: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(1);
    expect(episodeStore.read()).toMatchObject({ status: 'available', phase: 'closed' });
    restarted.stop();

    const recoveredRestart = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      POLL_MS,
      undefined,
      null,
      createSilenceRegistryEpisodeStore(silenceRegistryEpisodePath(episodeStateRoot)),
    );
    recoveredRestart.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(1);
    recoveredRestart.stop();
  });

  it('uses the sticky failover episode when the primary lifecycle journal is unreadable', async () => {
    const primaryPath = silenceRegistryEpisodePath(episodeStateRoot);
    const malformedPrimary = '{unreadable-primary-episode';
    writeFileSync(primaryPath, malformedPrimary, { mode: 0o600 });
    chmodSync(primaryPath, 0o600);
    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      observedAt: NOW,
      reasonClass: 'permission_denied',
    });

    const first = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      POLL_MS,
      undefined,
      null,
      registryEpisodeStore(),
    );
    first.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);
    expect(readFileSync(primaryPath, 'utf8')).toBe(malformedPrimary);
    first.stop();

    const restarted = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      POLL_MS,
      undefined,
      null,
      registryEpisodeStore(),
    );
    restarted.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);

    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'observed',
      readBasis: 'current',
      rules: [],
      observedAt: '2026-05-20T12:00:01.000Z',
      revision: 'sha256:1111111111111111111111111111111111111111111111111111',
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(1);
    restarted.stop();
  });

  it('does not create a process-local registry alert lifecycle when both journals are unreadable', async () => {
    const primaryPath = silenceRegistryEpisodePath(episodeStateRoot);
    writeFileSync(primaryPath, '{unreadable-primary-episode', { mode: 0o600 });
    chmodSync(primaryPath, 0o600);
    const failoverPath = silenceRegistryEpisodeFailoverPath(episodeStateRoot);
    writeFileSync(failoverPath, '{unreadable-failover-episode', { mode: 0o600 });
    chmodSync(failoverPath, 0o600);
    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      observedAt: NOW,
      reasonClass: 'permission_denied',
    });

    const poller = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      POLL_MS,
      undefined,
      null,
      registryEpisodeStore(),
    );
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(alertFns.emitAlert).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls.filter((call) => call[1] === 'silence registry episode journal unavailable'))
      .toHaveLength(1);
    poller.stop();
  });

  it('does not settle a registry episode on legacy-only delivery acceptance', async () => {
    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      observedAt: NOW,
      reasonClass: 'permission_denied',
    });
    alertFns.emitAlert.mockReturnValue({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
    });
    const episodeStore = registryEpisodeStore();
    const poller = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      POLL_MS,
      undefined,
      null,
      episodeStore,
    );
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(episodeStore.read()).toMatchObject({ status: 'available', phase: 'onset_pending' });
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);

    alertFns.emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    await vi.advanceTimersByTimeAsync(SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS);

    expect(alertFns.emitAlert).toHaveBeenCalledTimes(2);
    expect(episodeStore.read()).toMatchObject({ status: 'available', phase: 'open' });
    poller.stop();
  });

  it('does not settle a registry recovery until its clear is durably queued', async () => {
    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'unavailable',
      readBasis: 'none',
      rules: null,
      observedAt: NOW,
      reasonClass: 'permission_denied',
    });
    const episodeStore = registryEpisodeStore();
    const poller = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
      POLL_MS,
      undefined,
      null,
      episodeStore,
    );
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(episodeStore.read()).toMatchObject({ status: 'available', phase: 'open' });

    silenceManager.getSilenceStoreObservation.mockReturnValue({
      availability: 'observed',
      readBasis: 'current',
      rules: [],
      observedAt: '2026-05-20T12:00:01.000Z',
      revision: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    });
    alertFns.clearAlertSource.mockReturnValue({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(1);
    expect(episodeStore.read()).toMatchObject({ status: 'available', phase: 'recovery_pending' });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(1);

    alertFns.clearAlertSource.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    await vi.advanceTimersByTimeAsync(SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS - POLL_MS * 2);

    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(2);
    expect(episodeStore.read()).toMatchObject({ status: 'available', phase: 'closed' });
    poller.stop();
  });

  it('closes the episode and opens a new one when the suppression REASON changes', async () => {
    throttledSince('2026-05-20T11:55:00.000Z');
    silenceManager.isInstanceSilenced.mockReturnValue(true);
    const poller = startFailingPoller();
    await advanceSuppressedPolls(4);

    // Un-silence: the same key stays suppressed, but now by the throttle.
    silenceManager.isInstanceSilenced.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(infoCallsWith(SILENCED_MSG)).toHaveLength(1);
    expect(infoCallsWith(RATE_LIMIT_MSG)).toHaveLength(1);

    // The silenced episode closed with its own count when the reason changed.
    const summary = soleInfoFields(EPISODE_END_MSG);
    expect(summary.reason).toBe(SILENCED_MSG);
    expect(summary.suppressedObservations).toBe(4);

    poller.stop();
  });

  it('closes the episode before the alert that ends it is emitted', async () => {
    // Expires 4s after NOW, so suppression lifts mid-run rather than after 900
    // polls.
    throttledSince('2026-05-20T11:45:04.000Z');
    const poller = startFailingPoller();
    await advanceSuppressedPolls(2);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    // Next poll crosses the 15-minute boundary: suppression stops applying.
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);
    const summary = soleInfoFields(EPISODE_END_MSG);
    expect(summary.reason).toBe(RATE_LIMIT_MSG);
    // Suppressed polls only; the poll that emitted is not one of them.
    expect(summary.suppressedObservations).toBe(2);

    poller.stop();
  });
});
