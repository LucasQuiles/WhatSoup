/**
 * Tests for control message interception in src/core/ingest.ts (step 0).
 *
 * Control messages from trusted peers must be:
 *   - Intercepted BEFORE storeMessageIfNew (never land in messages table)
 *   - Stored in control_messages table
 *   - Not forwarded to shouldRespond or runtime.handleMessage
 *
 * Non-peer control-prefixed messages and non-control messages must flow normally.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

// ---------------------------------------------------------------------------
// Module mocks — must be registered before any imports of the mocked modules
// vi.mock factories are hoisted to top of file, so PEER_PHONE/PEER_JID must
// be inlined in the factory rather than referencing top-level variables.
// ---------------------------------------------------------------------------

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    // PEER_PHONE inlined: '15559998888'
    controlPeers: new Map<string, string>([['q', '15559998888']]),
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    models: {
      conversation: 'claude-opus-4-6',
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5',
      fallback: 'gpt-5.4',
    },
  },
}));

// Peer identity constants (must match what's inlined in the mock above)
const PEER_PHONE = '15559998888';
const PEER_JID = `${PEER_PHONE}@s.whatsapp.net`;

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/core/command-router.ts', () => ({
  isAdminMessage: vi.fn().mockReturnValue(false),
  parseAdminCommand: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/core/admin.ts', () => ({
  handleAdminCommand: vi.fn().mockResolvedValue(undefined),
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/access-policy.ts', () => ({
  shouldRespond: vi.fn().mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' }),
}));

// Real extractPhone implementation (strips @domain suffix)
vi.mock('../../src/core/access-list.ts', () => ({
  extractPhone: vi.fn((jid: string) => jid.split('@')[0]),
  extractLocal: vi.fn((jid: string) => jid.split('@')[0]),
  resolvePhoneFromJid: vi.fn((jid: string) => jid.split('@')[0]),
  lookupAccess: vi.fn(),
  insertPending: vi.fn(),
  updateAccess: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import { createIngestHandler } from '../../src/core/ingest.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

function makeRuntime(): Runtime {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(3).toString('hex')}`,
    chatJid: '15184194479@s.whatsapp.net',
    senderJid: '15184194479@s.whatsapp.net',
    senderName: 'Alice',
    content: 'hello',
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

async function runIngest(handler: (msg: IncomingMessage) => void, msg: IncomingMessage): Promise<void> {
  handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const BOT_JID = '18455943112@s.whatsapp.net';

function makeIngest(db: Database, messenger: Messenger, runtime: Runtime, durability?: DurabilityEngine) {
  return createIngestHandler(db, messenger, runtime, () => BOT_JID, () => null, durability);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore happy-path defaults for mocked access-policy
  vi.mocked(shouldRespond).mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' });
});

// ---------------------------------------------------------------------------
// Test 1: Control message from control peer → stored in control_messages, NOT messages
// ---------------------------------------------------------------------------

describe('Control message interception', () => {
  it('control message from trusted peer is stored in control_messages, not messages', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const msg = makeMsg({
      messageId: 'ctrl-msg-001',
      senderJid: PEER_JID,
      content: '[LOOPS_HEAL] {"reportId":"r1","type":"crash","errorClass":"OOM","attempt":1,"maxAttempts":3,"timestamp":"2026-01-01T00:00:00Z"}',
    });

    await runIngest(handler, msg);

    // Must be in control_messages
    const ctrlRow = db.raw.prepare(
      `SELECT * FROM control_messages WHERE message_id = ?`,
    ).get(msg.messageId) as Record<string, unknown> | undefined;
    expect(ctrlRow).toBeDefined();
    expect(ctrlRow?.direction).toBe('inbound');
    expect(ctrlRow?.peer_jid).toBe(PEER_JID);
    expect(ctrlRow?.protocol).toBe('LOOPS_HEAL');

    // Must NOT be in messages table
    const msgRow = db.raw.prepare(
      `SELECT * FROM messages WHERE message_id = ?`,
    ).get(msg.messageId) as Record<string, unknown> | undefined;
    expect(msgRow).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Control message from control peer → runtime.handleMessage NOT called
  // ---------------------------------------------------------------------------

  it('control message from trusted peer does NOT call shouldRespond or runtime.handleMessage', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const msg = makeMsg({
      senderJid: PEER_JID,
      content: '[LOOPS_HEAL] {"reportId":"r2","type":"crash","errorClass":"OOM","attempt":1,"maxAttempts":3,"timestamp":"2026-01-01T00:00:00Z"}',
    });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(shouldRespond)).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 3: Non-control message from control peer → normal path
  // ---------------------------------------------------------------------------

  it('non-control message from control peer flows through the normal path', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const msg = makeMsg({
      messageId: 'normal-from-peer-001',
      senderJid: PEER_JID,
      content: 'hey just checking in',
    });

    await runIngest(handler, msg);

    // Stored in messages (normal path)
    const msgRow = db.raw.prepare(
      `SELECT * FROM messages WHERE message_id = ?`,
    ).get(msg.messageId) as Record<string, unknown> | undefined;
    expect(msgRow).toBeDefined();

    // Runtime was dispatched
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();

    // Nothing in control_messages
    const ctrlRow = db.raw.prepare(
      `SELECT * FROM control_messages WHERE message_id = ?`,
    ).get(msg.messageId) as Record<string, unknown> | undefined;
    expect(ctrlRow).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 4: Control-prefixed message from non-peer → normal path (not trusted)
  // ---------------------------------------------------------------------------

  it('control-prefixed message from non-peer is NOT intercepted (flows through normal path)', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const nonPeerJid = '19995550001@s.whatsapp.net';
    const msg = makeMsg({
      messageId: 'ctrl-from-nonpeer-001',
      senderJid: nonPeerJid,
      content: '[LOOPS_HEAL] {"reportId":"r3","type":"crash","errorClass":"OOM","attempt":1,"maxAttempts":3,"timestamp":"2026-01-01T00:00:00Z"}',
    });

    await runIngest(handler, msg);

    // Should be in messages (normal storage), NOT bypassed
    const msgRow = db.raw.prepare(
      `SELECT * FROM messages WHERE message_id = ?`,
    ).get(msg.messageId) as Record<string, unknown> | undefined;
    expect(msgRow).toBeDefined();

    // Control intercept must NOT have triggered
    const ctrlRow = db.raw.prepare(
      `SELECT * FROM control_messages WHERE message_id = ?`,
    ).get(msg.messageId) as Record<string, unknown> | undefined;
    expect(ctrlRow).toBeUndefined();

    // Normal dispatch occurred (shouldRespond was consulted)
    expect(vi.mocked(shouldRespond)).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Normal messages from normal senders are unaffected
  // ---------------------------------------------------------------------------

  it('normal messages from normal senders are unaffected by control intercept', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const msg = makeMsg({
      messageId: 'normal-msg-001',
      senderJid: '19885551234@s.whatsapp.net',
      content: 'what time is the party?',
    });

    await runIngest(handler, msg);

    // Stored in messages
    const msgRow = db.raw.prepare(
      `SELECT * FROM messages WHERE message_id = ?`,
    ).get(msg.messageId) as Record<string, unknown> | undefined;
    expect(msgRow).toBeDefined();
    expect(msgRow?.content).toBe('what time is the party?');

    // Runtime dispatched
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();

    // Nothing in control_messages
    const ctrlRow = db.raw.prepare(
      `SELECT * FROM control_messages WHERE message_id = ?`,
    ).get(msg.messageId) as Record<string, unknown> | undefined;
    expect(ctrlRow).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Bonus: Durability journaling for control messages
  // ---------------------------------------------------------------------------

  it('control message from peer: durability journals inbound as control + marks skipped', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(42);
    const skipSpy = vi.spyOn(durability, 'markInboundSkipped');

    const handler = makeIngest(db, messenger, runtime, durability);

    const msg = makeMsg({
      senderJid: PEER_JID,
      content: '[HEAL_COMPLETE] {"reportId":"r4","errorClass":"OOM","result":"fixed","diagnosis":"restarted"}',
    });

    await runIngest(handler, msg);

    expect(journalSpy).toHaveBeenCalledOnce();
    expect(journalSpy).toHaveBeenCalledWith(
      msg.messageId,
      expect.any(String),
      msg.chatJid,
      'control',
    );
    expect(skipSpy).toHaveBeenCalledWith(42, 'control_message');
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });
});
