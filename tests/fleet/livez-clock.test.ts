/**
 * #2200 (src/fleet slice): the /livez uptime is measured against the injected
 * Clock in LivenessOptions, not the raw wall clock.
 *
 * The fake clock sits months away from the real one, so a handler that reads
 * the wall clock reports an uptime of months instead of the injected interval.
 */
import { describe, expect, it } from 'vitest';
import { createLivenessHandler } from '../../src/fleet/livez.ts';
import { fakeClock } from '../../src/lib/clock.ts';
import { mockReq, mockRes } from '../helpers/http-mocks.ts';

const FAKE_NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');

describe('#2200 /livez uptime reads the injected clock', () => {
  it('reports uptime as the injected interval since startedAtMs', () => {
    const clock = fakeClock(FAKE_NOW_MS);
    const handler = createLivenessHandler({
      selfName: 'clock-line',
      startedAtMs: FAKE_NOW_MS - 42_000,
      clock,
    });

    const first = mockRes();
    expect(handler(mockReq({ url: '/livez' }), first)).toBe(true);
    expect(first._status).toBe(200);
    expect((JSON.parse(first._body) as { uptime_seconds: number }).uptime_seconds).toBe(42);

    clock.advance(8_000);
    const second = mockRes();
    handler(mockReq({ url: '/livez' }), second);
    expect((JSON.parse(second._body) as { uptime_seconds: number }).uptime_seconds).toBe(50);
  });
});
