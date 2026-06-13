import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn(() => true),
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

type AlertMockCall = [string, string, ...unknown[]];

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

// Suppress pino output during tests
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    ...logger,
    child: vi.fn().mockReturnThis(),
  }),
}));

function makeInstance(overrides: Partial<InstanceHealth> = {}): InstanceHealth {
  return {
    name: 'remote-1',
    type: 'chat',
    accessMode: 'open',
    healthPort: 9100,
    healthToken: null,
    ...overrides,
  };
}

function makeInstances(...items: [string, InstanceHealth][]): Map<string, InstanceHealth> {
  return new Map(items);
}

function makeVerifiedRelinkHealth(overrides: {
  authBond?: Record<string, unknown>;
  creds?: Record<string, unknown>;
  connection?: Record<string, unknown>;
  outboundSends?: Record<string, unknown>;
  whatsapp?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    status: 'healthy',
    whatsapp: {
      connected: true,
      connection: {
        state: 'connected',
        reconnect_phase: null,
        reconnect_attempts: 0,
        ...overrides.connection,
      },
      auth_bond: {
        status: 'present',
        ...overrides.authBond,
        creds: {
          exists: true,
          size: 512,
          mtime: '2026-05-20T12:00:05.000Z',
          hash: 'a'.repeat(20),
          empty_hash: false,
          ...overrides.creds,
        },
      },
      ...overrides.whatsapp,
    },
    outbound_sends: {
      latest_successful_send_at: '2026-05-20T12:00:10.000Z',
      latest_successful_transport_id: 'wamid.relink-proof',
      ...overrides.outboundSends,
    },
  };
}

function expectClearAlertSourceCalled(instance: string, source: string): void {
  expect(
    (alertFns.clearAlertSource.mock.calls as unknown as AlertMockCall[]).some(
      ([callInstance, callSource]) => callInstance === instance && callSource === source,
    ),
  ).toBe(true);
}

function expectClearAlertSourceNotCalled(instance: string, source: string): void {
  expect(
    (alertFns.clearAlertSource.mock.calls as unknown as AlertMockCall[]).some(
      ([callInstance, callSource]) => callInstance === instance && callSource === source,
    ),
  ).toBe(false);
}

function expectEmitAlertSourceNotCalled(instance: string, source: string): void {
  expect(
    (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).some(
      ([callInstance, callSource]) => callInstance === instance && callSource === source,
    ),
  ).toBe(false);
}

function serverRevokedAssetMatcher(confidence: 'confirmed' | 'probable' = 'confirmed') {
  return expect.objectContaining({
    asset: expect.objectContaining({
      kind: 'whatsapp_linked_device',
      instance: 'remote-1',
      owner: 'whatsoup',
    }),
    failure: expect.objectContaining({
      code: 'WA_AUTH_BOND_SERVER_REVOKED',
      domain: 'account_linkage',
      recoverability: 'manual_relink_required',
      confidence,
    }),
  });
}

function relinkVerifiedAssetMatcher() {
  return expect.objectContaining({
    asset: expect.objectContaining({
      kind: 'whatsapp_linked_device',
      instance: 'remote-1',
      owner: 'whatsoup',
    }),
    failure: expect.objectContaining({
      code: 'WA_AUTH_BOND_RELINK_VERIFIED',
      domain: 'account_linkage',
      confidence: 'confirmed',
    }),
  });
}

describe('HealthPoller', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
    alertFns.emitAlert.mockReset();
    alertFns.emitAlert.mockReturnValue(true);
    alertFns.clearAlertSource.mockReset();
    alertFns.clearAlertSource.mockReturnValue(true);
    alertThrottleStore.loadAlertThrottle.mockReset();
    alertThrottleStore.loadAlertThrottle.mockReturnValue(new Map());
    alertThrottleStore.loadAlertThrottleDetailed.mockReset();
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({ entries: new Map(), loadError: null });
    // mockReset (not mockClear) so a per-test throwing implementation cannot
    // leak into later tests.
    alertThrottleStore.recordAlertThrottle.mockReset();
    silenceManager.isInstanceSilenced.mockReset();
    silenceManager.isInstanceSilenced.mockReturnValue(false);
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Test 1: self-instance uses getSelfHealth callback (no HTTP)
  it('self-instance uses getSelfHealth callback without HTTP', async () => {
    const selfHealth = { status: 'healthy', uptime_seconds: 42 };
    const getSelfHealth = vi.fn().mockReturnValue(selfHealth);
    const instances = makeInstances(['self', makeInstance({ name: 'self' })]);

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();

    // Wait for the initial async poll to settle
    await vi.advanceTimersByTimeAsync(0);

    const status = poller.getStatus('self');
    expect(status).toBeDefined();
    expect(status!.status).toBe('online');
    expect(status!.health).toEqual(selfHealth);
    expect(status!.consecutiveFailures).toBe(0);
    expect(status!.error).toBeNull();
    expect(getSelfHealth).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();

    poller.stop();
  });

  it('start() is idempotent — a second start does not double-poll', async () => {
    const getSelfHealth = vi.fn().mockReturnValue({ status: 'healthy', uptime_seconds: 1 });
    const instances = makeInstances(['self', makeInstance({ name: 'self' })]);

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    void poller.start(); // must be a no-op, not a second immediate poll + interval
    await vi.advanceTimersByTimeAsync(0);
    expect(getSelfHealth).toHaveBeenCalledTimes(1); // one immediate poll, not two

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getSelfHealth).toHaveBeenCalledTimes(2); // one interval tick, not two

    poller.stop();
  });

  // Self-instance health must be CLASSIFIED with the same semantics as a
  // remote payload — a degraded/logged-out self snapshot was previously
  // forced to status 'online' with confirmed confidence.
  it('self-instance with a non-online health snapshot is classified, not forced online', async () => {
    const loggedOutSelf = {
      status: 'unhealthy',
      whatsapp: {
        connected: false,
        account_jid: 'not connected',
        connection: {
          state: 'logged_out',
          auth_failure_class: 'logged_out',
          last_disconnect_reason: 'loggedOut',
          last_status_code: 401,
        },
      },
    };
    const getSelfHealth = vi.fn().mockReturnValue(loggedOutSelf);
    const instances = makeInstances(['self', makeInstance({ name: 'self' })]);

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const status = poller.getStatus('self');
    expect(status).toBeDefined();
    expect(status!.status).not.toBe('online');
    expect(status!.health).toEqual(loggedOutSelf);
    expect(mockFetch).not.toHaveBeenCalled();

    poller.stop();
  });

  // Test 2: remote instance polled via fetch
  it('remote instance polled via fetch', async () => {
    const remoteHealth = { status: 'healthy', uptime_seconds: 100 };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(remoteHealth),
    });

    const instances = makeInstances(
      ['self', makeInstance({ name: 'self' })],
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({ status: 'healthy' });

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const status = poller.getStatus('remote-1');
    expect(status).toBeDefined();
    expect(status!.status).toBe('online');
    expect(status!.health).toEqual(remoteHealth);
    expect(status!.consecutiveFailures).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9100/health',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: {},
      }),
    );

    poller.stop();
  });

  it('debounces a single degraded health body without alerting', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'degraded',
        reason: 'runtime_agent_at_risk',
        whatsapp: { connected: true, connection: { state: null } },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    expect(alertFns.emitAlert).not.toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      expect.any(String),
      expect.any(String),
    );

    poller.stop();
  });

  it('alerts when a degraded health body persists beyond the debounce window', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'degraded',
        reason: 'runtime_agent_at_risk',
        whatsapp: { connected: true, connection: { state: null } },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(alertFns.emitAlert).not.toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      expect.any(String),
      expect.any(String),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      'whatsoup@remote-1 health is degraded',
      expect.stringContaining('health_body_degraded_polls=3'),
      'critical',
      undefined,
    );
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      'whatsoup@remote-1 health is degraded',
      expect.stringContaining('connection_state=unknown'),
      'critical',
      undefined,
    );

    poller.stop();
  });

  it('clears only health_body_degraded when degraded health recovers', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'degraded', reason: 'runtime_agent_at_risk' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'degraded', reason: 'runtime_agent_at_risk' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'degraded', reason: 'runtime_agent_at_risk' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      'whatsoup@remote-1 health is degraded',
      expect.stringContaining('health_body_degraded_polls=3'),
      'critical',
      undefined,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expectClearAlertSourceCalled('remote-1', 'health_body_degraded');
    expectClearAlertSourceNotCalled('remote-1', 'instance_degraded');
    expectClearAlertSourceNotCalled('remote-1', 'health_probe_auth_failed');

    poller.stop();
  });

  it('classifies health endpoint auth failures separately from reachability loss', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'unauthorized' }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100, healthToken: 'wrong-token' })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_probe_auth_failed',
      'whatsoup@remote-1 health probe auth failed',
      'health_probe_auth_failed http_status=401 health_port=9100',
      'critical',
      undefined,
    );
    expect(alertFns.emitAlert).not.toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.any(String),
      expect.any(String),
    );

    poller.stop();
  });

  it('clears only health_probe_auth_failed when health auth recovers', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'unauthorized' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100, healthToken: 'wrong-token' })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_probe_auth_failed',
      'whatsoup@remote-1 health probe auth failed',
      'health_probe_auth_failed http_status=401 health_port=9100',
      'critical',
      undefined,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expectClearAlertSourceCalled('remote-1', 'health_probe_auth_failed');
    expectClearAlertSourceNotCalled('remote-1', 'instance_degraded');
    expectClearAlertSourceNotCalled('remote-1', 'health_body_degraded');

    poller.stop();
  });

  // Test 3: 3 consecutive failures -> 'unreachable' status
  it('3 consecutive failures mark instance as unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();

    // Poll 1
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(1);

    // Poll 2
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(2);

    // Poll 3 — threshold reached
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
    expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(3);
    expect(poller.getStatus('remote-1')!.everReachable).toBe(false);
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_never_reachable',
      'whatsoup@remote-1 has never answered health checks',
      expect.stringContaining('Last error: connection refused'),
      'warning',
      undefined,
    );
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_never_reachable',
      'whatsoup@remote-1 has never answered health checks',
      expect.stringContaining('target_pid=unknown'),
      'warning',
      undefined,
    );

    poller.stop();
  });

  it('emits a critical outage for an instance that was online then went unreachable', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy', instance: { pid: 4242 } }),
      })
      .mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus('remote-1')!.everReachable).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
    expect(poller.getStatus('remote-1')!.everReachable).toBe(true);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.stringContaining('whatsoup@remote-1 unreachable'),
      expect.stringContaining('Last error: connection refused'),
      'critical',
      undefined,
    );
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.stringContaining('consecutive poll failures'),
      expect.stringContaining('dwell_ms=30000'),
      'critical',
      undefined,
    );
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.stringContaining('consecutive poll failures'),
      expect.stringContaining('target_pid=4242'),
      'critical',
      undefined,
    );

    poller.stop();
  });

  it('suppresses a previously reachable outage that recovers before the dwell window', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      })
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expect(alertFns.emitAlert).not.toHaveBeenCalled();
    expectClearAlertSourceNotCalled('remote-1', 'instance_unreachable');

    poller.stop();
  });

  it('keeps planned-maintenance outages internal while instance alerts are silenced', async () => {
    silenceManager.isInstanceSilenced.mockReturnValue(true);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      })
      .mockRejectedValue(new Error('operation timed out during restart'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
    expect(poller.getStatus('remote-1')!.everReachable).toBe(true);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(alertFns.emitAlert).not.toHaveBeenCalled();
    expect(alertThrottleStore.recordAlertThrottle).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'remote-1',
        source: 'instance_unreachable',
      }),
      'alert suppressed — instance is silenced',
    );

    poller.stop();
  });

  it('does not silence or rate-limit explicit logged-out evidence', async () => {
    alertThrottleStore.loadAlertThrottle.mockReturnValue(new Map([
      ['remote-1', '2026-05-20T11:59:30.000Z'],
    ]));
    silenceManager.isInstanceSilenced.mockReturnValue(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        whatsapp: {
          connected: false,
          connection: {
            state: 'disconnected',
            auth_failure_class: 'serverside_logout_irreversible',
            last_status_code: 401,
            last_disconnect_reason: 'loggedOut',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('auth_failure_class=serverside_logout_irreversible'),
      'critical',
      serverRevokedAssetMatcher(),
    );
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('last_status_code=401'),
      'critical',
      serverRevokedAssetMatcher(),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'instance_logged_out' }),
      'alert suppressed — instance is silenced',
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'instance_logged_out' }),
      'alert suppressed — rate limit (15min)',
    );

    poller.stop();
  });

  it('classifies pairing_required as critical physical-intervention evidence', async () => {
    silenceManager.isInstanceSilenced.mockReturnValue(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        whatsapp: {
          connected: false,
          connection: {
            state: 'connecting',
            auth_failure_class: 'pairing_required',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('auth_failure_class=pairing_required'),
      'critical',
      serverRevokedAssetMatcher(),
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'instance_logged_out' }),
      'alert suppressed — instance is silenced',
    );

    poller.stop();
  });

  it('does not treat a stale connected boolean as logged-out recovery', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        whatsapp: {
          connected: true,
          connection: {
            state: 'disconnected',
            auth_failure_class: 'serverside_logout_irreversible',
            last_status_code: 401,
            last_disconnect_reason: 'loggedOut',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('state=disconnected'),
      'critical',
      serverRevokedAssetMatcher(),
    );

    poller.stop();
  });

  it('treats a non-ok HTTP response as proof of reachability', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus('remote-1')!.everReachable).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
    expect(poller.getStatus('remote-1')!.everReachable).toBe(true);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.stringContaining('whatsoup@remote-1 unreachable'),
      expect.stringContaining('Last error: HTTP 503'),
      'critical',
      undefined,
    );

    poller.stop();
  });

  it('clears instance_never_reachable when a never-reachable instance later answers', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
    expect(poller.getStatus('remote-1')!.everReachable).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expectClearAlertSourceCalled('remote-1', 'instance_never_reachable');
    expectClearAlertSourceNotCalled('remote-1', 'instance_unreachable');

    poller.stop();
  });

  it('clears instance_unreachable when a previously reachable outage recovers', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      })
      .mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
    expect(poller.getStatus('remote-1')!.everReachable).toBe(true);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.stringContaining('whatsoup@remote-1 unreachable'),
      expect.stringContaining('dwell_ms=30000'),
      'critical',
      undefined,
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: 'healthy' }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expectClearAlertSourceCalled('remote-1', 'instance_unreachable');
    expectClearAlertSourceNotCalled('remote-1', 'instance_never_reachable');

    poller.stop();
  });

  it('re-arms unreachable paging without sending a recovery clear when unreachable escalates to logged-out', async () => {
    let phase: 'healthy' | 'failing' | 'logged-out' = 'healthy';
    mockFetch.mockImplementation(async () => {
      if (phase === 'failing') throw new Error('connection refused');
      if (phase === 'logged-out') {
        return {
          ok: true,
          json: () => Promise.resolve({
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
          }),
        };
      }
      return {
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      };
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    phase = 'failing';
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.stringContaining('whatsoup@remote-1 unreachable'),
      expect.stringContaining('dwell_ms=30000'),
      'critical',
      undefined,
    );

    phase = 'logged-out';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expectClearAlertSourceNotCalled('remote-1', 'instance_unreachable');
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);

    phase = 'healthy';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expectClearAlertSourceNotCalled('remote-1', 'instance_logged_out');

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    alertFns.emitAlert.mockClear();

    phase = 'failing';
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.stringContaining('whatsoup@remote-1 unreachable'),
      expect.stringContaining('dwell_ms=30000'),
      'critical',
      undefined,
    );

    poller.stop();
  });

  // Test 4: successful poll resets consecutiveFailures to 0
  it('successful poll resets consecutiveFailures to 0', async () => {
    // First two polls fail, third succeeds
    mockFetch
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();

    // Poll 1 — fails
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(1);

    // Poll 2 — fails
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(2);

    // Poll 3 — succeeds
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(0);
    expect(poller.getStatus('remote-1')!.everReachable).toBe(true);
    expect(poller.getStatus('remote-1')!.error).toBeNull();

    poller.stop();
  });

  // Test 5: fetch abort before connect is classified as local probe starvation.
  it('does not count aborted-before-connect probes as remote instance failures', async () => {
    mockFetch.mockRejectedValue(new Error('The operation was aborted'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const status = poller.getStatus('remote-1');
    expect(status).toBeDefined();
    expect(status!.status).toBe('degraded');
    expect(status!.error).toContain('health_probe_timeout_under_proxy_load');
    expect(status!.error).toContain('reason=probe_aborted_before_connect');
    expect(status!.error).toContain('health_port=9100');
    expect(status!.consecutiveFailures).toBe(0);
    expect(status!.everReachable).toBe(false);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    poller.stop();
  });

  it('carries the last target pid through aborted-before-connect probe evidence', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy', instance: { pid: 5151 } }),
      })
      .mockRejectedValueOnce(new Error('The operation was aborted'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    const status = poller.getStatus('remote-1');
    expect(status).toBeDefined();
    expect(status!.status).toBe('degraded');
    expect(status!.error).toContain('health_probe_timeout_under_proxy_load');
    expect(status!.error).toContain('target_pid=5151');
    expect(status!.consecutiveFailures).toBe(0);

    poller.stop();
  });

  it('keeps timeout active while reading health response JSON', async () => {
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      const json = new Promise<Record<string, unknown>>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('health body aborted')), { once: true });
      });
      return { ok: true, json: () => json };
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    const pollPromise = (poller as any).poll() as Promise<void>;
    let settled = false;
    pollPromise.finally(() => { settled = true; }).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.resolve();

    expect(settled).toBe(true);
    await expect(pollPromise).resolves.toBeUndefined();
    const status = poller.getStatus('remote-1');
    expect(status).toMatchObject({
      status: 'degraded',
      error: 'health body aborted',
      consecutiveFailures: 1,
      everReachable: true,
    });
  });

  // Test 6: auth token forwarded in Authorization header
  it('auth token forwarded in Authorization header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'healthy' }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100, healthToken: 'secret-abc' })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9100/health',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-abc' },
      }),
    );

    poller.stop();
  });

  it('prunes statuses for instances removed from discovery', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'healthy' }),
    });

    const instances = makeInstances(
      ['self', makeInstance({ name: 'self' })],
      ['remote-a', makeInstance({ name: 'remote-a', healthPort: 9101 })],
      ['remote-b', makeInstance({ name: 'remote-b', healthPort: 9102 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({ status: 'healthy' });
    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);

    await (poller as any).poll();
    expect(poller.getStatus('remote-a')).toBeDefined();
    expect(poller.getStatus('remote-b')).toBeDefined();

    instances.delete('remote-b');
    await (poller as any).poll();

    expect(poller.getStatus('self')).toBeDefined();
    expect(poller.getStatus('remote-a')).toBeDefined();
    expect(poller.getStatus('remote-b')).toBeUndefined();
  });

  it('non-ok HTTP response records failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const status = poller.getStatus('remote-1');
    expect(status!.status).toBe('degraded');
    expect(status!.error).toBe('HTTP 503');

    poller.stop();
  });

  it('ignores stale backoff-zero reconnect metadata when connection is healthy', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'healthy',
        whatsapp: {
          connected: true,
          account_jid: '15550001111@s.whatsapp.net',
          connection: {
            state: 'connected',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['mini4', makeInstance({ name: 'mini4', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    const status = poller.getStatus('mini4');
    expect(status).toMatchObject({
      status: 'online',
      statusConfidence: 'confirmed',
      statusReason: 'health_body_ok',
      error: null,
    });
    expect(status!.statusEvidence).toEqual(expect.arrayContaining([
      'health_status=healthy',
      'whatsapp_connected=true',
      'account_jid_status=present',
      'connection_state=connected',
      'reconnect_phase=backoff',
      'reconnect_attempts=0',
    ]));
    expectEmitAlertSourceNotCalled('mini4', 'instance_degraded');
    expectEmitAlertSourceNotCalled('mini4', 'instance_logged_out');
  });

  it('includes recent disconnect churn evidence for degraded connected instances', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'degraded',
        whatsapp: {
          connected: true,
          account_jid: '15550001111@s.whatsapp.net',
          connection: {
            state: 'connected',
            reconnect_phase: null,
            reconnect_attempts: 0,
            last_disconnect_reason: null,
            last_status_code: null,
            recent_disconnects: {
              window_ms: 600_000,
              degraded_threshold: 3,
              count: 4,
              last_at: '2026-05-20T11:59:30.000Z',
              last_reason: 'connectionReplaced',
              last_status_code: 440,
            },
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    const status = poller.getStatus('remote-1');
    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'confirmed',
      statusReason: 'health_body_degraded',
    });
    expect(status!.statusEvidence).toEqual(expect.arrayContaining([
      'health_status=degraded',
      'whatsapp_connected=true',
      'connection_state=connected',
      'auth_failure_class=unknown',
      'recent_disconnect_count=4',
      'recent_disconnect_threshold=3',
      'recent_disconnect_window_ms=600000',
      'recent_disconnect_last_at=2026-05-20T11:59:30.000Z',
      'recent_disconnect_last_reason=connectionReplaced',
      'recent_disconnect_last_status_code=440',
    ]));
  });

  it('keeps disconnected backoff-zero ambiguous without explicit auth-loss proof', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'degraded',
        whatsapp: {
          connected: false,
          account_jid: 'not connected',
          connection: {
            state: 'reconnecting',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
            last_disconnect_reason: 'connectionReplaced',
            last_status_code: 440,
            auth_failure_class: 'none',
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    const status = poller.getStatus('remote-1');
    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'whatsapp_backoff_zero_attempts_with_disconnect_without_auth_loss_signal',
      error: null,
    });
    expect(status!.statusEvidence).toEqual(expect.arrayContaining([
      'whatsapp_connected=false',
      'account_jid_status=not_connected',
      'connection_state=reconnecting',
      'last_disconnect_reason=connectionReplaced',
      'last_status_code=440',
      'auth_failure_class=none',
    ]));
    expectEmitAlertSourceNotCalled('remote-1', 'instance_degraded');
    expectEmitAlertSourceNotCalled('remote-1', 'instance_logged_out');
  });

  it('classifies disconnected backoff-zero as logged_out when auth-loss proof is explicit', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        whatsapp: {
          connected: false,
          account_jid: 'not connected',
          connection: {
            state: 'disconnected',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
            last_disconnect_reason: 'loggedOut',
            last_status_code: 401,
            auth_failure_class: 'serverside_logout_irreversible',
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    const status = poller.getStatus('remote-1');
    expect(status).toMatchObject({
      status: 'logged_out',
      statusConfidence: 'confirmed',
      statusReason: 'instance_logged_out',
      error: null,
    });
    expect(status!.statusEvidence).toEqual(expect.arrayContaining([
      'last_disconnect_reason=loggedOut',
      'last_status_code=401',
      'auth_failure_class=serverside_logout_irreversible',
    ]));
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('last_disconnect_reason=loggedOut'),
      'critical',
      serverRevokedAssetMatcher(),
    );
  });

  it('parses non-ok health JSON before falling back to generic HTTP failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({
        status: 'unhealthy',
        whatsapp: {
          connected: false,
          account_jid: 'not connected',
          connection: {
            state: 'disconnected',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
            last_disconnect_reason: 'connectionReplaced',
            last_status_code: 440,
            auth_failure_class: 'none',
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 0,
      error: null,
      statusReason: 'whatsapp_backoff_zero_attempts_with_disconnect_without_auth_loss_signal',
    });
    expectEmitAlertSourceNotCalled('remote-1', 'instance_logged_out');
  });

  it('logs and continues when a status change listener throws', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});
    const listenerError = new Error('listener failed');
    const throwingListener = vi.fn(() => { throw listenerError; });
    const followingListener = vi.fn();

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.on('statusChange', throwingListener);
    poller.on('statusChange', followingListener);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(throwingListener).toHaveBeenCalledWith('remote-1', 'degraded', 'online');
    expect(followingListener).toHaveBeenCalledWith('remote-1', 'degraded', 'online');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: listenerError,
        instance: 'remote-1',
        newStatus: 'degraded',
        oldStatus: 'online',
      }),
      'status change listener failed',
    );

    poller.stop();
  });

  it('getStatuses returns all tracked instances', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'healthy' }),
    });

    const instances = makeInstances(
      ['self', makeInstance({ name: 'self' })],
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
      ['remote-2', makeInstance({ name: 'remote-2', healthPort: 9200 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({ status: 'healthy' });

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const statuses = poller.getStatuses();
    expect(statuses.size).toBe(3);
    expect(statuses.has('self')).toBe(true);
    expect(statuses.has('remote-1')).toBe(true);
    expect(statuses.has('remote-2')).toBe(true);

    poller.stop();
  });

  it('hydrates lastAlertAt from the persisted alert throttle store', async () => {
    const lastAlertAt = '2026-05-20T11:55:00.000Z';
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
      entries: new Map([['remote-1:instance_unreachable', lastAlertAt]]),
      loadError: null,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'healthy' }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.lastAlertAt).toBe(lastAlertAt);

    poller.stop();
  });

  it('persists lastAlertAt when an alert is emitted', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(alertThrottleStore.recordAlertThrottle).toHaveBeenCalledWith(
      'remote-1:instance_never_reachable',
      '2026-05-20T12:00:02.000Z',
    );
    expect(alertFns.emitAlert).toHaveBeenCalledOnce();

    poller.stop();
  });

  it('does not burn cooldown or active state when a never-reachable alert emission fails', async () => {
    alertFns.emitAlert.mockReturnValue(false);
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(alertFns.emitAlert).toHaveBeenCalledOnce();
    expect(alertThrottleStore.recordAlertThrottle).not.toHaveBeenCalled();
    expect(poller.getStatus('remote-1')!.lastAlertAt).toBeNull();
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(alertFns.emitAlert).toHaveBeenCalledTimes(2);
    expect(alertThrottleStore.recordAlertThrottle).not.toHaveBeenCalled();
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual([]);

    poller.stop();
  });

  it('retries logged-out alerts after a failed emission instead of treating them as delivered', async () => {
    alertFns.emitAlert
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        whatsapp: {
          connected: false,
          connection: {
            state: 'disconnected',
            auth_failure_class: 'serverside_logout_irreversible',
            last_status_code: 401,
            last_disconnect_reason: 'loggedOut',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(alertFns.emitAlert).toHaveBeenCalledOnce();
    expect(alertThrottleStore.recordAlertThrottle).not.toHaveBeenCalled();
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(alertFns.emitAlert).toHaveBeenCalledTimes(2);
    expect(alertThrottleStore.recordAlertThrottle).toHaveBeenCalledWith(
      'remote-1:instance_logged_out',
      '2026-05-20T12:00:01.000Z',
    );
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);

    poller.stop();
  });

  it('still emits an alert when throttle persistence fails', async () => {
    const persistErr = new Error('disk full');
    alertThrottleStore.recordAlertThrottle.mockImplementationOnce(() => {
      throw persistErr;
    });
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_never_reachable',
      'whatsoup@remote-1 has never answered health checks',
      expect.stringContaining('Last error: connection refused'),
      'warning',
      undefined,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: persistErr,
        name: 'remote-1',
        source: 'instance_never_reachable',
        throttleKey: 'remote-1:instance_never_reachable',
      }),
      'failed to persist alert throttle',
    );

    poller.stop();
  });

  it('suppresses restart-cycle alerts using persisted lastAlertAt', async () => {
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
      entries: new Map([
        ['remote-1:instance_never_reachable', '2026-05-20T11:55:00.000Z'],
      ]),
      loadError: null,
    });
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(alertFns.emitAlert).not.toHaveBeenCalled();
    expect(alertThrottleStore.recordAlertThrottle).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'remote-1',
        source: 'instance_never_reachable',
      }),
      'alert suppressed — rate limit (15min)',
    );

    poller.stop();
  });


  it('rate-limits alerts per incident source', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'healthy' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'unhealthy' }),
      })
      .mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_degraded',
      'whatsoup@remote-1 is degraded',
      'Health body reports status=unhealthy',
      'critical',
      undefined,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.stringContaining('whatsoup@remote-1 unreachable'),
      expect.stringContaining('dwell_ms=30000'),
      'critical',
      undefined,
    );
    expect(alertThrottleStore.recordAlertThrottle).toHaveBeenCalledWith(
      'remote-1:instance_degraded',
      '2026-05-20T12:00:01.000Z',
    );
    expect(alertThrottleStore.recordAlertThrottle).toHaveBeenCalledWith(
      'remote-1:instance_unreachable',
      expect.any(String),
    );

    poller.stop();
  });

  it('does not emit logged-out alert for a single weak restart-window backoff sample', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          status: 'unhealthy',
          whatsapp: {
            connected: false,
            connection: {
              state: 'disconnected',
              reconnect_phase: 'backoff',
              reconnect_attempts: 0,
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0 },
          },
        }),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expect(alertFns.emitAlert).not.toHaveBeenCalled();
    expect(alertFns.clearAlertSource).not.toHaveBeenCalled();

    poller.stop();
  });

  it('does not classify connected restart-window backoff as logged-out during settle grace', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        uptime_seconds: 21,
        whatsapp: {
          connected: true,
          connection: {
            state: 'connected',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_degraded',
      'whatsoup@remote-1 is degraded',
      'Health body reports status=unhealthy',
      'critical',
      undefined,
    );
    expectEmitAlertSourceNotCalled('remote-1', 'instance_logged_out');

    poller.stop();
  });

  it('does not emit logged-out for persistent weak backoff while inside settle grace', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        uptime_seconds: 21,
        whatsapp: {
          connected: false,
          connection: {
            state: 'disconnected',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    poller.stop();
  });

  it('emits logged-out immediately for explicit 401 logout evidence', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        uptime_seconds: 120,
        whatsapp: {
          connected: false,
          connection: {
            state: 'disconnected',
            disconnect_class: 'serverside_logout_irreversible',
            last_status_code: 401,
            last_disconnect_reason: 'loggedOut',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('disconnect_class=serverside_logout_irreversible'),
      'critical',
      serverRevokedAssetMatcher(),
    );

    poller.stop();
  });

  it('adds rich redacted credential lifecycle metadata to logged-out alert evidence', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        uptime_seconds: 120,
        whatsapp: {
          connected: false,
          connection: {
            state: 'disconnected',
            last_status_code: 401,
            last_disconnect_reason: 'loggedOut',
            auth_failure_class: 'serverside_logout_irreversible',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
          credential_lifecycle: {
            latestBaileysVersion: '7.0.0-rc.9',
            connectStartedAt: '2026-06-11T04:10:00.000Z',
            lastOpenAt: '2026-06-11T04:11:00.000Z',
            lastCloseAt: '2026-06-11T04:13:30.867Z',
            lastQrAt: '2026-06-10T04:10:00.000Z',
            lastCredsUpdateAt: '2026-06-11T04:12:00.000Z',
            lastCredsUpdateFailedAt: '2026-06-11T04:12:30.000Z',
            lastAuthSnapshotAt: '2026-06-11T04:10:30.000Z',
            lastAuthSnapshotFailedAt: '2026-06-11T04:12:45.000Z',
            credsUpdateCount: 17,
            authSnapshotCaptureCount: 5,
            authSnapshotFailureCount: 1,
            environment: {
              host: 'nucles',
              pid: 4242,
              nodeVersion: 'v24.1.0',
              platform: 'linux',
              arch: 'arm64',
              processUptimeSeconds: 219,
              osUptimeSeconds: 86400,
              authDir: '/home/testuser/.local/share/whatsoup/instances/agent-alpha/auth',
              memory: {
                freeBytes: 1024,
                totalBytes: 4096,
              },
            },
            lastDisconnectDiagnostic: {
              statusCode: 401,
              reason: 'loggedOut',
              message: 'device 15555550123@s.whatsapp.net token=do-not-print phone 14155551234 removed Authorization: Bearer topsecretvalue',
            },
            recentEvents: [
              { event: 'baileys_version', at: '2026-06-11T04:10:00.000Z' },
              { event: 'socket_created', at: '2026-06-11T04:10:01.000Z' },
              { event: 'device_bond_lost', at: '2026-06-11T04:13:30.867Z', statusCode: 401, reason: 'loggedOut token=event-secret' },
            ],
          },
          auth_bond: {
            status: 'present',
            issues: ['server_revoked token=issue-secret'],
            auth_dir: {
              path: '/home/testuser/.local/share/whatsoup/instances/agent-alpha/auth',
              exists: true,
              mode: '700',
              mtime: '2026-06-11T04:10:30.000Z',
            },
            creds: {
              path: '/home/testuser/.local/share/whatsoup/instances/agent-alpha/auth/creds.json',
              exists: true,
              mode: '600',
              size: 2048,
              mtime: '2026-06-11T04:12:00.000Z',
              hash: 'abc123hash',
              empty_hash: false,
            },
            me_hash: 'mehash123',
            tree_hash: 'treehash123',
            backup: {
              root: '/home/testuser/.local/state/whatsoup/auth-bond-backups',
              latest: '/home/testuser/.local/state/whatsoup/auth-bond-backups/agent-alpha/latest',
              latest_at: '2026-06-11T04:12:05.000Z',
              latest_reason: 'creds_update',
              latest_tree_hash: 'treehash123',
              last_capture_at: '2026-06-11T04:12:05.000Z',
              last_capture_reason: 'creds_update',
              last_capture_error: 'copy failed token=capture-secret for 14155551234',
              last_capture_deferred_at: '2026-06-11T04:12:06.000Z',
              last_capture_deferred_reason: 'creds_update token=deferred-secret',
              last_capture_deferred_age_ms: 402,
              last_restore_at: '2026-06-11T04:20:00.000Z',
              last_restore_source: '/home/testuser/.local/state/whatsoup/auth-bond-backups/agent-alpha/latest',
              last_restore_error: 'restore failed secret=restore-secret',
            },
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
      ([instance, source]) => instance === 'remote-1' && source === 'instance_logged_out',
    );
    const evidence = String(call?.[3] ?? '');

    expect(evidence).toContain('baileys_version=7.0.0-rc.9');
    expect(evidence).toContain('lifecycle_last_close_at=2026-06-11T04:13:30.867Z');
    expect(evidence).toContain('lifecycle_creds_update_count=17');
    expect(evidence).toContain('lifecycle_host=nucles');
    expect(evidence).toContain('lifecycle_pid=4242');
    expect(evidence).toContain('credential_lifecycle_events=baileys_version,socket_created,device_bond_lost');
    expect(evidence).toContain('credential_lifecycle_last_event_status_code=401');
    expect(evidence).toContain('auth_bond_status=present');
    expect(evidence).toContain('auth_bond_creds_hash=abc123hash');
    expect(evidence).toContain('auth_bond_identity_hash=mehash123');
    expect(evidence).toContain('auth_bond_tree_hash=treehash123');
    expect(evidence).toContain('auth_bond_backup_latest_present=true');
    expect(evidence).toContain('auth_bond_backup_last_capture_deferred_at=2026-06-11T04:12:06.000Z');
    expect(evidence).toContain('auth_bond_backup_last_capture_deferred_age_ms=402');
    expect(evidence).toContain('auth_bond_backup_last_restore_source_present=true');
    expect(evidence).toContain('token=[REDACTED]');
    expect(evidence).toContain('secret=[REDACTED]');
    expect(evidence).toContain('[REDACTED_JID]');
    expect(evidence).toContain('[REDACTED_PHONE]');
    expect(evidence).not.toContain('15555550123@s.whatsapp.net');
    expect(evidence).not.toContain('14155551234');
    expect(evidence).not.toContain('do-not-print');
    expect(evidence).not.toContain('topsecretvalue');
    expect(evidence).not.toContain('event-secret');
    expect(evidence).not.toContain('issue-secret');
    expect(evidence).not.toContain('capture-secret');
    expect(evidence).not.toContain('deferred-secret');
    expect(evidence).not.toContain('restore-secret');
    expect(evidence).not.toContain('/home/testuser/.local/share/whatsoup/instances/agent-alpha/auth');
    expect(evidence).not.toContain('/home/testuser/.local/state/whatsoup/auth-bond-backups/agent-alpha/latest');

    poller.stop();
  });

  it('does not miss device-removed logout evidence when top-level health says healthy', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'healthy',
        uptime_seconds: 120,
        whatsapp: {
          connected: false,
          connection: {
            state: 'disconnected',
            last_disconnect_reason: 'device_removed_by_server',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('last_disconnect_reason=device_removed_by_server'),
      'critical',
      serverRevokedAssetMatcher(),
    );

    poller.stop();
  });

  it('emits logged-out immediately for normalized server-side auth failure class', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        uptime_seconds: 120,
        whatsapp: {
          connected: false,
          connection: {
            state: 'disconnected',
            auth_failure_class: 'serverside_logout_irreversible',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('auth_failure_class=serverside_logout_irreversible'),
      'critical',
      serverRevokedAssetMatcher(),
    );

    poller.stop();
  });

  it('resets weak logged-out persistence after an intervening non-weak sample', async () => {
    const weakHealth = {
      status: 'unhealthy',
      uptime_seconds: '120',
      whatsapp: {
        connected: false,
        connection: {
          state: 'disconnected',
          reconnect_phase: 'backoff',
          reconnect_attempts: 0,
        },
      },
    };
    const nonWeakHealth = {
      status: 'unhealthy',
      uptime_seconds: 120,
      whatsapp: {
        connected: false,
        connection: {
          state: 'disconnected',
          reconnect_phase: 'backoff',
          reconnect_attempts: 1,
        },
      },
    };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(weakHealth) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(weakHealth) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(nonWeakHealth) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(weakHealth) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(weakHealth) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(weakHealth) });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    expectEmitAlertSourceNotCalled('remote-1', 'instance_logged_out');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('weak_signal_polls=3'),
      'critical',
      serverRevokedAssetMatcher('probable'),
    );

    poller.stop();
  });

  it('parses non-ok health bodies for explicit logout evidence before marking unreachable', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({
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
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(0);
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('last_status_code=401'),
      'critical',
      serverRevokedAssetMatcher(),
    );
    expectEmitAlertSourceNotCalled('remote-1', 'instance_unreachable');

    poller.stop();
  });

  it('emits logged-out only after weak backoff evidence persists', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        uptime_seconds: 120,
        whatsapp: {
          connected: false,
          connection: {
            state: 'disconnected',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('weak_signal_polls=3'),
      'critical',
      serverRevokedAssetMatcher('probable'),
    );
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('uptime_seconds=120'),
      'critical',
      serverRevokedAssetMatcher('probable'),
    );

    poller.stop();
  });

  it('does not clear weaker degraded alerts when the instance escalates to logged_out', async () => {
    const degradedHealth = {
      status: 'degraded',
      reason: 'runtime_agent_at_risk',
      whatsapp: { connected: true, connection: { state: null } },
    };
    const loggedOutHealth = {
      status: 'unhealthy',
      whatsapp: {
        connected: false,
        connection: {
          state: 'disconnected',
          auth_failure_class: 'serverside_logout_irreversible',
          last_status_code: 401,
          last_disconnect_reason: 'loggedOut',
          reconnect_phase: 'backoff',
          reconnect_attempts: 0,
        },
      },
    };
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(degradedHealth),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(degradedHealth),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(degradedHealth),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(loggedOutHealth),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      'whatsoup@remote-1 health is degraded',
      expect.stringContaining('health_body_degraded_polls=3'),
      'critical',
      undefined,
    );
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['health_body_degraded']);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('auth_failure_class=serverside_logout_irreversible'),
      'critical',
      serverRevokedAssetMatcher(),
    );
    expectClearAlertSourceNotCalled('remote-1', 'health_body_degraded');
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);

    poller.stop();
  });

  it('keeps instance_logged_out sticky when a logged-out instance only reconnects', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
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
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0 },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeVerifiedRelinkHealth()),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);
    expectClearAlertSourceNotCalled('remote-1', 'instance_logged_out');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expect(alertFns.clearAlertSource).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      expect.stringContaining('clear_code=WA_AUTH_BOND_RELINK_VERIFIED'),
      relinkVerifiedAssetMatcher(),
    );
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual([]);

    poller.stop();
  });

  it('clears instance_logged_out when recovery proves auth bond and post-incident send', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
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
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeVerifiedRelinkHealth()),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expect(alertFns.clearAlertSource).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      expect.stringContaining('clear_code=WA_AUTH_BOND_RELINK_VERIFIED'),
      relinkVerifiedAssetMatcher(),
    );

    poller.stop();
  });

  it.each([
    ['zero-byte creds', { creds: { size: 0 } }],
    ['empty creds hash', { creds: { hash: 'e3b0c44298fc1c149af', empty_hash: true } }],
    ['send before creds mtime', { outboundSends: { latest_successful_send_at: '2026-05-20T12:00:04.000Z' } }],
    ['send before logged-out incident', { creds: { mtime: '2026-05-20T11:00:00.000Z' }, outboundSends: { latest_successful_send_at: '2026-05-20T11:59:59.000Z' } }],
  ])('does not clear instance_logged_out when recovery proof is incomplete: %s', async (_name, recoveryOverrides) => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
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
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeVerifiedRelinkHealth(recoveryOverrides)),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);
    expectClearAlertSourceNotCalled('remote-1', 'instance_logged_out');

    poller.stop();
  });

  it('marks alert evidence when persisted alert throttle state was unreadable', async () => {
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
      entries: new Map(),
      loadError: { file: '/redacted/fleet-alert-throttle.json', code: 'EACCES', error: 'permission denied' },
    });
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_never_reachable',
      'whatsoup@remote-1 has never answered health checks',
      expect.stringContaining('alert_throttle_load_error=true alert_throttle_load_error_code=EACCES'),
      'warning',
      undefined,
    );
    const evidence = String((alertFns.emitAlert.mock.calls as unknown as AlertMockCall[])[0]?.[3] ?? '');
    expect(evidence).not.toContain('/redacted');
    expect(evidence).not.toContain('permission denied');

    poller.stop();
  });

  it('stops marking alert evidence after the throttle file self-heals on the first successful save', async () => {
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
      entries: new Map(),
      loadError: { file: '/redacted/fleet-alert-throttle.json', code: 'EACCES', error: 'permission denied' },
    });
    // 3 failures -> unreachable alert #1, recover once, 3 failures -> alert #2.
    mockFetch
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'healthy' }) })
      .mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    // 10-minute interval so the second alert lands outside the 15-minute
    // rate-limit window of the first.
    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 10 * 60 * 1000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // fail 1
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // fail 2
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // fail 3 -> alert #1

    // Alert #1 still carries the flag: throttle suppression up to this point
    // ran without persisted state. The successful recordAlertThrottle during
    // this emission rewrites the file (self-heal).
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(1);
    expect((alertFns.emitAlert.mock.calls as unknown as AlertMockCall[])[0]?.[3]).toContain('alert_throttle_load_error=true alert_throttle_load_error_code=EACCES');
    expect(alertThrottleStore.recordAlertThrottle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // recovers -> online
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // fail 1
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // fail 2
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // fail 3 -> alert #2

    // Alert #2 must be clean: the load error no longer describes on-disk state.
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(2);
    expect((alertFns.emitAlert.mock.calls as unknown as AlertMockCall[])[1]?.[3]).not.toContain('alert_throttle_load_error');

    poller.stop();
  });

  it('keeps marking alert evidence while throttle saves continue to fail', async () => {
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
      entries: new Map(),
      loadError: { file: '/redacted/fleet-alert-throttle.json', code: 'EACCES', error: 'permission denied' },
    });
    alertThrottleStore.recordAlertThrottle.mockImplementation(() => {
      throw new Error('still unwritable');
    });
    mockFetch
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'healthy' }) })
      .mockRejectedValue(new Error('connection refused'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 10 * 60 * 1000);
    poller.start();
    for (let i = 0; i < 7; i += 1) {
      await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 10 * 60 * 1000);
    }

    // No successful save happened, so the flag must persist on every alert.
    expect(alertFns.emitAlert).toHaveBeenCalledTimes(2);
    expect((alertFns.emitAlert.mock.calls as unknown as AlertMockCall[])[0]?.[3]).toContain('alert_throttle_load_error=true alert_throttle_load_error_code=EACCES');
    expect((alertFns.emitAlert.mock.calls as unknown as AlertMockCall[])[1]?.[3]).toContain('alert_throttle_load_error=true alert_throttle_load_error_code=EACCES');

    poller.stop();
  });
});
