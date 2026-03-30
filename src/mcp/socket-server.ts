import { createServer } from 'node:net';
import type { Server } from 'node:net';
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

export class WhatSoupSocketServer {
  private server: Server | null = null;
  private readonly socketPath: string;
  private readonly registry: ToolRegistry;
  private readonly session: SessionContext;

  constructor(socketPath: string, registry: ToolRegistry, session: SessionContext) {
    this.socketPath = socketPath;
    this.registry = registry;
    this.session = session;
  }

  start(): void {
    // Crash recovery: remove stale socket file if present
    try {
      unlinkSync(this.socketPath);
    } catch {
      // File didn't exist — that's fine
    }

    const MAX_BUF = 1_024 * 1_024; // 1 MB — prevent memory DoS from no-newline streams

    this.server = createServer((socket) => {
      let buf = '';

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
            continue;
          }

          // Notifications have no id — silently ignore them
          if (req.id === undefined) {
            continue;
          }

          void this.handleRequest(req).then((response) => {
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

    this.server.listen(this.socketPath, () => {
      log.info({ socketPath: this.socketPath }, 'MCP socket server listening');
    });

    this.server.on('error', (err) => {
      log.error({ err }, 'server error');
    });
  }

  stop(): void {
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

  updateDeliveryJid(jid: string): void {
    this.session.deliveryJid = jid;
  }

  private async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
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
          const tools = this.registry.listTools(this.session);
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
          const callResult = await this.registry.call(name, args, this.session);
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
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, method: req.method }, 'unhandled error in request handler');
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal error: ${message}` },
      };
    }
  }
}
