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
 * policy file, surfaced by the caller's `EgressPolicySource` — denies with
 * reason `policy-unreadable`, UNLESS `failOpen` is true, in which case it
 * allows and logs `sandbox_egress_fail_open` with reason `policy-unreadable`
 * instead. This is the same shape as the missing-`sandbox-policy.json`
 * handling in `deploy/hooks/agent-sandbox.sh:22-25`: that hook treats an
 * unreadable (there, absent) policy as the trigger for
 * `WHATSOUP_SANDBOX_FAIL_OPEN=1` to allow, and this module mirrors it for the
 * policy-throws case. `failOpen` likewise relaxes the plain "policy read fine
 * but host/port is not on the allowlist" denial: normally that denies, with
 * `failOpen: true` it allows and logs `sandbox_egress_fail_open` instead of
 * `sandbox_egress_deny` (resolved by the CALLER — this module never reads
 * `process.env`).
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
   * from process.env here. Relaxes both a not-on-the-allowlist denial and a
   * policy-read failure into an allow (see module docs).
   */
  failOpen?: boolean;
}

const HTTP_DENY_BODY = '403 Forbidden';
const CONNECT_ESTABLISHED = 'HTTP/1.1 200 Connection Established\r\n\r\n';
// Same short body as the forward-path 403 (HTTP_DENY_BODY), so a CONNECT
// deny and a forward deny are indistinguishable to the caller by body text.
const CONNECT_FORBIDDEN =
  `HTTP/1.1 403 Forbidden\r\nContent-Length: ${Buffer.byteLength(HTTP_DENY_BODY)}\r\nConnection: close\r\n\r\n${HTTP_DENY_BODY}`;
// No body: sent only when adjudication already allowed the tunnel and the
// upstream TCP connect itself failed — there is nothing upstream to relay a
// body from, and the 200 banner has not been sent yet (see handleConnect).
const CONNECT_BAD_GATEWAY = 'HTTP/1.1 502 Bad Gateway\r\n\r\n';

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
    // Defense in depth (F3): a live-edited policy can carry a non-string
    // element (e.g. an operator adds `443` or an object). Skip it rather than
    // throw a TypeError on `.lastIndexOf`/`.toLowerCase` — this call site is
    // outside adjudicate()'s try/catch, so an uncaught throw here crashes the
    // whole proxy process. The runtime policy reader also filters to strings.
    if (typeof entry !== 'string') continue;
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
    if (opts.failOpen) {
      opts.log({ event: 'sandbox_egress_fail_open', host, port, reason: 'policy-unreadable' });
      return true;
    }
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
  const rawUrl = req.url ?? '';
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    opts.log({ event: 'sandbox_egress_deny', host: rawUrl, port: 0, reason: 'malformed-target' });
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('400 Bad Request: absolute-URI required');
    return;
  }

  // Normalized once here so adjudication and every log event below carry the
  // same lowercase host (URL already lowercases http/https hostnames, but we
  // don't rely on that — see the CONNECT path, which has no such guarantee).
  const host = target.hostname.toLowerCase();
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
      // Class defense (F5): this 'response' listener is catch-less; a
      // synchronous throw from writeHead (e.g. an invalid upstream header
      // value) would otherwise be uncaught and kill the process. Turn it into
      // a clean 502 + end instead.
      try {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      } catch {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end();
        upstreamRes.destroy();
      }
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
  // Reject out-of-range ports (F2): a port > 65535 (or <= 0) is not a valid
  // TCP port. Without the upper bound it reaches netConnect(port, host), which
  // throws ERR_SOCKET_BAD_PORT synchronously inside the catch-less connect
  // listener — an uncaught throw that kills the whole proxy process. Returning
  // null routes it through the malformed-target deny path instead.
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Exported (unlike `handleForward`, `parseConnectTarget`) so tests can drive
 * a hijacked CONNECT socket directly and assert the entry-level 'error'
 * listener below is in place without needing to win a real TCP RST race —
 * see the module's test file for why that race isn't practical to trigger
 * in-process.
 */
export function handleConnect(
  opts: EgressProxyOptions,
  tunnels: Set<Duplex>,
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): void {
  // Attached before anything else touches `clientSocket` — parsing,
  // adjudication, and both early-return deny writes below all happen before
  // any other listener exists on this socket. A CONNECT socket is handed to
  // this function already hijacked away from http.Server's own connection
  // management (unlike the forward path's `req`/`res`, which stay under
  // http.Server's internal error handling for their whole lifetime — see
  // `handleForward`). Without a listener here, a loopback peer that resets
  // the connection in the window between the server accepting the CONNECT
  // and a deny write flushing hits Node's default 'error' behavior on a
  // listener-less socket: uncaught exception, whole process exits. Since
  // this proxy's only client is the sandboxed (adversarial) agent
  // subprocess, that subprocess could trigger this on demand and take down
  // its own containment boundary. Left in place (not removed) once the
  // allowed path adds its own `teardown`-bound listener below — two 'error'
  // listeners both settling on `clientSocket.destroy()` is harmless, since
  // `destroy()` is idempotent.
  clientSocket.on('error', () => clientSocket.destroy());

  // Class defense (F2): wrap parse → adjudicate → netConnect so ANY synchronous
  // throw (a malformed adjudication, an ERR_SOCKET_BAD_PORT from netConnect, a
  // throwing policy reader that escapes adjudicate) becomes a clean deny+destroy
  // rather than an uncaught exception that kills the process. The sandboxed
  // agent is this proxy's only client, so it could otherwise take down its own
  // containment boundary on demand.
  try {
    const rawTarget = req.url ?? '';
    const parsed = parseConnectTarget(rawTarget);
    if (!parsed) {
      opts.log({ event: 'sandbox_egress_deny', host: rawTarget, port: 0, reason: 'malformed-target' });
      clientSocket.write(CONNECT_FORBIDDEN, () => clientSocket.destroy());
      return;
    }
    // Normalized once here (see handleForward) — the raw CONNECT authority is
    // never run through URL parsing, so unlike the forward path this is the
    // only place case gets normalized before adjudication/logging/connect.
    const host = parsed.host.toLowerCase();
    const { port } = parsed;

    if (!adjudicate(opts, host, port)) {
      clientSocket.write(CONNECT_FORBIDDEN, () => clientSocket.destroy());
      return;
    }

    const upstream = netConnect(port, host);
    tunnels.add(clientSocket);
    tunnels.add(upstream);

    // Set once the 200 banner has actually been written, so the upstream
    // error handler below knows whether it's still safe to write a 502
    // status line (never write after the tunnel is already established).
    let established = false;

    const teardown = () => {
      tunnels.delete(clientSocket);
      tunnels.delete(upstream);
      clientSocket.destroy();
      upstream.destroy();
    };

    clientSocket.on('error', teardown);
    clientSocket.on('close', teardown);
    upstream.on('close', teardown);

    upstream.on('error', () => {
      if (!established && !clientSocket.destroyed && clientSocket.writable) {
        clientSocket.write(CONNECT_BAD_GATEWAY, () => teardown());
        return;
      }
      teardown();
    });

    upstream.on('connect', () => {
      established = true;
      clientSocket.write(CONNECT_ESTABLISHED);
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
  } catch {
    opts.log({ event: 'sandbox_egress_deny', host: '', port: 0, reason: 'connect-error' });
    if (!clientSocket.destroyed) clientSocket.destroy();
  }
}

export class EgressProxy {
  // Explicit fields (not constructor parameter properties): the runtime uses
  // Node's --experimental-strip-types (strip-only mode, no build), which rejects
  // parameter properties. See tests/strip-types-compat.test.ts.
  private readonly server: HttpServer;
  private readonly tunnels: Set<Duplex>;
  public readonly port: number;

  private constructor(server: HttpServer, tunnels: Set<Duplex>, port: number) {
    this.server = server;
    this.tunnels = tunnels;
    this.port = port;
  }

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
    // Force-close active/keep-alive FORWARD connections (F8): server.close()
    // stops accepting but does NOT terminate in-flight or idle keep-alive
    // sockets, so a live plain-HTTP transfer could stall shutdown indefinitely.
    // closeAllConnections() (Node 18.2+) tears them down. The tunnel destroy
    // loop above already handles CONNECT sockets, which are hijacked away from
    // the server's own connection tracking.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
