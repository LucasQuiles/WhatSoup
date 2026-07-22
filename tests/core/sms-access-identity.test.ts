/**
 * SMS allowlist/approval round-trip tests.
 *
 * Covers:
 *   1. resolvePhoneFromJid: SMS JID → digits (subject-format decision).
 *   2. resolveAdminChatJid: SMS sender row → @sms JID; no-row + twilio transport → @sms fallback.
 *   3. Integration round-trip: inbound SMS sender → shouldRespond pending/unknown →
 *      insertPending → console access decision → updateAccess → shouldRespond allowed.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Config mock — must come before any src/ imports that pull in config.ts.
// We need transport = 'twilio' for the admin fallback path tests.
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
    adminReplayDelayMs: 0,
    transport: 'twilio',
    siblingPhones: new Set(),
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
// Imports after mocks
// ---------------------------------------------------------------------------
import { Database } from '../../src/core/database.ts';
import { resolvePhoneFromJid, lookupAccess, insertPending, updateAccess } from '../../src/core/access-list.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';
import { parseAdminCommand, type AdminCommand } from '../../src/core/command-router.ts';

/** Narrow an AdminCommand to the allow/block variant (fails the test otherwise). */
function asAccessCommand(cmd: AdminCommand | null): Extract<AdminCommand, { action: 'allow' | 'block' }> {
  if (cmd === null || (cmd.action !== 'allow' && cmd.action !== 'block')) {
    throw new Error(`expected allow/block command, got ${JSON.stringify(cmd)}`);
  }
  return cmd;
}
import { sendApprovalRequest } from '../../src/core/admin.ts';
import type { IncomingMessage } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  return join(tmpdir(), `whatsoup-sms-id-test-${randomBytes(4).toString('hex')}.db`);
}

const dbPath = tempDbPath();
const db = new Database(dbPath);
db.open();

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

beforeEach(() => {
  db.raw.prepare('DELETE FROM access_list').run();
  db.raw.prepare('DELETE FROM messages').run();
});

function makeSmsMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `sms-msg-${randomBytes(4).toString('hex')}`,
    chatJid: '+14155550100@sms',
    senderJid: '+14155550100@sms',
    senderName: null,
    content: 'hello',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolvePhoneFromJid — SMS domain branch
// ---------------------------------------------------------------------------

describe('resolvePhoneFromJid — SMS JID', () => {
  it('strips leading + and @sms suffix, returning digits only', () => {
    expect(resolvePhoneFromJid('+14155550100@sms', db)).toBe('14155550100');
  });

  it('handles numbers without leading + (bare local part)', () => {
    // Defensive: if for some reason the local part has no '+', still returns digits
    expect(resolvePhoneFromJid('14155550100@sms', db)).toBe('14155550100');
  });

  it('WhatsApp personal JID is byte-for-byte unchanged', () => {
    expect(resolvePhoneFromJid('15551230100@s.whatsapp.net', db)).toBe('15551230100');
  });

  it('WhatsApp LID JID fallback is byte-for-byte unchanged (unresolvable)', () => {
    // No lid_mappings entry → falls back to raw LID local
    expect(resolvePhoneFromJid('11111119999@lid', db)).toBe('11111119999');
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand — transport-neutral command parser compatibility
// ---------------------------------------------------------------------------

describe('parseAdminCommand — ALLOW <digits from SMS>', () => {
  it('parses ALLOW 14155550100 as a phone command', () => {
    const cmd = asAccessCommand(parseAdminCommand('ALLOW 14155550100'));
    expect(cmd.action).toBe('allow');
    expect(cmd.subjectType).toBe('phone');
    expect(cmd.subjectId).toBe('14155550100');
  });

  it('parses BLOCK 14155550100', () => {
    const cmd = asAccessCommand(parseAdminCommand('BLOCK 14155550100'));
    expect(cmd.action).toBe('block');
    expect(cmd.subjectType).toBe('phone');
    expect(cmd.subjectId).toBe('14155550100');
  });
});

// ---------------------------------------------------------------------------
// resolveAdminChatJid — tested indirectly via sendApprovalRequest
// ---------------------------------------------------------------------------

describe('sendApprovalRequest — resolveAdminChatJid with SMS sender row', () => {
  it('sends to the @sms chat JID when an admin SMS message row exists', async () => {
    // Insert an admin message row with @sms sender/chat
    db.raw.prepare(
      `INSERT INTO messages
         (message_id, chat_jid, conversation_key, sender_jid, sender_name,
          content, content_type, is_from_me, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      'admin-sms-001',
      '+15550100001@sms',
      '+15550100001_at_sms',
      '+15550100001@sms',
      'Admin',
      'hi',
      'text',
      1700000000,
    );

    const messenger = { sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }), sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }) };
    await sendApprovalRequest(db, messenger, '14155550100', 'Alice', 'hello there');

    expect(messenger.sendMessage).toHaveBeenCalledOnce();
    const [sentJid, sentText] = messenger.sendMessage.mock.calls[0] as [string, string];
    expect(sentJid).toBe('+15550100001@sms');
    expect(sentText).toContain('Review this request in the WhatSoup console');
    expect(sentText).toContain('SMS replies cannot authorize access decisions');
    expect(sentText).not.toContain('ALLOW 14155550100');
    expect(sentText).not.toContain('BLOCK 14155550100');
  });

  it('falls back to +<admin>@sms when no message rows exist and transport=twilio', async () => {
    const messenger = { sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }), sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }) };
    await sendApprovalRequest(db, messenger, '14155550100', 'Bob', 'hey');

    expect(messenger.sendMessage).toHaveBeenCalledOnce();
    const [sentJid] = messenger.sendMessage.mock.calls[0] as [string, string];
    expect(sentJid).toBe('+15550100001@sms');
  });
});

// ---------------------------------------------------------------------------
// Full round-trip integration: SMS allowlist flow
// ---------------------------------------------------------------------------

describe('SMS allowlist round-trip', () => {
  const BOT_JID = '+19999000001@sms';
  const SMS_SENDER = '+14155550100@sms';
  const PHONE_DIGITS = '14155550100';

  it('unknown SMS sender → pending → ALLOW command → allowed', () => {
    const msg = makeSmsMsg({ senderJid: SMS_SENDER, chatJid: SMS_SENDER });

    // Step 1: shouldRespond returns unknown (no access_list entry yet)
    const result1 = shouldRespond(msg, BOT_JID, null, db);
    expect(result1.respond).toBe(false);
    expect(result1.accessStatus).toBe('unknown');

    // Step 2: insert pending (mirrors what ingest does via sendApprovalRequest)
    const phone = resolvePhoneFromJid(SMS_SENDER, db);
    expect(phone).toBe(PHONE_DIGITS);
    insertPending(db, 'phone', phone, 'Alice');

    // Step 3: shouldRespond now returns pending
    const result2 = shouldRespond(msg, BOT_JID, null, db);
    expect(result2.respond).toBe(false);
    expect(result2.accessStatus).toBe('pending');

    // Step 4: an authenticated console operator applies the decision.
    updateAccess(db, 'phone', phone, 'allowed');

    // Step 5: shouldRespond now allows
    const result3 = shouldRespond(msg, BOT_JID, null, db);
    expect(result3.respond).toBe(true);
    expect(result3.reason).toBe('dm_allowed');
  });

  it('unknown SMS sender → pending → BLOCK command → blocked', () => {
    const msg = makeSmsMsg({ senderJid: '+14155550199@sms', chatJid: '+14155550199@sms' });

    const phone = resolvePhoneFromJid('+14155550199@sms', db);
    insertPending(db, 'phone', phone, 'BlockMe');

    const cmd = asAccessCommand(parseAdminCommand(`BLOCK ${phone}`));
    updateAccess(db, cmd.subjectType, cmd.subjectId, 'blocked');

    const result = shouldRespond(msg, BOT_JID, null, db);
    expect(result.respond).toBe(false);
    expect(result.accessStatus).toBe('blocked');
  });

  it('sendApprovalRequest directs SMS notification recipients to the console', async () => {
    const messenger = { sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }), sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }) };
    const phone = resolvePhoneFromJid(SMS_SENDER, db);

    await sendApprovalRequest(db, messenger, phone, 'Alice', 'hello from SMS');

    const sentText = messenger.sendMessage.mock.calls[0][1] as string;
    expect(sentText).toContain('Review this request in the WhatSoup console');
    expect(sentText).toContain('SMS replies cannot authorize access decisions');
    expect(sentText).not.toContain(`ALLOW ${PHONE_DIGITS}`);
    expect(sentText).not.toContain(`BLOCK ${PHONE_DIGITS}`);
    // The pending row must use digits (not +digits or +digits_at_sms)
    const entry = lookupAccess(db, 'phone', PHONE_DIGITS);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// handleAdminCommand — an authorized external decision replays queued @sms messages
// ---------------------------------------------------------------------------

describe('handleAdminCommand — SMS queued-message replay', () => {
  it('replays a message stored under the +<digits>@sms sender JID after ALLOW', async () => {
    const { handleAdminCommand } = await import('../../src/core/admin.ts');

    db.raw.prepare(
      `INSERT INTO messages
         (message_id, chat_jid, conversation_key, sender_jid, sender_name,
          content, content_type, is_from_me, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      'queued-sms-001',
      '+15550100002@sms',
      '+15550100002_at_sms',
      '+15550100002@sms',
      null,
      'queued while pending',
      'text',
      1700000100,
    );

    const messenger = {
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
    };
    const replayed: IncomingMessage[] = [];
    await handleAdminCommand(
      db,
      messenger as never,
      'allow',
      'phone',
      '15550100002',
      '+15550100003@sms',
      async (msg: IncomingMessage) => {
        replayed.push(msg);
      },
    );

    expect(replayed).toHaveLength(1);
    expect(replayed[0].messageId).toBe('queued-sms-001');
    expect(replayed[0].chatJid).toBe('+15550100002@sms');
  });
});

describe('handleAdminCommand — 10-digit subject normalization', () => {
  it('ALLOW with a 10-digit subject flips the full-digit access row AND replays the @sms queue', async () => {
    const { handleAdminCommand } = await import('../../src/core/admin.ts');

    // Pending row stored under the full-digit key resolvePhoneFromJid produces
    insertPending(db, 'phone', '15550100004', null);
    db.raw.prepare(
      `INSERT INTO messages
         (message_id, chat_jid, conversation_key, sender_jid, sender_name,
          content, content_type, is_from_me, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      'queued-sms-10digit', '+15550100004@sms', '+15550100004_at_sms',
      '+15550100004@sms', null, 'queued', 'text', 1700000200,
    );

    const messenger = {
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
    };
    const replayed: IncomingMessage[] = [];
    // The authorized decision used the 10-digit compatibility form (no country code).
    await handleAdminCommand(db, messenger as never, 'allow', 'phone', '5550100004',
      '+15550100005@sms', async (msg: IncomingMessage) => {
        replayed.push(msg);
      });

    // The full-digit access row flipped (not a silent miss on '5550100004')
    expect(lookupAccess(db, 'phone', '15550100004')?.status).toBe('allowed');
    // And the queued SMS message replayed
    expect(replayed.map((m) => m.messageId)).toEqual(['queued-sms-10digit']);
  });
});
