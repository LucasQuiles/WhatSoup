import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGetFleetMetrics } from '../../../src/fleet/routes/fleet-metrics.ts';

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
    handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);

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
    handleGetFleetMetrics(mockReq('/api/metrics?range=90d'), res, deps);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'range must be one of: 24h, 7d, 30d',
    });
    expect(deps.dbReader.getMetrics).not.toHaveBeenCalled();
  });
});
