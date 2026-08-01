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
    sendMessage: vi.fn(),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
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

function makeTextMessage(opts: {
  id?: string;
  remoteJid: string;
  fromMe?: boolean;
  text?: string;
  participant?: string;
  participantAlt?: string;
}) {
  return {
    key: {
      id: opts.id ?? 'msg-1',
      remoteJid: opts.remoteJid,
      fromMe: opts.fromMe ?? false,
      participant: opts.participant,
      participantAlt: opts.participantAlt,
    },
    message: { conversation: opts.text ?? 'hello' },
    messageTimestamp: 1_700_000_000,
    pushName: 'Test User',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ConnectionManager — messages.upsert dispatch', () => {
  it('invokes onMessage when a parseable notify message arrives', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const onMessage = vi.fn();
    manager.onMessage = onMessage;

    await manager.connect();
    emit(openEvent());

    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [makeTextMessage({ remoteJid: '15551234567@s.whatsapp.net' })],
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    const parsed = onMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(parsed['messageId']).toBe('msg-1');
    expect(parsed['chatJid']).toBe('15551234567@s.whatsapp.net');
  });

  it('invokes onMessage for type=append', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const onMessage = vi.fn();
    manager.onMessage = onMessage;

    await manager.connect();
    emit(openEvent());

    emit({
      'messages.upsert': {
        type: 'append',
        messages: [makeTextMessage({ id: 'msg-append', remoteJid: '15551234567@s.whatsapp.net' })],
      },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onMessage for full history sync messages', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const onMessage = vi.fn();
    manager.onMessage = onMessage;

    await manager.connect();
    emit(openEvent());

    emit({
      'messages.upsert': {
        type: 'historySync',
        messages: [makeTextMessage({ remoteJid: '15551234567@s.whatsapp.net' })],
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('does not invoke onMessage when the parser returns null (no inner message)', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const onMessage = vi.fn();
    manager.onMessage = onMessage;

    await manager.connect();
    emit(openEvent());

    const bareMessage = {
      key: { id: 'msg-bare', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
      message: null,
      messageTimestamp: 1_700_000_000,
    };

    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [bareMessage],
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('swallows errors thrown by the onMessage callback', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    manager.onMessage = () => {
      throw new Error('callback boom');
    };

    await manager.connect();
    emit(openEvent());

    expect(() =>
      emit({
        'messages.upsert': {
          type: 'notify',
          messages: [makeTextMessage({ remoteJid: '15551234567@s.whatsapp.net' })],
        },
      }),
    ).not.toThrow();
  });

  it('continues dispatching later messages when one onMessage callback throws', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const onMessage = vi.fn((message: { messageId: string }) => {
      if (message.messageId === 'msg-fail') {
        throw new Error('callback boom');
      }
    });
    manager.onMessage = onMessage as any;

    await manager.connect();
    emit(openEvent());

    expect(() =>
      emit({
        'messages.upsert': {
          type: 'notify',
          messages: [
            makeTextMessage({ id: 'msg-fail', remoteJid: '15551234567@s.whatsapp.net' }),
            makeTextMessage({ id: 'msg-next', remoteJid: '15551234567@s.whatsapp.net' }),
          ],
        },
      }),
    ).not.toThrow();

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[1]?.[0].messageId).toBe('msg-next');
  });

  it('emits decryptionFailure for CIPHERTEXT stubs without invoking onMessage', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const onMessage = vi.fn();
    const onDecryptionFailure = vi.fn();
    manager.onMessage = onMessage;
    manager.on('decryptionFailure', onDecryptionFailure);

    await manager.connect();
    emit(openEvent());

    const ciphertextStub = {
      key: { id: 'msg-cipher', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
      messageStubType: 2,
      messageStubParameters: ['decryption failed'],
      message: null,
      messageTimestamp: 1_700_000_000,
    };

    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [ciphertextStub],
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onDecryptionFailure).toHaveBeenCalledTimes(1);
    const payload = onDecryptionFailure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['messageId']).toBe('msg-cipher');
    expect(payload['errorMessage']).toBe('decryption failed');
  });

  it('emits lidPairDiscovered when a message includes both participant and participantAlt', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const onLidPair = vi.fn();
    manager.on('lidPairDiscovered', onLidPair);

    await manager.connect();
    emit(openEvent());

    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [
          makeTextMessage({
            remoteJid: '111111100000000001@g.us',
            participant: '15551234567@s.whatsapp.net',
            participantAlt: '11111111000@lid',
          }),
        ],
      },
    });

    expect(onLidPair).toHaveBeenCalledWith(
      '15551234567@s.whatsapp.net',
      '11111111000@lid',
    );
  });
});
