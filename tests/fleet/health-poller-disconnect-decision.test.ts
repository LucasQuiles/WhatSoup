/**
 * The fleet poller reads the transport's carried disconnect decision instead
 * of treating every 401 as a confirmed server revocation.
 *
 *   confirmed_device_removed  -> logged_out, confirmed, asset confidence confirmed
 *   ambiguous_401_parked      -> logged_out, inferred,  asset confidence probable
 *   ambiguous_401_reconnecting-> not logged_out (bounded retry in progress)
 *   unknown future value      -> not logged_out on a bare 401
 *   legacy body (no field)    -> the conservative 401 rule still applies
 *
 * Harness mirrors tests/fleet/health-poller-branches2.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import {
  decideAuthLossModeEvent,
} from '../../src/fleet/auth-loss-mode-bucket-contract.ts';
import { hasExplicitAuthLossSignal } from '../../src/fleet/auth-loss-signals.ts';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn((): AlertEmissionResult => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  clearAlertSource: vi.fn(() => true),
}));
const logger = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));
const alertThrottleStore = vi.hoisted(() => ({
  loadAlertThrottle: vi.fn(() => new Map<string, string>()),
  loadAlertThrottleDetailed: vi.fn((): {
    entries: Map<string, string>;
    loadError: { file: string; code?: string; error: string } | null;
  } => ({ entries: new Map<string, string>(), loadError: null })),
  recordAlertThrottle: vi.fn(),
}));
const silenceManager = vi.hoisted(() => ({ isInstanceSilenced: vi.fn(() => false) }));

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

type AlertMockCall = [string, string, string, string, string, { failure?: { confidence?: string } }?];

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

function loggedOutBody(
  status: 'degraded' | 'unhealthy',
  authFailureClass: string,
  decision: Record<string, unknown> | null | undefined,
  state = 'disconnected',
  reconnectAttempts = 0,
): Record<string, unknown> {
  const connection: Record<string, unknown> = {
    state,
    reconnect_phase: 'backoff',
    reconnect_attempts: reconnectAttempts,
    last_status_code: 401,
    last_disconnect_reason: 'loggedOut',
    auth_failure_class: authFailureClass,
  };
  if (decision !== undefined) connection.disconnect_decision = decision;
  return {
    status,
    generated_at: new Date().toISOString(),
    uptime_seconds: 600,
    runtime: {},
    whatsapp: { connected: false, account_jid: 'not connected', connection },
  };
}

function decision(classification: string): Record<string, unknown> {
  return { version: 1, classification };
}

async function pollOnce(body: Record<string, unknown>, httpStatus: number): Promise<HealthPoller> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: httpStatus === 200,
    status: httpStatus,
    json: () => Promise.resolve(body),
  }));
  const instances = new Map([['remote-1', makeInstance()]]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
  await (poller as unknown as { poll(): Promise<void> }).poll();
  return poller;
}

function loggedOutAlert(): AlertMockCall | undefined {
  return (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[])
    .find(([instance, source]) => instance === 'remote-1' && source === 'instance_logged_out');
}

describe('HealthPoller — carried disconnect decision', () => {
  beforeEach(() => {
    for (const fn of Object.values(logger)) fn.mockClear?.();
    alertFns.emitAlert.mockReset();
    alertFns.emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    alertFns.clearAlertSource.mockReset();
    alertFns.clearAlertSource.mockReturnValue(true);
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({ entries: new Map(), loadError: null });
    silenceManager.isInstanceSilenced.mockReturnValue(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T05:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a confirmed device_removed body is a confirmed logout', async () => {
    const poller = await pollOnce(
      loggedOutBody('unhealthy', 'serverside_logout_irreversible', decision('confirmed_device_removed')),
      503,
    );
    expect(poller.getStatus('remote-1')).toMatchObject({ status: 'logged_out', statusConfidence: 'confirmed' });
    const alert = loggedOutAlert();
    expect(alert?.[3]).toContain('disconnect_classification=confirmed_device_removed');
    expect(alert?.[5]?.failure?.confidence).toBe('confirmed');
  });

  it('a parked ambiguous 401 is logged out but only inferred, with a probable failure', async () => {
    const poller = await pollOnce(
      loggedOutBody('unhealthy', 'auth_401_ambiguous_parked', decision('ambiguous_401_parked')),
      503,
    );
    expect(poller.getStatus('remote-1')).toMatchObject({ status: 'logged_out', statusConfidence: 'inferred' });
    const alert = loggedOutAlert();
    expect(alert?.[3]).toContain('auth_failure_class=auth_401_ambiguous_parked');
    expect(alert?.[3]).toContain('disconnect_classification=ambiguous_401_parked');
    expect(alert?.[5]?.failure?.confidence).toBe('probable');
  });

  it('a parked line pages once, not on every poll past the throttle window', async () => {
    const body = loggedOutBody('unhealthy', 'auth_401_ambiguous_parked', decision('ambiguous_401_parked'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve(body) }));
    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();
    for (let i = 0; i < 3; i++) {
      await poll();
      vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1_000));
    }
    const pages = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[])
      .filter(([instance, source]) => instance === 'remote-1' && source === 'instance_logged_out');
    expect(pages).toHaveLength(1);
  });

  it('an ambiguous 401 inside its bounded retry is not a logout despite last_status_code=401', async () => {
    const poller = await pollOnce(
      loggedOutBody('degraded', 'auth_401_ambiguous_retrying', decision('ambiguous_401_reconnecting'), 'reconnecting', 1),
      200,
    );
    expect(poller.getStatus('remote-1')?.status).not.toBe('logged_out');
    expect(loggedOutAlert()).toBeUndefined();
  });

  it('legacy body without the field keeps the conservative 401 rule', async () => {
    const poller = await pollOnce(loggedOutBody('unhealthy', 'none', undefined), 503);
    expect(poller.getStatus('remote-1')).toMatchObject({ status: 'logged_out', statusConfidence: 'confirmed' });
  });
});

describe('hasExplicitAuthLossSignal — decision gating', () => {
  const raw401 = { lastStatusCode: 401, lastDisconnectReason: 'loggedOut', authFailureClass: 'none' };

  it('legacy (absent) keeps the raw 401 rule', () => {
    expect(hasExplicitAuthLossSignal(raw401)).toBe(true);
    expect(hasExplicitAuthLossSignal({ ...raw401, disconnectDecision: { kind: 'absent' } })).toBe(true);
  });

  it('a carried decision overrides the raw fields', () => {
    const reading = (classification: 'ambiguous_401_reconnecting' | 'ambiguous_401_parked') =>
      ({ kind: 'classified', classification }) as const;
    expect(hasExplicitAuthLossSignal({ ...raw401, disconnectDecision: reading('ambiguous_401_reconnecting') }))
      .toBe(false);
    expect(hasExplicitAuthLossSignal({ ...raw401, disconnectDecision: reading('ambiguous_401_parked') }))
      .toBe(true);
    expect(hasExplicitAuthLossSignal({ ...raw401, disconnectDecision: { kind: 'none' } })).toBe(false);
  });

  it('an unknown future classification stays unknown — not auth loss on a bare 401', () => {
    expect(hasExplicitAuthLossSignal({
      ...raw401,
      disconnectDecision: { kind: 'unknown', reason: 'unrecognized_classification' },
    })).toBe(false);
  });

  it('a terminal auth class still decides on its own', () => {
    expect(hasExplicitAuthLossSignal({
      lastStatusCode: null,
      lastDisconnectReason: null,
      authFailureClass: 'auth_401_uninspected_exit',
      disconnectDecision: { kind: 'unknown', reason: 'malformed' },
    })).toBe(true);
  });
});

describe('decideAuthLossModeEvent — unconfirmed 401 classes', () => {
  it('parks and uninspected exits open a relink outage as inferred, never confirmed', () => {
    for (const authFailureClass of ['auth_401_ambiguous_parked', 'auth_401_uninspected_exit'] as const) {
      expect(decideAuthLossModeEvent({ authFailureClass })).toEqual({
        action: 'open_outage',
        bucket: 'mode_1_manual_relink',
        closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
        confidence: 'inferred',
      });
    }
  });

  it('an ambiguous retry is a transient flap, and confirmed removal stays confirmed', () => {
    expect(decideAuthLossModeEvent({ authFailureClass: 'auth_401_ambiguous_retrying' })).toMatchObject({
      bucket: 'transient_flap',
      confidence: 'inferred',
    });
    expect(decideAuthLossModeEvent({ authFailureClass: 'serverside_logout_irreversible' })).toMatchObject({
      bucket: 'mode_1_manual_relink',
      confidence: 'confirmed',
    });
  });
});
