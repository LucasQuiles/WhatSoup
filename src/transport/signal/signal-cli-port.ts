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
  InboundAttachment,
  InboundSignal,
  ReactSignalArgs,
  SendReadReceiptArgs,
  SendSignalArgs,
  SendTypingArgs,
  SignalGroupMetadata,
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
    reaction?: {
      emoji?: string | null;
      targetAuthorUuid?: string;
      targetSentTimestamp?: number;
      isRemove?: boolean;
    };
    delete?: {
      targetSentTimestamp?: number;
    };
    /**
     * edited message payload. signal-cli surfaces an edited
     * inbound message via `dataMessage.edit` with the original message's
     * timestamp and the replacement body in `message`.
     */
    edit?: {
      targetSentTimestamp?: number;
    };
    /**
     * signal-cli downloads inbound attachments to its data dir and
     * reports each one with: storedFilename (absolute path on the signal-cli
     * host), contentType (sniffed MIME), size (decoded bytes), and optionally
     * a caller-facing filename. See `man signal-cli` §receive.
     */
    attachments?: RpcAttachment[];
  };
  syncMessage?: {
    sentMessage?: {
      message?: string | null;
      destination?: string;
      destinationNumber?: string;
      destinationUuid?: string;
      groupInfo?: { groupId?: string };
      timestamp?: number;
      attachments?: RpcAttachment[];
    };
  };
  receiptMessage?: {
    type?: string;            // 'READ' | 'DELIVERY'
    timestamps?: number[];
  };
  typingMessage?: unknown;
}

/**
 * signal-cli's `attachments` array shape (per the man page §receive
 * and the JSON-RPC `receive` response). The port carries these through
 * unchanged; the adapter decides what to surface upstream.
 */
interface RpcAttachment {
  storedFilename?: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

/** Convert a signal-cli RPC attachment to the port-level InboundAttachment. */
function toInboundAttachment(a: RpcAttachment): InboundAttachment | null {
  if (!a || typeof a.storedFilename !== 'string') return null;
  return {
    storedFilename: a.storedFilename,
    contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
    size: typeof a.size === 'number' ? a.size : 0,
    filename: typeof a.filename === 'string' ? a.filename : undefined,
  };
}

function senderUuid(env: RpcEnvelope): string {
  return env.sourceUuid ?? env.source ?? env.sourceNumber ?? 'unknown';
}

export function normalizeEnvelope(env: RpcEnvelope, ownNumber: string): InboundSignal | null {
  // Sync echo of our own outbound message.
  if (env.syncMessage?.sentMessage) {
    const sent = env.syncMessage.sentMessage;
    const attachments = (sent.attachments ?? [])
      .map(toInboundAttachment)
      .filter((a): a is InboundAttachment => a !== null);
    return {
      timestamp: sent.timestamp ?? env.timestamp ?? 0,
      source: ownNumber,
      destination: sent.destinationUuid ?? sent.destination ?? sent.destinationNumber ?? sent.groupInfo?.groupId ?? 'unknown',
      groupId: sent.groupInfo?.groupId,
      body: sent.message ?? null,
      fromMe: true,
      type: 'sync',
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }
  // Read receipt — ONLY type='READ' (DELIVERY receipts have no extension event
  // in v1; durability tracks delivery via sync echoes). One receipt can carry
  // multiple timestamps; the adapter fans them out to one ReadEvent each.
  if (env.receiptMessage?.type === 'READ' && Array.isArray(env.receiptMessage.timestamps)) {
    return {
      timestamp: env.timestamp ?? 0,
      source: senderUuid(env),
      destination: ownNumber,
      body: null,
      fromMe: false,
      type: 'read',
      read: { timestamps: env.receiptMessage.timestamps.slice() },
    };
  }
  // Inbound data message — may carry text, a reaction, or a remote-delete.
  // signal-cli packs all three under dataMessage; the discriminator is which
  // sub-object is present (reaction / delete / message body).
  if (env.dataMessage) {
    const dm = env.dataMessage;
    const groupId = dm.groupInfo?.groupId;

    // Remote-delete (dataMessage.delete). targetAuthor is not echoed by
    // signal-cli; the port fills it with the envelope source — the deleter —
    // which matches the common case where actor==author. The adapter surfaces
    // targetAuthor as target.conversation; mismatches surface as a different
    // conversation id but still emit the event.
    if (dm.delete && typeof dm.delete.targetSentTimestamp === 'number') {
      return {
        timestamp: env.timestamp ?? 0,
        source: senderUuid(env),
        destination: groupId ?? ownNumber,
        groupId,
        body: null,
        fromMe: false,
        type: 'delete',
        delete: {
          targetTimestamp: dm.delete.targetSentTimestamp,
          targetAuthor: senderUuid(env),
        },
      };
    }

    // Reaction (dataMessage.reaction). Empty emoji + isRemove is the
    // canonical "remove" form; signal-cli also emits isRemove:true with the
    // previously-reacted emoji.
    if (dm.reaction && typeof dm.reaction.targetSentTimestamp === 'number') {
      return {
        timestamp: env.timestamp ?? 0,
        source: senderUuid(env),
        destination: groupId ?? ownNumber,
        groupId,
        body: null,
        fromMe: false,
        type: 'reaction',
        reaction: {
          emoji: dm.reaction.emoji ?? '',
          remove: dm.reaction.isRemove === true,
          targetTimestamp: dm.reaction.targetSentTimestamp,
          targetAuthor: dm.reaction.targetAuthorUuid ?? senderUuid(env),
        },
      };
    }

    // edited message. signal-cli emits these as a dataMessage with
    // both `edit.targetSentTimestamp` (the original message) and `message`
    // (the new body). Detect BEFORE the plain-text fallback so edits don't
    // surface as fresh messages.
    if (dm.edit && typeof dm.edit.targetSentTimestamp === 'number') {
      return {
        timestamp: env.timestamp ?? 0,
        source: senderUuid(env),
        destination: groupId ?? ownNumber,
        groupId,
        body: dm.message ?? null,
        fromMe: false,
        type: 'edit',
        edit: {
          targetTimestamp: dm.edit.targetSentTimestamp,
          newText: dm.message ?? '',
        },
      };
    }

    // Plain text (or text + attachments). signal-cli emits attachments
    // under dataMessage.attachments when a media message arrives.
    const attachments = (dm.attachments ?? [])
      .map(toInboundAttachment)
      .filter((a): a is InboundAttachment => a !== null);
    return {
      timestamp: env.timestamp ?? 0,
      source: senderUuid(env),
      destination: groupId ?? ownNumber,
      groupId,
      body: dm.message ?? null,
      fromMe: false,
      type: 'data',
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }
  // typingMessage envelopes. signal-cli's typingMessage carries
  // an optional `action` field ('STARTED' for composing, 'STOPPED' for idle).
  // We surface these as type='typing' with a composing boolean; the adapter
  // emits a PresenceEvent. (Pre- these were dropped.)
  if (env.typingMessage && typeof env.typingMessage === 'object') {
    const tm = env.typingMessage as { action?: string };
    const composing = tm.action !== 'STOPPED';
    return {
      timestamp: env.timestamp ?? 0,
      source: senderUuid(env),
      destination: ownNumber,
      body: null,
      fromMe: false,
      type: 'typing',
      typing: { composing },
    };
  }
  // Delivery receipts and calls remain dropped — no inbound extension event
  // for these (delivery is tracked via sync echoes; calls are out of scope).
  return null;
}

// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

export class SignalCliPort implements SignalPort {
  // Explicit fields instead of constructor parameter properties: node
  // strip-types (strip-only mode) rejects parameter properties
  // (tests/strip-types-compat.test.ts).
  private readonly config: SignalConfig;
  private readonly connectionFactory: SignalRpcConnectionFactory;

  private connection: SignalRpcConnection | null = null;

  constructor(
    config: SignalConfig,
    connectionFactory: SignalRpcConnectionFactory = createSocketConnection,
  ) {
    this.config = config;
    this.connectionFactory = connectionFactory;
  }

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
    // forward attachments as the signal-cli `attachments` array.
    // Each entry is a data URI per the signal-cli man page §send:
    //   data:<MIME>;filename=<FILENAME>;base64,<BASE64 ENCODED DATA>
    if (args.attachments && args.attachments.length > 0) {
      params.attachments = args.attachments.slice();
    }
    // edit-timestamp forwards to signal-cli's `editTimestamp` param.
    // When present, signal-cli treats this send as an edit of the prior
    // outbound message identified by the timestamp.
    if (args.editTimestamp !== undefined) {
      params.editTimestamp = args.editTimestamp;
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
    }
    // Sort BEFORE capping: the contract is ascending-by-timestamp, so the
    // pageSize cap must keep the OLDEST envelopes, not the first-arriving.
    out.sort((a, b) => a.timestamp - b.timestamp);
    return pageSize !== undefined ? out.slice(0, pageSize) : out;
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

  /**
   * fetch metadata for a single Signal V2 group via signal-cli's
   * `listGroups` RPC. signal-cli returns an array of objects with shape:
   *   { id: string, name: string, members: string[], ... }
   * We filter to the requested groupId. When the group is unknown (or this
   * linked-device session hasn't seen it), the RPC returns an empty array —
   * we surface that as a typed error the adapter maps upstream.
   */
  async getGroupMetadata(groupId: string): Promise<SignalGroupMetadata> {
    if (!groupId) {
      throw Object.assign(new Error('getGroupMetadata: groupId is required'), { code: 'BadArgs' }) satisfies SignalPortError;
    }
    const result = await this.conn().request('listGroups', {
      detailed: true,
    }) as Array<{
      id?: string;
      name?: string;
      members?: Array<string | { number?: string; uuid?: string }>;
    }> | undefined;
    const groups = (result ?? []).filter((g) => g.id === groupId);
    if (groups.length === 0) {
      throw Object.assign(
        new Error(`getGroupMetadata: group ${groupId} not found in this session`),
        { code: 'GroupNotFound' },
      ) satisfies SignalPortError;
    }
    const g = groups[0];
    // Normalize members: signal-cli emits each member as either a bare string
    // (UUID or E.164) or an object with { number, uuid }. We accept both.
    const members: string[] = [];
    for (const m of g.members ?? []) {
      if (typeof m === 'string') {
        members.push(m);
      } else if (m && typeof m === 'object') {
        const id = m.uuid ?? m.number;
        if (typeof id === 'string') members.push(id);
      }
    }
    return {
      id: g.id ?? groupId,
      name: g.name ?? '',
      members,
    };
  }
}
