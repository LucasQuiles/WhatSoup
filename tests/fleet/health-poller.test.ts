import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';

const emitAlert = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const alertThrottleStore = vi.hoisted(() => ({
  loadAlertThrottle: vi.fn(() => new Map<string, string>()),
  recordAlertThrottle: vi.fn(),
}));
const silenceManager = vi.hoisted(() => ({
  isInstanceSilenced: vi.fn(() => false),
}));

vi.mock('../../src/lib/emit-alert.ts', () => ({ emitAlert }));

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

describe('HealthPoller', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
    emitAlert.mockClear();
    alertThrottleStore.loadAlertThrottle.mockReset();
    alertThrottleStore.loadAlertThrottle.mockReturnValue(new Map());
    alertThrottleStore.recordAlertThrottle.mockClear();
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
    expect(poller.getStatus('remote-1')!.error).toBeNull();

    poller.stop();
  });

  // Test 5: fetch timeout produces 'degraded' status
  it('fetch timeout produces degraded status', async () => {
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
    alertThrottleStore.loadAlertThrottle.mockReturnValue(new Map([['remote-1', lastAlertAt]]));
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
      'remote-1',
      '2026-05-20T12:00:02.000Z',
    );
    expect(emitAlert).toHaveBeenCalledOnce();

    poller.stop();
  });

  it('suppresses restart-cycle alerts using persisted lastAlertAt', async () => {
    alertThrottleStore.loadAlertThrottle.mockReturnValue(new Map([
      ['remote-1', '2026-05-20T11:55:00.000Z'],
    ]));
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

    expect(emitAlert).not.toHaveBeenCalled();
    expect(alertThrottleStore.recordAlertThrottle).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'remote-1',
        source: 'instance_unreachable',
      }),
      'alert suppressed — rate limit (15min)',
    );

    poller.stop();
  });
});
