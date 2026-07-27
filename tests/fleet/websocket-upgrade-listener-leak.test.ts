/**
 * #2292 L6 — `close()` must detach the 'upgrade' listener it attached.
 *
 * The listener lives on the SHARED httpServer, which outlives the
 * FleetWebSocketServer. Before this it was an anonymous arrow with no stored
 * reference, so nothing could remove it: a closed server stayed subscribed,
 * retained `this` (its client set and auth deps) for the process lifetime, and
 * a second instance on the same httpServer left BOTH handlers running — the
 * stale one calling handleUpgrade on an already-closed WebSocketServer.
 *
 * These assert listener bookkeeping on the real http.Server rather than
 * memory, because listener count is the observable that actually governs the
 * leak and the double-handling.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

vi.mock('../../src/logger.ts', () => {
  const noop = vi.fn();
  const fakeLogger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  return { default: fakeLogger, createChildLogger: () => fakeLogger, flushLogger: async () => {} };
});

import { FleetWebSocketServer } from '../../src/fleet/websocket-server.ts';
import { createTicketStore, type TicketStore } from '../../src/fleet/ws-ticket.ts';

const TEST_TOKEN = 'a'.repeat(64);
let httpServer: Server | null = null;
const stores: TicketStore[] = [];

function makeWs(server: Server): FleetWebSocketServer {
  const ticketStore = createTicketStore({ evictionIntervalMs: 0 });
  stores.push(ticketStore);
  return new FleetWebSocketServer(server, {
    ticketStore,
    ticketValidKeys: () => [TEST_TOKEN],
    verifyLegacyToken: (t) => t === TEST_TOKEN,
  });
}

afterEach(() => {
  if (httpServer) { httpServer.close(); httpServer = null; }
  stores.length = 0;
});

describe('FleetWebSocketServer upgrade-listener lifecycle (#2292 L6)', () => {
  it('attaches exactly one upgrade listener on construction', () => {
    httpServer = createServer();
    expect(httpServer.listenerCount('upgrade')).toBe(0);
    makeWs(httpServer);
    expect(httpServer.listenerCount('upgrade')).toBe(1);
  });

  it('removes its upgrade listener on close — the leak this fixes', () => {
    httpServer = createServer();
    const ws = makeWs(httpServer);
    expect(httpServer.listenerCount('upgrade')).toBe(1);

    ws.close();

    expect(httpServer.listenerCount('upgrade')).toBe(0);
  });

  // The accumulation case: this is what made the leak matter in a long-lived
  // process, not the single-instance count.
  it('does not accumulate listeners across repeated construct/close cycles', () => {
    httpServer = createServer();
    for (let i = 0; i < 5; i += 1) {
      const ws = makeWs(httpServer);
      ws.close();
    }
    expect(httpServer.listenerCount('upgrade')).toBe(0);
  });

  it('leaves a CONCURRENT instance subscribed — close() detaches only its own listener', () => {
    httpServer = createServer();
    const first = makeWs(httpServer);
    const second = makeWs(httpServer);
    expect(httpServer.listenerCount('upgrade')).toBe(2);

    first.close();

    // Removing by reference must not tear down the other server's handler.
    expect(httpServer.listenerCount('upgrade')).toBe(1);
    second.close();
    expect(httpServer.listenerCount('upgrade')).toBe(0);
  });

  // ORDERING. close() detaches BEFORE tearing down clients and the wss, so an
  // upgrade arriving mid-close is never handed to a server about to close.
  // Observed through the public clientCount getter: if the detach ran last, the
  // client set would already have been cleared by the time it fired.
  it('detaches BEFORE tearing down clients and the wss, not after', () => {
    httpServer = createServer();
    const ws = makeWs(httpServer);

    let clientsAtDetach = -1;
    const realRemove = httpServer.removeListener.bind(httpServer);
    httpServer.removeListener = ((event: string, handler: (...a: unknown[]) => void) => {
      if (event === 'upgrade') clientsAtDetach = ws.clientCount;
      return realRemove(event, handler as never);
    }) as typeof httpServer.removeListener;

    // Put a client in the set so "cleared" and "not yet cleared" differ.
    (ws as unknown as { clients: Set<unknown> }).clients.add({ close() {} });
    expect(ws.clientCount).toBe(1);

    ws.close();

    expect(clientsAtDetach).toBe(1);   // detach saw the clients still present
    expect(ws.clientCount).toBe(0);    // and they were cleared afterwards
  });

  it('is idempotent — a second close() does not throw or remove a foreign listener', () => {
    httpServer = createServer();
    const other = (): void => {};
    httpServer.on('upgrade', other);
    const ws = makeWs(httpServer);
    expect(httpServer.listenerCount('upgrade')).toBe(2);

    ws.close();
    ws.close();

    // Only the foreign listener remains; the double close is harmless.
    expect(httpServer.listenerCount('upgrade')).toBe(1);
    expect(httpServer.listeners('upgrade')).toContain(other);
  });
});
