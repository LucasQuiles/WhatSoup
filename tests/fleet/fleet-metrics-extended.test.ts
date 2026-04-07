import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGetFleetMetrics, type FleetMetricsDeps } from '../../src/fleet/routes/fleet-metrics.ts';

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function mockRes(): ServerResponse & { _statusCode: number; _body: any } {
  const res = {
    _statusCode: 0,
    _body: null,
    writeHead(code: number) { res._statusCode = code; return res; },
    end(body: string) { res._body = JSON.parse(body); },
    setHeader() {},
  } as unknown as ServerResponse & { _statusCode: number; _body: any };
  return res;
}

function mockReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

describe('handleGetFleetMetrics — extended', () => {
  it('aggregates all 9 metrics across instances with meta flags', () => {
    const deps: FleetMetricsDeps = {
      discovery: {
        getInstances: () => new Map([
          ['inst1', { name: 'inst1', dbPath: '/tmp/1.db' }],
          ['inst2', { name: 'inst2', dbPath: '/tmp/2.db' }],
        ]),
      } as any,
      dbReader: {
        getMetrics: vi.fn()
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [{ bucket: '2026-04-05T15:00:00.000Z', inbound: 5, outbound: 3, media: 1 }],
              tokenUsage: [{ bucket: '2026-04-05T15:00:00.000Z', input: 100, output: 50 }],
              sessionActivity: [{ bucket: '2026-04-05T15:00:00.000Z', active: 2, started: 1 }],
              activeHours: [],
              hasMessageData: true,
              hasTokenData: true,
              hasSessionData: true,
            },
          })
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [{ bucket: '2026-04-05T15:00:00.000Z', inbound: 3, outbound: 2, media: 0 }],
              tokenUsage: [{ bucket: '2026-04-05T15:00:00.000Z', input: 200, output: 75 }],
              sessionActivity: [{ bucket: '2026-04-05T15:00:00.000Z', active: 1, started: 0 }],
              activeHours: [],
              hasMessageData: true,
              hasTokenData: true,
              hasSessionData: true,
            },
          }),
      } as any,
    };

    const res = mockRes();
    handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);

    expect(res._statusCode).toBe(200);
    expect(res._body.range).toBe('24h');
    expect(res._body.messageVolume).toHaveLength(1);
    expect(res._body.messageVolume[0]).toEqual({
      bucket: '2026-04-05T15:00:00.000Z',
      inbound: 8,
      outbound: 5,
      media: 1,
    });
    expect(res._body.tokenUsage[0]).toEqual({
      bucket: '2026-04-05T15:00:00.000Z',
      input: 300,
      output: 125,
    });
    expect(res._body.sessionActivity[0]).toEqual({
      bucket: '2026-04-05T15:00:00.000Z',
      active: 3,
      started: 1,
    });
    expect(res._body.meta.instancesQueried).toBe(2);
    expect(res._body.meta.instancesFailed).toBe(0);
    expect(res._body.meta.hasMessageData).toBe(true);
    expect(res._body.meta.hasTokenData).toBe(true);
    expect(res._body.meta.hasSessionData).toBe(true);
  });

  it('handles partial instance failure with meta.instancesFailed', () => {
    const deps: FleetMetricsDeps = {
      discovery: {
        getInstances: () => new Map([
          ['inst1', { name: 'inst1', dbPath: '/tmp/1.db' }],
          ['inst2', { name: 'inst2', dbPath: '/tmp/2.db' }],
        ]),
      } as any,
      dbReader: {
        getMetrics: vi.fn()
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [{ bucket: '2026-04-05T15:00:00.000Z', inbound: 5, outbound: 3, media: 0 }],
              tokenUsage: [{ bucket: '2026-04-05T15:00:00.000Z', input: 100, output: 50 }],
              sessionActivity: [{ bucket: '2026-04-05T15:00:00.000Z', active: 1, started: 1 }],
              activeHours: [],
              hasMessageData: true,
              hasTokenData: true,
              hasSessionData: true,
            },
          })
          .mockReturnValueOnce({ ok: false, error: 'db locked' }),
      } as any,
    };

    const res = mockRes();
    handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);

    expect(res._statusCode).toBe(200);
    expect(res._body.meta.instancesQueried).toBe(2);
    expect(res._body.meta.instancesFailed).toBe(1);
    expect(res._body.messageVolume).toHaveLength(1);
    expect(res._body.messageVolume[0].inbound).toBe(5);
  });
});
