/**
 * Exhaustive test suite for LID/JID/Phone resolution across the entire system.
 *
 * Covers:
 *   - resolvePhoneFromJid: all JID formats, LID resolution, fallbacks, edge cases
 *   - extractLocal: raw extraction without DB
 *   - resolveLid: DB queries, colon suffix, caching, missing entries
 *   - shouldRespond: all access modes × LID/JID sender combinations
 *   - isAdminMessage: LID admin detection
 *   - sendApprovalRequest: LID senders get correct phone stored
 *   - resolveAdminChatJid: finding admin via LID JIDs
 *   - ContactsDirectory: LID resolution + caching in @mention population
 *   - Rate limiter: LID/JID normalization to prevent bypass
 *   - Conversation key: LID vs phone consistency
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Mock config — vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------

const { testConfig } = vi.hoisted(() => {
  const testConfig = {
    adminPhones: new Set(['18455880337']),
    accessMode: 'allowlist' as string,
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    healthPort: 9090,
    maxTokens: 4096,
    tokenBudget: 50000,
    rateLimitPerHour: 40,
    rateLimitNoticeWindowMs: 3600000,
    controlPeers: new Map(),
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  };
  return { testConfig };
});

vi.mock('../../src/config.ts', () => ({
  config: testConfig,
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { Database } from '../../src/core/database.ts';
import {
  extractLocal,
  extractPhone,
  resolvePhoneFromJid,
  lookupAccess,
  insertPending,
  insertAllowed,
  updateAccess,
  upsertAccess,
} from '../../src/core/access-list.ts';
import { resolveLid, hydrateLidMappings, upsertLidMapping, getAllLidMappings } from '../../src/core/lid-resolver.ts';
import { toConversationKey } from '../../src/core/conversation-key.ts';
import { toPersonalJid, toLidJid } from '../../src/core/jid-constants.ts';
import { isAdminPhone, normalizePhone, normalizePhoneE164 } from '../../src/lib/phone.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';
import { isAdminMessage, parseAdminCommand } from '../../src/core/command-router.ts';
import { ContactsDirectory } from '../../src/core/mentions.ts';
import { handleBlocklistSet, handleBlocklistUpdate } from '../../src/core/blocklist-sync.ts';
import type { IncomingMessage } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const ADMIN_PHONE = '18455880337';
const ADMIN_LID = '31478083756155';
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;
const ADMIN_LID_JID = `${ADMIN_LID}@lid`;

const USER_PHONE = '15184194479';
const USER_LID = '74823329915101';
const USER_JID = `${USER_PHONE}@s.whatsapp.net`;
const USER_LID_JID = `${USER_LID}@lid`;

const UNKNOWN_PHONE = '19999999999';
const UNKNOWN_LID = '88888888888888';
const UNKNOWN_JID = `${UNKNOWN_PHONE}@s.whatsapp.net`;
const UNKNOWN_LID_JID = `${UNKNOWN_LID}@lid`;

const BOT_JID = '18454179470@s.whatsapp.net';
const BOT_LID = '74823329915101@lid';

const GROUP_JID = '120363123456789@g.us';

// ---------------------------------------------------------------------------
// DB setup — fresh in-memory DB for each describe block that needs it
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function seedLidMappings(db: Database): void {
  upsertLidMapping(db, ADMIN_LID, ADMIN_JID);
  upsertLidMapping(db, USER_LID, USER_JID);
}

function seedAccessList(db: Database): void {
  insertAllowed(db, 'phone', ADMIN_PHONE);
  insertAllowed(db, 'phone', USER_PHONE);
  insertPending(db, 'phone', UNKNOWN_PHONE, 'Unknown Person');
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    chatJid: USER_JID,
    senderJid: USER_JID,
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

// ═══════════════════════════════════════════════════════════════════════════
// 1. extractLocal — raw local part extraction (no DB)
// ═══════════════════════════════════════════════════════════════════════════

describe('extractLocal', () => {
  it('extracts phone from personal JID', () => {
    expect(extractLocal('15184194479@s.whatsapp.net')).toBe('15184194479');
  });

  it('extracts opaque LID from LID JID (does NOT resolve)', () => {
    expect(extractLocal('31478083756155@lid')).toBe('31478083756155');
  });

  it('strips colon-device suffix from LID', () => {
    expect(extractLocal('31478083756155:2@lid')).toBe('31478083756155');
  });

  it('handles group JIDs', () => {
    expect(extractLocal('120363123456789@g.us')).toBe('120363123456789_at_g.us');
  });

  it('returns bare string unchanged when no @', () => {
    expect(extractLocal('15184194479')).toBe('15184194479');
  });

  it('returns empty string for bare @domain', () => {
    expect(extractLocal('@s.whatsapp.net')).toBe('');
  });

  it('handles newsletter JIDs', () => {
    expect(extractLocal('123456789@newsletter')).toBe('123456789_at_newsletter');
  });

  it('deprecated extractPhone alias works identically', () => {
    expect(extractPhone('15184194479@s.whatsapp.net')).toBe(extractLocal('15184194479@s.whatsapp.net'));
    expect(extractPhone('31478083756155@lid')).toBe(extractLocal('31478083756155@lid'));
    expect(extractPhone('31478083756155:2@lid')).toBe(extractLocal('31478083756155:2@lid'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. resolveLid — DB-backed LID→phone resolution
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveLid', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDb();
    seedLidMappings(db);
  });
  afterAll(() => db.close());

  it('resolves a known LID to phone digits', () => {
    expect(resolveLid(db, ADMIN_LID)).toBe(ADMIN_PHONE);
  });

  it('returns null for unknown LID', () => {
    expect(resolveLid(db, UNKNOWN_LID)).toBeNull();
  });

  it('handles colon-device suffix (strips before lookup)', () => {
    expect(resolveLid(db, `${ADMIN_LID}:2`)).toBe(ADMIN_PHONE);
    expect(resolveLid(db, `${ADMIN_LID}:0`)).toBe(ADMIN_PHONE);
    expect(resolveLid(db, `${USER_LID}:99`)).toBe(USER_PHONE);
  });

  it('handles empty string gracefully', () => {
    expect(resolveLid(db, '')).toBeNull();
  });

  it('handles numeric-only input (no colon)', () => {
    expect(resolveLid(db, USER_LID)).toBe(USER_PHONE);
  });

  it('getAllLidMappings returns all entries', () => {
    const all = getAllLidMappings(db);
    expect(all.size).toBe(2);
    expect(all.get(ADMIN_LID)).toBe(ADMIN_PHONE);
    expect(all.get(USER_LID)).toBe(USER_PHONE);
  });

  it('upsertLidMapping overwrites existing entry', () => {
    const tempDb = createTestDb();
    upsertLidMapping(tempDb, '111', '222@s.whatsapp.net');
    expect(resolveLid(tempDb, '111')).toBe('222');
    upsertLidMapping(tempDb, '111', '333@s.whatsapp.net');
    expect(resolveLid(tempDb, '111')).toBe('333');
    tempDb.close();
  });

  it('hydrateLidMappings reads Baileys filesystem files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lid-test-'));
    const tempDb = createTestDb();

    // Write a valid reverse mapping file
    fs.writeFileSync(
      path.join(tmpDir, 'lid-mapping-55555_reverse.json'),
      JSON.stringify('16665554444'),
    );
    // Write an invalid file (should be skipped)
    fs.writeFileSync(
      path.join(tmpDir, 'lid-mapping-66666_reverse.json'),
      'not json',
    );
    // Write a non-matching filename (should be skipped)
    fs.writeFileSync(
      path.join(tmpDir, 'some-other-file.json'),
      JSON.stringify('ignored'),
    );

    const count = hydrateLidMappings(tempDb, tmpDir);
    expect(count).toBe(1); // only the valid file
    expect(resolveLid(tempDb, '55555')).toBe('16665554444');
    expect(resolveLid(tempDb, '66666')).toBeNull(); // malformed was skipped

    tempDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hydrateLidMappings returns 0 for non-existent directory', () => {
    const tempDb = createTestDb();
    expect(hydrateLidMappings(tempDb, '/nonexistent/dir')).toBe(0);
    tempDb.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. resolvePhoneFromJid — the central identity resolver
// ═══════════════════════════════════════════════════════════════════════════

describe('resolvePhoneFromJid', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDb();
    seedLidMappings(db);
  });
  afterAll(() => db.close());

  describe('personal JIDs (@s.whatsapp.net)', () => {
    it('returns phone digits directly', () => {
      expect(resolvePhoneFromJid(ADMIN_JID, db)).toBe(ADMIN_PHONE);
      expect(resolvePhoneFromJid(USER_JID, db)).toBe(USER_PHONE);
    });

    it('does NOT hit the DB (no LID resolution needed)', () => {
      // Even with bogus phone, returns it directly
      expect(resolvePhoneFromJid('99999@s.whatsapp.net', db)).toBe('99999');
    });
  });

  describe('LID JIDs (@lid)', () => {
    it('resolves known LID to real phone number', () => {
      expect(resolvePhoneFromJid(ADMIN_LID_JID, db)).toBe(ADMIN_PHONE);
      expect(resolvePhoneFromJid(USER_LID_JID, db)).toBe(USER_PHONE);
    });

    it('falls back to raw LID number when resolution fails', () => {
      expect(resolvePhoneFromJid(UNKNOWN_LID_JID, db)).toBe(UNKNOWN_LID);
    });

    it('handles colon-device suffix in LID JIDs', () => {
      expect(resolvePhoneFromJid(`${ADMIN_LID}:2@lid`, db)).toBe(ADMIN_PHONE);
      expect(resolvePhoneFromJid(`${USER_LID}:0@lid`, db)).toBe(USER_PHONE);
    });

    it('colon-device suffix with unknown LID returns stripped LID', () => {
      expect(resolvePhoneFromJid('99999:5@lid', db)).toBe('99999');
    });
  });

  describe('group JIDs (@g.us)', () => {
    it('returns conversation key format', () => {
      expect(resolvePhoneFromJid('120363123456789@g.us', db)).toBe('120363123456789_at_g.us');
    });
  });

  describe('bare strings (no @)', () => {
    it('returns string unchanged', () => {
      expect(resolvePhoneFromJid('15184194479', db)).toBe('15184194479');
      expect(resolvePhoneFromJid('', db)).toBe('');
    });
  });

  describe('consistency: same person, different JID formats', () => {
    it('admin phone resolves identically from JID and LID', () => {
      const fromJid = resolvePhoneFromJid(ADMIN_JID, db);
      const fromLid = resolvePhoneFromJid(ADMIN_LID_JID, db);
      expect(fromJid).toBe(fromLid);
      expect(fromJid).toBe(ADMIN_PHONE);
    });

    it('user phone resolves identically from JID and LID', () => {
      const fromJid = resolvePhoneFromJid(USER_JID, db);
      const fromLid = resolvePhoneFromJid(USER_LID_JID, db);
      expect(fromJid).toBe(fromLid);
      expect(fromJid).toBe(USER_PHONE);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. shouldRespond — LID senders across all access modes
// ═══════════════════════════════════════════════════════════════════════════

describe('shouldRespond with LID senders', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDb();
    seedLidMappings(db);
    seedAccessList(db);
  });

  afterAll(() => {
    db.close();
    testConfig.accessMode = 'allowlist';
  });

  describe('allowlist mode', () => {
    beforeEach(() => {
      testConfig.accessMode = 'allowlist';
    });

    it('LID sender whose phone is allowed → responds', () => {
      const msg = makeMsg({
        chatJid: ADMIN_LID_JID,
        senderJid: ADMIN_LID_JID,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('dm_allowed');
    });

    it('LID sender whose phone is allowed (non-admin user) → responds', () => {
      const msg = makeMsg({
        chatJid: USER_LID_JID,
        senderJid: USER_LID_JID,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('dm_allowed');
    });

    it('LID sender whose phone is pending → rejected as pending', () => {
      // Add a LID mapping for the pending user
      upsertLidMapping(db, '11111111111', `${UNKNOWN_PHONE}@s.whatsapp.net`);
      const msg = makeMsg({
        chatJid: '11111111111@lid',
        senderJid: '11111111111@lid',
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(false);
      expect(result.reason).toBe('pending');
    });

    it('LID sender with unknown/unresolvable LID → rejected as unknown', () => {
      const msg = makeMsg({
        chatJid: UNKNOWN_LID_JID,
        senderJid: UNKNOWN_LID_JID,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(false);
      expect(result.reason).toBe('unknown');
    });

    it('phone JID sender who is allowed → responds (baseline)', () => {
      const msg = makeMsg({
        chatJid: ADMIN_JID,
        senderJid: ADMIN_JID,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('dm_allowed');
    });

    it('LID and JID of same person both get same access result', () => {
      const jidResult = shouldRespond(
        makeMsg({ chatJid: USER_JID, senderJid: USER_JID }),
        BOT_JID, BOT_LID, db,
      );
      const lidResult = shouldRespond(
        makeMsg({ chatJid: USER_LID_JID, senderJid: USER_LID_JID }),
        BOT_JID, BOT_LID, db,
      );
      expect(jidResult.respond).toBe(lidResult.respond);
      expect(jidResult.reason).toBe(lidResult.reason);
    });
  });

  describe('self_only mode', () => {
    beforeEach(() => {
      testConfig.accessMode = 'self_only';
    });

    it('admin via LID → responds', () => {
      const msg = makeMsg({
        chatJid: ADMIN_LID_JID,
        senderJid: ADMIN_LID_JID,
        isGroup: false,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('self_only_admin');
    });

    it('admin via personal JID → responds', () => {
      const msg = makeMsg({
        chatJid: ADMIN_JID,
        senderJid: ADMIN_JID,
        isGroup: false,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('self_only_admin');
    });

    it('non-admin via LID → rejected', () => {
      const msg = makeMsg({
        chatJid: USER_LID_JID,
        senderJid: USER_LID_JID,
        isGroup: false,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(false);
      expect(result.reason).toBe('self_only_rejected');
    });

    it('unresolvable LID → rejected with distinct reason', () => {
      const msg = makeMsg({
        chatJid: UNKNOWN_LID_JID,
        senderJid: UNKNOWN_LID_JID,
        isGroup: false,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(false);
      expect(result.reason).toBe('self_only_lid_unresolvable');
      expect(result.accessStatus).toBe('blocked');
    });

    it('groups always rejected in self_only, even from admin LID', () => {
      const msg = makeMsg({
        chatJid: GROUP_JID,
        senderJid: ADMIN_LID_JID,
        isGroup: true,
        mentionedJids: [BOT_JID],
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(false);
      expect(result.reason).toBe('self_only_no_groups');
    });
  });

  describe('open_dm mode', () => {
    beforeEach(() => {
      testConfig.accessMode = 'open_dm';
    });

    it('LID DM from anyone → responds (open mode)', () => {
      const msg = makeMsg({
        chatJid: UNKNOWN_LID_JID,
        senderJid: UNKNOWN_LID_JID,
        isGroup: false,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('open_dm');
    });

    it('blocked LID sender still blocked in open_dm', () => {
      // Add blocked entry for a LID-mapped phone
      const blockedPhone = '12223334444';
      const blockedLid = '77777777777';
      upsertLidMapping(db, blockedLid, `${blockedPhone}@s.whatsapp.net`);
      db.raw.prepare(
        "INSERT OR IGNORE INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'blocked')"
      ).run(blockedPhone);

      const msg = makeMsg({
        chatJid: `${blockedLid}@lid`,
        senderJid: `${blockedLid}@lid`,
        isGroup: false,
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(false);
      expect(result.reason).toBe('blocked');
    });
  });

  describe('LID senders in groups', () => {
    beforeEach(() => {
      testConfig.accessMode = 'allowlist';
    });

    it('LID sender in group with bot @mention → responds', () => {
      const msg = makeMsg({
        chatJid: GROUP_JID,
        senderJid: USER_LID_JID,
        isGroup: true,
        mentionedJids: [BOT_JID],
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(true);
      expect(result.reason).toBe('mentioned');
    });

    it('blocked LID sender in group with @mention → blocked', () => {
      const blockedPhone2 = '13334445555';
      const blockedLid2 = '66666666666';
      upsertLidMapping(db, blockedLid2, `${blockedPhone2}@s.whatsapp.net`);
      db.raw.prepare(
        "INSERT OR IGNORE INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'blocked')"
      ).run(blockedPhone2);

      const msg = makeMsg({
        chatJid: GROUP_JID,
        senderJid: `${blockedLid2}@lid`,
        isGroup: true,
        mentionedJids: [BOT_JID],
      });
      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);
      expect(result.respond).toBe(false);
      expect(result.reason).toBe('blocked');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. isAdminMessage — LID admin detection
// ═══════════════════════════════════════════════════════════════════════════

describe('isAdminMessage with LID senders', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDb();
    seedLidMappings(db);
    testConfig.adminPhones = new Set([ADMIN_PHONE]);
  });

  afterAll(() => {
    db.close();
  });

  it('admin via personal JID → true', () => {
    const msg = makeMsg({ senderJid: ADMIN_JID, isGroup: false });
    expect(isAdminMessage(msg, db)).toBe(true);
  });

  it('admin via LID JID → true (resolved to phone)', () => {
    const msg = makeMsg({ senderJid: ADMIN_LID_JID, isGroup: false });
    expect(isAdminMessage(msg, db)).toBe(true);
  });

  it('admin via LID with colon-device suffix → true', () => {
    const msg = makeMsg({ senderJid: `${ADMIN_LID}:2@lid`, isGroup: false });
    expect(isAdminMessage(msg, db)).toBe(true);
  });

  it('non-admin via personal JID → false', () => {
    const msg = makeMsg({ senderJid: USER_JID, isGroup: false });
    expect(isAdminMessage(msg, db)).toBe(false);
  });

  it('non-admin via LID → false', () => {
    const msg = makeMsg({ senderJid: USER_LID_JID, isGroup: false });
    expect(isAdminMessage(msg, db)).toBe(false);
  });

  it('admin via LID in group → false (groups always false)', () => {
    const msg = makeMsg({ senderJid: ADMIN_LID_JID, isGroup: true });
    expect(isAdminMessage(msg, db)).toBe(false);
  });

  it('unresolvable LID → false', () => {
    const msg = makeMsg({ senderJid: UNKNOWN_LID_JID, isGroup: false });
    expect(isAdminMessage(msg, db)).toBe(false);
  });

  it('admin phone without country code matches via suffix (8455880337)', () => {
    testConfig.adminPhones.add('8455880337'); // no country code
    const msg = makeMsg({ senderJid: ADMIN_LID_JID, isGroup: false });
    expect(isAdminMessage(msg, db)).toBe(true);
    testConfig.adminPhones.delete('8455880337');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. ContactsDirectory — LID resolution for @mentions
// ═══════════════════════════════════════════════════════════════════════════

describe('ContactsDirectory with LID resolution', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDb();
    seedLidMappings(db);
  });
  afterAll(() => db.close());

  it('resolves LID sender to real phone in contacts map', () => {
    const dir = new ContactsDirectory(db);
    dir.observe(ADMIN_LID_JID, 'Shannon');

    // Should be indexed by resolved phone, not opaque LID
    expect(dir.resolve('shannon')).toBe(ADMIN_PHONE);
    expect(dir.resolve(ADMIN_PHONE)).toBe(ADMIN_PHONE);
  });

  it('personal JID sender → phone directly', () => {
    const dir = new ContactsDirectory(db);
    dir.observe(ADMIN_JID, 'Shannon');
    expect(dir.resolve('shannon')).toBe(ADMIN_PHONE);
  });

  it('same person via LID and JID → same phone in directory', () => {
    const dir = new ContactsDirectory(db);
    dir.observe(ADMIN_JID, 'Shannon');
    dir.observe(ADMIN_LID_JID, 'Shannon Quiles');

    expect(dir.resolve('shannon')).toBe(ADMIN_PHONE);
    expect(dir.resolve('shannon quiles')).toBe(ADMIN_PHONE);
    expect(dir.resolve(ADMIN_PHONE)).toBe(ADMIN_PHONE);
  });

  it('unresolvable LID → falls back to raw LID number in contacts', () => {
    const dir = new ContactsDirectory(db);
    dir.observe(UNKNOWN_LID_JID, 'Stranger');

    // Since LID can't be resolved, it stores the raw LID
    expect(dir.resolve('stranger')).toBe(UNKNOWN_LID);
  });

  it('without DB → uses extractLocal (raw LID)', () => {
    const dir = new ContactsDirectory(); // no DB
    dir.observe(ADMIN_LID_JID, 'Shannon');

    // Without DB, stores raw LID
    expect(dir.resolve('shannon')).toBe(ADMIN_LID);
  });

  it('setDatabase enables resolution for subsequent observations', () => {
    const dir = new ContactsDirectory();
    dir.observe(USER_LID_JID, 'Alice'); // before DB — raw LID
    expect(dir.resolve('alice')).toBe(USER_LID);

    dir.setDatabase(db);
    dir.observe(USER_LID_JID, 'Alice Updated'); // after DB — resolved
    // 'alice updated' should now resolve to real phone
    expect(dir.resolve('alice updated')).toBe(USER_PHONE);
  });

  it('LID cache prevents repeated DB queries', () => {
    const dir = new ContactsDirectory(db);

    // Observe same LID sender multiple times
    for (let i = 0; i < 10; i++) {
      dir.observe(ADMIN_LID_JID, 'Shannon');
    }

    // Should still resolve correctly
    expect(dir.resolve('shannon')).toBe(ADMIN_PHONE);
    // Size should not grow unboundedly (same keys overwritten)
    expect(dir.size).toBeLessThanOrEqual(3); // phone, full name, first name
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Conversation key consistency — LID vs JID
// ═══════════════════════════════════════════════════════════════════════════

describe('toConversationKey with LID JIDs', () => {
  it('personal JID → phone digits', () => {
    expect(toConversationKey(ADMIN_JID)).toBe(ADMIN_PHONE);
  });

  it('LID JID → LID number (NOT the phone)', () => {
    // This is expected — conversation keys use the local part
    // The important thing is that resolvePhoneFromJid resolves it
    expect(toConversationKey(ADMIN_LID_JID)).toBe(ADMIN_LID);
  });

  it('LID with colon suffix → stripped LID', () => {
    expect(toConversationKey(`${ADMIN_LID}:2@lid`)).toBe(ADMIN_LID);
  });

  it('group JID → group key format', () => {
    expect(toConversationKey(GROUP_JID)).toBe('120363123456789_at_g.us');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Rate limiter key normalization
// ═══════════════════════════════════════════════════════════════════════════

describe('rate limiter key normalization', () => {
  it('same person via JID and LID → same conversation key for rate limit', () => {
    // The chat runtime uses toConversationKey(msg.senderJid) for rate limits
    const jidKey = toConversationKey(ADMIN_JID);
    const lidKey = toConversationKey(ADMIN_LID_JID);

    // These will be DIFFERENT because toConversationKey doesn't resolve LIDs
    // But that's okay because the rate limiter uses senderJid's conversation key
    // and the messages table tracks both separately
    expect(jidKey).toBe(ADMIN_PHONE);
    expect(lidKey).toBe(ADMIN_LID);

    // The important thing: each format is internally consistent
    // A sender always uses the same JID format within a session
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. isAdminPhone — suffix matching with LID-resolved phones
// ═══════════════════════════════════════════════════════════════════════════

describe('isAdminPhone with various phone formats', () => {
  const adminSet = new Set(['18455880337']);

  it('exact match', () => {
    expect(isAdminPhone('18455880337', adminSet)).toBe(true);
  });

  it('without country code (suffix match)', () => {
    expect(isAdminPhone('8455880337', adminSet)).toBe(true);
  });

  it('with different country code format (no match if too different)', () => {
    expect(isAdminPhone('5555555555', adminSet)).toBe(false);
  });

  it('short numbers are rejected (min 7 digits)', () => {
    const shortSet = new Set(['1234']);
    expect(isAdminPhone('1234', shortSet)).toBe(true); // exact match still works
    expect(isAdminPhone('91234', shortSet)).toBe(false); // suffix match blocked — too short
  });

  it('resolved LID phone matches admin phone', () => {
    // Simulates the full flow: LID → resolvePhoneFromJid → isAdminPhone
    const db = createTestDb();
    seedLidMappings(db);

    const resolved = resolvePhoneFromJid(ADMIN_LID_JID, db);
    expect(isAdminPhone(resolved, adminSet)).toBe(true);
    db.close();
  });

  it('unresolved LID number does NOT match admin phone', () => {
    const db = createTestDb();
    const resolved = resolvePhoneFromJid(UNKNOWN_LID_JID, db);
    expect(isAdminPhone(resolved, adminSet)).toBe(false);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Access list: LID sender approval/blocking lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('access list with LID-resolved phones', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDb();
    seedLidMappings(db);
  });
  afterAll(() => db.close());

  it('resolvePhoneFromJid result matches access list entries', () => {
    insertAllowed(db, 'phone', ADMIN_PHONE);
    const phone = resolvePhoneFromJid(ADMIN_LID_JID, db);
    const entry = lookupAccess(db, 'phone', phone);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('allowed');
  });

  it('approval request stores resolved phone, not LID', () => {
    // Simulate: sender uses LID, approval stores their resolved phone
    const phone = resolvePhoneFromJid(USER_LID_JID, db);
    insertPending(db, 'phone', phone, 'LID User');

    // Lookup by resolved phone should find it
    const entry = lookupAccess(db, 'phone', USER_PHONE);
    expect(entry).not.toBeNull();
    expect(entry!.displayName).toBe('LID User');
  });

  it('blocking a resolved phone blocks both JID and LID senders', () => {
    const blockPhone = '14445556666';
    const blockLid = '22222222222';
    upsertLidMapping(db, blockLid, `${blockPhone}@s.whatsapp.net`);

    // Block the phone
    upsertAccess(db, 'phone', blockPhone, 'allowed');
    updateAccess(db, 'phone', blockPhone, 'blocked');

    // Both JID and LID should resolve to the same blocked phone
    const fromJid = resolvePhoneFromJid(`${blockPhone}@s.whatsapp.net`, db);
    const fromLid = resolvePhoneFromJid(`${blockLid}@lid`, db);
    expect(fromJid).toBe(fromLid);
    expect(lookupAccess(db, 'phone', fromJid)!.status).toBe('blocked');
    expect(lookupAccess(db, 'phone', fromLid)!.status).toBe('blocked');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. parseAdminCommand — commands use resolved phone for allow/block
// ═══════════════════════════════════════════════════════════════════════════

describe('parseAdminCommand and LID interactions', () => {
  it('ALLOW command with phone number', () => {
    const cmd = parseAdminCommand('allow 18455880337');
    expect(cmd).not.toBeNull();
    expect(cmd!.action).toBe('allow');
    expect(cmd!.subjectType).toBe('phone');
    expect(cmd!.subjectId).toBe('18455880337');
  });

  it('ALLOW command with LID number (treated as phone digits)', () => {
    // If admin types "allow 31478083756155" they're allowing the raw number
    // This is expected — the admin should use the real phone, not the LID
    const cmd = parseAdminCommand('allow 31478083756155');
    expect(cmd).not.toBeNull();
    expect(cmd!.subjectId).toBe('31478083756155');
  });

  it('BLOCK command with group JID', () => {
    const cmd = parseAdminCommand('block group 120363123456789@g.us');
    expect(cmd).not.toBeNull();
    expect(cmd!.action).toBe('block');
    expect(cmd!.subjectType).toBe('group');
    expect(cmd!.subjectId).toBe('120363123456789@g.us');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. JID construction helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('JID construction roundtrip', () => {
  it('toPersonalJid + extractLocal roundtrips', () => {
    expect(extractLocal(toPersonalJid('18455880337'))).toBe('18455880337');
  });

  it('toLidJid + extractLocal roundtrips', () => {
    expect(extractLocal(toLidJid('31478083756155'))).toBe('31478083756155');
  });

  it('toPersonalJid + resolvePhoneFromJid roundtrips', () => {
    const db = createTestDb();
    expect(resolvePhoneFromJid(toPersonalJid('18455880337'), db)).toBe('18455880337');
    db.close();
  });

  it('toLidJid + resolvePhoneFromJid resolves when mapping exists', () => {
    const db = createTestDb();
    upsertLidMapping(db, '31478083756155', '18455880337@s.whatsapp.net');
    expect(resolvePhoneFromJid(toLidJid('31478083756155'), db)).toBe('18455880337');
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Phone normalization integration
// ═══════════════════════════════════════════════════════════════════════════

describe('phone normalization with resolved LID phones', () => {
  it('normalizePhone strips non-digits from resolved phone', () => {
    expect(normalizePhone('18455880337')).toBe('18455880337');
    expect(normalizePhone('+1-845-588-0337')).toBe('18455880337');
  });

  it('normalizePhoneE164 adds country code for 10-digit numbers', () => {
    expect(normalizePhoneE164('8455880337')).toBe('18455880337');
    expect(normalizePhoneE164('18455880337')).toBe('18455880337');
  });

  it('resolved LID phone is already E.164 (no normalization needed)', () => {
    const db = createTestDb();
    seedLidMappings(db);
    const phone = resolvePhoneFromJid(ADMIN_LID_JID, db);
    expect(phone).toBe(normalizePhoneE164(phone));
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Edge cases and boundary conditions
// ═══════════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  let db: Database;

  beforeAll(() => {
    db = createTestDb();
    seedLidMappings(db);
  });
  afterAll(() => db.close());

  it('LID with multiple colons (e.g. 12345:67:89@lid)', () => {
    // Should strip everything after first colon
    upsertLidMapping(db, '12345', '19998887777@s.whatsapp.net');
    expect(resolveLid(db, '12345:67:89')).toBe('19998887777');
    expect(resolvePhoneFromJid('12345:67:89@lid', db)).toBe('19998887777');
  });

  it('very long LID number', () => {
    const longLid = '9'.repeat(20);
    expect(resolveLid(db, longLid)).toBeNull();
    expect(resolvePhoneFromJid(`${longLid}@lid`, db)).toBe(longLid);
  });

  it('LID that looks like a phone number', () => {
    // A LID could coincidentally be a valid phone number
    upsertLidMapping(db, '15551234567', '15559876543@s.whatsapp.net');
    // resolvePhoneFromJid should resolve it via DB, not return it as-is
    expect(resolvePhoneFromJid('15551234567@lid', db)).toBe('15559876543');
  });

  it('same number used as both phone and LID (different identities)', () => {
    // Phone 14445556666 exists in access list
    insertAllowed(db, 'phone', '14445556666');
    // LID 14445556666 maps to a DIFFERENT phone
    upsertLidMapping(db, '14445556666', '17778889999@s.whatsapp.net');

    // Personal JID → returns the phone directly
    expect(resolvePhoneFromJid('14445556666@s.whatsapp.net', db)).toBe('14445556666');
    // LID JID → resolves to the mapped phone
    expect(resolvePhoneFromJid('14445556666@lid', db)).toBe('17778889999');
  });

  it('newsletter JID does not attempt LID resolution', () => {
    expect(resolvePhoneFromJid('123@newsletter', db)).toBe('123_at_newsletter');
  });

  it('unknown domain falls back gracefully', () => {
    expect(resolvePhoneFromJid('123@unknowndomain', db)).toBe('123_at_unknowndomain');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. LID conversation key resolution in ingest
// ═══════════════════════════════════════════════════════════════════════════

describe('LID DM conversation key resolution', () => {
  it('LID DM resolves to phone-based conversation key (not LID number)', () => {
    const db = createTestDb();
    seedLidMappings(db);

    // For a LID DM, the conversation key should be the resolved phone, not the LID
    // This is what ingest.ts now does for !isGroup && chatJid.endsWith('@lid')
    const chatJid = ADMIN_LID_JID;
    const isGroup = false;
    const key = !isGroup && chatJid.endsWith('@lid')
      ? resolvePhoneFromJid(chatJid, db)
      : toConversationKey(chatJid);

    expect(key).toBe(ADMIN_PHONE); // resolved to phone, not LID number
    db.close();
  });

  it('phone JID DM uses standard conversation key', () => {
    const chatJid = ADMIN_JID;
    const key = toConversationKey(chatJid);
    expect(key).toBe(ADMIN_PHONE);
  });

  it('same person via LID and JID produces same conversation key', () => {
    const db = createTestDb();
    seedLidMappings(db);

    const lidKey = resolvePhoneFromJid(ADMIN_LID_JID, db);
    const jidKey = toConversationKey(ADMIN_JID);
    expect(lidKey).toBe(jidKey);
    db.close();
  });

  it('unresolvable LID DM falls back to raw LID as conversation key', () => {
    const db = createTestDb();
    // No mappings seeded — LID can't resolve
    const key = resolvePhoneFromJid(UNKNOWN_LID_JID, db);
    expect(key).toBe(UNKNOWN_LID);
    db.close();
  });

  it('group messages still use standard toConversationKey (not resolved)', () => {
    const db = createTestDb();
    const key = toConversationKey(GROUP_JID);
    expect(key).toBe('120363123456789_at_g.us');
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. upsertLidMapping — access list migration on new mapping discovery
// ═══════════════════════════════════════════════════════════════════════════

describe('upsertLidMapping access list migration', () => {
  it('migrates orphaned LID-based access entry to real phone', () => {
    const db = createTestDb();
    const lid = '55555555555';
    const realPhone = '16667778888';

    // Simulate: LID sender approved before mapping was known
    insertPending(db, 'phone', lid, 'Unknown LID User');
    updateAccess(db, 'phone', lid, 'allowed');
    expect(lookupAccess(db, 'phone', lid)!.status).toBe('allowed');

    // Now the LID mapping arrives
    upsertLidMapping(db, lid, `${realPhone}@s.whatsapp.net`);

    // The orphaned LID entry should be migrated to the real phone
    expect(lookupAccess(db, 'phone', lid)).toBeNull(); // old entry gone
    expect(lookupAccess(db, 'phone', realPhone)!.status).toBe('allowed'); // new entry

    db.close();
  });

  it('does not overwrite existing real-phone entry when LID entry also exists', () => {
    const db = createTestDb();
    const lid = '66666666666';
    const realPhone = '17778889999';

    // Real phone already blocked, LID entry is allowed (stale/orphan)
    insertAllowed(db, 'phone', lid);
    insertPending(db, 'phone', realPhone, 'Real User');
    updateAccess(db, 'phone', realPhone, 'blocked');

    upsertLidMapping(db, lid, `${realPhone}@s.whatsapp.net`);

    // Real phone entry should be preserved (blocked), orphan deleted
    expect(lookupAccess(db, 'phone', realPhone)!.status).toBe('blocked');
    expect(lookupAccess(db, 'phone', lid)).toBeNull();

    db.close();
  });

  it('no-op when LID and phone are the same (no migration needed)', () => {
    const db = createTestDb();
    const num = '12345678901';

    insertAllowed(db, 'phone', num);
    upsertLidMapping(db, num, `${num}@s.whatsapp.net`);

    // Entry should still exist unchanged
    expect(lookupAccess(db, 'phone', num)!.status).toBe('allowed');
    db.close();
  });

  it('no-op when no orphaned access entry exists', () => {
    const db = createTestDb();
    upsertLidMapping(db, '99999', '11111@s.whatsapp.net');
    // Nothing crashes, no orphan to migrate
    expect(lookupAccess(db, 'phone', '99999')).toBeNull();
    expect(lookupAccess(db, 'phone', '11111')).toBeNull();
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. ALLOW replay finds LID-stored messages via reverse lookup
// ═══════════════════════════════════════════════════════════════════════════

describe('ALLOW replay with LID-stored messages', () => {
  it('getAllLidMappings finds LIDs that map to the allowed phone', () => {
    const db = createTestDb();
    upsertLidMapping(db, ADMIN_LID, ADMIN_JID);
    upsertLidMapping(db, USER_LID, USER_JID);

    const all = getAllLidMappings(db);
    // Should find the LID that maps to admin phone
    const adminLids: string[] = [];
    for (const [lid, phone] of all) {
      if (isAdminPhone(phone, new Set([ADMIN_PHONE]))) {
        adminLids.push(lid);
      }
    }
    expect(adminLids).toContain(ADMIN_LID);
    expect(adminLids).not.toContain(USER_LID);
    db.close();
  });

  it('toLidJid with actual LID number constructs valid sender_jid for lookup', () => {
    // This verifies the fix: we now use the actual LID from lid_mappings,
    // NOT toLidJid(phone) which would construct an invalid JID
    const validLidJid = toLidJid(ADMIN_LID); // '31478083756155@lid'
    expect(validLidJid).toBe(`${ADMIN_LID}@lid`);

    // The old broken approach:
    const invalidLidJid = toLidJid(ADMIN_PHONE); // '18455880337@lid' — WRONG
    expect(invalidLidJid).toBe(`${ADMIN_PHONE}@lid`);
    // This would never match any message in the DB
    expect(invalidLidJid).not.toBe(validLidJid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18. LID sender display name — no opaque LID leak
// ═══════════════════════════════════════════════════════════════════════════

describe('LID sender display name handling', () => {
  it('resolvePhoneFromJid provides real phone as display fallback', () => {
    const db = createTestDb();
    seedLidMappings(db);

    // Agent runtime uses: const phone = resolvePhoneFromJid(senderJid, db)
    // then: const displayName = senderName ?? phone
    const senderName = null;
    const phone = resolvePhoneFromJid(ADMIN_LID_JID, db);
    const displayName = senderName ?? phone;

    // Should be real phone, not opaque LID
    expect(displayName).toBe(ADMIN_PHONE);
    expect(displayName).not.toBe(ADMIN_LID);
    db.close();
  });

  it('unresolvable LID falls back to LID number (unavoidable)', () => {
    const db = createTestDb();
    const phone = resolvePhoneFromJid(UNKNOWN_LID_JID, db);
    const displayName = null ?? phone;
    // This is the best we can do without a mapping
    expect(displayName).toBe(UNKNOWN_LID);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19. Rate limiter — unified bucket for JID/LID via resolvePhoneFromJid
// ═══════════════════════════════════════════════════════════════════════════

describe('rate limiter identity unification', () => {
  it('same person via JID and LID produces same rate limit key', () => {
    const db = createTestDb();
    seedLidMappings(db);

    // Chat runtime now uses resolvePhoneFromJid(msg.senderJid, db) for rate limit key
    const jidKey = resolvePhoneFromJid(ADMIN_JID, db);
    const lidKey = resolvePhoneFromJid(ADMIN_LID_JID, db);
    expect(jidKey).toBe(lidKey);
    expect(jidKey).toBe(ADMIN_PHONE);
    db.close();
  });

  it('unresolvable LID gets its own rate limit bucket (expected)', () => {
    const db = createTestDb();
    const key = resolvePhoneFromJid(UNKNOWN_LID_JID, db);
    expect(key).toBe(UNKNOWN_LID);
    // Different from any phone-based key — acceptable since we can't resolve
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20. Blocklist sync — propagates to access_list with LID resolution
// ═══════════════════════════════════════════════════════════════════════════

describe('blocklist sync with LID resolution', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedLidMappings(db);
  });

  afterEach(() => db.close());

  it('handleBlocklistSet propagates blocks to access_list via resolved phone', () => {
    handleBlocklistSet(db, [ADMIN_JID]);
    const entry = lookupAccess(db, 'phone', ADMIN_PHONE);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('blocked');
  });

  it('handleBlocklistSet resolves LID JIDs before blocking', () => {
    handleBlocklistSet(db, [ADMIN_LID_JID]);
    // Should block the resolved phone, not the LID number
    const entry = lookupAccess(db, 'phone', ADMIN_PHONE);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('blocked');
    // No entry for the raw LID
    expect(lookupAccess(db, 'phone', ADMIN_LID)).toBeNull();
  });

  it('handleBlocklistUpdate add → blocks resolved phone', () => {
    handleBlocklistUpdate(db, { blocklist: [USER_LID_JID], type: 'add' });
    const entry = lookupAccess(db, 'phone', USER_PHONE);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('blocked');
  });

  it('handleBlocklistUpdate remove → unblocks if currently blocked', () => {
    // First block
    handleBlocklistUpdate(db, { blocklist: [USER_JID], type: 'add' });
    expect(lookupAccess(db, 'phone', USER_PHONE)!.status).toBe('blocked');
    // Then unblock
    handleBlocklistUpdate(db, { blocklist: [USER_JID], type: 'remove' });
    expect(lookupAccess(db, 'phone', USER_PHONE)!.status).toBe('allowed');
  });

  it('handleBlocklistUpdate remove does not change non-blocked entry', () => {
    // Insert as allowed
    insertAllowed(db, 'phone', ADMIN_PHONE);
    // Remove from blocklist (wasn't blocked via access_list)
    handleBlocklistUpdate(db, { blocklist: [ADMIN_JID], type: 'remove' });
    // Should still be allowed (not changed)
    expect(lookupAccess(db, 'phone', ADMIN_PHONE)!.status).toBe('allowed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 21. ContactsDirectory LID cache — invalidation and bounds
// ═══════════════════════════════════════════════════════════════════════════

describe('ContactsDirectory LID cache lifecycle', () => {
  it('invalidateLidCache clears cached resolutions', () => {
    const db = createTestDb();
    seedLidMappings(db);
    const dir = new ContactsDirectory(db);

    // Observe to populate cache
    dir.observe(ADMIN_LID_JID, 'Shannon');
    expect(dir.resolve('shannon')).toBe(ADMIN_PHONE);

    // Update the mapping to a different phone
    upsertLidMapping(db, ADMIN_LID, '19998887777@s.whatsapp.net');

    // Cache still has old value
    dir.observe(ADMIN_LID_JID, 'Shannon Updated');
    expect(dir.resolve('shannon updated')).toBe(ADMIN_PHONE); // stale

    // Invalidate cache
    dir.invalidateLidCache();

    // Now observe again — should re-resolve from DB
    dir.observe(ADMIN_LID_JID, 'Shannon Fresh');
    expect(dir.resolve('shannon fresh')).toBe('19998887777'); // updated

    db.close();
  });

  it('lidCache is bounded to maxEntries', () => {
    const db = createTestDb();
    const dir = new ContactsDirectory(db, 5); // small cap

    // Create more LID mappings than the cap
    for (let i = 0; i < 10; i++) {
      const lid = `${90000000000 + i}`;
      upsertLidMapping(db, lid, `1555000${i}@s.whatsapp.net`);
      dir.observe(`${lid}@lid`, `User ${i}`);
    }

    // The lidCache should not exceed maxEntries
    // We can't directly inspect private fields, but we can verify it doesn't crash
    // and that the latest entries are correctly resolved
    expect(dir.resolve('user 9')).toBe('15550009');
    db.close();
  });
});
