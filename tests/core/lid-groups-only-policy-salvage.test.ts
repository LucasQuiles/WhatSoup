/**
 * shouldRespond() — LID senders in groups_only access mode.
 *
 * Salvaged coverage for the two behaviors main's access-policy.test.ts does not exercise
 * (it runs in allowlist mode and has no groups_only_no_dms coverage):
 *   - A LID DM is rejected (groups_only_no_dms) even when the resolved phone is allowed.
 *   - A LID group sender still gets a response when the bot is @mentioned.
 * Uses a self-contained testConfig.accessMode harness + a real in-memory DB seeded with a
 * real LID→phone→allowed mapping, exercising the real shouldRespond against production logic.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock config — vi.hoisted runs before vi.mock factories
// ---------------------------------------------------------------------------

const { testConfig } = vi.hoisted(() => {
  const testConfig = {
    adminPhones: new Set(['15551230007']),
    accessMode: 'allowlist' as string,
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth-lid-groups-only-policy-salvage',
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

vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());

import { Database } from '../../src/core/database.ts';
import { insertPending, insertAllowed } from '../../src/core/access-list.ts';
import { upsertLidMapping } from '../../src/core/lid-resolver.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';
import type { IncomingMessage } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const ADMIN_PHONE = '15551230007';
const ADMIN_LID = '31478083756155';
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;
const ADMIN_LID_JID = `${ADMIN_LID}@lid`;

const USER_PHONE = '15551230008';
const USER_LID = '11111110000005';
const USER_JID = `${USER_PHONE}@s.whatsapp.net`;
const USER_LID_JID = `${USER_LID}@lid`;

const UNKNOWN_PHONE = '19999999999';
const UNKNOWN_LID = '88888888888888';
const UNKNOWN_JID = `${UNKNOWN_PHONE}@s.whatsapp.net`;
const UNKNOWN_LID_JID = `${UNKNOWN_LID}@lid`;

const BOT_JID = '15551230003@s.whatsapp.net';
const BOT_LID = '11111110000005@lid';

const GROUP_JID = '12223334444-group@g.us';

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
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

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

  describe('groups_only mode', () => {
    beforeEach(() => {
      testConfig.accessMode = 'groups_only';
    });

    it('rejects LID DMs even when the resolved phone is allowed', () => {
      const msg = makeMsg({
        chatJid: USER_LID_JID,
        senderJid: USER_LID_JID,
        isGroup: false,
      });

      const result = shouldRespond(msg, BOT_JID, BOT_LID, db);

      expect(result.respond).toBe(false);
      expect(result.reason).toBe('groups_only_no_dms');
    });

    it('still responds to LID group senders when the bot is mentioned', () => {
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
  });
});
