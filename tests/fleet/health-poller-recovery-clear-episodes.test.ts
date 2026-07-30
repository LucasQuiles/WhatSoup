import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  loadAlertThrottleDetailed: vi.fn(() => ({ entries: new Map<string, string>(), loadError: null })),
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

const POLL_MS = 1_000;
const WITHHELD_MSG = 'recovered alert clear withheld until recovery proof is complete';
const EPISODE_END_MSG = 'recovery-clear withholding episode ended';

function infoCallsWith(message: string): unknown[][] {
  return logger.info.mock.calls.filter((call) => call[1] === message);
}

function soleInfoFields(message: string): Record<string, unknown> {
  const calls = infoCallsWith(message);
  expect(calls).toHaveLength(1);
  return calls[0][0] as Record<string, unknown>;
}

function makeInstance(overrides: Partial<InstanceHealth> = {}): InstanceHealth {
  return {
    name: 'remote-1',
    type: 'chat',
    accessMode: 'open',
    healthPort: 9100,
    dbPath: '/tmp/whatsoup-recovery-clear-episodes.db',
    healthToken: null,
    ...overrides,
  };
}

function loggedOutHealth(): Record<string, unknown> {
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

function relinkHealth(overrides: {
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
      account_jid: 'private-account@s.whatsapp.net',
      connection: {
        state: 'connected',
        reconnect_phase: null,
        reconnect_attempts: 0,
        auth_failure_class: 'none',
        ...overrides.connection,
      },
      auth_bond: {
        status: 'present',
        creds: {
          exists: true,
          size: 512,
          mtime: '2026-05-20T12:00:05.000Z',
          hash: 'a'.repeat(20),
          empty_hash: false,
          ...overrides.creds,
        },
        ...overrides.authBond,
      },
      ...overrides.whatsapp,
    },
    outbound_sends: {
      latest_successful_send_at: '2026-05-20T12:00:10.000Z',
      ...overrides.outboundSends,
    },
    runtime: {},
  };
}

function incompleteRelinkHealth(overrides: {
  authBond?: Record<string, unknown>;
  creds?: Record<string, unknown>;
  connection?: Record<string, unknown>;
  outboundSends?: Record<string, unknown>;
  whatsapp?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return relinkHealth({
    outboundSends: { latest_successful_send_at: null },
    ...overrides,
  });
}

const reachableIncompleteProofCases: ReadonlyArray<[
  string,
  Parameters<typeof relinkHealth>[0],
  string,
]> = [
  ['missing auth bond', { whatsapp: { auth_bond: null } }, 'auth_bond_missing'],
  ['zero-byte credentials', { creds: { size: 0 } }, 'credentials_empty'],
  ['missing credential timestamp', { creds: { mtime: null } }, 'credentials_mtime_unavailable'],
  ['missing post-bond send', { outboundSends: { latest_successful_send_at: null } }, 'post_bond_send_missing'],
  ['post-bond send before credentials', {
    outboundSends: { latest_successful_send_at: '2026-05-20T12:00:04.000Z' },
  }, 'post_bond_send_before_credentials'],
  ['post-bond send before incident', {
    creds: { mtime: '2026-05-20T11:00:00.000Z' },
    outboundSends: { latest_successful_send_at: '2026-05-20T11:59:59.000Z' },
  }, 'post_bond_send_before_incident'],
];

describe('#2392 recovery-clear withholding episodes', () => {
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

  it('logs one recovery-clear diagnostic across 180 identical incomplete-proof polls', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementation(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }));

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'logged_out',
      activeAlertSources: ['instance_logged_out'],
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'online',
      activeAlertSources: ['instance_logged_out'],
    });
    expect(infoCallsWith(WITHHELD_MSG)).toHaveLength(1);
    for (let i = 1; i < 180; i += 1) await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(infoCallsWith(WITHHELD_MSG)).toHaveLength(1);
    expect(alertFns.clearAlertSource).not.toHaveBeenCalled();

    const entry = soleInfoFields(WITHHELD_MSG);
    expect(Object.keys(entry).sort()).toEqual(['name', 'recoveryProofReason', 'source']);
    expect(JSON.stringify(entry)).not.toContain('private-account');

    poller.stop();
    const summary = soleInfoFields(EPISODE_END_MSG);
    expect(summary).toMatchObject({
      name: 'remote-1',
      source: 'instance_logged_out',
      recoveryProofReason: 'post_bond_send_missing',
      withheldObservations: 180,
    });
    expect(Object.keys(summary).sort()).toEqual([
      'episodeDurationMs',
      'name',
      'recoveryProofReason',
      'source',
      'withheldObservations',
    ]);
    expect(JSON.stringify(summary)).not.toContain('private-account');
  });

  it.each(reachableIncompleteProofCases)(
    'keeps the source fail-closed and reports only the bounded reason for %s',
    async (_caseName, overrides, expectedReason) => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
        .mockImplementation(() => Promise.resolve({
          ok: true,
          json: () => Promise.resolve(relinkHealth(overrides)),
        }));

      const instances = new Map([['remote-1', makeInstance()]]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(POLL_MS);

      expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);
      expect(alertFns.clearAlertSource).not.toHaveBeenCalled();
      expect(soleInfoFields(WITHHELD_MSG)).toMatchObject({ recoveryProofReason: expectedReason });

      poller.stop();
    },
  );

  it('closes the prior episode and opens a new one when the missing proof changes', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth({ creds: { size: 0 } })),
      }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth({ creds: { size: 0 } })),
      }))
      .mockImplementation(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }));

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);

    expect(infoCallsWith(WITHHELD_MSG)).toHaveLength(2);
    expect(infoCallsWith(EPISODE_END_MSG).map((call) => call[0])).toContainEqual(expect.objectContaining({
      recoveryProofReason: 'credentials_empty',
      withheldObservations: 2,
    }));

    poller.stop();
    expect(infoCallsWith(EPISODE_END_MSG).map((call) => call[0])).toContainEqual(expect.objectContaining({
      recoveryProofReason: 'post_bond_send_missing',
      withheldObservations: 1,
    }));
  });

  it('closes the waiting episode when verified recovery emits the existing alert clear', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }))
      .mockImplementation(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(relinkHealth()),
      }));

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);

    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(1);
    expect(alertFns.clearAlertSource).toHaveBeenCalledWith(
      'remote-1',
      'instance_logged_out',
      expect.stringContaining('clear_code=WA_AUTH_BOND_RELINK_VERIFIED'),
      expect.anything(),
    );
    expect(soleInfoFields(EPISODE_END_MSG)).toMatchObject({
      name: 'remote-1',
      source: 'instance_logged_out',
      recoveryProofReason: 'post_bond_send_missing',
      withheldObservations: 2,
    });

    poller.stop();
  });

  it.each([
    ['post-bond send equals credentials mtime', {
      outboundSends: { latest_successful_send_at: '2026-05-20T12:00:05.000Z' },
    }],
    ['post-bond send equals the logged-out incident', {
      creds: { mtime: '2026-05-20T11:00:00.000Z' },
      outboundSends: { latest_successful_send_at: '2026-05-20T12:00:00.000Z' },
    }],
  ])('keeps recovery clear eligible when %s', async (_caseName, overrides) => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementation(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(relinkHealth(overrides)),
      }));

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(1);
    expect(infoCallsWith(WITHHELD_MSG)).toHaveLength(0);
    poller.stop();
  });

  it('ends the diagnostic episode even when a proof-eligible clear cannot be delivered', async () => {
    alertFns.clearAlertSource.mockReturnValue(false);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }))
      .mockImplementation(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(relinkHealth()),
      }));

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS);

    expect(alertFns.clearAlertSource).toHaveBeenCalledTimes(1);
    expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_logged_out']);
    expect(soleInfoFields(EPISODE_END_MSG)).toMatchObject({
      recoveryProofReason: 'post_bond_send_missing',
      withheldObservations: 1,
    });

    poller.stop();
  });

  it('does not reopen a flushed episode when an in-flight poll completes after stop', async () => {
    let resolveDelayedResponse!: (response: { ok: boolean; json: () => Promise<Record<string, unknown>> }) => void;
    const delayedResponse = new Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>((resolve) => {
      resolveDelayedResponse = resolve;
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }))
      .mockImplementation(() => delayedResponse);

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    poller.stop();
    expect(soleInfoFields(EPISODE_END_MSG)).toMatchObject({ withheldObservations: 1 });
    resolveDelayedResponse({ ok: true, json: () => Promise.resolve(incompleteRelinkHealth()) });
    await vi.advanceTimersByTimeAsync(0);

    expect(infoCallsWith(WITHHELD_MSG)).toHaveLength(1);
    expect(infoCallsWith(EPISODE_END_MSG)).toHaveLength(1);
  });

  it('does not recreate an episode after discovery removes an instance during an in-flight poll', async () => {
    let resolveDelayedResponse!: (response: { ok: boolean; json: () => Promise<Record<string, unknown>> }) => void;
    const delayedResponse = new Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>((resolve) => {
      resolveDelayedResponse = resolve;
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }))
      .mockImplementation(() => delayedResponse);

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    instances.clear();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(poller.getStatus('remote-1')).toBeUndefined();
    expect(soleInfoFields(EPISODE_END_MSG)).toMatchObject({ withheldObservations: 1 });
    resolveDelayedResponse({ ok: true, json: () => Promise.resolve(incompleteRelinkHealth()) });
    await vi.advanceTimersByTimeAsync(0);

    expect(infoCallsWith(WITHHELD_MSG)).toHaveLength(1);
    expect(infoCallsWith(EPISODE_END_MSG)).toHaveLength(1);
    expect(poller.getStatus('remote-1')).toBeUndefined();
    poller.stop();
  });

  it('flushes the waiting episode when the logged-out fault becomes active again', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }))
      .mockImplementation(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(loggedOutHealth()),
      }));

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS);

    expect(poller.getStatus('remote-1')).toMatchObject({ status: 'logged_out' });
    expect(soleInfoFields(EPISODE_END_MSG)).toMatchObject({
      name: 'remote-1',
      source: 'instance_logged_out',
      recoveryProofReason: 'post_bond_send_missing',
      withheldObservations: 1,
    });

    poller.stop();
  });

  it('does not reopen an episode when an older incomplete poll finishes after a newer refault', async () => {
    let resolveDelayedResponse!: (response: { ok: boolean; json: () => Promise<Record<string, unknown>> }) => void;
    const delayedResponse = new Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>((resolve) => {
      resolveDelayedResponse = resolve;
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(incompleteRelinkHealth()) })
      .mockImplementationOnce(() => delayedResponse)
      .mockImplementation(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(loggedOutHealth()),
      }));

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(soleInfoFields(EPISODE_END_MSG)).toMatchObject({ withheldObservations: 1 });
    resolveDelayedResponse({ ok: true, json: () => Promise.resolve(incompleteRelinkHealth()) });
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getStatus('remote-1')).toMatchObject({ status: 'logged_out' });
    expect(infoCallsWith(WITHHELD_MSG)).toHaveLength(1);
    expect(infoCallsWith(EPISODE_END_MSG)).toHaveLength(1);
    poller.stop();
  });

  it('flushes the waiting episode when an ordinary probe failure re-faults the instance', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }))
      .mockRejectedValue(new Error('connection refused'));

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS);

    expect(poller.getStatus('remote-1')).toMatchObject({ status: 'degraded' });
    expect(soleInfoFields(EPISODE_END_MSG)).toMatchObject({
      name: 'remote-1',
      source: 'instance_logged_out',
      recoveryProofReason: 'post_bond_send_missing',
      withheldObservations: 1,
    });

    poller.stop();
  });

  it('keeps recovery-clear episode counters independent for each instance', async () => {
    let fetchCount = 0;
    mockFetch.mockImplementation(() => {
      fetchCount += 1;
      const health = fetchCount <= 2 ? loggedOutHealth() : incompleteRelinkHealth();
      return Promise.resolve({ ok: true, json: () => Promise.resolve(health) });
    });

    const instances = new Map([
      ['remote-1', makeInstance({ name: 'remote-1' })],
      ['remote-2', makeInstance({ name: 'remote-2' })],
    ]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS);

    expect(infoCallsWith(WITHHELD_MSG)).toHaveLength(2);

    poller.stop();
    const summaries = infoCallsWith(EPISODE_END_MSG).map((call) => call[0]);
    expect(summaries).toContainEqual(expect.objectContaining({
      name: 'remote-1',
      source: 'instance_logged_out',
      withheldObservations: 2,
    }));
    expect(summaries).toContainEqual(expect.objectContaining({
      name: 'remote-2',
      source: 'instance_logged_out',
      withheldObservations: 2,
    }));
  });

  it('flushes the waiting episode before a disappeared instance is discarded', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutHealth()) })
      .mockImplementation(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve(incompleteRelinkHealth()),
      }));

    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), POLL_MS);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    instances.clear();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(poller.getStatus('remote-1')).toBeUndefined();
    expect(soleInfoFields(EPISODE_END_MSG)).toMatchObject({
      name: 'remote-1',
      source: 'instance_logged_out',
      recoveryProofReason: 'post_bond_send_missing',
      withheldObservations: 1,
    });

    poller.stop();
  });
});
