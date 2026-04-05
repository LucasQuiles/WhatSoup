import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGetFleetMetrics } from '../../../src/fleet/routes/fleet-metrics.ts';
import type { FleetMetricsDeps } from '../../../src/fleet/routes/fleet-metrics.ts';

function mockReq(url = '/'): IncomingMessage {
  return { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) {
      res._status = status;
    },
    end(data?: string) {
      if (data) res._body = data;
    },
  };
  return res as any;
}

function makeDeps(overrides: Partial<FleetMetricsDeps> = {}): FleetMetricsDeps {
  return {
    discovery: {
      getInstances: vi.fn(() => new Map()),
    } as any,
    dbReader: {
      getMetrics: vi.fn(() => ({ ok: true, data: { messageVolume: [], activeHours: [] } })),
    } as any,
    ...overrides,
  };
}

describe('handleGetFleetMetrics', () => {
  it('returns 400 for invalid range', () => {
    const deps = makeDeps();
    const res = mockRes();

    handleGetFleetMetrics(mockReq('/api/metrics?range=bad'), res, deps);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'range must be one of: 24h, 7d, 30d',
    });
  });

  it('aggregates message volume across all discovered instances', () => {
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([
          ['alpha', { name: 'alpha', dbPath: '/tmp/alpha.db' }],
          ['beta', { name: 'beta', dbPath: '/tmp/beta.db' }],
        ])),
      } as any,
      dbReader: {
        getMetrics: vi
          .fn()
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [
                { bucket: '2026-04-05T17:00:00.000Z', inbound: 2, outbound: 3 },
                { bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 1 },
              ],
              activeHours: [],
            },
          })
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [
                { bucket: '2026-04-05T17:00:00.000Z', inbound: 5, outbound: 2 },
                { bucket: '2026-04-05T19:00:00.000Z', inbound: 1, outbound: 6 },
              ],
              activeHours: [],
            },
          }),
      } as any,
    });
    const res = mockRes();

    handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      range: '24h',
      messageVolume: [
        { bucket: '2026-04-05T17:00:00.000Z', inbound: 7, outbound: 5 },
        { bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 1 },
        { bucket: '2026-04-05T19:00:00.000Z', inbound: 1, outbound: 6 },
      ],
    });
  });

  it('skips instances whose metrics query fails', () => {
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([
          ['alpha', { name: 'alpha', dbPath: '/tmp/alpha.db' }],
          ['beta', { name: 'beta', dbPath: '/tmp/beta.db' }],
        ])),
      } as any,
      dbReader: {
        getMetrics: vi
          .fn()
          .mockReturnValueOnce({ ok: false, error: 'db locked' })
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [
                { bucket: '2026-04-05T19:00:00.000Z', inbound: 3, outbound: 4 },
              ],
              activeHours: [],
            },
          }),
      } as any,
    });
    const res = mockRes();

    handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      range: '24h',
      messageVolume: [
        { bucket: '2026-04-05T19:00:00.000Z', inbound: 3, outbound: 4 },
      ],
    });
  });
});
