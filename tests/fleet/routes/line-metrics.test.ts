import { describe, expect, it, vi } from 'vitest';
import { handleGetMetrics } from '../../../src/fleet/routes/metrics.ts';
import type { MetricsDeps } from '../../../src/fleet/routes/metrics.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

function makeDeps(overrides: Partial<MetricsDeps> = {}): MetricsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => ({
        name: 'q',
        dbPath: '/tmp/q.db',
      })),
    } as any,
    dbReader: {
      getMetrics: vi.fn(() => ({
        ok: true,
        data: {
          messageVolume: [
            { bucket: '2026-06-13T12:00:00.000Z', inbound: 2, outbound: 1, media: 0 },
          ],
          tokenUsage: [],
          sessionActivity: [],
          activeHours: [],
          hasMessageData: true,
          hasTokenData: false,
          hasSessionData: false,
        },
      })),
    } as any,
    ...overrides,
  };
}

describe('handleGetMetrics', () => {
  it('returns 404 when the line instance is unknown', () => {
    const deps = makeDeps({
      discovery: {
        getInstance: vi.fn(() => undefined),
      } as any,
    });
    const res = mockRes();

    handleGetMetrics(mockReq({ url: '/api/lines/missing/metrics' }), res, deps, { name: 'missing' });

    expect(deps.discovery.getInstance).toHaveBeenCalledWith('missing');
    expect(deps.dbReader.getMetrics).not.toHaveBeenCalled();
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: "instance 'missing' not found" });
  });

  it('uses the default 24h range when the query omits range', () => {
    const deps = makeDeps();
    const res = mockRes();

    handleGetMetrics(mockReq({ url: '/api/lines/q/metrics' }), res, deps, { name: 'q' });

    expect(deps.dbReader.getMetrics).toHaveBeenCalledWith('q', '/tmp/q.db', { range: '24h' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      range: '24h',
      messageVolume: [
        { bucket: '2026-06-13T12:00:00.000Z', inbound: 2, outbound: 1, media: 0 },
      ],
      tokenUsage: [],
      sessionActivity: [],
      activeHours: [],
      hasMessageData: true,
      hasTokenData: false,
      hasSessionData: false,
    });
  });

  it.each(['7d', '30d'] as const)('passes through valid %s range queries', (range) => {
    const deps = makeDeps();
    const res = mockRes();

    handleGetMetrics(mockReq({ url: `/api/lines/q/metrics?range=${range}` }), res, deps, { name: 'q' });

    expect(deps.dbReader.getMetrics).toHaveBeenCalledWith('q', '/tmp/q.db', { range });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).range).toBe(range);
  });

  it('returns 400 for an unsupported range before querying metrics', () => {
    const deps = makeDeps();
    const res = mockRes();

    handleGetMetrics(mockReq({ url: '/api/lines/q/metrics?range=90d' }), res, deps, { name: 'q' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'range must be one of: 24h, 7d, 30d',
    });
    expect(deps.dbReader.getMetrics).not.toHaveBeenCalled();
  });

  it('returns reader failures as 500 JSON responses', () => {
    const deps = makeDeps({
      dbReader: {
        getMetrics: vi.fn(() => ({ ok: false, error: 'database locked' })),
      } as any,
    });
    const res = mockRes();

    handleGetMetrics(mockReq({ url: '/api/lines/q/metrics?range=24h' }), res, deps, { name: 'q' });

    expect(deps.dbReader.getMetrics).toHaveBeenCalledWith('q', '/tmp/q.db', { range: '24h' });
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toEqual({ error: 'database locked' });
  });
});
