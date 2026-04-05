// src/fleet/websocket-server.ts
// WebSocket server for real-time console updates.
// Design: invalidation-first — small events trigger React Query refetch.
// Exception: typing_update pushes full state (too latency-sensitive for refetch).

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('fleet:ws');

// ---------------------------------------------------------------------------
// Event types — matches Phase 4 spec consensus
// ---------------------------------------------------------------------------

/** Invalidation events — trigger React Query refetch on the client. */
export interface WsInvalidationEvent {
  type: 'instance_status' | 'message_received' | 'chat_updated' | 'log_entry' | 'feed_event' | 'access_changed';
  instance: string;
  /** Optional conversation key for scoped invalidation. */
  conversationKey?: string;
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

export class FleetWebSocketServer {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private expectedToken: string;

  constructor(httpServer: HttpServer, expectedToken: string) {
    this.expectedToken = expectedToken;
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests with auth
    httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
      if (!this.authenticate(req)) {
        log.warn({ url: req.url }, 'ws_auth_rejected');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

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
        client.send(data);
      }
    }
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Gracefully close all connections. */
  close(): void {
    for (const client of this.clients) {
      client.close(1001, 'server shutting down');
    }
    this.clients.clear();
    this.wss.close();
  }

  // ---------------------------------------------------------------------------
  // Auth — ?token= query parameter (browser WebSocket can't send headers)
  // ---------------------------------------------------------------------------

  private authenticate(req: IncomingMessage): boolean {
    if (!this.expectedToken) return false;
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) return false;
      if (token.length !== this.expectedToken.length) return false;
      return timingSafeEqual(Buffer.from(token), Buffer.from(this.expectedToken));
    } catch {
      return false;
    }
  }
}
