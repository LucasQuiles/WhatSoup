// tests/transport/imessage/imsg-port.test.ts
import net, { type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  createSocketConnection,
  ImsgPort,
  type ImsgRpcConnection,
} from '../../../src/transport/imessage/imsg-port.ts';
import { DEFAULT_IMESSAGE, type ImessageConfig } from '../../../src/transport/imessage/types.ts';
import type { ImessagePortError } from '../../../src/transport/imessage/port.ts';

class MockRpcConnection implements ImsgRpcConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCalls = 0;
  private readonly handlers = new Map<string, (params?: Record<string, unknown>) => unknown>();
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();

  on(method: string, handler: (params?: Record<string, unknown>) => unknown): this {
    this.handlers.set(method, handler);
    return this;
  }

  failWith(method: string, err: ImessagePortError): this {
    this.handlers.set(method, () => { throw err; });
    return this;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) throw Object.assign(new Error(`no mock handler for ${method}`), { code: 'Unmocked' });
    return handler(params);
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  emitNotification(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) handler(method, params);
  }

  close(): void { this.closeCalls += 1; }
}

function makeConfig(overrides: Partial<ImessageConfig> = {}): ImessageConfig {
  return {
    ...DEFAULT_IMESSAGE,
    account: 'test',
    backend: 'imsg',
    imsgSocketPath: '/tmp/imsg-test.sock',
    sender: 'me@users.noreply.github.com',
    ...overrides,
  };
}

function makePort(overrides: Partial<ImessageConfig> = {}) {
  const mock = new MockRpcConnection();
  const port = new ImsgPort(makeConfig(overrides), () => mock);
  return { port, mock };
}

describe('ImsgPort — verifyCredentials', () => {
  it('probes chats.list with limit 1', async () => {
    const { port, mock } = makePort();
    mock.on('chats.list', () => ({ chats: [] }));
    await expect(port.verifyCredentials()).resolves.toBeUndefined();
    expect(mock.calls).toEqual([{ method: 'chats.list', params: { limit: 1 } }]);
  });

  it('propagates a daemon failure', async () => {
    const { port, mock } = makePort();
    mock.failWith('chats.list', { message: 'imsg socket error: ECONNREFUSED', code: 'SocketError', status: 503 });
    await expect(port.verifyCredentials()).rejects.toMatchObject({ code: 'SocketError', status: 503 });
  });

  it('opens the connection lazily', async () => {
    let factoryCalls = 0;
    const mock = new MockRpcConnection();
    mock.on('chats.list', () => ({}));
    const port = new ImsgPort(makeConfig(), () => { factoryCalls += 1; return mock; });
    expect(factoryCalls).toBe(0);
    await port.verifyCredentials();
    await port.verifyCredentials();
    expect(factoryCalls).toBe(1);
  });
});

describe('ImsgPort — send', () => {
  it('sends with to/text and returns the guid', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({ guid: 'g-1' }));
    const result = await port.send({ recipient: 'friend@users.noreply.github.com', body: 'hi' });
    expect(result.guid).toBe('g-1');
    expect(mock.calls[0]).toEqual({ method: 'send', params: { to: 'friend@users.noreply.github.com', text: 'hi' } });
  });

  it('falls back to a stringified numeric id when guid is absent', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({ id: 42 }));
    const result = await port.send({ recipient: '+15559990000', body: 'x' });
    expect(result.guid).toBe('42');
  });

  it('rejects subject before calling the upstream send method', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({ guid: 'g' }));
    await expect(port.send({ recipient: 'a@users.noreply.github.com', body: 'x', subject: 'S' }))
      .rejects.toMatchObject({ code: 'UnsupportedParameter', status: 400 });
    expect(mock.calls).toEqual([]);
  });

  it('marks an accepted send without an identifier as ambiguous', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({ ok: true }));
    await expect(port.send({ recipient: 'a@users.noreply.github.com', body: 'x' }))
      .rejects.toMatchObject({ code: 'SendAcceptedWithoutId', phase: 'ack_received' });
  });
});

describe('ImsgPort — listInboundSince', () => {
  const rec = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    chat_id: 42,
    chat_identifier: 'friend@users.noreply.github.com',
    chat_guid: 'iMessage;-;friend@users.noreply.github.com',
    participants: ['friend@users.noreply.github.com'],
    is_group: false,
    guid: 'g-1',
    sender: 'friend@users.noreply.github.com',
    text: 'hello',
    is_from_me: false,
    created_at: '2026-07-22T12:00:01.000Z',
    ...overrides,
  });

  function bootstrap(mock: MockRpcConnection, messages: readonly Record<string, unknown>[]): void {
    let historyCall = 0;
    mock.on('chats.list', () => ({
      chats: [{
        id: 42,
        identifier: 'friend@users.noreply.github.com',
        guid: 'iMessage;-;friend@users.noreply.github.com',
        participants: ['friend@users.noreply.github.com'],
      }],
    }));
    mock.on('messages.history', () => {
      historyCall += 1;
      if (historyCall === 1) {
        const newest = messages.reduce<Record<string, unknown> | undefined>((current, message) =>
          current === undefined || Number(message.id) > Number(current.id) ? message : current, undefined);
        return { messages: newest === undefined ? [] : [newest] };
      }
      return { messages: [...messages] };
    });
    mock.on('watch.subscribe', () => ({ subscription: 1 }));
  }

  it('bootstraps with chat-scoped ISO history and normalizes the upstream schema', async () => {
    const { port, mock } = makePort();
    bootstrap(mock, [rec()]);
    const since = new Date('2026-07-22T12:00:00.000Z');
    const page = await port.listInboundSince(since);

    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      guid: 'g-1',
      from: 'friend@users.noreply.github.com',
      to: 'me@users.noreply.github.com',
      body: 'hello',
      fromMe: false,
      kind: 'text',
      timestamp: since.getTime() + 1000,
    });
    expect(mock.calls).toEqual([
      { method: 'chats.list', params: { limit: 1001 } },
      { method: 'messages.history', params: { chat_id: 42, limit: 1 } },
      { method: 'watch.subscribe', params: { since_rowid: 1, include_reactions: false } },
      { method: 'chats.list', params: { limit: 1001 } },
      { method: 'messages.history', params: { chat_id: 42, limit: 1001, start: since.toISOString() } },
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toMatch(/^imsg1:/);
  });

  it('buffers a watch notification that races ahead of the subscribe response', async () => {
    const { port, mock } = makePort();
    bootstrap(mock, []);
    mock.on('watch.subscribe', () => {
      mock.emitNotification('message', { subscription: 1, message: rec({ id: 2, guid: 'raced' }) });
      return { subscription: 1 };
    });

    const page = await port.listInboundSince(new Date(0));

    expect(page.records.map((message) => message.guid)).toEqual(['raced']);
  });

  it('restarts bootstrap after post-subscribe history failure', async () => {
    const { port, mock } = makePort();
    const message = rec({ id: 7, guid: 'recovered-history' });
    let historyCall = 0;
    mock.on('chats.list', () => ({ chats: [{ id: 42 }] }));
    mock.on('watch.subscribe', () => ({ subscription: historyCall }));
    mock.on('messages.history', () => {
      historyCall += 1;
      if (historyCall === 2) {
        throw {
          message: 'injected post-subscribe history failure',
          code: 'MalformedResponse',
          status: 502,
        } satisfies ImessagePortError;
      }
      return { messages: [message] };
    });

    await expect(port.listInboundSince(new Date(0))).rejects.toMatchObject({
      code: 'MalformedResponse',
    });
    const callsAfterFailure = mock.calls.length;

    const recovered = await port.listInboundSince(new Date(0));

    expect(mock.closeCalls).toBe(1);
    expect(mock.calls.slice(callsAfterFailure).map(({ method }) => method)).toEqual([
      'chats.list',
      'messages.history',
      'watch.subscribe',
      'chats.list',
      'messages.history',
    ]);
    expect(recovered.records.map(({ guid }) => guid)).toEqual(['recovered-history']);
  });

  it('fails closed on malformed params for a known watch notification', async () => {
    const { port, mock } = makePort();
    bootstrap(mock, []);
    mock.on('watch.subscribe', () => {
      mock.emitNotification('message', null);
      return { subscription: 1 };
    });

    await expect(port.listInboundSince(new Date(0))).rejects.toMatchObject({
      code: 'MalformedResponse',
    });
    expect(mock.closeCalls).toBe(1);
  });

  it.each([
    ['message', { subscription: '1', message: rec({ id: 2, guid: 'string-subscription' }) }],
    ['message', { subscription: 0, message: rec({ id: 3, guid: 'zero-subscription' }) }],
    ['error', null],
    ['error', { subscription: -1 }],
  ] as const)('fails closed on malformed %s subscription context', async (method, params) => {
    const { port, mock } = makePort();
    bootstrap(mock, []);
    mock.on('watch.subscribe', () => {
      mock.emitNotification(method, params);
      return { subscription: 1 };
    });

    await expect(port.listInboundSince(new Date(0))).rejects.toMatchObject({
      code: 'MalformedResponse',
    });
    expect(mock.closeCalls).toBe(1);
  });

  it('ignores malformed unknown notifications and valid notifications for another subscription', async () => {
    const { port, mock } = makePort();
    bootstrap(mock, []);
    mock.on('watch.subscribe', () => {
      mock.emitNotification('typing', null);
      mock.emitNotification('message', {
        subscription: 2,
        message: rec({ id: 4, guid: 'foreign-subscription' }),
      });
      return { subscription: 1 };
    });

    const page = await port.listInboundSince(new Date(0));

    expect(page.records).toEqual([]);
    expect(mock.closeCalls).toBe(0);
  });

  it('resubscribes from the exclusive rowid cursor after a connection reset', async () => {
    const { port, mock } = makePort();
    bootstrap(mock, [rec({ id: 7, guid: 'g-7' })]);
    const first = await port.listInboundSince(new Date(0));
    port.resetConnection();
    mock.on('watch.subscribe', () => ({ subscription: 2 }));

    await port.listInboundSince(new Date(0), 100, first.cursor);

    expect(mock.calls.at(-1)).toEqual({
      method: 'watch.subscribe',
      params: { since_rowid: 7, include_reactions: false },
    });
  });

  it('replays a page until its cursor is committed and prunes it afterward', async () => {
    const { port, mock } = makePort();
    bootstrap(mock, [rec({ id: 7, guid: 'g-7' })]);

    const first = await port.listInboundSince(new Date(0), 1);
    const retried = await port.listInboundSince(new Date(0), 1, null);
    const committed = await port.listInboundSince(new Date(0), 1, first.cursor);

    expect(first.records.map((message) => message.guid)).toEqual(['g-7']);
    expect(retried.records.map((message) => message.guid)).toEqual(['g-7']);
    expect(committed.records).toEqual([]);
  });

  it('retains an uncommitted page across a connection reset', async () => {
    const { port, mock } = makePort();
    bootstrap(mock, []);
    const baseline = await port.listInboundSince(new Date(0), 1);
    mock.emitNotification('message', {
      subscription: 1,
      message: rec({ id: 7, guid: 'g-7' }),
    });
    const first = await port.listInboundSince(new Date(0), 1, baseline.cursor);
    port.resetConnection();
    mock.on('watch.subscribe', () => ({ subscription: 2 }));

    const retried = await port.listInboundSince(new Date(0), 1, baseline.cursor);

    expect(first.records.map((message) => message.guid)).toEqual(['g-7']);
    expect(retried.records.map((message) => message.guid)).toEqual(['g-7']);
  });

  it('fails closed on a malformed required upstream field', async () => {
    const { port, mock } = makePort();
    bootstrap(mock, [rec({ created_at: 'not-an-iso-date' })]);

    await expect(port.listInboundSince(new Date(0))).rejects.toMatchObject({
      code: 'MalformedResponse',
    });
  });

  it('rejects invalid pageSize with RangeError', async () => {
    const { port } = makePort();
    await expect(port.listInboundSince(new Date(0), 0)).rejects.toThrow(RangeError);
    await expect(port.listInboundSince(new Date(0), 1001)).rejects.toThrow(RangeError);
  });
});

describe('ImsgPort — tapback / read / typing bridge methods', () => {
  it('forwards reactions to tapback with the upstream parameter names', async () => {
    const { port, mock } = makePort();
    mock.on('tapback', () => ({}));
    await port.sendReaction({ targetGuid: 'g-1', conversation: 'iMessage;+;chatG', emoji: '👍', remove: false });
    expect(mock.calls[0]).toEqual({
      method: 'tapback',
      params: { chat_guid: 'iMessage;+;chatG', message_guid: 'g-1', reaction: '👍', remove: false },
    });
  });

  it('marks a direct conversation read using a direct target', async () => {
    const { port, mock } = makePort();
    mock.on('read', () => ({}));
    await port.sendReadReceipts({ conversation: 'friend@users.noreply.github.com', guids: ['g-1', 'g-2'] });
    expect(mock.calls[0]).toEqual({
      method: 'read',
      params: { to: 'friend@users.noreply.github.com' },
    });
  });

  it('forwards typing state', async () => {
    const { port, mock } = makePort();
    mock.on('typing', () => ({}));
    await port.sendTypingIndicator({ conversation: 'friend@users.noreply.github.com', composing: true });
    expect(mock.calls[0]).toEqual({
      method: 'typing',
      params: { to: 'friend@users.noreply.github.com', typing: true },
    });
  });

  it('surfaces method-not-found as UnsupportedMethod (501)', async () => {
    const { port, mock } = makePort();
    mock.failWith('typing', { message: 'method not found', code: 'UnsupportedMethod', status: 501 });
    await expect(port.sendTypingIndicator({ conversation: 'a@users.noreply.github.com', composing: true }))
      .rejects.toMatchObject({ code: 'UnsupportedMethod', status: 501 });
  });
});

describe('ImsgPort — dispose', () => {
  it('closes the connection idempotently', async () => {
    const { port, mock } = makePort();
    mock.on('chats.list', () => ({}));
    await port.verifyCredentials();
    port.dispose();
    port.dispose();
    expect(mock.closeCalls).toBe(1);
  });

  it('empties the in-memory inboundQueue Map on dispose', async () => {
    const { port, mock } = makePort();
    mock.on('chats.list', () => ({
      chats: [{
        id: 42,
        identifier: 'friend@users.noreply.github.com',
        guid: 'iMessage;-;friend@users.noreply.github.com',
        participants: ['friend@users.noreply.github.com'],
      }],
    }));
    mock.on('messages.history', () => ({
      messages: [{
        id: 1,
        chat_id: 42,
        chat_identifier: 'friend@users.noreply.github.com',
        chat_guid: 'iMessage;-;friend@users.noreply.github.com',
        participants: ['friend@users.noreply.github.com'],
        is_group: false,
        guid: 'g-1',
        sender: 'friend@users.noreply.github.com',
        text: 'hello',
        is_from_me: false,
        created_at: '2026-07-22T12:00:01.000Z',
      }],
    }));
    mock.on('watch.subscribe', () => ({ subscription: 1 }));

    // Bootstraps and enqueues one record into the private inboundQueue Map;
    // listInboundSince only evicts entries once a later call commits their
    // cursor, so this record is still resident in the Map after the call.
    await port.listInboundSince(new Date('2026-07-22T12:00:00.000Z'));

    const inboundQueue = (port as unknown as { inboundQueue: Map<number, unknown> }).inboundQueue;
    expect(inboundQueue.size).toBeGreaterThan(0);

    port.dispose();

    expect(inboundQueue.size).toBe(0);
  });
});

interface RpcFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

describe('imsg UNIX socket lifecycle', () => {
  let dir: string;
  let socketPath: string;
  const servers = new Set<Server>();
  const sockets = new Set<Socket>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whatsoup-imsg-rpc-'));
    socketPath = join(dir, 'imsg.sock');
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })));
    rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(onFrame: (frame: RpcFrame, socket: Socket) => void): Promise<Server> {
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line !== '') onFrame(JSON.parse(line) as RpcFrame, socket);
          newline = buffer.indexOf('\n');
        }
      });
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    return server;
  }

  async function stopServer(server: Server): Promise<void> {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.delete(server);
  }

  it('preserves UTF-8 when a socket chunk splits a multibyte code point', async () => {
    await startServer((frame, socket) => {
      const response = Buffer.from(`${JSON.stringify({
        jsonrpc: '2.0',
        id: frame.id,
        result: { message: 'x😀y' },
      })}\n`);
      const emojiOffset = response.indexOf(Buffer.from('😀'));
      socket.write(response.subarray(0, emojiOffset + 2));
      setImmediate(() => socket.write(response.subarray(emojiOffset + 2)));
    });
    const connection = createSocketConnection(makeConfig({ imsgSocketPath: socketPath }));

    await expect(connection.request('unicode')).resolves.toEqual({ message: 'x😀y' });
    connection.close();
  });

  it('delivers JSON-RPC notifications that omit request ids', async () => {
    await startServer((frame, socket) => {
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        method: 'message',
        params: { subscription: 1, message: { id: 7 } },
      })}\n`);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { subscription: 1 } })}\n`);
    });
    const connection = createSocketConnection(makeConfig({ imsgSocketPath: socketPath }));
    const notifications: Array<{ method: string; params: unknown }> = [];
    connection.onNotification((method, params) => notifications.push({ method, params }));

    await connection.request('watch.subscribe');

    expect(notifications).toEqual([{ method: 'message', params: { subscription: 1, message: { id: 7 } } }]);
    connection.close();
  });

  it('rejects every concurrent pending request promptly when the peer ends', async () => {
    await startServer((_frame, socket) => socket.end());
    const connection = createSocketConnection(makeConfig({ imsgSocketPath: socketPath }));

    const settled = await Promise.allSettled([
      connection.request('one'),
      connection.request('two'),
    ]);

    expect(settled).toHaveLength(2);
    expect(settled.every((result) =>
      result.status === 'rejected' && (result.reason as ImessagePortError).code === 'Closed'))
      .toBe(true);
  });

  it('rejects every pending request when the peer closes without an orderly end', async () => {
    await startServer((_frame, socket) => socket.destroy());
    const connection = createSocketConnection(makeConfig({ imsgSocketPath: socketPath }));

    const settled = await Promise.allSettled([
      connection.request('one'),
      connection.request('two'),
    ]);

    expect(settled).toHaveLength(2);
    expect(settled.every((result) =>
      result.status === 'rejected' && (result.reason as ImessagePortError).code === 'Closed'))
      .toBe(true);
  });

  it('marks a peer close after the request write as an ambiguous provider call', async () => {
    await startServer((_frame, socket) => socket.end());
    const connection = createSocketConnection(makeConfig({ imsgSocketPath: socketPath }));

    await expect(connection.request('send', { to: '+15551230008', text: 'hi' }))
      .rejects.toMatchObject({ code: 'RequestAbortedAfterWrite', phase: 'provider_call_started' });
  });

  it('reconnects the same port after daemon shutdown and restart', async () => {
    const first = await startServer((_frame, socket) => socket.end());
    const port = new ImsgPort(makeConfig({ imsgSocketPath: socketPath }));

    await expect(port.verifyCredentials()).rejects.toMatchObject({ code: 'Closed' });
    await stopServer(first);
    await startServer((frame, socket) => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { chats: [] } })}\n`);
    });

    await expect(port.verifyCredentials()).resolves.toBeUndefined();
    port.resetConnection();
  });

  it('resetConnection is idempotent and the next call creates one fresh socket', async () => {
    let connections = 0;
    const server = await startServer((frame, socket) => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { chats: [] } })}\n`);
    });
    server.on('connection', () => { connections += 1; });
    const port = new ImsgPort(makeConfig({ imsgSocketPath: socketPath }));

    await port.verifyCredentials();
    port.resetConnection();
    port.resetConnection();
    await port.verifyCredentials();

    expect(connections).toBe(2);
    port.dispose();
  });
});
