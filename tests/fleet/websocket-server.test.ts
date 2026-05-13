import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';

type WarnCall = { obj: Record<string, unknown> | undefined; msg: unknown };
const warnCalls = vi.hoisted((): WarnCall[] => []);

vi.mock('../../src/logger.ts', () => {
  const noop = vi.fn();
  const warn = (obj: unknown, msg?: unknown) => {
    warnCalls.push({
      obj: obj && typeof obj === 'object' ? obj as Record<string, unknown> : undefined,
      msg,
    });
  };
  const fakeLogger = { info: noop, warn, error: noop, debug: noop, trace: noop, fatal: noop };
  return { default: fakeLogger, createChildLogger: () => fakeLogger, flushLogger: async () => {} };
});

import { FleetWebSocketServer } from '../../src/fleet/websocket-server.ts';
import type { WsEvent } from '../../src/fleet/websocket-server.ts';
import { createTicketStore, type TicketStore } from '../../src/fleet/ws-ticket.ts';
import { waitForMessage as waitForMessageHelper } from '../helpers/wait-for.ts';

function waitForMessage(ws: WebSocket): Promise<WsEvent> {
  return waitForMessageHelper<WsEvent>(ws);
}

const TEST_TOKEN = 'a'.repeat(64);
let httpServer: Server;
let wsServer: FleetWebSocketServer;
let ticketStore: TicketStore;
let port: number;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    ticketStore = createTicketStore({ evictionIntervalMs: 0 });
    wsServer = new FleetWebSocketServer(httpServer, {
      ticketStore,
      ticketValidKeys: () => [TEST_TOKEN],
      verifyLegacyToken: (t) => t === TEST_TOKEN,
    });
    httpServer.listen(0, '127.0.0.1', () => {
      port = (httpServer.address() as { port: number }).port;
      resolve();
    });
  });
}

function connect(query?: string): Promise<{ ws: WebSocket; firstMessage: Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}${query ? `?${query}` : ''}`;
    const ws = new WebSocket(url);
    // Capture first message before open resolves (server sends hello immediately on connection)
    const firstMessage = new Promise<unknown>((res) => {
      ws.once('message', (data) => res(JSON.parse(data.toString())));
    });
    ws.on('open', () => resolve({ ws, firstMessage }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 3000);
  });
}

function connectWithTicket(): Promise<{ ws: WebSocket; firstMessage: Promise<unknown> }> {
  const { ticket } = ticketStore.issue(TEST_TOKEN);
  return connect(`ticket=${ticket}`);
}



function closeAndWait(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
  });
}

async function expectClientCount(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(wsServer.clientCount).toBe(count);
  });
}

afterEach(() => {
  wsServer?.close();
  httpServer?.close();
  ticketStore?.stop();
  warnCalls.length = 0;
});

describe('FleetWebSocketServer', () => {
  it('rejects connections without a ticket or token', async () => {
    await startServer();
    await expect(connect()).rejects.toThrow();
  });

  it('rejects connections with an unknown ticket', async () => {
    await startServer();
    await expect(connect('ticket=not-a-real-ticket')).rejects.toThrow();
  });

  it('rejects connections with a wrong legacy token', async () => {
    await startServer();
    await expect(connect('token=wrong-token')).rejects.toThrow();
  });

  it('does not log raw URL credentials on rejected auth', async () => {
    await startServer();
    await expect(connect('ticket=expired-secret&token=wrong-token')).rejects.toThrow();

    const rejected = warnCalls.find((call) => call.msg === 'ws_auth_rejected');
    expect(rejected?.obj).toMatchObject({
      path: '/',
      hasTicket: true,
      hasLegacyToken: true,
    });
    expect(rejected?.obj).not.toHaveProperty('url');
    expect(JSON.stringify(rejected?.obj)).not.toContain('expired-secret');
    expect(JSON.stringify(rejected?.obj)).not.toContain('wrong-token');
  });

  it('accepts connections with a valid ticket and sends hello', async () => {
    await startServer();
    const { ws, firstMessage } = await connectWithTicket();
    const msg = await firstMessage;
    expect(msg).toMatchObject({ type: 'connected' });
    expect(wsServer.clientCount).toBe(1);
    ws.close();
  });

  describe('legacy: token in query', () => {
    it('still accepts ?token=<active> for one rollout cycle', async () => {
      await startServer();
      const { ws, firstMessage } = await connect(`token=${TEST_TOKEN}`);
      const msg = await firstMessage;
      expect(msg).toMatchObject({ type: 'connected' });
      ws.close();
    });

    it('rejects replay of the same ticket', async () => {
      await startServer();
      const { ticket } = ticketStore.issue(TEST_TOKEN);
      // First redemption succeeds via the connect path
      const conn1 = await connect(`ticket=${ticket}`);
      await conn1.firstMessage;
      conn1.ws.close();
      // Second use of the same ticket must be rejected
      await expect(connect(`ticket=${ticket}`)).rejects.toThrow();
    });
  });

  it('broadcasts events to connected clients', async () => {
    await startServer();
    const { ws, firstMessage } = await connectWithTicket();
    await firstMessage; // consume hello

    const event: WsEvent = { type: 'instance_status', instance: 'test-line' };
    const msgPromise = waitForMessage(ws);
    wsServer.broadcast(event);
    const received = await msgPromise;
    expect(received).toEqual(event);
    ws.close();
  });

  it('broadcasts typing events with full payload', async () => {
    await startServer();
    const { ws, firstMessage } = await connectWithTicket();
    await firstMessage; // consume hello

    const event: WsEvent = {
      type: 'typing_update',
      instance: 'test-line',
      jid: '15551234567@s.whatsapp.net',
      composing: true,
      since: Date.now(),
    };
    const msgPromise = waitForMessage(ws);
    wsServer.broadcast(event);
    const received = await msgPromise;
    expect(received).toEqual(event);
    ws.close();
  });

  it('continues broadcasting when one client send fails', async () => {
    await startServer();
    const failingClient = {
      readyState: WebSocket.OPEN,
      send: vi.fn(() => { throw new Error('socket write failed'); }),
      close: vi.fn(),
    };
    const healthyClient = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    };
    const clients = (wsServer as unknown as { clients: Set<{ readyState: number; send: (data: string) => void; close: () => void }> }).clients;
    clients.add(failingClient);
    clients.add(healthyClient);

    const event: WsEvent = { type: 'feed_event', instance: 'test-line' };
    expect(() => wsServer.broadcast(event)).not.toThrow();

    expect(failingClient.send).toHaveBeenCalledWith(JSON.stringify(event));
    expect(healthyClient.send).toHaveBeenCalledWith(JSON.stringify(event));
    expect(clients.has(failingClient)).toBe(false);
    expect(clients.has(healthyClient)).toBe(true);
  });

  it('tracks client count correctly on connect/disconnect', async () => {
    await startServer();
    expect(wsServer.clientCount).toBe(0);

    const { ws: ws1, firstMessage: hello1 } = await connectWithTicket();
    await hello1;
    expect(wsServer.clientCount).toBe(1);

    const { ws: ws2, firstMessage: hello2 } = await connectWithTicket();
    await hello2;
    expect(wsServer.clientCount).toBe(2);

    await closeAndWait(ws1);
    await expectClientCount(1);

    await closeAndWait(ws2);
    await expectClientCount(0);
  });
});
