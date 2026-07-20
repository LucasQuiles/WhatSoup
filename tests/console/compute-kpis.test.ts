/**
 * Direct unit coverage for console/src/lib/compute-kpis.ts.
 *
 * `computeKpis(lines)` aggregates seven KPIs across the LineInstance fleet:
 *   connected | needAttention | unread | agentSessions | totalSent | totalReceived | totalMedia
 *
 * The function is pure (no DOM, no React, no async), making it a clean unit-
 * test target. This file pins each counter's increment rules and the
 * optional-field safety paths (`health?`, `messageStats?`, `runtime?`).
 */
import { describe, expect, it } from 'vitest';
import { computeKpis, isLineConnected, isLineConnectivityUnknown } from '../../console/src/lib/compute-kpis';
import type { LineInstance } from '../../console/src/types';

/**
 * Build a minimal LineInstance fixture. Only fields read by computeKpis are
 * required; everything else is filled with safe defaults via the `as` cast at
 * the boundary so we don't have to construct unrelated shape.
 */
function makeLine(overrides: Partial<LineInstance>): LineInstance {
  return {
    name: 'alpha',
    phone: '15551234567',
    mode: 'agent',
    status: 'online',
    accessMode: 'allowlist',
    healthPort: 9001,
    uptime: '1h',
    messagesTotal: 0,
    health: null,
    heartbeat: [],
    lastActive: '',
    error: null,
    ...overrides,
  } as LineInstance;
}

const zeroKpis = {
  connected: 0,
  needAttention: 0,
  unread: 0,
  agentSessions: 0,
  totalSent: 0,
  totalReceived: 0,
  totalMedia: 0,
  staleExcluded: 0,
  connectivityUnknown: 0,
  metricsUnavailable: 0,
};

describe('computeKpis', () => {
  it('returns all zeros for an empty fleet', () => {
    expect(computeKpis([])).toEqual(zeroKpis);
  });

  it('counts a single online line as connected=1, no attention needed', () => {
    const result = computeKpis([makeLine({ status: 'online' })]);
    expect(result.connected).toBe(1);
    expect(result.needAttention).toBe(0);
  });

  it('counts a degraded line as needAttention=1, not connected', () => {
    const result = computeKpis([makeLine({ status: 'degraded' })]);
    expect(result.connected).toBe(0);
    expect(result.needAttention).toBe(1);
  });

  it('counts an unreachable line as needAttention=1', () => {
    const result = computeKpis([makeLine({ status: 'unreachable' })]);
    expect(result.needAttention).toBe(1);
  });

  it.each(['logged_out', 'config_error', 'unknown'] as const)(
    'counts %s as needAttention=1',
    (status) => {
      const result = computeKpis([makeLine({ status })]);
      expect(result.connected).toBe(0);
      expect(result.needAttention).toBe(1);
    },
  );

  it('counts an online line with non-null error as both connected AND needAttention', () => {
    const result = computeKpis([makeLine({ status: 'online', error: 'boom' })]);
    expect(result.connected).toBe(1);
    expect(result.needAttention).toBe(1);
  });

  it('sums passive runtime unread counts across lines', () => {
    const result = computeKpis([
      makeLine({
        status: 'online',
        health: {
          status: 'ok',
          uptime_seconds: 1,
          messages_total: 0,
          whatsapp: { connection: { state: 'open' } },
          sqlite: { messages_total: 0, schema_version: 5 },
          runtime: { passive: { unreadCount: 3, lastActivityAt: null } },
        },
      }),
      makeLine({
        status: 'online',
        health: {
          status: 'ok',
          uptime_seconds: 1,
          messages_total: 0,
          whatsapp: { connection: { state: 'open' } },
          sqlite: { messages_total: 0, schema_version: 5 },
          runtime: { passive: { unreadCount: 7, lastActivityAt: null } },
        },
      }),
    ]);
    expect(result.unread).toBe(10);
  });

  it('sums agent runtime activeSessions across lines', () => {
    const result = computeKpis([
      makeLine({
        status: 'online',
        health: {
          status: 'ok',
          uptime_seconds: 1,
          messages_total: 0,
          whatsapp: { connection: { state: 'open' } },
          sqlite: { messages_total: 0, schema_version: 5 },
          runtime: {
            agent: { activeSessions: 4, lastSessionStatus: null, lastSessionStartedAt: null },
          },
        },
      }),
      makeLine({
        status: 'online',
        health: {
          status: 'ok',
          uptime_seconds: 1,
          messages_total: 0,
          whatsapp: { connection: { state: 'open' } },
          sqlite: { messages_total: 0, schema_version: 5 },
          runtime: {
            agent: { activeSessions: 5, lastSessionStatus: null, lastSessionStartedAt: null },
          },
        },
      }),
    ]);
    expect(result.agentSessions).toBe(9);
  });

  it('aggregates messageStats: totalSent/totalReceived/totalMedia (images+audio+documents)', () => {
    const result = computeKpis([
      makeLine({
        messageStats: { sent: 10, received: 20, images: 3, audio: 2, documents: 1 },
      }),
      makeLine({
        messageStats: { sent: 100, received: 50, images: 7, audio: 0, documents: 4 },
      }),
    ]);
    expect(result.totalSent).toBe(110);
    expect(result.totalReceived).toBe(70);
    expect(result.totalMedia).toBe(3 + 2 + 1 + 7 + 0 + 4);
  });

  it('skips messageStats safely when undefined', () => {
    const result = computeKpis([makeLine({})]);
    expect(result.totalSent).toBe(0);
    expect(result.totalReceived).toBe(0);
    expect(result.totalMedia).toBe(0);
  });

  it('skips runtime fields safely when health is null', () => {
    const result = computeKpis([makeLine({ health: null })]);
    expect(result.unread).toBe(0);
    expect(result.agentSessions).toBe(0);
  });

  it('skips runtime fields safely when runtime is undefined', () => {
    const result = computeKpis([
      makeLine({
        health: {
          status: 'ok',
          uptime_seconds: 1,
          messages_total: 0,
          whatsapp: { connection: { state: 'open' } },
          sqlite: { messages_total: 0, schema_version: 5 },
          // runtime intentionally omitted
        },
      }),
    ]);
    expect(result.unread).toBe(0);
    expect(result.agentSessions).toBe(0);
  });

  it('combines all KPIs across a heterogeneous fleet correctly', () => {
    const result = computeKpis([
      makeLine({ status: 'online' }), // connected only
      makeLine({ status: 'degraded' }), // needAttention only
      makeLine({
        status: 'online',
        health: {
          status: 'ok',
          uptime_seconds: 1,
          messages_total: 0,
          whatsapp: { connection: { state: 'open' } },
          sqlite: { messages_total: 0, schema_version: 5 },
          runtime: { passive: { unreadCount: 2, lastActivityAt: null } },
        },
        messageStats: { sent: 5, received: 6, images: 1, audio: 1, documents: 1 },
      }),
    ]);
    expect(result).toEqual({
      connected: 2,
      needAttention: 1,
      unread: 2,
      agentSessions: 0,
      totalSent: 5,
      totalReceived: 6,
      totalMedia: 3,
      staleExcluded: 0,
      // The degraded line has no health body at all (missing health data) —
      // an unproven row, not a confirmed disconnect. See the coverage
      // dimension tests below (#1881 criterion 5).
      connectivityUnknown: 1,
      // None of these fixtures set metricAvailability — back-compat lines
      // never trip the #1879 coverage counter.
      metricsUnavailable: 0,
    });
  });

  // ---------------------------------------------------------------------------
  //  Health freshness gate (#1762 remediation 2)
  //
  //  `stale` (enrichInstance, src/fleet/routes/lines.ts) means the poller is
  //  currently failing and `health` is carried forward from an older successful
  //  observation. Summing the carried-forward health BODY (runtime.passive.unread,
  //  runtime.agent.activeSessions) across stale instances inflates fleet totals
  //  with values that no longer reflect the live instant. Gate ONLY those
  //  body-derived counts; per rem-1 the status-derived (connected / needAttention)
  //  and DB-derived (messageStats) fields must stay visible through the outage.
  // ---------------------------------------------------------------------------

  it('excludes a stale instance health-body counts (unread/agentSessions) but keeps its status + messageStats', () => {
    const result = computeKpis([
      makeLine({
        status: 'online',
        stale: true,
        error: 'boom',
        health: {
          status: 'ok',
          uptime_seconds: 1,
          messages_total: 0,
          whatsapp: { connection: { state: 'open' } },
          sqlite: { messages_total: 0, schema_version: 5 },
          runtime: {
            passive: { unreadCount: 5, lastActivityAt: null },
            agent: { activeSessions: 3, lastSessionStatus: null, lastSessionStartedAt: null },
          },
        },
        messageStats: { sent: 10, received: 20, images: 1, audio: 1, documents: 1 },
      }),
      makeLine({
        status: 'online',
        stale: false,
        health: {
          status: 'ok',
          uptime_seconds: 1,
          messages_total: 0,
          whatsapp: { connection: { state: 'open' } },
          sqlite: { messages_total: 0, schema_version: 5 },
          runtime: {
            passive: { unreadCount: 4, lastActivityAt: null },
            agent: { activeSessions: 2, lastSessionStatus: null, lastSessionStartedAt: null },
          },
        },
      }),
    ]);
    // Body-derived counts: only the fresh line contributes.
    expect(result.unread).toBe(4);
    expect(result.agentSessions).toBe(2);
    // Status-derived: the stale line still counts (rem-1 keeps status visible).
    expect(result.connected).toBe(2);
    expect(result.needAttention).toBe(1); // stale line has error -> attention
    // DB-derived messageStats persist through the outage.
    expect(result.totalSent).toBe(10);
    expect(result.totalReceived).toBe(20);
    expect(result.totalMedia).toBe(3);
    // Explicit: the gate is surfaced, not silent.
    expect(result.staleExcluded).toBe(1);
  });

  it('reports staleExcluded even for a stale instance with no health body', () => {
    const result = computeKpis([
      makeLine({ status: 'online', stale: true, health: null }),
      makeLine({ status: 'online', stale: false, health: null }),
    ]);
    expect(result.connected).toBe(2);
    expect(result.staleExcluded).toBe(1);
  });

  // ---------------------------------------------------------------------------
  //  Transport-connectivity dimension (#1881)
  //
  //  "Connected" is transport connectivity, NOT health-state. A line whose
  //  WhatsApp transport is genuinely up counts as connected even when its
  //  control-plane health status is `degraded` (e.g. recent-disconnect churn:
  //  src/core/health.ts marks `degraded` while `whatsapp.connected === true`
  //  and `connection.state === 'connected'`). Counting connectivity by
  //  `status === 'online'` alone undercounts working transports precisely when
  //  operators most need to tell "connected but impaired" from "disconnected".
  //
  //  The connected count is the UNION of two branches:
  //    (a) health-state `online` — stays visible through an outage (#1762
  //        rem-1), so it counts regardless of staleness; online ⊆ connected
  //        because the poller cannot classify a line online while the transport
  //        reports disconnected.
  //    (b) a FRESH transport-up signal (`whatsapp.connected === true` AND
  //        `connection.state === 'connected'`) on a non-stale line. A stale
  //        (carried-forward) connectivity body is UNKNOWN, not connected —
  //        mirroring how unread/agentSessions body counts are gated on `stale`
  //        (#1762 rem-2). This keeps stale/unavailable signals out of the
  //        connected count rather than miscounting them as connected.
  //
  //  NOTE: the emitter (health.ts) sets `connection.state` to the real
  //  connection state where `connected === true` REQUIRES `state ===
  //  'connected'`, so a real degraded-but-connected line has BOTH fields set.
  //  (Older fixtures above use `connection.state: 'open'`, which is not an
  //  emitter value; those lines count via the `online` branch instead.)
  // ---------------------------------------------------------------------------

  function connectedHealth(overrides?: Partial<{ connected: boolean; state: string }>) {
    return {
      status: 'ok',
      uptime_seconds: 1,
      messages_total: 0,
      whatsapp: {
        connected: overrides?.connected ?? true,
        connection: { state: overrides?.state ?? 'connected' },
      },
      sqlite: { messages_total: 0, schema_version: 5 },
    } as LineInstance['health'];
  }

  it('counts a degraded-but-connected line as connected (transport up) AND needing attention', () => {
    const result = computeKpis([
      makeLine({ status: 'degraded', stale: false, health: connectedHealth() }),
    ]);
    // Transport is up -> connected, even though health-state is degraded.
    expect(result.connected).toBe(1);
    // Health-state is still degraded -> the two dimensions are separate.
    expect(result.needAttention).toBe(1);
  });

  it('does NOT count a degraded-and-disconnected line as connected', () => {
    const result = computeKpis([
      makeLine({
        status: 'degraded',
        stale: false,
        health: connectedHealth({ connected: false, state: 'disconnected' }),
      }),
    ]);
    expect(result.connected).toBe(0);
    expect(result.needAttention).toBe(1);
  });

  it('treats a stale carried-forward connectivity body as unknown, not connected', () => {
    const result = computeKpis([
      // Stale + degraded but the carried-forward body still says connected:
      // must NOT count (the fresh transport signal is unavailable).
      makeLine({ status: 'degraded', stale: true, health: connectedHealth() }),
    ]);
    expect(result.connected).toBe(0);
    expect(result.staleExcluded).toBe(1);
    expect(result.connectivityUnknown).toBe(1);
  });

  it('treats an unreachable line with stale last-known connectivity as unknown, not connected', () => {
    const result = computeKpis([
      // #1881 acceptance case: service is currently unreachable, so its LAST
      // known health body (carried forward, connected) is not a fresh transport
      // signal. It counts as unknown (excluded from connected), not disconnected.
      makeLine({ status: 'unreachable', stale: true, health: connectedHealth() }),
    ]);
    expect(result.connected).toBe(0);
    expect(result.needAttention).toBe(1);
    expect(result.staleExcluded).toBe(1);
    expect(result.connectivityUnknown).toBe(1);
  });

  it('does NOT count a degraded line with missing health data as connected', () => {
    const result = computeKpis([
      makeLine({ status: 'degraded', stale: false, health: null }),
    ]);
    expect(result.connected).toBe(0);
  });

  it('counts an online+connected line once (branches do not double-count)', () => {
    const result = computeKpis([
      makeLine({ status: 'online', stale: false, health: connectedHealth() }),
    ]);
    expect(result.connected).toBe(1);
  });

  // ---------------------------------------------------------------------------
  //  Connectivity coverage dimension (#1881 criterion 5)
  //
  //  `isLineConnected` returning `false` collapses two different situations
  //  into one "not connected" bucket: a genuine fresh disconnect signal, and
  //  an unproven row (stale or missing health data) that was never actually
  //  read as disconnected. Without a separate counter, an operator staring at
  //  "N Connected" out of a fleet of size M cannot tell how many of the
  //  remaining `M - N` are confirmed-disconnected versus simply unproven —
  //  the denominator is implicit. `connectivityUnknown` makes it explicit.
  // ---------------------------------------------------------------------------

  it('all-known: connectivityUnknown is 0 when every line has a decisive signal', () => {
    const result = computeKpis([
      makeLine({ status: 'online' }), // confirmed connected (health-state)
      makeLine({
        status: 'degraded',
        stale: false,
        health: connectedHealth({ connected: false, state: 'disconnected' }),
      }), // confirmed disconnected (fresh signal)
    ]);
    expect(result.connected).toBe(1);
    expect(result.connectivityUnknown).toBe(0);
  });

  it('some-stale: a stale non-online line is unknown; a stale ONLINE line stays confirmed connected', () => {
    const result = computeKpis([
      makeLine({ status: 'degraded', stale: true, health: connectedHealth() }), // unknown
      makeLine({ status: 'online', stale: true, health: null }), // online overrides staleness
    ]);
    expect(result.connected).toBe(1);
    expect(result.connectivityUnknown).toBe(1);
  });

  it('some-missing-health: a non-stale line with no health body is unknown, not a confirmed disconnect', () => {
    const result = computeKpis([
      makeLine({ status: 'degraded', stale: false, health: null }),
      makeLine({ status: 'online' }),
    ]);
    expect(result.connected).toBe(1);
    expect(result.connectivityUnknown).toBe(1);
  });

  it('does not mark a confirmed disconnect (fresh signal) as unknown', () => {
    const result = computeKpis([
      makeLine({
        status: 'degraded',
        stale: false,
        health: connectedHealth({ connected: false, state: 'disconnected' }),
      }),
    ]);
    expect(result.connected).toBe(0);
    expect(result.connectivityUnknown).toBe(0);
  });

  // ---------------------------------------------------------------------------
  //  DB metric availability coverage (#1879 crit 3)
  //
  //  /api/lines used to turn a faulted DB read into an ordinary zero and
  //  cache it, so a locked/schema-gapped DB lowered the fleet's message
  //  totals exactly like a legitimately idle instance. `metricAvailability`
  //  (enrichInstance, src/fleet/routes/lines.ts) tags each observation with
  //  its status; computeKpis SKIPS an `unavailable` messageStats observation
  //  out of totalSent/totalReceived/totalMedia and tallies it into
  //  metricsUnavailable instead of folding it in as a real zero. A true zero
  //  (status `available`) still counts normally — the exclusion is keyed on
  //  status, not on the value happening to be zero.
  // ---------------------------------------------------------------------------

  it('excludes an unavailable messageStats observation from message totals and counts it as coverage', () => {
    const result = computeKpis([
      makeLine({
        messageStats: { sent: 0, received: 0, images: 0, audio: 0, documents: 0 },
        metricAvailability: { messageStats: 'unavailable' },
      }),
      makeLine({
        messageStats: { sent: 10, received: 5, images: 1, audio: 0, documents: 0 },
        metricAvailability: { messageStats: 'available' },
      }),
    ]);
    expect(result.totalSent).toBe(10);
    expect(result.totalReceived).toBe(5);
    expect(result.totalMedia).toBe(1);
    expect(result.metricsUnavailable).toBe(1);
  });

  it('counts a true zero (available) messageStats observation in totals, not as coverage', () => {
    const result = computeKpis([
      makeLine({
        messageStats: { sent: 0, received: 0, images: 0, audio: 0, documents: 0 },
        metricAvailability: { messageStats: 'available' },
      }),
    ]);
    expect(result.totalSent).toBe(0);
    expect(result.totalReceived).toBe(0);
    expect(result.totalMedia).toBe(0);
    expect(result.metricsUnavailable).toBe(0);
  });

  it('does not count metricsUnavailable when metricAvailability is absent (back-compat)', () => {
    const result = computeKpis([
      makeLine({ messageStats: { sent: 3, received: 2, images: 0, audio: 0, documents: 0 } }),
    ]);
    expect(result.totalSent).toBe(3);
    expect(result.totalReceived).toBe(2);
    expect(result.metricsUnavailable).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S17 — generic transport health block (generic-first, whatsapp fallback)
// ---------------------------------------------------------------------------

describe('S17 — generic transport health block', () => {
  const healthWith = (block: Record<string, unknown>) => ({
    status: 'ok',
    uptime_seconds: 100,
    messages_total: 0,
    whatsapp: { connection: { state: 'open' } },
    sqlite: { messages_total: 0, schema_version: 1 },
    ...block,
  }) as LineInstance['health'];

  it('isLineConnected reads transport.connected + connection.state generic-first', () => {
    const line = makeLine({
      status: 'unknown',
      health: healthWith({ transport: { kind: 'signal', connected: true, connection: { state: 'connected' } } }),
    });
    expect(isLineConnected(line)).toBe(true);
  });

  it('isLineConnected returns false when transport block says disconnected', () => {
    const line = makeLine({
      status: 'unknown',
      health: healthWith({ transport: { kind: 'imessage', connected: false, connection: { state: 'close' } } }),
    });
    expect(isLineConnected(line)).toBe(false);
  });

  it('isLineConnected falls back to the whatsapp block when transport is absent', () => {
    const line = makeLine({
      status: 'unknown',
      health: {
        status: 'ok', uptime_seconds: 100, messages_total: 0,
        whatsapp: { connected: true, connection: { state: 'connected' } },
        sqlite: { messages_total: 0, schema_version: 1 },
      } as LineInstance['health'],
    });
    expect(isLineConnected(line)).toBe(true);
  });

  it('isLineConnected falls back to whatsapp when transport.connected is undefined', () => {
    const line = makeLine({
      status: 'unknown',
      health: healthWith({ transport: { kind: 'signal' } }),
    });
    // transport has no connected verdict → whatsapp block decides (no connected field → false)
    expect(isLineConnected(line)).toBe(false);
  });

  it('isLineConnectivityUnknown is false when the transport block has a verdict', () => {
    const line = makeLine({
      status: 'unknown',
      health: healthWith({ transport: { kind: 'imessage', connected: false, connection: { state: 'close' } } }),
    });
    expect(isLineConnectivityUnknown(line)).toBe(false);
  });

  it('isLineConnectivityUnknown is true only when neither block has a verdict', () => {
    const line = makeLine({
      status: 'unknown',
      health: healthWith({ transport: { kind: 'signal' } }),
    });
    expect(isLineConnectivityUnknown(line)).toBe(true);
  });
});
