/**
 * Extended coverage tests for src/fleet/routes/metrics.ts
 * Target repo path: tests/fleet/routes/metrics-extended.test.ts
 *
 * Existing tests/fleet/routes/metrics.test.ts covers fleet-metrics.ts (handleGetFleetMetrics),
 * NOT the per-line metrics route in routes/metrics.ts (handleGetMetrics).
 * This file covers all remaining uncovered lines: 20, 21, 23-27, 30-33, 36.
 *
 * Branches:
 *   - requireInstance returns null → early return (lines 20-21)
 *   - range param absent → default '24h' (line 24 else branch)
 *   - range param present and valid
 *   - range param present and invalid → 400 (lines 25-27)
 *   - dbReader.getMetrics returns ok:false → 500 (lines 31-33)
 *   - dbReader.getMetrics returns ok:true → 200 (line 36)
 */
import { describe, it, expect, vi } from 'vitest';
import { handleGetMetrics } from '../../../src/fleet/routes/metrics.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';
import type { MetricsDeps } from '../../../src/fleet/routes/metrics.ts';

function makeDeps(overrides: Partial<MetricsDeps> = {}): MetricsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => undefined),
    } as any,
    dbReader: {
      getMetrics: vi.fn(() => ({ ok: true, data: {} })),
    } as any,
    ...overrides,
  };
}

function fakeInstance(overrides = {}) {
  return {
    name: 'test-line',
    dbPath: '/data/test-line/bot.db',
    type: 'passive',
    ...overrides,
  };
}

describe('handleGetMetrics', () => {
  it('returns 404 when instance is not found (requireInstance null path)', () => {
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => undefined) } as any,
    });
    const res = mockRes();
    handleGetMetrics(mockReq({ url: '/api/lines/missing/metrics' }), res, deps, { name: 'missing' });
    expect(res._status).toBe(404);
    expect(deps.dbReader.getMetrics).not.toHaveBeenCalled();
  });

  it('defaults range to 24h when query param is absent', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getMetrics: vi.fn(() => ({
          ok: true,
          data: { messageVolume: [], tokenUsage: [], sessionActivity: [] },
        })),
      } as any,
    });
    const res = mockRes();
    handleGetMetrics(mockReq({ url: '/api/lines/test-line/metrics' }), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(deps.dbReader.getMetrics).toHaveBeenCalledWith('test-line', '/data/test-line/bot.db', { range: '24h' });
    const body = JSON.parse(res._body);
    expect(body.range).toBe('24h');
  });

  it('uses provided valid range param 7d', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getMetrics: vi.fn(() => ({
          ok: true,
          data: { messageVolume: [], tokenUsage: [], sessionActivity: [] },
        })),
      } as any,
    });
    const res = mockRes();
    handleGetMetrics(mockReq({ url: '/api/lines/test-line/metrics?range=7d' }), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(deps.dbReader.getMetrics).toHaveBeenCalledWith('test-line', '/data/test-line/bot.db', { range: '7d' });
    const body = JSON.parse(res._body);
    expect(body.range).toBe('7d');
  });

  it('uses provided valid range param 30d', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getMetrics: vi.fn(() => ({
          ok: true,
          data: { messageVolume: [], tokenUsage: [], sessionActivity: [] },
        })),
      } as any,
    });
    const res = mockRes();
    handleGetMetrics(mockReq({ url: '/api/lines/test-line/metrics?range=30d' }), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.range).toBe('30d');
  });

  it('returns 400 for an invalid range param', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });
    const res = mockRes();
    handleGetMetrics(mockReq({ url: '/api/lines/test-line/metrics?range=90d' }), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'range must be one of: 24h, 7d, 30d' });
    expect(deps.dbReader.getMetrics).not.toHaveBeenCalled();
  });

  it('returns 400 for another invalid range value', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });
    const res = mockRes();
    handleGetMetrics(mockReq({ url: '/api/lines/test-line/metrics?range=1h' }), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
  });

  it('returns 500 when dbReader.getMetrics returns ok:false', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getMetrics: vi.fn(() => ({ ok: false, error: 'database locked' })),
      } as any,
    });
    const res = mockRes();
    handleGetMetrics(mockReq({ url: '/api/lines/test-line/metrics' }), res, deps, { name: 'test-line' });
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toEqual({ error: 'database locked' });
  });

  it('returns 200 with merged range and data on success', () => {
    const inst = fakeInstance();
    const metricData = {
      messageVolume: [{ bucket: '2026-04-05T17:00:00.000Z', inbound: 5, outbound: 3, media: 1 }],
      tokenUsage: [],
      sessionActivity: [],
      activeHours: [],
      hasMessageData: true,
      hasTokenData: false,
      hasSessionData: false,
    };
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getMetrics: vi.fn(() => ({ ok: true, data: metricData })),
      } as any,
    });
    const res = mockRes();
    handleGetMetrics(mockReq({ url: '/api/lines/test-line/metrics?range=24h' }), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.range).toBe('24h');
    expect(body.messageVolume).toEqual(metricData.messageVolume);
    expect(body.hasMessageData).toBe(true);
  });
});
