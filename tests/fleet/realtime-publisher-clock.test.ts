/**
 * #2200 (src/fleet slice): the typing_update `since` stamp comes from the
 * injected Clock, not the raw wall clock.
 */
import { describe, expect, it, vi } from 'vitest';
import { publishTypingUpdate } from '../../src/fleet/realtime-publisher.ts';
import type { WsEvent } from '../../src/fleet/websocket-server.ts';
import { fakeClock } from '../../src/lib/clock.ts';

const FAKE_NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');

describe('#2200 typing_update since reads the injected clock', () => {
  it('stamps since with the injected instant', () => {
    const publish = vi.fn<(event: WsEvent) => void>();
    publishTypingUpdate({ publish }, 'clock-line', 'synthetic-peer@s.whatsapp.net', true, fakeClock(FAKE_NOW_MS));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toEqual({
      type: 'typing_update',
      instance: 'clock-line',
      jid: 'synthetic-peer@s.whatsapp.net',
      composing: true,
      since: FAKE_NOW_MS,
    });
  });
});
