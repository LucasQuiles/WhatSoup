/**
 * EgressProxy — loopback filtering forward-proxy for agent-subprocess network
 * egress (#1607 / QR-008).
 *
 * Binds 127.0.0.1 on an ephemeral port and adjudicates every request against
 * an injected `EgressPolicySource`'s `allowedEgress` list:
 *   - Plain HTTP forward: client sends an absolute-URI request line
 *     (`GET http://host:port/path HTTP/1.1`) to this proxy; allowed requests
 *     are relayed upstream via `http.request` and the response piped back.
 *   - HTTPS tunnel: client sends `CONNECT host:port HTTP/1.1`; allowed
 *     requests get `200 Connection Established` and a raw bidirectional pipe
 *     to the upstream TCP socket (TLS happens end-to-end through the tunnel,
 *     this proxy never sees it).
 *
 * Fail-closed by construction: an empty (or unset) allowlist denies
 * everything, and a throwing `policy.read()` — a corrupt or unreadable
 * policy file, surfaced by the caller's `EgressPolicySource` — ALWAYS denies
 * with reason `policy-unreadable`, regardless of `failOpen`. `failOpen` only
 * changes what happens when the policy is readable but the host/port is not
 * on the allowlist: normally that denies, with `failOpen: true` it allows
 * and logs `sandbox_egress_fail_open` instead of `sandbox_egress_deny` (the
 * WHATSOUP_SANDBOX_FAIL_OPEN=1 escape-valve parity from
 * `deploy/hooks/agent-sandbox.sh`, resolved by the CALLER — this module never
 * reads `process.env`).
 *
 * The policy is re-read on every single request (not cached at start()) so a
 * live policy edit takes effect immediately and a policy that goes corrupt
 * mid-flight fails closed on the very next request.
 *
 * This module is self-contained: no filesystem reads, no pino wiring, no
 * `process.env` reads. Those are the caller's job (later tasks).
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';

export interface EgressPolicySource {
  read(): { allowedEgress: string[] };
}

export interface EgressLogEvent {
  event: 'sandbox_egress_deny' | 'sandbox_egress_allow' | 'sandbox_egress_fail_open';
  host: string;
  port: number;
  reason?: string;
}

export interface EgressProxyOptions {
  policy: EgressPolicySource;
  log: (event: EgressLogEvent) => void;
  /**
   * WHATSOUP_SANDBOX_FAIL_OPEN=1 parity — resolved by the CALLER, never read
   * from process.env here. Only relaxes "host not on the allowlist" denials;
   * a policy-read failure still denies unconditionally (see module docs).
   */
  failOpen?: boolean;
}

const HTTP_DENY_BODY = '403 Forbidden';
const CONNECT_ESTABLISHED = 'HTTP/1.1 200 Connection Established\r\n\r\n';
const CONNECT_FORBIDDEN = 'HTTP/1.1 403 Forbidden\r\n\r\n';

/**
 * Pure allowlist match, exported so the future firewall backstop can reuse
 * the exact same grammar without re-deriving it.
 *
 * Grammar: an entry of `host` matches that host on ANY port; an entry of
 * `host:port` matches only that exact port. Host comparison is
 * lowercase-exact — no wildcards, no prefix/suffix matching.
 */
export function egressHostAllowed(allowedEgress: string[], host: string, port: number): boolean {
  const targetHost = host.toLowerCase();
  for (const entry of allowedEgress) {
    const sep = entry.lastIndexOf(':');
    if (sep === -1) {
      if (entry.toLowerCase() === targetHost) return true;
      continue;
    }
    const entryHost = entry.slice(0, sep).toLowerCase();
    const entryPort = entry.slice(sep + 1);
    if (entryHost === targetHost && entryPort === String(port)) return true;
  }
  return false;
}

/**
 * Reads the policy fresh, adjudicates host:port against it, and logs the
 * outcome. Returns whether the request should proceed.
 */
function adjudicate(opts: EgressProxyOptions, host: string, port: number): boolean {
  let policy: { allowedEgress: string[] };
  try {
    policy = opts.policy.read();
  } catch {
    opts.log({ event: 'sandbox_egress_deny', host, port, reason: 'policy-unreadable' });
    return false;
  }

  if (egressHostAllowed(policy.allowedEgress ?? [], host, port)) {
    opts.log({ event: 'sandbox_egress_allow', host, port });
    return true;
  }

  if (opts.failOpen) {
    opts.log({ event: 'sandbox_egress_fail_open', host, port, reason: 'not-allowed' });
    return true;
  }

  opts.log({ event: 'sandbox_egress_deny', host, port, reason: 'not-allowed' });
  return false;
}

function handleForward(opts: EgressProxyOptions, req: IncomingMessage, res: ServerResponse): void {
  let target: URL;
  try {
    target = new URL(req.url ?? '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('400 Bad Request: absolute-URI required');
    return;
  }

  const host = target.hostname;
  const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;

  if (!adjudicate(opts, host, port)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(HTTP_DENY_BODY);
    return;
  }

  const upstreamReq = httpRequest(
    {
      hostname: host,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: req.headers,
      agent: false,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end();
  });
  res.on('error', () => upstreamReq.destroy());
  req.on('error', () => upstreamReq.destroy());

  req.pipe(upstreamReq);
}

function parseConnectTarget(url: string): { host: string; port: number } | null {
  const sep = url.lastIndexOf(':');
  if (sep === -1) return null;
  const host = url.slice(0, sep);
  const port = Number(url.slice(sep + 1));
  if (!host || !Number.isInteger(port) || port <= 0) return null;
  return { host, port };
}

function handleConnect(
  opts: EgressProxyOptions,
  tunnels: Set<Duplex>,
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): void {
  const target = parseConnectTarget(req.url ?? '');
  if (!target) {
    clientSocket.write(CONNECT_FORBIDDEN, () => clientSocket.destroy());
    return;
  }
  const { host, port } = target;

  if (!adjudicate(opts, host, port)) {
    clientSocket.write(CONNECT_FORBIDDEN, () => clientSocket.destroy());
    return;
  }

  const upstream = netConnect(port, host);
  tunnels.add(clientSocket);
  tunnels.add(upstream);

  const teardown = () => {
    tunnels.delete(clientSocket);
    tunnels.delete(upstream);
    clientSocket.destroy();
    upstream.destroy();
  };

  clientSocket.on('error', teardown);
  clientSocket.on('close', teardown);
  upstream.on('error', teardown);
  upstream.on('close', teardown);

  upstream.on('connect', () => {
    clientSocket.write(CONNECT_ESTABLISHED);
    if (head.length > 0) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
}

export class EgressProxy {
  private constructor(
    private readonly server: HttpServer,
    private readonly tunnels: Set<Duplex>,
    public readonly port: number,
  ) {}

  static async start(opts: EgressProxyOptions): Promise<EgressProxy> {
    const server = createHttpServer();
    const tunnels = new Set<Duplex>();

    server.on('request', (req, res) => handleForward(opts, req, res));
    server.on('connect', (req, socket, head) => handleConnect(opts, tunnels, req, socket, head));

    return new Promise<EgressProxy>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('egress-proxy: failed to determine bound ephemeral port'));
          return;
        }
        resolve(new EgressProxy(server, tunnels, address.port));
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.tunnels) {
      socket.destroy();
    }
    this.tunnels.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
