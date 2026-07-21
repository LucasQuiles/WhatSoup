import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ADMIN_UUID, PEER_UUID } = vi.hoisted(() => ({
  ADMIN_UUID: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  PEER_UUID: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
}));

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set([ADMIN_UUID]),
    adminReplayMax: 5,
    adminReplayDelayMs: 0,
    transport: 'signal',
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

function messenger() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

describe('Signal access identity round trip', () => {
  let db: Database;

  beforeEach(() => {
    config.adminPhones.clear();
    config.adminPhones.add(ADMIN_UUID);
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('recognizes a configured UUID admin and parses a UUID approval command', () => {
    expect(isAdminMessage({
      messageId: 'admin-1', chatJid: `${ADMIN_UUID}@signal`, senderJid: `${ADMIN_UUID}@signal`,
      senderName: null, content: `ALLOW ${PEER_UUID}`, contentText: null, contentType: 'text',
      isFromMe: false, isGroup: false, mentionedJids: [], timestamp: 1,
      quotedMessageId: null, isResponseWorthy: true,
    }, db)).toBe(true);
    expect(parseAdminCommand(`ALLOW ${PEER_UUID}`)).toEqual({
      action: 'allow', subjectType: 'phone', subjectId: PEER_UUID,
    });
  });

  it('routes the first approval prompt to the configured Signal admin identity', async () => {
    const mockMessenger = messenger();

    await sendApprovalRequest(db, mockMessenger, PEER_UUID, 'Peer', 'hello');

    expect(lookupAccess(db, 'phone', PEER_UUID)?.status).toBe('pending');
    expect(mockMessenger.sendMessage).toHaveBeenCalledWith(
      `${ADMIN_UUID}@signal`,
      expect.stringContaining(`ALLOW ${PEER_UUID}`),
    );
  });

  it('routes a +E.164 Signal admin fallback without stripping its provider prefix', async () => {
    config.adminPhones.clear();
    config.adminPhones.add('+15550100001');
    const mockMessenger = messenger();

    await sendApprovalRequest(db, mockMessenger, PEER_UUID, 'Peer', 'hello');

    expect(mockMessenger.sendMessage).toHaveBeenCalledWith(
      '+15550100001@signal',
      expect.stringContaining(`ALLOW ${PEER_UUID}`),
    );
  });

  it('allows and replays a pending UUID without digit-normalizing its key', async () => {
    insertPending(db, 'phone', PEER_UUID, 'Peer');
    storeMessageIfNew(db, {
      chatJid: `${PEER_UUID}@signal`, conversationKey: PEER_UUID,
      senderJid: `${PEER_UUID}@signal`, senderName: 'Peer', messageId: 'peer-1',
      content: 'queued', contentType: 'text', isFromMe: false, timestamp: 100,
    });
    const handleMessage = vi.fn().mockResolvedValue(undefined);

    await handleAdminCommand(
      db, messenger(), 'allow', 'phone', PEER_UUID, `${ADMIN_UUID}@signal`, handleMessage,
    );

    expect(lookupAccess(db, 'phone', PEER_UUID)?.status).toBe('allowed');
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'peer-1' }));
  });

  it('preserves a plus-prefixed Signal E.164 access key', async () => {
    const e164 = '+15551230008';
    insertPending(db, 'phone', e164, 'Phone Peer');

    await handleAdminCommand(
      db, messenger(), 'allow', 'phone', e164, `${ADMIN_UUID}@signal`, vi.fn(),
    );

    expect(lookupAccess(db, 'phone', e164)?.status).toBe('allowed');
    expect(lookupAccess(db, 'phone', '15551230008')).toBeNull();
  });
});
