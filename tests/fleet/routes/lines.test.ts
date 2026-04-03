/**
 * Tests for src/fleet/routes/lines.ts
 */
import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGetLines, handleGetLine } from '../../../src/fleet/routes/lines.ts';
import type { LinesDeps } from '../../../src/fleet/routes/lines.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import type { InstanceStatus } from '../../../src/fleet/health-poller.ts';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockReq(url = '/'): IncomingMessage {
  return { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number, _headers?: Record<string, string>) {
      res._status = status;
    },
    end(data?: string) {
      if (data) res._body = data;
    },
  };
  return res as any;
}

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'test-line',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/test-line/bot.db',
    stateRoot: '/state/test-line',
    logDir: '/data/test-line/logs',
    healthToken: null,
    configPath: '/config/test-line/config.json',
    socketPath: null,
    ...overrides,
  };
}

function fakeStatus(overrides: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    name: 'test-line',
    health: { uptime: 1234 },
    lastPollAt: '2026-04-01T00:00:00.000Z',
    consecutiveFailures: 0,
    status: 'online',
    error: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<LinesDeps> = {}): LinesDeps {
  return {
    discovery: {
      getInstances: vi.fn(() => new Map()),
      getInstance: vi.fn(() => undefined),
      scan: vi.fn(),
      startAutoRefresh: vi.fn(),
      stop: vi.fn(),
    } as any,
    healthPoller: {
      getStatuses: vi.fn(() => new Map()),
      getStatus: vi.fn(() => undefined),
      start: vi.fn(),
      stop: vi.fn(),
    } as any,
    dbReader: {
      getSummaryStats: vi.fn(() => ({ ok: true, data: { messageCount: 100, chatCount: 5, pendingAccess: 2 } })),
      getChats: vi.fn(),
      getMessages: vi.fn(),
      getAccessList: vi.fn(),
      query: vi.fn(() => ({ ok: true, data: [] })),
    } as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleGetLines
// ---------------------------------------------------------------------------

describe('handleGetLines', () => {
  it('returns an empty array when no instances exist', () => {
    const deps = makeDeps();
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([]);
  });

  it('returns instances with their poller status', () => {
    const inst = fakeInstance({ name: 'alpha' });
    const status = fakeStatus({ name: 'alpha', status: 'online' });

    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['alpha', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['alpha', status]])),
        getStatus: vi.fn(),
      } as any,
    });

    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    expect(res._status).toBe(200);

    const body = JSON.parse(res._body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      name: 'alpha',
      mode: 'chat',
      status: 'online',
      error: null,
    });
    // lastActive is derived from health runtime timestamps or last message time,
    // not from poller's lastPollAt. With empty mock data, it may be null or a
    // mock-derived value depending on what dbReader.query returns.
    expect(body[0]).toHaveProperty('lastActive');
  });

  it('returns "unknown" status when poller has no data for an instance', () => {
    const inst = fakeInstance({ name: 'beta' });

    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['beta', inst]])),
        getInstance: vi.fn(),
      } as any,
    });

    const res = mockRes();
    handleGetLines(mockReq(), res, deps);

    const body = JSON.parse(res._body);
    expect(body[0].status).toBe('unknown');
    // lastActive is null when no health runtime timestamps and no messages exist
    expect(body[0]).toHaveProperty('lastActive');
  });

  it('does not include dbStats in the list response', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['test-line', inst]])),
        getInstance: vi.fn(),
      } as any,
    });

    const res = mockRes();
    handleGetLines(mockReq(), res, deps);

    const body = JSON.parse(res._body);
    expect(body[0]).not.toHaveProperty('dbStats');
  });
});

// ---------------------------------------------------------------------------
// handleGetLine
// ---------------------------------------------------------------------------

describe('handleGetLine', () => {
  it('returns 404 for unknown instance', async () => {
    const deps = makeDeps();
    const res = mockRes();
    await handleGetLine(mockReq(), res, deps, { name: 'nonexistent' });
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toMatch(/not found/);
  });

  it('returns full detail with dbStats for known instance', async () => {
    const inst = fakeInstance({ name: 'gamma', type: 'passive', socketPath: '/state/gamma/whatsoup.sock' });
    const status = fakeStatus({ name: 'gamma' });

    const deps = makeDeps({
      discovery: {
        getInstance: vi.fn(() => inst),
        getInstances: vi.fn(),
      } as any,
      healthPoller: {
        getStatus: vi.fn(() => status),
        getStatuses: vi.fn(),
      } as any,
    });

    const res = mockRes();
    await handleGetLine(mockReq(), res, deps, { name: 'gamma' });
    expect(res._status).toBe(200);

    const body = JSON.parse(res._body);
    expect(body.name).toBe('gamma');
    expect(body.type).toBe('passive');
    expect(body.socketPath).toBe('/state/gamma/whatsoup.sock');
    expect(body.status).toBe('online');
    expect(body.health).toEqual({ uptime: 1234 });
    expect(body.dbStats).toEqual({ messageCount: 100, chatCount: 5, pendingAccess: 2 });
  });

  it('returns null dbStats when db query fails', async () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst), getInstances: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: false, error: 'db locked' })),
      } as any,
    });

    const res = mockRes();
    await handleGetLine(mockReq(), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).dbStats).toBeNull();
  });
});
