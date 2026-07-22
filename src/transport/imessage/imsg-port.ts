// src/transport/imessage/imsg-port.ts
// Concrete ImessagePort against the macOS-native `imsg` daemon's JSON-RPC
// interface (NDJSON over a UNIX socket).
//
// The imsg daemon (AsamK-ecosystem, not to be confused with signal-cli)
// reads the local chat.db and sends via the macOS Messages framework. Its
// JSON-RPC surface (per the OpenClaw imessage extension's usage):
//   foundational: chats.list, messages.history, watch.subscribe,
//                 watch.unsubscribe, send
//   bridge-gated: react, typing, read-receipt (newer builds only)
//
// Capability policy (v1, honest degradation):
// - verifyCredentials → chats.list (limit 1) — proves daemon + chat.db.
// - send → send.
// - listInboundSince → messages.history.
// - sendReaction / sendReadReceipts / sendTypingIndicator → forwarded to the
//   bridge methods; an older daemon that lacks them answers with a
//   JSON-RPC method-not-found error, which the port surfaces as
//   ImessagePortError{ code: 'UnsupportedMethod', status: 501 } so the
//   adapter can park the extension without crashing the transport.
//
// The RPC seam is injectable (ImsgRpcConnection) so tests run without
// sockets — same pattern as the signal-cli port.

import net from 'node:net';
import type { ImessageConfig } from './types.ts';
import type {
  ImessagePort,
  ImessagePortError,
  InboundImessage,
  ReactImessageArgs,
  SendImessageArgs,
  SendReadReceiptArgs,
  SendTypingArgs,
} from './port.ts';

// ---------------------------------------------------------------------------
// Injectable RPC seam
// ---------------------------------------------------------------------------

export interface ImsgRpcConnection {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export type ImsgRpcConnectionFactory = (config: ImessageConfig) => ImsgRpcConnection;

// ---------------------------------------------------------------------------
// NDJSON-over-socket connection (production path)
// ---------------------------------------------------------------------------

const RPC_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: ImessagePortError) => void;
  timer: NodeJS.Timeout;
}

export function createSocketConnection(config: ImessageConfig): ImsgRpcConnection {
  const socket = net.createConnection(config.imsgSocketPath ?? '/tmp/imsg.sock');

  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let connectError: ImessagePortError | null = null;

  socket.on('error', (err) => {
    const rpcErr: ImessagePortError = {
      message: `imsg socket error: ${err.message}`,
      code: 'SocketError',
      status: 503,
    };
    if (pending.size === 0) connectError = rpcErr;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(rpcErr);
    }
    pending.clear();
  });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === '') continue;
      let frame: { id?: number; result?: unknown; error?: { code?: unknown; message?: unknown } };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        continue;
      }
      const id = frame.id;
      if (id === undefined) continue;
      const p = pending.get(id);
      if (!p) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      if (frame.error) {
        const code = frame.error.code;
        const isMethodMissing = code === -32601 || code === 'MethodNotFound';
        p.reject({
          message: typeof frame.error.message === 'string' ? frame.error.message : 'imsg RPC error',
          code: isMethodMissing ? 'UnsupportedMethod' : code !== undefined ? String(code) : undefined,
          status: isMethodMissing ? 501 : undefined,
        });
      } else {
        p.resolve(frame.result);
      }
    }
  });

  return {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (connectError) return Promise.reject(connectError);
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject({ message: `imsg rpc timeout (${method})`, code: 'Timeout', status: 504 } satisfies ImessagePortError);
        }, RPC_REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        const frame = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {}, id }) + '\n';
        socket.write(frame, (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(id);
            reject({ message: `imsg socket write failed: ${err.message}`, code: 'SocketError', status: 503 });
          }
        });
      });
    },
    close(): void {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject({ message: 'imsg connection closed', code: 'Closed', status: 503 });
      }
      pending.clear();
      socket.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Message normalization
// ---------------------------------------------------------------------------

/** imsg messages.history record (fields the port consumes). */
interface ImsgHistoryRecord {
  rowid?: number | string;
  guid?: string;
  from?: string;
  to?: string;
  chat_guid?: string;
  text?: string | null;
  is_from_me?: boolean;
  kind?: string;
  timestamp?: number;
}

function normalizeRecord(rec: ImsgHistoryRecord): InboundImessage | null {
  const guid = rec.guid ?? (rec.rowid !== undefined ? String(rec.rowid) : undefined);
  if (guid === undefined || guid === '') return null;
  return {
    guid,
    from: rec.from ?? (rec.is_from_me === true ? '' : 'unknown'),
    to: rec.to ?? rec.chat_guid ?? '',
    chatGuid: rec.chat_guid,
    body: typeof rec.text === 'string' ? rec.text : null,
    fromMe: rec.is_from_me === true,
    kind: rec.kind ?? (rec.text !== null && rec.text !== undefined ? 'text' : 'other'),
    timestamp: typeof rec.timestamp === 'number' ? rec.timestamp : 0,
  };
}

// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

export class ImsgPort implements ImessagePort {
  private connection: ImsgRpcConnection | null = null;
  private readonly config: ImessageConfig;
  private readonly connectionFactory: ImsgRpcConnectionFactory;

  // Explicit fields + assignment rather than constructor parameter properties:
  // this repo runs Node's --experimental-strip-types (no build step), which
  // rejects parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  constructor(
    config: ImessageConfig,
    connectionFactory: ImsgRpcConnectionFactory = createSocketConnection,
  ) {
    this.config = config;
    this.connectionFactory = connectionFactory;
  }

  private conn(): ImsgRpcConnection {
    if (!this.connection) {
      this.connection = this.connectionFactory(this.config);
    }
    return this.connection;
  }

  dispose(): void {
    this.connection?.close();
    this.connection = null;
  }

  async verifyCredentials(): Promise<void> {
    // chats.list with limit 1 is the lightest call that proves both the
    // daemon is reachable AND chat.db is readable.
    await this.conn().request('chats.list', { limit: 1 });
  }

  async send(args: SendImessageArgs): Promise<{ guid: string }> {
    const params: Record<string, unknown> = { to: args.recipient, text: args.body };
    if (args.subject !== undefined) params.subject = args.subject;
    const result = await this.conn().request('send', params) as
      | { rowid?: number | string; guid?: string }
      | undefined;
    const guid = result?.guid ?? (result?.rowid !== undefined ? String(result.rowid) : undefined);
    if (guid === undefined || guid === '') {
      throw {
        message: 'imsg send returned no message id',
        code: 'MalformedResponse',
        status: 502,
      } satisfies ImessagePortError;
    }
    return { guid };
  }

  async listInboundSince(since: Date, pageSize?: number, offset = 0): Promise<readonly InboundImessage[]> {
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize <= 0)) {
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
    }
    const result = await this.conn().request('messages.history', {
      since: since.getTime(),
      limit: pageSize ?? 100,
      offset,
    }) as { messages?: ImsgHistoryRecord[] } | ImsgHistoryRecord[] | undefined;

    const records = Array.isArray(result) ? result : (result?.messages ?? []);
    const sinceMs = since.getTime();
    const out: InboundImessage[] = [];
    for (const rec of records) {
      const normalized = normalizeRecord(rec);
      if (!normalized) continue;
      // Inclusive boundary: at-least-once delivery; callers dedupe by guid.
      if (normalized.timestamp < sinceMs) continue;
      out.push(normalized);
    }
    // Sort BEFORE capping: the cap must keep the OLDEST records.
    out.sort((a, b) => a.timestamp - b.timestamp);
    return pageSize !== undefined ? out.slice(0, pageSize) : out;
  }

  async sendReaction(args: ReactImessageArgs): Promise<void> {
    await this.conn().request('react', {
      chat_guid: args.conversation,
      target_guid: args.targetGuid,
      emoji: args.emoji,
      remove: args.remove,
    });
  }

  async sendReadReceipts(args: SendReadReceiptArgs): Promise<void> {
    await this.conn().request('read-receipt', {
      chat_guid: args.conversation,
      guids: [...args.guids],
    });
  }

  async sendTypingIndicator(args: SendTypingArgs): Promise<void> {
    await this.conn().request('typing', {
      chat_guid: args.conversation,
      composing: args.composing,
    });
  }
}
