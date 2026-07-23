import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeInstance(): InstanceHealth {
  return {
    name: 'remote-1',
    type: 'chat',
    accessMode: 'open',
    healthPort: 9100,
    dbPath: '/tmp/whatsoup-test-instance.db',
    healthToken: null,
  };
}

type ExpectedReason =
  | 'health_body_unrecognized'
  | 'health_body_incomplete'
  | 'health_body_type_error'
  | 'health_poll_failed_transient';

interface FuzzRow {
  row: string;
  kind: 'json' | 'garbage';
  body?: unknown;
  expectedConfidence: 'ambiguous' | 'inferred';
  expectedReason: ExpectedReason;
}

const STALE_TS = '2020-01-01T00:00:00.000Z';
const JID = 'redacted-account@s.whatsapp.net';
const NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

function canonicalHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const whatsappOverrides = typeof overrides.whatsapp === 'object' && overrides.whatsapp !== null
    ? overrides.whatsapp as Record<string, unknown>
    : {};
  const connectionOverrides = typeof whatsappOverrides.connection === 'object' && whatsappOverrides.connection !== null
    ? whatsappOverrides.connection as Record<string, unknown>
    : {};
  return {
    status: 'healthy',
    generated_at: NOW_ISO,
    runtime: {},
    ...overrides,
    whatsapp: {
      connected: true,
      account_jid: JID,
      ...whatsappOverrides,
      connection: {
        state: 'connected',
        reconnect_phase: null,
        reconnect_attempts: 0,
        last_disconnect_reason: null,
        last_status_code: null,
        auth_failure_class: 'none',
        recent_disconnects: {
          count: 0,
          degraded_threshold: 3,
          window_ms: 600_000,
          last_at: null,
          last_reason: null,
          last_status_code: null,
        },
        ...connectionOverrides,
      },
    },
  };
}
const ROWS: FuzzRow[] = [
  {
    row: 'empty_object',
    kind: 'json',
    body: {},
    expectedConfidence: 'ambiguous',
    expectedReason: 'health_body_unrecognized',
  },
  {
    row: 'status_number_42',
    kind: 'json',
    body: { status: 42 },
    expectedConfidence: 'ambiguous',
    expectedReason: 'health_body_type_error',
  },
  {
    row: 'status_online_stale_timestamps',
    kind: 'json',
    body: { status: 'online', last_message_at: STALE_TS, heartbeat_at: STALE_TS },
    expectedConfidence: 'ambiguous',
    expectedReason: 'health_body_unrecognized',
  },
  {
    row: 'whatsapp_connected_string_true',
    kind: 'json',
    body: {
      status: 'healthy',
      whatsapp: {
        connected: 'true',
        account_jid: JID,
        connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0 },
      },
    },
    expectedConfidence: 'ambiguous',
    expectedReason: 'health_body_type_error',
  },
  {
    row: 'missing_whatsapp_block',
    kind: 'json',
    body: { status: 'healthy' },
    expectedConfidence: 'ambiguous',
    expectedReason: 'health_body_incomplete',
  },
  {
    row: 'missing_runtime_block_but_whatsapp_healthy',
    kind: 'json',
    body: {
      status: 'healthy',
      whatsapp: {
        connected: true,
        account_jid: JID,
        connection: { state: 'connected', reconnect_phase: null, reconnect_attempts: 0 },
      },
    },
    expectedConfidence: 'ambiguous',
    expectedReason: 'health_body_incomplete',
  },
  {
    row: 'http200_non_json_garbage_body',
    kind: 'garbage',
    expectedConfidence: 'inferred',
    expectedReason: 'health_poll_failed_transient',
  },
  {
    row: 'top_level_connected_true_no_jid',
    kind: 'json',
    body: { connected: true },
    expectedConfidence: 'ambiguous',
    expectedReason: 'health_body_unrecognized',
  },
  {
    row: 'top_level_state_connecting',
    kind: 'json',
    body: { state: 'connecting' },
    expectedConfidence: 'ambiguous',
    expectedReason: 'health_body_unrecognized',
  },
  {
    row: 'empty_whatsapp_object',
    kind: 'json',
    body: { whatsapp: {} },
    expectedConfidence: 'ambiguous',
    expectedReason: 'health_body_incomplete',
  },
];

describe('health snapshot schema fuzz', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function pollJson(body: Record<string, unknown>) {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    const poller = new HealthPoller(
      () => new Map([['remote-1', makeInstance()]]),
      'self',
      vi.fn().mockReturnValue({}),
    );

    await (poller as unknown as { poll(): Promise<void> }).poll();
    return poller.getStatus('remote-1');
  }

  it.each(ROWS)('$row fails closed with the exact classification', async (row) => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: row.kind === 'garbage'
        ? () => Promise.reject(new SyntaxError('Unexpected token < in JSON'))
        : () => Promise.resolve(row.body),
    });
    const poller = new HealthPoller(
      () => new Map([['remote-1', makeInstance()]]),
      'self',
      vi.fn().mockReturnValue({}),
    );

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(poller.getStatus('remote-1')).toMatchObject({
      status: 'degraded',
      statusConfidence: row.expectedConfidence,
      statusReason: row.expectedReason,
    });
  });

  it('accepts a complete canonical body with a fresh generated_at timestamp', async () => {
    await expect(pollJson(canonicalHealth())).resolves.toMatchObject({
      status: 'online',
      statusConfidence: 'confirmed',
      statusReason: 'health_body_ok',
    });
  });

  it('rejects a complete canonical body older than the 30-second freshness window', async () => {
    const status = await pollJson(canonicalHealth({
      generated_at: new Date(NOW_MS - 30_001).toISOString(),
    }));

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_unrecognized',
    });
    expect(status?.statusEvidence).toEqual(expect.arrayContaining([
      'generated_at_age_ms=30001',
      'generated_at_max_age_ms=30000',
    ]));
  });

  it('classifies a missing generated_at timestamp as incomplete', async () => {
    const body = canonicalHealth();
    delete body.generated_at;

    const status = await pollJson(body);

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_incomplete',
    });
    expect(status?.statusEvidence).toContain('schema_incomplete_fields=generated_at');
  });

  it.each([
    ['wrong type', 42],
    ['unparseable string', 'not-a-timestamp'],
  ])('classifies a generated_at %s as a type error', async (_case, generatedAt) => {
    const status = await pollJson(canonicalHealth({ generated_at: generatedAt }));

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_type_error',
    });
    expect(status?.statusEvidence).toContain('schema_type_errors=generated_at');
  });

  it('rejects generated_at beyond the five-second future-skew allowance', async () => {
    const status = await pollJson(canonicalHealth({
      generated_at: new Date(NOW_MS + 5_001).toISOString(),
    }));

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_unrecognized',
    });
    expect(status?.statusEvidence).toEqual(expect.arrayContaining([
      'generated_at_age_ms=-5001',
      'generated_at_max_future_skew_ms=5000',
    ]));
  });

  it.each([
    'pairing_required',
    'serverside_logout_irreversible',
  ])('preserves logged-out precedence for terminal auth failure %s', async (authFailureClass) => {
    const body = canonicalHealth();
    const whatsapp = body.whatsapp as Record<string, unknown>;
    const connection = whatsapp.connection as Record<string, unknown>;
    connection.auth_failure_class = authFailureClass;

    const status = await pollJson(body);

    expect(status).toMatchObject({
      status: 'logged_out',
      statusConfidence: 'confirmed',
      statusReason: 'instance_logged_out',
    });
    expect(status?.statusEvidence).toContain(`auth_failure_class=${authFailureClass}`);
  });

  it.each([
    'local_corruption_restorable',
    'local_corruption_unrestorable',
    'auth_bond_at_risk',
  ])('rejects a healthy body carrying known non-none auth failure %s', async (authFailureClass) => {
    const body = canonicalHealth();
    const whatsapp = body.whatsapp as Record<string, unknown>;
    const connection = whatsapp.connection as Record<string, unknown>;
    connection.auth_failure_class = authFailureClass;

    const status = await pollJson(body);

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_unrecognized',
    });
    expect(status?.statusEvidence).toContain(
      `health_body_conflicts=auth_failure_class=${authFailureClass}`,
    );
  });

  it('classifies missing auth_failure_class as incomplete', async () => {
    const body = canonicalHealth();
    const whatsapp = body.whatsapp as Record<string, unknown>;
    const connection = whatsapp.connection as Record<string, unknown>;
    delete connection.auth_failure_class;

    const status = await pollJson(body);

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_incomplete',
    });
    expect(status?.statusEvidence).toContain(
      'schema_incomplete_fields=whatsapp.connection.auth_failure_class',
    );
  });

  it.each([
    ['null', null],
    ['blank', '   '],
  ])('classifies %s auth_failure_class as incomplete', async (_case, authFailureClass) => {
    const body = canonicalHealth();
    const whatsapp = body.whatsapp as Record<string, unknown>;
    const connection = whatsapp.connection as Record<string, unknown>;
    connection.auth_failure_class = authFailureClass;

    const status = await pollJson(body);

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_incomplete',
    });
    expect(status?.statusEvidence).toContain(
      'schema_incomplete_fields=whatsapp.connection.auth_failure_class',
    );
  });

  it('classifies an unknown nonempty auth_failure_class as unrecognized', async () => {
    const body = canonicalHealth();
    const whatsapp = body.whatsapp as Record<string, unknown>;
    const connection = whatsapp.connection as Record<string, unknown>;
    connection.auth_failure_class = 'future_auth_failure';

    const status = await pollJson(body);

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_unrecognized',
    });
    expect(status?.statusEvidence).toEqual(expect.arrayContaining([
      'auth_failure_class=future_auth_failure',
      'schema_unrecognized_fields=whatsapp.connection.auth_failure_class',
    ]));
  });

  it('rejects a healthy body whose recent disconnect count crosses its threshold', async () => {
    const body = canonicalHealth();
    const whatsapp = body.whatsapp as Record<string, unknown>;
    const connection = whatsapp.connection as Record<string, unknown>;
    const recent = connection.recent_disconnects as Record<string, unknown>;
    recent.count = 3;

    const status = await pollJson(body);

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'health_body_unrecognized',
    });
    expect(status?.statusEvidence).toContain(
      'health_body_conflicts=recent_disconnect_count=3>=degraded_threshold=3',
    );
  });

  it.each([
    ['last_disconnect_reason', 'connection', 'last_disconnect_reason', 42],
    ['last_status_code', 'connection', 'last_status_code', '401'],
    ['last_status_code negative', 'connection', 'last_status_code', -1],
    ['last_status_code fractional', 'connection', 'last_status_code', 401.5],
    ['auth_failure_class', 'connection', 'auth_failure_class', false],
    ['recent_disconnects', 'connection', 'recent_disconnects', []],
    ['recent_disconnects.count', 'recent', 'count', '0'],
    ['recent_disconnects.count negative', 'recent', 'count', -1],
    ['recent_disconnects.count fractional', 'recent', 'count', 0.5],
    ['recent_disconnects.degraded_threshold', 'recent', 'degraded_threshold', '3'],
    ['recent_disconnects.degraded_threshold zero', 'recent', 'degraded_threshold', 0],
    ['recent_disconnects.degraded_threshold negative', 'recent', 'degraded_threshold', -1],
    ['recent_disconnects.degraded_threshold fractional', 'recent', 'degraded_threshold', 3.5],
    ['recent_disconnects.window_ms', 'recent', 'window_ms', '600000'],
    ['recent_disconnects.window_ms zero', 'recent', 'window_ms', 0],
    ['recent_disconnects.window_ms negative', 'recent', 'window_ms', -1],
    ['recent_disconnects.window_ms fractional', 'recent', 'window_ms', 600_000.5],
    ['recent_disconnects.last_at', 'recent', 'last_at', 'not-a-timestamp'],
    ['recent_disconnects.last_reason', 'recent', 'last_reason', false],
    ['recent_disconnects.last_status_code', 'recent', 'last_status_code', '440'],
    ['recent_disconnects.last_status_code negative', 'recent', 'last_status_code', -1],
    ['recent_disconnects.last_status_code fractional', 'recent', 'last_status_code', 440.5],
    ['reconnect_attempts negative', 'connection', 'reconnect_attempts', -1],
    ['reconnect_attempts fractional', 'connection', 'reconnect_attempts', 0.5],
  ] as const)(
    'classifies malformed diagnostic %s as a type error',
    async (_case, target, field, value) => {
      const body = canonicalHealth();
      const whatsapp = body.whatsapp as Record<string, unknown>;
      const connection = whatsapp.connection as Record<string, unknown>;
      if (target === 'recent') {
        const recent = connection.recent_disconnects as Record<string, unknown>;
        recent[field] = value;
      } else {
        connection[field] = value;
      }

      const status = await pollJson(body);

      expect(status).toMatchObject({
        status: 'degraded',
        statusConfidence: 'ambiguous',
        statusReason: 'health_body_type_error',
      });
      expect(status?.statusEvidence.join(' ')).toContain(`schema_type_errors=whatsapp.connection.${_case.replace(' zero', '').replace(' negative', '').replace(' fractional', '')}`);
    },
  );

  it('preserves corroborated logged-out precedence over an unrelated malformed diagnostic', async () => {
    const body = canonicalHealth({
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
          recent_disconnects: {
            count: 'malformed',
            degraded_threshold: 3,
            window_ms: 600_000,
            last_at: null,
            last_reason: null,
            last_status_code: null,
          },
        },
      },
    });

    const status = await pollJson(body);

    expect(status).toMatchObject({
      status: 'logged_out',
      statusConfidence: 'confirmed',
      statusReason: 'instance_logged_out',
    });
    expect(status?.statusEvidence.join(' ')).toContain('last_status_code=401');
  });

  it('preserves explicit unhealthy precedence while recording malformed optional diagnostics', async () => {
    const body = canonicalHealth({
      status: 'unhealthy',
      whatsapp: {
        connected: false,
        account_jid: 'not connected',
        connection: {
          state: 'disconnected',
          reconnect_phase: null,
          reconnect_attempts: 1,
          last_disconnect_reason: 42,
          last_status_code: null,
          auth_failure_class: 'none',
          recent_disconnects: {
            count: 0,
            degraded_threshold: 3,
            window_ms: 600_000,
            last_at: null,
            last_reason: null,
            last_status_code: null,
          },
        },
      },
    });

    const status = await pollJson(body);

    expect(status).toMatchObject({
      status: 'degraded',
      statusConfidence: 'confirmed',
      statusReason: 'health_body_unhealthy',
    });
    expect(status?.statusEvidence.join(' ')).toContain(
      'schema_type_errors=whatsapp.connection.last_disconnect_reason',
    );
  });
});
