/**
 * Branch-coverage supplement #2 for src/fleet/health-poller.ts.
 *
 * Additive companion to tests/fleet/health-poller-branches.test.ts. Targets the
 * remaining reachable uncovered branch arms that the first supplement did not
 * reach: the `?? 'unknown'` fallbacks inside the logged-out evidence builders
 * (when the underlying connection/reconnect fields are ABSENT rather than
 * present), the readNumber non-finite-string arm, the auth-failure-with-null-
 * body `?? { status: 'degraded' }` fallback, and the 200-OK-body classified as
 * logged_out via classifyHealthSnapshot (not the loggedOutSignal heuristic).
 *
 * Placement mirrors the existing supplement: hoisted mocks identical so module
 * resolution is consistent when run together.
 *   npx vitest run --pool=forks tests/fleet/health-poller-branches2.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HealthPoller,
  LOGGED_OUT_CONFIRMATION_CONTRACT,
  type InstanceHealth,
  type LoggedOutConfirmation,
} from '../../src/fleet/health-poller.ts';

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

type AlertMockCall = [string, string, ...unknown[]];
type AlertCriticalAsset = {
  failure?: {
    code?: string;
    confidence?: string;
  };
};

type LoggedOutConfirmationContract = {
  confirmed: boolean;
  weak: boolean;
  reason: string;
  failureCode: string;
  confidence: 'confirmed' | 'inferred' | 'ambiguous';
  evidence: string;
};
const loggedOutConfirmationContract: LoggedOutConfirmation extends LoggedOutConfirmationContract ? true : false = true;
void loggedOutConfirmationContract;

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

type PollerPrivate = { poll(): Promise<void> };
function privatePoll(p: HealthPoller): Promise<void> {
  return (p as unknown as PollerPrivate).poll();
}

function findAlertEvidence(instance: string, source: string): string {
  const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
    ([i, s]) => i === instance && s === source,
  );
  return String(call?.[3] ?? '');
}

function findAlertCriticalAsset(instance: string, source: string): AlertCriticalAsset | undefined {
  const call = (alertFns.emitAlert.mock.calls as unknown as AlertMockCall[]).find(
    ([i, s]) => i === instance && s === source,
  );
  return call?.[5] as AlertCriticalAsset | undefined;
}

describe('HealthPoller — branch coverage supplement #2', () => {
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

  describe('logged-out confirmation contract', () => {
    it('pins the named confirmation result fields and known reason/failure-code set', () => {
      expect(Object.isFrozen(LOGGED_OUT_CONFIRMATION_CONTRACT)).toBe(true);
      expect(Object.isFrozen(LOGGED_OUT_CONFIRMATION_CONTRACT.requiredFields)).toBe(true);
      expect(Object.isFrozen(LOGGED_OUT_CONFIRMATION_CONTRACT.reasons)).toBe(true);
      expect(Object.isFrozen(LOGGED_OUT_CONFIRMATION_CONTRACT.failureCodes)).toBe(true);
      expect(LOGGED_OUT_CONFIRMATION_CONTRACT.requiredFields).toEqual([
        'confirmed',
        'weak',
        'reason',
        'failureCode',
        'confidence',
        'evidence',
      ]);
      expect(LOGGED_OUT_CONFIRMATION_CONTRACT.reasons).toEqual([
        'explicit_auth_loss',
        'connected',
        'not_weak_signal',
        'weak_signal_inside_settle_grace',
        'weak_signal_waiting_for_persistence',
        'weak_signal_persisted',
      ]);
      expect(LOGGED_OUT_CONFIRMATION_CONTRACT.failureCodes).toEqual([
        'WA_AUTH_BOND_SERVER_REVOKED',
        'WEAK_LOGGED_OUT_SIGNAL',
        'NONE',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Line 536/541/542: explicit-logout evidence `?? 'unknown'` fallback arms.
  // An explicit logout (last_disconnect_reason=loggedOut) with the connection
  // STATE / reconnect_phase / reconnect_attempts fields ABSENT exercises the
  // right-hand 'unknown' arms of those nullish-coalescing template fragments.
  // -------------------------------------------------------------------------
  describe('explicit logged-out evidence: missing connection fields fall back to "unknown"', () => {
    it('emits state=unknown, reconnect_phase=unknown, reconnect_attempts=unknown', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'unhealthy',
          whatsapp: {
            connected: false,
            connection: {
              // state, reconnect_phase, reconnect_attempts deliberately absent
              last_disconnect_reason: 'loggedOut',
            },
          },
        }),
      });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
      const evidence = findAlertEvidence('remote-1', 'instance_logged_out');
      expect(evidence).toContain('state=unknown');
      expect(evidence).toContain('reconnect_phase=unknown');
      expect(evidence).toContain('reconnect_attempts=unknown');
    });
  });

  // -------------------------------------------------------------------------
  // Line 576/580: weak-signal-persistence evidence fallbacks. After the weak
  // logged-out signal persists for WEAK_LOGGED_OUT_POLLS samples, the final
  // evidence builder runs. With connection.state ABSENT and uptime_seconds
  // present, line 576 (`state ?? 'unknown'`) takes the fallback arm and line
  // 580 (`uptimeSeconds === null ? 'unknown' : String(...)`) takes the
  // String(...) arm.
  // -------------------------------------------------------------------------
  describe('weak logged-out persistence: state fallback with known uptime', () => {
    it('promotes to logged_out after 3 weak polls and records state=unknown', async () => {
      // weak signal: connected=false, reconnect_phase=backoff, reconnect_attempts=0,
      // uptime past the 60s settle grace, no explicit disconnect evidence, state absent.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'healthy',
          uptime_seconds: 600,
          whatsapp: {
            connected: false,
            connection: {
              // state deliberately absent
              reconnect_phase: 'backoff',
              reconnect_attempts: 0,
            },
          },
        }),
      });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));

      // First two polls are weak (waiting for persistence), third promotes.
      await privatePoll(poller);
      expect(poller.getStatus('remote-1')!.status).not.toBe('logged_out');
      await privatePoll(poller);
      await privatePoll(poller);

      expect(poller.getStatus('remote-1')!.status).toBe('logged_out');
      const evidence = findAlertEvidence('remote-1', 'instance_logged_out');
      expect(evidence).toContain('state=unknown');
      expect(evidence).toContain('uptime_seconds=600');
      expect(evidence).toContain('weak_signal_polls=3');
      expect(findAlertCriticalAsset('remote-1', 'instance_logged_out')?.failure).toMatchObject({
        code: 'WEAK_LOGGED_OUT_SIGNAL',
        confidence: 'probable',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Line 744: readNumber — a non-empty string that does NOT parse to a finite
  // number falls through the `if (Number.isFinite(parsed))` guard and returns
  // null. Drive it via uptime_seconds on a weak-signal body so the value flows
  // through classifyLoggedOutSignal -> readNumber.
  // -------------------------------------------------------------------------
  describe('readNumber: non-numeric uptime string yields null (settle grace applies)', () => {
    it('treats uptime_seconds="not-a-number" as unknown uptime', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'healthy',
          uptime_seconds: 'not-a-number',
          whatsapp: {
            connected: false,
            connection: {
              state: 'reconnecting',
              reconnect_phase: 'backoff',
              reconnect_attempts: 0,
            },
          },
        }),
      });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      // uptime parsed to null -> inside settle grace -> not logged_out yet, weak.
      expect(poller.getStatus('remote-1')!.status).not.toBe('logged_out');
    });
  });

  // -------------------------------------------------------------------------
  // Line 379: non-OK auth-failure response (401) whose body is NOT valid JSON.
  // readHealthBody returns null, so `failureHealth ?? { status: 'degraded' }`
  // takes the right-hand fallback arm in the updateDegraded call.
  // -------------------------------------------------------------------------
  describe('401 with unparseable body: degraded fallback health object', () => {
    it('marks degraded using the synthesised { status: "degraded" } health', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.reject(new SyntaxError('not json')),
      });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const status = poller.getStatus('remote-1')!;
      expect(status.status).toBe('degraded');
      expect(status.health).toEqual({ status: 'degraded' });
    });
  });

  // -------------------------------------------------------------------------
  // Line 419-421: HTTP 200 body that is NOT caught by the loggedOutSignal
  // heuristic but IS classified as logged_out by classifyHealthSnapshot. This
  // exercises the `classification.status === 'logged_out'` arm on the 200 path
  // (distinct from the loggedOutSignal.confirmed arm).
  // -------------------------------------------------------------------------
  describe('200-OK body classified logged_out by snapshot (not heuristic)', () => {
    it('routes through updateFromHealthSnapshot for a logged_out classification', async () => {
      // classifyHealthSnapshot normalises disconnect reasons, so the hyphenated
      // 'logged-out' satisfies its explicitAuthLossSignal. The poller-level
      // classifyLoggedOutSignal uses an EXACT `=== 'loggedOut'` test that this
      // value does NOT match, and with uptime absent the weak path stays inside
      // the settle grace — so the loggedOutSignal heuristic returns not-loggedOut
      // and control reaches the `classification.status === 'logged_out'` arm.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          status: 'healthy',
          whatsapp: {
            connected: false,
            connection: {
              state: 'reconnecting',
              reconnect_phase: 'backoff',
              reconnect_attempts: 0,
              last_disconnect_reason: 'logged-out',
            },
          },
        }),
      });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      await privatePoll(poller);

      const status = poller.getStatus('remote-1')!;
      expect(status.status).toBe('logged_out');
      expect(status.statusReason).toBe('whatsapp_auth_loss_with_disconnect_corroboration');
    });
  });

  // -------------------------------------------------------------------------
  // Line 722/723: redactEvidenceString PHONE_LIKE_RE arms not covered by the
  // first supplement.
  //   722 binary#1: candidate WITHOUT a leading '+' (left arm false) forces the
  //     right arm `/[\s().-]/.test(candidate)` to be evaluated.
  //   723 cond#1: a separator-bearing candidate whose stripped digit count is
  //     OUTSIDE the [10,15] range returns the original match (no redaction).
  // -------------------------------------------------------------------------
  describe('redactEvidenceString: separator phone without + prefix', () => {
    function loggedOutWithMessage(message: string): Record<string, unknown> {
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
          credential_lifecycle: {
            lastDisconnectDiagnostic: { message },
          },
        },
      };
    }

    function evidenceFor(message: string): Promise<string> {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(loggedOutWithMessage(message)) });
      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}));
      return privatePoll(poller).then(() => findAlertEvidence('remote-1', 'instance_logged_out'));
    }

    it('redacts a 10-digit space-separated number that has no + prefix', async () => {
      // No '+' -> startsWith('+') false -> /[\s().-]/ test arm runs; 10 digits
      // with separators -> hasPhoneSyntax true and digits in range -> redacted.
      const evidence = await evidenceFor('seen number 555 123 4567 in logs');
      expect(evidence).toContain('[REDACTED_PHONE]');
      expect(evidence).not.toContain('555 123 4567');
    });

    it('does not redact a separator digit run shorter than 10 digits', async () => {
      // Has separators (phone syntax) but only 8 digits -> outside [10,15] ->
      // the conditional returns the original match (cond arm 1).
      const evidence = await evidenceFor('ref 12 34 56 78 here');
      expect(evidence).not.toContain('[REDACTED_PHONE]');
    });
  });

  // -------------------------------------------------------------------------
  // Line 1089 cond#0: hasVerifiedRelinkRecovery hash resolution prefers the
  // string `creds.hash` over `creds.sha256`. Reached when empty_hash is NOT
  // false (so the hash-integrity block runs) and creds.hash is a non-empty
  // string that is not a prefix of the canonical empty-creds SHA-256.
  // -------------------------------------------------------------------------
  describe('hasVerifiedRelinkRecovery: string creds.hash resolved over sha256', () => {
    it('accepts recovery when empty_hash is null and creds.hash is a real digest', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({
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
        }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              creds: {
                exists: true,
                size: 512,
                mtime: '2026-05-20T12:00:05.000Z',
                // empty_hash null -> integrity block runs; hash is a real digest
                empty_hash: null,
                hash: 'fa'.repeat(20),
                sha256: 'sha256-should-not-be-used',
              },
            },
          },
          outbound_sends: { latest_successful_send_at: '2026-05-20T12:00:10.000Z' },
        }) });

      const instances = makeInstances(['remote-1', makeInstance()]);
      const poller = new HealthPoller(() => instances, 'self', vi.fn().mockReturnValue({}), 1_000);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(
        (alertFns.clearAlertSource.mock.calls as unknown as AlertMockCall[]).some(
          ([i, s]) => i === 'remote-1' && s === 'instance_logged_out',
        ),
      ).toBe(true);
      poller.stop();
    });
  });
});

// NOTE: readNonNegativeEnvInt (lines 51/53) is evaluated once at module load
// against the live env and its result (INSTANCE_UNREACHABLE_ALERT_DWELL_MS) is
// not exported, so its parse-failure / negative / non-finite arms are not
// observable through the public surface. Left as a documented residual rather
// than asserting on an unexported constant via a fragile re-import.
