/**
 * healthObservedAt plumbing — freshness seam (WhatSoup #1762 remediation 1).
 *
 * Pins that HealthPoller only advances `healthObservedAt` when `health` is
 * genuinely REPLACED by a live payload, and preserves the prior value when a
 * poll fails and `health` is carried forward verbatim (updateFailure /
 * updateProbeStarved). Without this distinction, a consumer reading
 * `lastPollAt` as a freshness proxy would be misled: `lastPollAt` advances on
 * every poll ATTEMPT, `healthObservedAt` only on actual replacement.
 *
 * Harness mirrors tests/fleet/health-poller-branches2.test.ts (hoisted mocks,
 * privatePoll cast, fetch stub) — kept minimal and scoped to this one seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller } from '../../src/fleet/health-poller.ts';
import type { InstanceHealth } from '../../src/fleet/health-poller.ts';

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));
vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  clearAlertSourceChecked: vi.fn(() => true),
}));
vi.mock('../../src/fleet/alert-throttle-store.ts', () => ({
  ALERT_THROTTLE_INTERVAL_MS: 15 * 60 * 1_000,
  loadAlertThrottle: vi.fn(() => new Map<string, string>()),
  loadAlertThrottleDetailed: vi.fn(() => ({ entries: new Map<string, string>(), loadError: null })),
  recordAlertThrottle: vi.fn(),
}));
vi.mock('../../src/fleet/silence-manager.ts', () => ({
  isInstanceSilenced: vi.fn(() => false),
}));

function makeInstance(overrides: Partial<InstanceHealth> = {}): InstanceHealth {
  return {
    name: 'remote-1',
    type: 'chat',
    accessMode: 'open',
    healthPort: 9100,
    dbPath: '/tmp/whatsoup-test-instance.db',
    healthToken: null,
    ...overrides,
  };
}

type PollerPrivate = { poll(): Promise<void> };
function privatePoll(p: HealthPoller): Promise<void> {
  return (p as unknown as PollerPrivate).poll();
}

function onlineBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'healthy',
    generated_at: new Date().toISOString(),
    runtime: {},
    whatsapp: {
      connected: true,
      account_jid: 'redacted-account@s.whatsapp.net',
      connection: {
        state: 'connected',
        reconnect_phase: null,
        reconnect_attempts: 0,
        auth_failure_class: 'none',
      },
    },
    ...overrides,
  };
}

describe('HealthPoller — healthObservedAt freshness seam', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sets healthObservedAt on the first successful poll, matching lastPollAt', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(onlineBody()) });
    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

    await privatePoll(poller);

    const status = poller.getStatus('remote-1')!;
    expect(status.healthObservedAt).toBe(status.lastPollAt);
    expect(status.healthObservedAt).toBe('2026-07-13T12:00:00.000Z');
  });

  it('advances lastPollAt but PRESERVES healthObservedAt when a subsequent poll fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineBody()) });
    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
    await privatePoll(poller);
    const observedAtFresh = poller.getStatus('remote-1')!.healthObservedAt;

    vi.setSystemTime(new Date('2026-07-13T12:05:00.000Z'));
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await privatePoll(poller);

    const status = poller.getStatus('remote-1')!;
    expect(status.lastPollAt).toBe('2026-07-13T12:05:00.000Z');
    expect(status.lastPollAt).not.toBe(observedAtFresh);
    // Carried forward, NOT reset — this is the whole point of the seam.
    expect(status.healthObservedAt).toBe(observedAtFresh);
    expect(status.consecutiveFailures).toBe(1);
    // Anti-blanket-gate regression guard: the last-known health snapshot
    // stays present through the outage; only its freshness marker changes.
    expect(status.health).not.toBeNull();
  });

  it('refreshes healthObservedAt when a fresh degraded-but-reachable body arrives', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineBody()) });
    const instances = new Map([['remote-1', makeInstance()]]);
    const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
    await privatePoll(poller);
    const firstObservedAt = poller.getStatus('remote-1')!.healthObservedAt;

    vi.setSystemTime(new Date('2026-07-13T12:05:00.000Z'));
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineBody({ status: 'degraded' })) });
    await privatePoll(poller);

    const status = poller.getStatus('remote-1')!;
    expect(status.status).toBe('degraded');
    // A live payload arrived (even though classified degraded) — freshness advances.
    expect(status.healthObservedAt).toBe('2026-07-13T12:05:00.000Z');
    expect(status.healthObservedAt).not.toBe(firstObservedAt);
  });
});
