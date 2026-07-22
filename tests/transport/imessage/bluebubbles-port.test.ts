// tests/transport/imessage/bluebubbles-port.test.ts
import { describe, it, expect } from 'vitest';
import {
  BlueBubblesPort,
  type BlueBubblesHttpClient,
  type BlueBubblesHttpRequest,
} from '../../../src/transport/imessage/bluebubbles-port.ts';
import { DEFAULT_IMESSAGE, type ImessageConfig } from '../../../src/transport/imessage/types.ts';
import type { ImessagePortError } from '../../../src/transport/imessage/port.ts';

class MockHttpClient {
  readonly calls: BlueBubblesHttpRequest[] = [];
  private readonly handlers = new Map<string, (req: BlueBubblesHttpRequest) => unknown>();

  on(method: string, path: string, handler: (req: BlueBubblesHttpRequest) => unknown): this {
    this.handlers.set(`${method} ${path}`, handler);
    return this;
  }

  failWith(method: string, path: string, err: ImessagePortError): this {
    this.handlers.set(`${method} ${path}`, () => { throw err; });
    return this;
  }

  client: BlueBubblesHttpClient = async (req) => {
    this.calls.push(req);
    const handler = this.handlers.get(`${req.method} ${req.path}`);
    if (!handler) throw Object.assign(new Error(`unmocked ${req.method} ${req.path}`), { code: 'Unmocked' });
    return handler(req);
  };
}

function makeConfig(overrides: Partial<ImessageConfig> = {}): ImessageConfig {
  return {
    ...DEFAULT_IMESSAGE,
    account: 'test',
    backend: 'bluebubbles',
    bluebubblesUrl: 'https://bb.example.test',
    bluebubblesPassword: 'pw',
    sender: 'me@users.noreply.github.com',
    ...overrides,
  };
}

function makePort(overrides: Partial<ImessageConfig> = {}) {
  const mock = new MockHttpClient();
  const port = new BlueBubblesPort(makeConfig(overrides), mock.client);
  return { port, mock };
}

describe('BlueBubblesPort — verifyCredentials', () => {
  it('pings the server', async () => {
    const { port, mock } = makePort();
    mock.on('GET', '/ping', () => ({ status: 'pong' }));
    await expect(port.verifyCredentials()).resolves.toBeUndefined();
    expect(mock.calls).toEqual([{ method: 'GET', path: '/ping' }]);
  });

  it('propagates an auth failure', async () => {
    const { port, mock } = makePort();
    mock.failWith('GET', '/ping', { message: 'HTTP 401', code: 'HttpError', status: 401 });
    await expect(port.verifyCredentials()).rejects.toMatchObject({ status: 401 });
  });
});

describe('BlueBubblesPort — send', () => {
  it('sends to a 1:1 recipient by constructing the DM chat guid', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/text', () => ({ data: { guid: 'g-1' } }));
    const result = await port.send({ recipient: 'friend@users.noreply.github.com', body: 'hi' });
    expect(result.guid).toBe('g-1');
    expect(mock.calls[0]?.body).toEqual({
      chatGuid: 'iMessage;-;friend@users.noreply.github.com',
      message: 'hi',
    });
  });

  it('passes a group chat GUID through verbatim', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/text', () => ({ data: { guid: 'g-2' } }));
    await port.send({ recipient: 'iMessage;+;chatABC123', body: 'group hi' });
    expect(mock.calls[0]?.body).toMatchObject({ chatGuid: 'iMessage;+;chatABC123' });
  });

  it('includes subject when provided', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/text', () => ({ data: { guid: 'g-3' } }));
    await port.send({ recipient: '+15559990000', body: 'x', subject: 'Subj' });
    expect(mock.calls[0]?.body).toMatchObject({ subject: 'Subj' });
  });

  it('throws MalformedResponse when the server returns no guid', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/text', () => ({ data: {} }));
    await expect(port.send({ recipient: 'a@users.noreply.github.com', body: 'x' }))
      .rejects.toMatchObject({ code: 'MalformedResponse' });
  });
});

describe('BlueBubblesPort — listInboundSince', () => {
  const bbMsg = (overrides: Record<string, unknown> = {}) => ({
    guid: 'g-1',
    text: 'hello',
    isFromMe: false,
    handle: { address: 'friend@users.noreply.github.com' },
    dateCreated: 1000,
    ...overrides,
  });

  it('normalizes inbound text messages (fromMe=false)', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/query', () => ({ data: [bbMsg()] }));
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      guid: 'g-1',
      from: 'friend@users.noreply.github.com',
      body: 'hello',
      fromMe: false,
      kind: 'text',
      timestamp: 1000,
    });
    expect(mock.calls[0]?.body).toMatchObject({ sort: 'ASC', limit: 100, offset: 0 });
  });

  it('marks echoes fromMe=true and flags group messages via chat guid', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/query', () => ({
      data: [
        bbMsg({ guid: 'g-2', isFromMe: true, handle: null }),
        bbMsg({ guid: 'g-3', chats: [{ guid: 'iMessage;+;chatG' }] }),
      ],
    }));
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]).toMatchObject({ guid: 'g-2', fromMe: true });
    expect(out[1]).toMatchObject({ guid: 'g-3', chatGuid: 'iMessage;+;chatG' });
  });

  it('drops messages older than `since` but keeps the inclusive boundary', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/query', () => ({
      data: [
        bbMsg({ guid: 'g-old', dateCreated: 500 }),
        bbMsg({ guid: 'g-eq', dateCreated: 1000 }),
        bbMsg({ guid: 'g-new', dateCreated: 1500 }),
      ],
    }));
    const out = await port.listInboundSince(new Date(1000));
    expect(out.map((m) => m.guid)).toEqual(['g-eq', 'g-new']);
  });

  it('sorts ascending by timestamp and caps at pageSize', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/query', () => ({
      data: [
        bbMsg({ guid: 'g3', dateCreated: 3000 }),
        bbMsg({ guid: 'g1', dateCreated: 1000 }),
        bbMsg({ guid: 'g2', dateCreated: 2000 }),
      ],
    }));
    const out = await port.listInboundSince(new Date(0), 2);
    expect(out.map((m) => m.guid)).toEqual(['g1', 'g2']);
  });

  it('forwards a stable continuation offset to the provider query', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/query', () => ({ data: [bbMsg({ guid: 'continued' })] }));

    await port.listInboundSince(new Date(1000), 500, 500);

    expect(mock.calls[0]?.body).toMatchObject({ after: 1000, limit: 500, offset: 500 });
  });

  it('rejects invalid pageSize with RangeError', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/query', () => ({ data: [] }));
    await expect(port.listInboundSince(new Date(0), 0)).rejects.toThrow(RangeError);
    await expect(port.listInboundSince(new Date(0), 1.5)).rejects.toThrow(RangeError);
    await expect(port.listInboundSince(new Date(0), 1, -1)).rejects.toThrow(RangeError);
    await expect(port.listInboundSince(new Date(0), 1, 1.5)).rejects.toThrow(RangeError);
  });

  it('drops records with no guid or non-text body shape', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/query', () => ({
      data: [
        { text: 'no guid' },
        bbMsg({ guid: 'g-null-body', text: null }),
        bbMsg({ guid: 'g-ok' }),
      ],
    }));
    const out = await port.listInboundSince(new Date(0));
    expect(out.map((m) => m.guid)).toEqual(['g-null-body', 'g-ok']);
    expect(out[0]).toMatchObject({ body: null, kind: 'other' });
  });
});

describe('BlueBubblesPort — sendReaction', () => {
  it('maps tapback emojis to reactionType (1:1)', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/react', () => ({}));
    await port.sendReaction({ targetGuid: 'g-1', conversation: 'friend@users.noreply.github.com', emoji: '❤️', remove: false });
    expect(mock.calls[0]?.body).toEqual({
      chatGuid: 'iMessage;-;friend@users.noreply.github.com',
      selectedMessageGuid: 'g-1',
      reactionType: 'love',
    });
  });

  it('prefixes removal with a dash and routes groups via chatGuid', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/message/react', () => ({}));
    await port.sendReaction({ targetGuid: 'g-2', conversation: 'iMessage;+;chatG', emoji: '👍', remove: true });
    expect(mock.calls[0]?.body).toMatchObject({ chatGuid: 'iMessage;+;chatG', reactionType: '-like' });
  });

  it('rejects unsupported emojis', async () => {
    const { port } = makePort();
    await expect(port.sendReaction({ targetGuid: 'g', conversation: 'a@users.noreply.github.com', emoji: '🔥', remove: false }))
      .rejects.toMatchObject({ code: 'BadArgs' });
  });
});

describe('BlueBubblesPort — sendReadReceipts + sendTypingIndicator', () => {
  it('marks a conversation read with the message guids', async () => {
    const { port, mock } = makePort();
    mock.on('POST', '/chat/iMessage%3B-%3Bfriend%40users.noreply.github.com/read', () => ({}));
    await port.sendReadReceipts({ conversation: 'friend@users.noreply.github.com', guids: ['g-1', 'g-2'] });
    expect(mock.calls[0]?.body).toEqual({ messageGuids: ['g-1', 'g-2'] });
  });

  it('sends typing start (POST) and stop (DELETE)', async () => {
    const { port, mock } = makePort();
    const p = '/chat/iMessage%3B-%3Bfriend%40users.noreply.github.com/typing';
    mock.on('POST', p, () => ({}));
    mock.on('DELETE', p, () => ({}));
    await port.sendTypingIndicator({ conversation: 'friend@users.noreply.github.com', composing: true });
    await port.sendTypingIndicator({ conversation: 'friend@users.noreply.github.com', composing: false });
    expect(mock.calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
  });
});
