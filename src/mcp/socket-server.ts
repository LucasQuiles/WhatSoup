import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { unlinkSync } from 'node:fs';
import { createChildLogger } from '../logger.ts';
import type { ToolRegistry } from './registry.ts';
import type { SessionContext } from './types.ts';

const log = createChildLogger('WhatSoupSocketServer');

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// SP11: Per-connection SessionContext isolation
//
// Each MCP client connection receives its own shallow clone of the base
// SessionContext. This prevents concurrent clients from racing on
// deliveryJid or other mutable session fields.
//
// updateDeliveryJid propagates to ALL active connections so JID alias
// changes (e.g., from LID resolution) reach every client.
// ---------------------------------------------------------------------------

export class WhatSoupSocketServer {
  private server: Server | null = null;
  private readonly socketPath: string;
  private readonly registry: ToolRegistry;
  private readonly baseSession: SessionContext;
  /** Per-connection isolated sessions. Cleaned up on disconnect. */
  private readonly connectionSessions = new Map<number, SessionContext>();
  /** Active client sockets. Destroyed on stop() so FDs do not leak. */
  private readonly activeSockets = new Map<number, Socket>();

  /**
   * F-STICKY-ACTOR: optional per-request actor resolver. When set (per-chat
   * sockets in non-sandbox per_chat mode), the actor for each tool call is
   * resolved at read time from the turn the subprocess is currently executing,
   * fail-closed (undefined -> deny). When unset, behavior is unchanged and the
   * request uses the broadcast connSession.actorJid.
   */
  private readonly actorResolver?: () => string | undefined;

  constructor(
    socketPath: string,
    registry: ToolRegistry,
    session: SessionContext,
    actorResolver?: () => string | undefined,
  ) {
    this.socketPath = socketPath;
    this.registry = registry;
    this.baseSession = session;
    this.actorResolver = actorResolver;
  }

  /** Number of active client connections. */
  get connectionCount(): number {
    return this.connectionSessions.size;
  }

  /** Configured concurrent-connection cap on the underlying server (QR-059); 0 before start(). */
  get maxConnections(): number {
    return this.server?.maxConnections ?? 0;
  }

  start(): void {
    // Crash recovery: remove stale socket file if present
    try {
      unlinkSync(this.socketPath);
    } catch {
      // File didn't exist — that's fine
    }

    const MAX_BUF = 1_024 * 1_024; // 1 MB — prevent memory DoS from no-newline streams
    // QR-059: cap concurrent connections. Legit clients (the instance's own agent subprocess
    // holding one persistent MCP session + short-lived per-call fleet mcpCall connections) use
    // single-digit concurrency, so 128 is generous headroom while bounding a connection-flood /
    // slow-loris fan-out from a compromised agent to N held sockets (each already ≤1MB via
    // MAX_BUF). No idle timeout is added: legit MCP sessions are legitimately long-idle between
    // tool calls, so an idle-destroy would break them — the count cap bounds the blast radius.
    const MAX_CONNECTIONS = 128;

    let clientCounter = 0;

    this.server = createServer((socket: Socket) => {
      const clientId = ++clientCounter;
      // SP11: Clone base session for this connection
      const abortController = new AbortController();
      const connSession: SessionContext = { ...this.baseSession, abortSignal: abortController.signal };
      this.connectionSessions.set(clientId, connSession);
      this.activeSockets.set(clientId, socket);

      log.info({ clientId, socketPath: this.socketPath, connections: this.connectionSessions.size }, 'client connected');
      // QR-053: decode the stream as UTF-8 so Node's internal StringDecoder buffers
      // an incomplete multibyte sequence across a kernel read boundary. Without this,
      // `chunk.toString()` decoded each ~64KB read independently and a multibyte char
      // (emoji / non-Latin) split across the boundary was silently turned into U+FFFD
      // — JSON.parse still succeeded, so a mangled tool arg / message body shipped with
      // no error. With setEncoding, each 'data' chunk is already a string assembled
      // across boundaries; the chunk.toString() below is then a no-op on the string.
      socket.setEncoding('utf8');
      let buf = '';

      socket.on('close', () => {
        abortController.abort(); // Signal all pending tool calls for this client
        this.connectionSessions.delete(clientId);
        this.activeSockets.delete(clientId);
        log.info({ clientId, connections: this.connectionSessions.size }, 'client disconnected');
      });

      socket.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.length > MAX_BUF) {
          log.warn('buffer exceeded 1 MB limit — closing connection');
          socket.destroy();
          return;
        }
        const lines = buf.split('\n');
        // Last element may be an incomplete line — keep it in the buffer
        buf = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let req: JsonRpcRequest;
          try {
            req = JSON.parse(trimmed) as JsonRpcRequest;
          } catch {
            log.warn({ line: trimmed }, 'failed to parse JSON-RPC message');
            const response: JsonRpcResponse = {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            };
            try {
              socket.write(JSON.stringify(response) + '\n');
            } catch (err) {
              log.error({ err }, 'failed to write parse error response');
            }
            continue;
          }

          // Notifications have no id — silently ignore them
          if (req.id === undefined) {
            continue;
          }

          // QR-042: snapshot the session per request. connSession.actorJid /
          // deliveryJid / conversationKey are mutated IN PLACE by updateActorJid /
          // updateConversationKey at each turn dispatch; with fire-and-forget dispatch
          // sharing the one connSession, a next-turn mutation could race an in-flight
          // admin-gated tool reading actorJid (it could observe the wrong turn's actor).
          // A shallow per-request copy pins those fields at dispatch time; the live
          // abortSignal is preserved by reference so client-disconnect still aborts.
          const requestSession: SessionContext = { ...connSession };
          // F-STICKY-ACTOR: per-chat sockets bind the actor to the currently
          // executing turn, resolved at read time and fail-closed (undefined ->
          // deny). Overrides the broadcast connSession.actorJid, which is not
          // maintained for per-chat sockets.
          if (this.actorResolver) requestSession.actorJid = this.actorResolver();
          void this.handleRequest(req, requestSession).then((response) => {
            if (response !== null) {
              try {
                socket.write(JSON.stringify(response) + '\n');
              } catch (err) {
                log.error({ err }, 'failed to write response');
              }
            }
          }).catch(err => log.error({ err }, 'request handler failed'));
        }
      });

      socket.on('error', (err) => {
        log.error({ err }, 'socket error');
      });
    });

    this.server.maxConnections = MAX_CONNECTIONS;

    this.server.listen(this.socketPath, () => {
      log.info({ socketPath: this.socketPath }, 'MCP socket server listening');
    });

    this.server.on('error', (err) => {
      log.error({ err }, 'server error');
    });
  }

  stop(): void {
    for (const socket of this.activeSockets.values()) {
      socket.destroy();
    }
    this.activeSockets.clear();
    this.connectionSessions.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Already gone — that's fine
      }
    }
  }

  /**
   * Update delivery JID on the base session AND all active connections.
   * This ensures JID alias changes (e.g., LID resolution) propagate
   * to every connected MCP client.
   */
  updateDeliveryJid(jid: string): void {
    this.baseSession.deliveryJid = jid;
    for (const session of this.connectionSessions.values()) {
      session.deliveryJid = jid;
    }
  }

  /**
   * Update actor JID (caller identity) on the base session AND all active
   * connections. Set per-message by the runtime before dispatching to the
   * subprocess, so admin-gated substrate tools see the sender's phone JID
   * rather than the group chat JID.
   */
  updateActorJid(jid: string | undefined): void {
    this.baseSession.actorJid = jid;
    for (const session of this.connectionSessions.values()) {
      session.actorJid = jid;
    }
  }

  /**
   * Update conversation binding on the base session AND all active connections.
   * Shared/global runtimes call this at turn start so injected tools inherit the
   * originating conversation and the registry's cross-conversation guard can fire.
   */
  updateConversationKey(conversationKey: string | undefined): void {
    this.baseSession.conversationKey = conversationKey;
    for (const session of this.connectionSessions.values()) {
      session.conversationKey = conversationKey;
    }
  }

  private async handleRequest(req: JsonRpcRequest, session: SessionContext): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;

    try {
      switch (req.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'whatsoup', version: '0.1.0' },
            },
          };

        case 'tools/list': {
          const tools = this.registry.listTools(session);
          return {
            jsonrpc: '2.0',
            id,
            result: { tools },
          };
        }

        case 'tools/call': {
          const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          const name = params?.name ?? '';
          const args = params?.arguments ?? {};
          const callResult = await this.registry.call(name, args, session);
          return {
            jsonrpc: '2.0',
            id,
            result: callResult,
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }
    } catch (err) {
      const errorId = `E${Date.now().toString(36).toUpperCase()}`;
      log.error({ err, method: req.method, errorId }, 'unhandled error in request handler');
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal error [${errorId}]` },
      };
    }
  }
}
