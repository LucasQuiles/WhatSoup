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

function emptyData() {
  return {
    messageVolume: [],
    tokenUsage: [],
    sessionActivity: [],
    activeHours: [],
    hasMessageData: false,
    hasTokenData: false,
    hasSessionData: false,
    tokenUsageByProvider: {},
    sessionActivityByProvider: {},
    providers: [],
  };
}

function makeDeps(overrides: Partial<FleetMetricsDeps> = {}): FleetMetricsDeps {
  return {
    discovery: {
      getInstances: vi.fn(() => new Map()),
    } as any,
    dbReader: {
      getMetrics: vi.fn(() => ({ ok: true, data: emptyData() })),
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
                { bucket: '2026-04-05T17:00:00.000Z', inbound: 2, outbound: 3, media: 0 },
                { bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 1, media: 1 },
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
                { bucket: '2026-04-05T17:00:00.000Z', inbound: 5, outbound: 2, media: 0 },
                { bucket: '2026-04-05T19:00:00.000Z', inbound: 1, outbound: 6, media: 0 },
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
      } as any,
    });
    const res = mockRes();

    handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.range).toBe('24h');
    expect(body.messageVolume).toEqual([
      { bucket: '2026-04-05T17:00:00.000Z', inbound: 7, outbound: 5, media: 0 },
      { bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 1, media: 1 },
      { bucket: '2026-04-05T19:00:00.000Z', inbound: 1, outbound: 6, media: 0 },
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
                { bucket: '2026-04-05T19:00:00.000Z', inbound: 3, outbound: 4, media: 0 },
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
      } as any,
    });
    const res = mockRes();

    handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.messageVolume).toEqual([
      { bucket: '2026-04-05T19:00:00.000Z', inbound: 3, outbound: 4, media: 0 },
    ]);
    expect(body.meta).toEqual({
      instancesQueried: 2,
      instancesFailed: 1,
      hasMessageData: true,
      hasTokenData: false,
      hasSessionData: false,
      providers: [],
    });
  });

  it('does not depend on the runtime default locale for bucket ordering', () => {
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([
          ['alpha', { name: 'alpha', dbPath: '/tmp/alpha.db' }],
        ])),
      } as any,
      dbReader: {
        getMetrics: vi.fn(() => ({
          ok: true,
          data: {
            messageVolume: [
              { bucket: '2026-04-05T19:00:00.000Z', inbound: 1, outbound: 0, media: 0 },
              { bucket: '2026-04-05T17:00:00.000Z', inbound: 2, outbound: 0, media: 0 },
            ],
            tokenUsage: [
              { bucket: '2026-04-05T19:00:00.000Z', input: 9, output: 0 },
              { bucket: '2026-04-05T17:00:00.000Z', input: 7, output: 0 },
            ],
            sessionActivity: [
              { bucket: '2026-04-05T19:00:00.000Z', active: 9, started: 0 },
              { bucket: '2026-04-05T17:00:00.000Z', active: 7, started: 0 },
            ],
            activeHours: [],
            hasMessageData: true,
            hasTokenData: true,
            hasSessionData: true,
            tokenUsageByProvider: {
              local: [
                { bucket: '2026-04-05T19:00:00.000Z', input: 9, output: 0 },
                { bucket: '2026-04-05T17:00:00.000Z', input: 7, output: 0 },
              ],
            },
            sessionActivityByProvider: {
              local: [
                { bucket: '2026-04-05T19:00:00.000Z', active: 9, started: 0 },
                { bucket: '2026-04-05T17:00:00.000Z', active: 7, started: 0 },
              ],
            },
            providers: ['local'],
          },
        })),
      } as any,
    });
    const nativeLocaleCompare = String.prototype.localeCompare;
    const localeSpy = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function (
        this: string,
        compareString: string,
        locales?: Intl.LocalesArgument,
        options?: Intl.CollatorOptions,
      ) {
        if (locales === 'en' && options?.sensitivity === 'base') {
          return nativeLocaleCompare.call(this, compareString, locales, options);
        }
        return -nativeLocaleCompare.call(this, compareString, 'en', { sensitivity: 'base' });
      });
    const res = mockRes();

    try {
      handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);
    } finally {
      localeSpy.mockRestore();
    }

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.messageVolume.map((bucket: { bucket: string }) => bucket.bucket)).toEqual([
      '2026-04-05T17:00:00.000Z',
      '2026-04-05T19:00:00.000Z',
    ]);
    expect(body.tokenUsage.map((bucket: { bucket: string }) => bucket.bucket)).toEqual([
      '2026-04-05T17:00:00.000Z',
      '2026-04-05T19:00:00.000Z',
    ]);
    expect(body.sessionActivity.map((bucket: { bucket: string }) => bucket.bucket)).toEqual([
      '2026-04-05T17:00:00.000Z',
      '2026-04-05T19:00:00.000Z',
    ]);
    expect(body.tokenUsageByProvider.local.map((bucket: { bucket: string }) => bucket.bucket)).toEqual([
      '2026-04-05T17:00:00.000Z',
      '2026-04-05T19:00:00.000Z',
    ]);
    expect(body.sessionActivityByProvider.local.map((bucket: { bucket: string }) => bucket.bucket)).toEqual([
      '2026-04-05T17:00:00.000Z',
      '2026-04-05T19:00:00.000Z',
    ]);
  });
});
