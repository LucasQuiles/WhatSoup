// tests/transport/imessage/imsg-port.test.ts
import { describe, it, expect } from 'vitest';
import {
  ImsgPort,
  type ImsgRpcConnection,
} from '../../../src/transport/imessage/imsg-port.ts';
import { DEFAULT_IMESSAGE, type ImessageConfig } from '../../../src/transport/imessage/types.ts';
import type { ImessagePortError } from '../../../src/transport/imessage/port.ts';

class MockRpcConnection implements ImsgRpcConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCalls = 0;
  private readonly handlers = new Map<string, (params?: Record<string, unknown>) => unknown>();

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

  it('falls back to a stringified rowid when guid is absent', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({ rowid: 42 }));
    const result = await port.send({ recipient: '+15559990000', body: 'x' });
    expect(result.guid).toBe('42');
  });

  it('includes subject when provided', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({ guid: 'g' }));
    await port.send({ recipient: 'a@users.noreply.github.com', body: 'x', subject: 'S' });
    expect(mock.calls[0]?.params).toMatchObject({ subject: 'S' });
  });

  it('throws MalformedResponse when no id comes back', async () => {
    const { port, mock } = makePort();
    mock.on('send', () => ({}));
    await expect(port.send({ recipient: 'a@users.noreply.github.com', body: 'x' }))
      .rejects.toMatchObject({ code: 'MalformedResponse' });
  });
});

describe('ImsgPort — listInboundSince', () => {
  const rec = (overrides: Record<string, unknown> = {}) => ({
    guid: 'g-1',
    from: 'friend@users.noreply.github.com',
    to: 'me@users.noreply.github.com',
    text: 'hello',
    is_from_me: false,
    kind: 'text',
    timestamp: 1000,
    ...overrides,
  });

  it('normalizes history records (array form)', async () => {
    const { port, mock } = makePort();
    mock.on('messages.history', () => [rec()]);
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ guid: 'g-1', body: 'hello', fromMe: false, kind: 'text' });
    expect(mock.calls[0]).toEqual({ method: 'messages.history', params: { since: 0, limit: 100 } });
  });

  it('accepts the { messages } wrapper form', async () => {
    const { port, mock } = makePort();
    mock.on('messages.history', () => ({ messages: [rec({ guid: 'g-2' })] }));
    const out = await port.listInboundSince(new Date(0));
    expect(out.map((m) => m.guid)).toEqual(['g-2']);
  });

  it('maps group records via chat_guid and echoes via is_from_me', async () => {
    const { port, mock } = makePort();
    mock.on('messages.history', () => [
      rec({ guid: 'g-3', chat_guid: 'iMessage;+;chatG' }),
      rec({ guid: 'g-4', is_from_me: true }),
    ]);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]).toMatchObject({ guid: 'g-3', chatGuid: 'iMessage;+;chatG' });
    expect(out[1]).toMatchObject({ guid: 'g-4', fromMe: true });
  });

  it('drops old records, keeps the inclusive boundary, sorts ascending, caps oldest', async () => {
    const { port, mock } = makePort();
    mock.on('messages.history', () => [
      rec({ guid: 'g-old', timestamp: 500 }),
      rec({ guid: 'g-c', timestamp: 3000 }),
      rec({ guid: 'g-a', timestamp: 1000 }),
      rec({ guid: 'g-b', timestamp: 2000 }),
    ]);
    const out = await port.listInboundSince(new Date(1000), 2);
    expect(out.map((m) => m.guid)).toEqual(['g-a', 'g-b']);
  });

  it('rejects invalid pageSize with RangeError', async () => {
    const { port, mock } = makePort();
    mock.on('messages.history', () => []);
    await expect(port.listInboundSince(new Date(0), 0)).rejects.toThrow(RangeError);
  });

  it('stringifies numeric rowids when guid is absent', async () => {
    const { port, mock } = makePort();
    mock.on('messages.history', () => [rec({ guid: undefined, rowid: 77 })]);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]?.guid).toBe('77');
  });
});

describe('ImsgPort — react / read-receipt / typing (bridge methods)', () => {
  it('forwards reactions to the react bridge method', async () => {
    const { port, mock } = makePort();
    mock.on('react', () => ({}));
    await port.sendReaction({ targetGuid: 'g-1', conversation: 'iMessage;+;chatG', emoji: '👍', remove: false });
    expect(mock.calls[0]).toEqual({
      method: 'react',
      params: { chat_guid: 'iMessage;+;chatG', target_guid: 'g-1', emoji: '👍', remove: false },
    });
  });

  it('forwards read receipts with the guid list', async () => {
    const { port, mock } = makePort();
    mock.on('read-receipt', () => ({}));
    await port.sendReadReceipts({ conversation: 'friend@users.noreply.github.com', guids: ['g-1', 'g-2'] });
    expect(mock.calls[0]).toEqual({
      method: 'read-receipt',
      params: { chat_guid: 'friend@users.noreply.github.com', guids: ['g-1', 'g-2'] },
    });
  });

  it('forwards typing state', async () => {
    const { port, mock } = makePort();
    mock.on('typing', () => ({}));
    await port.sendTypingIndicator({ conversation: 'friend@users.noreply.github.com', composing: true });
    expect(mock.calls[0]).toEqual({
      method: 'typing',
      params: { chat_guid: 'friend@users.noreply.github.com', composing: true },
    });
  });

  it('surfaces method-not-found as UnsupportedMethod (501) so the adapter can park the extension', async () => {
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
});
