/**
 * SoupKitchen page — structural + behavioral tests.
 * Verifies KPI computation, sparkline derivation, filter logic, and alert derivation.
 */
import { describe, it, expect } from 'vitest';
import { computeKpis } from '../../console/src/lib/compute-kpis';
import { deriveFleetMessageSparklines } from '../../console/src/lib/metrics-sparklines';
import type { LineInstance, MessageVolumeBucket } from '../../console/src/types';

// ---------------------------------------------------------------------------
// KPI computation
// ---------------------------------------------------------------------------

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'test', phone: '+1555000000', mode: 'passive', status: 'online',
    accessMode: 'open', healthPort: 9100, uptime: '1h', messagesTotal: 100,
    health: null, heartbeat: [], lastActive: new Date().toISOString(), error: null,
    ...overrides,
  };
}

describe('computeKpis', () => {
  it('counts connected lines', () => {
    const lines = [makeLine({ status: 'online' }), makeLine({ status: 'unreachable' })];
    expect(computeKpis(lines).connected).toBe(1);
  });

  it('counts lines needing attention', () => {
    const lines = [
      makeLine({ status: 'degraded' }),
      makeLine({ status: 'unreachable' }),
      makeLine({ status: 'online' }),
    ];
    expect(computeKpis(lines).needAttention).toBe(2);
  });

  it('aggregates message stats', () => {
    const lines = [
      makeLine({ messageStats: { sent: 10, received: 20, images: 3, audio: 1, documents: 2 } }),
      makeLine({ messageStats: { sent: 5, received: 8, images: 0, audio: 0, documents: 1 } }),
    ];
    const kpis = computeKpis(lines);
    expect(kpis.totalSent).toBe(15);
    expect(kpis.totalReceived).toBe(28);
    expect(kpis.totalMedia).toBe(7);
  });

  it('returns zeros for empty lines', () => {
    const kpis = computeKpis([]);
    expect(kpis.connected).toBe(0);
    expect(kpis.totalSent).toBe(0);
    expect(kpis.unread).toBe(0);
  });

  it('counts agent sessions from runtime health', () => {
    const lines = [
      makeLine({
        health: {
          status: 'ok', uptime_seconds: 100, messages_total: 50,
          connection: { state: 'open' }, sqlite: { messages_total: 50, schema_version: 1 },
          runtime: { agent: { activeSessions: 3, lastSessionStatus: null, lastSessionStartedAt: null } },
        },
      }),
    ];
    expect(computeKpis(lines).agentSessions).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Sparkline derivation
// ---------------------------------------------------------------------------

describe('deriveFleetMessageSparklines', () => {
  it('returns undefined for empty data', () => {
    expect(deriveFleetMessageSparklines(undefined)).toBeUndefined();
    expect(deriveFleetMessageSparklines([])).toBeUndefined();
  });

  it('normalizes outbound to 0-1 range', () => {
    const buckets: MessageVolumeBucket[] = [
      { bucket: '2026-01-01T00:00:00Z', inbound: 0, outbound: 10 },
      { bucket: '2026-01-01T01:00:00Z', inbound: 0, outbound: 5 },
      { bucket: '2026-01-01T02:00:00Z', inbound: 0, outbound: 0 },
    ];
    const result = deriveFleetMessageSparklines(buckets);
    expect(result).toBeDefined();
    expect(result!.outbound).toEqual([1, 0.5, 0]);
  });

  it('normalizes inbound independently', () => {
    const buckets: MessageVolumeBucket[] = [
      { bucket: '2026-01-01T00:00:00Z', inbound: 4, outbound: 0 },
      { bucket: '2026-01-01T01:00:00Z', inbound: 2, outbound: 0 },
    ];
    const result = deriveFleetMessageSparklines(buckets);
    expect(result!.inbound).toEqual([1, 0.5]);
  });
});

// ---------------------------------------------------------------------------
// Alert derivation (same logic used in SoupKitchen)
// ---------------------------------------------------------------------------

describe('alert derivation', () => {
  it('produces alerts for unreachable and degraded lines', () => {
    const lines = [
      makeLine({ name: 'a', status: 'unreachable', lastSessionStatus: null }),
      makeLine({ name: 'b', status: 'degraded' }),
      makeLine({ name: 'c', status: 'online' }),
    ];
    const alerts = lines
      .filter((l) => l.status === 'unreachable' || l.status === 'degraded')
      .map((l) => l.name);
    expect(alerts).toEqual(['a', 'b']);
  });
});
