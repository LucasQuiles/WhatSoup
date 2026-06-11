import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------
vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    adminReplayMax: 5,
    adminReplayDelayMs: 0, // zero delay for fast tests; throttle tests override
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
  }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { Database } from '../../src/core/database.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';
import { insertPending, lookupAccess } from '../../src/core/access-list.ts';
import {
  handleAdminCommand,
  sendApprovalRequest,
} from '../../src/core/admin.ts';
import * as adminModule from '../../src/core/admin.ts';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMockMessenger() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

const ADMIN_CHAT_JID = '15550100001@s.whatsapp.net';

// ---------------------------------------------------------------------------
// handleAdminCommand — ALLOW (phone)
// ---------------------------------------------------------------------------

describe('handleAdminCommand ALLOW phone', () => {
  it('updates access status to allowed', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    insertPending(db, 'phone', '15184194479', 'Test User');

    await handleAdminCommand(db, messenger, 'allow', 'phone', '15184194479', ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    const entry = lookupAccess(db, 'phone', '15184194479');
    expect(entry!.status).toBe('allowed');
  });

  it('sends confirmation to the admin chatJid', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await handleAdminCommand(db, messenger, 'allow', 'phone', '15184194479', ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    expect(messenger.sendMessage).toHaveBeenCalledWith(ADMIN_CHAT_JID, expect.stringContaining('15184194479'));
  });

  it('processes queued messages for the newly allowed sender', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    storeMessageIfNew(db, {
      chatJid: '15184194479@s.whatsapp.net',
      conversationKey: '15184194479',
      senderJid: '15184194479@s.whatsapp.net',
      senderName: 'Queued User',
      messageId: 'queued-msg-001',
      content: 'pending content',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700000000,
    });

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    await handleAdminCommand(db, messenger, 'allow', 'phone', '15184194479', ADMIN_CHAT_JID, handleMessageFn);

    expect(handleMessageFn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'queued-msg-001', content: 'pending content' }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleAdminCommand — BLOCK (phone)
// ---------------------------------------------------------------------------

describe('handleAdminCommand BLOCK phone', () => {
  it('updates access status to blocked', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    insertPending(db, 'phone', '15184194479', 'BlockMe');

    await handleAdminCommand(db, messenger, 'block', 'phone', '15184194479', ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    expect(lookupAccess(db, 'phone', '15184194479')!.status).toBe('blocked');
  });

  it('sends confirmation to admin', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await handleAdminCommand(db, messenger, 'block', 'phone', '15184194479', ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    expect(messenger.sendMessage).toHaveBeenCalledWith(ADMIN_CHAT_JID, expect.stringContaining('Blocked'));
  });

  it('does NOT replay queued messages', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    const handleMessageFn = vi.fn();

    await handleAdminCommand(db, messenger, 'block', 'phone', '15184194479', ADMIN_CHAT_JID, handleMessageFn);

    expect(handleMessageFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleAdminCommand — ALLOW GROUP
// ---------------------------------------------------------------------------

// @check CHK-078
// @traces REQ-013.AC-05
describe('handleAdminCommand ALLOW GROUP', () => {
  it('updates group access status to allowed', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    const groupJid = '120363987654321@g.us';
    insertPending(db, 'group', groupJid, 'Test Group');

    await handleAdminCommand(db, messenger, 'allow', 'group', groupJid, ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    const entry = lookupAccess(db, 'group', groupJid);
    expect(entry!.status).toBe('allowed');
  });

  it('sends group confirmation to admin', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    const groupJid = '120363987654321@g.us';

    await handleAdminCommand(db, messenger, 'allow', 'group', groupJid, ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    expect(messenger.sendMessage).toHaveBeenCalledWith(ADMIN_CHAT_JID, expect.stringContaining(groupJid));
  });

  it('does NOT replay queued messages for groups (no queued message support)', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    const groupJid = '120363987654321@g.us';
    const handleMessageFn = vi.fn();

    await handleAdminCommand(db, messenger, 'allow', 'group', groupJid, ADMIN_CHAT_JID, handleMessageFn);

    expect(handleMessageFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleAdminCommand — BLOCK GROUP
// ---------------------------------------------------------------------------

// @check CHK-079
// @traces REQ-013.AC-06
describe('handleAdminCommand BLOCK GROUP', () => {
  it('updates group access status to blocked', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    const groupJid = '120363555555555@g.us';
    insertPending(db, 'group', groupJid, 'SomeGroup');

    await handleAdminCommand(db, messenger, 'block', 'group', groupJid, ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    expect(lookupAccess(db, 'group', groupJid)!.status).toBe('blocked');
  });

  it('sends blocked group confirmation to admin', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    const groupJid = '120363555555555@g.us';

    await handleAdminCommand(db, messenger, 'block', 'group', groupJid, ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    expect(messenger.sendMessage).toHaveBeenCalledWith(ADMIN_CHAT_JID, expect.stringContaining(groupJid));
  });

  it('schema supports both phone and group subjects in access_list', () => {
    const db = openDb();
    insertPending(db, 'phone', '15550001111', 'PhoneUser');
    insertPending(db, 'group', '120363111111111@g.us', 'GroupChat');
    const phoneEntry = lookupAccess(db, 'phone', '15550001111');
    const groupEntry = lookupAccess(db, 'group', '120363111111111@g.us');
    expect(phoneEntry!.subjectType).toBe('phone');
    expect(groupEntry!.subjectType).toBe('group');
  });
});

// ---------------------------------------------------------------------------
// sendApprovalRequest
// ---------------------------------------------------------------------------

describe('sendApprovalRequest', () => {
  it('inserts pending record', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await sendApprovalRequest(db, messenger, '15554440000', 'Carol', 'Hi there!');

    const entry = lookupAccess(db, 'phone', '15554440000');
    expect(entry!.status).toBe('pending');
  });

  it('sends formatted approval message', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await sendApprovalRequest(db, messenger, '15554440001', 'Dave', 'Please help');

    expect(messenger.sendMessage).toHaveBeenCalledOnce();
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('Dave');
    expect(sentText).toContain('15554440001');
    expect(sentText).toContain('ALLOW');
    expect(sentText).toContain('BLOCK');
  });

  it('truncates long preview to 100 chars', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await sendApprovalRequest(db, messenger, '15554440002', 'Eve', 'a'.repeat(200));

    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    const previewMatch = sentText.match(/"([^"]+)"/);
    expect(previewMatch![1].length).toBeLessThanOrEqual(100);
  });

  it('is idempotent — duplicate does not throw', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await sendApprovalRequest(db, messenger, '15554440003', 'Frank', 'First');
    await expect(sendApprovalRequest(db, messenger, '15554440003', 'Frank', 'Second')).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SP4 — Admin replay hardening (dedup + throttle + cap)
// ---------------------------------------------------------------------------

describe('handleAdminCommand ALLOW — SP4 replay hardening', () => {
  it('caps replayedIds at 10,000 entries and evicts the oldest id', async () => {
    const adminAny = adminModule as any;

    adminAny.__resetReplayedIdsForTests();

    for (let i = 0; i <= 10_000; i++) {
      adminAny.__rememberReplayedIdForTests(`replayed-${i}`);
    }

    expect(adminAny.__getReplayedIdsSizeForTests()).toBe(10_000);
    expect(adminAny.__hasReplayedIdForTests('replayed-0')).toBe(false);
    expect(adminAny.__hasReplayedIdForTests('replayed-1')).toBe(true);
    expect(adminAny.__hasReplayedIdForTests('replayed-10000')).toBe(true);
  });

  it('caps replayed messages to adminReplayMax', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 3;
    (config as any).adminReplayDelayMs = 0;

    const db = openDb();
    const messenger = makeMockMessenger();

    // Store 6 messages — only last 3 should replay
    for (let i = 0; i < 6; i++) {
      storeMessageIfNew(db, {
        chatJid: '15559990001@s.whatsapp.net',
        conversationKey: '15559990001',
        senderJid: '15559990001@s.whatsapp.net',
        senderName: 'CapUser',
        messageId: `cap-msg-${i}`,
        content: `msg ${i}`,
        contentType: 'text',
        isFromMe: false,
        timestamp: 1700000000 + i,
      });
    }

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    await handleAdminCommand(db, messenger, 'allow', 'phone', '15559990001', ADMIN_CHAT_JID, handleMessageFn);

    expect(handleMessageFn).toHaveBeenCalledTimes(3);
    // Should be the last 3 messages (most recent)
    const replayedIds = handleMessageFn.mock.calls.map((c: any[]) => c[0].messageId);
    expect(replayedIds).toContain('cap-msg-3');
    expect(replayedIds).toContain('cap-msg-4');
    expect(replayedIds).toContain('cap-msg-5');
  });

  it('deduplicates — same message is not replayed twice across allow calls', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 10;
    (config as any).adminReplayDelayMs = 0;

    const db = openDb();
    const messenger = makeMockMessenger();

    storeMessageIfNew(db, {
      chatJid: '15559990002@s.whatsapp.net',
      conversationKey: '15559990002',
      senderJid: '15559990002@s.whatsapp.net',
      senderName: 'DedupUser',
      messageId: 'dedup-msg-1',
      content: 'hello',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700000000,
    });

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);

    // First allow — should replay the message
    await handleAdminCommand(db, messenger, 'allow', 'phone', '15559990002', ADMIN_CHAT_JID, handleMessageFn);
    expect(handleMessageFn).toHaveBeenCalledTimes(1);

    handleMessageFn.mockClear();

    // Second allow — same message should NOT replay (dedup via replayedIds)
    await handleAdminCommand(db, messenger, 'allow', 'phone', '15559990002', ADMIN_CHAT_JID, handleMessageFn);
    expect(handleMessageFn).not.toHaveBeenCalled();
  });

  it('applies throttle delay between replayed messages', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 10;
    (config as any).adminReplayDelayMs = 50; // 50ms per message

    const db = openDb();
    const messenger = makeMockMessenger();

    for (let i = 0; i < 3; i++) {
      storeMessageIfNew(db, {
        chatJid: '15559990003@s.whatsapp.net',
        conversationKey: '15559990003',
        senderJid: '15559990003@s.whatsapp.net',
        senderName: 'ThrottleUser',
        messageId: `throttle-msg-${i}`,
        content: `msg ${i}`,
        contentType: 'text',
        isFromMe: false,
        timestamp: 1700000000 + i,
      });
    }

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    const start = Date.now();
    await handleAdminCommand(db, messenger, 'allow', 'phone', '15559990003', ADMIN_CHAT_JID, handleMessageFn);
    const elapsed = Date.now() - start;

    expect(handleMessageFn).toHaveBeenCalledTimes(3);
    // 3 messages with 50ms delay each = at least ~100ms total (delay after each except possibly last)
    // Be lenient — just check it's noticeably above 0
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// DM-scope replay: group messages must be excluded from replay
// ---------------------------------------------------------------------------

describe('handleAdminCommand ALLOW — DM-scope replay (group exclusion)', () => {
  it('replays DM messages but skips group messages', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 10;
    (config as any).adminReplayDelayMs = 0;

    const db = openDb();
    const messenger = makeMockMessenger();

    // DM message: chatJid is a personal JID
    storeMessageIfNew(db, {
      chatJid: '15551234567@s.whatsapp.net',
      conversationKey: '15551234567',
      senderJid: '15551234567@s.whatsapp.net',
      senderName: 'DmUser',
      messageId: 'dm-msg-group-test-001',
      content: 'hello from dm',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700001000,
    });

    // Group message: same sender, but chatJid is a group JID
    storeMessageIfNew(db, {
      chatJid: '120363555555555000@g.us',
      conversationKey: '120363555555555000',
      senderJid: '15551234567@s.whatsapp.net',
      senderName: 'DmUser',
      messageId: 'group-msg-group-test-001',
      content: 'hello from group',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700001001,
    });

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    await handleAdminCommand(db, messenger, 'allow', 'phone', '15551234567', ADMIN_CHAT_JID, handleMessageFn);

    const replayedMsgIds = handleMessageFn.mock.calls.map((c: any[]) => c[0].messageId as string);
    expect(replayedMsgIds).toContain('dm-msg-group-test-001');
    expect(replayedMsgIds).not.toContain('group-msg-group-test-001');
    expect(handleMessageFn).toHaveBeenCalledTimes(1);
  });

  it('group messages do not consume the replay cap', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 1;
    (config as any).adminReplayDelayMs = 0;

    const db = openDb();
    const messenger = makeMockMessenger();

    // Older DM — should survive even with cap=1 because the group message is filtered out first
    storeMessageIfNew(db, {
      chatJid: '11111111111@s.whatsapp.net',
      conversationKey: '11111111111',
      senderJid: '11111111111@s.whatsapp.net',
      senderName: 'CapTestUser',
      messageId: 'cap-dm-msg-001',
      content: 'older dm',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700002000,
    });

    // Newer group message — must NOT consume the cap slot
    storeMessageIfNew(db, {
      chatJid: '120363555555555000@g.us',
      conversationKey: '120363555555555000',
      senderJid: '11111111111@s.whatsapp.net',
      senderName: 'CapTestUser',
      messageId: 'cap-group-msg-001',
      content: 'group message',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700002001,
    });

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    await handleAdminCommand(db, messenger, 'allow', 'phone', '11111111111', ADMIN_CHAT_JID, handleMessageFn);

    const replayedMsgIds = handleMessageFn.mock.calls.map((c: any[]) => c[0].messageId as string);
    // DM must be replayed despite cap=1 (group did not consume the slot)
    expect(replayedMsgIds).toContain('cap-dm-msg-001');
    // Group must never be dispatched
    expect(replayedMsgIds).not.toContain('cap-group-msg-001');
    expect(handleMessageFn).toHaveBeenCalledTimes(1);
  });
});
