// Falsifiers for #2521: WebSocket broadcaster client lifecycle — heartbeat
// liveness, backpressure budget, and asynchronous send-completion outcomes.
//
// Synthetic clients are injected through the same adoption path production
// connections use (adoptClient), so pong wiring, record creation, and drop
// handling are the real code paths. All values are reserved synthetic tokens;
// no network listener or live client is involved.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

type WarnCall = { obj: Record<string, unknown> | undefined; msg: unknown };
const warnCalls = vi.hoisted((): WarnCall[] => []);

vi.mock('../../src/logger.ts', () => {
  const noop = vi.fn();
  const warn = (obj: unknown, msg?: unknown) => {
    warnCalls.push({
      obj: obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : undefined,
      msg,
    });
  };
  const fakeLogger = { info: noop, warn, error: noop, debug: noop, trace: noop, fatal: noop };
  return { default: fakeLogger, createChildLogger: () => fakeLogger, flushLogger: async () => {} };
});

import { FleetWebSocketServer } from '../../src/fleet/websocket-server.ts';
import { createTicketStore } from '../../src/fleet/ws-ticket.ts';

class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  sendCallbacks: Array<(err?: Error) => void> = [];
  pingCount = 0;
  terminated = false;
  closed = false;
  throwOnSend = false;

  send(data: string, cb?: (err?: Error) => void): void {
    if (this.throwOnSend) throw new Error('synthetic sync send failure');
    this.sent.push(data);
    if (cb) this.sendCallbacks.push(cb);
  }

  ping(): void {
    this.pingCount += 1;
  }

  terminate(): void {
    this.terminated = true;
  }

  close(): void {
    this.closed = true;
  }
}

interface Harness {
  server: FleetWebSocketServer;
  httpServer: HttpServer;
  clock: { nowMs: number };
  adopt: (client: FakeClient) => void;
  sweep: () => void;
  cleanup: () => void;
}

function makeHarness(options: Record<string, unknown> = {}): Harness {
  const httpServer = createServer();
  const clock = { nowMs: 0 };
  const server = new FleetWebSocketServer(
    httpServer,
    {
      ticketStore: createTicketStore({ evictionIntervalMs: 0 }),
      ticketValidKeys: () => ['t'.repeat(64)],
      verifyLegacyToken: () => false,
    },
    {
      heartbeatIntervalMs: 3_600_000, // sweeps are driven manually via sweep()
      missedPongBudget: 2,
      maxBufferedBytes: 1_024,
      backpressureGraceMs: 5_000,
      logThrottleMs: 10_000,
      monotonicNow: () => clock.nowMs,
      ...options,
    },
  );
  const internals = server as unknown as {
    adoptClient: (ws: unknown) => void;
    heartbeatSweep: () => void;
  };
  return {
    server,
    httpServer,
    clock,
    adopt: (client) => internals.adoptClient(client),
    sweep: () => internals.heartbeatSweep(),
    cleanup: () => server.close(),
  };
}

afterEach(() => {
  warnCalls.length = 0;
});

describe('websocket client lifecycle (#2521)', () => {
  it('terminates a client that stops answering pings within the missed-pong budget', () => {
    const h = makeHarness();
    const silent = new FakeClient();
    h.adopt(silent);
    // hello frame consumed the initial send; the client never emits pong.
    h.sweep(); // missed=1, ping sent
    h.sweep(); // missed=2, ping sent
    expect(silent.terminated).toBe(false);
    h.sweep(); // missed >= budget(2) -> terminated
    expect(silent.terminated).toBe(true);
    expect(h.server.clientCount).toBe(0);
    expect(h.server.healthSnapshot().recentOutcomes.client_unresponsive).toBe(1);
    h.cleanup();
  });

  it('pong recovery before the deadline keeps the client live without lifecycle flap', () => {
    const h = makeHarness();
    const healthy = new FakeClient();
    h.adopt(healthy);
    for (let i = 0; i < 6; i += 1) {
      h.sweep();
      healthy.emit('pong'); // answered every sweep
    }
    expect(healthy.terminated).toBe(false);
    expect(healthy.pingCount).toBe(6);
    const snapshot = h.server.healthSnapshot();
    expect(snapshot.live).toBe(1);
    expect(snapshot.awaitingPong).toBe(0);
    expect(snapshot.recentOutcomes.client_unresponsive).toBe(0);
    h.cleanup();
  });

  it('enqueues no application frames to a client above the buffer budget', () => {
    const h = makeHarness();
    const slow = new FakeClient();
    h.adopt(slow);
    const helloCount = slow.sent.length;
    slow.bufferedAmount = 64 * 1024 * 1024;
    h.server.broadcast({ type: 'instance_status', instance: 'synthetic-a' });
    expect(slow.sent.length, 'a backpressured client must receive no further frames').toBe(helloCount);
    const snapshot = h.server.healthSnapshot();
    expect(snapshot.recentOutcomes.dropped).toBe(1);
    expect(snapshot.backpressured).toBe(1);
    h.cleanup();
  });

  it('a buffer exactly at the budget still delivers (boundary is strict-greater)', () => {
    const h = makeHarness();
    const atBudget = new FakeClient();
    h.adopt(atBudget);
    const helloCount = atBudget.sent.length;
    atBudget.bufferedAmount = 1_024; // == maxBufferedBytes
    h.server.broadcast({ type: 'instance_status', instance: 'synthetic-a' });
    expect(atBudget.sent.length).toBe(helloCount + 1);
    h.cleanup();
  });

  it('evicts a slow client after the grace window without touching healthy peers', () => {
    const h = makeHarness();
    const slow = new FakeClient();
    const healthy = new FakeClient();
    h.adopt(slow);
    h.adopt(healthy);
    const healthyHello = healthy.sent.length;
    slow.bufferedAmount = 1_000_000;
    h.server.broadcast({ type: 'instance_status', instance: 'synthetic-a' }); // marks backpressured at t=0
    h.clock.nowMs = 6_000; // past 5s grace
    h.server.broadcast({ type: 'instance_status', instance: 'synthetic-b' });
    expect(slow.terminated).toBe(true);
    expect(h.server.healthSnapshot().recentOutcomes.client_evicted_backpressure).toBe(1);
    expect(healthy.sent.length, 'healthy peer must receive every frame').toBe(healthyHello + 2);
    expect(h.server.clientCount).toBe(1);
    h.cleanup();
  });

  it('an asynchronous send failure terminates exactly the affected client with one outcome', () => {
    const h = makeHarness();
    const failing = new FakeClient();
    const healthy = new FakeClient();
    h.adopt(failing);
    h.adopt(healthy);
    h.server.broadcast({ type: 'instance_status', instance: 'synthetic-a' });
    const broadcastCallback = failing.sendCallbacks.at(-1);
    expect(broadcastCallback).toBeTypeOf('function');
    broadcastCallback?.(new Error('synthetic async write failure'));
    expect(failing.terminated).toBe(true);
    expect(h.server.clientCount).toBe(1);
    expect(h.server.healthSnapshot().recentOutcomes.failed).toBe(1);
    const healthyBefore = healthy.sent.length;
    h.server.broadcast({ type: 'instance_status', instance: 'synthetic-b' });
    expect(healthy.sent.length).toBe(healthyBefore + 1);
    h.cleanup();
  });

  it('a synchronous send throw stays isolated and does not abort the broadcast loop', () => {
    const h = makeHarness();
    const thrower = new FakeClient();
    thrower.throwOnSend = true;
    const healthy = new FakeClient();
    // hello send throws during adoption -> thrower is dropped there; re-adopt
    // with throw disabled, then re-arm the throw for the broadcast itself.
    thrower.throwOnSend = false;
    h.adopt(thrower);
    h.adopt(healthy);
    thrower.throwOnSend = true;
    const healthyBefore = healthy.sent.length;
    h.server.broadcast({ type: 'instance_status', instance: 'synthetic-a' });
    expect(healthy.sent.length, 'healthy peer delivery must survive the throw').toBe(healthyBefore + 1);
    expect(h.server.clientCount).toBe(1);
    expect(h.server.healthSnapshot().recentOutcomes.failed).toBe(1);
    h.cleanup();
  });

  it('close() clears the heartbeat timer, upgrade listener, and all clients', () => {
    const h = makeHarness();
    const client = new FakeClient();
    h.adopt(client);
    expect(h.httpServer.listenerCount('upgrade')).toBe(1);
    h.server.close();
    expect(h.httpServer.listenerCount('upgrade')).toBe(0);
    expect(h.server.clientCount).toBe(0);
    expect(client.closed).toBe(true);
    expect(
      (h.server as unknown as { heartbeatTimer: unknown }).heartbeatTimer,
    ).toBeNull();
  });

  it('repeated failure logs are throttled into a bounded count', () => {
    const h = makeHarness();
    for (let i = 0; i < 20; i += 1) {
      const failing = new FakeClient();
      h.adopt(failing);
      h.server.broadcast({ type: 'instance_status', instance: 'synthetic-a' });
      failing.sendCallbacks.at(-1)?.(new Error('synthetic async write failure'));
    }
    const asyncFailLogs = warnCalls.filter((call) => call.msg === 'ws_async_send_failed');
    expect(asyncFailLogs.length, 'same-token failures inside the throttle window log once').toBe(1);
    h.clock.nowMs = 20_000; // past the 10s throttle
    const failing = new FakeClient();
    h.adopt(failing);
    h.server.broadcast({ type: 'instance_status', instance: 'synthetic-a' });
    failing.sendCallbacks.at(-1)?.(new Error('synthetic async write failure'));
    const after = warnCalls.filter((call) => call.msg === 'ws_async_send_failed');
    expect(after.length).toBe(2);
    expect(after[1]?.obj?.suppressedSinceLast, 'suppressed count must be carried, not lost').toBe(19);
    h.cleanup();
  });

  it('health snapshot exposes only bounded aggregate values', () => {
    const h = makeHarness();
    h.adopt(new FakeClient());
    const snapshot = h.server.healthSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual(
      ['awaitingPong', 'backpressured', 'clientCount', 'heartbeatAgeMs', 'live', 'recentOutcomes'].sort(),
    );
    const flat = JSON.stringify(snapshot);
    expect(flat).not.toContain('synthetic');
    expect(flat).not.toContain('127.0.0.1');
    for (const value of Object.values(snapshot.recentOutcomes)) {
      expect(value).toBeTypeOf('number');
    }
    h.cleanup();
  });
});
