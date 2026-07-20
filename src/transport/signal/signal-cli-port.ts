// src/transport/signal/signal-cli-port.ts
// Concrete SignalPort implementation against a signal-cli daemon's JSON-RPC
// interface (NDJSON over a UNIX socket or TCP).
//
// signal-cli daemon mode speaks JSON-RPC 2.0 with newline-delimited frames:
//   → {"jsonrpc":"2.0","method":"send","params":{...},"id":1}\n
//   ← {"jsonrpc":"2.0","result":{...},"id":1}\n
//
// Design notes:
// - The RPC connection is an injectable seam (SignalRpcConnection) so tests
//   run the full port logic against a scripted connection with no sockets.
// - The connection is lazily opened on first use, mirroring twilio-port.ts's
//   lazy client init. The daemon socket path/host is operator config, so
//   eager connect at construction would make adapters unconstructable when
//   the daemon is down — lazy keeps construction cheap and puts the failure
//   at the first verifyCredentials() call where the adapter expects it.
// - Errors surface as SignalPortError-shaped plain objects; the ADAPTER maps
//   them to typed TransportError subclasses (port knows RPC, adapter knows
//   the contract).

import net from 'node:net';
import type { SignalConfig } from './types.ts';
import type {
  InboundSignal,
  ReactSignalArgs,
  SendReadReceiptArgs,
  SendSignalArgs,
  SendTypingArgs,
  SignalPort,
  SignalPortError,
} from './port.ts';

// ---------------------------------------------------------------------------
// Injectable RPC seam
// ---------------------------------------------------------------------------

/** Minimal JSON-RPC connection: one request/response round-trip per call. */
export interface SignalRpcConnection {
  /** Send a JSON-RPC method call; resolves with the `result`, rejects with a
   *  SignalPortError-shaped object on RPC error, transport error, or timeout. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Close the underlying transport. Idempotent. */
  close(): void;
}

export type SignalRpcConnectionFactory = (config: SignalConfig) => SignalRpcConnection;

// ---------------------------------------------------------------------------
// NDJSON-over-socket connection (production path)
// ---------------------------------------------------------------------------

const RPC_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: SignalPortError) => void;
  timer: NodeJS.Timeout;
}

export function createSocketConnection(config: SignalConfig): SignalRpcConnection {
  const useSocket = config.socketPath !== undefined || config.tcpPort === undefined;
  const socket = useSocket
    ? net.createConnection(config.socketPath ?? '/tmp/signalc.sock')
    : net.createConnection({
        host: config.tcpHost ?? '127.0.0.1',
        port: config.tcpPort!,
      });

  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let connectError: SignalPortError | null = null;

  socket.on('error', (err) => {
    const rpcErr: SignalPortError = {
      message: `signal-cli socket error: ${err.message}`,
      code: 'SocketError',
      status: 503,
    };
    if (pending.size === 0) {
      connectError = rpcErr;
    }
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
        continue; // malformed frame — signal-cli emits log lines on some builds; skip
      }
      const id = frame.id;
      if (id === undefined) continue; // async notification, not a response
      const p = pending.get(id);
      if (!p) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      if (frame.error) {
        p.reject({
          message: typeof frame.error.message === 'string' ? frame.error.message : 'signal-cli RPC error',
          code: frame.error.code !== undefined ? String(frame.error.code) : undefined,
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
          reject({ message: `signal-cli RPC ${method} timed out after ${RPC_REQUEST_TIMEOUT_MS}ms`, code: 'Timeout', status: 504 } satisfies SignalPortError);
        }, RPC_REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        const frame = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {}, id }) + '\n';
        socket.write(frame, (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(id);
            reject({ message: `signal-cli socket write failed: ${err.message}`, code: 'SocketError', status: 503 });
          }
        });
      });
    },
    close(): void {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject({ message: 'signal-cli connection closed', code: 'Closed', status: 503 });
      }
      pending.clear();
      socket.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Envelope normalization
// ---------------------------------------------------------------------------

/** signal-cli receive() envelope wrapper (fields the port consumes). */
interface RpcEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  timestamp?: number;
  dataMessage?: {
    message?: string | null;
    groupInfo?: { groupId?: string };
  };
  syncMessage?: {
    sentMessage?: {
      message?: string | null;
      destination?: string;
      destinationNumber?: string;
      destinationUuid?: string;
      groupInfo?: { groupId?: string };
      timestamp?: number;
    };
  };
  receiptMessage?: unknown;
  typingMessage?: unknown;
}

function senderUuid(env: RpcEnvelope): string {
  return env.sourceUuid ?? env.source ?? env.sourceNumber ?? 'unknown';
}

function normalizeEnvelope(env: RpcEnvelope, ownNumber: string): InboundSignal | null {
  // Sync echo of our own outbound message.
  if (env.syncMessage?.sentMessage) {
    const sent = env.syncMessage.sentMessage;
    return {
      timestamp: sent.timestamp ?? env.timestamp ?? 0,
      source: ownNumber,
      destination: sent.destinationUuid ?? sent.destination ?? sent.destinationNumber ?? sent.groupInfo?.groupId ?? 'unknown',
      groupId: sent.groupInfo?.groupId,
      body: sent.message ?? null,
      fromMe: true,
      type: 'sync',
    };
  }
  // Inbound data message.
  if (env.dataMessage) {
    return {
      timestamp: env.timestamp ?? 0,
      source: senderUuid(env),
      destination: env.dataMessage.groupInfo?.groupId ?? ownNumber,
      groupId: env.dataMessage.groupInfo?.groupId,
      body: env.dataMessage.message ?? null,
      fromMe: false,
      type: 'data',
    };
  }
  // Receipts, typing indicators, calls: not message envelopes — the adapter's
  // inbound filter drops non-text anyway; keep the port's surface messages-only.
  return null;
}

// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

export class SignalCliPort implements SignalPort {
  private connection: SignalRpcConnection | null = null;

  constructor(
    private readonly config: SignalConfig,
    private readonly connectionFactory: SignalRpcConnectionFactory = createSocketConnection,
  ) {}

  /** Lazily open the RPC connection on first use. */
  private conn(): SignalRpcConnection {
    if (!this.connection) {
      this.connection = this.connectionFactory(this.config);
    }
    return this.connection;
  }

  /** Release the connection (daemon restart, adapter disconnect). Idempotent. */
  dispose(): void {
    this.connection?.close();
    this.connection = null;
  }

  async verifyCredentials(): Promise<void> {
    // `version` is the lightest RPC the daemon answers; a successful round-trip
    // proves the daemon is reachable AND the JSON-RPC channel is functional.
    // An unlinked/closed account surfaces as an RPC error on this call on
    // signal-cli >= 0.13 daemon mode.
    await this.conn().request('version');
  }

  async send(args: SendSignalArgs): Promise<{ timestamp: number }> {
    if (args.recipient && args.groupId) {
      throw Object.assign(new Error('send: recipient and groupId are mutually exclusive'), { code: 'BadArgs' }) satisfies SignalPortError;
    }
    if (!args.recipient && !args.groupId) {
      throw Object.assign(new Error('send: one of recipient or groupId is required'), { code: 'BadArgs' }) satisfies SignalPortError;
    }
    const params: Record<string, unknown> = { message: args.body };
    if (args.groupId) {
      params.groupId = args.groupId;
    } else {
      params.recipient = [args.recipient];
    }
    const result = await this.conn().request('send', params) as { timestamp?: number } | undefined;
    const timestamp = result?.timestamp ?? args.timestamp ?? Date.now();
    return { timestamp };
  }

  async listInboundSince(since: Date, pageSize?: number): Promise<readonly InboundSignal[]> {
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize <= 0)) {
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
    }
    // signal-cli `receive` long-polls; a short timeout makes this effectively
    // a drain-what's-queued call in poll mode. Envelopes older than `since`
    // are dropped here so the adapter's cursor semantics stay simple.
    const result = await this.conn().request('receive', { timeout: 1 }) as
      | Array<{ envelope?: RpcEnvelope }>
      | undefined;
    const sinceMs = since.getTime();
    const out: InboundSignal[] = [];
    for (const wrapper of result ?? []) {
      const env = wrapper.envelope;
      if (!env) continue;
      const normalized = normalizeEnvelope(env, this.config.phoneNumber);
      if (!normalized) continue;
      // Inclusive boundary: at-least-once delivery means timestamp == since
      // re-delivers; callers dedupe by timestamp.
      if (normalized.timestamp < sinceMs) continue;
      out.push(normalized);
      if (pageSize !== undefined && out.length >= pageSize) break;
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  async sendReaction(args: ReactSignalArgs): Promise<void> {
    const params: Record<string, unknown> = {
      emoji: args.emoji,
      targetAuthor: args.targetAuthor,
      targetTimestamp: args.targetTimestamp,
    };
    if (args.remove) params.remove = true;
    if (args.targetInGroup) {
      params.groupId = args.targetAuthor;
    } else {
      params.recipient = [args.targetAuthor];
    }
    await this.conn().request('sendReaction', params);
  }

  async sendReadReceipts(args: SendReadReceiptArgs): Promise<void> {
    await this.conn().request('sendReceipt', {
      recipient: [args.target],
      type: 'read',
      targetTimestamps: [...args.timestamps],
    });
  }

  async sendTypingIndicator(args: SendTypingArgs): Promise<void> {
    await this.conn().request('sendTyping', {
      recipient: [args.target],
      when: args.composing ? 'TYPING' : 'STOPPED',
    });
  }
}
