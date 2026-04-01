import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';

// Suppress pino output during tests
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
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
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
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
});
