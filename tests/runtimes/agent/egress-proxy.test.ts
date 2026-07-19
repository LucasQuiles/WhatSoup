/**
 * EgressProxy — loopback filtering forward-proxy for agent-subprocess network
 * egress (#1607 / QR-008).
 *
 * Real-socket tests: a local `http.Server` target on 127.0.0.1 (ephemeral
 * port) stands in for "the outside world", and each test drives the
 * `EgressProxy` under test with a real `http.request` (forward path) or raw
 * `node:net` socket (CONNECT tunnel path). No real external hosts are ever
 * contacted.
 */
import { describe, it, expect, vi } from 'vitest';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import {
  EgressProxy,
  egressHostAllowed,
  type EgressPolicySource,
  type EgressLogEvent,
} from '../../../src/runtimes/agent/egress-proxy.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function startTargetServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  },
): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('target server: failed to bind ephemeral port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makePolicy(allowedEgress: string[]): EgressPolicySource {
  return { read: () => ({ allowedEgress }) };
}

/** Sends `GET <path>` through `proxy` as an absolute-URI forward-proxy request. */
function forwardGet(
  proxyPort: number,
  targetPort: number,
  path = '/',
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://127.0.0.1:${targetPort}${path}`,
        headers: { Host: `127.0.0.1:${targetPort}` },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Opens a raw CONNECT tunnel to `proxyPort` and resolves once the status line + blank line arrive. */
function rawConnect(proxyPort: number, targetHostPort: string): Promise<{ socket: Socket; statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, '127.0.0.1');
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\r\n\r\n');
      if (idx !== -1) {
        socket.off('data', onData);
        const statusLine = buf.slice(0, idx).split('\r\n')[0] ?? '';
        resolve({ socket, statusLine });
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(`CONNECT ${targetHostPort} HTTP/1.1\r\n\r\n`);
    });
  });
}

function waitForClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once('close', () => resolve());
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EgressProxy', () => {
  it('allows listed host (HTTP forward)', async () => {
    const { server: target, port: targetPort } = await startTargetServer();
    const log = vi.fn<(event: EgressLogEvent) => void>();
    const proxy = await EgressProxy.start({ policy: makePolicy(['127.0.0.1']), log });

    try {
      const { statusCode, body } = await forwardGet(proxy.port, targetPort);
      expect(statusCode).toBe(200);
      expect(body).toBe('ok');
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'sandbox_egress_allow', host: '127.0.0.1', port: targetPort }),
      );
    } finally {
      await proxy.close();
      await closeServer(target);
    }
  });

  it('denies unlisted host with 403 + logs deny', async () => {
    const { server: target, port: targetPort } = await startTargetServer();
    const log = vi.fn<(event: EgressLogEvent) => void>();
    const proxy = await EgressProxy.start({ policy: makePolicy(['allowed.example']), log });

    try {
      const { statusCode, body } = await forwardGet(proxy.port, targetPort);
      expect(statusCode).toBe(403);
      expect(body).toContain('403');
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'sandbox_egress_deny',
          host: '127.0.0.1',
          port: targetPort,
          reason: 'not-allowed',
        }),
      );
    } finally {
      await proxy.close();
      await closeServer(target);
    }
  });

  it('CONNECT tunnel allowed for listed host:port', async () => {
    const { server: target, port: targetPort } = await startTargetServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('tunneled');
    });
    const log = vi.fn<(event: EgressLogEvent) => void>();
    const proxy = await EgressProxy.start({
      policy: makePolicy([`127.0.0.1:${targetPort}`]),
      log,
    });

    let tunnelSocket: Socket | undefined;
    try {
      const { socket, statusLine } = await rawConnect(proxy.port, `127.0.0.1:${targetPort}`);
      tunnelSocket = socket;
      expect(statusLine).toBe('HTTP/1.1 200 Connection Established');

      const response = await new Promise<string>((resolve, reject) => {
        let buf = '';
        socket.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes('tunneled')) resolve(buf);
        });
        socket.on('error', reject);
        socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`);
      });

      expect(response).toContain('200');
      expect(response).toContain('tunneled');
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'sandbox_egress_allow', host: '127.0.0.1', port: targetPort }),
      );
    } finally {
      tunnelSocket?.destroy();
      await proxy.close();
      await closeServer(target);
    }
  });

  it('CONNECT denied for unlisted → 403 + destroy', async () => {
    const { server: target, port: targetPort } = await startTargetServer();
    const log = vi.fn<(event: EgressLogEvent) => void>();
    const proxy = await EgressProxy.start({ policy: makePolicy([]), log });

    let tunnelSocket: Socket | undefined;
    try {
      const { socket, statusLine } = await rawConnect(proxy.port, `127.0.0.1:${targetPort}`);
      tunnelSocket = socket;
      expect(statusLine).toBe('HTTP/1.1 403 Forbidden');
      await waitForClose(socket);
      expect(socket.destroyed).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'sandbox_egress_deny',
          host: '127.0.0.1',
          port: targetPort,
          reason: 'not-allowed',
        }),
      );
    } finally {
      tunnelSocket?.destroy();
      await proxy.close();
      await closeServer(target);
    }
  });

  it('empty allowlist denies all', async () => {
    const { server: target, port: targetPort } = await startTargetServer();
    const log = vi.fn<(event: EgressLogEvent) => void>();
    const proxy = await EgressProxy.start({ policy: makePolicy([]), log });

    try {
      const { statusCode } = await forwardGet(proxy.port, targetPort);
      expect(statusCode).toBe(403);
    } finally {
      await proxy.close();
      await closeServer(target);
    }
  });

  it("policy read throws ⇒ deny (fail-closed)", async () => {
    const { server: target, port: targetPort } = await startTargetServer();
    const log = vi.fn<(event: EgressLogEvent) => void>();
    const policy: EgressPolicySource = {
      read: () => {
        throw new Error('policy file corrupt');
      },
    };
    const proxy = await EgressProxy.start({ policy, log });

    try {
      const { statusCode } = await forwardGet(proxy.port, targetPort);
      expect(statusCode).toBe(403);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'sandbox_egress_deny',
          host: '127.0.0.1',
          port: targetPort,
          reason: 'policy-unreadable',
        }),
      );
    } finally {
      await proxy.close();
      await closeServer(target);
    }
  });

  it('failOpen=true allows unlisted WITH warn log', async () => {
    const { server: target, port: targetPort } = await startTargetServer();
    const log = vi.fn<(event: EgressLogEvent) => void>();
    const proxy = await EgressProxy.start({
      policy: makePolicy([]),
      log,
      failOpen: true,
    });

    try {
      const { statusCode, body } = await forwardGet(proxy.port, targetPort);
      expect(statusCode).toBe(200);
      expect(body).toBe('ok');
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'sandbox_egress_fail_open', host: '127.0.0.1', port: targetPort }),
      );
    } finally {
      await proxy.close();
      await closeServer(target);
    }
  });

  it('host matching: host-only entry any port; host:port exact; case-insensitive', () => {
    expect(egressHostAllowed([], 'example.com', 80)).toBe(false);

    // host-only entry matches any port
    expect(egressHostAllowed(['example.com'], 'example.com', 80)).toBe(true);
    expect(egressHostAllowed(['example.com'], 'example.com', 9999)).toBe(true);

    // host:port entry matches only the exact port
    expect(egressHostAllowed(['example.com:443'], 'example.com', 443)).toBe(true);
    expect(egressHostAllowed(['example.com:443'], 'example.com', 80)).toBe(false);

    // case-insensitive host comparison
    expect(egressHostAllowed(['Example.COM'], 'example.com', 80)).toBe(true);
    expect(egressHostAllowed(['example.com'], 'EXAMPLE.COM', 80)).toBe(true);

    // no wildcards / no partial matches
    expect(egressHostAllowed(['example.com'], 'sub.example.com', 80)).toBe(false);
    expect(egressHostAllowed(['example.com'], 'notexample.com', 80)).toBe(false);

    // unrelated host in the list does not match
    expect(egressHostAllowed(['other.example'], 'example.com', 80)).toBe(false);
  });
});
