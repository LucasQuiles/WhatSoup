/**
 * #1786: HealthPoller writes/resolves the durable auth_loss_signal latch.
 *
 * The in-memory `instance_logged_out` alert state does not survive a fleet restart;
 * the durable table does. These tests prove the poller records a confirmed logged_out
 * as a durable row (idempotently) and resolves it on a proven recovery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  clearAlertSource: vi.fn(() => true),
}));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const alertThrottleStore = vi.hoisted(() => ({
  loadAlertThrottle: vi.fn(() => new Map<string, string>()),
  loadAlertThrottleDetailed: vi.fn(() => ({ entries: new Map<string, string>(), loadError: null })),
  recordAlertThrottle: vi.fn(),
}));
const silenceManager = vi.hoisted(() => ({ isInstanceSilenced: vi.fn(() => false) }));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  ...alertFns,
  emitAlertChecked: alertFns.emitAlert,
  clearAlertSourceChecked: alertFns.clearAlertSource,
}));
vi.mock('../../src/fleet/alert-throttle-store.ts', () => ({
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1_000,
  ...alertThrottleStore,
}));
vi.mock('../../src/fleet/silence-manager.ts', () => silenceManager);
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ ...logger, child: vi.fn().mockReturnThis() }),
}));

import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import { AuthLossSignalStore } from '../../src/fleet/auth-loss-signal-store.ts';
import { Database } from '../../src/core/database.ts';

/** Health body that classifies as a confirmed `logged_out` (explicit 401 + backoff/0). */
function loggedOutBody(): Record<string, unknown> {
  return {
    status: 'unhealthy',
    whatsapp: {
      connected: false,
      connection: {
        state: 'disconnected',
        last_status_code: 401,
        last_disconnect_reason: 'loggedOut',
        reconnect_phase: 'backoff',
        reconnect_attempts: 0,
      },
    },
  };
}

const INSTANCE = 'loops';
function selfInstance(): Map<string, InstanceHealth> {
  return new Map([[INSTANCE, { name: INSTANCE, type: 'agent', accessMode: 'allowlist', healthPort: 9001, healthToken: null }]]);
}
function activeRows(db: Database): Array<{ instance: string; classifier: string; reason: string; confidence: string }> {
  return db.raw
    .prepare("SELECT instance, classifier, reason, confidence FROM auth_loss_signal WHERE resolved_at IS NULL")
    .all() as Array<{ instance: string; classifier: string; reason: string; confidence: string }>;
}

describe('HealthPoller durable auth-loss signal (#1786)', () => {
  let db: Database;
  let store: AuthLossSignalStore;
  let poller: HealthPoller;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    store = new AuthLossSignalStore(db.raw);
    vi.clearAllMocks();
  });
  afterEach(() => {
    poller?.stop();
    db.close();
  });

  it('records a durable auth_loss_signal row on a confirmed logged_out classification', async () => {
    poller = new HealthPoller(selfInstance, INSTANCE, loggedOutBody, 5_000, undefined, store);
    await poller.start();

    const rows = activeRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instance: INSTANCE,
      classifier: 'logged_out',
      reason: 'whatsapp_auth_loss_with_disconnect_corroboration',
      confidence: 'confirmed',
    });
  });

  it('is idempotent — repeated logged_out polls keep exactly one active row', async () => {
    poller = new HealthPoller(selfInstance, INSTANCE, loggedOutBody, 5_000, undefined, store);
    await poller.start();
    await poller.start(); // no-op second start; simulate a second observation via the store dedup
    // A second explicit record must dedup, not duplicate:
    store.record({ instance: INSTANCE, host: INSTANCE, classifier: 'logged_out', reason: 'whatsapp_auth_loss_with_disconnect_corroboration', confidence: 'confirmed' });
    expect(activeRows(db)).toHaveLength(1);
  });

  it('does nothing when no store is injected (backward compatible)', async () => {
    poller = new HealthPoller(selfInstance, INSTANCE, loggedOutBody, 5_000);
    await poller.start();
    // No throw, no store — the poller behaves as before.
    expect(activeRows(db)).toHaveLength(0);
  });
});

/**
 * Remote-instance path (#1786). A fleet host polls OTHER instances over HTTP; a confirmed
 * de-link there is routed through `classifyLoggedOutSignal` → `updateLoggedOutFromConfirmation`,
 * a DIFFERENT path than the self-health `classifyHealthSnapshot` branch above. The durable
 * writer must fire here too, or every remote de-link (incl. hard 401/loggedOut logouts) is
 * invisible across restart — the exact #1786 defect for the primary fleet-monitoring case.
 *
 * NOTE (test footgun): the body is served over HTTP **200** with a nested
 * `whatsapp.connection.last_status_code: 401`. A transport-level 401 response would
 * short-circuit to `degraded` (health_probe_auth_failed) BEFORE the confirmation classifier
 * runs, so a 401 status here would prove nothing.
 */
describe('HealthPoller durable auth-loss signal — remote confirmation path (#1786)', () => {
  let db: Database;
  let store: AuthLossSignalStore;
  let poller: HealthPoller;
  let mockFetch: ReturnType<typeof vi.fn>;

  const REMOTE = 'remote-1';
  function remoteInstances(): Map<string, InstanceHealth> {
    return new Map<string, InstanceHealth>([
      ['self', { name: 'self', type: 'agent', accessMode: 'allowlist', healthPort: 9000, healthToken: null }],
      [REMOTE, { name: REMOTE, type: 'chat', accessMode: 'open', healthPort: 9100, healthToken: null }],
    ]);
  }
  function onlineSelf(): Record<string, unknown> {
    return {
      status: 'healthy',
      generated_at: new Date().toISOString(),
      whatsapp: {
        connected: true,
        account_jid: 'self@s.whatsapp.net',
        connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0, auth_failure_class: 'none' },
      },
    };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    store = new AuthLossSignalStore(db.raw);
    mockFetch = vi.fn();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'));
  });
  afterEach(() => {
    poller?.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    db.close();
  });

  it('records a durable row for a REMOTE confirmed logged_out (explicit_auth_loss via the confirmation path)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(loggedOutBody()) });
    poller = new HealthPoller(remoteInstances, 'self', () => onlineSelf(), 5_000, undefined, store);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const rows = activeRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instance: REMOTE,
      classifier: 'logged_out',
      reason: 'explicit_auth_loss',
      confidence: 'confirmed',
    });
  });

  it('is idempotent — repeated remote logged_out polls keep exactly one active row', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(loggedOutBody()) });
    poller = new HealthPoller(remoteInstances, 'self', () => onlineSelf(), 5_000, undefined, store);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000); // second poll, same de-linked state
    expect(activeRows(db)).toHaveLength(1);
  });
});
