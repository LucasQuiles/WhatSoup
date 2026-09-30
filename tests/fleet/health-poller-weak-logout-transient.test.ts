import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import * as healthPoller from '../../src/fleet/health-poller.ts';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';
import { usePerTestBotErrorsMarkerIsolation } from '../../tests/setup/bot-errors-vitest-isolation.ts';

// #3722: the weak "logged out" signal (backoff, 0 attempts) must not confirm
// on a transient reconnect, and a shared outage must not page every instance.

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn((): AlertEmissionResult => ({
    ok: true,
    channel: 'outbox',
    status: 'durably_queued',
  })),
  clearAlertSource: vi.fn(() => true),
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
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1000,
  ...alertThrottleStore,
}));

vi.mock('../../src/fleet/silence-manager.ts', () => silenceManager);

vi.mock('../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(logger);
  return { createChildLogger };
});

type AlertMockCall = [string, string, string, string, ...unknown[]];

// Policy values from the fix, as literals: at base the exports do not exist,
// and the RED must come from an assertion, not from NaN arithmetic.
const INTERVAL_MS = 10_000;
const WEAK_TRANSIENT_MAX_MS = 6 * 60_000;

const WEAK_LOGGED_OUT_CORRELATION_HOLD_MS = 6 * 60_000;
const T0 = Date.parse('2026-05-20T12:00:00.000Z');

const PORTS: Record<string, number> = { 'remote-1': 9101, 'remote-2': 9102, 'remote-3': 9103 };
const TRIO = ['remote-1', 'remote-2', 'remote-3'];

function onlineBody(): Record<string, unknown> {
  return {
    status: 'healthy',
    uptime_seconds: 120,
    whatsapp: {
      connected: true,
      connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0 },
    },
  };
}

/** Seconds since the test's T0, read from the fake clock at fetch time. */
function elapsedSeconds(): number {
  return Math.round((Date.now() - T0) / 1000);
}

function makeInstance(name: string): InstanceHealth {
  return {
    name,
    type: 'chat',
    accessMode: 'open',
    healthPort: PORTS[name]!,
    dbPath: '/tmp/whatsoup-test-instance-weak-logout-transient.db',
    healthToken: null,
  };
}

function weakBody(connection: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'unhealthy',
    uptime_seconds: 120,
    whatsapp: {
      connected: false,
      connection: {
        state: 'reconnecting',
        reconnect_phase: 'backoff',
        reconnect_attempts: 0,
        ...connection,
      },
    },
  };
}

const TRANSIENT_DECISION = {
  version: 1,
  classification: 'other',
  decision: 'reconnect:transient',
  action: 'reconnect',
  reason: 'transient',
  basis: null,
  status_code: 408,
  conflict_inspected: false,
  conflict_type: null,
  unclassified_401_retry_spent: false,
  observed_at: '2026-05-20T11:59:00.000Z',
};

function loggedOutCalls(name: string): AlertMockCall[] {
  return (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).filter(
    ([callName, callSource]) => callName === name && callSource === 'instance_logged_out',
  );
}

usePerTestBotErrorsMarkerIsolation();

describe('HealthPoller — weak logged-out signal on a transient reconnect (#3722)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let bodyFor: (name: string) => Record<string, unknown>;
  let poller: HealthPoller | null = null;

  async function start(names: string[]): Promise<HealthPoller> {
    const instances = new Map(names.map((name) => [name, makeInstance(name)] as [string, InstanceHealth]));
    poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), INTERVAL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // poll at t = 0
    return poller;
  }

  async function polls(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) await vi.advanceTimersByTimeAsync(INTERVAL_MS);
  }

  /** Poll until the poll at `seconds` after T0 has run. */
  async function pollThrough(seconds: number): Promise<void> {
    while (elapsedSeconds() < seconds) await polls(1);
  }

  function emitsBy(names: string[]): number[] {
    return names.map((name) => loggedOutCalls(name).length);
  }

  beforeEach(() => {
    mockFetch = vi.fn((url: string) => {
      const port = Number(new URL(url).port);
      const name = Object.keys(PORTS).find((key) => PORTS[key] === port)!;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(bodyFor(name)) });
    });
    logger.info?.mockClear();
    logger.warn?.mockClear();
    logger.error?.mockClear();
    logger.debug?.mockClear();
    alertFns.emitAlert.mockReset();
    alertFns.emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    alertFns.clearAlertSource.mockReset();
    alertFns.clearAlertSource.mockReturnValue(true);
    alertThrottleStore.loadAlertThrottleDetailed.mockReset();
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({ entries: new Map(), loadError: null });
    alertThrottleStore.recordAlertThrottle.mockReset();
    silenceManager.isInstanceSilenced.mockReset();
    silenceManager.isInstanceSilenced.mockReturnValue(false);
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'));
  });

  afterEach(() => {
    poller?.stop();
    poller = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('T1: a transient status code keeps the weak signal from confirming inside the bound', async () => {
    bodyFor = () => weakBody({ last_status_code: 408 });
    const p = await start(['remote-1']);
    await polls(4); // 5 polls in all

    expect(p.getStatus('remote-1')!.status).not.toBe('logged_out');
    expect(loggedOutCalls('remote-1')).toHaveLength(0);
  });

  it('T1b: a classified transient reconnect decision keeps the weak signal from confirming', async () => {
    bodyFor = () => weakBody({ last_status_code: null, disconnect_decision: TRANSIENT_DECISION });
    const p = await start(['remote-1']);
    await polls(4);

    expect(p.getStatus('remote-1')!.status).not.toBe('logged_out');
    expect(loggedOutCalls('remote-1')).toHaveLength(0);
  });

  it('T2: an explicit 401 on a legacy body still confirms at once', async () => {
    bodyFor = () => weakBody({ last_status_code: 401 });
    const p = await start(['remote-1']);

    expect(p.getStatus('remote-1')!.status).toBe('logged_out');
    expect(loggedOutCalls('remote-1')).toHaveLength(1);
    expect(loggedOutCalls('remote-1')[0]![5]).toEqual(expect.objectContaining({
      failure: expect.objectContaining({ code: 'WA_AUTH_BOND_SERVER_REVOKED' }),
    }));
  });

  it('T4: a weak signal with no transient basis confirms at the third poll, as before', async () => {
    bodyFor = () => weakBody();
    const p = await start(['remote-1']);
    await polls(1);
    expect(loggedOutCalls('remote-1')).toHaveLength(0);

    await polls(1); // third poll
    expect(p.getStatus('remote-1')!.status).toBe('logged_out');
    expect(loggedOutCalls('remote-1')).toHaveLength(1);
    expect(loggedOutCalls('remote-1')[0]![3]).toContain('weak_signal_polls=3');
  });

  it('T5: a reconnect-reset marker keeps the weak signal from confirming inside the bound', async () => {
    bodyFor = () => weakBody({
      reconnect_reset: { reason: 'graceful_reconnect_keepalive_failed', at: '2026-05-20T11:59:30.000Z' },
    });
    const p = await start(['remote-1']);
    await polls(4);

    expect(p.getStatus('remote-1')!.status).not.toBe('logged_out');
    expect(loggedOutCalls('remote-1')).toHaveLength(0);
  });

  it('T7: a reset marker that never clears expires after one reconnect cycle, then pages once', async () => {
    bodyFor = () => weakBody({
      reconnect_reset: { reason: 'exhaustion_cycle_retry', at: '2026-05-20T11:59:30.000Z' },
    });
    const p = await start(['remote-1']);
    // Polls at t = 10 s .. 370 s: the bound expires at 360 s, then persistence
    // counts 360 s, 370 s, and confirms at 380 s.
    await polls(WEAK_TRANSIENT_MAX_MS / INTERVAL_MS + 1);
    expect(p.getStatus('remote-1')!.status).not.toBe('logged_out');
    expect(loggedOutCalls('remote-1')).toHaveLength(0);

    await polls(1); // t = 380 s
    expect(p.getStatus('remote-1')!.status).toBe('logged_out');
    expect(loggedOutCalls('remote-1')).toHaveLength(1);
    expect(loggedOutCalls('remote-1')[0]![3]).toContain('transient_basis_expired=reset');
    expect(loggedOutCalls('remote-1')[0]![3]).toContain('weak_signal_polls=3');
  });

  it('T7b: a transient status code that never clears expires the same way', async () => {
    bodyFor = () => weakBody({ last_status_code: 408 });
    const p = await start(['remote-1']);
    await polls(WEAK_TRANSIENT_MAX_MS / INTERVAL_MS + 1);
    expect(loggedOutCalls('remote-1')).toHaveLength(0);

    await polls(1);
    expect(p.getStatus('remote-1')!.status).toBe('logged_out');
    expect(loggedOutCalls('remote-1')).toHaveLength(1);
    expect(loggedOutCalls('remote-1')[0]![3]).toContain('transient_basis_expired=status_code');
  });

  // ── Correlated-trip hold. A trip is recorded at an instance's first counted
  // weak poll and correlation is checked at confirm (poll 3), so a shared
  // outage is held as one for HOLD from each trip (lead ruling (b)).

  it('T3: three instances weak together are held for HOLD from their trips, then each pages once', async () => {
    bodyFor = () => weakBody();
    await start(TRIO); // trips at t = 0
    await pollThrough(WEAK_LOGGED_OUT_CORRELATION_HOLD_MS / 1000 - 10);
    expect(emitsBy(TRIO)).toEqual([0, 0, 0]);

    await polls(1); // t = 360 s
    expect(emitsBy(TRIO)).toEqual([1, 1, 1]);
    await polls(3);
    expect(emitsBy(TRIO)).toEqual([1, 1, 1]);
  });

  it('T3b: instances that reconnect inside the hold never page', async () => {
    bodyFor = () => (elapsedSeconds() < 200 ? weakBody() : onlineBody());
    await start(TRIO);
    await pollThrough(1_200);
    expect(emitsBy(TRIO)).toEqual([0, 0, 0]);
  });

  it('T3c-a: trips inside the persistence gap (one poll apart) are held as one', async () => {
    bodyFor = (name) => (name === 'remote-1' || elapsedSeconds() >= 10 ? weakBody() : onlineBody());
    await start(TRIO); // remote-1 trips at 0; remote-2 and remote-3 at 10 s
    await pollThrough(350);
    expect(emitsBy(TRIO)).toEqual([0, 0, 0]);

    await pollThrough(360);
    expect(emitsBy(TRIO)).toEqual([1, 0, 0]);
    await pollThrough(370);
    expect(emitsBy(TRIO)).toEqual([1, 1, 1]);
  });

  it('T3c-b: a 90 s spread pages the early instances; the last, correlated with both, is held', async () => {
    const weakFrom: Record<string, number> = { 'remote-1': 0, 'remote-2': 90, 'remote-3': 180 };
    bodyFor = (name) => (elapsedSeconds() >= weakFrom[name]! ? weakBody() : onlineBody());
    const p = await start(TRIO);

    await pollThrough(20); // remote-1 confirms alone: one trip, no correlation
    expect(emitsBy(TRIO)).toEqual([1, 0, 0]);

    await pollThrough(100);
    expect(emitsBy(TRIO)).toEqual([1, 0, 0]);
    await pollThrough(110); // remote-2 confirms with two trips: still below the minimum
    expect(emitsBy(TRIO)).toEqual([1, 1, 0]);

    // remote-3's trip (180 s) is within WINDOW of remote-2's (90 s), whose
    // window also holds remote-1's (0 s): three live trips, so it is held.
    // The instances that already paged stay logged out: a confirmed trip is
    // never held again.
    for (let s = 200; s <= 530; s += INTERVAL_MS / 1000) {
      await pollThrough(s);
      expect(p.getStatus('remote-1')!.status).toBe('logged_out');
      expect(p.getStatus('remote-2')!.status).toBe('logged_out');
    }
    expect(emitsBy(TRIO)).toEqual([1, 1, 0]);
    await pollThrough(540);
    expect(emitsBy(TRIO)).toEqual([1, 1, 1]);
  });

  it('T3d: one instance reconnecting does not release the others into a page', async () => {
    bodyFor = (name) => (name === 'remote-1' && elapsedSeconds() >= 180 ? onlineBody() : weakBody());
    await start(TRIO);
    await pollThrough(350);
    expect(emitsBy(TRIO)).toEqual([0, 0, 0]);

    await pollThrough(360);
    expect(emitsBy(TRIO)).toEqual([0, 1, 1]);
  });

  it('T3e: a second shared outage after recovery is held again from the new trips', async () => {
    bodyFor = () => {
      const s = elapsedSeconds();
      return s < 200 || s >= 800 ? weakBody() : onlineBody();
    };
    await start(TRIO);
    await pollThrough(1_150); // new trips at 800 s, held until 1160 s
    expect(emitsBy(TRIO)).toEqual([0, 0, 0]);

    await pollThrough(1_160);
    expect(emitsBy(TRIO)).toEqual([1, 1, 1]);
  });

  it('T3f: a long, correlated, real logout confirms once and stays confirmed', async () => {
    bodyFor = () => weakBody();
    const p = await start(TRIO);
    await pollThrough(350);
    expect(emitsBy(TRIO)).toEqual([0, 0, 0]);

    await pollThrough(360);
    for (let s = 360; s <= 16 * 60; s += INTERVAL_MS / 1000) {
      await pollThrough(s);
      for (const name of TRIO) expect(p.getStatus(name)!.status).toBe('logged_out');
    }
    expect(emitsBy(TRIO)).toEqual([1, 1, 1]);
  });
});

describe('weakSignalTransientBasis (#3722 U1)', () => {
  const absent = { kind: 'absent' } as const;
  const classifiedOther = { kind: 'classified', classification: 'other' } as const;

  function basis(input: Record<string, unknown>): unknown {
    // Namespace access, so a missing export fails by assertion, not at import.
    expect(typeof (healthPoller as Record<string, unknown>)['weakSignalTransientBasis']).toBe('function');
    const fn = (healthPoller as Record<string, unknown>)['weakSignalTransientBasis'] as (arg: unknown) => unknown;
    return fn({ lastStatusCode: null, decisionReading: absent, decisionNode: null, reconnectReset: null, ...input });
  }

  it('names each reset reason, with the marker time in its identity', () => {
    for (const reason of [
      'exhaustion_cycle_retry',
      'graceful_reconnect_keepalive_failed',
      'graceful_reconnect_connection_exhausted',
    ]) {
      expect(basis({ reconnectReset: { reason, at: '2026-05-20T11:59:30.000Z' } })).toEqual({
        kind: 'reset',
        identity: `reset:${reason}@2026-05-20T11:59:30.000Z`,
      });
    }
  });

  it('ignores an unknown reset reason', () => {
    expect(basis({ reconnectReset: { reason: 'something_else', at: '2026-05-20T11:59:30.000Z' } })).toBeNull();
  });

  it('names a classified transient reconnect decision', () => {
    expect(basis({ decisionReading: classifiedOther, decisionNode: TRANSIENT_DECISION })).toEqual({
      kind: 'decision',
      identity: 'decision:2026-05-20T11:59:00.000Z',
    });
    expect(basis({
      decisionReading: classifiedOther,
      decisionNode: { ...TRANSIENT_DECISION, action: 'exit' },
    })).toBeNull();
  });

  it('names each transient status code and nothing else', () => {
    for (const code of [428, 408, 500, 503]) {
      expect(basis({ lastStatusCode: code })).toEqual({ kind: 'status_code', identity: `code:${code}` });
    }
    for (const code of [401, 440, 515, null]) {
      expect(basis({ lastStatusCode: code })).toBeNull();
    }
  });

  it('prefers reset, then decision, then status code', () => {
    const reconnectReset = { reason: 'exhaustion_cycle_retry', at: '2026-05-20T11:59:30.000Z' };
    expect(basis({
      reconnectReset,
      decisionReading: classifiedOther,
      decisionNode: TRANSIENT_DECISION,
      lastStatusCode: 408,
    })).toEqual({ kind: 'reset', identity: 'reset:exhaustion_cycle_retry@2026-05-20T11:59:30.000Z' });
    expect(basis({
      decisionReading: classifiedOther,
      decisionNode: TRANSIENT_DECISION,
      lastStatusCode: 408,
    })).toEqual({ kind: 'decision', identity: 'decision:2026-05-20T11:59:00.000Z' });
  });
});
