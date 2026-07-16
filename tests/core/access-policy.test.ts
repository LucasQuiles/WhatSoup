import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Database } from '../../src/core/database.ts';
import { classifyTrustedActorAccess, shouldRespond } from '../../src/core/access-policy.ts';
import { resolveLid, hydrateLidMappings, upsertLidMapping } from '../../src/core/lid-resolver.ts';
import { extractLocal } from '../../src/core/access-list.ts';
import type { IncomingMessage } from '../../src/core/types.ts';
import { config } from '../../src/config.ts';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BOT_JID = '15551230004@s.whatsapp.net';
const BOT_LID = '81536414179557@lid';
const BOT_PHONE = '15551230004';
const BOT_LID_NUM = '81536414179557';

const ALLOWED_ADMIN = '15550100001';
const ALLOWED_USER = '15551230008';
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
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractLocal unit tests
// ---------------------------------------------------------------------------

describe('extractLocal', () => {
  it('strips @s.whatsapp.net suffix', () => {
    expect(extractLocal('15551230008@s.whatsapp.net')).toBe('15551230008');
  });

  it('strips @lid suffix', () => {
    expect(extractLocal('81536414179557@lid')).toBe('81536414179557');
  });

  it('returns plain phone unchanged when no @ present', () => {
    expect(extractLocal('15551230008')).toBe('15551230008');
  });

  it('handles colon-device suffix in LID format', () => {
    // extractLocal strips at the @ boundary; toConversationKey also strips the :device
    // '81536414179557:2@lid' → '81536414179557' (toConversationKey strips :device too)
    expect(extractLocal('81536414179557:2@lid')).toBe('81536414179557');
  });

  it('returns empty string for bare @ (degenerate input)', () => {
    // toConversationKey('@s.whatsapp.net') → '' (local part is '')
    expect(extractLocal('@s.whatsapp.net')).toBe('');
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
  // R4 (#9): media in a PENDING group must NOT implicit-mention. The predicate was
  // `groupEntry.status !== 'blocked'`, which fired for pending groups too. It is now
  // `=== 'allowed'`; since an allowed group already returns group_auto_respond earlier,
  // media in a pending/known-but-not-allowed group falls through to the @mention check.
  it.each(['image', 'sticker', 'video', 'audio'] as const)(
    '%s in a PENDING group does NOT trigger a response without an @mention',
    (contentType) => {
      const msg = makeMsg({
        chatJid: KNOWN_GROUP, // status=pending
        senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
        isGroup: true,
        contentType,
        content: null,
        mentionedJids: [],
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(false);
      expect(result.reason).toBe('not_mentioned');
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
// R5: strict group-sender policy (groupSenderPolicy)
// ---------------------------------------------------------------------------

describe('R5: strict group-sender policy', () => {
  const origPolicy = config.groupSenderPolicy;
  const origAdmins = config.adminPhones;
  afterEach(() => {
    (config as unknown as { groupSenderPolicy: string }).groupSenderPolicy = origPolicy;
    (config as unknown as { adminPhones: Set<string> }).adminPhones = origAdmins;
  });
  const strict = () => {
    (config as unknown as { groupSenderPolicy: string }).groupSenderPolicy = 'allowlisted_only';
  };

  it('allowlisted_only DENIES an unknown sender in an ALLOWED group (closes #4 auto-respond-all)', () => {
    strict();
    const msg = makeMsg({ chatJid: AUTO_RESPOND_GROUP, senderJid: `${UNKNOWN_USER}@s.whatsapp.net`, isGroup: true });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('strict_group_non_allowlisted');
  });

  it('allowlisted_only DENIES an unknown sender @mentioning the bot in an un-allowlisted group (closes #20)', () => {
    strict();
    const msg = makeMsg({ chatJid: MENTION_TEST_GROUP, senderJid: `${UNKNOWN_USER}@s.whatsapp.net`, isGroup: true, mentionedJids: [BOT_JID] });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('strict_group_non_allowlisted');
  });

  it('allowlisted_only DENIES a pending sender in an allowed group', () => {
    strict();
    const msg = makeMsg({ chatJid: AUTO_RESPOND_GROUP, senderJid: `${PENDING_USER}@s.whatsapp.net`, isGroup: true });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('strict_group_non_allowlisted');
  });

  it('allowlisted_only ALLOWS an allowlisted sender in an allowed group', () => {
    strict();
    const msg = makeMsg({ chatJid: AUTO_RESPOND_GROUP, senderJid: `${ALLOWED_USER}@s.whatsapp.net`, isGroup: true });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('group_auto_respond');
  });

  it('allowlisted_only ALLOWS an admin (not access-listed) sender via the admin check', () => {
    strict();
    (config as unknown as { adminPhones: Set<string> }).adminPhones = new Set([UNKNOWN_USER]);
    const msg = makeMsg({ chatJid: AUTO_RESPOND_GROUP, senderJid: `${UNKNOWN_USER}@s.whatsapp.net`, isGroup: true });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('group_auto_respond');
  });

  it('any_member (default) preserves current behavior: unknown sender in an allowed group still responds', () => {
    (config as unknown as { groupSenderPolicy: string }).groupSenderPolicy = 'any_member';
    const msg = makeMsg({ chatJid: AUTO_RESPOND_GROUP, senderJid: `${UNKNOWN_USER}@s.whatsapp.net`, isGroup: true });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(true);
    expect(result.reason).toBe('group_auto_respond');
  });

  it('any_member (default): blocked sender is still blocked before the strict gate matters', () => {
    (config as unknown as { groupSenderPolicy: string }).groupSenderPolicy = 'allowlisted_only';
    const msg = makeMsg({ chatJid: AUTO_RESPOND_GROUP, senderJid: `${BLOCKED_USER}@s.whatsapp.net`, isGroup: true });
    const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
    expect(result.respond).toBe(false);
    expect(result.reason).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// Sibling bot filter (anti-echo-loop)
// ---------------------------------------------------------------------------

describe('sibling bot filter', () => {
  const SIBLING_PHONE = '15551112222';

  it('MUST NOT respond to sibling bot in group when NOT mentioned', async () => {
    const { config: realConfig } = await import('../../src/config.ts');
    realConfig.siblingPhones.add(SIBLING_PHONE);
    try {
      const msg = makeMsg({
        chatJid: AUTO_RESPOND_GROUP,
        senderJid: `${SIBLING_PHONE}@s.whatsapp.net`,
        isGroup: true,
        mentionedJids: [],
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(false);
      expect(result.reason).toBe('sibling_bot');
    } finally {
      realConfig.siblingPhones.delete(SIBLING_PHONE);
    }
  });

  it('MUST respond to sibling bot when explicitly @mentioned in group', async () => {
    const { config: realConfig } = await import('../../src/config.ts');
    realConfig.siblingPhones.add(SIBLING_PHONE);
    try {
      const msg = makeMsg({
        chatJid: MENTION_TEST_GROUP,
        senderJid: `${SIBLING_PHONE}@s.whatsapp.net`,
        isGroup: true,
        mentionedJids: [BOT_JID],
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('sibling_mentioned');
    } finally {
      realConfig.siblingPhones.delete(SIBLING_PHONE);
    }
  });

  it('sibling bot in auto-respond group responds when @mentioned', async () => {
    const { config: realConfig } = await import('../../src/config.ts');
    realConfig.siblingPhones.add(SIBLING_PHONE);
    try {
      const msg = makeMsg({
        chatJid: AUTO_RESPOND_GROUP,
        senderJid: `${SIBLING_PHONE}@s.whatsapp.net`,
        isGroup: true,
        mentionedJids: [BOT_JID],
      });
      // Even in an auto-respond group, sibling filter runs first —
      // but with a mention, the sibling should still respond
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('sibling_mentioned');
    } finally {
      realConfig.siblingPhones.delete(SIBLING_PHONE);
    }
  });

  it('allows sibling bot in DMs (filter is group-only)', async () => {
    const { config: realConfig } = await import('../../src/config.ts');
    // Sibling must be in access_list to get past DM checks
    db.raw.prepare(
      `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
       VALUES ('phone', ?, 'allowed', 'SiblingBot', datetime('now'))`
    ).run(SIBLING_PHONE);
    realConfig.siblingPhones.add(SIBLING_PHONE);
    try {
      const msg = makeMsg({
        chatJid: `${SIBLING_PHONE}@s.whatsapp.net`,
        senderJid: `${SIBLING_PHONE}@s.whatsapp.net`,
        isGroup: false,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('dm_allowed');
    } finally {
      realConfig.siblingPhones.delete(SIBLING_PHONE);
    }
  });

  it('no-op when siblingPhones is empty (default behavior preserved)', () => {
    const msg = makeMsg({
      chatJid: AUTO_RESPOND_GROUP,
      senderJid: `${ALLOWED_USER}@s.whatsapp.net`,
      isGroup: true,
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

describe('LID resolver', () => {
  const ADMIN_PHONE = '15551230007';
  const ADMIN_LID_NUM = '31478083756155';
  const NON_ADMIN_LID_NUM = '99999999999999';

  let tmpAuthDir: string;
  let lidDb: Database;

  beforeAll(() => {
    tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-lid-test-'));
    // Write valid reverse mapping files (Baileys format)
    fs.writeFileSync(
      path.join(tmpAuthDir, `lid-mapping-${ADMIN_LID_NUM}_reverse.json`),
      JSON.stringify(ADMIN_PHONE),
    );
    lidDb = new Database(':memory:');
    lidDb.open();
  });

  afterAll(() => {
    fs.rmSync(tmpAuthDir, { recursive: true, force: true });
    lidDb.close();
  });

  it('hydrates lid_mappings from Baileys filesystem files', () => {
    const count = hydrateLidMappings(lidDb, tmpAuthDir);
    expect(count).toBe(1);
  });

  it('resolves a known LID to a phone via DB', () => {
    const result = resolveLid(lidDb, ADMIN_LID_NUM);
    expect(result).toBe(ADMIN_PHONE);
  });

  it('returns null for an unknown LID', () => {
    const result = resolveLid(lidDb, NON_ADMIN_LID_NUM);
    expect(result).toBeNull();
    expect(
      lidDb.raw.prepare('SELECT COUNT(*) AS count FROM lid_mappings WHERE lid = ?').get(NON_ADMIN_LID_NUM),
    ).toEqual({ count: 0 });
  });

  it('upsertLidMapping updates existing entries', () => {
    const newPhone = '19998887777';
    upsertLidMapping(lidDb, ADMIN_LID_NUM, `${newPhone}@s.whatsapp.net`);
    expect(resolveLid(lidDb, ADMIN_LID_NUM)).toBe(newPhone);
  });

  it('hydrate uses INSERT OR IGNORE — does not overwrite upserted values', () => {
    // Re-hydrate from the same auth dir (file still says ADMIN_PHONE)
    hydrateLidMappings(lidDb, tmpAuthDir);
    // The upserted value (19998887777) should persist — hydrate doesn't overwrite
    expect(resolveLid(lidDb, ADMIN_LID_NUM)).toBe('19998887777');
  });
});

describe('trusted actor access classification', () => {
  const ADMIN_LID_NUM = '72638194015577';

  it('classifies an authenticated phone JID in adminPhones as administrator', () => {
    expect(classifyTrustedActorAccess(
      `${ALLOWED_ADMIN}@s.whatsapp.net`,
      db,
      new Set([ALLOWED_ADMIN]),
    )).toBe('administrator');
  });

  it('classifies an authenticated mapped LID in adminPhones as administrator', () => {
    upsertLidMapping(db, ADMIN_LID_NUM, `${ALLOWED_ADMIN}@s.whatsapp.net`);

    expect(classifyTrustedActorAccess(
      `${ADMIN_LID_NUM}@lid`,
      db,
      new Set([ALLOWED_ADMIN]),
    )).toBe('administrator');
  });

  it('classifies an authenticated allowlisted non-admin as authorized_user', () => {
    expect(classifyTrustedActorAccess(
      `${ALLOWED_USER}@s.whatsapp.net`,
      db,
      new Set([ALLOWED_ADMIN]),
    )).toBe('authorized_user');
  });

  it.each([
    [`${ALLOWED_ADMIN}@sms`, 'spoofable SMS admin identity'],
    ['unmapped-actor@lid', 'unmapped LID'],
    [`${UNKNOWN_USER}@s.whatsapp.net`, 'unknown authenticated sender'],
    [undefined, 'missing actor identity'],
  ])('fails closed for %s (%s)', (senderJid, _description) => {
    expect(classifyTrustedActorAccess(senderJid, db, new Set([ALLOWED_ADMIN])))
      .toBe('untrusted_or_unknown');
  });
});
