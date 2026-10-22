/**
 * #2200 (src/fleet slice): the per-line stat caches in routes/lines.ts expire
 * by the injected Clock carried in LinesDeps, not the raw wall clock.
 *
 * Two GET /api/lines calls at the same injected instant are served from the
 * cache. Advancing only the injected clock past the 60 s TTL must force a
 * fresh read. A handler that reads the wall clock never sees the advance and
 * keeps serving the cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGetLines, _resetLineCaches, type LinesDeps } from '../../../src/fleet/routes/lines.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { fakeClock } from '../../../src/lib/clock.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

vi.mock('../../../src/logger.ts', async () => (await import('../../helpers/logger-mock.ts')).loggerMock());

const FAKE_NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');
/** DAILY_CACHE_TTL in routes/lines.ts. */
const CACHE_TTL_MS = 60_000;

const INSTANCE: DiscoveredInstance = {
  name: 'agent-line',
  type: 'agent',
  accessMode: 'self_only',
  healthPort: 3010,
  dbPath: '/nonexistent/agent-line/bot.db',
  stateRoot: '/nonexistent/agent-line/state',
  logDir: '/nonexistent/agent-line/logs',
  healthToken: null,
  configPath: '/nonexistent/agent-line/config.json',
  socketPath: null,
};

describe('#2200 line stat caches expire by the injected clock', () => {
  beforeEach(() => {
    _resetLineCaches();
  });

  it('serves the cache inside the TTL and re-reads once the injected clock passes it', () => {
    const clock = fakeClock(FAKE_NOW_MS);
    // Runs each stat query against an empty database stub, so every helper
    // returns an available, cacheable observation.
    const emptyDb = { prepare: () => ({ get: () => undefined, all: () => [] }) };
    const query = vi.fn((_name: string, _dbPath: string, read: (db: unknown) => unknown) => ({ ok: true, data: read(emptyDb) }));
    const deps: LinesDeps = {
      discovery: {
        getInstance: vi.fn(() => INSTANCE),
        getInstances: vi.fn(() => new Map([[INSTANCE.name, INSTANCE]])),
      } as unknown as LinesDeps['discovery'],
      healthPoller: {
        getStatus: vi.fn(() => undefined),
        getStatuses: vi.fn(() => new Map()),
      } as unknown as LinesDeps['healthPoller'],
      dbReader: { query } as unknown as LinesDeps['dbReader'],
      clock,
    };

    handleGetLines(mockReq(), mockRes(), deps);
    const firstReads = query.mock.calls.length;
    expect(firstReads).toBeGreaterThan(0);

    handleGetLines(mockReq(), mockRes(), deps);
    expect(query.mock.calls.length).toBe(firstReads);

    clock.advance(CACHE_TTL_MS);
    handleGetLines(mockReq(), mockRes(), deps);
    expect(query.mock.calls.length).toBe(firstReads * 2);
  });
});
