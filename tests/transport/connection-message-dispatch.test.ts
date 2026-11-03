import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth-connection-message-dispatch',
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-connection-message-dispatch/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off',
    generateHighQualityLinkPreview: false,
    transportAuthority: {
      enabled: true,
      accountId: 'pilot-account',
    },
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
  it('delivers a server-rendered review card through the final authority seam without invoking the runtime', async () => {
    // Break caught: a model receives /review and can alter the selected held work or its recipient.
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const authority = {
      registerInbound: vi.fn(async () => ({
        kind: 'review' as const,
        review: {
          challenge: 'challenge-1',
          items: [{ id: 'operation-1', digest: 'sha256:payload' }],
          previews: [{
            id: 'operation-1',
            accountId: 'pilot-account',
            action: 'whatsapp.send',
            payload: { recipient: '15551234567@s.whatsapp.net', content: { text: 'held reply' } },
            digest: 'sha256:payload',
            state: 'held',
          }],
          expiresAt: '2026-11-02T15:00:00.000Z',
        },
      })),
      closeInbound: vi.fn(async () => undefined),
      admit: vi.fn(async () => ({ attemptId: 'attempt-card', payloadDigest: 'sha256:card' })),
      recordReceipt: vi.fn(async () => undefined),
      recordDecision: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
    };
    const manager = new ConnectionManager();
    manager.setOperationsAuthorityClient(authority);
    const onMessage = vi.fn();
    manager.onMessage = onMessage;

    await manager.connect();
    emit(openEvent());
    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [makeTextMessage({ id: 'review-command', remoteJid: '15551234567@s.whatsapp.net', text: '/review operation-1' })],
      },
    });

    await vi.waitFor(() => expect(authority.recordReceipt).toHaveBeenCalledTimes(1));
    expect(onMessage).not.toHaveBeenCalled();
    expect(authority.registerInbound).toHaveBeenCalledWith(expect.objectContaining({ text: '/review operation-1' }));
    expect(authority.admit).toHaveBeenCalledWith(expect.objectContaining({
      recipient: '15551234567@s.whatsapp.net',
      context: { inbound_event_id: 'review-command' },
    }));
    expect(mockSock.sendMessage).toHaveBeenCalledWith('15551234567@s.whatsapp.net', expect.objectContaining({
      text: expect.stringContaining('/approve challenge-1 operation-1'),
    }));
  });

  it('retries only an authority-dispatched WhatsApp operation on a protected approval command', async () => {
    // Break caught: approval text is parsed locally or released payload is sent outside the final gate.
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const authority = {
      registerInbound: vi.fn(async () => ({
        kind: 'decision' as const,
        operations: [{
          id: 'operation-1',
          accountId: 'pilot-account',
          action: 'whatsapp.send',
          payload: {
            recipient: '15551230000@s.whatsapp.net',
            content: { text: 'released reply' },
            options: { timestamp: 1_700_000_000 },
          },
          digest: 'sha256:payload',
          state: 'approved',
        }],
      })),
      closeInbound: vi.fn(async () => undefined),
      admit: vi.fn(async () => ({ attemptId: 'attempt-retry', payloadDigest: 'sha256:retry' })),
      recordReceipt: vi.fn(async () => undefined),
      recordDecision: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
    };
    const manager = new ConnectionManager();
    manager.setOperationsAuthorityClient(authority);
    const onMessage = vi.fn();
    manager.onMessage = onMessage;

    await manager.connect();
    emit(openEvent());
    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [makeTextMessage({ id: 'approve-command', remoteJid: '15551234567@s.whatsapp.net', text: '/approve challenge-1 operation-1' })],
      },
    });

    await vi.waitFor(() => expect(authority.recordReceipt).toHaveBeenCalledTimes(1));
    expect(onMessage).not.toHaveBeenCalled();
    expect(authority.admit).toHaveBeenCalledWith({
      recipient: '15551230000@s.whatsapp.net',
      content: { text: 'released reply' },
      options: { timestamp: 1_700_000_000 },
      context: { inbound_event_id: 'approve-command' },
      operationId: 'operation-1',
    });
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      '15551230000@s.whatsapp.net',
      { text: 'released reply' },
      { timestamp: 1_700_000_000 },
    );
  });

  it('sends only the authority-created fixed receipt after the authority persists /stop', async () => {
    // Break caught: a paused account sends a local acknowledgement through a
    // normal reply grant instead of its one-use server-issued receipt.
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const authority = {
      registerInbound: vi.fn(async () => ({
        kind: 'paused' as const,
        receipt: {
          id: 'receipt-stop',
          accountId: 'pilot-account',
          action: 'whatsapp.control_receipt',
          payload: { recipient: '15551234567@s.whatsapp.net', content: { text: 'Notifications paused.' } },
          digest: 'sha256:receipt',
          state: 'approved',
        },
      })),
      closeInbound: vi.fn(async () => undefined),
      admit: vi.fn(async () => ({ attemptId: 'stop-receipt', payloadDigest: 'sha256:stop-receipt' })),
      recordReceipt: vi.fn(async () => undefined),
      recordDecision: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
    };
    const manager = new ConnectionManager();
    manager.setOperationsAuthorityClient(authority);
    const onMessage = vi.fn();
    manager.onMessage = onMessage;

    await manager.connect();
    emit(openEvent());
    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [makeTextMessage({ id: 'stop-command', remoteJid: '15551234567@s.whatsapp.net', text: '/stop' })],
      },
    });

    await vi.waitFor(() => expect(authority.recordReceipt).toHaveBeenCalledTimes(1));
    expect(onMessage).not.toHaveBeenCalled();
    expect(authority.admit).toHaveBeenCalledWith({
      recipient: '15551234567@s.whatsapp.net',
      content: { text: 'Notifications paused.' },
      context: { inbound_event_id: 'stop-command' },
      operationId: 'receipt-stop',
    });
    expect(mockSock.sendMessage).toHaveBeenCalledWith('15551234567@s.whatsapp.net', { text: 'Notifications paused.' });
  });

  it('retries only server-created approved WhatsApp automation before the normal inbound turn', async () => {
    // Break caught: agent text can manufacture automation facts, or an approved
    // mail operation is incorrectly pushed through the WhatsApp socket.
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const onMessage = vi.fn();
    const authority = {
      registerInbound: vi.fn(async () => ({
        kind: 'inbound' as const,
        automationOperations: [
          {
            id: 'auto-whatsapp-1', accountId: 'pilot-account', action: 'whatsapp.send',
            payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'server automation' } },
            digest: 'sha256:auto', state: 'approved',
          },
          {
            id: 'auto-mail-1', accountId: 'pilot-account', action: 'mail.send',
            payload: { subject: 'executor only' }, digest: 'sha256:mail', state: 'approved',
          },
        ],
        automationHolds: [{ ruleId: 'rule-hold-1', reason: 'needs_review' }],
      })),
      closeInbound: vi.fn(async () => undefined),
      admit: vi.fn(async () => ({ attemptId: 'attempt-auto', payloadDigest: 'sha256:auto' })),
      recordReceipt: vi.fn(async () => undefined),
      recordDecision: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
    };
    const manager = new ConnectionManager();
    manager.setOperationsAuthorityClient(authority);
    manager.onMessage = onMessage;

    await manager.connect();
    emit(openEvent());
    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [makeTextMessage({ id: 'inbound-auto', remoteJid: '15551234567@s.whatsapp.net', text: 'trigger' })],
      },
    });

    await vi.waitFor(() => expect(authority.recordReceipt).toHaveBeenCalledTimes(1));
    expect(authority.admit).toHaveBeenCalledWith({
      recipient: '15551230000@s.whatsapp.net',
      content: { text: 'server automation' },
      context: { inbound_event_id: 'inbound-auto' },
      operationId: 'auto-whatsapp-1',
    });
    expect(mockSock.sendMessage).toHaveBeenCalledWith('15551230000@s.whatsapp.net', { text: 'server automation' });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps an authority inbound lease open until the asynchronous ingest turn settles', async () => {
    // Break caught: treating queue admission as completion lets a later queued
    // reply lose its only authenticated inbound binding.
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    let resolveTurn!: () => void;
    const onMessage = vi.fn(() => new Promise<void>((resolve) => { resolveTurn = resolve; }));
    const authority = {
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
      admit: vi.fn(async () => ({ attemptId: 'unused', payloadDigest: 'sha256:unused' })),
      recordReceipt: vi.fn(async () => undefined),
      recordDecision: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
    };
    const manager = new ConnectionManager();
    manager.setOperationsAuthorityClient(authority);
    manager.onMessage = onMessage;

    await manager.connect();
    emit(openEvent());
    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [makeTextMessage({ id: 'lease-turn', remoteJid: '15551234567@s.whatsapp.net', text: 'wait' })],
      },
    });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(authority.closeInbound).not.toHaveBeenCalled();
    resolveTurn();
    await vi.waitFor(() => expect(authority.closeInbound).toHaveBeenCalledWith({ eventId: 'lease-turn' }));
  });

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
