/**
 * Shape tests for PassiveRuntime.getHealthSnapshot().
 *
 * Verifies that the details object contains unreadCount (number)
 * and lastActivityAt (string | null).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn(), updateDeliveryJid: vi.fn() };
  }),
}));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { PassiveRuntime } from '../../../src/runtimes/passive/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { ConnectionManager } from '../../../src/transport/connection.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(queryResult?: { total: number; last_at: string | null }): Database {
  const mockGet = vi.fn().mockReturnValue(queryResult ?? { total: 0, last_at: null });
  return {
    raw: {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: mockGet, all: vi.fn() }),
    },
  } as unknown as Database;
}

function makeConnection(): ConnectionManager {
  return {} as unknown as ConnectionManager;
}

function makeConfig() {
  return { name: 'test', paths: { stateRoot: '/tmp/test' } };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PassiveRuntime.getHealthSnapshot — shape', () => {
  it('details contains unreadCount as a number', () => {
    const runtime = new PassiveRuntime(makeDb(), makeConnection(), makeConfig());
    const snapshot = runtime.getHealthSnapshot();
    expect(typeof snapshot.details['unreadCount']).toBe('number');
  });

  it('details contains lastActivityAt as string or null', () => {
    const runtime = new PassiveRuntime(makeDb(), makeConnection(), makeConfig());
    const snapshot = runtime.getHealthSnapshot();
    const val = snapshot.details['lastActivityAt'];
    expect(val === null || typeof val === 'string').toBe(true);
  });

  it('unreadCount is 0 when DB returns zero', () => {
    const runtime = new PassiveRuntime(makeDb({ total: 0, last_at: null }), makeConnection(), makeConfig());
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.details['unreadCount']).toBe(0);
  });

  it('unreadCount reflects DB aggregate', () => {
    const runtime = new PassiveRuntime(makeDb({ total: 42, last_at: '2026-03-31T20:00:00Z' }), makeConnection(), makeConfig());
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.details['unreadCount']).toBe(42);
  });

  it('lastActivityAt reflects DB max updated_at', () => {
    const runtime = new PassiveRuntime(makeDb({ total: 5, last_at: '2026-03-31T20:00:00Z' }), makeConnection(), makeConfig());
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.details['lastActivityAt']).toBe('2026-03-31T20:00:00Z');
  });

  it('lastActivityAt is null when no chats exist', () => {
    const runtime = new PassiveRuntime(makeDb({ total: 0, last_at: null }), makeConnection(), makeConfig());
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.details['lastActivityAt']).toBeNull();
  });

  it('gracefully returns defaults when DB query throws', () => {
    const db = {
      raw: {
        exec: vi.fn(),
        prepare: vi.fn().mockReturnValue({
          run: vi.fn(),
          get: vi.fn().mockImplementation(() => { throw new Error('DB locked'); }),
          all: vi.fn(),
        }),
      },
    } as unknown as Database;
    const runtime = new PassiveRuntime(db, makeConnection(), makeConfig());
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.details['unreadCount']).toBe(0);
    expect(snapshot.details['lastActivityAt']).toBeNull();
  });

  it('snapshot has a valid status string', () => {
    const runtime = new PassiveRuntime(makeDb(), makeConnection(), makeConfig());
    const snapshot = runtime.getHealthSnapshot();
    expect(['healthy', 'degraded', 'unhealthy']).toContain(snapshot.status);
  });
});
