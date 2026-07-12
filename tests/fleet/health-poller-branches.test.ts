/**
 * Branch-coverage supplement for src/fleet/health-poller.ts.
 *
 * Targets the 98 uncovered arms identified in coverage-final.json.
 * This file is ADDITIVE — it never duplicates a describe/it block that
 * already exists in tests/fleet/health-poller.test.ts.
 *
 * Placement: copy to tests/fleet/health-poller-branches.test.ts, then:
 *   npx vitest run --pool=forks tests/fleet/health-poller-branches.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthPoller, type InstanceHealth } from '../../src/fleet/health-poller.ts';
import type { AlertEmissionResult } from '../../src/lib/emit-alert.ts';

// ---------------------------------------------------------------------------
// Hoisted mocks — must mirror the existing test file so module resolution is
// consistent when both suites are run together.
// ---------------------------------------------------------------------------
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
  createChildLogger: () => ({
    ...logger,
    child: vi.fn().mockReturnThis(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type AlertMockCall = [string, string, ...unknown[]];

function durableAlertResult(): AlertEmissionResult {
  return { ok: true, channel: 'outbox', status: 'durably_queued' };
}

function failedAlertResult(): AlertEmissionResult {
  return { ok: false, channel: 'none', status: 'failed' };
}

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

function onlineHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Build a minimal health payload that satisfies hasVerifiedRelinkRecovery. */
function makeRelinkHealth(overrides: {
  connected?: boolean;
  connectionState?: string;
  authBondStatus?: string;
  credsExists?: boolean;
  credsSize?: number;
  credsMtime?: string;
  credsHash?: string | null;
  credsEmptyHash?: boolean | null;
  latestSendAt?: string;
  authBond?: Record<string, unknown>;
  creds?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const {
    connected = true,
    connectionState = 'connected',
    authBondStatus = 'present',
    credsExists = true,
    credsSize = 512,
    credsMtime = '2026-05-20T12:00:05.000Z',
    credsHash = 'a'.repeat(20),
    credsEmptyHash = false,
    latestSendAt = '2026-05-20T12:00:10.000Z',
  } = overrides;

  return {
    status: 'healthy',
    generated_at: new Date().toISOString(),
    whatsapp: {
      connected,
      account_jid: 'redacted-account@s.whatsapp.net',
      connection: {
        state: connectionState,
        reconnect_phase: null,
        reconnect_attempts: 0,
        auth_failure_class: 'none',
      },
      auth_bond: {
        status: authBondStatus,
        ...overrides.authBond,
        creds: {
          exists: credsExists,
          size: credsSize,
          mtime: credsMtime,
          hash: credsHash,
          empty_hash: credsEmptyHash,
          ...overrides.creds,
        },
      },
    },
    outbound_sends: {
      latest_successful_send_at: latestSendAt,
    },
    runtime: {},
  };
}

/** Standard logged-out JSON body using explicit status-code evidence. */
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

function expectAlertEmitted(instance: string, source: string): void {
  expect(
    (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).some(
      ([i, s]) => i === instance && s === source,
    ),
  ).toBe(true);
}
function expectAlertNotEmitted(instance: string, source: string): void {
  expect(
    (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).some(
      ([i, s]) => i === instance && s === source,
    ),
  ).toBe(false);
}
function expectClearEmitted(instance: string, source: string): void {
  expect(
    (alertFns.clearAlertSource.mock.calls as unknown as AlertMockCall[]).some(
      ([i, s]) => i === instance && s === source,
    ),
  ).toBe(true);
}
function expectClearNotEmitted(instance: string, source: string): void {
  expect(
    (alertFns.clearAlertSource.mock.calls as unknown as AlertMockCall[]).some(
      ([i, s]) => i === instance && s === source,
    ),
  ).toBe(false);
}

type PollerPrivate = { poll(): Promise<void> };
function privatePoll(p: HealthPoller): Promise<void> {
  return (p as unknown as PollerPrivate).poll();
}

// ---------------------------------------------------------------------------
describe('HealthPoller — branch coverage supplement', () => {
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

  // -------------------------------------------------------------------------
  // Branch 0 arm 1 (line 51): env var is set to empty-ish → fallback path.
  // Exercised indirectly: the module is already loaded with the real env.
  // We verify the 30 000 ms default is in effect via the dwell-gate behaviour.
  // -------------------------------------------------------------------------
  describe('readNonNegativeEnvInt default values via dwell-gate behaviour', () => {
    it('uses the default 30 000 ms dwell when the env var is absent', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth()) })
        .mockRejectedValue(new Error('refused'));

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
      // Still below 30 000 ms dwell — no alert yet
      await vi.advanceTimersByTimeAsync(15_000);
      expectAlertNotEmitted('remote-1', 'instance_unreachable');
      // Now past 30 000 ms
      await vi.advanceTimersByTimeAsync(15_000);
      expectAlertEmitted('remote-1', 'instance_unreachable');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 19 arm 0 (line 180): loggedOutHeuristic=true but no disconnect
  // corroboration → ambiguous degraded with reason
  // 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration'
  // -------------------------------------------------------------------------
  describe('classifyHealthSnapshot: loggedOutHeuristic without disconnect corroboration', () => {
    it('classifies backoff-zero with no disconnect evidence as ambiguous degraded', async () => {
      // To hit line 180 we need:
      //   loggedOutHeuristic = true (reconnect_phase=backoff, reconnect_attempts=0, staleReconnectHint=false)
      //   disconnectedCorroboration = false (connected != false, account_jid != 'not connected',
      //     state != 'disconnected', healthStatus != 'unhealthy')
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'healthy',
          whatsapp: {
            connected: null,           // not false → disconnectedCorroboration stays false
            account_jid: null,         // not 'not connected'
            connection: {
              state: 'reconnecting',   // not 'disconnected'
              reconnect_phase: 'backoff',
              reconnect_attempts: 0,
            },
          },
        }),
      });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const status = poller.getStatus('remote-1');
      expect(status).toMatchObject({
        status: 'degraded',
        statusConfidence: 'ambiguous',
        statusReason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
        error: null,
      });
      expectAlertNotEmitted('remote-1', 'instance_logged_out');
    });
  });

  // -------------------------------------------------------------------------
  // Branch 24 arm 0 (line 254): throttle.loadError present but no .code
  // → alertThrottleLoadErrorCode = 'UNKNOWN'
  // -------------------------------------------------------------------------
  describe('constructor: loadAlertThrottleDetailed error without code field', () => {
    it('uses UNKNOWN error code when loadError has no code property', async () => {
      alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
        entries: new Map(),
        loadError: { file: '/tmp/fake', error: 'parse error' }, // no .code
      });
      mockFetch.mockRejectedValue(new Error('refused'));
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
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
  });

  // -------------------------------------------------------------------------
  // Branch 25 arm 1 (line 259): on() called with an event other than 'statusChange'
  // -------------------------------------------------------------------------
  describe('on() ignores unknown event names', () => {
    it('does not invoke a callback registered under an unrecognised event name', async () => {
      mockFetch.mockRejectedValue(new Error('refused'));
      const instances = makeInstances(['remote-1', makeInstance()]);
      const cb = vi.fn();
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      (poller as unknown as { on(e: string, cb: unknown): void }).on('other', cb);
      await privatePoll(poller);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Branches 30+31+32 (lines 309–310): lastAlertAtFor persisted prefix scanning
  // -------------------------------------------------------------------------
  describe('lastAlertAtFor: persisted throttle prefix scanning', () => {
    it('picks the latest timestamp across all per-source entries for an instance', async () => {
      const earlier = '2026-05-20T11:50:00.000Z';
      const later   = '2026-05-20T11:58:00.000Z';
      alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
        entries: new Map([
          ['remote-1:instance_degraded', earlier],
          ['remote-1:instance_unreachable', later],
          ['remote-2:instance_degraded', '2026-05-20T11:59:00.000Z'],
        ]),
        loadError: null,
      });
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(onlineHealth()) });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);
      expect(poller.getStatus('remote-1')!.lastAlertAt).toBe(later);
    });

    it('returns null when no throttle entry matches the instance prefix', async () => {
      alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
        entries: new Map([['other-instance:instance_degraded', '2026-05-20T11:59:00.000Z']]),
        loadError: null,
      });
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(onlineHealth()) });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);
      expect(poller.getStatus('remote-1')!.lastAlertAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 44 arm 1 (line 412): healthStatus field is not a string.
  // -------------------------------------------------------------------------
  describe('healthStatus: numeric status field fails closed', () => {
    it('classifies a numeric status field as an ambiguous type error', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 200,  // numeric, not a string
          whatsapp: { connected: true, connection: { state: 'connected' } },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);
      expect(poller.getStatus('remote-1')).toMatchObject({
        status: 'degraded',
        statusConfidence: 'ambiguous',
        statusReason: 'health_body_type_error',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Branch 53 arm 0 (line 445): 200-OK body → classifyHealthSnapshot sees
  // 'degraded' after the loggedOutSignal=false and healthStatus checks pass.
  // Reachable when status='healthy' but whatsapp signals ambiguous backoff.
  // -------------------------------------------------------------------------
  describe('200-OK body: classifyHealthSnapshot marks degraded despite healthy status field', () => {
    it('marks degraded when whatsapp signals ambiguous backoff despite a healthy status string', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'healthy',
          whatsapp: {
            connected: false,
            account_jid: 'not connected',
            connection: {
              state: 'disconnected',
              reconnect_phase: 'backoff',
              reconnect_attempts: 0,
              last_disconnect_reason: 'connectionReplaced',
              auth_failure_class: null,
            },
          },
        }),
      });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const status = poller.getStatus('remote-1');
      // classifyLoggedOutSignal: no explicit signal, no uptime → loggedOut=false.
      // classifyHealthSnapshot: loggedOutHeuristic + disconnectedCorroboration = ambiguous degraded.
      expect(status!.status).toBe('degraded');
      expect(status!.statusConfidence).toBe('ambiguous');
    });
  });

  // -------------------------------------------------------------------------
  // Branch 60 arm 1 (line 497): readHealthBody JSON parse failure
  // -------------------------------------------------------------------------
  describe('readHealthBody: JSON parse failure on non-ok response', () => {
    it('falls back to updateFailure when non-ok response body is not valid JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new SyntaxError('invalid json')),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);
      const status = poller.getStatus('remote-1');
      expect(status!.status).toBe('degraded');
      expect(status!.error).toBe('HTTP 500');
    });
  });

  // -------------------------------------------------------------------------
  // Typed health diagnostics: producer last_status_code is number|null. A
  // string "401" cannot promote an unhealthy body to confirmed logged-out.
  // -------------------------------------------------------------------------
  describe('classifyLoggedOutSignal: string "401" fails closed without auth promotion', () => {
    it('preserves explicit unhealthy classification and records the type error', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'unhealthy',
          generated_at: new Date().toISOString(),
          uptime_seconds: 200,
          whatsapp: {
            connected: false,
            connection: {
              state: 'disconnected',
              last_status_code: '401',  // string, not number
              reconnect_phase: 'backoff',
              reconnect_attempts: 0,
            },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);
      expect(poller.getStatus('remote-1')).toMatchObject({
        status: 'degraded',
        statusConfidence: 'confirmed',
        statusReason: 'health_body_unhealthy',
      });
      expect(poller.getStatus('remote-1')!.statusEvidence.join(' ')).toContain(
        'schema_type_errors=whatsapp.connection.last_status_code',
      );
      expectAlertNotEmitted('remote-1', 'instance_logged_out');
    });
  });

  // -------------------------------------------------------------------------
  // Branch 81 arm 1 (line 575) / Branch 83 arm 0 (line 579):
  // uptime_seconds absent → readNumber returns null → settle grace fires,
  // logs, and returns {loggedOut:false, weak:true}
  // -------------------------------------------------------------------------
  describe('classifyLoggedOutSignal: absent uptime_seconds triggers settle grace', () => {
    it('does not classify as logged-out and logs settle grace when uptime_seconds is absent', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'unhealthy',
          // no uptime_seconds → null
          whatsapp: {
            connected: false,
            connection: { state: 'disconnected', reconnect_phase: 'backoff', reconnect_attempts: 0 },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      expect(poller.getStatus('remote-1')!.status).toBe('degraded');
      expectAlertNotEmitted('remote-1', 'instance_logged_out');
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'remote-1', uptimeSeconds: null }),
        'weak logged-out signal observed inside settle grace; waiting',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Branches 86+88+89 (lines 631, 638, 641): appendLifecycleEvidence —
  // recentEvents with non-string event names → names is empty → no events field
  // -------------------------------------------------------------------------
  describe('appendLifecycleEvidence: recentEvents with non-string event names', () => {
    it('includes event_count but skips the events list when event fields are not strings', async () => {
      mockFetch.mockResolvedValue({
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
            credential_lifecycle: {
              recentEvents: [
                { event: 42, at: '2026-05-20T11:59:00.000Z' },
                { event: null, at: '2026-05-20T11:59:01.000Z' },
                { at: '2026-05-20T11:59:02.000Z' },
              ],
            },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      const evidence = String(call?.[3] ?? '');
      expect(evidence).toContain('credential_lifecycle_event_count=3');
      expect(evidence).not.toContain('credential_lifecycle_events=');
    });
  });

  // -------------------------------------------------------------------------
  // Branches 91+93+94 (lines 653, 658, 661): appendAuthBondEvidence — issues array
  // -------------------------------------------------------------------------
  describe('appendAuthBondEvidence: empty issues array', () => {
    it('omits auth_bond_issues when the issues array is empty', async () => {
      mockFetch.mockResolvedValue({
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
            auth_bond: {
              status: 'present',
              issues: [],
              creds: { exists: true, size: 512, mtime: '2026-05-20T12:00:00.000Z' },
            },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      expect(call).toBeDefined();
      expect(String(call![3])).not.toContain('auth_bond_issues=');
    });

    it('omits auth_bond_issues when issues contains only non-string items', async () => {
      // formatEvidenceValue: null→null, NaN→null (non-finite number), {}→null (non-string/bool/num),
      // Infinity→null (non-finite). Finite numbers like 42 ARE serialised ("42"), so must be excluded.
      mockFetch.mockResolvedValue({
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
            auth_bond: {
              status: 'present',
              issues: [null, NaN, {}, Infinity],
              creds: {},
            },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      expect(String(call?.[3] ?? '')).not.toContain('auth_bond_issues=');
    });
  });

  // -------------------------------------------------------------------------
  // Branches 95–112 (lines 671–692): appendAuthBondEvidence camelCase fallbacks
  // -------------------------------------------------------------------------
  describe('appendAuthBondEvidence: camelCase key fallbacks', () => {
    it('reads creds hash from sha256, identity from meHash, tree from treeHash, backup from camelCase keys', async () => {
      mockFetch.mockResolvedValue({
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
            auth_bond: {
              status: 'present',
              creds: {
                exists: true,
                size: 512,
                sha256: 'sha256hashvalue',  // no 'hash' → falls back to sha256
                empty_hash: false,
              },
              meHash: 'meHashValue',    // camelCase for branch 97
              treeHash: 'treeHashValue', // camelCase for branch 100
              backup: {
                latestAt: '2026-05-20T11:00:00.000Z',        // branch 101
                latestReason: 'creds_update',                  // branch 102
                latestTreeHash: 'backupTreeHash',              // branch 103
                lastCaptureAt: '2026-05-20T11:05:00.000Z',   // branch 104
                lastCaptureReason: 'creds_update',             // branch 105
                lastCaptureError: 'copy failed',               // branch 106
                lastCaptureDeferredAt: '2026-05-20T11:05:01.000Z', // branch 107
                lastCaptureDeferredReason: 'noop',             // branch 108
                lastCaptureDeferredAgeMs: 100,                 // branch 109
                lastRestoreAt: '2026-05-20T10:00:00.000Z',   // branch 110
                lastRestoreSource: '/tmp/backup',              // branch 112
                lastRestoreError: 'restore failed',
              },
            },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      expect(call).toBeDefined();
      const evidence = String(call![3]);
      expect(evidence).toContain('auth_bond_creds_hash=sha256hashvalue');
      expect(evidence).toContain('auth_bond_identity_hash=meHashValue');
      expect(evidence).toContain('auth_bond_tree_hash=treeHashValue');
      expect(evidence).toContain('auth_bond_backup_latest_at=2026-05-20T11:00:00.000Z');
      expect(evidence).toContain('auth_bond_backup_last_capture_at=2026-05-20T11:05:00.000Z');
      expect(evidence).toContain('auth_bond_backup_last_restore_at=2026-05-20T10:00:00.000Z');
      expect(evidence).toContain('auth_bond_backup_last_restore_source_present=true');
    });

    it('reads auth_bond identity from credential_lifecycle.currentAuthBond when auth_bond is absent', async () => {
      mockFetch.mockResolvedValue({
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
            credential_lifecycle: {
              currentAuthBond: {
                status: 'present',
                creds: { exists: true, size: 512 },
                me_hash: 'lifecycleMeHash',
              },
            },
            // no auth_bond key → falls back to lifecycleAuthBond
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      expect(String(call?.[3] ?? '')).toContain('auth_bond_identity_hash=lifecycleMeHash');
    });
  });

  // -------------------------------------------------------------------------
  // Branch 118 arm 1 (line 703): formatEvidenceValue: boolean false → 'false'
  // -------------------------------------------------------------------------
  describe('formatEvidenceValue: boolean false serialises as "false"', () => {
    it('includes creds_exists=false in evidence when creds.exists is boolean false', async () => {
      mockFetch.mockResolvedValue({
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
            auth_bond: {
              status: 'present',
              creds: { exists: false, size: 0 },
            },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      expect(String(call?.[3] ?? '')).toContain('auth_bond_creds_exists=false');
    });
  });

  // -------------------------------------------------------------------------
  // Branches 120+121 (lines 705+707): formatEvidenceValue: non-string/non-boolean
  // value returns null; redactEvidenceString empty result returns null
  // -------------------------------------------------------------------------
  describe('formatEvidenceValue: object value returns null (no evidence field)', () => {
    it('treats backup.latest as an object → latest_present=false (not a non-empty string)', async () => {
      mockFetch.mockResolvedValue({
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
            auth_bond: {
              status: 'present',
              backup: {
                latest: { path: '/tmp/bkp' },  // object, not string → branch 121
                latest_at: '2026-05-20T10:00:00.000Z',
              },
            },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      expect(String(call?.[3] ?? '')).toContain('auth_bond_backup_latest_present=false');
    });
  });

  // -------------------------------------------------------------------------
  // Branches 122+123+124 (lines 721–722): redactEvidenceString PHONE_LIKE_RE
  // -------------------------------------------------------------------------
  describe('redactEvidenceString: PHONE_LIKE_RE conditional arms', () => {
    it('redacts a phone candidate with + prefix', async () => {
      mockFetch.mockResolvedValue({
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
            credential_lifecycle: {
              lastDisconnectDiagnostic: {
                message: 'device removed for +1 (555) 000-1234',
              },
            },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      const evidence = String(call?.[3] ?? '');
      expect(evidence).toContain('[REDACTED_PHONE]');
      expect(evidence).not.toContain('+1');
    });

    it('does not redact a short digit sequence without phone syntax', async () => {
      mockFetch.mockResolvedValue({
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
            credential_lifecycle: {
              lastDisconnectDiagnostic: {
                message: 'error code 123456',
              },
            },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      // 6 digits, no phone syntax → should NOT be redacted
      expect(String(call?.[3] ?? '')).not.toContain('[REDACTED_PHONE]');
    });
  });

  // -------------------------------------------------------------------------
  // Branch 130 arm 1 (line 743): readNumber from string that is a valid integer
  // -------------------------------------------------------------------------
  describe('readNumber: string numeric uptime applies settle grace', () => {
    it('parses string uptime_seconds and respects settle grace window', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'unhealthy',
          uptime_seconds: '30',  // string, not number, but parses to 30 < 60
          whatsapp: {
            connected: false,
            connection: { state: 'disconnected', reconnect_phase: 'backoff', reconnect_attempts: 0 },
          },
        }),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      expect(poller.getStatus('remote-1')!.status).toBe('degraded');
      expectAlertNotEmitted('remote-1', 'instance_logged_out');
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'remote-1', uptimeSeconds: 30 }),
        'weak logged-out signal observed inside settle grace; waiting',
      );
    });
  });

  // -------------------------------------------------------------------------
  // A target failure following an existing degraded state does not emit another
  // statusChange when no loop-lag evidence corroborates local starvation.
  // -------------------------------------------------------------------------
  describe('abort-before-connect: no status-change event when already degraded', () => {
    it('does not emit a status-change when an uncorroborated abort follows an existing degraded state', async () => {
      const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ status: 'degraded', whatsapp: { connected: true, connection: { state: null } } }),
        })
        .mockRejectedValueOnce(abortErr);

      const instances = makeInstances(['remote-1', makeInstance()]);
      const listener = vi.fn();
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.on('statusChange', listener);
      poller.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(poller.getStatus('remote-1')!.status).toBe('degraded');
      const callsAfterFirst = listener.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.getStatus('remote-1')!.status).toBe('degraded');
      expect(poller.getStatus('remote-1')!.statusReason).toBe('health_poll_failed_transient');
      expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(1);
      expect(listener.mock.calls.length).toBe(callsAfterFirst);
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 185 arm 0 (line 952): updateDegraded: previous status was unreachable,
  // newStatus is degraded (not logged_out) → clearRecoveredAlert is called
  // -------------------------------------------------------------------------
  describe('updateDegraded: recovery-clear when transitioning from unreachable to degraded', () => {
    it('triggers clearRecoveredAlert on unreachable→degraded transition', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('refused'))
        .mockRejectedValueOnce(new Error('refused'))
        .mockRejectedValueOnce(new Error('refused'));

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
      expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual(['instance_never_reachable']);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          status: 'degraded',
          whatsapp: { connected: true, connection: { state: null } },
        }),
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(poller.getStatus('remote-1')!.status).toBe('degraded');
      expectClearEmitted('remote-1', 'instance_never_reachable');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 195 arm 0 (line 995): updateFromHealthSnapshot returns early for online
  // -------------------------------------------------------------------------
  describe('updateFromHealthSnapshot: online classification causes early return', () => {
    it('does not call updateDegraded when self-health classification is online', async () => {
      const getSelfHealth = vi.fn().mockReturnValue(onlineHealth());
      const instances = makeInstances(['self', makeInstance({ name: 'self' })]);
      const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
      await privatePoll(poller);
      expect(poller.getStatus('self')!.status).toBe('online');
      expect(poller.getStatus('self')!.statusReason).toBe('self_health_callback');
    });
  });

  // -------------------------------------------------------------------------
  // Branch 196 arm 0 (line 1002): updateFromHealthSnapshot logged_out classification
  // routes to 'instance_logged_out' alert source
  // -------------------------------------------------------------------------
  describe('updateFromHealthSnapshot: logged_out classification uses instance_logged_out source', () => {
    it('emits instance_logged_out when self-health classifies as logged_out', async () => {
      const getSelfHealth = vi.fn().mockReturnValue({
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
      });
      const instances = makeInstances(['self', makeInstance({ name: 'self' })]);
      const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
      await privatePoll(poller);

      expect(poller.getStatus('self')!.status).toBe('logged_out');
      expectAlertEmitted('self', 'instance_logged_out');
    });
  });

  // -------------------------------------------------------------------------
  // Branch 197 arm 1 (line 1018): activeAlertSources defaults to [] (no existing)
  // -------------------------------------------------------------------------
  describe('poll: activeAlertSources initialised to [] on first successful online poll', () => {
    it('sets activeAlertSources to empty array on the first poll when no prior status exists', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(onlineHealth()) });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);
      expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Branch 208 arm 0 (line 1040): clearRecoveredAlert adds 'instance_logged_out'
  // from prevStatus when it is not already in activeAlertSources
  // -------------------------------------------------------------------------
  describe('clearRecoveredAlert: belt-and-suspenders adds instance_logged_out from prevStatus', () => {
    it('attempts clear of instance_logged_out even when it was never added to activeAlertSources', async () => {
      alertFns.emitAlert.mockReturnValueOnce(failedAlertResult()); // first logged_out alert fails
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeRelinkHealth()) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
      expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.getStatus('remote-1')!.status).toBe('online');
      expectClearEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 212 arm 0 (line 1069): hasVerifiedRelinkRecovery whatsapp absent
  // Branch 215 arm 0 (line 1074): whatsapp.connected !== true
  // Branch 218 arm 0 (line 1079): connection.state !== 'connected'
  // Branch 219 arm 0 (line 1080): authBond or creds absent
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: early-exit guards', () => {
    it('withholds clear when whatsapp sub-field is absent from recovery health', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'healthy' }) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.getStatus('remote-1')).toMatchObject({
        status: 'degraded',
        statusConfidence: 'ambiguous',
        statusReason: 'health_body_incomplete',
      });
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      expect(poller.getStatus('remote-1')!.activeAlertSources).toContain('instance_logged_out');
      poller.stop();
    });

    it('withholds clear when whatsapp.connected is false', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeRelinkHealth({ connected: false })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });

    it('withholds clear when connection.state is not "connected"', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeRelinkHealth({ connectionState: 'reconnecting' })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });

    it('withholds clear when auth_bond is absent from recovery health', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth({
          whatsapp: { connected: true, connection: { state: 'connected' } },
          outbound_sends: { latest_successful_send_at: '2026-05-20T12:00:10.000Z' },
        })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 223 arm 1 (line 1086): creds.empty_hash !== false → hash check
  // Branch 224 (line 1088): hash is null → return false
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: empty_hash guard', () => {
    it('withholds clear when empty_hash is true and hash matches EMPTY_SHA256 prefix', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(
          makeRelinkHealth({ credsEmptyHash: true, credsHash: 'e3b0c44298fc1c149af' }),
        ) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });

    it('withholds clear when empty_hash is not false and hash is absent', async () => {
      // makeRelinkHealth spreads overrides.creds on top of defaults, so include
      // hash: undefined explicitly to shadow the default 'a'.repeat(20) value.
      // With empty_hash: null (not false) and hash undefined → null → return false.
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(
          makeRelinkHealth({ creds: { exists: true, size: 512, mtime: '2026-05-20T12:00:05.000Z', empty_hash: null, hash: undefined } }),
        ) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });

    it('emits clear when empty_hash is not false but hash is a valid non-EMPTY_SHA256 value', async () => {
      // empty_hash = null (not false), but hash = 'deadbeef...' (non-empty, doesn't start EMPTY_SHA256)
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(
          makeRelinkHealth({ credsEmptyHash: null as unknown as boolean, credsHash: 'deadbeefdeadbeef' }),
        ) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.getStatus('remote-1')!.status).toBe('online');
      expectClearEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 225 arm 1 (line 1089): auth_bond.status !== 'present'
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: auth_bond.status guard', () => {
    it('withholds clear when auth_bond.status is not "present"', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeRelinkHealth({ authBondStatus: 'missing' })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 227 arm 0 (line 1095): creds.exists !== true
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: creds.exists must be true', () => {
    it('withholds clear when creds.exists is false', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeRelinkHealth({ credsExists: false })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 228 arm 0 (line 1098): size <= 0 or null
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: creds.size must be > 0', () => {
    it('withholds clear when creds.size is zero', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeRelinkHealth({ credsSize: 0 })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });

    it('withholds clear when creds.size is absent', async () => {
      // makeRelinkHealth defaults size=512 before the spread; include size: undefined
      // explicitly so the spread shadows it, leaving creds['size'] undefined.
      // readNumber(undefined) → null → size===null → return false.
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(
          makeRelinkHealth({ creds: { exists: true, size: undefined, mtime: '2026-05-20T12:00:05.000Z', hash: 'abc', empty_hash: false } }),
        ) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branches 233–240 (lines 1139–1146): relinkRecoveryEvidence camelCase fallbacks
  // -------------------------------------------------------------------------
  describe('relinkRecoveryEvidence: camelCase outboundSends key', () => {
    it('resolves latest_successful_send_at from camelCase latestSuccessfulSendAt key', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth({
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              creds: { exists: true, size: 512, mtime: '2026-05-20T12:00:05.000Z', hash: 'abcdef', empty_hash: false },
            },
          },
          outboundSends: { latestSuccessfulSendAt: '2026-05-20T12:00:10.000Z' },
        })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);

      expectClearEmitted('remote-1', 'instance_logged_out');
      const clearCall = (alertFns.clearAlertSource.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      const evidence = String(clearCall?.[2] ?? '');
      expect(evidence).toContain('latest_successful_send_at=2026-05-20T12:00:10.000Z');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branches 241+242 (lines 1162+1164): relinkRecoveryCriticalAsset fingerprint
  // -------------------------------------------------------------------------
  describe('relinkRecoveryCriticalAsset: fingerprint field variants', () => {
    it('uses creds.sha256 as fingerprint when hash is absent', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth({
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              creds: { exists: true, size: 512, mtime: '2026-05-20T12:00:05.000Z', sha256: 'sha256fp', empty_hash: false },
            },
          },
          outbound_sends: { latest_successful_send_at: '2026-05-20T12:00:10.000Z' },
        })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);

      expectClearEmitted('remote-1', 'instance_logged_out');
      const clearCall = (alertFns.clearAlertSource.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      const asset = (clearCall?.[3] as { asset?: { fingerprint?: string } } | undefined)?.asset;
      expect(asset?.fingerprint).toBe('sha256fp');
      poller.stop();
    });

    it('sets fingerprint to undefined when neither hash nor sha256 is present', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth({
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              creds: { exists: true, size: 512, mtime: '2026-05-20T12:00:05.000Z', empty_hash: false },
            },
          },
          outbound_sends: { latest_successful_send_at: '2026-05-20T12:00:10.000Z' },
        })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);

      const clearCall = (alertFns.clearAlertSource.mock.calls as unknown as AlertMockCall[]).find(
        ([inst, src]) => inst === 'remote-1' && src === 'instance_logged_out',
      );
      const asset = (clearCall?.[3] as { asset?: { fingerprint?: string } } | undefined)?.asset;
      expect(asset?.fingerprint).toBeUndefined();
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branches 248+249 (lines 1189–1190): readLatestSuccessfulSendAt fallbacks
  // -------------------------------------------------------------------------
  describe('readLatestSuccessfulSendAt: absent outbound data blocks clear', () => {
    it('withholds clear when no outbound_sends or outboundSends key exists', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth({
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              creds: { exists: true, size: 512, mtime: '2026-05-20T12:00:05.000Z', hash: 'abc', empty_hash: false },
            },
          },
          // no outbound_sends or outboundSends
        })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.getStatus('remote-1')!.status).toBe('online');
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 250 arm 0 (line 1196): readTimestampMs: value is not a string → null
  // Branch 253 arm 1 (line 1202): space-delimited datetime normalisation
  // -------------------------------------------------------------------------
  describe('readTimestampMs: non-string and space-delimited datetime', () => {
    it('withholds clear when creds.mtime is a number (non-string)', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              creds: { exists: true, size: 512, mtime: 1716206405000, hash: 'abc', empty_hash: false },
            },
          },
          outbound_sends: { latest_successful_send_at: '2026-05-20T12:00:10.000Z' },
        }) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });

    it('accepts a space-delimited datetime string and emits clear', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(
          makeRelinkHealth({ credsMtime: '2026-05-20 12:00:05' }),
        ) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 254 arm 0 (line 1207): credsMtimeMs === null → false
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: unparseable creds.mtime', () => {
    it('withholds clear when creds.mtime is not a parseable string', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeRelinkHealth({ credsMtime: 'not-a-date' })) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 257 arm 0 (line 1209): latestSendMs === null → false
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: unparseable send timestamp', () => {
    it('withholds clear when outbound send timestamp is not parseable', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              creds: { exists: true, size: 512, mtime: '2026-05-20T12:00:05.000Z', hash: 'abc', empty_hash: false },
            },
          },
          outbound_sends: { latest_successful_send_at: 'bad-date' },
        }) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 259 arm 0 (line 1221): latestSendMs < credsMtimeMs → false
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: send before creds mtime', () => {
    it('withholds clear when the latest send was before the creds were written', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(
          makeRelinkHealth({
            credsMtime:  '2026-05-20T12:00:10.000Z',
            latestSendAt: '2026-05-20T12:00:05.000Z', // send BEFORE mtime
          }),
        ) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 260 arm 1 (line 1223): send before incident timestamp → false
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: send before the incident poll time', () => {
    it('withholds clear when the latest send preceded the logged-out poll', async () => {
      // Incident poll time = 2026-05-20T12:00:00Z.
      // Send at 2026-05-19: before both creds mtime and incident.
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(
          makeRelinkHealth({
            credsMtime:  '2026-05-19T11:00:00.000Z',
            latestSendAt: '2026-05-19T11:00:05.000Z',
          }),
        ) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expectClearNotEmitted('remote-1', 'instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 270 arm 1 (line 1258): trackActiveAlertSource skips when an alert
  // is not durably accepted and there is no confirmed prior alert.
  // -------------------------------------------------------------------------
  describe('trackActiveAlertSource: source not tracked when alert fails and no throttle entry', () => {
    it('leaves activeAlertSources empty when emitAlert reports failure with no prior throttle entry', async () => {
      alertFns.emitAlert.mockReturnValue(failedAlertResult());
      mockFetch.mockResolvedValue({
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
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
      expect(poller.getStatus('remote-1')!.activeAlertSources).toEqual([]);
    });

    it('adds source when emitAlert fails but persisted throttle has a prior entry', async () => {
      alertFns.emitAlert.mockReturnValue(failedAlertResult());
      alertThrottleStore.loadAlertThrottleDetailed.mockReturnValue({
        entries: new Map([['remote-1:instance_logged_out', '2026-05-20T11:55:00.000Z']]),
        loadError: null,
      });
      mockFetch.mockResolvedValue({
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
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      expect(poller.getStatus('remote-1')!.activeAlertSources).toContain('instance_logged_out');
    });
  });

  // -------------------------------------------------------------------------
  // Self-instance: getSelfHealth throws → updateFailure path
  // -------------------------------------------------------------------------
  describe('self-instance: getSelfHealth throws', () => {
    it('records an error and degraded status when getSelfHealth throws', async () => {
      const throwErr = new Error('health callback exploded');
      const getSelfHealth = vi.fn().mockImplementation(() => { throw throwErr; });
      const instances = makeInstances(['self', makeInstance({ name: 'self' })]);
      const poller = new HealthPoller(() => instances, 'self', getSelfHealth);
      await privatePoll(poller);

      const status = poller.getStatus('self');
      expect(status!.status).toBe('degraded');
      expect(status!.error).toBe('health callback exploded');
      expect(status!.consecutiveFailures).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 403 Forbidden on health probe (auth failure path, line 376)
  // -------------------------------------------------------------------------
  describe('403 Forbidden on health probe', () => {
    it('classifies 403 as health_probe_auth_failed', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: 'forbidden' }),
      });
      const instances = makeInstances(['remote-1', makeInstance({ healthToken: 'expired-token' })]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      expect(poller.getStatus('remote-1')!.status).toBe('degraded');
      expectAlertEmitted('remote-1', 'health_probe_auth_failed');
      expect(alertFns.emitAlert).toHaveBeenCalledWith(
        'remote-1',
        'health_probe_auth_failed',
        'whatsoup@remote-1 health probe auth failed',
        'health_probe_auth_failed http_status=403 health_port=9100',
        'critical',
        undefined,
      );
    });
  });

  // -------------------------------------------------------------------------
  // readHealthBody: non-record parseable body (e.g., array) returns null
  // -------------------------------------------------------------------------
  describe('readHealthBody: array body is not a record', () => {
    it('falls through to HTTP error when non-ok body is a JSON array', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve([{ status: 'degraded' }]),
      });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      expect(poller.getStatus('remote-1')!.status).toBe('degraded');
      expect(poller.getStatus('remote-1')!.error).toBe('HTTP 503');
    });
  });

  // -------------------------------------------------------------------------
  // isProbeAbortBeforeConnect: additional abort message variants
  // -------------------------------------------------------------------------
  describe('isProbeAbortBeforeConnect: additional abort message variants', () => {
    it('treats "aborted" as a target failure without corroborating loop lag', async () => {
      mockFetch.mockRejectedValue(new Error('aborted'));
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);
      expect(poller.getStatus('remote-1')!.statusReason).toBe('health_poll_failed_transient');
      expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(1);
    });

    it('treats "this operation was aborted" as a target failure without corroborating loop lag', async () => {
      mockFetch.mockRejectedValue(new Error('this operation was aborted'));
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);
      expect(poller.getStatus('remote-1')!.statusReason).toBe('health_poll_failed_transient');
      expect(poller.getStatus('remote-1')!.consecutiveFailures).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // clearRecoveredAlert: clearAlertSourceChecked returns false → source retained
  // -------------------------------------------------------------------------
  describe('clearRecoveredAlert: source retained when clear emission returns false', () => {
    it('keeps source in activeAlertSources when clearAlertSourceChecked returns false', async () => {
      alertFns.clearAlertSource.mockReturnValue(false);
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeRelinkHealth()) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.getStatus('remote-1')!.status).toBe('online');
      expect(poller.getStatus('remote-1')!.activeAlertSources).toContain('instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // clearRecoveredAlert: clearAlertSourceChecked throws → warn logged, source retained
  // -------------------------------------------------------------------------
  describe('clearRecoveredAlert: exception from clearAlertSourceChecked is handled', () => {
    it('logs a warning and retains source when clearAlertSourceChecked throws', async () => {
      const clearErr = new Error('network socket closed');
      alertFns.clearAlertSource.mockImplementation(() => { throw clearErr; });

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeRelinkHealth()) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: clearErr, name: 'remote-1', source: 'instance_logged_out' }),
        'failed to emit alert clear',
      );
      expect(poller.getStatus('remote-1')!.activeAlertSources).toContain('instance_logged_out');
      poller.stop();
    });
  });

  // -------------------------------------------------------------------------
  // stop() is safe when not started
  // -------------------------------------------------------------------------
  describe('stop() is idempotent when not started', () => {
    it('does not throw when stop is called without a prior start', () => {
      const poller = new HealthPoller(() => new Map(), 'self', vi.fn().mockReturnValue({}));
      expect(() => poller.stop()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // dropSupersededAlertSources: 'instance_unreachable' cleared when logged_out fires
  // -------------------------------------------------------------------------
  describe('dropSupersededAlertSources: instance_unreachable superseded by logged_out', () => {
    it('removes instance_unreachable from activeAlertSources when logged_out is confirmed', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(onlineHealth()) })
        .mockRejectedValueOnce(new Error('refused'))
        .mockRejectedValueOnce(new Error('refused'))
        .mockRejectedValueOnce(new Error('refused'));

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poller.getStatus('remote-1')!.status).toBe('unreachable');
      await vi.advanceTimersByTimeAsync(30_000);
      expectAlertEmitted('remote-1', 'instance_unreachable');
      expect(poller.getStatus('remote-1')!.activeAlertSources).toContain('instance_unreachable');

      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(loggedOutBody()) });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
      expect(poller.getStatus('remote-1')!.activeAlertSources).not.toContain('instance_unreachable');
      expect(poller.getStatus('remote-1')!.activeAlertSources).toContain('instance_logged_out');
      poller.stop();
    });
  });
});
