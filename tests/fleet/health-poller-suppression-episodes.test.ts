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
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn((): AlertEmissionResult => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  clearAlertSource: vi.fn(() => true),
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
  isInstanceSilenced: vi.fn(() => false),
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

  beforeEach(() => {
    mockFetch = vi.fn();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
    alertFns.emitAlert.mockReset();
    alertFns.emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    alertFns.clearAlertSource.mockReset();
    alertFns.clearAlertSource.mockReturnValue(true);
    alertThrottleStore.loadAlertThrottle.mockReset();
    alertThrottleStore.loadAlertThrottle.mockReturnValue(new Map());
    alertThrottleStore.loadAlertThrottleDetailed.mockReset();
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({ entries: new Map(), loadError: null });
    alertThrottleStore.recordAlertThrottle.mockReset();
    silenceManager.isInstanceSilenced.mockReset();
    silenceManager.isInstanceSilenced.mockReturnValue(false);
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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
