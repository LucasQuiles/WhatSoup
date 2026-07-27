// src/fleet/websocket-server.ts
// WebSocket server for real-time console updates.
// Design: invalidation-first — small events trigger React Query refetch.
// Exception: typing_update pushes full state (too latency-sensitive for refetch).
//
// Auth model (issue #237):
//   - Preferred: short-lived ?ticket=<...> validated against the in-process
//     ticket store. The browser fetches the ticket via POST /api/ws-ticket
//     (Bearer auth) so the root fleet token never travels in a URL.
//   - Legacy: ?token=<fleetToken> still works for one rollout cycle; it
//     emits a one-shot deprecation warning per server instance so operators
//     can spot tooling that hasn't migrated yet.

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';
import { createChildLogger } from '../logger.ts';
import type { TicketStore } from './ws-ticket.ts';
import { errorMessage } from '../lib/error-message.ts';

const log = createChildLogger('fleet:ws');

function describeAuthRejectUrl(rawUrl: string | undefined): {
  path: string;
  hasTicket: boolean;
  hasLegacyToken: boolean;
} {
  try {
    const url = new URL(rawUrl ?? '', 'http://localhost');
    return {
      path: url.pathname,
      hasTicket: url.searchParams.has('ticket'),
      hasLegacyToken: url.searchParams.has('token'),
    };
  } catch {
    return { path: '<invalid>', hasTicket: false, hasLegacyToken: false };
  }
}

// ---------------------------------------------------------------------------
// Event types — matches the realtime/WebSocket spec consensus
// ---------------------------------------------------------------------------

/** Invalidation events — trigger React Query refetch on the client. */
export interface WsInvalidationEvent {
  type:
    | 'instance_status'
    | 'message_received'
    | 'chat_updated'
    | 'log_entry'
    | 'feed_event'
    | 'access_changed'
    | 'lid_conflict';
  instance: string;
  /** Optional conversation key for scoped invalidation. */
  conversationKey?: string;
  /** Optional LID for lid_conflict invalidations. */
  lid?: string;
  /** Optional message pk for precise cache updates. */
  messagePk?: number;
}

/** Full-payload event for typing indicators (latency-sensitive). */
export interface WsTypingEvent {
  type: 'typing_update';
  instance: string;
  jid: string;
  composing: boolean;
  since: number;
}

export type WsEvent = WsInvalidationEvent | WsTypingEvent;

// ---------------------------------------------------------------------------
// FleetWebSocketServer
// ---------------------------------------------------------------------------

export interface FleetWsAuthDeps {
  /** Ticket store; ticket-mode connections are validated through this. */
  ticketStore: TicketStore;
  /** Signing keys to accept for ticket HMAC validation (active + accept[]). */
  ticketValidKeys: () => readonly string[];
  /** Verifier for the legacy `?token=` path. */
  verifyLegacyToken: (token: string) => boolean;
}

export class FleetWebSocketServer {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private authDeps: FleetWsAuthDeps;
  private legacyWarningEmitted = false;
  /**
   * Kept so `close()` can detach it (#2292 L6). The listener lives on the
   * SHARED httpServer, which outlives this object: without a reference there
   * is nothing to remove, so a closed server stayed subscribed to 'upgrade',
   * retained `this` (clients set, auth deps) for the process lifetime, and a
   * second instance on the same httpServer meant both handlers ran — the stale
   * one calling handleUpgrade on an already-closed WebSocketServer.
   */
  private readonly httpServer: HttpServer;
  private readonly onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(httpServer: HttpServer, authDeps: FleetWsAuthDeps) {
    this.authDeps = authDeps;
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests with auth
    this.onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.authenticate(req)) {
        log.warn(describeAuthRejectUrl(req.url), 'ws_auth_rejected');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    };
    httpServer.on('upgrade', this.onUpgrade);

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      log.info({ clients: this.clients.size }, 'ws_client_connected');

      ws.on('close', () => {
        this.clients.delete(ws);
        log.info({ clients: this.clients.size }, 'ws_client_disconnected');
      });

      ws.on('error', (err) => {
        log.warn({ err: err.message }, 'ws_client_error');
        this.clients.delete(ws);
      });

      // Send initial hello so client knows connection is live
      ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
    });
  }

  /** Broadcast an event to all connected clients. */
  broadcast(event: WsEvent): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(data);
        } catch (err) {
          this.clients.delete(client);
          log.warn({ err: errorMessage(err) }, 'ws_broadcast_failed');
        }
      }
    }
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Gracefully close all connections. */
  close(): void {
    // Detach FIRST: an upgrade arriving mid-close would otherwise be handed to
    // a WebSocketServer that is about to be (or already is) closed.
    this.httpServer.removeListener('upgrade', this.onUpgrade);
    for (const client of this.clients) {
      client.close(1001, 'server shutting down');
    }
    this.clients.clear();
    this.wss.close();
  }

  // ---------------------------------------------------------------------------
  // Auth — query parameter only (browser WebSocket can't send headers)
  //   - ?ticket=<...>  preferred; HMAC-signed, single-use, ~60s TTL
  //   - ?token=<...>   legacy; emits a one-shot deprecation log per server
  // ---------------------------------------------------------------------------

  private authenticate(req: IncomingMessage): boolean {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const ticket = url.searchParams.get('ticket');
      if (ticket) {
        return this.authDeps.ticketStore.redeem(ticket, this.authDeps.ticketValidKeys());
      }
      const legacyToken = url.searchParams.get('token');
      if (legacyToken) {
        const ok = this.authDeps.verifyLegacyToken(legacyToken);
        if (ok && !this.legacyWarningEmitted) {
          this.legacyWarningEmitted = true;
          log.warn({ legacy: 'ws-token-in-url' }, 'ws_legacy_token_path');
        }
        return ok;
      }
      return false;
    } catch {
      return false;
    }
  }
}
