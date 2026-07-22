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
import { storeMessageIfNew, type StoredMessage } from '../../src/core/messages.ts';
import { insertPending, lookupAccess } from '../../src/core/access-list.ts';
import {
  handleAdminCommand,
  handleFallbackCommand,
  handleGrantCommand,
  sendApprovalRequest,
} from '../../src/core/admin.ts';
import type { CapabilityGrantManager } from '../../src/lib/capability-grant.ts';
import * as adminModule from '../../src/core/admin.ts';
import type { Runtime } from '../../src/runtimes/types.ts';
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
    insertPending(db, 'phone', '15551230008', 'Test User');

    await handleAdminCommand(db, messenger, 'allow', 'phone', '15551230008', ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    const entry = lookupAccess(db, 'phone', '15551230008');
    expect(entry!.status).toBe('allowed');
  });

  it('sends confirmation to the admin chatJid', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await handleAdminCommand(db, messenger, 'allow', 'phone', '15551230008', ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    expect(messenger.sendMessage).toHaveBeenCalledWith(ADMIN_CHAT_JID, expect.stringContaining('15551230008'));
  });

  it('processes queued messages for the newly allowed sender', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    storeMessageIfNew(db, {
      chatJid: '15551230008@s.whatsapp.net',
      conversationKey: '15551230008',
      senderJid: '15551230008@s.whatsapp.net',
      senderName: 'Queued User',
      messageId: 'queued-msg-001',
      content: 'pending content',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700000000,
    });

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    await handleAdminCommand(db, messenger, 'allow', 'phone', '15551230008', ADMIN_CHAT_JID, handleMessageFn);

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
    insertPending(db, 'phone', '15551230008', 'BlockMe');

    await handleAdminCommand(db, messenger, 'block', 'phone', '15551230008', ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    expect(lookupAccess(db, 'phone', '15551230008')!.status).toBe('blocked');
  });

  it('sends confirmation to admin', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await handleAdminCommand(db, messenger, 'block', 'phone', '15551230008', ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined));

    expect(messenger.sendMessage).toHaveBeenCalledWith(ADMIN_CHAT_JID, expect.stringContaining('Blocked'));
  });

  it('does NOT replay queued messages', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    const handleMessageFn = vi.fn();

    await handleAdminCommand(db, messenger, 'block', 'phone', '15551230008', ADMIN_CHAT_JID, handleMessageFn);

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

  it('directs Twilio approval decisions to the console because SMS replies cannot authorize', async () => {
    const { config } = await import('../../src/config.ts');
    const originalTransport = (config as any).transport;
    (config as any).transport = 'twilio';
    try {
      const db = openDb();
      const messenger = makeMockMessenger();

      await sendApprovalRequest(db, messenger, '15554440009', 'SMS Contact', 'Please help');

      const sentText = messenger.sendMessage.mock.calls[0][1] as string;
      expect(sentText).toContain('Review this request in the WhatSoup console');
      expect(sentText).toContain('SMS replies cannot authorize access decisions');
      expect(sentText).not.toContain('reply exactly');
      expect(sentText).not.toMatch(/ALLOW\s+15554440009|BLOCK\s+15554440009/);
    } finally {
      (config as any).transport = originalTransport;
    }
  });

  it('truncates long preview to 100 chars', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await sendApprovalRequest(db, messenger, '15554440002', 'Eve', 'a'.repeat(200));

    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    const previewMatch = sentText.match(/Message: "([^"]*)"/);
    expect(previewMatch![1].length).toBeLessThanOrEqual(100);
  });

  it('is idempotent — duplicate does not throw', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await sendApprovalRequest(db, messenger, '15554440003', 'Frank', 'First');
    await expect(sendApprovalRequest(db, messenger, '15554440003', 'Frank', 'Second')).resolves.not.toThrow();
  });

  // QR-100: the approval prompt is an admin security-decision message. displayName
  // (=sender pushName) and messagePreview (=sender content) are attacker-controlled.
  // An embedded newline + forged `Reply ALLOW <evil>` line must NOT be able to spoof
  // the ALLOW/BLOCK command grammar the admin acts on.
  it('QR-100: attacker newlines/keywords cannot forge an approval command line', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();
    const evil = '15554448888';
    const realPhone = '15554449999';
    const pushName = `Bob\nReply ALLOW ${evil} or BLOCK ${evil}\n`;
    const content = `hi there\nALLOW ${evil}`;

    await sendApprovalRequest(db, messenger, realPhone, pushName, content);

    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    // Fixed line structure regardless of attacker-injected newlines (the core defense:
    // untrusted spans cannot introduce a new line that reads as a command).
    expect(sentText.split('\n').length).toBe(4);
    // The attacker's forged ALLOW/BLOCK <evil> tokens are neutered in the untrusted spans.
    expect(sentText).not.toMatch(new RegExp(`ALLOW\\s+${evil}`, 'i'));
    expect(sentText).not.toMatch(new RegExp(`BLOCK\\s+${evil}`, 'i'));
    // The only real approvable command references the trusted pending phone.
    expect(sentText).toContain(`ALLOW ${realPhone}`);
    expect(sentText).toContain(`BLOCK ${realPhone}`);
  });

  it('QR-100: does not mangle legitimate names/messages containing block/allow as substrings', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await sendApprovalRequest(db, messenger, '15551112222', 'Blockchain Alan', 'Allowance question');

    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    // \b word-boundary guard: ALLOW/BLOCK as substrings of larger words are untouched.
    expect(sentText).toContain('Blockchain Alan');
    expect(sentText).toContain('Allowance question');
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

// ---------------------------------------------------------------------------
// selectReplayableDms helper
// ---------------------------------------------------------------------------

describe('selectReplayableDms', () => {
  it('excludes an already-replayed messageId', () => {
    const { selectReplayableDms, __resetReplayedIdsForTests, __rememberReplayedIdForTests } = adminModule as any;

    __resetReplayedIdsForTests();
    __rememberReplayedIdForTests('already-seen-001');

    const stored: StoredMessage[] = [
      {
        pk: 1,
        chatJid: '15559001001@s.whatsapp.net',
        conversationKey: '15559001001',
        senderJid: '15559001001@s.whatsapp.net',
        senderName: 'TestUser',
        messageId: 'already-seen-001',
        content: 'already replayed',
        contentType: 'text',
        isFromMe: false,
        timestamp: 1700010000,
        quotedMessageId: null,
        enrichmentProcessedAt: null,
        enrichmentRetries: 0,
        createdAt: '2023-01-01T00:00:00.000Z',
        mediaPath: null,
        contentText: null,
      },
      {
        pk: 2,
        chatJid: '15559001001@s.whatsapp.net',
        conversationKey: '15559001001',
        senderJid: '15559001001@s.whatsapp.net',
        senderName: 'TestUser',
        messageId: 'fresh-msg-001',
        content: 'not yet replayed',
        contentType: 'text',
        isFromMe: false,
        timestamp: 1700010001,
        quotedMessageId: null,
        enrichmentProcessedAt: null,
        enrichmentRetries: 0,
        createdAt: '2023-01-01T00:00:01.000Z',
        mediaPath: null,
        contentText: null,
      },
    ];

    const result = selectReplayableDms(stored, 10);
    const ids = result.toReplay.map((m: any) => m.messageId as string);
    expect(ids).not.toContain('already-seen-001');
    expect(ids).toContain('fresh-msg-001');
    expect(result.groupSkipped).toBe(0);
  });

  it('reports groupSkipped count for every transport group chatJid', () => {
    const { selectReplayableDms, __resetReplayedIdsForTests } = adminModule as any;

    __resetReplayedIdsForTests();

    const stored: StoredMessage[] = [
      {
        pk: 3,
        chatJid: '15559002001@s.whatsapp.net',
        conversationKey: '15559002001',
        senderJid: '15559002001@s.whatsapp.net',
        senderName: 'TestUser2',
        messageId: 'dm-helper-001',
        content: 'dm content',
        contentType: 'text',
        isFromMe: false,
        timestamp: 1700020000,
        quotedMessageId: null,
        enrichmentProcessedAt: null,
        enrichmentRetries: 0,
        createdAt: '2023-01-01T00:00:00.000Z',
        mediaPath: null,
        contentText: null,
      },
      {
        pk: 4,
        chatJid: '120363555555555000@g.us',
        conversationKey: '120363555555555000',
        senderJid: '15559002001@s.whatsapp.net',
        senderName: 'TestUser2',
        messageId: 'group-helper-001',
        content: 'group content',
        contentType: 'text',
        isFromMe: false,
        timestamp: 1700020001,
        quotedMessageId: null,
        enrichmentProcessedAt: null,
        enrichmentRetries: 0,
        createdAt: '2023-01-01T00:00:01.000Z',
        mediaPath: null,
        contentText: null,
      },
      {
        pk: 5,
        chatJid: 'Z3JvdXAtY29udmVyc2F0aW9u@signal',
        conversationKey: 'signal-group-helper',
        senderJid: '+15559002001@signal',
        senderName: 'SignalGroupUser',
        messageId: 'signal-group-helper-001',
        content: 'signal group content',
        contentType: 'text',
        isFromMe: false,
        timestamp: 1700020002,
        quotedMessageId: null,
        enrichmentProcessedAt: null,
        enrichmentRetries: 0,
        createdAt: '2023-01-01T00:00:02.000Z',
        mediaPath: null,
        contentText: null,
      },
      {
        pk: 6,
        chatJid: 'iMessage;+;group-helper@imessage',
        conversationKey: 'imessage-group-helper',
        senderJid: 'sender@example.test@imessage',
        senderName: 'ImessageGroupUser',
        messageId: 'imessage-group-helper-001',
        content: 'imessage group content',
        contentType: 'text',
        isFromMe: false,
        timestamp: 1700020003,
        quotedMessageId: null,
        enrichmentProcessedAt: null,
        enrichmentRetries: 0,
        createdAt: '2023-01-01T00:00:03.000Z',
        mediaPath: null,
        contentText: null,
      },
    ];

    const result = selectReplayableDms(stored, 10);
    const ids = result.toReplay.map((m: any) => m.messageId as string);
    expect(ids).toContain('dm-helper-001');
    expect(ids).not.toContain('group-helper-001');
    expect(ids).not.toContain('signal-group-helper-001');
    expect(ids).not.toContain('imessage-group-helper-001');
    expect(result.groupSkipped).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Admin notice wording — groupSkipped>0 path
// ---------------------------------------------------------------------------

describe('handleAdminCommand ALLOW — admin notice wording', () => {
  it('appends group-skipped suffix to the notice when group messages are present', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 10;
    (config as any).adminReplayDelayMs = 0;

    const db = openDb();
    const messenger = makeMockMessenger();

    // One DM
    storeMessageIfNew(db, {
      chatJid: '15558880001@s.whatsapp.net',
      conversationKey: '15558880001',
      senderJid: '15558880001@s.whatsapp.net',
      senderName: 'NoticeUser',
      messageId: 'notice-dm-001',
      content: 'dm',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700030000,
    });

    // One group message from same sender
    storeMessageIfNew(db, {
      chatJid: '120363555555555000@g.us',
      conversationKey: '120363555555555000',
      senderJid: '15558880001@s.whatsapp.net',
      senderName: 'NoticeUser',
      messageId: 'notice-group-001',
      content: 'group',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700030001,
    });

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    await handleAdminCommand(db, messenger, 'allow', 'phone', '15558880001', ADMIN_CHAT_JID, handleMessageFn);

    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    // Should say "1 of 1 queued DM messages" (totalQueued = DM count after filter)
    expect(sentText).toContain('replaying 1 of 1 queued DM messages');
    // Must include the group-skipped annotation
    expect(sentText).toContain('1 group message');
  });

  it('keeps original notice wording when no group messages are present', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 10;
    (config as any).adminReplayDelayMs = 0;

    const db = openDb();
    const messenger = makeMockMessenger();

    storeMessageIfNew(db, {
      chatJid: '15558880002@s.whatsapp.net',
      conversationKey: '15558880002',
      senderJid: '15558880002@s.whatsapp.net',
      senderName: 'NoGroupUser',
      messageId: 'notice-dm-only-001',
      content: 'dm only',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700031000,
    });

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    await handleAdminCommand(db, messenger, 'allow', 'phone', '15558880002', ADMIN_CHAT_JID, handleMessageFn);

    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('replaying 1 of 1 queued messages');
    // Must NOT include the group suffix
    expect(sentText).not.toContain('group message');
  });
});

// ---------------------------------------------------------------------------
// admin.ts uncovered-branch coverage
// ---------------------------------------------------------------------------

describe('admin.ts uncovered-branch coverage', () => {
  // Helper: minimal Runtime stub with only the surface area handleFallbackCommand touches.
  function makeRuntime(overrides: Partial<Runtime> = {}): Runtime {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      getHealthSnapshot: vi.fn().mockReturnValue({ ok: true, checks: {} } as any),
      shutdown: vi.fn().mockResolvedValue(undefined),
      setDurability: vi.fn(),
      ...overrides,
    } as Runtime;
  }

  // ----- handleAdminCommand — normalize-mismatch path (10-digit subject) -----

  it('ALLOW with 10-digit subject flips the full-digit access row (normalize mismatch path)', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 10;
    (config as any).adminReplayDelayMs = 0;

    const db = openDb();
    const messenger = makeMockMessenger();
    // Pending row stored under the FULL E.164 key the resolver produces.
    insertPending(db, 'phone', '15551230010', 'MismatchUser');

    // Admin types the 10-digit form — normalizePhoneE164 !== subjectId.
    await handleAdminCommand(
      db, messenger, 'allow', 'phone', '5551230010',
      ADMIN_CHAT_JID, vi.fn().mockResolvedValue(undefined),
    );

    const entry = lookupAccess(db, 'phone', '15551230010');
    expect(entry!.status).toBe('allowed');
  });

  // ----- handleAdminCommand — LID reverse-lookup path -----

  it('ALLOW replays messages stored under a LID JID that maps to the allowed phone', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 10;
    (config as any).adminReplayDelayMs = 0;

    const db = openDb();
    const messenger = makeMockMessenger();

    // Seed a LID→phone mapping directly into lid_mappings.
    db.raw.prepare(
      "INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))",
    ).run('1555999001', '15557770010@s.whatsapp.net');

    // Queue an inbound message whose sender_jid is the LID JID.
    storeMessageIfNew(db, {
      chatJid: '1555999001@lid',
      conversationKey: '1555999001',
      senderJid: '1555999001@lid',
      senderName: 'LidUser',
      messageId: 'lid-replay-001',
      content: 'via lid',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700040000,
    });

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    await handleAdminCommand(
      db, messenger, 'allow', 'phone', '15557770010',
      ADMIN_CHAT_JID, handleMessageFn,
    );

    const replayed = handleMessageFn.mock.calls.map((c: any[]) => c[0].messageId as string);
    expect(replayed).toContain('lid-replay-001');
  });

  // ----- handleAdminCommand — SMS-stored queued message path -----

  it('ALLOW replays messages stored under the +<digits>@sms sender form', async () => {
    const { config } = await import('../../src/config.ts');
    (config as any).adminReplayMax = 10;
    (config as any).adminReplayDelayMs = 0;

    const db = openDb();
    const messenger = makeMockMessenger();

    // Queue an inbound whose sender_jid is the SMS form.
    storeMessageIfNew(db, {
      chatJid: '+15556660010@s.whatsapp.net',
      conversationKey: '15556660010',
      senderJid: '+15556660010@sms',
      senderName: 'SmsUser',
      messageId: 'sms-replay-001',
      content: 'via sms',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700050000,
    });

    const handleMessageFn = vi.fn().mockResolvedValue(undefined);
    await handleAdminCommand(
      db, messenger, 'allow', 'phone', '15556660010',
      ADMIN_CHAT_JID, handleMessageFn,
    );

    const replayed = handleMessageFn.mock.calls.map((c: any[]) => c[0].messageId as string);
    expect(replayed).toContain('sms-replay-001');
  });

  // ----- resolveAdminChatJid — SMS-row path (via sendApprovalRequest) -----

  it('sendApprovalRequest resolves the admin JID from an SMS sender row', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    // Store an inbound message whose chat_jid/sender_jid is the admin's SMS JID.
    storeMessageIfNew(db, {
      chatJid: '+15550100001@s.whatsapp.net',
      conversationKey: '15550100001',
      senderJid: '+15550100001@sms',
      senderName: 'AdminSms',
      messageId: 'admin-sms-row-001',
      content: 'hi',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700060000,
    });

    await sendApprovalRequest(db, messenger, '15550000999', 'SmsResolved', 'hello');

    // Admin JID must be the SMS row's chat_jid.
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      '+15550100001@s.whatsapp.net',
      expect.stringContaining('SmsResolved'),
    );
  });

  // ----- resolveAdminChatJid — WhatsApp LIKE-prefix path -----

  it('sendApprovalRequest resolves the admin JID from a WhatsApp sender LIKE match', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    storeMessageIfNew(db, {
      chatJid: '15550100001@s.whatsapp.net',
      conversationKey: '15550100001',
      senderJid: '15550100001@s.whatsapp.net',
      senderName: 'AdminWa',
      messageId: 'admin-wa-row-001',
      content: 'hi',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700060001,
    });

    await sendApprovalRequest(db, messenger, '15550000888', 'WaResolved', 'hi');

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      '15550100001@s.whatsapp.net',
      expect.stringContaining('WaResolved'),
    );
  });

  // ----- resolveAdminChatJid — LID-row path -----

  it('sendApprovalRequest resolves the admin JID via a LID that maps to an admin phone', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    // Map a LID to the admin phone.
    db.raw.prepare(
      "INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))",
    ).run('1555777001', '15550100001@s.whatsapp.net');

    // Store a message whose sender_jid is the LID JID form.
    storeMessageIfNew(db, {
      chatJid: '1555777001@lid',
      conversationKey: '1555777001',
      senderJid: '1555777001@lid',
      senderName: 'AdminLid',
      messageId: 'admin-lid-row-001',
      content: 'hi',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1700060002,
    });

    await sendApprovalRequest(db, messenger, '15550000777', 'LidResolved', 'hi');

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      '1555777001@lid',
      expect.stringContaining('LidResolved'),
    );
  });

  // ----- resolveAdminChatJid — no admin phones → returns null → no send -----

  it('sendApprovalRequest does not send when config.adminPhones is empty', async () => {
    const { config } = await import('../../src/config.ts');
    const original = (config as any).adminPhones;
    (config as any).adminPhones = new Set<string>();
    try {
      const db = openDb();
      const messenger = makeMockMessenger();

      await sendApprovalRequest(db, messenger, '15550000666', 'NoAdmin', 'hi');

      expect(messenger.sendMessage).not.toHaveBeenCalled();
      // The pending row IS still inserted — assert that concretely.
      const entry = lookupAccess(db, 'phone', '15550000666');
      expect(entry!.status).toBe('pending');
    } finally {
      (config as any).adminPhones = original;
    }
  });

  // ----- resolveAdminChatJid — twilio fallback synthesis -----

  it('sendApprovalRequest synthesises a +<digits>@sms admin JID on the twilio transport', async () => {
    const { config } = await import('../../src/config.ts');
    const originalTransport = (config as any).transport;
    (config as any).transport = 'twilio';
    try {
      const db = openDb();
      const messenger = makeMockMessenger();

      await sendApprovalRequest(db, messenger, '15550000555', 'TwilioResolved', 'hi');

      // Synthesized JID is the @sms form of the first admin phone.
      const sentTarget = messenger.sendMessage.mock.calls[0][0] as string;
      expect(sentTarget).toBe('+15550100001@sms');
      expect(messenger.sendMessage).toHaveBeenCalledWith(
        '+15550100001@sms',
        expect.stringContaining('TwilioResolved'),
      );
    } finally {
      (config as any).transport = originalTransport;
    }
  });

  // ----- resolveAdminChatJid — personal JID fallback (default transport) -----

  it('sendApprovalRequest synthesises a personal @s.whatsapp.net admin JID by default', async () => {
    const db = openDb();
    const messenger = makeMockMessenger();

    await sendApprovalRequest(db, messenger, '15550000444', 'PersonalResolved', 'hi');

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      '15550100001@s.whatsapp.net',
      expect.stringContaining('PersonalResolved'),
    );
  });

  // ----- handleFallbackCommand — help -----

  it('handleFallbackCommand help replies with the fallback command summary', async () => {
    const runtime = makeRuntime();
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'help' }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('FALLBACK ON');
    expect(sentText).toContain('FALLBACK OFF');
  });

  // ----- handleFallbackCommand — status (unsupported) -----

  it('handleFallbackCommand status on a runtime without getFallbackState replies "not supported"', async () => {
    const runtime = makeRuntime(); // no getFallbackState
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'status' }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('not supported');
  });

  // ----- handleFallbackCommand — status (supported, with chain + probes + activations + cost) -----

  it('handleFallbackCommand status reports provider, window, chain, probes, activations and cost', async () => {
    const runtime = makeRuntime({
      getFallbackState: () => ({
        effectiveProvider: 'fallback-provider',
        fallbackActiveUntil: Date.now() + 120 * 60_000, // 2h → hours branch of formatRelativeWindow
        fallbackTurnsServed: 3,
        fallbackTurnsEmpty: 1,
        lastFallbackTurnAt: null,
        probeAttempts: 2,
        fallbackActivations: 4,
        fallbackReverts: 2,
        fallbackWindowCostUsd: 1.5,
        fallbackChain: [
          { provider: 'openai', model: 'gpt-4', eligible: true },
          { provider: 'anthropic', model: null as any, eligible: false },
          { provider: 'google', model: 'gemini', eligible: null as any },
        ] as any,
      }),
    });
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'status' }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('Provider: fallback-provider');
    expect(sentText).toContain('chain:');
    expect(sentText).toContain('openai gpt-4 (ready)');
    expect(sentText).toContain('anthropic (unavailable)');
    expect(sentText).toContain('google gemini (unknown)');
    expect(sentText).toContain('probes: 2');
    expect(sentText).toContain('activations: 4');
    expect(sentText).toContain('reverts: 2');
    expect(sentText).toContain('window cost: $1.50');
    // hours branch: 120 minutes rounds to ≈2h
    expect(sentText).toMatch(/≈2h/);
  });

  // ----- handleFallbackCommand — status (supported, minutes window, no chain, no probes/activations/cost) -----

  it('handleFallbackCommand status uses minutes window and omits absent counters', async () => {
    const runtime = makeRuntime({
      getFallbackState: () => ({
        effectiveProvider: 'primary',
        fallbackActiveUntil: Date.now() + 10 * 60_000, // 10min → minutes branch
        fallbackTurnsServed: 0,
        fallbackTurnsEmpty: 0,
        lastFallbackTurnAt: null,
        fallbackChain: [] as any,
      }),
    });
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'status' }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('Provider: primary');
    expect(sentText).toMatch(/≈10m/);
    expect(sentText).not.toContain('probes:');
    expect(sentText).not.toContain('activations:');
    expect(sentText).not.toContain('window cost:');
  });

  // ----- handleFallbackCommand — status with no active window → window: none -----

  it('handleFallbackCommand status reports window "none" when no fallback is active', async () => {
    const runtime = makeRuntime({
      getFallbackState: () => ({
        effectiveProvider: 'primary',
        fallbackActiveUntil: null,
        fallbackTurnsServed: 0,
        fallbackTurnsEmpty: 0,
        lastFallbackTurnAt: null,
      }),
    });
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'status' }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('window: none');
  });

  // ----- handleFallbackCommand — on (unsupported) -----

  it('handleFallbackCommand ON on a runtime without forceFallback replies "not supported"', async () => {
    const runtime = makeRuntime(); // no forceFallback
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'on' }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('not supported');
  });

  // ----- handleFallbackCommand — on (failed) -----

  it('handleFallbackCommand ON forwards the failure reason when forceFallback returns !ok', async () => {
    const runtime = makeRuntime({
      forceFallback: vi.fn().mockReturnValue({ ok: false, reason: 'cooldown active' }),
    });
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'on', durationMs: 60_000 }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('Cannot force fallback');
    expect(sentText).toContain('cooldown active');
    expect(runtime.forceFallback).toHaveBeenCalledWith(60_000);
  });

  // ----- handleFallbackCommand — on (ok, clamped) -----

  it('handleFallbackCommand ON reports clamping when forceFallback clamps the duration', async () => {
    const until = Date.now() + 3_600_000;
    const runtime = makeRuntime({
      forceFallback: vi.fn().mockReturnValue({ ok: true, activeUntil: until, clamped: true }),
    });
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'on' }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('Fallback forced until');
    expect(sentText).toContain('duration clamped');
  });

  // ----- handleFallbackCommand — on (ok, not clamped) -----

  it('handleFallbackCommand ON does not mention clamping when forceFallback is not clamped', async () => {
    const until = Date.now() + 1_800_000;
    const runtime = makeRuntime({
      forceFallback: vi.fn().mockReturnValue({ ok: true, activeUntil: until, clamped: false }),
    });
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'on', durationMs: 1_800_000 }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('Fallback forced until');
    expect(sentText).not.toContain('clamped');
  });

  // ----- handleFallbackCommand — off (unsupported) -----

  it('handleFallbackCommand OFF on a runtime without disableFallback replies "not supported"', async () => {
    const runtime = makeRuntime(); // no disableFallback
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'off' }, ADMIN_CHAT_JID,
    );
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('not supported');
  });

  // ----- handleFallbackCommand — off (ok) -----

  it('handleFallbackCommand OFF disables fallback and confirms to the admin', async () => {
    const disableFallback = vi.fn().mockReturnValue({ ok: true });
    const runtime = makeRuntime({ disableFallback });
    const messenger = makeMockMessenger();
    await handleFallbackCommand(
      runtime, messenger, { action: 'fallback', sub: 'off' }, ADMIN_CHAT_JID,
    );
    expect(disableFallback).toHaveBeenCalledOnce();
    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('Fallback disabled');
    expect(sentText).toContain('primary provider active');
  });
});

// ---------------------------------------------------------------------------
// handleGrantCommand
// ---------------------------------------------------------------------------

describe('handleGrantCommand', () => {
  function mgr(overrides: Partial<CapabilityGrantManager> = {}): CapabilityGrantManager {
    return {
      arm: vi.fn(),
      disarm: vi.fn(),
      status: vi.fn(),
      reconcile: vi.fn(),
      stop: vi.fn(),
      ...overrides,
    } as unknown as CapabilityGrantManager;
  }

  it('help replies with the grant command summary', async () => {
    const messenger = makeMockMessenger();
    await handleGrantCommand(mgr(), messenger, { action: 'grant', sub: 'help' }, ADMIN_CHAT_JID);
    const t = messenger.sendMessage.mock.calls[0][1] as string;
    expect(t).toContain('GRANT');
    expect(t).toContain('DISARM');
  });

  it('arm success replies with the granted capabilities and expiry', async () => {
    const messenger = makeMockMessenger();
    const arm = vi.fn().mockResolvedValue({ ok: true, record: { capabilities: ['camera.snap'], expiresAtMs: 1_900_000_000_000 } });
    await handleGrantCommand(mgr({ arm }), messenger, { action: 'grant', sub: 'arm', group: 'camera', durationMs: 60_000 }, ADMIN_CHAT_JID);
    expect(arm).toHaveBeenCalledWith('camera', 60_000, { isOwner: true });
    const t = messenger.sendMessage.mock.calls[0][1] as string;
    expect(t).toContain("Granted 'camera'");
    expect(t).toContain('auto-reverts');
  });

  it('arm on an unknown group relays the manager error, not a success', async () => {
    const messenger = makeMockMessenger();
    const arm = vi.fn().mockResolvedValue({ ok: false, error: 'unknown group: nope' });
    await handleGrantCommand(mgr({ arm }), messenger, { action: 'grant', sub: 'arm', group: 'nope' }, ADMIN_CHAT_JID);
    const t = messenger.sendMessage.mock.calls[0][1] as string;
    expect(t).toContain("Cannot grant 'nope'");
    expect(t).toContain('unknown group');
  });

  it('arm with no duration passes null (manual grant)', async () => {
    const messenger = makeMockMessenger();
    const arm = vi.fn().mockResolvedValue({ ok: true, record: { capabilities: ['x'], expiresAtMs: null } });
    await handleGrantCommand(mgr({ arm }), messenger, { action: 'grant', sub: 'arm', group: 'g' }, ADMIN_CHAT_JID);
    expect(arm).toHaveBeenCalledWith('g', null, { isOwner: true });
    expect(messenger.sendMessage.mock.calls[0][1] as string).toContain('manual (no expiry)');
  });

  it('disarm relays a distinguishable "not authorized" (never claims success)', async () => {
    const messenger = makeMockMessenger();
    const disarm = vi.fn().mockResolvedValue({ changed: false, removed: [], restored: [], reason: 'unauthorized' });
    await handleGrantCommand(mgr({ disarm }), messenger, { action: 'grant', sub: 'disarm' }, ADMIN_CHAT_JID);
    expect(messenger.sendMessage.mock.calls[0][1] as string).toContain('Not authorized');
  });

  it('disarm success reports what was reverted', async () => {
    const messenger = makeMockMessenger();
    const disarm = vi.fn().mockResolvedValue({ changed: true, removed: ['camera.snap'], restored: [], reason: 'manual' });
    await handleGrantCommand(mgr({ disarm }), messenger, { action: 'grant', sub: 'disarm' }, ADMIN_CHAT_JID);
    expect(messenger.sendMessage.mock.calls[0][1] as string).toContain('reverted');
  });

  it('status when not armed', async () => {
    const messenger = makeMockMessenger();
    const status = vi.fn().mockResolvedValue({ armed: false });
    await handleGrantCommand(mgr({ status }), messenger, { action: 'grant', sub: 'status' }, ADMIN_CHAT_JID);
    expect(messenger.sendMessage.mock.calls[0][1] as string).toContain('No capability grant active');
  });

  it('status when armed reports the group and capabilities', async () => {
    const messenger = makeMockMessenger();
    const status = vi.fn().mockResolvedValue({ armed: true, group: 'camera', capabilities: ['camera.snap'], remainingMs: 120_000 });
    await handleGrantCommand(mgr({ status }), messenger, { action: 'grant', sub: 'status' }, ADMIN_CHAT_JID);
    const t = messenger.sendMessage.mock.calls[0][1] as string;
    expect(t).toContain('camera');
    expect(t).toContain('camera.snap');
  });
});
