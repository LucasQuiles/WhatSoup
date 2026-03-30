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

  // ── messages.reaction ─────────────────────────────────────────────────

  describe('messages.reaction', () => {
    it('emits reactionReceived with correct fields', () => {
      const handler = vi.fn();
      cm.on('reactionReceived', handler);

      emit({
        'messages.reaction': [
          {
            key: { remoteJid: '1234@s.whatsapp.net', id: 'msg-abc', fromMe: false },
            reaction: {
              text: '👍',
              key: { remoteJid: '1234@s.whatsapp.net', participant: '5678@s.whatsapp.net' },
            },
          },
        ],
      });

      expect(handler).toHaveBeenCalledWith({
        messageId: 'msg-abc',
        conversationKey: '1234',
        senderJid: '5678@s.whatsapp.net',
        reaction: '👍',
      });
    });

    it('falls back to remoteJid from reaction.key when participant is absent', () => {
      const handler = vi.fn();
      cm.on('reactionReceived', handler);

      emit({
        'messages.reaction': [
          {
            key: { remoteJid: '9999@s.whatsapp.net', id: 'msg-xyz' },
            reaction: {
              text: '❤️',
              key: { remoteJid: '9999@s.whatsapp.net' },
            },
          },
        ],
      });

      expect(handler).toHaveBeenCalledWith({
        messageId: 'msg-xyz',
        conversationKey: '9999',
        senderJid: '9999@s.whatsapp.net',
        reaction: '❤️',
      });
    });

    it('does not crash on null/non-array input', () => {
      const handler = vi.fn();
      cm.on('reactionReceived', handler);

      // Non-array values should be handled without throwing
      expect(() => {
        emit({ 'messages.reaction': null });
      }).not.toThrow();

      expect(handler).not.toHaveBeenCalled();
    });

    it('skips entries where messageId or remoteJid is missing', () => {
      const handler = vi.fn();
      cm.on('reactionReceived', handler);

      emit({
        'messages.reaction': [
          // missing id
          {
            key: { remoteJid: '1234@s.whatsapp.net' },
            reaction: { text: '👍', key: {} },
          },
          // missing remoteJid
          {
            key: { id: 'msg-no-jid' },
            reaction: { text: '👍', key: {} },
          },
        ],
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── message-receipt.update ────────────────────────────────────────────

  describe('message-receipt.update', () => {
    it('emits receiptUpdate with type delivery when only receiptTimestamp present', () => {
      const handler = vi.fn();
      cm.on('receiptUpdate', handler);

      emit({
        'message-receipt.update': [
          {
            key: { id: 'msg-1' },
            receipt: { userJid: '5678@s.whatsapp.net', receiptTimestamp: 1700000000 },
          },
        ],
      });

      expect(handler).toHaveBeenCalledWith({
        messageId: 'msg-1',
        recipientJid: '5678@s.whatsapp.net',
        type: 'delivery',
      });
    });

    it('emits receiptUpdate with type read when readTimestamp is present', () => {
      const handler = vi.fn();
      cm.on('receiptUpdate', handler);

      emit({
        'message-receipt.update': [
          {
            key: { id: 'msg-2' },
            receipt: { userJid: '5678@s.whatsapp.net', readTimestamp: 1700000001 },
          },
        ],
      });

      expect(handler).toHaveBeenCalledWith({
        messageId: 'msg-2',
        recipientJid: '5678@s.whatsapp.net',
        type: 'read',
      });
    });

    it('emits receiptUpdate with type played when playedTimestamp is present', () => {
      const handler = vi.fn();
      cm.on('receiptUpdate', handler);

      emit({
        'message-receipt.update': [
          {
            key: { id: 'msg-3' },
            receipt: { userJid: '5678@s.whatsapp.net', playedTimestamp: 1700000002 },
          },
        ],
      });

      expect(handler).toHaveBeenCalledWith({
        messageId: 'msg-3',
        recipientJid: '5678@s.whatsapp.net',
        type: 'played',
      });
    });

    it('skips entries with no messageId', () => {
      const handler = vi.fn();
      cm.on('receiptUpdate', handler);

      emit({
        'message-receipt.update': [
          {
            key: {},
            receipt: { userJid: '5678@s.whatsapp.net', readTimestamp: 1700000001 },
          },
        ],
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('skips entries with no recipientJid', () => {
      const handler = vi.fn();
      cm.on('receiptUpdate', handler);

      emit({
        'message-receipt.update': [
          {
            key: { id: 'msg-4' },
            receipt: { readTimestamp: 1700000001 },
          },
        ],
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── messages.media-update ─────────────────────────────────────────────

  describe('messages.media-update', () => {
    it('emits mediaUpdate with the update array', () => {
      const handler = vi.fn();
      cm.on('mediaUpdate', handler);

      const updates = [
        { key: { id: 'msg-media-1' }, update: { mimetype: 'image/jpeg', fileLength: 1024 } },
        { key: { id: 'msg-media-2' }, update: { mimetype: 'video/mp4', fileLength: 2048 } },
      ];

      emit({ 'messages.media-update': updates });

      expect(handler).toHaveBeenCalledWith(updates);
    });
  });

  // ── chats.upsert ──────────────────────────────────────────────────────

  describe('chats.upsert', () => {
    it('emits chatsUpsert with the chat array', () => {
      const handler = vi.fn();
      cm.on('chatsUpsert', handler);

      const chats = [
        { id: '1234@s.whatsapp.net', unreadCount: 2 },
        { id: '120363@g.us', name: 'Test Group' },
      ];

      emit({ 'chats.upsert': chats });

      expect(handler).toHaveBeenCalledWith(chats);
    });

    it('handles empty array gracefully', () => {
      const handler = vi.fn();
      cm.on('chatsUpsert', handler);

      emit({ 'chats.upsert': [] });

      expect(handler).toHaveBeenCalledWith([]);
    });
  });

  // ── chats.update ──────────────────────────────────────────────────────

  describe('chats.update', () => {
    it('emits chatsUpdate with the update array', () => {
      const handler = vi.fn();
      cm.on('chatsUpdate', handler);

      const updates = [{ id: '1234@s.whatsapp.net', unreadCount: 0 }];

      emit({ 'chats.update': updates });

      expect(handler).toHaveBeenCalledWith(updates);
    });
  });

  // ── chats.delete ──────────────────────────────────────────────────────

  describe('chats.delete', () => {
    it('emits chatsDelete with the jid array', () => {
      const handler = vi.fn();
      cm.on('chatsDelete', handler);

      const jids = ['1234@s.whatsapp.net', '120363@g.us'];

      emit({ 'chats.delete': jids });

      expect(handler).toHaveBeenCalledWith(jids);
    });
  });

  // ── groups.upsert ─────────────────────────────────────────────────────

  describe('groups.upsert', () => {
    it('emits groupsUpsert with the group array', () => {
      const handler = vi.fn();
      cm.on('groupsUpsert', handler);

      const groups = [
        { id: '120363@g.us', subject: 'My Group', participant: [] },
      ];

      emit({ 'groups.upsert': groups });

      expect(handler).toHaveBeenCalledWith(groups);
    });
  });

  // ── groups.update ─────────────────────────────────────────────────────

  describe('groups.update', () => {
    it('emits groupsUpdate with the update array', () => {
      const handler = vi.fn();
      cm.on('groupsUpdate', handler);

      const updates = [{ id: '120363@g.us', subject: 'Renamed Group' }];

      emit({ 'groups.update': updates });

      expect(handler).toHaveBeenCalledWith(updates);
    });
  });

  // ── group.join-request ────────────────────────────────────────────────

  describe('group.join-request', () => {
    it('emits groupJoinRequest with groupJid from the id field', () => {
      const handler = vi.fn();
      cm.on('groupJoinRequest', handler);

      emit({
        'group.join-request': {
          id: '120363@g.us',
          participant: '9999@s.whatsapp.net',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        groupJid: '120363@g.us',
        requesterJid: '9999@s.whatsapp.net',
        requestId: '',
      });
    });

    it('does not emit when participant is missing', () => {
      const handler = vi.fn();
      cm.on('groupJoinRequest', handler);

      emit({
        'group.join-request': {
          id: '120363@g.us',
          // no participant field
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit when groupJid is missing', () => {
      const handler = vi.fn();
      cm.on('groupJoinRequest', handler);

      emit({
        'group.join-request': {
          participant: '9999@s.whatsapp.net',
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── blocklist.set ─────────────────────────────────────────────────────

  describe('blocklist.set', () => {
    it('emits blocklistSet with JIDs from {blocklist: [...]} object format', () => {
      const handler = vi.fn();
      cm.on('blocklistSet', handler);

      emit({
        'blocklist.set': {
          blocklist: ['1111@s.whatsapp.net', '2222@s.whatsapp.net'],
        },
      });

      expect(handler).toHaveBeenCalledWith(['1111@s.whatsapp.net', '2222@s.whatsapp.net']);
    });

    it('emits blocklistSet with JIDs from raw array format', () => {
      const handler = vi.fn();
      cm.on('blocklistSet', handler);

      emit({
        'blocklist.set': ['3333@s.whatsapp.net', '4444@s.whatsapp.net'],
      });

      expect(handler).toHaveBeenCalledWith(['3333@s.whatsapp.net', '4444@s.whatsapp.net']);
    });
  });

  // ── blocklist.update ──────────────────────────────────────────────────

  describe('blocklist.update', () => {
    it('emits blocklistUpdate with add type', () => {
      const handler = vi.fn();
      cm.on('blocklistUpdate', handler);

      emit({
        'blocklist.update': {
          blocklist: ['5555@s.whatsapp.net'],
          type: 'add',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        blocklist: ['5555@s.whatsapp.net'],
        type: 'add',
      });
    });

    it('emits blocklistUpdate with remove type', () => {
      const handler = vi.fn();
      cm.on('blocklistUpdate', handler);

      emit({
        'blocklist.update': {
          blocklist: ['5555@s.whatsapp.net'],
          type: 'remove',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        blocklist: ['5555@s.whatsapp.net'],
        type: 'remove',
      });
    });

    it('defaults to add type when type field is absent', () => {
      const handler = vi.fn();
      cm.on('blocklistUpdate', handler);

      emit({
        'blocklist.update': {
          blocklist: ['6666@s.whatsapp.net'],
        },
      });

      expect(handler).toHaveBeenCalledWith({
        blocklist: ['6666@s.whatsapp.net'],
        type: 'add',
      });
    });
  });

  // ── labels.edit ───────────────────────────────────────────────────────

  describe('labels.edit', () => {
    it('emits labelsEdit with the label array', () => {
      const handler = vi.fn();
      cm.on('labelsEdit', handler);

      const labels = [
        { id: 'label-1', name: 'Important', color: 1 },
        { id: 'label-2', name: 'Follow-up', color: 2, predefinedId: 'p1' },
      ];

      emit({ 'labels.edit': labels });

      expect(handler).toHaveBeenCalledWith(labels);
    });
  });

  // ── labels.association ────────────────────────────────────────────────

  describe('labels.association', () => {
    it('emits labelsAssociation with chat association', () => {
      const handler = vi.fn();
      cm.on('labelsAssociation', handler);

      emit({
        'labels.association': {
          association: {
            labelId: 'label-1',
            type: 'chat',
            chatId: '1234@s.whatsapp.net',
          },
          type: 'add',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        labelId: 'label-1',
        type: 'chat',
        chatJid: '1234@s.whatsapp.net',
        messageId: undefined,
        operation: 'add',
      });
    });

    it('emits labelsAssociation with message association', () => {
      const handler = vi.fn();
      cm.on('labelsAssociation', handler);

      emit({
        'labels.association': {
          association: {
            labelId: 'label-2',
            type: 'message',
            chatId: '1234@s.whatsapp.net',
            messageId: 'msg-abc',
          },
          type: 'remove',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        labelId: 'label-2',
        type: 'message',
        chatJid: '1234@s.whatsapp.net',
        messageId: 'msg-abc',
        operation: 'remove',
      });
    });

    it('does not emit when labelId is missing', () => {
      const handler = vi.fn();
      cm.on('labelsAssociation', handler);

      emit({
        'labels.association': {
          association: { type: 'chat', chatId: '1234@s.whatsapp.net' },
          type: 'add',
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── newsletter.reaction ───────────────────────────────────────────────

  describe('newsletter.reaction', () => {
    it('emits newsletterReaction with the raw event data', () => {
      const handler = vi.fn();
      cm.on('newsletterReaction', handler);

      const data = { newsletterId: 'nl-1', messageId: 'msg-1', reaction: '🔥', count: 5 };

      emit({ 'newsletter.reaction': data });

      expect(handler).toHaveBeenCalledWith(data);
    });
  });

  // ── messaging-history.set ─────────────────────────────────────────────

  describe('messaging-history.set', () => {
    it('emits historyMessages, chatsUpsert, and historySyncComplete when data is full', () => {
      const historyHandler = vi.fn();
      const chatsHandler = vi.fn();
      const syncHandler = vi.fn();
      cm.on('historyMessages', historyHandler);
      cm.on('chatsUpsert', chatsHandler);
      cm.on('historySyncComplete', syncHandler);

      const messages = [{ key: { id: 'h-msg-1' } }, { key: { id: 'h-msg-2' } }];
      const chats = [{ id: '1234@s.whatsapp.net' }, { id: '120363@g.us' }];

      emit({
        'messaging-history.set': {
          messages,
          chats,
          isLatest: true,
        },
      });

      expect(historyHandler).toHaveBeenCalledWith(messages);
      expect(chatsHandler).toHaveBeenCalledWith(chats);
      expect(syncHandler).toHaveBeenCalledOnce();
    });

    it('emits only historySyncComplete when messages and chats arrays are empty', () => {
      const historyHandler = vi.fn();
      const chatsHandler = vi.fn();
      const syncHandler = vi.fn();
      cm.on('historyMessages', historyHandler);
      cm.on('chatsUpsert', chatsHandler);
      cm.on('historySyncComplete', syncHandler);

      emit({
        'messaging-history.set': {
          messages: [],
          chats: [],
          isLatest: false,
        },
      });

      expect(historyHandler).not.toHaveBeenCalled();
      expect(chatsHandler).not.toHaveBeenCalled();
      expect(syncHandler).toHaveBeenCalledOnce();
    });

    it('emits historySyncComplete even when messages and chats fields are absent', () => {
      const syncHandler = vi.fn();
      cm.on('historySyncComplete', syncHandler);

      emit({ 'messaging-history.set': {} });

      expect(syncHandler).toHaveBeenCalledOnce();
    });
  });
});
