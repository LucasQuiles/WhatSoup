/**
 * tests/fleet/websocket-server-redact-url.test.ts
 *
 * Covers the URL redaction in the `ws_auth_rejected` warn log (#410).
 *
 * Vector: the WS upgrade handler reads `?ticket=` / `?token=` from `req.url`
 * for auth. Prior to the fix, a failed auth attempt would log the raw `req.url`
 * — including the secret query string — to the fleet log. An attacker
 * (or a misconfigured client) sending a wrong-but-real-looking token would
 * persist that secret to disk.
 *
 * Mirrors the HTTP precedent at `src/fleet/static.ts:29` and the HTTP-API
 * deprecation log at `src/fleet/index.ts:800` which only log the pathname.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';

// Logger mock — capture every warn call so the test can introspect.
// Must be set up before importing the module under test.
type WarnCall = { obj: Record<string, unknown> | undefined; msg: string };
const warnCalls: WarnCall[] = [];

vi.mock('../../src/logger.ts', () => {
  const noop = () => {};
  const warn = (obj: unknown, msg?: unknown) => {
    if (typeof obj === 'string') {
      warnCalls.push({ obj: undefined, msg: obj });
    } else {
      warnCalls.push({
        obj: obj as Record<string, unknown> | undefined,
        msg: typeof msg === 'string' ? msg : '',
      });
    }
  };
  const child = () => fakeLogger;
  const fakeLogger: Record<string, unknown> = {
    info: noop, warn, error: noop, debug: noop, trace: noop, fatal: noop,
    child, flush: noop,
  };
  return { default: fakeLogger, createChildLogger: () => fakeLogger, flushLogger: async () => {} };
});

const { FleetWebSocketServer } = await import('../../src/fleet/websocket-server.ts');
const { createTicketStore } = await import('../../src/fleet/ws-ticket.ts');
type TicketStore = Awaited<ReturnType<typeof createTicketStore>> extends infer T ? T : never;

const TEST_TOKEN = 'a'.repeat(64);
let httpServer: Server;
let wsServer: InstanceType<typeof FleetWebSocketServer>;
let ticketStore: ReturnType<typeof createTicketStore>;
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
      verifyLegacyToken: (t: string) => t === TEST_TOKEN,
    });
    httpServer.listen(0, '127.0.0.1', () => {
      port = (httpServer.address() as { port: number }).port;
      resolve();
    });
  });
}

function tryConnect(query: string): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?${query}`);
    ws.on('open', () => { ws.close(); resolve(); });
    ws.on('error', () => resolve());
    ws.on('unexpected-response', () => { ws.terminate(); resolve(); });
    setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } resolve(); }, 2000);
  });
}

afterEach(() => {
  wsServer?.close();
  httpServer?.close();
  ticketStore?.stop();
  warnCalls.length = 0;
});

describe('FleetWebSocketServer ws_auth_rejected log redaction (#410)', () => {
  it('does not include the raw token query string in the rejection log', async () => {
    await startServer();
    const SECRET = 'SECRET_TOKEN_VALUE_DO_NOT_LEAK_abc123xyz';
    await tryConnect(`token=${SECRET}`);

    const rejections = warnCalls.filter((c) => c.msg === 'ws_auth_rejected');
    expect(rejections.length).toBeGreaterThanOrEqual(1);

    for (const call of rejections) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(SECRET);
    }
  });

  it('does not include the raw ticket query string in the rejection log', async () => {
    await startServer();
    const SECRET_TICKET = 'SECRET_TICKET_VALUE_DO_NOT_LEAK_qwerty789';
    await tryConnect(`ticket=${SECRET_TICKET}`);

    const rejections = warnCalls.filter((c) => c.msg === 'ws_auth_rejected');
    expect(rejections.length).toBeGreaterThanOrEqual(1);

    for (const call of rejections) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(SECRET_TICKET);
    }
  });

  it('still logs the request path for debugging', async () => {
    await startServer();
    await tryConnect('token=wrong');

    const rejections = warnCalls.filter((c) => c.msg === 'ws_auth_rejected');
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    // The path field (or url stripped of query) should still be present so
    // operators can see *which* endpoint was hit, just not the secret.
    const last = rejections[rejections.length - 1];
    const serialized = JSON.stringify(last.obj ?? {});
    // The path "/" (root) must appear in the log payload; the query string
    // (which starts with "?") must NOT — that's the leak vector.
    expect(serialized).toMatch(/"(url|path)"\s*:\s*"\/"/);
    expect(serialized).not.toContain('?');
    expect(serialized).not.toContain('token=wrong');
  });

  it('does not log an arbitrary `auth` query param value either', async () => {
    await startServer();
    const SECRET = 'SECRET_AUTH_PARAM_zzz999';
    await tryConnect(`auth=${SECRET}`);

    const rejections = warnCalls.filter((c) => c.msg === 'ws_auth_rejected');
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    for (const call of rejections) {
      expect(JSON.stringify(call)).not.toContain(SECRET);
    }
  });
});
