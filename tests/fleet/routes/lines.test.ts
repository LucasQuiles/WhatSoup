/**
 * Tests for src/fleet/routes/lines.ts
 */
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: vi.fn(),
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  _getLineCachesForTests,
  _resetLineCaches,
  handleGetLines,
  handleGetLine,
  handleGetLineProviderStatus,
} from '../../../src/fleet/routes/lines.ts';
import type { LinesDeps } from '../../../src/fleet/routes/lines.ts';
import { lookupCredential } from '../../../src/lib/keyring.ts';
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
    everReachable: true,
    status: 'online',
    statusConfidence: 'confirmed',
    statusReason: 'health_body_ok',
    statusEvidence: ['health_status=healthy'],
    error: null,
    lastAlertAt: null,
    silencedUntil: null,
    activeAlertSources: [],
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

const mockedLookup = vi.mocked(lookupCredential);

beforeEach(() => {
  _resetLineCaches();
  mockedLookup.mockReset();
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

  it('uses live WhatsApp health to avoid a false unlinked read when auth artifacts are absent', () => {
    const inst = fakeInstance({ name: 'mini4', configPath: '/missing/mini4/config.json' });
    const status = fakeStatus({
      name: 'mini4',
      health: {
        status: 'healthy',
        whatsapp: {
          connected: true,
          account_jid: '15550001111@s.whatsapp.net',
          connection: { state: 'connected' },
        },
      },
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
      linkedStatus: 'linked',
      linkedStatusConfidence: 'confirmed',
      linkedStatusReason: 'whatsapp_health_connected',
    });
    expect(body[0].linkedStatusEvidence).toEqual(expect.arrayContaining([
      'link_source=health',
      'whatsapp_connected=true',
      'account_jid_status=present',
      'connection_state=connected',
    ]));
  });

  it('reports unknown linkage instead of unlinked when auth artifacts are unreadable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-link-state-'));
    try {
      fs.writeFileSync(path.join(tmp, 'auth'), 'not a directory');
      const inst = fakeInstance({ name: 'mini4', configPath: path.join(tmp, 'config.json') });
      const deps = makeDeps({
        discovery: {
          getInstances: vi.fn(() => new Map([['mini4', inst]])),
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
      expect(body[0]).toMatchObject({
        linkedStatus: 'unknown',
        linkedStatusConfidence: 'ambiguous',
        linkedStatusReason: 'auth_artifacts_unreadable',
      });
      expect(body[0].linkedStatusEvidence).toEqual(expect.arrayContaining([
        'link_source=auth_artifacts',
        'auth_read_error_code=ENOTDIR',
      ]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('lets confirmed disconnected health override stale auth artifacts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-link-state-'));
    try {
      fs.mkdirSync(path.join(tmp, 'auth'));
      fs.writeFileSync(path.join(tmp, 'auth', 'creds.json'), '{}');
      const inst = fakeInstance({ name: 'mini4', configPath: path.join(tmp, 'config.json') });
      const status = fakeStatus({
        name: 'mini4',
        health: {
          status: 'unhealthy',
          whatsapp: {
            connected: false,
            account_jid: 'not connected',
            connection: {
              state: 'disconnected',
              last_disconnect_reason: 'loggedOut',
              last_status_code: 401,
              auth_failure_class: 'serverside_logout_irreversible',
            },
          },
        },
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
        linkedStatus: 'unlinked',
        linkedStatusConfidence: 'confirmed',
        linkedStatusReason: 'whatsapp_health_disconnected',
      });
      expect(body[0].linkedStatusEvidence).toEqual(expect.arrayContaining([
        'link_source=health',
        'whatsapp_connected=false',
        'account_jid_status=not_connected',
        'connection_state=disconnected',
        'last_disconnect_reason=loggedOut',
        'last_status_code=401',
        'auth_failure_class=serverside_logout_irreversible',
      ]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not report unlinked from disconnected health without explicit auth-loss proof', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-link-state-'));
    try {
      fs.mkdirSync(path.join(tmp, 'auth'));
      fs.writeFileSync(path.join(tmp, 'auth', 'creds.json'), '{}');
      const inst = fakeInstance({ name: 'mini4', configPath: path.join(tmp, 'config.json') });
      const status = fakeStatus({
        name: 'mini4',
        health: {
          status: 'unhealthy',
          whatsapp: {
            connected: false,
            account_jid: 'not connected',
            connection: {
              state: 'disconnected',
              last_disconnect_reason: 'connectionReplaced',
              last_status_code: 440,
              auth_failure_class: 'none',
            },
          },
        },
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
        linkedStatus: 'unknown',
        linkedStatusConfidence: 'ambiguous',
        linkedStatusReason: 'whatsapp_health_disconnected_without_auth_loss_signal',
      });
      expect(body[0].linkedStatusEvidence).toEqual(expect.arrayContaining([
        'link_source=health',
        'whatsapp_connected=false',
        'account_jid_status=not_connected',
        'connection_state=disconnected',
        'last_disconnect_reason=connectionReplaced',
        'last_status_code=440',
        'auth_failure_class=none',
      ]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
    // Cache entries hold an Observation ({status, value}), not a bare value
    // (#1879) — only stable (`available`/`not_applicable`) states are ever
    // written, so every poked fixture here uses `status: 'available'`.
    caches.messageStatsCache.set('alpha', {
      data: { status: 'available', value: { sent: 1, received: 2, images: 0, audio: 0, documents: 0 } },
      cachedAt: staleCachedAt,
    });
    caches.sessionCountCache.set('alpha', { data: { status: 'available', value: 3 }, cachedAt: staleCachedAt });
    caches.chatCountsCache.set('alpha', { data: { status: 'available', value: { chats: 4, groups: 1 } }, cachedAt: staleCachedAt });
    caches.tokenStatsCache.set('alpha', { data: { status: 'available', value: { input: 5, output: 6 } }, cachedAt: staleCachedAt });
    caches.lastActiveCache.set('alpha', { data: { status: 'available', value: '2026-04-01T00:00:00.000Z' }, cachedAt: staleCachedAt });

    caches.messageStatsCache.set('ghost', {
      data: { status: 'available', value: { sent: 9, received: 9, images: 9, audio: 9, documents: 9 } },
      cachedAt: staleCachedAt,
    });
    caches.sessionCountCache.set('ghost', { data: { status: 'available', value: 9 }, cachedAt: staleCachedAt });
    caches.chatCountsCache.set('ghost', { data: { status: 'available', value: { chats: 9, groups: 9 } }, cachedAt: staleCachedAt });
    caches.tokenStatsCache.set('ghost', { data: { status: 'available', value: { input: 9, output: 9 } }, cachedAt: staleCachedAt });
    caches.lastActiveCache.set('ghost', { data: { status: 'available', value: '2026-04-02T00:00:00.000Z' }, cachedAt: staleCachedAt });

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

// ---------------------------------------------------------------------------
// formatUptime coverage — exercised indirectly via health snapshot uptime
// ---------------------------------------------------------------------------

describe('handleGetLines uptime formatting', () => {
  function lineWithUptime(uptimeSec: number | null): Record<string, unknown> {
    const health: Record<string, unknown> = uptimeSec !== null ? { uptime_seconds: uptimeSec } : {};
    const inst = fakeInstance({ name: 'u' });
    const status = fakeStatus({ name: 'u', health });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['u', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['u', status]])),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    return (JSON.parse(res._body) as Record<string, unknown>[])[0];
  }

  it('formats uptime in days and hours when >= 86400s', () => {
    // 2 days + 3 hours = 2*86400 + 3*3600 = 183600
    const line = lineWithUptime(183600);
    expect(line.uptime).toBe('2d 3h');
  });

  it('formats uptime in hours and minutes when < 86400s and >= 3600s', () => {
    // 2 hours 30 minutes = 9000
    const line = lineWithUptime(9000);
    expect(line.uptime).toBe('2h 30m');
  });

  it('formats uptime in minutes only when < 3600s', () => {
    const line = lineWithUptime(600);
    expect(line.uptime).toBe('10m');
  });

  it('returns null uptime when uptime_seconds is absent from health', () => {
    const line = lineWithUptime(null);
    expect(line.uptime).toBeNull();
    // name is still populated — the null is uptime specifically, not the whole line
    expect(line.name).toBe('u');
  });

  it('returns null uptime when uptime_seconds is negative', () => {
    const inst = fakeInstance({ name: 'neg' });
    const status = fakeStatus({ name: 'neg', health: { uptime_seconds: -1 } });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['neg', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['neg', status]])),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    expect(JSON.parse(res._body)[0].uptime).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildHeartbeat coverage — consecutive failures drive down/up distribution
// ---------------------------------------------------------------------------

describe('handleGetLines heartbeat', () => {
  it('builds an all-down heartbeat when poller has no data', () => {
    const inst = fakeInstance({ name: 'hb' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['hb', inst]])),
        getInstance: vi.fn(),
      } as any,
      // no status in map → poll is undefined
      healthPoller: {
        getStatuses: vi.fn(() => new Map()),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const body = JSON.parse(res._body);
    expect(body[0].heartbeat).toHaveLength(20);
    expect(body[0].heartbeat.every((v: string) => v === 'down')).toBe(true);
  });

  it('places recent failures at the end of the heartbeat array', () => {
    const inst = fakeInstance({ name: 'hb2' });
    const status = fakeStatus({ name: 'hb2', consecutiveFailures: 5 });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['hb2', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['hb2', status]])),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const hb = JSON.parse(res._body)[0].heartbeat as string[];
    expect(hb).toHaveLength(20);
    // Last 5 are 'down', first 15 are 'up'
    expect(hb.slice(0, 15).every(v => v === 'up')).toBe(true);
    expect(hb.slice(15).every(v => v === 'down')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getMessageStats — row-level branch coverage via query callback interception
// ---------------------------------------------------------------------------

/**
 * Build a dbReader mock that executes the query callback synchronously with a
 * fake DB object whose prepare() returns the given rows.
 */
function makeLiveDbReader(rows: { content_type: string; is_from_me: number; cnt: number }[]): LinesDeps['dbReader'] {
  return {
    getSummaryStats: vi.fn(() => ({ ok: true, data: { messageCount: 0, chatCount: 0, pendingAccess: 0 } })),
    query: vi.fn((_name, _dbPath, fn) => {
      const fakeDb = {
        prepare: vi.fn(() => ({
          all: vi.fn(() => rows),
          get: vi.fn(() => undefined),
        })),
      };
      try {
        const data = fn(fakeDb as any);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }),
  } as any;
}

describe('handleGetLines message stats row processing', () => {
  it('counts sent, received, images, audio, and documents from same-day messages', () => {
    const rows = [
      { content_type: 'text', is_from_me: 1, cnt: 3 },
      { content_type: 'text', is_from_me: 0, cnt: 2 },
      { content_type: 'image', is_from_me: 0, cnt: 1 },
      { content_type: 'audio', is_from_me: 1, cnt: 4 },
      { content_type: 'document', is_from_me: 0, cnt: 2 },
    ];
    const inst = fakeInstance({ name: 'ms1' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['ms1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map()),
        getStatus: vi.fn(),
      } as any,
      dbReader: makeLiveDbReader(rows),
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    // sent = 3 (text) + 4 (audio) = 7; received = 2 (text) + 1 (image) + 2 (doc) = 5
    expect(line.messageStats).toMatchObject({
      sent: 7,
      received: 5,
      images: 1,
      audio: 4,
      documents: 2,
    });
    expect(line.messagesToday).toBe(12);
    // #1879 crit 4: a successfully queried result — even a legitimate 0 —
    // reports `available`, distinct from an `unavailable` failure fallback.
    expect(line.metricAvailability.messageStats).toBe('available');
  });

  it('returns zero stats when the db query fails', () => {
    const inst = fakeInstance({ name: 'msfail' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['msfail', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map()),
        getStatus: vi.fn(),
      } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: false, error: 'db locked' })),
        query: vi.fn(() => ({ ok: false, error: 'db locked' })),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.messageStats).toMatchObject({ sent: 0, received: 0, images: 0, audio: 0, documents: 0 });
    expect(line.messagesToday).toBe(0);
    // #1879 crit 1: a db-locked failure is `unavailable`, not a masked zero.
    expect(line.metricAvailability.messageStats).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// getTotalSessions — agent vs non-agent, and db failure path
// ---------------------------------------------------------------------------

describe('handleGetLines totalSessions', () => {
  it('returns 0 total sessions for non-agent instances without querying the db', () => {
    const inst = fakeInstance({ name: 'chat1', type: 'chat' });
    // query mock must return row arrays (not scalars) because getMessageStats
    // runs first and iterates result.data. getTotalSessions is skipped for
    // non-agent instances before the session COUNT(*) query is ever issued.
    const issuedSql: string[] = [];
    const querySpy = vi.fn((_name: string, _dbPath: string, fn: (db: unknown) => unknown) => {
      const fakeDb = {
        prepare: vi.fn((sql: string) => {
          issuedSql.push(sql);
          return {
            all: vi.fn(() => []),
            get: vi.fn(() => ({ ts: null, i: 0, o: 0, total: 0, groups: 0 })),
          };
        }),
      };
      return { ok: true, data: fn(fakeDb) };
    });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['chat1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: querySpy,
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.totalSessions).toBe(0);
    // The session-count COUNT(*) query is never issued for non-agent instances.
    expect(issuedSql.some((s) => s.includes('COUNT(*) as cnt FROM agent_sessions'))).toBe(false);
    // #1879: structurally absent (not an agent), not a failed read.
    expect(line.metricAvailability.sessions).toBe('not_applicable');
  });

  it('queries agent_sessions count for agent instances', () => {
    const inst = fakeInstance({ name: 'ag1', type: 'agent' });
    // getMessageStats runs first (calls .all()), then getTotalSessions (calls .get()).
    // The fake DB must provide both methods so neither call throws.
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['ag1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: vi.fn((_name, _dbPath, fn) => {
          const fakeDb = {
            prepare: vi.fn(() => ({
              all: vi.fn(() => []),
              get: vi.fn(() => ({ cnt: 7, ts: null, i: 0, o: 0, total: 0, groups: 0 })),
            })),
          };
          return { ok: true, data: fn(fakeDb as any) };
        }),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.totalSessions).toBe(7);
    expect(line.metricAvailability.sessions).toBe('available');
  });

  it('returns 0 total sessions when the agent_sessions query fails', () => {
    const inst = fakeInstance({ name: 'ag2', type: 'agent' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['ag2', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: vi.fn(() => ({ ok: false, error: 'no such table' })),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.totalSessions).toBe(0);
    expect(line.metricAvailability.sessions).toBe('unavailable');
  });

  it('returns 0 when agent_sessions table does not exist (caught exception path)', () => {
    const inst = fakeInstance({ name: 'ag3', type: 'agent' });
    // getMessageStats runs first and needs .all(); getTotalSessions then calls
    // .get() on 'agent_sessions' which should throw to exercise the catch branch.
    let callCount = 0;
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['ag3', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: vi.fn((_name, _dbPath, fn) => {
          callCount++;
          // First call is getMessageStats (.all()), subsequent calls include
          // getTotalSessions (.get() on agent_sessions — must throw). Match
          // the exact sessions COUNT(*) statement (not any 'agent_sessions'
          // substring) so this fixture doesn't also trip getTokenStats' own
          // agent_sessions sub-select — that cross-metric interaction is
          // covered separately by the missing-column test below.
          const isSessionsQuery = callCount > 1;
          const fakeDb = {
            prepare: vi.fn((sql: string) => {
              if (isSessionsQuery && sql.includes('COUNT(*) as cnt FROM agent_sessions')) {
                throw new Error('no such table: agent_sessions');
              }
              return { all: vi.fn(() => []), get: vi.fn(() => ({ ts: null, i: 0, o: 0, total: 0, groups: 0 })) };
            }),
          };
          // #1879: getTotalSessions no longer swallows this exception itself
          // — it now relies on the same outer try/catch FleetDbReader.query
          // provides in production (src/fleet/db-reader.ts), so the mock
          // must mirror that layer instead of letting the throw escape.
          try {
            return { ok: true, data: fn(fakeDb as any) };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        }),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.totalSessions).toBe(0);
    // #1879 crit 1: a missing-table exception must surface as `unavailable`,
    // not be masked internally as a legitimate zero.
    expect(line.metricAvailability.sessions).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// getLastMessageTime — timestamp-present branch
// ---------------------------------------------------------------------------

describe('handleGetLines lastMessageTime from DB', () => {
  it('uses DB last message timestamp for lastActive when health provides no runtime timestamps', () => {
    const inst = fakeInstance({ name: 'lmt1' });
    // Unix timestamp: 2026-01-01T00:00:00Z = 1767225600
    const unixTs = 1767225600;
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['lmt1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        // health has no runtime timestamps → falls through to lastMessageTime from DB
        getStatuses: vi.fn(() => new Map([['lmt1', fakeStatus({ name: 'lmt1', health: {} })]])),
        getStatus: vi.fn(),
      } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: vi.fn((_name, _dbPath, fn) => {
          // First call: getMessageStats (returns rows), second: getChatCounts,
          // third: getTokenStats (messages), fourth: getTokenStats (agent_sessions),
          // fifth: getLastMessageTime
          // Use a counter to return the right shape per call
          const fakeDb = {
            prepare: vi.fn(() => ({
              all: vi.fn(() => []),
              get: vi.fn(() => ({ ts: unixTs })),
            })),
          };
          return { ok: true, data: fn(fakeDb as any) };
        }),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    // lastActive should be ISO from the unix timestamp
    expect(typeof line.lastActive).toBe('string');
    expect(line.lastActive).toMatch(/2026-01-01/);
  });

  it('returns null lastActive when DB timestamp is null', () => {
    const inst = fakeInstance({ name: 'lmt2' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['lmt2', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['lmt2', fakeStatus({ name: 'lmt2', health: {} })]])),
        getStatus: vi.fn(),
      } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: vi.fn((_name, _dbPath, fn) => {
          const fakeDb = {
            prepare: vi.fn(() => ({
              all: vi.fn(() => []),
              get: vi.fn(() => ({ ts: null })),
            })),
          };
          return { ok: true, data: fn(fakeDb as any) };
        }),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.lastActive).toBeNull();
    // status is still emitted — only lastActive is absent
    expect(line.status).toBe('online');
    // #1879 crit 4: a successful query with no rows is a legitimate `null`,
    // not a failure — distinct from the query-failure case just below.
    expect(line.metricAvailability.lastActivity).toBe('available');
  });

  it('returns null lastActive when lastMessageTime db query fails', () => {
    const inst = fakeInstance({ name: 'lmt3' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['lmt3', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['lmt3', fakeStatus({ name: 'lmt3', health: {} })]])),
        getStatus: vi.fn(),
      } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: vi.fn(() => ({ ok: false, error: 'db unreachable' })),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.lastActive).toBeNull();
    // status is still correctly emitted even when the db query fails
    expect(line.status).toBe('online');
    expect(line.metricAvailability.lastActivity).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// getChatCounts — db failure path
// ---------------------------------------------------------------------------

describe('handleGetLines chatCounts', () => {
  it('returns zero chat counts when db query fails', () => {
    const inst = fakeInstance({ name: 'cc1' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['cc1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: false, error: 'fail' })),
        query: vi.fn(() => ({ ok: false, error: 'fail' })),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.chatCounts).toEqual({ chats: 0, groups: 0 });
    expect(line.metricAvailability.chatCounts).toBe('unavailable');
  });

  it('returns token usage zero when db query fails', () => {
    const inst = fakeInstance({ name: 'tu1' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['tu1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: false, error: 'fail' })),
        query: vi.fn(() => ({ ok: false, error: 'fail' })),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.tokenUsage).toEqual({ input: 0, output: 0 });
    expect(line.metricAvailability.tokenStats).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
// getTokenStats — live db with actual token values
// ---------------------------------------------------------------------------

describe('handleGetLines tokenStats live db', () => {
  it('sums message and agent_session tokens from the database', () => {
    const inst = fakeInstance({ name: 'tok1' });
    let callCount = 0;
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['tok1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: vi.fn((_name, _dbPath, fn) => {
          callCount++;
          const fakeDb = {
            prepare: vi.fn(() => ({
              all: vi.fn(() => []),
              // Token queries return specific values
              get: vi.fn(() => ({ i: 100, o: 50 })),
            })),
          };
          return { ok: true, data: fn(fakeDb as any) };
        }),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    // Both message tokens and session tokens contribute: 100+100=200, 50+50=100
    expect(line.tokenUsage.input).toBeGreaterThan(0);
    expect(line.tokenUsage.output).toBeGreaterThan(0);
    expect(line.metricAvailability.tokenStats).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// #1879 — per-metric DB availability
//
// GET /api/lines used to turn every DB read/schema failure into an ordinary
// zero/null and cache it for 60s, so a faulted DB lowered fleet totals
// exactly like a legitimately idle instance. These tests pin the fix: each
// DB-derived metric group (messageStats, sessions, chatCounts, tokenStats,
// lastActivity) now reports a `metricAvailability` status alongside its
// display value, distinguishing `available` / `unavailable` / `not_applicable`
// from a true zero, and failures are never cached (so recovery is immediate).
// ---------------------------------------------------------------------------

describe('handleGetLines legitimate zero vs unavailable (#1879 crit 4)', () => {
  it('reports available + true zero/null for a legitimately empty database, distinct from a failed read', () => {
    const inst = fakeInstance({ name: 'quiet1' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['quiet1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      // makeLiveDbReader([]) executes the real callback against a live-shaped
      // fake db that legitimately has no rows — every .get() call returns
      // undefined, every .all() call returns [] — the successful-but-empty
      // case, not a failure.
      dbReader: makeLiveDbReader([]),
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.messageStats).toEqual({ sent: 0, received: 0, images: 0, audio: 0, documents: 0 });
    expect(line.chatCounts).toEqual({ chats: 0, groups: 0 });
    expect(line.tokenUsage).toEqual({ input: 0, output: 0 });
    expect(line.lastActive).toBeNull();
    expect(line.metricAvailability).toMatchObject({
      messageStats: 'available',
      chatCounts: 'available',
      tokenStats: 'available',
      lastActivity: 'available',
    });
  });
});

describe('handleGetLines tokenStats missing-column path (#1879)', () => {
  it('reports unavailable, not a masked 0, when a token column is missing from an older schema', () => {
    const inst = fakeInstance({ name: 'tokcol' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['tokcol', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: vi.fn((_name, _dbPath, fn) => {
          const fakeDb = {
            prepare: vi.fn((sql: string) => {
              // #1879: getTokenStats no longer swallows this internally — the
              // exception must reach the same outer try/catch FleetDbReader.
              // query provides in production, which this mock mirrors below.
              if (sql.includes('input_tokens')) {
                throw new Error('no such column: input_tokens');
              }
              return { all: vi.fn(() => []), get: vi.fn(() => ({ ts: null, total: 0, groups: 0 })) };
            }),
          };
          try {
            return { ok: true, data: fn(fakeDb as any) };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        }),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.tokenUsage).toEqual({ input: 0, output: 0 });
    expect(line.metricAvailability.tokenStats).toBe('unavailable');
  });
});

describe('handleGetLines cache stability on failure (#1879 crit 2)', () => {
  it('does not cache an unavailable observation; the next request re-probes and returns the recovered value', () => {
    const inst = fakeInstance({ name: 'recover1' });
    let messageStatsCalls = 0;
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['recover1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
      dbReader: {
        getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
        query: vi.fn((_name, _dbPath, fn) => {
          const fakeDb = {
            prepare: vi.fn((sql: string) => {
              if (sql.includes('GROUP BY content_type')) {
                messageStatsCalls++;
                // Fail only the first attempt — a transient lock, not a
                // permanent schema gap.
                if (messageStatsCalls === 1) {
                  throw new Error('database is locked');
                }
              }
              return {
                all: vi.fn(() => []),
                get: vi.fn(() => ({ ts: null, i: 0, o: 0, total: 0, groups: 0 })),
              };
            }),
          };
          try {
            return { ok: true, data: fn(fakeDb as any) };
          } catch (err) {
            return { ok: false, error: String(err) };
          }
        }),
      } as any,
    });

    const res1 = mockRes();
    handleGetLines(mockReq(), res1, deps);
    const line1 = JSON.parse(res1._body)[0];
    expect(line1.metricAvailability.messageStats).toBe('unavailable');

    // A second request inside the 60s TTL window must NOT replay a cached
    // failure — cachedQuery only writes stable (available/not_applicable)
    // states to the cache, so this call re-probes instead of returning a
    // stale `unavailable`.
    const res2 = mockRes();
    handleGetLines(mockReq(), res2, deps);
    const line2 = JSON.parse(res2._body)[0];
    expect(line2.metricAvailability.messageStats).toBe('available');
    // Exactly one failed probe + one successful re-probe — proves the
    // failure was never cached (an old buggy cache-everything implementation
    // would have short-circuited the second call and left this at 1).
    expect(messageStatsCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// enrichInstance config_error coverage
// ---------------------------------------------------------------------------

describe('handleGetLines config_error instance', () => {
  it('surfaces config_error status and populates error and configError fields', () => {
    const inst = fakeInstance({
      name: 'broken',
      configError: 'config file not found',
    });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['broken', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: { getStatuses: vi.fn(() => new Map()), getStatus: vi.fn() } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.status).toBe('config_error');
    expect(line.statusConfidence).toBe('confirmed');
    expect(line.statusReason).toBe('config_error');
    expect(line.statusEvidence).toEqual(['config file not found']);
    expect(line.configError).toBe('config file not found');
    expect(line.error).toBe('config file not found');
  });
});

// ---------------------------------------------------------------------------
// enrichInstance lastSessionStatus derivation
// ---------------------------------------------------------------------------

describe('handleGetLines lastSessionStatus derivation', () => {
  it('derives lastSessionStatus=idle when status is online and health lacks runtime.agent', () => {
    const inst = fakeInstance({ name: 'idle1', type: 'agent' });
    const status = fakeStatus({ name: 'idle1', status: 'online', health: {} });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['idle1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['idle1', status]])),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.lastSessionStatus).toBe('idle');
  });

  it('derives lastSessionStatus=error when status is unreachable and health lacks runtime.agent', () => {
    const inst = fakeInstance({ name: 'err1', type: 'agent' });
    const status = fakeStatus({ name: 'err1', status: 'unreachable', health: null });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['err1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['err1', status]])),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.lastSessionStatus).toBe('error');
  });

  it('returns null lastSessionStatus when status is degraded and no runtime.agent present', () => {
    const inst = fakeInstance({ name: 'deg1', type: 'agent' });
    const status = fakeStatus({ name: 'deg1', status: 'degraded', health: {} });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['deg1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['deg1', status]])),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.lastSessionStatus).toBeNull();
    // The degraded status is still surfaced — only lastSessionStatus is null
    // because degraded is neither 'online' (idle) nor 'unreachable' (error).
    expect(line.status).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// linkedStatusFromHealth — accountJid present but connected not true
// ---------------------------------------------------------------------------

describe('handleGetLines linkedStatus inferred from account_jid', () => {
  it('returns linked/inferred when account_jid is present but connected is not true', () => {
    const inst = fakeInstance({ name: 'jid1' });
    const status = fakeStatus({
      name: 'jid1',
      health: {
        whatsapp: {
          connected: false,
          account_jid: '15550001111@s.whatsapp.net',
          // no connection block → connectionState is undefined
        },
      },
    });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([['jid1', inst]])),
        getInstance: vi.fn(),
      } as any,
      healthPoller: {
        getStatuses: vi.fn(() => new Map([['jid1', status]])),
        getStatus: vi.fn(),
      } as any,
    });
    const res = mockRes();
    handleGetLines(mockReq(), res, deps);
    const line = JSON.parse(res._body)[0];
    expect(line.linkedStatus).toBe('linked');
    expect(line.linkedStatusConfidence).toBe('inferred');
    expect(line.linkedStatusReason).toBe('whatsapp_account_present');
  });
});

// ---------------------------------------------------------------------------
// handleGetLine — config successfully read, adminPhones LID resolution
// ---------------------------------------------------------------------------

describe('handleGetLine config and adminPhones', () => {
  it('includes config from instance configPath when readable', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ name: 'mybot', webhookUrl: 'http://example.com' }));
      const inst = fakeInstance({ name: 'cfgtest', configPath });
      const deps = makeDeps({
        discovery: { getInstance: vi.fn(() => inst), getInstances: vi.fn() } as any,
        healthPoller: { getStatus: vi.fn(() => undefined), getStatuses: vi.fn() } as any,
      });
      const res = mockRes();
      await handleGetLine(mockReq(), res, deps, { name: 'cfgtest' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.config).toEqual({ name: 'mybot', webhookUrl: 'http://example.com' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves LID admin phones to human-readable numbers via lid_mappings DB', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      // adminPhones entry > 11 chars triggers LID lookup
      const lidPhone = '123456789012345';
      fs.writeFileSync(configPath, JSON.stringify({ adminPhones: [lidPhone] }));

      const inst = fakeInstance({ name: 'lidtest', configPath });
      const deps = makeDeps({
        discovery: { getInstance: vi.fn(() => inst), getInstances: vi.fn() } as any,
        healthPoller: { getStatus: vi.fn(() => undefined), getStatuses: vi.fn() } as any,
        dbReader: {
          getSummaryStats: vi.fn(() => ({ ok: true, data: { messageCount: 0, chatCount: 0, pendingAccess: 0 } })),
          query: vi.fn((_name, _dbPath, fn) => {
            const fakeDb = {
              prepare: vi.fn(() => ({
                all: vi.fn(() => [{ lid: lidPhone, phone_jid: '15551234567@s.whatsapp.net' }]),
                get: vi.fn(() => undefined),
              })),
            };
            return { ok: true, data: fn(fakeDb as any) };
          }),
        } as any,
      });

      const res = mockRes();
      await handleGetLine(mockReq(), res, deps, { name: 'lidtest' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.adminPhonesDisplay).toBeDefined();
      expect(body.adminPhonesDisplay[lidPhone]).toBe('15551234567');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('omits adminPhonesDisplay when LID query fails', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const lidPhone = '123456789012345';
      fs.writeFileSync(configPath, JSON.stringify({ adminPhones: [lidPhone] }));

      const inst = fakeInstance({ name: 'lidfail', configPath });
      const deps = makeDeps({
        discovery: { getInstance: vi.fn(() => inst), getInstances: vi.fn() } as any,
        healthPoller: { getStatus: vi.fn(() => undefined), getStatuses: vi.fn() } as any,
        dbReader: {
          getSummaryStats: vi.fn(() => ({ ok: true, data: {} })),
          query: vi.fn(() => ({ ok: false, error: 'db locked' })),
        } as any,
      });

      const res = mockRes();
      await handleGetLine(mockReq(), res, deps, { name: 'lidfail' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.adminPhonesDisplay).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('omits adminPhonesDisplay when adminPhones are all short (no LID lookup needed)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cfg-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      // All entries <= 11 chars — no LID lookup triggered
      fs.writeFileSync(configPath, JSON.stringify({ adminPhones: ['15551234567'] }));

      const inst = fakeInstance({ name: 'shortph', configPath });
      const deps = makeDeps({
        discovery: { getInstance: vi.fn(() => inst), getInstances: vi.fn() } as any,
        healthPoller: { getStatus: vi.fn(() => undefined), getStatuses: vi.fn() } as any,
      });

      const res = mockRes();
      await handleGetLine(mockReq(), res, deps, { name: 'shortph' });
      expect(res._status).toBe(200);
      expect(JSON.parse(res._body).adminPhonesDisplay).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// handleGetLineProviderStatus — uncovered-branch coverage
// ---------------------------------------------------------------------------

describe('lines.ts uncovered-branch coverage', () => {
  function providerConfig(
    configPath: string,
    agentOptions: Record<string, unknown>,
  ): { inst: DiscoveredInstance; deps: LinesDeps } {
    fs.writeFileSync(configPath, JSON.stringify({ agentOptions }));
    const inst = fakeInstance({ name: 'ps-line', type: 'agent', configPath });
    const deps = makeDeps({
      discovery: {
        getInstance: vi.fn(() => inst),
        getInstances: vi.fn(() => new Map([['ps-line', inst]])),
      } as any,
      healthPoller: { getStatus: vi.fn(), getStatuses: vi.fn() } as any,
    });
    return { inst, deps };
  }

  it('returns 404 for an unknown instance in provider-status', async () => {
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => undefined), getInstances: vi.fn() } as any,
      healthPoller: { getStatus: vi.fn(), getStatuses: vi.fn() } as any,
    });
    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ghost' });
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toMatch(/not found/);
  });

  it('reports keyPresent:null for a native-auth claude-cli primary provider', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { deps } = providerConfig(configPath, { provider: 'claude-cli' });
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.primary).toMatchObject({ provider: 'claude-cli', keyPresent: null });
      expect(body.fallback).toMatchObject({ provider: null, keyPresent: null, active: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports keyPresent:true for openai-api primary when keyring resolves the key', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { deps } = providerConfig(configPath, {
        provider: 'openai-api',
        providerConfig: { model: 'gpt-4o' },
      });
      mockedLookup.mockImplementation((service: string) =>
        service === 'openai' ? 'openai-key-present-stub' : null,
      );
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.primary).toMatchObject({ provider: 'openai-api', model: 'gpt-4o', keyPresent: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exposes endpointHost (host only) and apiKeyService for a BYOK custom endpoint', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { deps } = providerConfig(configPath, {
        provider: 'openai-api',
        providerConfig: {
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKeyService: 'groq',
          model: 'llama-3.3-70b-versatile',
        },
      });
      mockedLookup.mockReturnValue(null);
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.primary.endpointHost).toBe('api.groq.com');
      expect(body.primary.apiKeyService).toBe('groq');
      // Host only — the path (which could carry tenant identifiers) must not leak.
      expect(JSON.stringify(body)).not.toContain('/openai/v1');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('attributes endpoint fields by CONSUMPTION: CLI primary with orphaned providerConfig reports null, API-sibling fallback reports the inherited endpoint', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      // claude-cli never consumes providerConfig; the openai-api fallback
      // inherits it at runtime (managed-API-sibling rule). The endpoint must
      // surface under fallback, NOT primary.
      const { deps } = providerConfig(configPath, {
        provider: 'claude-cli',
        fallbackProvider: 'openai-api',
        fallbackModel: 'llama-3.3-70b-versatile',
        providerConfig: {
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKeyService: 'groq',
        },
      });
      mockedLookup.mockImplementation((service: string) =>
        service === 'groq' ? 'groq-key-present-stub' : null,
      );
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.primary.endpointHost).toBeNull();
      expect(body.primary.apiKeyService).toBeNull();
      expect(body.fallback.endpointHost).toBe('api.groq.com');
      expect(body.fallback.apiKeyService).toBe('groq');
      // keyPresent must resolve via the INHERITED service (groq), not the
      // openai default — mirrors fallbackProviderConfigFor at runtime.
      expect(body.fallback.keyPresent).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('normalizes unparseable and no-authority on-disk baseUrl values to null without erroring', async () => {
    // This route reads raw disk JSON with no validator pass — malformed
    // values are reachable (hand-edited/authOnly-bootstrapped configs).
    for (const badBaseUrl of ['%%%not a url%%%', 'file:///tmp/endpoint']) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
      try {
        const configPath = path.join(tmp, 'config.json');
        const { deps } = providerConfig(configPath, {
          provider: 'openai-api',
          providerConfig: { baseUrl: badBaseUrl, apiKeyService: 'openai', model: 'gpt-4o' },
        });
        mockedLookup.mockReturnValue(null);
        const res = mockRes();
        await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
        expect(res._status, badBaseUrl + ' must not 500').toBe(200);
        const body = JSON.parse(res._body);
        expect(body.primary.endpointHost, badBaseUrl + ' must normalize to null').toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it('reports endpointHost/apiKeyService as null when providerConfig has no override', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { deps } = providerConfig(configPath, { provider: 'claude-cli' });
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.primary.endpointHost).toBeNull();
      expect(body.primary.apiKeyService).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports keyPresent:false for anthropic-api when keyring has no key', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { deps } = providerConfig(configPath, {
        provider: 'anthropic-api',
        model: 'claude-x',
      });
      mockedLookup.mockReturnValue(null);
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.primary).toMatchObject({ provider: 'anthropic-api', model: 'claude-x', keyPresent: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when the config file is unreadable (catch branch)', async () => {
    const inst = fakeInstance({
      name: 'ps-broken',
      type: 'agent',
      configPath: path.join(os.tmpdir(), 'definitely-missing-config-xyz.json'),
    });
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst), getInstances: vi.fn() } as any,
      healthPoller: { getStatus: vi.fn(), getStatuses: vi.fn() } as any,
    });
    const res = mockRes();
    await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-broken' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    // agent type with no readable config → defaults to claude-cli (native-auth → null)
    expect(body.primary).toMatchObject({ provider: 'claude-cli', keyPresent: null });
  });

  it('exposes a configured fallback chain with eligibility inherited from config (no health chain)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agentOptions: {
            provider: 'openai-api',
            providerConfig: { model: 'gpt-4o' },
            fallbacks: [
              { provider: 'anthropic-api', model: 'claude-x' },
              { provider: 'claude-cli' },
            ],
          },
        }),
      );
      const inst = fakeInstance({ name: 'ps-fb', type: 'agent', configPath });
      const deps = makeDeps({
        discovery: { getInstance: vi.fn(() => inst), getInstances: vi.fn() } as any,
        healthPoller: { getStatus: vi.fn(), getStatuses: vi.fn() } as any,
      });
      mockedLookup.mockReturnValue('openai-key-present-stub');
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-fb' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.fallback).toMatchObject({
        provider: 'anthropic-api',
        model: 'claude-x',
        keyPresent: true,
        chain: [
          { provider: 'anthropic-api', model: 'claude-x', eligible: null },
          { provider: 'claude-cli', model: null, eligible: null },
        ],
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reflects an active fallback window from the health snapshot and activeFallbackEntry', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { inst, deps } = providerConfig(configPath, { provider: 'claude-cli' });
      const future = Date.now() + 60_000;
      (deps.healthPoller.getStatus as any) = vi.fn(() =>
        fakeStatus({
          name: 'ps-line',
          status: 'online',
          health: {
            uptime: 1,
            instance: {
              fallbackActiveUntil: future,
              effectiveProvider: 'openai-api',
              fallbackReason: 'primary_key_missing',
              fallbackResetAt: future + 3_600_000,
              fallbackRecoveryProbeRequired: true,
              fallbackTurnsServed: 7,
              fallbackTurnsEmpty: 2,
              lastFallbackTurnAt: 1_700_000_000_000,
              probeAttempts: 3,
              lastProbeAt: 1_700_000_001_000,
              fallbackWindowCostUsd: 0.42,
              fallbackActivations: 5,
              fallbackReverts: 1,
              fallbackReplays: 2,
              activeFallbackEntry: { provider: 'openai-api', model: 'gpt-4o' },
              fallbackChain: [
                { provider: 'openai-api', model: 'gpt-4o', eligible: true },
                { provider: 'claude-cli', model: null, eligible: false },
              ],
            },
          },
        }),
      );
      void inst;
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.fallback).toMatchObject({
        active: true,
        effectiveProvider: 'openai-api',
        reason: 'primary_key_missing',
        recoveryProbeRequired: true,
        turnsServed: 7,
        turnsEmpty: 2,
        probeAttempts: 3,
        windowCostUsd: 0.42,
        activations: 5,
        reverts: 1,
        replays: 2,
        activeEntry: { provider: 'openai-api', model: 'gpt-4o' },
        chain: [
          { provider: 'openai-api', model: 'gpt-4o', eligible: true },
          { provider: 'claude-cli', model: null, eligible: false },
        ],
      });
      expect(body.signal).toMatchObject({
        status: 'online',
        confidence: 'confirmed',
        reason: 'health_body_ok',
        evidence: ['health_status=healthy'],
      });
      expect(body.lineReachable).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports lineReachable:false for a degraded instance with an error', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { deps } = providerConfig(configPath, { provider: 'claude-cli' });
      (deps.healthPoller.getStatus as any) = vi.fn(() =>
        fakeStatus({
          name: 'ps-line',
          status: 'degraded',
          error: 'upstream 503',
          health: null,
        }),
      );
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      const body = JSON.parse(res._body);
      expect(body.lineReachable).toBe(false);
      expect(body.signal).toMatchObject({ status: 'degraded', reason: 'health_body_ok' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports lineReachable:true for a degraded instance with no error and a health body', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { deps } = providerConfig(configPath, { provider: 'claude-cli' });
      (deps.healthPoller.getStatus as any) = vi.fn(() =>
        fakeStatus({
          name: 'ps-line',
          status: 'degraded',
          error: null,
          health: { uptime: 5 },
        }),
      );
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      const body = JSON.parse(res._body);
      expect(body.lineReachable).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports lineReachable:false for an offline status (terminal return-false arm)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { deps } = providerConfig(configPath, { provider: 'claude-cli' });
      (deps.healthPoller.getStatus as any) = vi.fn(() =>
        fakeStatus({
          name: 'ps-line',
          status: 'unreachable',
          health: { uptime: 1 },
        }),
      );
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      const body = JSON.parse(res._body);
      expect(body.lineReachable).toBe(false);
      expect(body.signal).toMatchObject({ status: 'unreachable' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports not_polled signal when the poller has no status for the line', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      const { deps } = providerConfig(configPath, { provider: 'claude-cli' });
      // getStatus already returns undefined by default from makeDeps
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-line' });
      const body = JSON.parse(res._body);
      expect(body.signal).toEqual({ status: null, confidence: null, reason: 'not_polled', evidence: [] });
      expect(body.lineReachable).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('treats a config that parses to a non-object (array) as empty (line 673 branch)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ps-'));
    try {
      const configPath = path.join(tmp, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(['not-an-object']));
      const inst = fakeInstance({ name: 'ps-arr', type: 'chat', configPath });
      const deps = makeDeps({
        discovery: { getInstance: vi.fn(() => inst), getInstances: vi.fn() } as any,
        healthPoller: { getStatus: vi.fn(), getStatuses: vi.fn() } as any,
      });
      const res = mockRes();
      await handleGetLineProviderStatus(mockReq(), res, deps, { name: 'ps-arr' });
      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      // non-agent type with no readable object config → provider null (line 680 false branch)
      expect(body.primary).toMatchObject({ provider: null, keyPresent: null });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
