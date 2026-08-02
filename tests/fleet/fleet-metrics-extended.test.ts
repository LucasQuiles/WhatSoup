import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleGetFleetMetrics, type FleetMetricsDeps } from '../../src/fleet/routes/fleet-metrics.ts';
import { mockReq, mockRes } from '../helpers/http-mocks.ts';

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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
    handleGetFleetMetrics(mockReq({ url: '/api/metrics?range=24h' }), res, deps);
    const body = JSON.parse(res._body);

    expect(res._status).toBe(200);
    expect(body.range).toBe('24h');
    expect(body.messageVolume).toHaveLength(1);
    expect(body.messageVolume[0]).toEqual({
      bucket: '2026-04-05T15:00:00.000Z',
      inbound: 8,
      outbound: 5,
      media: 1,
    });
    expect(body.tokenUsage[0]).toEqual({
      bucket: '2026-04-05T15:00:00.000Z',
      input: 300,
      output: 125,
    });
    expect(body.sessionActivity[0]).toEqual({
      bucket: '2026-04-05T15:00:00.000Z',
      active: 3,
      started: 1,
    });
    expect(body.meta.instancesQueried).toBe(2);
    expect(body.meta.instancesFailed).toBe(0);
    expect(body.meta.hasMessageData).toBe(true);
    expect(body.meta.hasTokenData).toBe(true);
    expect(body.meta.hasSessionData).toBe(true);
  });

  it('aggregates per-provider token and session data across instances', () => {
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
              sessionActivity: [{ bucket: '2026-04-05T15:00:00.000Z', active: 2, started: 1 }],
              activeHours: [],
              hasMessageData: true, hasTokenData: true, hasSessionData: true,
              tokenUsageByProvider: {
                'claude-cli': [{ bucket: '2026-04-05T15:00:00.000Z', input: 100, output: 50 }],
              },
              sessionActivityByProvider: {
                'claude-cli': [{ bucket: '2026-04-05T15:00:00.000Z', active: 2, started: 1 }],
              },
              providers: ['claude-cli'],
            },
          })
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [{ bucket: '2026-04-05T15:00:00.000Z', inbound: 3, outbound: 2, media: 0 }],
              tokenUsage: [{ bucket: '2026-04-05T15:00:00.000Z', input: 200, output: 75 }],
              sessionActivity: [{ bucket: '2026-04-05T15:00:00.000Z', active: 1, started: 1 }],
              activeHours: [],
              hasMessageData: true, hasTokenData: true, hasSessionData: true,
              tokenUsageByProvider: {
                'codex-cli': [{ bucket: '2026-04-05T15:00:00.000Z', input: 200, output: 75 }],
              },
              sessionActivityByProvider: {
                'codex-cli': [{ bucket: '2026-04-05T15:00:00.000Z', active: 1, started: 1 }],
              },
              providers: ['codex-cli'],
            },
          }),
      } as any,
    };

    const res = mockRes();
    handleGetFleetMetrics(mockReq({ url: '/api/metrics?range=24h' }), res, deps);
    const body = JSON.parse(res._body);

    expect(body.meta.providers.sort()).toEqual(['claude-cli', 'codex-cli']);
    expect(body.tokenUsageByProvider['claude-cli'][0].input).toBe(100);
    expect(body.tokenUsageByProvider['codex-cli'][0].input).toBe(200);
    expect(body.sessionActivityByProvider['claude-cli'][0].active).toBe(2);
    expect(body.sessionActivityByProvider['codex-cli'][0].active).toBe(1);
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
    handleGetFleetMetrics(mockReq({ url: '/api/metrics?range=24h' }), res, deps);
    const body = JSON.parse(res._body);

    expect(res._status).toBe(200);
    expect(body.meta.instancesQueried).toBe(2);
    expect(body.meta.instancesFailed).toBe(1);
    expect(body.messageVolume).toHaveLength(1);
    expect(body.messageVolume[0].inbound).toBe(5);
  });
});
