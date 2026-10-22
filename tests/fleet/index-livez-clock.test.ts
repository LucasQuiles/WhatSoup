/**
 * #2200 (src/fleet slice): createFleetServer records its start time from the
 * injected Clock in FleetDeps and hands the same clock to /livez, so
 * `started_at` and `uptime_seconds` are both judged by one clock.
 *
 * The request is emitted straight into the server's request listener; the
 * server never listens and no pollers start.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { fakeClock } from '../../src/lib/clock.ts';
import { mockReq, mockRes } from '../helpers/http-mocks.ts';

vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());
vi.mock('../../src/fleet/platform.ts', () => ({
  createServiceManager: vi.fn(() => ({})),
  detectPlatform: vi.fn(() => 'linux-systemd'),
}));

import { createFleetServer } from '../../src/fleet/index.ts';

const FAKE_NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');

let fleet: ReturnType<typeof createFleetServer> | undefined;
let db: DatabaseSync | undefined;

afterEach(() => {
  fleet?.stop();
  db?.close();
  fleet = undefined;
  db = undefined;
});

describe('#2200 fleet start time reads the injected clock', () => {
  it('reports started_at and uptime from the injected clock', () => {
    const clock = fakeClock(FAKE_NOW_MS);
    db = new DatabaseSync(':memory:');
    fleet = createFleetServer({
      db,
      selfName: 'clock-self',
      fleetToken: 'f'.repeat(64),
      getSelfHealth: () => ({ status: 'ok' }),
      clock,
    });

    clock.advance(7_000);
    const res = mockRes();
    fleet.server.emit('request', mockReq({ url: '/livez' }), res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as { started_at: string; uptime_seconds: number };
    expect(body.started_at).toBe(new Date(FAKE_NOW_MS).toISOString());
    expect(body.uptime_seconds).toBe(7);
  });
});
