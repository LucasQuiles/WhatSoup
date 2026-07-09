import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'health', name), 'utf8'));

function fetchReturning(body: Record<string, unknown>, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  });
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('mini10-class body → provider_reauth_required (NOT health_body_degraded, NOT instance_logged_out)', async () => {
  vi.stubGlobal('fetch', fetchReturning(fixture('provider-reauth-required.json')));
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }));
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  const emits = alertFns.emitAlert.mock.calls;
  const reauth = emits.filter(([inst, src]) => inst === 'ad-bot' && src === 'provider_reauth_required');
  expect(reauth).toHaveLength(1);
  expect(reauth[0][4]).toBe('critical');
  expect(emits.some(([, src]) => src === 'health_body_degraded')).toBe(false);
  expect(emits.some(([, src]) => src === 'instance_logged_out')).toBe(false);
  const status = poller.getStatus('ad-bot');
  expect(status!.status).toBe('degraded');           // provider fault ≠ WhatsApp logout
  expect(status!.statusReason).toBe('provider_reauth_required');
  poller.stop();
});

it('repeat polls do not re-page (ALERT-09A: throttle/active-incident suppression)', async () => {
  vi.stubGlobal('fetch', fetchReturning(fixture('provider-reauth-required.json')));
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }), 5_000);
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(alertFns.emitAlert.mock.calls.filter(([, s]) => s === 'provider_reauth_required')).toHaveLength(1);
  poller.stop();
});

it('a persistent incident does not re-page past the 15-minute alert throttle window (true incident-scoped suppression, not just rate-limiting)', async () => {
  vi.stubGlobal('fetch', fetchReturning(fixture('provider-reauth-required.json')));
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }), 16 * 60 * 1000);
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(16 * 60 * 1000); // crosses the 15-minute ALERT_THROTTLE_INTERVAL_MS
  expect(alertFns.emitAlert.mock.calls.filter(([, s]) => s === 'provider_reauth_required')).toHaveLength(1);
  poller.stop();
});

it('a CONFIRMED WhatsApp logout still pages independently (approved flag 1: no supersession)', async () => {
  const body = fixture('provider-reauth-required.json');
  (body['whatsapp'] as Record<string, unknown>)['connected'] = false;
  (body['whatsapp'] as Record<string, unknown>)['connection'] = { state: 'close', last_status_code: 401 };
  vi.stubGlobal('fetch', fetchReturning(body));
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }));
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  // logout wins the status classification; reauth source is NOT in ALERT_SOURCES_SUPERSEDED_BY_LOGGED_OUT
  expect(alertFns.emitAlert.mock.calls.some(([, s]) => s === 'instance_logged_out')).toBe(true);
  const dropped = poller.getStatus('ad-bot');
  expect(dropped!.status).toBe('logged_out');
  poller.stop();
});

it('the failureHealth (non-200) path also confirms provider_reauth_required (Task-11 mirror branch)', async () => {
  vi.stubGlobal('fetch', fetchReturning(fixture('provider-reauth-required.json'), 503));
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }));
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  const emits = alertFns.emitAlert.mock.calls;
  expect(emits.some(([inst, src]) => inst === 'ad-bot' && src === 'provider_reauth_required')).toBe(true);
  poller.stop();
});

it('clear is WITHHELD while the body still confirms reauth', async () => {
  vi.stubGlobal('fetch', fetchReturning(fixture('provider-reauth-required.json')));
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }), 5_000);
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(alertFns.clearAlertSource.mock.calls.some(([, s]) => s === 'provider_reauth_required')).toBe(false);
  poller.stop();
});

it('recovery-window body clears the incident FROM THE DEGRADED FLOW (idle bot never returns online)', async () => {
  const mockFetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => fixture('provider-reauth-required.json') })
    .mockResolvedValue({ ok: true, status: 200, json: async () => fixture('provider-reauth-recovered.json') });
  vi.stubGlobal('fetch', mockFetch);
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }), 5_000);
  poller.start();
  await vi.advanceTimersByTimeAsync(0);      // poll 1: incident → page
  await vi.advanceTimersByTimeAsync(5_000);  // poll 2: recovery-window (status STILL degraded) → clear
  const clears = alertFns.clearAlertSource.mock.calls.filter(([, s]) => s === 'provider_reauth_required');
  expect(clears).toHaveLength(1);
  expect(String(clears[0][2])).toContain('clear_code=AGENT_PROVIDER_AUTH_RECOVERED');
  expect(String(clears[0][2])).toContain('proof=primary_model_probe_ok');
  poller.stop();
});

it('fallback serving never satisfies the clear (IMPACT-18)', async () => {
  const body = fixture('provider-reauth-required.json');
  (body['instance'] as Record<string, unknown>)['effectiveProvider'] = 'opencode';
  (body['instance'] as Record<string, unknown>)['fallbackActiveUntil'] = 9_999_999_999_999;
  vi.stubGlobal('fetch', fetchReturning(body));
  const instances = makeInstances(['ad-bot', makeInstance({ name: 'ad-bot' })]);
  const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({ status: 'healthy' }), 5_000);
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(alertFns.clearAlertSource.mock.calls.some(([, s]) => s === 'provider_reauth_required')).toBe(false);
  poller.stop();
});
