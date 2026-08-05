// src/transport/imessage/imsg-port.ts
// Concrete ImessagePort against the macOS-native `imsg rpc` JSON-RPC
// interface, reached through WhatSoup's local NDJSON-over-UNIX-socket relay.
//
// Upstream imsg reads the local chat.db and sends via the macOS Messages
// framework. Its JSON-RPC surface:
//   foundational: chats.list, messages.history, watch.subscribe,
//                 watch.unsubscribe, send
//   IMCore-gated: tapback, typing, read
//
// Capability policy (v1, honest degradation):
// - verifyCredentials → chats.list (limit 1) — proves relay + chat.db.
// - send → send.
// - listInboundSince → messages.history.
// - sendReaction / sendReadReceipts / sendTypingIndicator → forwarded to the
//   IMCore-gated methods; a provider that lacks them answers with a
//   JSON-RPC method-not-found error, which the port surfaces as
//   ImessagePortError{ code: 'UnsupportedMethod', status: 501 }.
//
// The RPC seam is injectable (ImsgRpcConnection) so tests run without
// provider processes or sockets — the same pattern as the signal-cli port.

import net from 'node:net';
import type { ImessageConfig } from './types.ts';
import type {
  ImessagePort,
  ImessagePortError,
  InboundImessage,
  InboundImessagePage,
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
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  close(): void;
}

export type ImsgRpcConnectionFactory = (
  config: ImessageConfig,
  onTerminal?: () => void,
) => ImsgRpcConnection;

// ---------------------------------------------------------------------------
// NDJSON-over-socket connection (production path)
// ---------------------------------------------------------------------------

const RPC_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  readonly method: string;
  resolve: (value: unknown) => void;
  reject: (err: ImessagePortError) => void;
  timer: NodeJS.Timeout;
  written: boolean;
}

export function createSocketConnection(
  config: ImessageConfig,
  onTerminal?: () => void,
): ImsgRpcConnection {
  const socket = net.createConnection(config.imsgSocketPath ?? '/tmp/imsg.sock');

  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const notificationHandlers = new Set<(method: string, params: unknown) => void>();
  let terminalError: ImessagePortError | null = null;

  const terminate = (error: ImessagePortError): void => {
    if (terminalError !== null) return;
    terminalError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(request.method === 'send' && request.written
        ? {
          ...error,
          code: 'RequestAbortedAfterWrite',
          phase: 'provider_call_started',
        }
        : error);
    }
    pending.clear();
    onTerminal?.();
  };

  socket.on('error', (err) => {
    terminate({
      message: `imsg socket error: ${err.message}`,
      code: 'SocketError',
      status: 503,
    });
  });
  socket.on('end', () => {
    terminate({
      message: 'imsg connection ended by peer',
      code: 'Closed',
      status: 503,
    });
  });
  socket.on('close', () => {
    terminate({
      message: 'imsg connection closed',
      code: 'Closed',
      status: 503,
    });
  });

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === '') continue;
      let frame: {
        id?: number;
        method?: unknown;
        params?: unknown;
        result?: unknown;
        error?: { code?: unknown; message?: unknown };
      };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        continue;
      }
      const id = frame.id;
      if (id === undefined) {
        if (typeof frame.method === 'string') {
          for (const handler of notificationHandlers) handler(frame.method, frame.params);
        }
        continue;
      }
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
      if (terminalError) return Promise.reject(terminalError);
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const request = pending.get(id);
          pending.delete(id);
          const timeout = {
            message: `imsg rpc timeout (${method})`,
            code: 'Timeout',
            status: 504,
          } satisfies ImessagePortError;
          const error: ImessagePortError = method === 'send' && request?.written === true
            ? { ...timeout, code: 'RequestAbortedAfterWrite', phase: 'provider_call_started' }
            : timeout;
          reject(error);
          terminate(timeout);
          socket.destroy();
        }, RPC_REQUEST_TIMEOUT_MS);
        pending.set(id, { method, resolve, reject, timer, written: false });
        const frame = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {}, id }) + '\n';
        socket.write(frame, (err) => {
          if (err) {
            terminate({
              message: `imsg socket write failed: ${err.message}`,
              code: 'SocketError',
              status: 503,
            });
            socket.destroy();
            return;
          }
          const request = pending.get(id);
          if (request !== undefined) request.written = true;
        });
      });
    },
    onNotification(handler: (method: string, params: unknown) => void): () => void {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    close(): void {
      terminate({ message: 'imsg connection closed', code: 'Closed', status: 503 });
      socket.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Message normalization
// ---------------------------------------------------------------------------

interface ImsgHistoryRecord {
  id?: unknown;
  chat_id?: unknown;
  chat_identifier?: unknown;
  chat_guid?: unknown;
  participants?: unknown;
  is_group?: unknown;
  guid?: unknown;
  sender?: unknown;
  text?: unknown;
  is_from_me?: unknown;
  created_at?: unknown;
  /** ISO 8601 date the peer read this outbound message (null/absent if unread). */
  date_read?: unknown;
}

interface ImsgChatRecord {
  id?: unknown;
}

interface ImsgCursorState {
  readonly version: 1;
  readonly rowId: number;
}

const IMSG_CURSOR_PREFIX = 'imsg1:';
const IMSG_MAX_PAGE_SIZE = 1000;
const IMSG_MAX_CHATS = 1000;
const IMSG_MAX_HISTORY_PER_CHAT = 1000;
const IMSG_MAX_NOTIFICATION_QUEUE = 5000;

function imsgError(
  message: string,
  code: string,
  status: number,
): ImessagePortError {
  return { message, code, status };
}

function encodeImsgCursor(rowId: number): string {
  return IMSG_CURSOR_PREFIX + Buffer.from(JSON.stringify({ version: 1, rowId }), 'utf8').toString('base64url');
}

function decodeImsgCursor(cursor: string): ImsgCursorState {
  if (!cursor.startsWith(IMSG_CURSOR_PREFIX)) {
    throw imsgError('invalid imsg inbound cursor', 'BadCursor', 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(IMSG_CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw imsgError('invalid imsg inbound cursor', 'BadCursor', 400);
  }
  const state = parsed as Partial<ImsgCursorState> | null;
  if (state === null
    || state.version !== 1
    || !Number.isSafeInteger(state.rowId)
    || (state.rowId as number) < 0) {
    throw imsgError('invalid imsg inbound cursor', 'BadCursor', 400);
  }
  return { version: 1, rowId: state.rowId as number };
}

function normalizeRecord(
  rec: ImsgHistoryRecord,
  ownSender: string,
): { rowId: number; message: InboundImessage } {
  const rowId = rec.id;
  const chatId = rec.chat_id;
  const timestamp = typeof rec.created_at === 'string' ? Date.parse(rec.created_at) : Number.NaN;
  const participants = rec.participants;
  if (!Number.isSafeInteger(rowId)
    || (rowId as number) <= 0
    || !Number.isSafeInteger(chatId)
    || (chatId as number) <= 0
    || typeof rec.guid !== 'string'
    || rec.guid === ''
    || typeof rec.chat_identifier !== 'string'
    || typeof rec.chat_guid !== 'string'
    || !Array.isArray(participants)
    || !participants.every((participant) => typeof participant === 'string')
    || typeof rec.is_group !== 'boolean'
    || typeof rec.is_from_me !== 'boolean'
    || typeof rec.sender !== 'string'
    || !Number.isFinite(timestamp)) {
    throw imsgError('imsg returned a malformed message record', 'MalformedResponse', 502);
  }

  const peer = rec.is_from_me
    ? (participants[0] ?? rec.chat_identifier)
    : rec.sender;
  if (peer === '') {
    throw imsgError('imsg returned a message without a peer identity', 'MalformedResponse', 502);
  }
  const chatGuid = rec.is_group ? rec.chat_guid : undefined;
  if (rec.is_group && rec.chat_guid === '') {
    throw imsgError('imsg returned a group message without a chat guid', 'MalformedResponse', 502);
  }
  const body = typeof rec.text === 'string' ? rec.text : null;
  return {
    rowId: rowId as number,
    message: {
      guid: rec.guid,
      from: rec.is_from_me ? ownSender : rec.sender,
      to: rec.is_group ? rec.chat_guid : (rec.is_from_me ? peer : ownSender),
      chatGuid,
      body,
      fromMe: rec.is_from_me,
      kind: body === null ? 'other' : 'text',
      timestamp,
      // Parse date_read (ISO 8601 from imsg RPC relay) → epoch ms. Only
      // set on outbound messages (peer read our message). Inbound date_read
      // is the local user's own read state — not a remote transition.
      dateRead: rec.is_from_me && typeof rec.date_read === 'string' && rec.date_read !== ''
        ? Date.parse(rec.date_read)
        : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

export class ImsgPort implements ImessagePort {
  private connection: ImsgRpcConnection | null = null;
  private removeNotificationHandler: (() => void) | null = null;
  private activeSubscription: number | null = null;
  private readonly earlyNotifications: Array<{ method: string; params: unknown }> = [];
  private readonly inboundQueue = new Map<number, InboundImessage>();
  private notificationFailure: ImessagePortError | null = null;
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
    if (this.connection !== null) return this.connection;
    let created: ImsgRpcConnection;
    created = this.connectionFactory(this.config, () => {
      if (this.connection === created) this.clearConnectionState();
    });
    this.removeNotificationHandler = created.onNotification((method, params) => {
      if (this.connection === created) this.handleNotification(method, params);
    });
    this.connection = created;
    return created;
  }

  private clearConnectionState(): void {
    this.removeNotificationHandler?.();
    this.removeNotificationHandler = null;
    this.connection = null;
    this.activeSubscription = null;
    this.earlyNotifications.length = 0;
    this.notificationFailure = null;
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const connection = this.conn();
    try {
      return await connection.request(method, params);
    } catch (error) {
      const code = (error as ImessagePortError | undefined)?.code;
      if ((code === 'SocketError' || code === 'Closed' || code === 'Timeout')
        && this.connection === connection) {
        this.connection = null;
        connection.close();
      }
      throw error;
    }
  }

  resetConnection(): void {
    const connection = this.connection;
    this.clearConnectionState();
    connection?.close();
  }

  dispose(): void {
    this.resetConnection();
    this.inboundQueue.clear();
  }

  async verifyCredentials(): Promise<void> {
    // chats.list with limit 1 is the lightest call that proves both the
    // relay is reachable AND chat.db is readable.
    await this.request('chats.list', { limit: 1 });
  }

  async send(args: SendImessageArgs): Promise<{ guid: string }> {
    if (args.subject !== undefined) {
      throw {
        message: 'imsg does not support message subjects through the send method',
        code: 'UnsupportedParameter',
        status: 400,
      } satisfies ImessagePortError;
    }
    const params: Record<string, unknown> = args.recipient.startsWith('iMessage;')
      ? { chat_guid: args.recipient, text: args.body }
      : { to: args.recipient, text: args.body };
    const result = await this.request('send', params) as
      | { ok?: unknown; id?: unknown; message_id?: unknown; guid?: unknown }
      | undefined;
    const guid = typeof result?.guid === 'string' && result.guid !== ''
      ? result.guid
      : typeof result?.message_id === 'string' && result.message_id !== ''
        ? result.message_id
        : Number.isSafeInteger(result?.id) ? String(result?.id) : undefined;
    if (guid === undefined || guid === '') {
      throw {
        message: result?.ok === true
          ? 'imsg accepted the send without returning a message id'
          : 'imsg send returned no message id',
        code: result?.ok === true ? 'SendAcceptedWithoutId' : 'MalformedResponse',
        status: result?.ok === true ? 202 : 502,
        phase: result?.ok === true ? 'ack_received' : undefined,
      } satisfies ImessagePortError;
    }
    return { guid };
  }

  async listInboundSince(
    since: Date,
    pageSize?: number,
    cursor: string | null = null,
  ): Promise<InboundImessagePage> {
    if (pageSize !== undefined
      && (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > IMSG_MAX_PAGE_SIZE)) {
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
    }
    const sinceMs = since.getTime();
    if (!Number.isFinite(sinceMs) || sinceMs < 0) {
      throw new RangeError('since must be a valid non-negative date');
    }
    const cursorState = cursor === null ? { version: 1 as const, rowId: 0 } : decodeImsgCursor(cursor);
    if (this.activeSubscription === null) {
      if (cursor === null) {
        try {
          await this.bootstrapInbound(since, cursorState.rowId);
        } catch (error) {
          this.resetConnection();
          throw error;
        }
      } else {
        await this.subscribe(cursorState.rowId);
      }
    }
    if (this.notificationFailure !== null) {
      const failure = this.notificationFailure;
      this.resetConnection();
      throw failure;
    }

    const limit = pageSize ?? 100;
    for (const rowId of this.inboundQueue.keys()) {
      if (rowId <= cursorState.rowId) this.inboundQueue.delete(rowId);
    }
    const available = [...this.inboundQueue.entries()]
      .filter(([rowId]) => rowId > cursorState.rowId)
      .sort(([left], [right]) => left - right);
    const selected = available.slice(0, limit);
    const rowId = selected.length === 0
      ? cursorState.rowId
      : selected[selected.length - 1]![0];
    return {
      records: selected.map(([, message]) => message),
      cursor: encodeImsgCursor(rowId),
      hasMore: available.length > selected.length,
    };
  }

  private async listChats(): Promise<readonly ImsgChatRecord[]> {
    const result = await this.request('chats.list', { limit: IMSG_MAX_CHATS + 1 }) as
      | { chats?: unknown }
      | undefined;
    if (!Array.isArray(result?.chats) || result.chats.length > IMSG_MAX_CHATS) {
      throw imsgError('imsg chat bootstrap exceeded its bounded limit', 'InboundChatLimit', 502);
    }
    for (const chat of result.chats) {
      if (typeof chat !== 'object'
        || chat === null
        || !Number.isSafeInteger((chat as ImsgChatRecord).id)
        || Number((chat as ImsgChatRecord).id) <= 0) {
        throw imsgError('imsg returned a malformed chat record', 'MalformedResponse', 502);
      }
    }
    return result.chats as ImsgChatRecord[];
  }

  private async history(
    chatId: number,
    params: { readonly limit: number; readonly start?: string },
  ): Promise<readonly ImsgHistoryRecord[]> {
    const result = await this.request('messages.history', { chat_id: chatId, ...params }) as
      | { messages?: unknown }
      | undefined;
    if (!Array.isArray(result?.messages)) {
      throw imsgError('imsg history omitted its messages array', 'MalformedResponse', 502);
    }
    return result.messages as ImsgHistoryRecord[];
  }

  private async bootstrapInbound(since: Date, initialRowId: number): Promise<void> {
    const beforeSubscribe = await this.listChats();
    let baselineRowId = initialRowId;
    for (const chat of beforeSubscribe) {
      const newest = await this.history(chat.id as number, { limit: 1 });
      if (newest.length > 0) {
        const normalized = normalizeRecord(newest[0]!, this.config.sender);
        baselineRowId = Math.max(baselineRowId, normalized.rowId);
      }
    }
    await this.subscribe(baselineRowId);

    const afterSubscribe = await this.listChats();
    for (const chat of afterSubscribe) {
      const messages = await this.history(chat.id as number, {
        limit: IMSG_MAX_HISTORY_PER_CHAT + 1,
        start: since.toISOString(),
      });
      if (messages.length > IMSG_MAX_HISTORY_PER_CHAT) {
        throw imsgError('imsg history bootstrap exceeded its bounded limit', 'InboundHistoryLimit', 502);
      }
      for (const message of messages) this.enqueue(message);
    }
  }

  private async subscribe(rowId: number): Promise<void> {
    const result = await this.request('watch.subscribe', {
      since_rowid: rowId,
      include_reactions: false,
    }) as { subscription?: unknown } | undefined;
    const subscription = result?.subscription;
    if (!Number.isSafeInteger(subscription) || Number(subscription) <= 0) {
      throw imsgError('imsg watch returned an invalid subscription id', 'MalformedResponse', 502);
    }
    this.activeSubscription = subscription as number;
    const buffered = this.earlyNotifications.splice(0);
    for (const notification of buffered) this.applyNotification(notification.method, notification.params);
  }

  private enqueue(raw: ImsgHistoryRecord): void {
    const normalized = normalizeRecord(raw, this.config.sender);
    this.inboundQueue.set(normalized.rowId, normalized.message);
    if (this.inboundQueue.size > IMSG_MAX_NOTIFICATION_QUEUE) {
      throw imsgError('imsg notification queue exceeded its bounded limit', 'InboundQueueLimit', 503);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.activeSubscription === null) {
      if (this.earlyNotifications.length >= IMSG_MAX_NOTIFICATION_QUEUE) {
        this.notificationFailure = imsgError(
          'imsg pre-subscription notification queue exceeded its bounded limit',
          'InboundQueueLimit',
          503,
        );
        return;
      }
      this.earlyNotifications.push({ method, params });
      return;
    }
    this.applyNotification(method, params);
  }

  private applyNotification(method: string, params: unknown): void {
    if (method !== 'message' && method !== 'error') return;
    if (typeof params !== 'object' || params === null) {
      this.notificationFailure = imsgError(
        `imsg watch returned malformed ${method} notification params`,
        'MalformedResponse',
        502,
      );
      return;
    }
    const subscription = (params as { subscription?: unknown }).subscription;
    if (!Number.isSafeInteger(subscription) || Number(subscription) <= 0) {
      this.notificationFailure = imsgError(
        `imsg watch returned malformed ${method} subscription`,
        'MalformedResponse',
        502,
      );
      return;
    }
    if (subscription !== this.activeSubscription) return;
    if (method === 'error') {
      this.notificationFailure = imsgError('imsg watch subscription failed', 'WatchError', 503);
      return;
    }
    const message = (params as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null) {
      this.notificationFailure = imsgError('imsg watch returned a malformed message', 'MalformedResponse', 502);
      return;
    }
    try {
      this.enqueue(message as ImsgHistoryRecord);
    } catch (error) {
      this.notificationFailure = error as ImessagePortError;
    }
  }

  async sendReaction(args: ReactImessageArgs): Promise<void> {
    const target = args.conversation.startsWith('iMessage;')
      ? { chat_guid: args.conversation }
      : { chat_identifier: args.conversation };
    await this.request('tapback', {
      ...target,
      message_guid: args.targetGuid,
      reaction: args.emoji,
      remove: args.remove,
    });
  }

  async sendReadReceipts(args: SendReadReceiptArgs): Promise<void> {
    const target = args.conversation.startsWith('iMessage;')
      ? { chat_guid: args.conversation }
      : { to: args.conversation };
    await this.request('read', target);
  }

  async sendTypingIndicator(args: SendTypingArgs): Promise<void> {
    const target = args.conversation.startsWith('iMessage;')
      ? { chat_guid: args.conversation }
      : { to: args.conversation };
    await this.request('typing', {
      ...target,
      typing: args.composing,
    });
  }
}
