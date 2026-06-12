/**
 * Tests for src/fleet/routes/lines.ts
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  _getLineCachesForTests,
  _resetLineCaches,
  handleGetLines,
  handleGetLine,
} from '../../../src/fleet/routes/lines.ts';
import type { LinesDeps } from '../../../src/fleet/routes/lines.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import type { InstanceStatus } from '../../../src/fleet/health-poller.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

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
    statusConfidence: 'confirmed',
    statusReason: 'health_body_ok',
    statusEvidence: ['health_status=healthy'],
    error: null,
    lastAlertAt: null,
    silencedUntil: null,
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

beforeEach(() => {
  _resetLineCaches();
});

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
      statusConfidence: 'confirmed',
      statusReason: 'health_body_ok',
      statusEvidence: ['health_status=healthy'],
      error: null,
    });
    // lastActive is derived from health runtime timestamps or last message time,
    // not from poller's lastPollAt. With empty mock data, it may be null or a
    // mock-derived value depending on what dbReader.query returns.
    expect(body[0]).toHaveProperty('lastActive');
  });

  it('normalizes sqlite-style runtime timestamps for lastActive', () => {
    const inst = fakeInstance({ name: 'alpha' });
    const status = fakeStatus({
      name: 'alpha',
      health: {
        uptime: 1234,
        runtime: {
          passive: {
            lastActivityAt: '2026-04-05 12:34:56',
          },
        },
      },
    });

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

    const body = JSON.parse(res._body);
    expect(body[0].lastActive).toBe('2026-04-05T12:34:56.000Z');
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
    expect(body[0].statusConfidence).toBeNull();
    expect(body[0].statusReason).toBe('not_polled');
    expect(body[0].statusEvidence).toEqual([]);
    // lastActive is null when no health runtime timestamps and no messages exist
    expect(body[0]).toHaveProperty('lastActive');
  });

  it('forwards ambiguous signal metadata for misleading health reads', () => {
    const inst = fakeInstance({ name: 'mini4', type: 'agent' });
    const status = fakeStatus({
      name: 'mini4',
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
      statusEvidence: [
        'health_status=healthy',
        'whatsapp_connected=true',
        'reconnect_phase=backoff',
        'reconnect_attempts=0',
      ],
    });

    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['mini4', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['mini4', status]])),
        getStatus: vi.fn(),
      } as any,
    });

    const res = mockRes();
    handleGetLines(mockReq(), res, deps);

    const body = JSON.parse(res._body);
    expect(body[0]).toMatchObject({
      name: 'mini4',
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
      statusEvidence: [
        'health_status=healthy',
        'whatsapp_connected=true',
        'reconnect_phase=backoff',
        'reconnect_attempts=0',
      ],
    });
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

  it('prunes stale line caches for deleted instances before responding', () => {
    const caches = _getLineCachesForTests();
    const staleCachedAt = Date.now();
    caches.messageStatsCache.set('alpha', {
      data: { sent: 1, received: 2, images: 0, audio: 0, documents: 0 },
      cachedAt: staleCachedAt,
    });
    caches.sessionCountCache.set('alpha', { data: 3, cachedAt: staleCachedAt });
    caches.chatCountsCache.set('alpha', { data: { chats: 4, groups: 1 }, cachedAt: staleCachedAt });
    caches.tokenStatsCache.set('alpha', { data: { input: 5, output: 6 }, cachedAt: staleCachedAt });
    caches.lastActiveCache.set('alpha', { data: '2026-04-01T00:00:00.000Z', cachedAt: staleCachedAt });

    caches.messageStatsCache.set('ghost', {
      data: { sent: 9, received: 9, images: 9, audio: 9, documents: 9 },
      cachedAt: staleCachedAt,
    });
    caches.sessionCountCache.set('ghost', { data: 9, cachedAt: staleCachedAt });
    caches.chatCountsCache.set('ghost', { data: { chats: 9, groups: 9 }, cachedAt: staleCachedAt });
    caches.tokenStatsCache.set('ghost', { data: { input: 9, output: 9 }, cachedAt: staleCachedAt });
    caches.lastActiveCache.set('ghost', { data: '2026-04-02T00:00:00.000Z', cachedAt: staleCachedAt });

    const inst = fakeInstance({ name: 'alpha' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['alpha', inst]])),
        getInstance: vi.fn(),
      } as any,
    });
    const res = mockRes();

    handleGetLines(mockReq(), res, deps);

    expect(caches.messageStatsCache.has('alpha')).toBe(true);
    expect(caches.sessionCountCache.has('alpha')).toBe(true);
    expect(caches.chatCountsCache.has('alpha')).toBe(true);
    expect(caches.tokenStatsCache.has('alpha')).toBe(true);
    expect(caches.lastActiveCache.has('alpha')).toBe(true);

    expect(caches.messageStatsCache.has('ghost')).toBe(false);
    expect(caches.sessionCountCache.has('ghost')).toBe(false);
    expect(caches.chatCountsCache.has('ghost')).toBe(false);
    expect(caches.tokenStatsCache.has('ghost')).toBe(false);
    expect(caches.lastActiveCache.has('ghost')).toBe(false);
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
        query: vi.fn(() => ({ ok: true, data: [] })),
      } as any,
    });

    const res = mockRes();
    await handleGetLine(mockReq(), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).dbStats).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sharedCwdWith surfacing
// ---------------------------------------------------------------------------

describe('handleGetLines sharedCwdWith', () => {
  it('forwards sharedCwdWith from discovery to the line shape', () => {
    const inst = fakeInstance({ name: 'alpha', type: 'agent', sharedCwdWith: ['beta'] });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['alpha', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map()),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const body = JSON.parse(res._body);
    expect(body[0].sharedCwdWith).toEqual(['beta']);
  });

  it('emits null when no cwd collision exists', () => {
    const inst = fakeInstance({ name: 'alpha', type: 'agent' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['alpha', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map()),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    expect(JSON.parse(res._body)[0].sharedCwdWith).toBeNull();
  });
});
