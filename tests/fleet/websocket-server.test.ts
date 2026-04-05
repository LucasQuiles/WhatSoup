import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { FleetWebSocketServer } from '../../src/fleet/websocket-server.ts';
import type { WsEvent } from '../../src/fleet/websocket-server.ts';

const TEST_TOKEN = 'test-token-abc123';
let httpServer: Server;
let wsServer: FleetWebSocketServer;
let port: number;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    wsServer = new FleetWebSocketServer(httpServer, TEST_TOKEN);
    httpServer.listen(0, '127.0.0.1', () => {
      port = (httpServer.address() as { port: number }).port;
      resolve();
    });
  });
}

function connect(token?: string): Promise<{ ws: WebSocket; firstMessage: Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}${token ? `?token=${token}` : ''}`;
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

function waitForMessage(ws: WebSocket): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try { resolve(JSON.parse(data.toString())); }
      catch (err) { reject(err); }
    });
    setTimeout(() => reject(new Error('message timeout')), 3000);
  });
}

afterEach(() => {
  wsServer?.close();
  httpServer?.close();
});

describe('FleetWebSocketServer', () => {
  it('rejects connections without a token', async () => {
    await startServer();
    await expect(connect()).rejects.toThrow();
  });

  it('rejects connections with wrong token', async () => {
    await startServer();
    await expect(connect('wrong-token')).rejects.toThrow();
  });

  it('accepts connections with correct token and sends hello', async () => {
    await startServer();
    const { ws, firstMessage } = await connect(TEST_TOKEN);
    const msg = await firstMessage;
    expect(msg).toMatchObject({ type: 'connected' });
    expect(wsServer.clientCount).toBe(1);
    ws.close();
  });

  it('broadcasts events to connected clients', async () => {
    await startServer();
    const { ws, firstMessage } = await connect(TEST_TOKEN);
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
    const { ws, firstMessage } = await connect(TEST_TOKEN);
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

  it('tracks client count correctly on connect/disconnect', async () => {
    await startServer();
    expect(wsServer.clientCount).toBe(0);

    const { ws: ws1, firstMessage: hello1 } = await connect(TEST_TOKEN);
    await hello1;
    expect(wsServer.clientCount).toBe(1);

    const { ws: ws2, firstMessage: hello2 } = await connect(TEST_TOKEN);
    await hello2;
    expect(wsServer.clientCount).toBe(2);

    ws1.close();
    await new Promise(r => setTimeout(r, 100));
    expect(wsServer.clientCount).toBe(1);

    ws2.close();
    await new Promise(r => setTimeout(r, 100));
    expect(wsServer.clientCount).toBe(0);
  });
});
