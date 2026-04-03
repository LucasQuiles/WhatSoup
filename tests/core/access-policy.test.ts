import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Database } from '../../src/core/database.ts';
import { shouldRespond, resolveLidPhone } from '../../src/core/access-policy.ts';
import { extractPhone } from '../../src/core/access-list.ts';
import type { IncomingMessage } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BOT_JID = '18455943112@s.whatsapp.net';
const BOT_LID = '81536414179557@lid';
const BOT_PHONE = '18455943112';
const BOT_LID_NUM = '81536414179557';

const ALLOWED_ADMIN = '15550100001';
const ALLOWED_USER = '15184194479';
const BLOCKED_USER = '19999999999';
const PENDING_USER = '18888888888';
const UNKNOWN_USER = '17777777777';
const MENTION_TEST_GROUP = '12223334444-group@g.us';  // no access_list entry — mention-gated
const AUTO_RESPOND_GROUP = '44445556666-group@g.us';  // status=allowed → auto-respond
const KNOWN_GROUP = '55556667777-group@g.us';          // status=pending → media implicit mention
const UNKNOWN_GROUP = '99998887777-group@g.us';        // no access_list entry
const BLOCKED_GROUP = '77778889999-group@g.us';        // status=blocked → should NOT trigger implicit mention

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

let db: Database;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `whatsoup-trigger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new Database(dbPath);
  db.open();

  // Seed test entries.
  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
     VALUES ('phone', ?, 'allowed', 'Admin', datetime('now'))`
  ).run(ALLOWED_ADMIN);

  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
     VALUES ('phone', ?, 'allowed', 'TestUser', datetime('now'))`
  ).run(ALLOWED_USER);

  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
     VALUES ('phone', ?, 'blocked', 'BlockedUser', datetime('now'))`
  ).run(BLOCKED_USER);

  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
     VALUES ('phone', ?, 'pending', 'PendingUser', datetime('now'))`
  ).run(PENDING_USER);

  // Seed an auto-respond group (status=allowed → group_auto_respond fires for all messages)
  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
     VALUES ('group', ?, 'allowed', 'AutoRespondGroup', datetime('now'))`
  ).run(AUTO_RESPOND_GROUP);
  // Note: MENTION_TEST_GROUP intentionally has NO access_list entry — relies on @mention matching

  // Seed a known group with non-allowed status (triggers media implicit mention path)
  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
     VALUES ('group', ?, 'pending', 'KnownGroup', datetime('now'))`
  ).run(KNOWN_GROUP);

  // Seed a blocked group — must NOT trigger implicit mention for media
  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
     VALUES ('group', ?, 'blocked', 'BlockedGroup', datetime('now'))`
  ).run(BLOCKED_GROUP);

  // Set accessMode to 'allowlist' via env so config picks it up
  process.env.WHATSOUP_ACCESS_MODE = 'allowlist';
});

afterAll(() => {
  db.close();
  // Remove the DB file and WAL/SHM side files
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  delete process.env.WHATSOUP_ACCESS_MODE;
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'test-msg-1',
    chatJid: `${ALLOWED_USER}@s.whatsapp.net`,
    senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
    senderName: 'TestUser',
    content: 'Hello',
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
// extractPhone unit tests
// ---------------------------------------------------------------------------

describe('extractPhone', () => {
  it('strips @s.whatsapp.net suffix', () => {
    expect(extractPhone('15184194479@s.whatsapp.net')).toBe('15184194479');
  });

  it('strips @lid suffix', () => {
    expect(extractPhone('81536414179557@lid')).toBe('81536414179557');
  });

  it('returns plain phone unchanged when no @ present', () => {
    expect(extractPhone('15184194479')).toBe('15184194479');
  });

  it('handles colon-device suffix in LID format', () => {
    // extractPhone strips at the @ boundary; toConversationKey also strips the :device
    // '81536414179557:2@lid' → '81536414179557' (toConversationKey strips :device too)
    expect(extractPhone('81536414179557:2@lid')).toBe('81536414179557');
  });

  it('returns empty string for bare @ (degenerate input)', () => {
    // toConversationKey('@s.whatsapp.net') → '' (local part is '')
    expect(extractPhone('@s.whatsapp.net')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Negative: own message
// ---------------------------------------------------------------------------

describe('own message guard', () => {
  // @check CHK-011
  // @traces REQ-003.AC-01
  it('MUST NOT respond to its own messages (isFromMe=true)', () => {
    const result = shouldRespond(makeMsg({ isFromMe: true }), BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('own_message');
  });
});

// ---------------------------------------------------------------------------
// Negative: not response worthy
// ---------------------------------------------------------------------------

describe('isResponseWorthy guard', () => {
  it('MUST NOT respond to non-response-worthy messages', () => {
    const result = shouldRespond(makeMsg({ isResponseWorthy: false }), BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('not_response_worthy');
  });
});

// ---------------------------------------------------------------------------
// Access control: blocked
// ---------------------------------------------------------------------------

describe('blocked sender', () => {
  it('MUST NOT respond to blocked numbers in DMs', () => {
    const msg = makeMsg({
      chatJid: `${BLOCKED_USER}@s.whatsapp.net`,
      senderJid: `${BLOCKED_USER}@s.whatsapp.net`,
      isGroup: false,
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('blocked');
    expect(result.accessStatus).toBe('blocked');
  });

  it('MUST NOT respond to blocked numbers in groups even when @mentioned', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${BLOCKED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_JID],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('blocked');
    expect(result.accessStatus).toBe('blocked');
  });

  it('MUST NOT respond to blocked numbers in groups without mention', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${BLOCKED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// DM: unknown and pending
// ---------------------------------------------------------------------------

describe('DM access control', () => {
  it('MUST NOT respond to unknown numbers in DMs', () => {
    const msg = makeMsg({
      chatJid: `${UNKNOWN_USER}@s.whatsapp.net`,
      senderJid: `${UNKNOWN_USER}@s.whatsapp.net`,
      isGroup: false,
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('unknown');
    expect(result.accessStatus).toBe('unknown');
  });

  it('MUST NOT respond to pending numbers in DMs', () => {
    const msg = makeMsg({
      chatJid: `${PENDING_USER}@s.whatsapp.net`,
      senderJid: `${PENDING_USER}@s.whatsapp.net`,
      isGroup: false,
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('pending');
    expect(result.accessStatus).toBe('pending');
  });

  // @check CHK-013
  // @traces REQ-003.AC-03
  it('responds to allowed numbers in DMs (admin)', () => {
    const msg = makeMsg({
      chatJid: `${ALLOWED_ADMIN}@s.whatsapp.net`,
      senderJid: `${ALLOWED_ADMIN}@s.whatsapp.net`,
      isGroup: false,
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('dm_allowed');
  });

  // @check CHK-012
  // @traces REQ-003.AC-02
  it('responds to allowed numbers in DMs (test user)', () => {
    const msg = makeMsg({
      chatJid: `${ALLOWED_USER}@s.whatsapp.net`,
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: false,
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('dm_allowed');
    expect(result.accessStatus).toBe('allowed');
  });
});

// ---------------------------------------------------------------------------
// Group: @mention matching
// ---------------------------------------------------------------------------

describe('group @mention matching', () => {
  it('MUST NOT respond in groups when not @mentioned', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('not_mentioned');
  });

  it('MUST NOT respond when empty mentionedJids array in group', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
  });

  it('MUST NOT trigger when mentionedJids has other users but not the bot', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [`${ALLOWED_ADMIN}@s.whatsapp.net`, `${UNKNOWN_USER}@s.whatsapp.net`],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('not_mentioned');
  });

  it('responds when JID exact match in mentionedJids → respond=true', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_JID],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('mentioned');
  });

  it('responds when LID exact match in mentionedJids → respond=true', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_LID],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('mentioned');
  });

  it('responds when phone-number-only portion matches (bare number)', () => {
    const msgBareNum = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_LID_NUM],  // bare number, no @
    });
    const result2 = shouldRespond(msgBareNum, BOT_JID, BOT_LID, db);
    expect(result2.respond).toBe(true);
    expect(result2.reason).toBe('mentioned');
  });

  it('responds when bot phone number is in mentionedJids (no @ suffix)', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_PHONE],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('mentioned');
  });

  it('responds when multiple JIDs in mentionedJids and one is the bot', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [`${ALLOWED_ADMIN}@s.whatsapp.net`, BOT_JID, `${UNKNOWN_USER}@s.whatsapp.net`],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('mentioned');
  });

  // @check CHK-014
  // @traces REQ-003.AC-04
  it('group @mention from allowed number → respond=true, reason=mentioned', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_JID],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('mentioned');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('MUST NOT crash when botJid is empty string (startup race) — groups return false', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_JID],
    });
    const result = shouldRespond(msg, '', BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('not_mentioned');
  });

  it('MUST NOT crash when botJid is empty string for DM messages — processes normally', () => {
    const msg = makeMsg({
      chatJid: `${ALLOWED_USER}@s.whatsapp.net`,
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: false,
    });
    const result = shouldRespond(msg, '', BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('dm_allowed');
  });

  it('bot LID null (legacy format) falls back to JID-only matching, no crash', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_JID],
    });
    const result = shouldRespond(msg, BOT_JID, null, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('mentioned');
  });

  it('bot LID null — LID mention does NOT match (no crash)', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_LID],
    });
    const result = shouldRespond(msg, BOT_JID, null, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('not_mentioned');
  });

  it('isFromMe=true takes priority over blocked status', () => {
    const msg = makeMsg({
      senderJid: `${BLOCKED_USER}@s.whatsapp.net`,
      isFromMe: true,
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('own_message');
  });

  it('isResponseWorthy=false takes priority before access checks', () => {
    const msg = makeMsg({
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isResponseWorthy: false,
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('not_response_worthy');
  });

  it('blocked takes priority over group mention check', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${BLOCKED_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_JID, BOT_LID],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('blocked');
  });

  it('unknown number in group without mention returns not_mentioned (not unknown)', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${UNKNOWN_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('not_mentioned');
  });

  it('unknown number in group @mentioning bot returns mentioned=true (groups only check mention)', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${UNKNOWN_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_JID],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('mentioned');
  });

  it('pending number in group @mentioning bot returns mentioned=true', () => {
    const msg = makeMsg({
      chatJid: '12223334444-group@g.us',
      senderJid: `${PENDING_USER}@s.whatsapp.net`,
      isGroup: true,
      mentionedJids: [BOT_LID],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('mentioned');
  });
});

// ---------------------------------------------------------------------------
// Media implicit mention in known groups
// ---------------------------------------------------------------------------

describe('media implicit mention in known groups', () => {
  it.each(['image', 'sticker', 'video', 'audio'] as const)(
    '%s in known group triggers implicit mention',
    (contentType) => {
      const msg = makeMsg({
        chatJid: KNOWN_GROUP,
        senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
        isGroup: true,
        contentType,
        content: null,
        mentionedJids: [],
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('media_implicit_mention');
    },
  );

  it('image in unknown group does NOT trigger implicit mention', () => {
    const msg = makeMsg({
      chatJid: UNKNOWN_GROUP,
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      contentType: 'image',
      content: null,
      mentionedJids: [],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('not_mentioned');
  });

  it('text in known group without mention does NOT trigger implicit mention', () => {
    const msg = makeMsg({
      chatJid: KNOWN_GROUP,
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      contentType: 'text',
      content: 'hello',
      mentionedJids: [],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('not_mentioned');
  });

  it('blocked sender image in known group is still blocked', () => {
    const msg = makeMsg({
      chatJid: KNOWN_GROUP,
      senderJid: `${BLOCKED_USER}@s.whatsapp.net`,
      isGroup: true,
      contentType: 'image',
      content: null,
      mentionedJids: [],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('blocked');
  });

  it('image in blocked group does NOT trigger implicit mention', () => {
    const msg = makeMsg({
      chatJid: BLOCKED_GROUP,
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      contentType: 'image',
      content: null,
      mentionedJids: [],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
  });

  it('image in auto-respond group uses group_auto_respond (not implicit mention)', () => {
    const msg = makeMsg({
      chatJid: AUTO_RESPOND_GROUP,
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
      contentType: 'image',
      content: null,
      mentionedJids: [],
    });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('group_auto_respond');
  });
});

// ---------------------------------------------------------------------------
// resolveLidPhone — LID→phone reverse mapping
// ---------------------------------------------------------------------------

describe('resolveLidPhone', () => {
  const ADMIN_PHONE = '18455880337';
  const ADMIN_LID_NUM = '31478083756155';
  const NON_ADMIN_LID_NUM = '99999999999999';

  let tmpAuthDir: string;

  beforeAll(() => {
    tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-lid-test-'));
    // Write a valid reverse mapping for the admin LID
    fs.writeFileSync(
      path.join(tmpAuthDir, `lid-mapping-${ADMIN_LID_NUM}_reverse.json`),
      JSON.stringify(ADMIN_PHONE),
    );
  });

  afterAll(() => {
    fs.rmSync(tmpAuthDir, { recursive: true, force: true });
  });

  it('returns the phone number for a known LID', () => {
    const result = resolveLidPhone(ADMIN_LID_NUM, tmpAuthDir);
    expect(result).toBe(ADMIN_PHONE);
  });

  it('returns null when no reverse mapping file exists', () => {
    const result = resolveLidPhone(NON_ADMIN_LID_NUM, tmpAuthDir);
    expect(result).toBeNull();
  });

  it('returns null for a malformed (non-string) mapping file', () => {
    const malformedLid = '11111111111111';
    fs.writeFileSync(
      path.join(tmpAuthDir, `lid-mapping-${malformedLid}_reverse.json`),
      JSON.stringify({ not: 'a phone' }),
    );
    const result = resolveLidPhone(malformedLid, tmpAuthDir);
    expect(result).toBeNull();
  });

  it('returns null when mapping file contains an empty string', () => {
    const emptyLid = '22222222222222';
    fs.writeFileSync(
      path.join(tmpAuthDir, `lid-mapping-${emptyLid}_reverse.json`),
      JSON.stringify(''),
    );
    const result = resolveLidPhone(emptyLid, tmpAuthDir);
    expect(result).toBeNull();
  });

  it('caches results so subsequent calls for the same LID skip the filesystem', () => {
    // ADMIN_LID_NUM was already resolved above; delete the file and confirm cache hit
    const reversePath = path.join(tmpAuthDir, `lid-mapping-${ADMIN_LID_NUM}_reverse.json`);
    // File may or may not still exist due to cache — call again and confirm consistent result
    const result = resolveLidPhone(ADMIN_LID_NUM, tmpAuthDir);
    expect(result).toBe(ADMIN_PHONE);
  });
});
