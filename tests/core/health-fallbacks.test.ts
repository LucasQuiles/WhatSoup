import { healthLogger, httpReq, TEST_HEALTH_TOKEN, healthReq, buildTestServer, makeDb, makeDeps, makeAuthBond } from './_helpers/health.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { Database } from '../../src/core/database.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Additional branch coverage — uncovered paths
// ---------------------------------------------------------------------------

describe('GET /health — branch coverage: empty-body safeDbQuery fallbacks and null guards', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
  });

  afterEach(async () => {
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (db) db.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('safeDbQuery returns fallback when the callback throws', async () => {
    // Drop schema_migrations so the COALESCE query still works but messages table breaks
    db.raw.exec('DROP TABLE messages');
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await healthReq(port);
    // Doesn't crash — returns fallback 0 for messages_total
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.sqlite.messages_total).toBe(0);
  });

  it('returns zero messages_total when messages table returns null row', async () => {
    // db is intact, just no messages
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    expect(JSON.parse(body).sqlite.messages_total).toBe(0);
  });

  it('sets probeAvailability.messages=false when messages query fails (#2514)', async () => {
    db.raw.exec('DROP TABLE messages');
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);

    // Failing probe → availability=false, value is fallback (distinguishable from empty)
    expect(json.sqlite.probe_availability.messages).toBe(false);
    expect(json.sqlite.messages_total).toBe(0);
  });

  it('sets probeAvailability.messages=true when messages query succeeds (#2514)', async () => {
    // Intact db — empty messages table succeeds
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);

    // Successful probe → availability=true, value is measured zero
    expect(json.sqlite.probe_availability.messages).toBe(true);
    expect(json.sqlite.messages_total).toBe(0);
  });

  it('schema_not_ready path is unchanged (#2514 no-regression)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);

    // schema_ready and schema_not_ready must still be present
    expect(json.sqlite).toHaveProperty('schema_ready');
    expect(json.sqlite).toHaveProperty('schema_migration_required');
    expect(json.sqlite).toHaveProperty('probe_availability');
  });

  it('classifies "cooldown" connection state as recovering (degraded not unhealthy)', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'cooldown',
          connected: false,
          reconnectAttempts: 5,
          reconnectPhase: 'cooldown',
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: '2026-06-09T12:00:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          recentDisconnects: {
            windowMs: 600_000,
            count: 0,
            lastAt: null,
            lastReason: null,
            lastStatusCode: null,
            byReason: {},
          },
          credentialLifecycle: null,
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('degraded');
    expect(JSON.parse(body).whatsapp.connection.state).toBe('cooldown');
    db2.close();
  });

  it('classifies device_removed reason as serverside_logout_irreversible', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'disconnected',
          connected: false,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: '2026-06-09T12:00:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: 'device_removed_all',
          lastStatusCode: null,
          recentDisconnects: {
            windowMs: 600_000,
            count: 0,
            lastAt: null,
            lastReason: null,
            lastStatusCode: null,
            byReason: {},
          },
          credentialLifecycle: null,
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.whatsapp.connection.auth_failure_class).toBe('serverside_logout_irreversible');
    db2.close();
  });

  it('classifies multidevice_mismatch disconnect when status code indicates it', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'reconnecting',
          connected: false,
          reconnectAttempts: 1,
          reconnectPhase: 'retry',
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: '2026-06-09T12:00:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: 'deviceReplaced',
          lastStatusCode: 411,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastQrAt: null,
            lastOpenAt: '2026-06-09T11:00:00.000Z',
          },
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connection.disconnect_class).toBe('multidevice_mismatch');
    db2.close();
  });

  it('exposes empty_hash true when auth bond creds sha256 matches the empty-file SHA', async () => {
    db.close();
    const db2 = makeDb();
    const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          authBond: makeAuthBond({
            creds: {
              path: '/auth/creds.json',
              exists: true,
              mode: '600',
              size: 0,
              mtime: '2026-06-09T12:00:00.000Z',
              sha256: EMPTY_SHA256,
            },
          }),
          credentialLifecycle: { lastQrAt: null, lastOpenAt: '2026-06-09T12:00:00.000Z' },
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.whatsapp.auth_bond.creds.empty_hash).toBe(true);
    db2.close();
  });

  it('isFreshInvalidCredentialWriteInFlight returns false when creds have no mtime', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T12:00:05Z'));
    try {
      db.close();
      const db2 = makeDb();
      const deps = makeDeps(db2, {
        connectionManager: {
          botJid: '15550199000@s.whatsapp.net',
          botLid: null,
          sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
          sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          getConnectionState: vi.fn().mockReturnValue({
            state: 'connected',
            connected: true,
            reconnectAttempts: 0,
            reconnectPhase: null,
            stateChangedAt: '2026-06-09T12:00:00.000Z',
            firstFailureAt: null,
            lastPingAt: null,
            lastPongAt: null,
            lastDisconnectReason: null,
            lastStatusCode: null,
            authBond: makeAuthBond({
              status: 'invalid',
              issues: ['creds_json_empty'],
              creds: {
                path: '/auth/creds.json',
                exists: true,
                mode: '600',
                size: 0,
                mtime: null, // no mtime — grace window cannot apply
                sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              },
            }),
          }),
        },
      } as any);
      ({ server, port } = await buildTestServer(deps));

      const { status, body } = await healthReq(port);
      const json = JSON.parse(body);
      // Not in grace window → classified as local_corruption (backup present → restorable)
      expect(status).toBe(200);
      expect(json.whatsapp.connection.auth_failure_class).toBe('local_corruption_restorable');
      db2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('isFreshInvalidCredentialWriteInFlight returns false when mtime is non-parseable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T12:00:05Z'));
    try {
      db.close();
      const db2 = makeDb();
      const deps = makeDeps(db2, {
        connectionManager: {
          botJid: '15550199000@s.whatsapp.net',
          botLid: null,
          sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
          sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          getConnectionState: vi.fn().mockReturnValue({
            state: 'connected',
            connected: true,
            reconnectAttempts: 0,
            reconnectPhase: null,
            stateChangedAt: '2026-06-09T12:00:00.000Z',
            firstFailureAt: null,
            lastPingAt: null,
            lastPongAt: null,
            lastDisconnectReason: null,
            lastStatusCode: null,
            authBond: makeAuthBond({
              status: 'invalid',
              issues: ['creds_json_invalid_json'],
              creds: {
                path: '/auth/creds.json',
                exists: true,
                mode: '600',
                size: 2,
                mtime: 'not-a-date', // NaN from Date.parse
                sha256: 'a'.repeat(64),
              },
            }),
          }),
        },
      } as any);
      ({ server, port } = await buildTestServer(deps));

      const { status, body } = await healthReq(port);
      const json = JSON.parse(body);
      // Non-finite mtime → not in grace window → local_corruption
      expect(status).toBe(200);
      expect(json.whatsapp.connection.auth_failure_class).toBe('local_corruption_restorable');
      db2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizeAgentTurnCapability returns null when details has no turnCapability key', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            // No turnCapability field
            activeSessions: 2,
          },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // No turnCapability → null
    expect(json.turn_capability).toBeNull();
    db2.close();
  });

  it('agentRuntimeDetailsForHealth passes through details unchanged when turnCapability is null', async () => {
    db.close();
    const db2 = makeDb();
    // Provide a runtime snapshot with a turnCapability key but non-record value
    // so normalizeAgentTurnCapability returns null, then agentRuntimeDetailsForHealth
    // substitutes null (the turnCapability: null branch)
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: 'not-a-record', // passes !isRecord → normalizeAgentTurnCapability returns null
            activeSessions: 1,
          },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.turn_capability).toBeNull();
    // turnCapability key present in details but non-record → substituted with null
    expect(json.runtime.agent.turnCapability).toBeNull();
    db2.close();
  });

  it('runtime snapshot degraded does NOT override an already-degraded status', async () => {
    // The snap.status === 'degraded' && status === 'healthy' branch:
    // if status is already 'degraded' (not 'healthy'), that branch is skipped
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      getEnrichmentStats: vi.fn().mockReturnValue({
        lastRun: '2000-01-01T00:00:00.000Z', // stale → status becomes 'degraded' before runtimeBlock
        unprocessed: 0,
        runtimeDegraded: false,
      }),
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'degraded',
          details: { turnCapability: null, activeSessions: 1 },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('degraded');
    db2.close();
  });

  it('chat runtime runtimeBlock uses zero when queue fields are absent', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'chat',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          // No queue key in details → activeChats/queuedChats both undefined
          details: {},
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.runtime.chat.queueDepth).toBe(0);
    db2.close();
  });

  it('fallbackState null fields resolve to null/false in instance block', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: { activeSessions: 1 },
        }),
        getFallbackState: () => ({
          effectiveProvider: 'claude',
          fallbackActiveUntil: null,
          fallbackReason: null,    // → null branch
          fallbackModel: null,     // → null branch
          fallbackResetAt: null,   // → null branch
          fallbackRecoveryProbeRequired: null, // → false branch
        }),
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.instance.effectiveProvider).toBe('claude');
    expect(json.instance.fallbackReason).toBeNull();
    expect(json.instance.fallbackModel).toBeNull();
    expect(json.instance.fallbackResetAt).toBeNull();
    expect(json.instance.fallbackRecoveryProbeRequired).toBe(false);
    db2.close();
  });
});

describe('GET /health — normalizeBooleanOrNull and normalizeNumberOrNull non-type paths', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
  });

  afterEach(async () => {
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (db) db.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('normalizes non-boolean modelUsable and non-finite lastSuccessfulTurnAt to null', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: 'yes',        // non-boolean → null
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: Infinity, // non-finite → null
              lastTurnErrorClass: null,
              lastTurnErrorAt: NaN,      // non-finite → null
            },
          },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.turn_capability).toEqual({
      model_usable: null,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'usable',
      periodic_probe_expected: null,
      periodic_probe_backoff_multiple: null,
      model_usable_freshness_ms: null,
      next_probe_due_at: null,
      last_successful_turn_at: null,
      last_successful_turn_provider: null,
      last_successful_turn_model: null,
      last_successful_turn_session_current: null,
      primary_model: null,
      last_turn_error_class: null,
      last_turn_error_at: null,
    });
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// health.ts lower-branch coverage (74-549)
// ---------------------------------------------------------------------------

describe('health.ts lower-branch coverage (74-549)', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
  });

  afterEach(async () => {
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (db) db.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // --- line 335: formatAuthBond hash nullish branch — creds.sha256 === null.
  //     Snapshot is connected so /health returns 200 (formatAuthBond is reached on
  //     every code path; the disconnected snapshot it was previously written with
  //     mapped to unhealthy/503, which is what the assertion under test cares about).
  it('renders auth_bond.creds.hash as null when creds.sha256 is null (line 335)', async () => {
    const deps = makeDeps(db, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          recentDisconnects: {
            windowMs: 600_000, count: 0, lastAt: null, lastReason: null, lastStatusCode: null, byReason: {},
          },
          authBond: makeAuthBond({
            creds: { path: '/auth/creds.json', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:00:00.000Z', sha256: null },
          }),
          credentialLifecycle: null,
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // Line 335 false branch: `authBond.creds.sha256?.slice(0, 20) ?? null` → null.
    expect(json.whatsapp.auth_bond.creds.hash).toBeNull();
    // empty_hash is `sha256 === EMPTY_SHA256`; null !== EMPTY_SHA256 so false.
    expect(json.whatsapp.auth_bond.creds.empty_hash).toBe(false);
  });

  // --- line 151: normalizeAgentTurnCapability(null) — the `if (!details) return null`
  //     branch. `details` is null when the agent runtime exposes no snapshot (no
  //     `deps.runtime`). We keep `instanceType: 'agent'` so line 909-910 reaches
  //     normalizeAgentTurnCapability with `runtimeSnapshot?.details ?? null` = null.
  it('nulls turn_capability when agent runtime exposes no details (line 151)', async () => {
    const deps = makeDeps(db, {
      instanceType: 'agent',
      // No `runtime` override → deps.runtime is undefined → runtimeSnapshot is null
      // → `runtimeSnapshot?.details ?? null` is null → line 151 `if (!details) return null`.
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // turnCapability is null → not degraded, and the field surfaces as null.
    expect(json.turn_capability).toBeNull();
    // Concrete shape check: the field is present-and-null (not absent), and the
    // handler still produced a well-formed 200 health payload with a string status.
    expect(json).toMatchObject({ turn_capability: null });
    expect(typeof json.status).toBe('string');
  });

  // --- line 431 is structurally unreachable: classifyDisconnect() calls
  //     decideDisconnectAction(statusCode) with NO context, so restartRequiredCount
  //     is always undefined → count 0 → never ≥ 10 → 'restart-required-flapping'
  //     is never returned. Documented below as a "lines not reached" item; we instead
  //     assert the reachable reconnect-classification paths through classifyDisconnect
  //     (line 427) to keep the suite honest without asserting unreachable behaviour.

  // --- line 427 + 431 reachable-coverage note: confirm restartRequired (515) maps to
  //     restart_required and that flapping can never be produced via /health.
  it('maps a restartRequired status code to restart_required (classifyDisconnect reconnect branch, line 427)', async () => {
    const deps = makeDeps(db, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'reconnecting',
          connected: false,
          reconnectAttempts: 1,
          reconnectPhase: 'retry',
          stateChangedAt: '2026-06-09T12:10:00.000Z',
          firstFailureAt: '2026-06-09T12:10:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: 'restartRequired',
          lastStatusCode: 515,
          recentDisconnects: {
            windowMs: 600_000, count: 0, lastAt: null, lastReason: null, lastStatusCode: null, byReason: {},
          },
          authBond: makeAuthBond(),
          credentialLifecycle: null,
        }),
      },
    } as any);
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // Line 427 (action.type === 'reconnect') entered; line 430 (restart-required) returns.
    expect(json.whatsapp.connection.disconnect_class).toBe('restart_required');
  });
});

// ---------------------------------------------------------------------------
// health.ts upper-branch coverage (624-1020)
// ---------------------------------------------------------------------------

describe('health.ts upper-branch coverage (624-1020)', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    // Token is set so requireAuth() runs; each test chooses whether to send
    // the Authorization header. healthReq() sends Bearer TEST_HEALTH_TOKEN.
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
  });

  afterEach(async () => {
    if (db) db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // --- line 624: `if (!requireAuth(req, res)) return;` inside POST /heal.
  //     Token set, no Authorization header → 401 + no heal report stored.
  it('POST /heal rejects with 401 and stores nothing when auth is missing (line 624)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ type: 'service_crash' }),
    );

    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
    const cnt = db.raw
      .prepare('SELECT COUNT(*) AS c FROM pending_heal_reports')
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  // --- line 709: `if (!requireAuth(req, res)) return;` inside POST /access.
  it('POST /access rejects with 401 and writes no access_list row when auth is missing (line 709)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: '15550000001@s.whatsapp.net', action: 'allow' }),
    );

    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
    const cnt = db.raw
      .prepare('SELECT COUNT(*) AS c FROM access_list')
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  // --- line 801: `if (!requireAuth(req, res)) return;` inside POST /mark-read.
  it('POST /mark-read rejects with 401 when auth is missing (line 801)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/mark-read',
      'POST',
      JSON.stringify({ conversation_key: '15550000001@s.whatsapp.net' }),
    );

    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  // --- line 772: the `'blocked' as const` arm of
  //     `action === 'allow' ? 'allowed' as const : 'blocked' as const`.
  //     Existing tests only exercise `allow`; this hits the `block` path and
  //     confirms the access_list row is persisted as `blocked`.
  it('POST /access with action=block stores status "blocked" (line 772 block-branch)', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'group', subjectId: '1111111000000000@g.us', action: 'block' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      ok: true,
      action: 'block',
      subjectType: 'group',
      subjectId: '1111111000000000@g.us',
      result: 'inserted',
    });
    const row = db.raw
      .prepare('SELECT subject_type, subject_id, status FROM access_list WHERE subject_id = ?')
      .get('1111111000000000@g.us');
    expect(row).toEqual({
      subject_type: 'group',
      subject_id: '1111111000000000@g.us',
      status: 'blocked',
    });
  });

  // --- lines 908 + 910: agent-instance path with a REAL runtime snapshot.
  //     `deps.instanceType === 'agent'` AND `deps.runtime` is set, so
  //     runtimeSnapshot is non-null and line 908 reads `runtimeSnapshot.status`
  //     while line 910 calls normalizeAgentTurnCapability(details) with real
  //     details. (The lower-coverage block only reaches 908/910 with a null
  //     snapshot; this exercises the truthy-snapshot branches.)
  it('GET /health surfaces agentRuntimeStatus and turn_capability from a healthy agent runtime snapshot (lines 908, 910, 1020)', async () => {
    const deps = makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: true,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: 1_700_000_000_000,
              lastSuccessfulTurnProvider: 'claude-cli',
              lastSuccessfulTurnSessionCurrent: true,
              lastTurnErrorClass: null,
              lastTurnErrorAt: null,
            },
          },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);

    // Line 908 truthy branch: agentRuntimeStatus === 'healthy' → overall
    // status stays 'healthy' (not unhealthy).
    expect(json.status).toBe('healthy');
    // Line 910 truthy branch: turn_capability was normalized from real details.
    expect(json.turn_capability).toEqual({
      model_usable: true,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'usable',
      periodic_probe_expected: null,
      periodic_probe_backoff_multiple: null,
      model_usable_freshness_ms: null,
      next_probe_due_at: null,
      last_successful_turn_at: 1_700_000_000_000,
      last_successful_turn_provider: 'claude-cli',
      last_successful_turn_model: null,
      last_successful_turn_session_current: true,
      primary_model: null,
      last_turn_error_class: null,
      last_turn_error_at: null,
    });
    // Line 1020 branch: agent runtime block was populated.
    expect(json.runtime).toMatchObject({
      agent: {
        turnCapability: {
          modelUsable: true,
          modelUsabilityStatus: 'usable',
          lastSuccessfulTurnAt: 1_700_000_000_000,
          lastSuccessfulTurnProvider: 'claude-cli',
          lastSuccessfulTurnSessionCurrent: true,
          lastTurnErrorClass: null,
          lastTurnErrorAt: null,
        },
      },
    });
  });

  // --- line 1006: `else if (snap.status === 'degraded' && status === 'healthy')`
  //     — a degraded runtime snapshot downgrades an otherwise-healthy instance
  //     to 'degraded'. Requires an agent/passive/chat instance that is connected
  //     (so the base status computes to 'healthy') plus a runtime reporting
  //     'degraded'.
  it('GET /health downgrades a healthy connection to degraded when the runtime snapshot is degraded (line 1006)', async () => {
    // Base status must compute to 'healthy' (connected socket + migrated db) so
    // that the line-1006 `&& status === 'healthy'` guard is satisfied and the
    // degraded runtime snapshot is what flips the overall status.
    // A 'chat' instance: agentRuntimeStatus is null (agent-only), so a degraded
    // runtime snapshot is NOT folded into the status during the main status
    // computation. The base status therefore stays 'healthy' until line 1006,
    // where snap.status === 'degraded' downgrades it.
    const deps = makeDeps(db, {
      instanceType: 'chat',
      connectionManager: {
        botJid: '15555550123@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-04-05T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
        }),
      } as unknown as ConnectionManager,
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'degraded',
          details: { queue: { activeChats: 0, queuedChats: 0 } },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    // 'degraded' is a 200, not a 503.
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // The connection itself is healthy; only the degraded runtime snapshot
    // downgrades the overall status via line 1006.
    expect(json.whatsapp.connected).toBe(true);
    expect(json.status).toBe('degraded');
    // Concrete: chat runtime block still populated via the line-1011 branch.
    expect(json.runtime).toMatchObject({ chat: { queueDepth: 0 } });
  });

  // --- line 1020 else: a runtime snapshot present but instanceType is none of
  //     passive/chat/agent leaves runtimeBlock as {} (no runtime block emitted).
  it('GET /health leaves runtimeBlock empty for an unrecognized instanceType (line 1020 else)', async () => {
    const deps = makeDeps(db, {
      instanceType: 'primary-line',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: { socket: 'ready' },
        }),
        getFallbackState: () => null,
      } as any,
    });
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // None of passive/chat/agent matched, so runtime stays an empty object.
    expect(json.runtime).toEqual({});
  });

  // #1753 rem-1: in-process event-loop-lag self-probe. A wedged loop makes
  // /health unanswerable, so nothing in THIS handler can detect a wedge in
  // progress — the sampler's own timer gives it a memory of recent lag that
  // survives into whichever request the loop is next free enough to answer.
  // This describe follows the enclosing block's convention: beforeEach only
  // creates `db`; each test builds its own server explicitly.
  describe('#1753 rem-1: event-loop-lag self-probe', () => {
    // This describe's own beforeEach (line ~3674) doesn't clear healthLogger —
    // it wasn't tracked before #1753. Clear it locally so each test here only
    // sees warn calls from its OWN request, not ones left over from a sibling.
    beforeEach(() => {
      healthLogger.warn.mockClear();
    });

    function fakeLoopLagSampler(snapshot: {
      sampleCount: number;
      p95LagMs: number | null;
      locallyStarved: boolean;
      discontinuityCount: number;
    }) {
      // The raw-instrumentation fields (#3253) default to empty/null so the
      // existing scenario call sites stay focused on the starvation contract.
      return {
        start: vi.fn(),
        stop: vi.fn(),
        snapshot: vi.fn().mockReturnValue({
          minLagMs: null,
          medianLagMs: null,
          maxLagMs: null,
          intervalSampleCount: 0,
          snapshotSampleCount: 0,
          lastEluUtilization: null,
          lastCpuDeltaMs: null,
          observerCostMs: 0,
          ...snapshot,
        }),
        // P42: the handler brackets itself with an observer span, so the
        // double has to answer beginObserverSpan like the real sampler.
        beginObserverSpan: vi.fn().mockReturnValue(() => {}),
        recordObserverSpan: vi.fn(),
        rawSamples: vi.fn().mockReturnValue([]),
        rawSamplePage: vi.fn().mockReturnValue({
          oldestSequence: null,
          latestSequence: null,
          nextAfter: 0,
          truncated: false,
          gap: null,
          samples: [],
        }),
      };
    }

    describe('GET /health/event-loop-samples', () => {
      it('requires privileged health auth with no public-envelope fallback', async () => {
        const sampler = fakeLoopLagSampler({
          sampleCount: 0,
          p95LagMs: null,
          locallyStarved: false,
          discontinuityCount: 0,
        });
        ({ server, port } = await buildTestServer(makeDeps(db, { loopLagSampler: sampler as any })));

        const missing = await httpReq(port, '/health/event-loop-samples', 'GET');
        const invalid = await httpReq(
          port,
          '/health/event-loop-samples',
          'GET',
          undefined,
          { Authorization: 'Bearer wrong-token' },
        );

        expect(missing.status).toBe(401);
        expect(invalid.status).toBe(401);
        expect(missing.body).toBe(JSON.stringify({ error: 'Unauthorized' }));
        expect(missing.body).not.toContain('samples');
        expect(sampler.rawSamplePage).not.toHaveBeenCalled();
      });

      it('returns one authenticated immutable page without sampling the loop', async () => {
        const sampler = fakeLoopLagSampler({
          sampleCount: 0,
          p95LagMs: null,
          locallyStarved: false,
          discontinuityCount: 0,
        });
        sampler.rawSamplePage.mockReturnValue({
          oldestSequence: 5,
          latestSequence: 5,
          nextAfter: 5,
          truncated: false,
          gap: null,
          samples: [{
            sequence: 5,
            atMs: 2_500,
            wallAtMs: 1_785_000_002_500,
            lagMs: 2.1254,
            source: 'interval',
            discontinuity: false,
            eluUtilization: 0.25,
            cpuDeltaMs: 1.5,
          }],
        });
        const startedAt = 1_785_000_000_000;
        ({ server, port } = await buildTestServer(makeDeps(db, {
          loopLagSampler: sampler as any,
          startedAt,
        })));

        const response = await httpReq(
          port,
          '/health/event-loop-samples?after=4&limit=1',
          'GET',
          undefined,
          { Authorization: `Bearer ${TEST_HEALTH_TOKEN}` },
        );
        const body = JSON.parse(response.body);

        expect(response.status).toBe(200);
        expect(sampler.rawSamplePage).toHaveBeenCalledExactlyOnceWith({ after: 4, limit: 1 });
        expect(sampler.snapshot).not.toHaveBeenCalled();
        expect(body).toMatchObject({
          schema_version: 'health.event-loop-samples.v1',
          process: { pid: process.pid, started_at_ms: startedAt },
          cadence_ms: 500,
          oldest_sequence: 5,
          latest_sequence: 5,
          next_after: 5,
          truncated: false,
          gap: null,
        });
        expect(body.samples).toEqual([{
          sequence: 5,
          at_ms: 2_500,
          wall_at_ms: 1_785_000_002_500,
          lag_ms: 2.125,
          source: 'interval',
          discontinuity: false,
          elu_utilization: 0.25,
          cpu_delta_ms: 1.5,
        }]);
      });

      it('fails closed on malformed, repeated, or unknown query parameters', async () => {
        const sampler = fakeLoopLagSampler({
          sampleCount: 0,
          p95LagMs: null,
          locallyStarved: false,
          discontinuityCount: 0,
        });
        ({ server, port } = await buildTestServer(makeDeps(db, { loopLagSampler: sampler as any })));
        const headers = { Authorization: `Bearer ${TEST_HEALTH_TOKEN}` };

        for (const [query, code] of [
          ['?after=-1', 'invalid_after'],
          ['?limit=1&limit=2', 'repeated_query_parameter'],
          ['?debug=true', 'unknown_query_parameter'],
        ] as const) {
          const response = await httpReq(
            port,
            `/health/event-loop-samples${query}`,
            'GET',
            undefined,
            headers,
          );
          expect(response.status, query).toBe(400);
          expect(JSON.parse(response.body), query).toEqual({ error: code });
        }
        expect(sampler.rawSamplePage).not.toHaveBeenCalled();
      });

      it('does not route non-GET methods or near-match paths', async () => {
        ({ server, port } = await buildTestServer(makeDeps(db)));
        const headers = { Authorization: `Bearer ${TEST_HEALTH_TOKEN}` };
        expect((await httpReq(port, '/health/event-loop-samples', 'POST', '', headers)).status).toBe(404);
        expect((await httpReq(port, '/health/event-loop-samples/', 'GET', undefined, headers)).status).toBe(404);
      });
    });

    it('exposes a well-shaped event_loop block with the real sampler by default', async () => {
      ({ server, port } = await buildTestServer(makeDeps(db)));

      const { status, body } = await healthReq(port);
      expect(status).toBe(200);
      const json = JSON.parse(body);
      expect(json.event_loop).toMatchObject({
        sample_count: expect.any(Number),
        locally_starved: false,
        starvation_threshold_ms: 250,
        discontinuity_count: expect.any(Number),
      });
      expect(json.event_loop.lag_p95_ms === null || typeof json.event_loop.lag_p95_ms === 'number').toBe(true);
    });

    it('folds a starved sampler snapshot into the event_loop body and degrades status', async () => {
      const sampler = fakeLoopLagSampler({
        sampleCount: 20,
        p95LagMs: 412,
        locallyStarved: true,
        discontinuityCount: 3,
      });
      const deps = makeDeps(db, { loopLagSampler: sampler as any });
      ({ server, port } = await buildTestServer(deps));

      const { status, body } = await healthReq(port);
      const json = JSON.parse(body);
      expect(status).toBe(200); // degraded, not unhealthy — the connection itself is fine
      expect(json.status).toBe('degraded');
      expect(json.event_loop).toEqual({
        lag_p95_ms: 412,
        sample_count: 20,
        locally_starved: true,
        starvation_threshold_ms: 250,
        observer_cost_ms: 0,
        discontinuity_count: 3,
        lag_min_ms: null,
        lag_median_ms: null,
        lag_max_ms: null,
        interval_sample_count: 0,
        snapshot_sample_count: 0,
        elu_utilization: null,
        cpu_delta_ms: null,
        raw_samples: {
          available: true,
          schema_version: 'health.event-loop-samples.v1',
          path: '/health/event-loop-samples',
          oldest_sequence: null,
          latest_sequence: null,
        },
      });
    });

    it('keeps raw samples out of diagnostic health and exposes only bounded discovery metadata', async () => {
      const sampler = fakeLoopLagSampler({
        sampleCount: 2,
        p95LagMs: 12,
        locallyStarved: false,
        discontinuityCount: 0,
      });
      sampler.rawSamplePage.mockReturnValue({
        oldestSequence: 2,
        latestSequence: 161,
        nextAfter: 161,
        truncated: true,
        gap: null,
        samples: [{
          sequence: 161,
          atMs: 80_500,
          wallAtMs: 1_785_000_080_500,
          lagMs: 0,
          source: 'interval',
          discontinuity: false,
          eluUtilization: 0.25,
          cpuDeltaMs: 1.5,
        }],
      });
      const deps = makeDeps(db, { loopLagSampler: sampler as any });
      ({ server, port } = await buildTestServer(deps));

      const { status, body } = await healthReq(port);
      expect(status).toBe(200);
      const eventLoop = JSON.parse(body).event_loop;
      expect(eventLoop).not.toHaveProperty('raw_recent');
      expect(eventLoop.raw_samples).toEqual({
        available: true,
        schema_version: 'health.event-loop-samples.v1',
        path: '/health/event-loop-samples',
        oldest_sequence: 2,
        latest_sequence: 161,
      });
      expect(JSON.stringify(eventLoop.raw_samples)).not.toContain('at_ms');
      expect(Buffer.byteLength(body), `diagnostic health body was ${Buffer.byteLength(body)} bytes`)
        .toBeLessThan(65_536);
      expect(sampler.rawSamplePage).toHaveBeenCalledExactlyOnceWith({ limit: 1 });
    });

    it('logs a warning when the sampler reports local starvation', async () => {
      const sampler = fakeLoopLagSampler({
        sampleCount: 20,
        p95LagMs: 500,
        locallyStarved: true,
        discontinuityCount: 0,
      });
      const deps = makeDeps(db, { loopLagSampler: sampler as any });
      ({ server, port } = await buildTestServer(deps));

      await healthReq(port);
      expect(healthLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ p95LagMs: 500, sampleCount: 20, thresholdMs: 250 }),
        'event loop starvation detected during health check',
      );
    });

    it('rate-limits continuous starvation warnings using monotonic time without hiding health', async () => {
      let nowMs = 1_000;
      const sampler = fakeLoopLagSampler({
        sampleCount: 20,
        p95LagMs: 500,
        locallyStarved: true,
        discontinuityCount: 2,
      });
      const deps = makeDeps(db, {
        loopLagSampler: sampler as any,
        loopLagWarningNow: () => nowMs,
      });
      ({ server, port } = await buildTestServer(deps));

      const first = JSON.parse((await healthReq(port)).body);
      nowMs += 299_999;
      const suppressed = JSON.parse((await healthReq(port)).body);
      expect(first.status).toBe('degraded');
      expect(suppressed.status).toBe('degraded');
      expect(suppressed.event_loop.discontinuity_count).toBe(2);
      expect(healthLogger.warn).toHaveBeenCalledTimes(1);

      nowMs += 1;
      await healthReq(port);
      expect(healthLogger.warn).toHaveBeenCalledTimes(2);
    });

    it('warns immediately when starvation re-enters inside the repeat interval', async () => {
      let nowMs = 1_000;
      const snapshot = {
        sampleCount: 20,
        p95LagMs: 500,
        locallyStarved: true,
        discontinuityCount: 0,
      };
      const sampler = fakeLoopLagSampler(snapshot);
      const deps = makeDeps(db, {
        loopLagSampler: sampler as any,
        loopLagWarningNow: () => nowMs,
      });
      ({ server, port } = await buildTestServer(deps));

      await healthReq(port);
      sampler.snapshot.mockReturnValue({
        ...snapshot,
        p95LagMs: 0,
        locallyStarved: false,
      });
      nowMs += 1;
      await healthReq(port);
      sampler.snapshot.mockReturnValue(snapshot);
      nowMs += 1;
      await healthReq(port);

      expect(healthLogger.warn).toHaveBeenCalledTimes(2);
    });

    it('does not log a starvation warning when the sampler is not starved', async () => {
      const sampler = fakeLoopLagSampler({
        sampleCount: 3,
        p95LagMs: 10,
        locallyStarved: false,
        discontinuityCount: 0,
      });
      const deps = makeDeps(db, { loopLagSampler: sampler as any });
      ({ server, port } = await buildTestServer(deps));

      await healthReq(port);
      expect(healthLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'event loop starvation detected during health check',
      );
    });

    it('stops the injected sampler when the server closes', async () => {
      const sampler = fakeLoopLagSampler({
        sampleCount: 0,
        p95LagMs: null,
        locallyStarved: false,
        discontinuityCount: 0,
      });
      const deps = makeDeps(db, { loopLagSampler: sampler as any });
      ({ server, port } = await buildTestServer(deps));
      expect(sampler.start).toHaveBeenCalled();

      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(sampler.stop).toHaveBeenCalled();
    });
  });

  // #1753 rem-2: MCP tool-call liveness. Exposition only — deliberately does
  // NOT affect `status` (no corroborated evidence yet for what "too long" is
  // for every tool), unlike the loop-lag block above.
  describe('#1753 rem-2: MCP liveness in /health', () => {
    it('exposes mcp_liveness as null for a non-agent instance', async () => {
      ({ server, port } = await buildTestServer(makeDeps(db)));

      const { status, body } = await healthReq(port);
      expect(status).toBe(200);
      expect(JSON.parse(body).mcp_liveness).toBeNull();
    });

    it('exposes mcp_liveness as null when the agent runtime does not implement getMcpLivenessSnapshot', async () => {
      const deps = makeDeps(db, {
        instanceType: 'agent',
        runtime: {
          getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: { active: true } }),
        } as any,
      });
      ({ server, port } = await buildTestServer(deps));

      const { body } = await healthReq(port);
      expect(JSON.parse(body).mcp_liveness).toBeNull();
    });

    it('surfaces pending_count/oldest_call_age_ms/oldest_call_tool from the agent runtime', async () => {
      const deps = makeDeps(db, {
        instanceType: 'agent',
        runtime: {
          getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: { active: true } }),
          getMcpLivenessSnapshot: () => ({
            pendingCount: 2,
            oldestCallAgeMs: 45_000,
            oldestCallTool: 'send_message',
          }),
        } as any,
      });
      ({ server, port } = await buildTestServer(deps));

      const { status, body } = await healthReq(port);
      const json = JSON.parse(body);
      expect(status).toBe(200);
      expect(json.status).toBe('healthy');
      expect(json.mcp_liveness).toEqual({
        pending_count: 2,
        oldest_call_age_ms: 45_000,
        oldest_call_tool: 'send_message',
      });
    });

    it('does not degrade status on its own, however old the oldest in-flight call is (exposition only)', async () => {
      const deps = makeDeps(db, {
        instanceType: 'agent',
        runtime: {
          getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: { active: true } }),
          getMcpLivenessSnapshot: () => ({
            pendingCount: 1,
            oldestCallAgeMs: 6 * 60 * 60 * 1000, // 6h — pathological, still exposition-only
            oldestCallTool: 'send_message',
          }),
        } as any,
      });
      ({ server, port } = await buildTestServer(deps));

      const { body } = await healthReq(port);
      expect(JSON.parse(body).status).toBe('healthy');
    });
  });
});
