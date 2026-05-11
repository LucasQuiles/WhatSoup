import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(),
  }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: { loggedOut: 401, restartRequired: 515, connectionClosed: 428 },
  isJidGroup: vi.fn((jid: string) => jid?.endsWith('@g.us')),
  jidNormalizedUser: vi.fn((jid: string) => jid?.replace(/:.*@/, '@')),
}));

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off',
    generateHighQualityLinkPreview: false,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs: number = 30_000) => {
    const exp = baseMs * Math.pow(2, attempt);
    return Math.min(exp, maxMs);
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      level: 'error',
    }),
  }),
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';

function makeMockSocket() {
  let evProcessCallback: ((events: Record<string, unknown>) => void) | undefined;
  const mockSock = {
    ev: {
      process: vi.fn((cb: (events: Record<string, unknown>) => void) => {
        evProcessCallback = cb;
      }),
    },
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wa-msg-1' } }),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    ws: { isOpen: true },
    user: {
      id: '18455943112:1@s.whatsapp.net',
      lid: '81536414179557:2@lid',
      name: 'WhatSoup',
    },
  };
  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    evProcessCallback(events);
  }
  return { mockSock, emit };
}

function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionManager — keepalive', () => {
  it('fires a sock.query ping IQ after the keepalive interval', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());
    expect(mockSock.query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSock.query).toHaveBeenCalledTimes(1);
    const queryArg = mockSock.query.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(queryArg).toBeDefined();
    expect(queryArg!['tag']).toBe('iq');
    const attrs = queryArg!['attrs'] as Record<string, unknown>;
    expect(attrs['xmlns']).toBe('w:p');
    expect(attrs['type']).toBe('get');
    expect(attrs['to']).toBe('s.whatsapp.net');
  });

  it('fires keepalive on each interval boundary', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockSock.query).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockSock.query).toHaveBeenCalledTimes(2);
  });

  it('does not fire keepalive when the socket websocket is not open', async () => {
    const { mockSock, emit } = makeMockSocket();
    mockSock.ws.isOpen = false;
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSock.query).not.toHaveBeenCalled();
  });
});

describe('ConnectionManager — self-mention stripping', () => {
  it('strips @<botJid bare> from sendMessage text payloads', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    await manager.sendMessage('15551234567@s.whatsapp.net', 'hi @18455943112 there');

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload['text']).toBe('hi 18455943112 there');
  });

  it('strips @<botLid bare> from sendMessage text payloads in LID-addressed groups', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    await manager.sendMessage('111111100000000001@g.us', 'tag @81536414179557 here');

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload['text']).toBe('tag 81536414179557 here');
  });

  it('passes through @<other-number> mentions untouched', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    await manager.sendMessage('15551234567@s.whatsapp.net', 'hello @19998887777 friend');

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload['text']).toBe('hello @19998887777 friend');
  });
});
