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
import { computeKpis } from '../../console/src/lib/compute-kpis';
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
    });
  });
});
