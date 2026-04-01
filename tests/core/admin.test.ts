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
import { storeMessage } from '../../src/core/messages.ts';
import { insertPending, lookupAccess } from '../../src/core/access-list.ts';
import {
  handleAdminCommand,
  sendApprovalRequest,
} from '../../src/core/admin.ts';
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

    storeMessage(db, {
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
