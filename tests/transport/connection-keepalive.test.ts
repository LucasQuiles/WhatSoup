import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

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

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

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
      id: '15551230004:1@s.whatsapp.net',
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

  it('emits exhausted when keepalive keeps failing past the 30-minute window', async () => {
    const { mockSock, emit } = makeMockSocket();
    mockSock.query.mockRejectedValue(new Error('ping timeout'));
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const exhausted = vi.fn();
    manager.on('exhausted', exhausted);
    await manager.connect();
    emit(openEvent());

    // First keepalive failure starts the keepalive-failure clock + triggers gracefulReconnect.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exhausted).not.toHaveBeenCalled();

    // Reconnected; jump the wall clock past the window without firing timers, then let the
    // next keepalive fail — elapsed since the first failure now exceeds 30 minutes.
    emit(openEvent());
    vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(exhausted).toHaveBeenCalled();
  });

  it('does not emit exhausted when a successful pong resets the keepalive-failure clock', async () => {
    const { mockSock, emit } = makeMockSocket();
    // Fail, then a healthy pong, then fail again.
    mockSock.query
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({})
      .mockRejectedValue(new Error('later blip'));
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const exhausted = vi.fn();
    manager.on('exhausted', exhausted);
    await manager.connect();
    emit(openEvent());

    await vi.advanceTimersByTimeAsync(30_000); // KA#1 fails → clock starts → gracefulReconnect
    emit(openEvent());
    await vi.advanceTimersByTimeAsync(30_000); // KA#2 pongs → clock reset
    // Even after jumping well past the window, the next failure starts a fresh clock.
    vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1_000);
    await vi.advanceTimersByTimeAsync(30_000); // KA#3 fails but elapsed ≈ 0

    expect(exhausted).not.toHaveBeenCalled();
  });
});

describe('ConnectionManager — self-mention stripping', () => {
  it('strips @<botJid bare> from sendMessage text payloads', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    await manager.sendMessage('15551234567@s.whatsapp.net', 'hi @15551230004 there');

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload['text']).toBe('hi 15551230004 there');
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
