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
// Helpers
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

describe('event wiring', () => {
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

  // ── group-participants.update ──────────────────────────────────────────

  describe('group-participants.update', () => {
    it('emits groupParticipantsUpdate for add action', () => {
      const handler = vi.fn();
      cm.on('groupParticipantsUpdate', handler);

      emit({
        'group-participants.update': {
          id: '120363@g.us',
          author: '1234@s.whatsapp.net',
          participants: ['5678@s.whatsapp.net'],
          action: 'add',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        groupJid: '120363@g.us',
        author: '1234@s.whatsapp.net',
        participants: ['5678@s.whatsapp.net'],
        action: 'add',
      });
    });

    it('emits groupParticipantsUpdate for remove action', () => {
      const handler = vi.fn();
      cm.on('groupParticipantsUpdate', handler);

      emit({
        'group-participants.update': {
          id: '120363@g.us',
          author: '1234@s.whatsapp.net',
          participants: ['5678@s.whatsapp.net'],
          action: 'remove',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        groupJid: '120363@g.us',
        author: '1234@s.whatsapp.net',
        participants: ['5678@s.whatsapp.net'],
        action: 'remove',
      });
    });

    it('emits groupParticipantsUpdate for promote/demote', () => {
      const handler = vi.fn();
      cm.on('groupParticipantsUpdate', handler);

      emit({
        'group-participants.update': {
          id: '120363@g.us',
          author: '1234@s.whatsapp.net',
          participants: ['5678@s.whatsapp.net'],
          action: 'promote',
        },
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].action).toBe('promote');
    });
  });

  // ── lid-mapping.update ────────────────────────────────────────────────

  describe('lid-mapping.update', () => {
    it('emits jidAliasChanged with conversationKey from LID', () => {
      const handler = vi.fn();
      cm.on('jidAliasChanged', handler);

      emit({
        'lid-mapping.update': {
          lid: '81536414179557:2@lid',
          pn: '18455943112@s.whatsapp.net',
        },
      });

      expect(handler).toHaveBeenCalledWith(
        '81536414179557', // conversationKey from LID
        '18455943112@s.whatsapp.net', // phone number JID
      );
    });

    it('does not emit when lid or pn is missing', () => {
      const handler = vi.fn();
      cm.on('jidAliasChanged', handler);

      emit({ 'lid-mapping.update': { lid: '81536414179557:2@lid' } });
      emit({ 'lid-mapping.update': { pn: '18455943112@s.whatsapp.net' } });
      emit({ 'lid-mapping.update': {} });

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
