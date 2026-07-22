import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn((): AlertEmissionResult => ({
    ok: true,
    channel: 'outbox',
    status: 'durably_queued',
  })),
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

function durableAlertResult(): AlertEmissionResult {
  return { ok: true, channel: 'outbox', status: 'durably_queued' };
}

function failedAlertResult(): AlertEmissionResult {
  return { ok: false, channel: 'none', status: 'failed' };
}

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

function makeOnlineHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const whatsappOverrides = typeof overrides.whatsapp === 'object' && overrides.whatsapp !== null
    ? overrides.whatsapp as Record<string, unknown>
    : {};
  const connectionOverrides = typeof whatsappOverrides.connection === 'object' && whatsappOverrides.connection !== null
    ? whatsappOverrides.connection as Record<string, unknown>
    : {};
  return {
    status: 'healthy',
    generated_at: new Date().toISOString(),
    runtime: {},
    ...overrides,
    whatsapp: {
      connected: true,
      account_jid: 'redacted-account@s.whatsapp.net',
      ...whatsappOverrides,
      connection: {
        state: 'connected',
        reconnect_phase: null,
        reconnect_attempts: 0,
        auth_failure_class: 'none',
        ...connectionOverrides,
      },
    },
  };
}

function makeOperationalFallbackHealth(overrides: {
  degradationCauses?: readonly string[];
  pressureActive?: boolean;
  recoveryOutstanding?: number;
  whatsappConnected?: boolean;
  connectionState?: string;
  fallbackChainExhausted?: boolean;
  failedEntryCount?: number;
  fallbackTurnsServed?: number;
  lastFallbackTurnAt?: number | null;
  lastTurnErrorClass?: string | null;
} = {}): Record<string, unknown> {
  return {
    status: 'degraded',
    degradation_causes: overrides.degradationCauses
      ?? ['provider_fallback_active', 'primary_model_evidence_stale'],
    instance: {
      effectiveProvider: 'opencode-cli',
      fallbackReason: 'usage-limit',
      fallbackModel: 'configured/fallback',
      fallbackChainExhausted: overrides.fallbackChainExhausted ?? false,
      failedEntryCount: overrides.failedEntryCount ?? 0,
      fallbackTurnsServed: overrides.fallbackTurnsServed ?? 2,
      lastFallbackTurnAt: overrides.lastFallbackTurnAt === undefined
        ? Date.now() - 1_000
        : overrides.lastFallbackTurnAt,
    },
    turn_capability: {
      last_successful_turn_at: Date.now() - 1_000,
      last_turn_error_class: overrides.lastTurnErrorClass ?? null,
    },
    runtime: {
      agent: {
        providerExecution: { pressureActive: overrides.pressureActive ?? false },
        turnRecoveryOutstanding: overrides.recoveryOutstanding ?? 0,
      },
    },
    whatsapp: {
      connected: overrides.whatsappConnected ?? true,
      connection: { state: overrides.connectionState ?? 'connected' },
    },
  };
}

function makeDatabaseInspectionHealth(
  code: 'future_schema' | 'engine_recovery_required' = 'future_schema',
): Record<string, unknown> {
  return {
    status: 'unhealthy',
    service_mode: 'inspection_only',
    generated_at: new Date().toISOString(),
    startup_block: {
      code,
      retryable: false,
      operator_action_required: true,
    },
    instance: {
      name: 'remote-1',
      pid: 123,
      mode: 'inspection_only',
      socket_path: null,
    },
    whatsapp: {
      connected: false,
      account_jid: 'not connected',
      connection: {
        state: 'not_started',
        reconnect_phase: null,
        reconnect_attempts: 0,
        last_disconnect_reason: 'startup_schema_gate',
        last_status_code: null,
        auth_failure_class: 'none',
      },
    },
    sqlite: {
      compatibility: code,
      schema_ready: false,
      database_writes_allowed: false,
      sql_inspection_available: code === 'future_schema',
      artifact_inspection_available: true,
      schema_migration_latest: code === 'future_schema' ? 45 : null,
      schema_migration_required: 44,
    },
    admission: {
      provider_turns: 'blocked',
      synthetic_turns: 'blocked',
    },
    durability: null,
    runtime: {
      agent: { started: false, admission: 'blocked', reason: code },
    },
  };
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
    generated_at: new Date().toISOString(),
    whatsapp: {
      connected: true,
      account_jid: 'redacted-account@s.whatsapp.net',
      connection: {
        state: 'connected',
        reconnect_phase: null,
        reconnect_attempts: 0,
        auth_failure_class: 'none',
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
    runtime: {},
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

function loggedOutAssetMatcher(
  code: 'WA_AUTH_BOND_SERVER_REVOKED' | 'WEAK_LOGGED_OUT_SIGNAL',
  confidence: 'confirmed' | 'probable' = 'confirmed',
) {
  return expect.objectContaining({
    asset: expect.objectContaining({
      kind: 'whatsapp_linked_device',
      instance: 'remote-1',
      owner: 'whatsoup',
    }),
    failure: expect.objectContaining({
      code,
      domain: 'account_linkage',
      recoverability: 'manual_relink_required',
      confidence,
    }),
  });
}

function serverRevokedAssetMatcher(confidence: 'confirmed' | 'probable' = 'confirmed') {
  return loggedOutAssetMatcher('WA_AUTH_BOND_SERVER_REVOKED', confidence);
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
    alertFns.emitAlert.mockReturnValue(durableAlertResult());
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
    const selfHealth = makeOnlineHealth({ uptime_seconds: 42 });
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
    const getSelfHealth = vi.fn().mockReturnValue(makeOnlineHealth({ uptime_seconds: 1 }));
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
    const remoteHealth = makeOnlineHealth({ uptime_seconds: 100 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(remoteHealth),
    });

    const instances = makeInstances(
      ['self', makeInstance({ name: 'self' })],
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue(makeOnlineHealth());

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

  it('suppresses the duplicate health-body alert for an exactly proven operational fallback', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeOperationalFallbackHealth()),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(alertFns.emitAlert).not.toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.anything(),
    );
    expect(poller.getStatus('remote-1')?.statusEvidence).toEqual(expect.arrayContaining([
      'degradation_class=operational_fallback',
      'degradation_causes=provider_fallback_active,primary_model_evidence_stale',
      'fallback_chain_exhausted=false',
      'turn_recovery_outstanding=0',
    ]));

    poller.stop();
  });

  it('keeps the health-body alert critical when fallback has any additional degradation cause', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeOperationalFallbackHealth({
        degradationCauses: [
          'provider_fallback_active',
          'primary_model_unusable',
          'turn_recovery_degraded',
        ],
      })),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      'whatsoup@remote-1 health is degraded',
      expect.stringContaining('degradation_class=undifferentiated'),
      'critical',
      undefined,
    );
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      expect.any(String),
      expect.stringContaining('degradation_causes=provider_fallback_active,primary_model_unusable,turn_recovery_degraded'),
      'critical',
      undefined,
    );

    poller.stop();
  });

  it.each([
    ['missing cause contract', { degradationCauses: [] }],
    ['provider execution pressure', { pressureActive: true }],
    ['outstanding recovery', { recoveryOutstanding: 1 }],
    ['disconnected transport', { whatsappConnected: false }],
    ['non-connected transport state', { connectionState: 'reconnecting' }],
    ['exhausted fallback chain', { fallbackChainExhausted: true }],
    ['failed fallback entry', { failedEntryCount: 1 }],
    ['no fallback turn proof', { fallbackTurnsServed: 0 }],
    ['no fallback turn timestamp', { lastFallbackTurnAt: null }],
    ['trailing turn error', { lastTurnErrorClass: 'server-error' }],
  ] as const)('fails closed for exact-cause fallback with %s', async (_label, overrides) => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeOperationalFallbackHealth(overrides)),
    });
    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      'whatsoup@remote-1 health is degraded',
      expect.stringContaining('degradation_class=undifferentiated'),
      'critical',
      undefined,
    );

    poller.stop();
  });

  it('clears an open health-body incident when exact evidence reclassifies it as operational fallback', async () => {
    const operationalFallbackHealth = makeOperationalFallbackHealth();
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
        json: () => Promise.resolve(operationalFallbackHealth),
      });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      expect.any(String),
      expect.any(String),
      'critical',
      undefined,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(alertFns.clearAlertSource).toHaveBeenCalledWith(
      'remote-1',
      'health_body_degraded',
      expect.stringContaining('reclassified=operational_fallback'),
      undefined,
    );
    expect(poller.getStatus('remote-1')?.activeAlertSources).not.toContain('health_body_degraded');

    poller.stop();
  });

  it('retries a failed reclassification clear and stops after durable acceptance', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'degraded', reason: 'runtime_agent_at_risk' }),
    });
    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 5_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poller.getStatus('remote-1')?.activeAlertSources).toContain('health_body_degraded');

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeOperationalFallbackHealth()),
    });
    alertFns.clearAlertSource.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poller.getStatus('remote-1')?.activeAlertSources).toContain('health_body_degraded');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(2);
    expect(poller.getStatus('remote-1')?.activeAlertSources).not.toContain('health_body_degraded');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(2);

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
        json: () => Promise.resolve(makeOnlineHealth()),
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
        json: () => Promise.resolve(makeOnlineHealth()),
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
        json: () => Promise.resolve(makeOnlineHealth({ instance: { pid: 4242 } })),
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
        json: () => Promise.resolve(makeOnlineHealth()),
      })
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeOnlineHealth()),
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
        json: () => Promise.resolve(makeOnlineHealth()),
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
        json: () => Promise.resolve(makeOnlineHealth()),
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
        json: () => Promise.resolve(makeOnlineHealth()),
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
      json: () => Promise.resolve(makeOnlineHealth()),
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
        json: () => Promise.resolve(makeOnlineHealth()),
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
        json: () => Promise.resolve(makeOnlineHealth()),
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

  // Test 5: an abort before connect is a target failure unless loop lag corroborates local starvation.
  it('counts aborted-before-connect probes as target failures without local starvation evidence', async () => {
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
    expect(status!.statusReason).toBe('health_poll_failed_transient');
    expect(status!.error).toBe('The operation was aborted');
    expect(status!.consecutiveFailures).toBe(1);
    expect(status!.everReachable).toBe(false);
    expect(alertFns.emitAlert).not.toHaveBeenCalled();

    poller.stop();
  });

  it('does not infer local starvation from an aborted probe solely because a target pid is known', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeOnlineHealth({ instance: { pid: 5151 } })),
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
    expect(status!.statusReason).toBe('health_poll_failed_transient');
    expect(status!.error).toBe('The operation was aborted');
    expect(status!.consecutiveFailures).toBe(1);

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
      json: () => Promise.resolve(makeOnlineHealth()),
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
      json: () => Promise.resolve(makeOnlineHealth()),
    });

    const instances = makeInstances(
      ['self', makeInstance({ name: 'self' })],
      ['remote-a', makeInstance({ name: 'remote-a', healthPort: 9101 })],
      ['remote-b', makeInstance({ name: 'remote-b', healthPort: 9102 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue(makeOnlineHealth());
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
      json: () => Promise.resolve(makeOnlineHealth({
        whatsapp: {
          connected: true,
          account_jid: '15550001111@s.whatsapp.net',
          connection: {
            state: 'connected',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
          },
        },
      })),
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

  it('preserves explicit degraded status ahead of an ambiguous reconnect hint', async () => {
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
      statusConfidence: 'confirmed',
      statusReason: 'health_body_degraded',
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

  it('keeps disconnected backoff-zero ambiguous without explicit auth-loss proof', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeOnlineHealth({
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
      })),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'whatsapp_backoff_zero_attempts_with_disconnect_without_auth_loss_signal',
      error: null,
    });
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
      statusReason: 'health_body_unhealthy',
    });
    expectEmitAlertSourceNotCalled('remote-1', 'instance_logged_out');
  });

  it('keeps repeated parseable non-ok health bodies in degraded state instead of escalating to unreachable', async () => {
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
    const poller = new HealthPoller(
      () => instances,
      'self',
      vi.fn().mockReturnValue({}),
      1_000,
    );
    poller.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 0,
      error: null,
      everReachable: true,
      statusReason: 'health_body_unhealthy',
    });
    expectEmitAlertSourceNotCalled('remote-1', 'instance_unreachable');

    poller.stop();
  });

  it.each([
    ['future_schema', 'database_future_schema'],
    ['engine_recovery_required', 'database_engine_recovery_required'],
  ] as const)(
    'keeps repeated %s inspection-only responses reachable without counting probe failures',
    async (code, expectedReason) => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve(makeDatabaseInspectionHealth(code)),
      });
      const instances = makeInstances(
        ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
      );
      const poller = new HealthPoller(
        () => instances,
        'self',
        vi.fn().mockReturnValue({}),
        1_000,
      );

      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(poller.getStatus('remote-1')).toMatchObject({
        status: 'degraded',
        statusConfidence: 'confirmed',
        statusReason: expectedReason,
        consecutiveFailures: 0,
        everReachable: true,
        error: null,
      });
      expect(poller.getStatus('remote-1')!.statusEvidence).toEqual(expect.arrayContaining([
        'service_mode=inspection_only',
        `startup_block_code=${code}`,
        'schema_migration_required=44',
        'database_writes_allowed=false',
        'provider_turns=blocked',
        'synthetic_turns=blocked',
      ]));
      expectEmitAlertSourceNotCalled('remote-1', 'instance_unreachable');
      poller.stop();
    },
  );

  it('classifies a matching self inspection-only snapshot as a database block', async () => {
    const body = makeDatabaseInspectionHealth();
    (body.instance as Record<string, unknown>).name = 'self';
    const getSelfHealth = vi.fn().mockReturnValue(body);
    const instances = makeInstances(['self', makeInstance({ name: 'self' })]);
    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);

    await (poller as any).poll();

    expect(poller.getStatus('self')).toMatchObject({
      status: 'degraded',
      statusConfidence: 'confirmed',
      statusReason: 'database_future_schema',
      consecutiveFailures: 0,
      everReachable: true,
      error: null,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects another instance name on the self inspection-only path', async () => {
    const body = makeDatabaseInspectionHealth();
    (body.instance as Record<string, unknown>).name = 'remote-2';
    const getSelfHealth = vi.fn().mockReturnValue(body);
    const instances = makeInstances(['self', makeInstance({ name: 'self' })]);
    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);

    await (poller as any).poll();

    expect(poller.getStatus('self')).toMatchObject({
      status: 'degraded',
      statusReason: 'health_body_unhealthy',
      consecutiveFailures: 0,
      everReachable: true,
      error: null,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not grant inspection-only classification to another instance name', async () => {
    const body = makeDatabaseInspectionHealth();
    (body.instance as Record<string, unknown>).name = 'remote-2';
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve(body),
    });
    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 0,
      everReachable: true,
      error: null,
    });
    expect(poller.getStatus('remote-1')!.statusReason).not.toMatch(/^database_/);
  });

  it.each([
    [['startup_block', 'code'], 'unknown'],
    [['instance', 'name'], ''],
    [['instance', 'pid'], 0],
    [['instance', 'mode'], 'runtime'],
    [['instance', 'socket_path'], '/tmp/whatsoup.sock'],
    [['sqlite', 'compatibility'], 'engine_recovery_required'],
    [['sqlite', 'database_writes_allowed'], true],
    [['sqlite', 'sql_inspection_available'], false],
    [['sqlite', 'artifact_inspection_available'], false],
    [['sqlite', 'schema_migration_latest'], 0],
    [['sqlite', 'schema_migration_required'], 46],
    [['admission', 'provider_turns'], 'open'],
    [['admission', 'synthetic_turns'], 'open'],
    [['runtime', 'agent', 'started'], 'false'],
    [['runtime', 'agent', 'reason'], 'engine_recovery_required'],
    [['durability'], 'not-null'],
    [['whatsapp', 'account_jid'], 'present'],
  ] as const)(
    'does not grant the database inspection classification to malformed field %j',
    async (path, value) => {
      const body = makeDatabaseInspectionHealth();
      let target = body;
      for (const key of path.slice(0, -1)) {
        target = target[key] as Record<string, unknown>;
      }
      target[path.at(-1)!] = value;
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve(body),
      });
      const instances = makeInstances(
        ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
      );
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

      await (poller as any).poll();

      expect(poller.getStatus('remote-1')).toMatchObject({
        status: 'degraded',
        consecutiveFailures: 0,
        everReachable: true,
        error: null,
      });
      expect(poller.getStatus('remote-1')!.statusReason).not.toMatch(/^database_/);
    },
  );

  it('does not grant inspection-only classification over HTTP 200', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeDatabaseInspectionHealth()),
    });
    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      statusReason: 'health_body_unhealthy',
      consecutiveFailures: 0,
      everReachable: true,
    });
  });

  it('emits a debug log when readHealthBody JSON parse fails on a non-ok response', async () => {
    const parseError = new Error('Unexpected token < in JSON at position 0');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(parseError),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    // Body parse failure is a debug-level observable event — silent catch is opaque
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: parseError }),
      expect.stringContaining('readHealthBody'),
    );
    // Control flow is unchanged: null body → HTTP failure path
    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 1,
      error: 'HTTP 503',
    });
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
      json: () => Promise.resolve(makeOnlineHealth()),
    });

    const instances = makeInstances(
      ['self', makeInstance({ name: 'self' })],
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
      ['remote-2', makeInstance({ name: 'remote-2', healthPort: 9200 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue(makeOnlineHealth());

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
      json: () => Promise.resolve(makeOnlineHealth()),
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
    alertFns.emitAlert.mockReturnValue(failedAlertResult());
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
      .mockReturnValueOnce(failedAlertResult())
      .mockReturnValueOnce(durableAlertResult());
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
        json: () => Promise.resolve(makeOnlineHealth()),
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
        json: () => Promise.resolve(makeOnlineHealth({
          whatsapp: {
            connected: true,
            connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0 },
          },
        })),
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
      loggedOutAssetMatcher('WEAK_LOGGED_OUT_SIGNAL', 'probable'),
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
      loggedOutAssetMatcher('WEAK_LOGGED_OUT_SIGNAL', 'probable'),
    );
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('uptime_seconds=120'),
      'critical',
      loggedOutAssetMatcher('WEAK_LOGGED_OUT_SIGNAL', 'probable'),
    );

    poller.stop();
  });

  it('re-emits logged-out when a weak signal escalates to explicit auth loss', async () => {
    const weakHealth = {
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
    };
    const explicitHealth = {
      status: 'unhealthy',
      uptime_seconds: 125,
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
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(weakHealth) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(weakHealth) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(weakHealth) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(explicitHealth) });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('weak_signal_polls=3'),
      'critical',
      loggedOutAssetMatcher('WEAK_LOGGED_OUT_SIGNAL', 'probable'),
    );

    alertFns.emitAlert.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(poller.getStatus('remote-1')!.statusConfidence).toBe('confirmed');
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('last_status_code=401'),
      'critical',
      serverRevokedAssetMatcher(),
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
        json: () => Promise.resolve(makeOnlineHealth({
          whatsapp: {
            connected: true,
            connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0 },
          },
        })),
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
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeOnlineHealth()) })
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
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeOnlineHealth()) })
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

  // ── NEW: branch-coverage extensions ───────────────────────────────────────

  // Branch: loadAlertThrottleDetailed returns loadError without a code field.
  // The constructor should fall back to 'UNKNOWN' as the error code.
  it('uses UNKNOWN error code when throttle loadError has no code field', async () => {
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
      entries: new Map(),
      loadError: { file: '/some/file.json', error: 'unexpected format' },
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
      expect.any(String),
      expect.stringContaining('alert_throttle_load_error_code=UNKNOWN'),
      'warning',
      undefined,
    );

    poller.stop();
  });

  // Branch: lastAlertAtFor picks the most-recent entry among multiple throttle keys
  // for the same instance when no existing status is in-memory yet.
  it('lastAlertAtFor returns the most recent entry among multiple persisted throttle keys', async () => {
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
      entries: new Map([
        ['remote-1:instance_degraded', '2026-05-20T11:50:00.000Z'],
        ['remote-1:instance_unreachable', '2026-05-20T11:58:00.000Z'],
        ['remote-1:health_body_degraded', '2026-05-20T11:45:00.000Z'],
      ]),
      loadError: null,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeOnlineHealth()),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // The most recent entry across all keys is instance_unreachable at 11:58:00
    expect(poller.getStatus('remote-1')!.lastAlertAt).toBe('2026-05-20T11:58:00.000Z');

    poller.stop();
  });

  // Branch: loggedOutHeuristic but no disconnectedCorroboration and no explicitAuthLossSignal
  // (backoff+zero attempts, but still says connected=true WITHOUT the 'present' account_jid check)
  it('classifies backoff-zero-attempts as ambiguous-degraded when no disconnect corroboration', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'healthy',
        whatsapp: {
          connected: true,
          // no account_jid → accountJidStatus = 'missing', but staleReconnectHint requires all 3
          connection: {
            state: 'connecting',
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
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
      statusReason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
      error: null,
    });
    expectEmitAlertSourceNotCalled('remote-1', 'instance_logged_out');
  });

  it('fails closed when the health status field has the wrong type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 42, // non-string
        whatsapp: {
          connected: true,
          account_jid: '15550001111@s.whatsapp.net',
          connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0 },
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
      statusReason: 'health_body_type_error',
      error: null,
    });
  });

  // Branch: HTTP 200, classifyHealthSnapshot returns logged_out (explicit whatsapp fields)
  // but classifyLoggedOutSignal returns loggedOut=false.
  // This exercises the `classification.status === 'logged_out'` branch on line 419.
  it('routes to updateFromHealthSnapshot when classifyHealthSnapshot returns logged_out', async () => {
    // classifyHealthSnapshot returns 'logged_out' when loggedOutHeuristic AND disconnectedCorroboration AND explicitAuthLossSignal
    // but classifyLoggedOutSignal does NOT return loggedOut=true (auth_failure_class not in TERMINAL set)
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
            last_disconnect_reason: 'loggedOut', // triggers explicitAuthLossSignal
            last_status_code: 401,               // also triggers explicitAuthLossSignal
            auth_failure_class: '',              // NOT in TERMINAL_AUTH_FAILURE_CLASSES
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
    // classifyLoggedOutSignal triggers (last_status_code=401), so status is logged_out via that path
    expect(status).toMatchObject({
      status: 'logged_out',
      error: null,
    });
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      'whatsoup@remote-1 appears logged out',
      expect.stringContaining('last_status_code=401'),
      'critical',
      serverRevokedAssetMatcher(),
    );
  });

  // Branch: HTTP 200, non-'unhealthy'/'degraded' healthStatus string but classifyHealthSnapshot
  // returns 'degraded' (loggedOutHeuristic path). Exercises line 445.
  it('routes to updateFromHealthSnapshot for degraded classification when healthStatus is not unhealthy/degraded', async () => {
    // classifyHealthSnapshot returns 'degraded' with ambiguous confidence when
    // loggedOutHeuristic is true but no disconnectedCorroboration
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'healthy', // not 'unhealthy' or 'degraded'
        whatsapp: {
          connected: false, // connected=false → staleReconnectHint=false
          connection: {
            state: 'connecting', // not 'disconnected' → no disconnectedCorroboration
            reconnect_phase: 'backoff',
            reconnect_attempts: 0,
            // no auth_failure_class, no last_status_code, no last_disconnect_reason
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
    // loggedOutHeuristic=true, disconnectedCorroboration=false (state='connecting', connected=false
    // but healthStatus='healthy' not 'unhealthy'), explicitAuthLossSignal=false
    // → reaches loggedOutHeuristic branch → 'degraded' confidence='ambiguous'
    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      error: null,
    });
  });

  // Branch: updateDegraded - prevStatus='unreachable', newStatus='degraded'.
  // Exercises line 953: `newStatus !== 'logged_out' && prevStatus === 'unreachable'`.
  it('clears unreachable alert when instance transitions from unreachable to degraded', async () => {
    // Use a large interval so dwell advance does not trigger extra polls.
    let phase: 'healthy' | 'failing' | 'degraded' = 'healthy';
    mockFetch.mockImplementation(async () => {
      if (phase === 'failing') throw new Error('connection refused');
      if (phase === 'degraded') {
        return {
          ok: true,
          json: () => Promise.resolve({
            status: 'degraded',
            whatsapp: { connected: true, connection: { state: null } },
          }),
        };
      }
      return { ok: true, json: () => Promise.resolve(makeOnlineHealth()) };
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // healthy

    phase = 'failing';
    await vi.advanceTimersByTimeAsync(1_000); // fail 1
    await vi.advanceTimersByTimeAsync(1_000); // fail 2
    await vi.advanceTimersByTimeAsync(1_000); // fail 3 → unreachable

    expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
    expect(poller.getStatus('remote-1')!.everReachable).toBe(true);

    // Keep failing so dwell accumulates (30s advance + 30 extra fail polls)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(alertFns.emitAlert).toHaveBeenCalledWith(
      'remote-1',
      'instance_unreachable',
      expect.any(String),
      expect.any(String),
      'critical',
      undefined,
    );

    // Now instance returns degraded body → transitions unreachable → degraded
    phase = 'degraded';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('degraded');
    // clearRecoveredAlert should be called for unreachable sources
    expectClearAlertSourceCalled('remote-1', 'instance_unreachable');

    poller.stop();
  });

  // Branch: clearAlertSourceChecked returns false → source is retained in activeAlertSources.
  it('retains active alert source when clearAlertSourceChecked returns false', async () => {
    alertFns.clearAlertSource.mockReturnValue(false);

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
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.status).toBe('online');
    // clearAlertSourceChecked returned false → source is retained
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);

    poller.stop();
  });

  // Branch: clearAlertSourceChecked throws → source is retained in activeAlertSources and warn logged.
  it('logs warning and retains source when clearAlertSourceChecked throws', async () => {
    const clearError = new Error('alert service unavailable');
    alertFns.clearAlertSource.mockImplementationOnce(() => { throw clearError; });

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
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: clearError, name: 'remote-1', source: 'instance_logged_out' }),
      'failed to emit alert clear',
    );

    poller.stop();
  });

  // Branch: hasVerifiedRelinkRecovery - no whatsapp field in health.
  it('hasVerifiedRelinkRecovery returns false when health has no whatsapp field', async () => {
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
          // no whatsapp field at all
        }),
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
    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_incomplete',
    });
    // No whatsapp → malformed recovery cannot clear the logged-out alert.
    expect(poller.getStatus('remote-1')!.activeAlertSources).toContain('instance_logged_out');
    expectClearAlertSourceNotCalled('remote-1', 'instance_logged_out');

    poller.stop();
  });

  // Branch: hasVerifiedRelinkRecovery - whatsapp present but connected !== true.
  it('hasVerifiedRelinkRecovery returns false when whatsapp.connected is false', async () => {
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
        json: () => Promise.resolve(makeVerifiedRelinkHealth({
          whatsapp: { connected: false },
        })),
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
    // connected=false is not explicit online evidence and cannot clear the alert.
    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_incomplete',
    });
    expect(poller.getStatus('remote-1')!.activeAlertSources).toContain('instance_logged_out');
    expectClearAlertSourceNotCalled('remote-1', 'instance_logged_out');

    poller.stop();
  });

  // Branch: hasVerifiedRelinkRecovery - connection.state !== 'connected'.
  it('hasVerifiedRelinkRecovery returns false when connection.state is not connected', async () => {
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
        json: () => Promise.resolve(makeVerifiedRelinkHealth({
          connection: { state: 'reconnecting' },
        })),
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
    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_incomplete',
    });
    expect(poller.getStatus('remote-1')!.activeAlertSources).toContain('instance_logged_out');
    expectClearAlertSourceNotCalled('remote-1', 'instance_logged_out');

    poller.stop();
  });

  // Branch: hasVerifiedRelinkRecovery - authBond missing entirely.
  it('hasVerifiedRelinkRecovery returns false when auth_bond is absent', async () => {
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
        json: () => Promise.resolve(makeOnlineHealth({
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            // no auth_bond field
          },
          outbound_sends: { latest_successful_send_at: '2026-05-20T12:00:10.000Z' },
        })),
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

  // Branch: hasVerifiedRelinkRecovery - authBond.status !== 'present'.
  it('hasVerifiedRelinkRecovery returns false when auth_bond.status is not present', async () => {
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
        json: () => Promise.resolve(makeVerifiedRelinkHealth({
          authBond: { status: 'missing' },
        })),
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

  // Branch: hasVerifiedRelinkRecovery - creds.exists !== true.
  it('hasVerifiedRelinkRecovery returns false when creds.exists is false', async () => {
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
        json: () => Promise.resolve(makeVerifiedRelinkHealth({
          creds: { exists: false, size: 512 },
        })),
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

  // Branch: hasVerifiedRelinkRecovery - creds.empty_hash is not false, hash is present and non-empty
  // but hash starts with EMPTY_SHA256 prefix → rejected.
  it('hasVerifiedRelinkRecovery returns false when creds hash prefix matches empty-sha256', async () => {
    const emptyHashPrefix = 'e3b0c44298fc1c149af'; // first 19 chars of EMPTY_SHA256
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
        json: () => Promise.resolve(makeVerifiedRelinkHealth({
          creds: {
            exists: true,
            size: 512,
            mtime: '2026-05-20T12:00:05.000Z',
            hash: emptyHashPrefix,
            empty_hash: undefined, // not false → triggers the hash check
          },
        })),
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

  // Branch: hasVerifiedRelinkRecovery - creds mtime is null (not a valid timestamp string).
  it('hasVerifiedRelinkRecovery returns false when creds.mtime is not a valid timestamp', async () => {
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
        json: () => Promise.resolve(makeVerifiedRelinkHealth({
          creds: {
            exists: true,
            size: 512,
            mtime: null, // not a string → readTimestampMs returns null
            hash: 'a'.repeat(20),
            empty_hash: false,
          },
        })),
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

  // Branch: hasVerifiedRelinkRecovery - latest_successful_send_at is null.
  it('hasVerifiedRelinkRecovery returns false when outbound send timestamp is absent', async () => {
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
        json: () => Promise.resolve(makeVerifiedRelinkHealth({
          outboundSends: { latest_successful_send_at: null },
        })),
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

  // Branch: readTimestampMs - space-delimited date format (normalized to ISO with T+Z).
  it('clears instance_logged_out when creds mtime uses space-delimited timestamp format', async () => {
    // 2026-05-20 12:00:05 space-delimited → normalized to 2026-05-20T12:00:05Z
    // Send is at 12:00:10, so send > creds mtime → recovery verified
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
        json: () => Promise.resolve(makeVerifiedRelinkHealth({
          creds: {
            exists: true,
            size: 512,
            mtime: '2026-05-20 12:00:05', // space-delimited, no Z suffix
            hash: 'a'.repeat(20),
            empty_hash: false,
          },
        })),
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
    // Space-delimited mtime parsed correctly → recovery verified → alert cleared
    expect(alertFns.clearAlertSource).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      expect.stringContaining('clear_code=WA_AUTH_BOND_RELINK_VERIFIED'),
      relinkVerifiedAssetMatcher(),
    );
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual([]);

    poller.stop();
  });

  // Branch: HTTP 403 response → health_probe_auth_failed (same path as 401).
  it('classifies HTTP 403 as health probe auth failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'forbidden' }),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100, healthToken: 'bad-token' })],
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
      'health_probe_auth_failed http_status=403 health_port=9100',
      'critical',
      undefined,
    );

    poller.stop();
  });

  // Branch: non-ok response without parseable body AND auth-loss evidence.
  // readHealthBody returns null (JSON parse fails) → falls through to updateFailure.
  it('treats non-ok response with null body as generic HTTP failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await (poller as any).poll();

    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 1,
      error: 'HTTP 500',
    });
  });

  // Branch: non-ok response with parseable body that classifies as non-online but not logged-out.
  // Exercises the `isNonOnlineClassification` path within the non-ok response handler.
  it('routes non-ok response with parseable non-logged-out body to updateFromHealthSnapshot', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({
        status: 'unhealthy', // healthStatus=unhealthy but no backoff/auth_failure signals
        whatsapp: {
          connected: false,
          account_jid: 'not connected',
          connection: {
            state: 'disconnected',
            reconnect_phase: 'active', // NOT 'backoff' → loggedOutHeuristic=false
            reconnect_attempts: 5,
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
    // classifyHealthSnapshot: unhealthy status → 'degraded' confidence='confirmed'
    // classifyLoggedOutSignal: not explicit, not connected, not backoff+0 → loggedOut=false
    // → goes to isNonOnlineClassification branch → updateFromHealthSnapshot
    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'confirmed',
      statusReason: 'health_body_unhealthy',
      consecutiveFailures: 0,
      error: null,
    });
    expectEmitAlertSourceNotCalled('remote-1', 'instance_logged_out');
  });

  // Branch: self-instance getSelfHealth throws → updateFailure called.
  it('self-instance poll failure is handled gracefully when getSelfHealth throws', async () => {
    const selfError = new Error('health callback crashed');
    const getSelfHealth = vi.fn().mockImplementation(() => { throw selfError; });
    const instances = makeInstances(['self', makeInstance({ name: 'self' })]);

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const status = poller.getStatus('self');
    expect(status).toBeDefined();
    expect(status!.status).toBe('degraded');
    expect(status!.consecutiveFailures).toBe(1);
    expect(status!.error).toBe('health callback crashed');
    expect(mockFetch).not.toHaveBeenCalled();

    poller.stop();
  });

  // Branch: readTimestampMs with an invalid (non-parseable) string → returns null.
  // Uses camelCase outboundSends to exercise the readLatestSuccessfulSendAt camelCase fallback.
  it('hasVerifiedRelinkRecovery handles camelCase outboundSends field', async () => {
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
        json: () => Promise.resolve(makeOnlineHealth({
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              creds: {
                exists: true,
                size: 512,
                mtime: '2026-05-20T12:00:05.000Z',
                hash: 'a'.repeat(20),
                empty_hash: false,
              },
            },
          },
          outboundSends: { // camelCase variant
            latestSuccessfulSendAt: '2026-05-20T12:00:10.000Z',
          },
        })),
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
    // camelCase field should be recognized → recovery verified → alert cleared
    expect(alertFns.clearAlertSource).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      expect.stringContaining('clear_code=WA_AUTH_BOND_RELINK_VERIFIED'),
      relinkVerifiedAssetMatcher(),
    );

    poller.stop();
  });

  // Branch: stop() called when pollInterval is null (already stopped or never started).
  it('stop() is safe when polling was never started', () => {
    const poller = new HealthPoller(
      () => new Map(),
      'self',
      vi.fn().mockReturnValue({}),
    );
    // Should not throw even though pollInterval is null
    expect(() => poller.stop()).not.toThrow();
  });

  // Branch: on() called with an event other than 'statusChange' is a no-op (defensive guard).
  it('on() ignores unrecognized event types without error', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});
    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    const cb = vi.fn();

    // TypeScript guard: cast to any to test the JS guard inside on()
    (poller as any).on('unknownEvent', cb);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // The unknown-event listener was NOT registered; only real statusChange listeners fire
    expect(cb).not.toHaveBeenCalled();

    poller.stop();
  });

  // Branch: lastAlertAtFor - existing.lastAlertAt is set (early-return path).
  it('lastAlertAtFor returns in-memory lastAlertAt when already set on existing status', async () => {
    // First poll: goes unreachable and fires an alert (sets lastAlertAt)
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

    const statusAfterAlert = poller.getStatus('remote-1')!;
    expect(statusAfterAlert.lastAlertAt).toBe('2026-05-20T12:00:02.000Z');

    // Fourth poll: still failing — existing.lastAlertAt is already set, takes early return
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getStatus('remote-1')!.lastAlertAt).toBe('2026-05-20T12:00:02.000Z');

    poller.stop();
  });
});

describe('health-poller.ts uncovered-branch coverage', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
    alertFns.emitAlert.mockReset();
    alertFns.emitAlert.mockReturnValue(durableAlertResult());
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
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Branch: lastAlertAtFor — persisted throttle entry whose key does NOT start
  // with the instance-name prefix must be skipped during the scan, while a
  // matching prefixed entry is still selected (line 309 true branch / continue).
  it('lastAlertAtFor skips non-matching persisted throttle keys and selects the latest matching one', async () => {
    const matching = '2026-05-20T11:55:00.000Z';
    const olderMatching = '2026-05-20T11:40:00.000Z';
    alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
      entries: new Map<string, string>([
        ['other-instance:instance_unreachable', '2026-05-20T11:59:00.000Z'],
        ['remote-1:instance_logged_out', olderMatching],
        ['remote-1:instance_unreachable', matching],
      ]),
      loadError: null,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeOnlineHealth()),
    });

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // The latest of the two remote-1 prefixed entries wins; the unrelated key
    // is skipped despite being the newest overall.
    expect(poller.getStatus('remote-1')!.lastAlertAt).toBe(matching);

    poller.stop();
  });

  // Branch: trackTargetPid → readNumber parses a numeric STRING pid (line 744
  // true branch) without changing an uncorroborated abort into local starvation.
  it('trackTargetPid accepts a numeric-string pid without misclassifying a target failure', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeOnlineHealth({ instance: { pid: '4242' } })),
      })
      .mockRejectedValueOnce(new Error('The operation was aborted'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // first poll seeds pid
    await vi.advanceTimersByTimeAsync(5_000); // second poll aborts without corroborating loop lag

    const status = poller.getStatus('remote-1')!;
    expect(status.status).toBe('degraded');
    expect(status.statusReason).toBe('health_poll_failed_transient');
    expect(status.error).toBe('The operation was aborted');
    expect(status.consecutiveFailures).toBe(1);

    poller.stop();
  });

  // A repeated target failure does not emit another statusChange when the
  // previous status was already degraded.
  it('an uncorroborated repeated abort skips statusChange emission when already degraded', async () => {
    mockFetch.mockRejectedValue(new Error('The operation was aborted'));

    const instances = makeInstances(
      ['remote-1', makeInstance({ name: 'remote-1', healthPort: 9100 })],
    );
    const getSelfHealth = vi.fn().mockReturnValue({});

    const poller = new HealthPoller(() => instances, 'self', getSelfHealth, 1_000);
    const changes: Array<{ name: string; next: string; prev: string }> = [];
    poller.on('statusChange', (name, next, prev) => changes.push({ name, next, prev }));
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // first abort → degraded (transition online→degraded)

    expect(changes).toEqual([{ name: 'remote-1', next: 'degraded', prev: 'online' }]);

    await vi.advanceTimersByTimeAsync(1_000); // second abort → still degraded (no transition)
    expect(changes).toEqual([{ name: 'remote-1', next: 'degraded', prev: 'online' }]);
    expect(poller.getStatus('remote-1')!.status).toBe('degraded');

    poller.stop();
  });

  // Branches: appendLifecycleEvidence (recentEvents) + appendAuthBondEvidence
  // (backup snake/camel fallbacks, issues, auth_dir) reached through the
  // logged-out evidence path. Asserts concrete redacted evidence substrings.
  it('logged-out evidence includes credential_lifecycle events and full auth_bond backup fields', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'unhealthy',
        uptime_seconds: 9999,
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
          credential_lifecycle: {
            latestBaileysVersion: '6.7.0',
            connectStartedAt: '2026-05-20T10:00:00.000Z',
            lastOpenAt: '2026-05-20T10:00:01.000Z',
            lastCloseAt: '2026-05-20T11:00:00.000Z',
            lastQrAt: '2026-05-20T10:05:00.000Z',
            lastCredsUpdateAt: '2026-05-20T10:10:00.000Z',
            lastCredsUpdateFailedAt: '2026-05-20T11:30:00.000Z',
            lastAuthSnapshotAt: '2026-05-20T10:15:00.000Z',
            lastAuthSnapshotFailedAt: '2026-05-20T11:45:00.000Z',
            credsUpdateCount: 7,
            authSnapshotCaptureCount: 3,
            authSnapshotFailureCount: 1,
            environment: {
              host: 'worker-1',
              pid: 1234,
              nodeVersion: 'v24.15.0',
              platform: 'linux',
              arch: 'x64',
              processUptimeSeconds: 600,
              osUptimeSeconds: 86400,
              memory: { freeBytes: 1024, totalBytes: 4096 },
            },
            lastDisconnectDiagnostic: {
              statusCode: 401,
              reason: 'loggedOut',
              message: 'session revoked',
            },
            recentEvents: [
              { event: 'connection.update', at: '2026-05-20T11:50:00.000Z' },
              { event: 'creds.update', at: '2026-05-20T11:55:00.000Z', statusCode: 200, reason: 'ok' },
              'not-a-record',
            ],
          },
          auth_bond: {
            status: 'revoked',
            issues: ['creds_missing', 'session_revoked'],
            tree_hash: 'abcdef',
            auth_dir: { exists: false, mode: 0o755, mtime: '2026-05-20T09:00:00.000Z' },
            creds: {
              exists: false,
              mode: 0o600,
              size: 0,
              mtime: '2026-05-20T09:30:00.000Z',
              hash: 'deadbeef',
              identityHash: 'idhash123',
              empty_hash: true,
              tree_hash: 'abcdef',
            },
            backup: {
              latest: 'snap-2026-05-20',
              latest_at: '2026-05-20T09:00:00.000Z',
              latest_reason: 'scheduled',
              latest_tree_hash: 'snap-tree',
              last_capture_at: '2026-05-20T09:00:00.000Z',
              last_capture_reason: 'scheduled',
              last_capture_error: 'none',
              last_capture_deferred_at: '2026-05-20T09:05:00.000Z',
              last_capture_deferred_reason: 'cooldown',
              last_capture_deferred_age_ms: 5000,
              last_restore_at: '2026-05-19T09:00:00.000Z',
              last_restore_source: 'manual-restore',
              last_restore_error: 'none',
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

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');

    const emitCall = (alertFns.emitAlert.mock.calls as unknown as Array<[string, string, string, string, ...unknown[]]>)
      .find(([_, source]) => source === 'instance_logged_out');
    expect(emitCall).toBeDefined();
    const evidence = emitCall![3];

    // credential_lifecycle recentEvents evidence
    expect(evidence).toContain('credential_lifecycle_event_count=3');
    expect(evidence).toContain('credential_lifecycle_events=connection.update,creds.update');
    expect(evidence).toContain('credential_lifecycle_last_event=creds.update');
    expect(evidence).toContain('baileys_version=6.7.0');
    expect(evidence).toContain('lifecycle_host=worker-1');
    expect(evidence).toContain('lifecycle_node_version=v24.15.0');
    expect(evidence).toContain('lifecycle_memory_free_bytes=1024');
    expect(evidence).toContain('lifecycle_disconnect_status_code=401');

    // auth_bond issues + auth_dir + creds + backup evidence
    expect(evidence).toContain('auth_bond_status=revoked');
    expect(evidence).toContain('auth_bond_issues=creds_missing,session_revoked');
    expect(evidence).toContain('auth_bond_auth_dir_exists=false');
    expect(evidence).toContain('auth_bond_auth_dir_mode=493'); // 0o755 decimal
    expect(evidence).toContain('auth_bond_creds_hash=deadbeef');
    expect(evidence).toContain('auth_bond_identity_hash=idhash123');
    expect(evidence).toContain('auth_bond_creds_empty_hash=true');
    expect(evidence).toContain('auth_bond_tree_hash=abcdef');

    // backup evidence
    expect(evidence).toContain('auth_bond_backup_latest_present=true');
    expect(evidence).toContain('auth_bond_backup_latest_at=2026-05-20T09:00:00.000Z');
    expect(evidence).toContain('auth_bond_backup_latest_tree_hash=snap-tree');
    expect(evidence).toContain('auth_bond_backup_last_capture_deferred_age_ms=5000');
    expect(evidence).toContain('auth_bond_backup_last_restore_source_present=true');
    expect(evidence).toContain('auth_bond_backup_last_restore_error=none');

    poller.stop();
  });

  // Branch: appendAuthBondEvidence backup camelCase key fallbacks (the
  // `?? backup['latestAt']` etc. paths) and an empty/missing latest backup.
  it('auth_bond backup evidence falls back to camelCase keys and flags missing latest', async () => {
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
          auth_bond: {
            status: 'revoked',
            backup: {
              latest: '',
              latestAt: '2026-05-20T08:00:00.000Z',
              latestReason: 'manual',
              latestTreeHash: 'camel-tree',
              lastCaptureAt: '2026-05-20T08:01:00.000Z',
              lastCaptureReason: 'manual',
              lastCaptureError: 'oops',
              lastCaptureDeferredAt: '2026-05-20T08:02:00.000Z',
              lastCaptureDeferredReason: 'busy',
              lastCaptureDeferredAgeMs: 1234,
              lastRestoreAt: '2026-05-19T08:00:00.000Z',
              lastRestoreSource: '',
              lastRestoreError: 'fail',
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

    expect(poller.getStatus('remote-1')!.status).toBe('logged_out');

    const emitCall = (alertFns.emitAlert.mock.calls as unknown as Array<[string, string, string, string, ...unknown[]]>)
      .find(([_, source]) => source === 'instance_logged_out');
    expect(emitCall).toBeDefined();
    const evidence = emitCall![3];

    // camelCase fallbacks picked up
    expect(evidence).toContain('auth_bond_backup_latest_present=false'); // latest === '' → present=false
    expect(evidence).toContain('auth_bond_backup_latest_at=2026-05-20T08:00:00.000Z');
    expect(evidence).toContain('auth_bond_backup_latest_reason=manual');
    expect(evidence).toContain('auth_bond_backup_latest_tree_hash=camel-tree');
    expect(evidence).toContain('auth_bond_backup_last_capture_at=2026-05-20T08:01:00.000Z');
    expect(evidence).toContain('auth_bond_backup_last_capture_reason=manual');
    expect(evidence).toContain('auth_bond_backup_last_capture_error=oops');
    expect(evidence).toContain('auth_bond_backup_last_capture_deferred_at=2026-05-20T08:02:00.000Z');
    expect(evidence).toContain('auth_bond_backup_last_capture_deferred_reason=busy');
    expect(evidence).toContain('auth_bond_backup_last_capture_deferred_age_ms=1234');
    expect(evidence).toContain('auth_bond_backup_last_restore_at=2026-05-19T08:00:00.000Z');
    expect(evidence).toContain('auth_bond_backup_last_restore_source_present=false'); // empty string
    expect(evidence).toContain('auth_bond_backup_last_restore_error=fail');

    poller.stop();
  });

  // Branches: appendLifecycleEvidence recentEvents with no string event names
  // (line 642 false branch — `names.length === 0`, no credential_lifecycle_events
  // emitted but count still recorded) and appendAuthBondEvidence issues that all
  // redact away (line 659 false branch — no auth_bond_issues emitted). Also
  // exercises non-finite number redaction (formatEvidenceValue, line 704 false).
  it('omits credential_lifecycle_events and auth_bond_issues when all entries are non-string', async () => {
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
          credential_lifecycle: {
            recentEvents: [
              { event: 12345, at: '2026-05-20T11:50:00.000Z' },
              { event: null, at: '2026-05-20T11:51:00.000Z' },
            ],
          },
          auth_bond: {
            status: 'revoked',
            issues: [null, { nested: 'object' }],
            creds: { mtime: '2026-05-20T09:30:00.000Z' },
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

    const emitCall = (alertFns.emitAlert.mock.calls as unknown as Array<[string, string, string, string, ...unknown[]]>)
      .find(([_, source]) => source === 'instance_logged_out');
    expect(emitCall).toBeDefined();
    const evidence = emitCall![3];

    // Event count is still recorded, but the names list (all non-string) is empty
    // so the credential_lifecycle_events=… substring is NOT emitted.
    expect(evidence).toContain('credential_lifecycle_event_count=2');
    expect(evidence).not.toMatch(/credential_lifecycle_events=/);

    // auth_bond_status still emitted, but issues (all non-string/null) produce
    // no auth_bond_issues=… entry.
    expect(evidence).toContain('auth_bond_status=revoked');
    expect(evidence).not.toMatch(/auth_bond_issues=/);

    poller.stop();
  });
});
