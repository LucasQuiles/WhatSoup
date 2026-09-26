/**
 * #2200 (src/fleet slice): the health poller reads time through an injected
 * Clock, not the raw wall clock.
 *
 * Each case injects a fake clock that disagrees with the real one and asserts
 * behaviour that only the injected reading can produce. Against a poller that
 * still calls the wall clock directly, the fake clock is ignored and every
 * case fails. No global fake timers are installed here on purpose: they would
 * move the wall clock too and hide a raw read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import { fakeClock, type Clock } from '../../src/lib/clock.ts';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn((): AlertEmissionResult => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  clearAlertSource: vi.fn((): AlertEmissionResult => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
}));
const { logger } = vi.hoisted(() => ({ logger: {} as Record<string, ReturnType<typeof vi.fn>> }));
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
  emitObservationChecked: vi.fn(() => true),
  clearAlertSourceChecked: alertFns.clearAlertSource,
}));
vi.mock('../../src/fleet/alert-throttle-store.ts', () => ({
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1_000,
  ...alertThrottleStore,
}));
vi.mock('../../src/fleet/silence-manager.ts', () => silenceManager);
vi.mock('../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(logger);
  return { createChildLogger };
});

// A fixed instant well away from the real wall clock, so a raw read cannot
// accidentally agree with it.
const FAKE_NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');
const FAKE_NOW_ISO = new Date(FAKE_NOW_MS).toISOString();
/** Default of WHATSOUP_INSTANCE_UNREACHABLE_ALERT_DWELL_MS in health-poller.ts. */
const UNREACHABLE_DWELL_MS = 30_000;

function makeInstance(): InstanceHealth {
  return {
    name: 'remote-1',
    type: 'chat',
    accessMode: 'open',
    healthPort: 9100,
    dbPath: '/tmp/whatsoup-test-instance.db',
    healthToken: null,
  };
}

function makePoller(clock: Clock): HealthPoller {
  return new HealthPoller(
    () => new Map([['remote-1', makeInstance()]]),
    'self',
    vi.fn().mockReturnValue({}),
    undefined,
    undefined,
    null,
    undefined,
    'test-host',
    undefined,
    clock,
  );
}

function canonicalHealth(generatedAt: string): Record<string, unknown> {
  return {
    status: 'healthy',
    generated_at: generatedAt,
    runtime: {},
    whatsapp: {
      connected: true,
      account_jid: 'redacted-account@s.whatsapp.net',
      connection: {
        state: 'connected',
        reconnect_phase: null,
        reconnect_attempts: 0,
        last_disconnect_reason: null,
        last_status_code: null,
        auth_failure_class: 'none',
        recent_disconnects: {
          count: 0,
          degraded_threshold: 3,
          window_ms: 600_000,
          last_at: null,
          last_reason: null,
          last_status_code: null,
        },
      },
    },
  };
}

interface PollerInternals {
  poll(): Promise<void>;
  updateFailure(name: string, error: string, reached?: boolean): void;
  noteAlertSuppressed(key: string, name: string, source: string, reason: string): void;
  endAlertSuppressionEpisode(key: string): void;
}

describe('#2200 health poller reads time through its injected clock', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    alertFns.emitAlert.mockClear();
    logger.info.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('judges snapshot freshness against the injected clock, not the wall clock', async () => {
    // generated_at equals the fake "now". Against the wall clock the same
    // snapshot is months old and would be classified stale.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(canonicalHealth(FAKE_NOW_ISO)),
    });
    const poller = makePoller(fakeClock(FAKE_NOW_MS));

    await (poller as unknown as PollerInternals).poll();

    expect(poller.getStatus('remote-1')).toMatchObject({ status: 'online' });
  });

  it('measures the unreachable-alert dwell with the injected clock', () => {
    const clock = fakeClock(FAKE_NOW_MS);
    const internals = makePoller(clock) as unknown as PollerInternals;

    // Three reached failures make the instance unreachable; its dwell starts
    // at the first failure.
    for (let i = 0; i < 3; i++) internals.updateFailure('remote-1', 'connect refused', true);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    clock.advance(UNREACHABLE_DWELL_MS + 1);
    internals.updateFailure('remote-1', 'connect refused', true);

    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);
    const firstCall = alertFns.emitAlert.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[1]).toBe('instance_unreachable');
  });

  it('reports a suppression episode duration from the injected clock', () => {
    const clock = fakeClock(FAKE_NOW_MS);
    const internals = makePoller(clock) as unknown as PollerInternals;

    internals.noteAlertSuppressed('remote-1:instance_unreachable', 'remote-1', 'instance_unreachable', 'suppressed');
    internals.noteAlertSuppressed('remote-1:instance_unreachable', 'remote-1', 'instance_unreachable', 'suppressed');
    clock.advance(90_000);
    internals.endAlertSuppressionEpisode('remote-1:instance_unreachable');

    const ended = logger.info.mock.calls.filter((call) => call[1] === 'alert suppression episode ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.[0]).toMatchObject({ episodeDurationMs: 90_000, suppressedObservations: 2 });
  });
});
