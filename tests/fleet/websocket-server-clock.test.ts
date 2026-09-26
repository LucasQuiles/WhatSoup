/**
 * #2200 (src/fleet slice): the WebSocket hello `timestamp` and the broadcast
 * `emitted_at` stamp both come from the injected Clock in
 * FleetWsLifecycleOptions, not the raw wall clock.
 *
 * A synthetic client is adopted through the same path production connections
 * use (adoptClient); no network listener is involved.
 */
import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { fakeClock } from '../../src/lib/clock.ts';

vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());

import { FleetWebSocketServer } from '../../src/fleet/websocket-server.ts';
import { createTicketStore } from '../../src/fleet/ws-ticket.ts';

const FAKE_NOW_MS = Date.parse('2026-07-10T14:00:00.000Z');

class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }
  ping(): void {}
  terminate(): void {}
  close(): void {}
}

describe('#2200 websocket stamps read the injected clock', () => {
  it('stamps the hello timestamp and broadcast emitted_at with the injected instant', () => {
    const clock = fakeClock(FAKE_NOW_MS);
    const ticketStore = createTicketStore({ evictionIntervalMs: 0 });
    const server = new FleetWebSocketServer(
      createServer(),
      {
        ticketStore,
        ticketValidKeys: () => ['t'.repeat(64)],
        verifyLegacyToken: () => false,
      },
      { heartbeatIntervalMs: 3_600_000, clock },
    );
    try {
      const client = new FakeClient();
      (server as unknown as { adoptClient: (ws: unknown) => void }).adoptClient(client);
      const hello = JSON.parse(client.sent[0] ?? '{}') as { type?: string; timestamp?: number };
      expect(hello.type).toBe('connected');
      expect(hello.timestamp).toBe(FAKE_NOW_MS);

      clock.advance(5_000);
      server.broadcast({ type: 'instance_status', instance: 'clock-line' });
      const frame = JSON.parse(client.sent[1] ?? '{}') as { emitted_at?: number };
      expect(frame.emitted_at).toBe(FAKE_NOW_MS + 5_000);
    } finally {
      server.close();
      ticketStore.stop();
    }
  });
});
