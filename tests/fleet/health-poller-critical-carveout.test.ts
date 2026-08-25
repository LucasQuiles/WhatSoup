/**
 * #3073 — critical-severity carve-out at the suppression gate.
 *
 * Before the carve-out, `bypassSuppression = source === 'instance_logged_out'`
 * was the ONLY path past silence: a silenced instance suppressed ALL its
 * alerts including critical-severity ones (instance_degraded,
 * instance_unreachable). An operator who silenced a noisy instance also
 * silenced its future critical alerts.
 *
 * The carve-out splits the single flag into two:
 *   bypassSilence  = severity === 'critical' || source === 'instance_logged_out'
 *   bypassThrottle = source === 'instance_logged_out'
 *
 * So critical alerts bypass SILENCE (operator sees them) but keep the 15-min
 * THROTTLE (storm guard); only instance_logged_out bypasses both (unchanged).
 *
 * T1-T4 are discriminating unit calls on maybeEmitAlert (accessed via the same
 * PollerPrivate cast used in probe-liveness-escalation.test.ts). Each test
 * fails against a specific mutation of the carve-out:
 *   T1 fails if bypassSilence drops the severity term (critical silenced again).
 *   T2 fails if bypassSilence ignores severity entirely (warnings leak through).
 *   T3 fails if bypassThrottle widens to all criticals (throttle defeated).
 *   T4 fails if instance_logged_out loses either bypass (regression).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';
import type { InstanceStatus, InstanceHealth } from '../../src/fleet/health-poller.ts';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn((): AlertEmissionResult => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
}));
const alertThrottleStore = vi.hoisted(() => ({
  loadAlertThrottle: vi.fn(() => new Map<string, string>()),
  loadAlertThrottleDetailed: vi.fn(() => ({
    entries: new Map<string, string>(),
    loadError: null,
  })),
  recordAlertThrottle: vi.fn(),
}));
const silenceManager = vi.hoisted(() => ({
  isInstanceSilenced: vi.fn((): boolean => false),
}));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  ...alertFns,
  emitAlertChecked: alertFns.emitAlert,
  emitObservationChecked: vi.fn(() => true),
}));
vi.mock('../../src/fleet/alert-throttle-store.ts', () => ({
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1000,
  ...alertThrottleStore,
}));
vi.mock('../../src/fleet/silence-manager.ts', () => silenceManager);
vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());

// Import AFTER mocks are registered.
const { HealthPoller } = await import('../../src/fleet/health-poller.ts');

/** Private-member access cast (same pattern as probe-liveness-escalation.test.ts). */
interface PollerPrivate {
  maybeEmitAlert(
    name: string,
    source: string,
    summary: string,
    evidence: string,
    severity?: 'critical' | 'error' | 'warning' | 'info',
    criticalAsset?: unknown,
  ): boolean;
  statuses: Map<string, InstanceStatus>;
  hostName: string;
}

const NOW = '2026-05-20T12:00:00.000Z';
const HOST = 'test-host';

function makeInstance(): InstanceHealth {
  return {
    name: 'alice',
    type: 'chat',
    accessMode: 'open',
    healthPort: 9100,
    dbPath: '/tmp/whatsoup-carveout.db',
    healthToken: null,
  };
}

/** Build a poller with a seeded status entry so the throttle-record path (:2370) fires. */
function makePoller(): PollerPrivate {
  const instances = new Map([['alice', makeInstance()]]);
  const poller = new HealthPoller(() => instances, 'self', () => ({}), 60_000) as unknown as PollerPrivate;
  // Seed a status so `existing` (maybeEmitAlert :2335) is truthy and the throttle
  // is RECORDED on emit — without this the second call in T3/T4 has no throttle entry.
  poller.statuses.set('alice', {
    name: 'alice',
    health: null,
    lastPollAt: NOW,
    consecutiveFailures: 3,
    everReachable: false,
    status: 'unreachable',
    statusConfidence: 'confirmed',
    statusReason: 'test seed',
    statusEvidence: [],
    error: null,
    lastAlertAt: null,
    silencedUntil: null,
    activeAlertSources: [],
  });
  return poller;
}

describe('#3073 critical-severity carve-out at the suppression gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    alertFns.emitAlert.mockReset();
    alertFns.emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({ entries: new Map(), loadError: null });
    alertThrottleStore.recordAlertThrottle.mockReset();
    silenceManager.isInstanceSilenced.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T1: a silenced instance still emits a critical-severity alert', () => {
    silenceManager.isInstanceSilenced.mockReturnValue(true);
    const poller = makePoller();

    const emitted = poller.maybeEmitAlert('alice', 'instance_degraded', 'degraded', 'evidence', 'critical');

    expect(emitted).toBe(true);
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);
  });

  it('T2: a silenced instance suppresses a warning-severity alert', () => {
    silenceManager.isInstanceSilenced.mockReturnValue(true);
    const poller = makePoller();

    const emitted = poller.maybeEmitAlert('alice', 'provider_fallback_capacity', 'fallback', 'evidence', 'warning');

    expect(emitted).toBe(false);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();
  });

  it('T3: a silenced critical alert is still rate-limited (throttle applies)', () => {
    silenceManager.isInstanceSilenced.mockReturnValue(true);
    const poller = makePoller();

    const first = poller.maybeEmitAlert('alice', 'instance_degraded', 'degraded-1', 'evidence-1', 'critical');
    // Immediately re-emit — well within the 15-min throttle window.
    const second = poller.maybeEmitAlert('alice', 'instance_degraded', 'degraded-2', 'evidence-2', 'critical');

    expect(first).toBe(true);
    expect(second).toBe(false); // throttle guard still active for non-logged-out criticals
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1); // only the first got through
  });

  it('T4: instance_logged_out bypasses BOTH silence and throttle (unchanged)', () => {
    silenceManager.isInstanceSilenced.mockReturnValue(true);
    const poller = makePoller();

    const first = poller.maybeEmitAlert('alice', 'instance_logged_out', 'logged-out-1', 'evidence-1', 'critical');
    const second = poller.maybeEmitAlert('alice', 'instance_logged_out', 'logged-out-2', 'evidence-2', 'critical');

    expect(first).toBe(true);
    expect(second).toBe(true); // throttle bypassed for instance_logged_out
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(2);
  });
});
