/**
 * Tests for POST /mark-read handler in src/core/health.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { request } from 'node:http';

// ---------------------------------------------------------------------------
// Mock config and logger
// ---------------------------------------------------------------------------

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9998, // won't actually be used (tests override)
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

const lookupCredentialMock = vi.hoisted(() => vi.fn(
  (service: string) => service === 'whatsoup-health-token'
    ? process.env.WHATSOUP_HEALTH_TOKEN ?? null
    : null,
));

vi.mock('../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: lookupCredentialMock };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import type { HealthDeps } from '../../src/core/health.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function httpReq(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
        ...extraHeaders,
      },
    };
    const req = request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Build test server on ephemeral port
// ---------------------------------------------------------------------------

async function buildTestServer(deps: HealthDeps): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const { startHealthServer } = await import('../../src/core/health.ts');

  return new Promise((resolve) => {
    const server = startHealthServer(deps);
    server.close(() => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ server, port });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeDeps(db: Database, overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    db,
    connectionManager: {
      botJid: '15551230004@s.whatsapp.net',
      botLid: null,
      getSocket: vi.fn().mockReturnValue(null),
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'WhatSoup',
    instanceType: 'chat',
    accessMode: 'allowlist',
    ...overrides,
  };
}

/** Insert a chat row into the in-memory DB. */
function insertChat(db: Database, jid: string, conversationKey: string, unreadCount = 3): void {
  db.raw
    .prepare(
      'INSERT INTO chats (jid, conversation_key, unread_count) VALUES (?, ?, ?)',
    )
    .run(jid, conversationKey, unreadCount);
}

/** Insert a message row into the in-memory DB. */
function insertMessage(
  db: Database,
  conversationKey: string,
  chatJid: string,
  messageId: string,
  senderJid: string,
  timestamp: number,
): void {
  db.raw
    .prepare(
      `INSERT INTO messages
         (chat_jid, conversation_key, sender_jid, message_id, timestamp, is_from_me)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(chatJid, conversationKey, senderJid, messageId, timestamp);
}

/** Read unread_count back from chats. */
function getUnreadCount(db: Database, conversationKey: string): number {
  const row = db.raw
    .prepare('SELECT unread_count FROM chats WHERE conversation_key = ?')
    .get(conversationKey) as { unread_count: number } | undefined;
  return row?.unread_count ?? -1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const AUTH_TOKEN = 'test-token';
const AUTH_HEADER = { authorization: `Bearer ${AUTH_TOKEN}` };
const BOT_JID = '15551230004@s.whatsapp.net';
const CHAT_JID = '15550100001@s.whatsapp.net';
const CONV_KEY = '15550100001';

describe('POST /mark-read', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;
  let chatModify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    lookupCredentialMock.mockClear();
    process.env.WHATSOUP_HEALTH_TOKEN = AUTH_TOKEN;
    db = makeDb();
    chatModify = vi.fn().mockResolvedValue(undefined);

    const connectionManager = {
      botJid: BOT_JID,
      botLid: null,
      getSocket: vi.fn().mockReturnValue({ chatModify }),
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionManager;

    ({ server, port } = await buildTestServer(makeDeps(db, { connectionManager })));
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── 1. Missing conversation_key ───────────────────────────────────────────

  it('returns 400 when conversation_key is missing', async () => {
    const payload = JSON.stringify({});
    const { status, body } = await httpReq(port, '/mark-read', 'POST', payload, AUTH_HEADER);
    expect(status).toBe(400);
    const json = JSON.parse(body);
    expect(json.error).toMatch(/conversation_key/);
  });

  it('returns 400 when body is empty object (no conversation_key)', async () => {
    const payload = JSON.stringify({ some_other_field: 'value' });
    const { status, body } = await httpReq(port, '/mark-read', 'POST', payload, AUTH_HEADER);
    expect(status).toBe(400);
    const json = JSON.parse(body);
    expect(json.error).toMatch(/conversation_key/);
  });

  // ── 2. Chat not found ─────────────────────────────────────────────────────

  it('returns 404 when conversation_key does not exist in chats', async () => {
    const payload = JSON.stringify({ conversation_key: 'nonexistent-key' });
    const { status, body } = await httpReq(port, '/mark-read', 'POST', payload, AUTH_HEADER);
    expect(status).toBe(404);
    const json = JSON.parse(body);
    expect(json.error).toMatch(/not found/);
    expect(json.conversation_key).toBe('nonexistent-key');
  });

  // ── 3. Success: zeroes unread_count and calls chatModify ──────────────────

  it('returns 200, zeroes unread_count, and calls chatModify when messages exist', async () => {
    insertChat(db, CHAT_JID, CONV_KEY, 5);
    const msgTs = Math.floor(Date.now() / 1000);
    insertMessage(db, CONV_KEY, CHAT_JID, 'msg-abc123', 'other@s.whatsapp.net', msgTs);

    const payload = JSON.stringify({ conversation_key: CONV_KEY });
    const { status, body } = await httpReq(port, '/mark-read', 'POST', payload, AUTH_HEADER);

    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.ok).toBe(true);
    expect(json.jid).toBe(CHAT_JID);
    expect(json.conversation_key).toBe(CONV_KEY);

    // DB should be zeroed
    expect(getUnreadCount(db, CONV_KEY)).toBe(0);

    // chatModify should have been called with markRead: true
    expect(chatModify).toHaveBeenCalledOnce();
    const [modifyArg, jidArg] = chatModify.mock.calls[0] as [unknown, string];
    expect(jidArg).toBe(CHAT_JID);
    expect((modifyArg as { markRead: boolean }).markRead).toBe(true);
    const lastMessages = (modifyArg as { lastMessages: { key: { id: string; fromMe: boolean }; messageTimestamp: number }[] }).lastMessages;
    expect(lastMessages).toHaveLength(1);
    expect(lastMessages[0].key.id).toBe('msg-abc123');
    expect(lastMessages[0].key.fromMe).toBe(false); // sender is not botJid
    expect(lastMessages[0].messageTimestamp).toBe(msgTs);
  });

  it('sets fromMe=true when last message sender_jid equals botJid', async () => {
    insertChat(db, CHAT_JID, CONV_KEY, 2);
    const msgTs = Math.floor(Date.now() / 1000);
    insertMessage(db, CONV_KEY, CHAT_JID, 'msg-fromme', BOT_JID, msgTs);

    const payload = JSON.stringify({ conversation_key: CONV_KEY });
    const { status } = await httpReq(port, '/mark-read', 'POST', payload, AUTH_HEADER);
    expect(status).toBe(200);

    const [modifyArg] = chatModify.mock.calls[0] as [{ lastMessages: { key: { fromMe: boolean } }[] }, string];
    expect(modifyArg.lastMessages[0].key.fromMe).toBe(true);
  });

  // ── 4. No messages: still zeroes unread_count, skips chatModify ───────────

  it('returns 200 and zeroes unread_count even when no messages exist (skips chatModify)', async () => {
    insertChat(db, CHAT_JID, CONV_KEY, 7);
    // No messages inserted

    const payload = JSON.stringify({ conversation_key: CONV_KEY });
    const { status, body } = await httpReq(port, '/mark-read', 'POST', payload, AUTH_HEADER);

    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.ok).toBe(true);
    expect(json.jid).toBe(CHAT_JID);

    // DB should be zeroed
    expect(getUnreadCount(db, CONV_KEY)).toBe(0);

    // chatModify should NOT have been called
    expect(chatModify).not.toHaveBeenCalled();
  });

  // ── 5. Auth guard ─────────────────────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    insertChat(db, CHAT_JID, CONV_KEY, 1);
    const payload = JSON.stringify({ conversation_key: CONV_KEY });
    const { status } = await httpReq(port, '/mark-read', 'POST', payload);
    expect(status).toBe(401);
  });

  it('returns 401 when Authorization header is wrong', async () => {
    insertChat(db, CHAT_JID, CONV_KEY, 1);
    const payload = JSON.stringify({ conversation_key: CONV_KEY });
    const { status } = await httpReq(port, '/mark-read', 'POST', payload, {
      authorization: 'Bearer wrong-token',
    });
    expect(status).toBe(401);
  });
});
