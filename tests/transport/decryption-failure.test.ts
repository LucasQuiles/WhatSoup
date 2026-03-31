import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

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
    adminPhones: new Set(['18459780919']),
    authDir: '/tmp/wa-test-auth',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
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

// ---------------------------------------------------------------------------
// Mock socket helpers
// ---------------------------------------------------------------------------

function makeMockSocket() {
  let evProcessCallback: ((events: Record<string, unknown>) => void) | undefined;

  const mockSock = {
    ev: {
      process: vi.fn((cb: (events: Record<string, unknown>) => void) => {
        evProcessCallback = cb;
      }),
    },
    sendMessage: vi.fn(),
    end: vi.fn(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CIPHERTEXT stub detection', () => {
  let cm: ConnectionManager;
  let emit: (events: Record<string, unknown>) => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { mockSock, emit: mockEmit } = makeMockSocket();
    emit = mockEmit;
    (makeWASocket as ReturnType<typeof vi.fn>).mockReturnValue(mockSock);

    cm = new ConnectionManager();
    await cm.connect();

    // Open the connection so the stale-socket guard passes
    emit({ 'connection.update': { connection: 'open' } });
  });

  afterEach(async () => {
    await cm.shutdown();
  });

  it('emits decryptionFailure when messageStubType=2 and message is absent', () => {
    const handler = vi.fn();
    cm.on('decryptionFailure', handler);

    const chatJid = '15551234567@s.whatsapp.net';
    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [
          {
            key: { id: 'msg-cipher-001', remoteJid: chatJid, fromMe: false },
            messageStubType: 2,
            messageStubParameters: ['Session reset'],
            messageTimestamp: 1700000000,
            // message is intentionally absent (undefined)
          },
        ],
      },
    });

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0][0];
    expect(payload.messageId).toBe('msg-cipher-001');
    expect(payload.chatJid).toBe(chatJid);
    expect(payload.errorMessage).toBe('Session reset');
    expect(payload.timestamp).toBe(1700000000);
    expect(payload.rawKey).toEqual({ remoteJid: chatJid, id: 'msg-cipher-001', fromMe: false });
  });

  it('uses fallback error message when messageStubParameters is absent', () => {
    const handler = vi.fn();
    cm.on('decryptionFailure', handler);

    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [
          {
            key: { id: 'msg-no-params', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
            messageStubType: 2,
            messageTimestamp: 1700000001,
          },
        ],
      },
    });

    const payload = handler.mock.calls[0][0];
    expect(payload.errorMessage).toBe('unknown decryption error');
  });

  it('uses participant JID as senderJid in group messages', () => {
    const handler = vi.fn();
    cm.on('decryptionFailure', handler);

    const groupJid = '120363000000001@g.us';
    const participantJid = '15551234567@s.whatsapp.net';
    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [
          {
            key: { id: 'msg-group-cipher', remoteJid: groupJid, fromMe: false, participant: participantJid },
            messageStubType: 2,
            messageTimestamp: 1700000002,
          },
        ],
      },
    });

    const payload = handler.mock.calls[0][0];
    expect(payload.senderJid).toBe(participantJid);
    expect(payload.chatJid).toBe(groupJid);
  });

  it('does NOT emit decryptionFailure for normal messages with message content', () => {
    const handler = vi.fn();
    cm.on('decryptionFailure', handler);

    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [
          {
            key: { id: 'msg-normal', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
            message: { conversation: 'Hello world' },
            messageTimestamp: 1700000003,
            pushName: 'Alice',
          },
        ],
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('does NOT emit decryptionFailure for history sync messages (type=historysync)', () => {
    const handler = vi.fn();
    cm.on('decryptionFailure', handler);

    emit({
      'messages.upsert': {
        type: 'historysync',
        messages: [
          {
            key: { id: 'msg-history', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
            messageStubType: 2,
            messageTimestamp: 1700000004,
          },
        ],
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
