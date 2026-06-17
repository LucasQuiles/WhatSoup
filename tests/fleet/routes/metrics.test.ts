import { describe, expect, it, vi } from 'vitest';
import { handleGetFleetMetrics } from '../../../src/fleet/routes/fleet-metrics.ts';
import { handleGetMetrics } from '../../../src/fleet/routes/metrics.ts';
import type { MetricsDeps } from '../../../src/fleet/routes/metrics.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

function lineMetricsData(overrides: Record<string, unknown> = {}) {
  return {
    messageVolume: [
      { bucket: '2026-04-05T17:00:00.000Z', inbound: 2, outbound: 1, media: 0 },
    ],
    tokenUsage: [
      { bucket: '2026-04-05T17:00:00.000Z', input: 11, output: 7 },
    ],
    sessionActivity: [
      { bucket: '2026-04-05T17:00:00.000Z', active: 1, started: 1 },
    ],
    activeHours: [[0, 1, 0]],
    activeHoursByDate: [{ date: '2026-04-05', hours: [0, 1, 0] }],
    hasMessageData: true,
    hasTokenData: true,
    hasSessionData: true,
    tokenUsageByProvider: {
      claude: [{ bucket: '2026-04-05T17:00:00.000Z', input: 11, output: 7 }],
    },
    sessionActivityByProvider: {
      claude: [{ bucket: '2026-04-05T17:00:00.000Z', active: 1, started: 1 }],
    },
    providers: ['claude'],
    ...overrides,
  };
}

function makeLineMetricsDeps(overrides: Partial<MetricsDeps> = {}): MetricsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => ({
        name: 'alpha',
        dbPath: '/tmp/alpha.db',
      })),
    } as any,
    dbReader: {
      getMetrics: vi.fn(() => ({
        ok: true,
        data: lineMetricsData(),
      })),
    } as any,
    ...overrides,
  };
}

describe('handleGetMetrics', () => {
  it('returns 404 and skips database reads when the line is unknown', () => {
    const deps = makeLineMetricsDeps({
      discovery: {
        getInstance: vi.fn(() => undefined),
      } as any,
    });
    const res = mockRes();

    handleGetMetrics(mockReq({ url: '/api/lines/missing/metrics?range=24h' }), res, deps, { name: 'missing' });

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: "instance 'missing' not found" });
    expect(deps.dbReader.getMetrics).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid line metric ranges after the line is resolved', () => {
    const deps = makeLineMetricsDeps();
    const res = mockRes();

    handleGetMetrics(mockReq({ url: '/api/lines/alpha/metrics?range=90d' }), res, deps, { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'range must be one of: 24h, 7d, 30d',
    });
    expect(deps.discovery.getInstance).toHaveBeenCalledWith('alpha');
    expect(deps.dbReader.getMetrics).not.toHaveBeenCalled();
  });

  it('defaults to a 24h range and returns the line metrics payload', () => {
    const deps = makeLineMetricsDeps();
    const res = mockRes();

    handleGetMetrics(mockReq({ url: '/api/lines/alpha/metrics' }), res, deps, { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(deps.dbReader.getMetrics).toHaveBeenCalledWith('alpha', '/tmp/alpha.db', { range: '24h' });
    expect(JSON.parse(res._body)).toEqual({
      range: '24h',
      ...lineMetricsData(),
    });
  });

  it('passes through an explicit 30d range to the database reader', () => {
    const deps = makeLineMetricsDeps({
      dbReader: {
        getMetrics: vi.fn(() => ({
          ok: true,
          data: lineMetricsData({ providers: ['claude', 'openai'] }),
        })),
      } as any,
    });
    const res = mockRes();

    handleGetMetrics(mockReq({ url: '/api/lines/alpha/metrics?range=30d' }), res, deps, { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(deps.dbReader.getMetrics).toHaveBeenCalledWith('alpha', '/tmp/alpha.db', { range: '30d' });
    expect(JSON.parse(res._body).providers).toEqual(['claude', 'openai']);
  });

  it('returns a 500 response when line metrics cannot be read', () => {
    const deps = makeLineMetricsDeps({
      dbReader: {
        getMetrics: vi.fn(() => ({ ok: false, error: 'db locked' })),
      } as any,
    });
    const res = mockRes();

    handleGetMetrics(mockReq({ url: '/api/lines/alpha/metrics?range=7d' }), res, deps, { name: 'alpha' });

    expect(res._status).toBe(500);
    expect(deps.dbReader.getMetrics).toHaveBeenCalledWith('alpha', '/tmp/alpha.db', { range: '7d' });
    expect(JSON.parse(res._body)).toEqual({ error: 'db locked' });
  });
});

describe('handleGetFleetMetrics', () => {
  it('aggregates message volume across instances', () => {
    const deps = {
      discovery: {
        getInstances: vi.fn(() => new Map([
          ['alpha', { name: 'alpha', dbPath: '/tmp/alpha.db' }],
          ['beta', { name: 'beta', dbPath: '/tmp/beta.db' }],
        ])),
      },
      dbReader: {
        getMetrics: vi
          .fn()
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [
                { bucket: '2026-04-05T17:00:00.000Z', inbound: 2, outbound: 1, media: 0 },
                { bucket: '2026-04-05T18:00:00.000Z', inbound: 3, outbound: 2, media: 1 },
              ],
              tokenUsage: [],
              sessionActivity: [],
              activeHours: [],
              hasMessageData: true,
              hasTokenData: false,
              hasSessionData: false,
              tokenUsageByProvider: {},
              sessionActivityByProvider: {},
              providers: [],
            },
          })
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [
                { bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 5, media: 0 },
                { bucket: '2026-04-05T19:00:00.000Z', inbound: 1, outbound: 0, media: 0 },
              ],
              tokenUsage: [],
              sessionActivity: [],
              activeHours: [],
              hasMessageData: true,
              hasTokenData: false,
              hasSessionData: false,
              tokenUsageByProvider: {},
              sessionActivityByProvider: {},
              providers: [],
            },
          }),
      },
    } as any;

    const res = mockRes();
    handleGetFleetMetrics(mockReq({ url: '/api/metrics?range=24h' }), res, deps);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.range).toBe('24h');
    expect(body.messageVolume).toEqual([
      { bucket: '2026-04-05T17:00:00.000Z', inbound: 2, outbound: 1, media: 0 },
      { bucket: '2026-04-05T18:00:00.000Z', inbound: 7, outbound: 7, media: 1 },
      { bucket: '2026-04-05T19:00:00.000Z', inbound: 1, outbound: 0, media: 0 },
    ]);
    expect(body.tokenUsage).toEqual([]);
    expect(body.sessionActivity).toEqual([]);
    expect(body.meta).toEqual({
      instancesQueried: 2,
      instancesFailed: 0,
      hasMessageData: true,
      hasTokenData: false,
      hasSessionData: false,
      providers: [],
    });
  });

  it('returns 400 for an invalid range', () => {
    const deps = {
      discovery: { getInstances: vi.fn(() => new Map()) },
      dbReader: { getMetrics: vi.fn() },
    } as any;

    const res = mockRes();
    handleGetFleetMetrics(mockReq({ url: '/api/metrics?range=90d' }), res, deps);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'range must be one of: 24h, 7d, 30d',
    });
    expect(deps.dbReader.getMetrics).not.toHaveBeenCalled();
  });
});
