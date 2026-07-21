import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ADMIN_ID, PEER_ID, PEER_PHONE } = vi.hoisted(() => ({
  ADMIN_ID: 'appleid@example.com',
  PEER_ID: 'sender@bb.example.test',
  PEER_PHONE: '+15551230008',
}));

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set([ADMIN_ID]),
    adminReplayMax: 5,
    adminReplayDelayMs: 0,
    transport: 'imessage',
    accessMode: 'allowlist',
    siblingPhones: new Set(),
    groupSenderPolicy: 'any_member',
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { Database } from '../../src/core/database.ts';
import { config } from '../../src/config.ts';
import { handleAdminCommand, sendApprovalRequest } from '../../src/core/admin.ts';
import { insertPending, lookupAccess } from '../../src/core/access-list.ts';
import { isAdminMessage, parseAdminCommand } from '../../src/core/command-router.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';
import { toImessageJid } from '../../src/core/jid-constants.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';

function messenger() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

describe('iMessage access identity round trip', () => {
  let db: Database;

  beforeEach(() => {
    config.adminPhones.clear();
    config.adminPhones.add(ADMIN_ID);
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('recognizes an AppleID admin and parses a canonical AppleID approval command', () => {
    expect(isAdminMessage({
      messageId: 'admin-imessage-1',
      chatJid: `${ADMIN_ID}@imessage`,
      senderJid: `${ADMIN_ID}@imessage`,
      senderName: null,
      content: `ALLOW ${PEER_ID}`,
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      isGroup: false,
      mentionedJids: [],
      timestamp: 1,
      quotedMessageId: null,
      isResponseWorthy: true,
    }, db)).toBe(true);
    expect(parseAdminCommand('ALLOW Sender@BB.Example.Test')).toEqual({
      action: 'allow', subjectType: 'phone', subjectId: PEER_ID,
    });
  });

  it('routes the first AppleID approval prompt to the configured iMessage admin', async () => {
    const mockMessenger = messenger();

    await sendApprovalRequest(db, mockMessenger, PEER_ID, 'Peer', 'hello');

    expect(lookupAccess(db, 'phone', PEER_ID)?.status).toBe('pending');
    expect(mockMessenger.sendMessage).toHaveBeenCalledWith(
      `${ADMIN_ID}@imessage`,
      expect.stringContaining(`ALLOW ${PEER_ID}`),
    );
  });

  it('preserves an iMessage +E.164 pending key and prompt', async () => {
    const mockMessenger = messenger();

    await sendApprovalRequest(db, mockMessenger, PEER_PHONE, 'Phone Peer', 'hello');

    expect(lookupAccess(db, 'phone', PEER_PHONE)?.status).toBe('pending');
    expect(lookupAccess(db, 'phone', PEER_PHONE.slice(1))).toBeNull();
    expect(mockMessenger.sendMessage).toHaveBeenCalledWith(
      `${ADMIN_ID}@imessage`,
      expect.stringContaining(`ALLOW ${PEER_PHONE}`),
    );
  });

  it('rejects digit-only iMessage approvals that cannot match a canonical +E.164 pending key', () => {
    expect(parseAdminCommand(`ALLOW ${PEER_PHONE.slice(1)}`)).toBeNull();
  });

  it('does not grant iMessage admin privileges to the same phone on another namespace', () => {
    config.adminPhones.clear();
    config.adminPhones.add(PEER_PHONE);
    const message = (senderJid: string) => ({
      messageId: `admin-${senderJid}`,
      chatJid: senderJid,
      senderJid,
      senderName: null,
      content: 'ALLOW +15551230009',
      contentText: null,
      contentType: 'text' as const,
      isFromMe: false,
      isGroup: false,
      mentionedJids: [],
      timestamp: 1,
      quotedMessageId: null,
      isResponseWorthy: true,
    });

    expect(isAdminMessage(message(`${PEER_PHONE}@imessage`), db)).toBe(true);
    expect(isAdminMessage(message(`${PEER_PHONE}@signal`), db)).toBe(false);
    expect(isAdminMessage(message(`${PEER_PHONE.slice(1)}@s.whatsapp.net`), db)).toBe(false);
  });

  it('uses exact AppleID matching when selecting the admin chat', async () => {
    const wildcardAdmin = 'admin_test@example.com';
    config.adminPhones.clear();
    config.adminPhones.add(wildcardAdmin);
    const insert = db.raw.prepare(
      `INSERT INTO messages
         (message_id, chat_jid, conversation_key, sender_jid, sender_name,
          content, content_type, is_from_me, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    insert.run(
      'admin-exact', `${wildcardAdmin}@imessage`, wildcardAdmin,
      `${wildcardAdmin}@imessage`, 'Admin', 'hello', 'text', 100,
    );
    insert.run(
      'admin-decoy', 'adminXtest@example.com@imessage', 'adminXtest@example.com',
      'adminXtest@example.com@imessage', 'Decoy', 'hello', 'text', 200,
    );
    const mockMessenger = messenger();

    await sendApprovalRequest(db, mockMessenger, PEER_ID, 'Peer', 'private preview');

    expect(mockMessenger.sendMessage).toHaveBeenCalledWith(
      `${wildcardAdmin}@imessage`,
      expect.stringContaining('private preview'),
    );
  });

  it.each([
    { identity: PEER_ID, messageId: 'queued-imessage-email' },
    { identity: PEER_PHONE, messageId: 'queued-imessage-phone' },
  ])('allows and replays a pending iMessage identity without cross-transport normalization', async ({ identity, messageId }) => {
    insertPending(db, 'phone', identity, 'Peer');
    const providerIdentity = identity === PEER_ID ? 'Sender@BB.Example.Test' : identity;
    const senderJid = toImessageJid(providerIdentity);
    storeMessageIfNew(db, {
      chatJid: senderJid,
      conversationKey: identity,
      senderJid,
      senderName: 'Peer',
      messageId,
      content: 'queued',
      contentType: 'text',
      isFromMe: false,
      timestamp: 100,
    });
    const handleMessage = vi.fn().mockResolvedValue(undefined);

    await handleAdminCommand(
      db,
      messenger(),
      'allow',
      'phone',
      identity,
      `${ADMIN_ID}@imessage`,
      handleMessage,
    );

    expect(lookupAccess(db, 'phone', identity)?.status).toBe('allowed');
    expect(senderJid).toBe(`${identity}@imessage`);
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId }));
    expect(shouldRespond({
      messageId: `${messageId}-next`,
      chatJid: senderJid,
      senderJid,
      senderName: 'Peer',
      content: 'next',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      isGroup: false,
      mentionedJids: [],
      timestamp: 101,
      quotedMessageId: null,
      isResponseWorthy: true,
    }, `${ADMIN_ID}@imessage`, null, db)).toMatchObject({
      respond: true,
      reason: 'dm_allowed',
    });
  });
});
