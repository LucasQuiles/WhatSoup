/**
 * Tests for src/core/ingest.ts — the shared ingest pipeline.
 *
 * Uses a real (temp-file) Database for storage verification so we can
 * assert that messages are actually persisted. Messenger and Runtime are mocks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

// ---------------------------------------------------------------------------
// Module mocks — before any imports of the modules they replace
// ---------------------------------------------------------------------------

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAlert: vi.fn(() => ({ ok: true, channel: 'sink', status: 'durably_queued' })),
}));

vi.mock('../../src/core/command-router.ts', () => ({
  isAdminMessage: vi.fn(),
  parseAdminCommand: vi.fn(),
}));

vi.mock('../../src/core/admin.ts', () => ({
  handleAdminCommand: vi.fn(),
  handleFallbackCommand: vi.fn(),
  sendApprovalRequest: vi.fn(),
}));

vi.mock('../../src/core/access-policy.ts', () => ({
  shouldRespond: vi.fn(),
}));

vi.mock('../../src/core/access-list.ts', () => ({
  extractLocal: vi.fn((jid: string) => jid.split('@')[0]),
  resolvePhoneFromJid: vi.fn((jid: string) => jid.split('@')[0]),
  // QR-143 (B4): grant primitive — authenticated transports resolve to the
  // phone; @sms and other non-authenticated transports fail closed (null).
  resolvePhoneFromJidForGrant: vi.fn((jid: string) =>
    jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') ? jid.split('@')[0] : null,
  ),
  lookupAccess: vi.fn(),
  insertPending: vi.fn(),
  updateAccess: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import { createIngestHandler, getIngestStats } from '../../src/core/ingest.ts';
import { drainIngest } from './_helpers/ingest-drain.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { isAdminMessage, parseAdminCommand } from '../../src/core/command-router.ts';
import { handleAdminCommand, handleFallbackCommand, sendApprovalRequest } from '../../src/core/admin.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';
import { extractLocal } from '../../src/core/access-list.ts';
import { getMessagesBySender } from '../../src/core/messages.ts';
import { config } from '../../src/config.ts';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockIsAdminMessage = vi.mocked(isAdminMessage);
const mockParseAdminCommand = vi.mocked(parseAdminCommand);
const mockHandleAdminCommand = vi.mocked(handleAdminCommand);
const mockHandleFallbackCommand = vi.mocked(handleFallbackCommand);
const mockSendApprovalRequest = vi.mocked(sendApprovalRequest);
const mockShouldRespond = vi.mocked(shouldRespond);
const mockExtractLocal = vi.mocked(extractLocal);

// ---------------------------------------------------------------------------
// Temp DB helpers
// ---------------------------------------------------------------------------

const tempDbPaths: string[] = [];

function makeTempDb(): Database {
  const path = join(tmpdir(), `ingest-test-${randomBytes(4).toString('hex')}.db`);
  tempDbPaths.push(path);
  const db = new Database(path);
  db.open();
  return db;
}

afterEach(() => {
  for (const p of [...tempDbPaths]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const fp = p + suffix;
      if (existsSync(fp)) {
        try { unlinkSync(fp); } catch { /* ignore */ }
      }
    }
  }
  tempDbPaths.length = 0;
});

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

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
    setDurability: vi.fn(),
  };
}

function makeIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(3).toString('hex')}`,
    chatJid: '15551230008@s.whatsapp.net',
    senderJid: '15551230008@s.whatsapp.net',
    senderName: 'Alice',
    content: 'hello bot',
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

const BOT_JID = '15551230004@s.whatsapp.net';
const BOT_LID = '81536414179557@lid';

/** Create an ingest handler with given db, messenger, and runtime. */
function makeIngest(
  db: Database,
  messenger: Messenger,
  runtime: Runtime,
  botJid = BOT_JID,
  botLid: string | null = BOT_LID,
  durability?: DurabilityEngine,
  instanceType?: string,
) {
  return createIngestHandler(db, messenger, runtime, () => botJid, () => botLid, durability, instanceType);
}

/** Run the ingest handler and wait for the async fire-and-forget to complete. */
async function runIngest(
  handler: (msg: IncomingMessage) => void,
  msg: IncomingMessage,
): Promise<void> {
  handler(msg);
  // Wait on real completion signal: active === 0 && queued === 0.
  // See tests/core/_helpers/ingest-drain.ts; replaces the legacy
  // setTimeout(0) flush, which did not guarantee the inner async IIFE
  // (admin routing, store, journal, runtime.handleMessage, sendMessage)
  // had settled before assertions ran.
  await drainIngest();
}

// ---------------------------------------------------------------------------
// Default mock setup for happy path
// ---------------------------------------------------------------------------

function setHappyPath(): void {
  mockIsAdminMessage.mockReturnValue(false);
  mockParseAdminCommand.mockReturnValue(null);
  mockShouldRespond.mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' });
  mockHandleAdminCommand.mockResolvedValue(undefined);
  mockHandleFallbackCommand.mockResolvedValue(undefined);
  mockSendApprovalRequest.mockResolvedValue(undefined);
  mockExtractLocal.mockImplementation((jid: string) => jid.split('@')[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  setHappyPath();
});

// ===========================================================================
// REQ-002.AC-01: Messages stored before dispatching
// ===========================================================================

describe('REQ-002.AC-01: message storage', () => {
  // @check CHK-008
  // @traces REQ-002.AC-01
  it('stores incoming message in DB before dispatching to runtime', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);
    const msg = makeIncomingMessage({ senderJid: '15550000003@s.whatsapp.net' });

    await runIngest(handler, msg);

    // Verify stored in DB
    const rows = getMessagesBySender(db, '15550000003@s.whatsapp.net');
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe(msg.messageId);
    expect(rows[0].content).toBe('hello bot');

    // Runtime was called
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  });

  it('strips the bot\'s own @mention from inbound group text before dispatch, keeping the stored copy raw (#1854)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);
    // BOT_JID = 15551230004@s.whatsapp.net → bare number 15551230004
    const msg = makeIncomingMessage({
      isGroup: true,
      content: '@15551230004 what is the weather',
      mentionedJids: [BOT_JID],
    });

    await runIngest(handler, msg);

    // The runtime (agent) sees the mention stripped…
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.handleMessage).mock.calls[0][0].content).toBe('what is the weather');

    // …but the stored copy retains the raw text (strip runs after persistence).
    const rows = getMessagesBySender(db, msg.senderJid);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('@15551230004 what is the weather');
  });

  it('leaves inbound group text without a self-mention structurally unchanged (#1854)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);
    const msg = makeIncomingMessage({
      isGroup: true,
      content: 'line one\nline two',
      mentionedJids: [BOT_JID],
    });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
    // No self-mention → newlines and content preserved verbatim.
    expect(vi.mocked(runtime.handleMessage).mock.calls[0][0].content).toBe('line one\nline two');
  });

  it('stores message even when access policy rejects it (REQ-002.AC-01)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);
    const msg = makeIncomingMessage({ senderJid: '15550000004@s.whatsapp.net' });

    // Blocked by access policy
    mockShouldRespond.mockReturnValue({ respond: false, reason: 'blocked', accessStatus: 'blocked' });

    await runIngest(handler, msg);

    // Message still stored
    const rows = getMessagesBySender(db, '15550000004@s.whatsapp.net');
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe(msg.messageId);

    // Runtime NOT called
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('returns early (no LLM dispatch) when storeMessage throws', async () => {
    // Use a db mock that throws on storeMessage
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();

    // Close the real DB to force a failure, then replace raw
    (db as any).db = null;
    // Override raw.prepare to throw
    (db as any)._raw = db.raw;
    Object.defineProperty(db, 'raw', {
      get: () => {
        throw new Error('DB closed');
      },
    });

    const handler = makeIngest(db, messenger, runtime);
    const msg = makeIncomingMessage();

    // Should not throw (fire-and-forget)
    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// REQ-002.AC-02: Admin commands consumed by ingest, not forwarded
// ===========================================================================

describe('REQ-002.AC-02: admin command routing', () => {
  // @check CHK-009
  // @traces REQ-002.AC-02
  it('ALLOW command consumed by ingest — not forwarded to runtime', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockIsAdminMessage.mockReturnValue(true);
    mockParseAdminCommand.mockReturnValue({ action: 'allow', subjectType: 'phone', subjectId: '15551234567' });

    const msg = makeIncomingMessage({ content: 'allow 15551234567' });
    await runIngest(handler, msg);

    // Admin command handler invoked
    expect(mockHandleAdminCommand).toHaveBeenCalledWith(
      db,
      messenger,
      'allow',
      'phone',
      '15551234567',
      msg.chatJid,
      expect.any(Function),
      undefined,
    );

    // Runtime NOT called — ingest consumed the command
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    // Trigger check NOT called — short-circuited before it
    expect(mockShouldRespond).not.toHaveBeenCalled();
  });

  it('BLOCK command consumed by ingest — not forwarded to runtime', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockIsAdminMessage.mockReturnValue(true);
    mockParseAdminCommand.mockReturnValue({ action: 'block', subjectType: 'phone', subjectId: '15559876543' });

    const msg = makeIncomingMessage({ content: 'block 15559876543' });
    await runIngest(handler, msg);

    expect(mockHandleAdminCommand).toHaveBeenCalledWith(
      db,
      messenger,
      'block',
      'phone',
      '15559876543',
      msg.chatJid,
      expect.any(Function),
      undefined,
    );
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('admin message with no valid command → proceeds to access policy check', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockIsAdminMessage.mockReturnValue(true);
    mockParseAdminCommand.mockReturnValue(null); // not a command

    const msg = makeIncomingMessage({ content: 'hey how are you' });
    await runIngest(handler, msg);

    expect(mockHandleAdminCommand).not.toHaveBeenCalled();
    expect(mockShouldRespond).toHaveBeenCalled();
  });

  it('non-admin message → parseAdminCommand never called', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockIsAdminMessage.mockReturnValue(false);

    await runIngest(handler, makeIncomingMessage());

    expect(mockParseAdminCommand).not.toHaveBeenCalled();
    expect(mockHandleAdminCommand).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// REQ-002.AC-03: Eligible messages dispatched to runtime
// ===========================================================================

describe('REQ-002.AC-03: dispatch to runtime', () => {
  // @check CHK-010
  // @traces REQ-002.AC-03
  it('allowed DM → dispatched to runtime.handleMessage', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockShouldRespond.mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' });

    const msg = makeIncomingMessage();
    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledWith(msg);
  });

  it('blocked sender → not dispatched to runtime', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockShouldRespond.mockReturnValue({ respond: false, reason: 'blocked', accessStatus: 'blocked' });

    await runIngest(handler, makeIncomingMessage());

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('own message (isFromMe) → shouldRespond returns false → not dispatched', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockShouldRespond.mockReturnValue({ respond: false, reason: 'own_message' });

    const msg = makeIncomingMessage({ isFromMe: true });
    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('unknown sender → sendApprovalRequest called, runtime not dispatched', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockShouldRespond.mockReturnValue({ respond: false, reason: 'unknown', accessStatus: 'unknown' });
    mockExtractLocal.mockReturnValue('15550000002');

    const msg = makeIncomingMessage({ senderJid: '15550000002@s.whatsapp.net', senderName: 'Bob', content: 'hi' });
    await runIngest(handler, msg);

    expect(mockSendApprovalRequest).toHaveBeenCalledWith(
      db,
      messenger,
      '15550000002',
      'Bob',
      'hi',
      undefined,
    );
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('pending sender → no approval request sent, runtime not dispatched', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockShouldRespond.mockReturnValue({ respond: false, reason: 'pending', accessStatus: 'pending' });

    await runIngest(handler, makeIncomingMessage());

    expect(mockSendApprovalRequest).not.toHaveBeenCalled();
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('sendApprovalRequest throws → error logged, no crash', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockShouldRespond.mockReturnValue({ respond: false, reason: 'unknown', accessStatus: 'unknown' });
    mockSendApprovalRequest.mockRejectedValue(new Error('network failure'));

    // Should not throw
    await expect(runIngest(handler, makeIncomingMessage())).resolves.toBeUndefined();
  });

  it('runtime.handleMessage throws → error caught, no crash', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    vi.mocked(runtime.handleMessage).mockRejectedValue(new Error('runtime error'));
    const handler = makeIngest(db, messenger, runtime);

    await expect(runIngest(handler, makeIncomingMessage())).resolves.toBeUndefined();
  });

  it('runtime.handleMessage throw still releases the ingest slot for the next message', async () => {
    const originalIngestDescriptor = Object.getOwnPropertyDescriptor(config, 'ingest');
    Object.defineProperty(config, 'ingest', {
      configurable: true,
      value: { ...config.ingest, maxConcurrent: 1 },
    });

    try {
      const db = makeTempDb();
      const messenger = makeMessenger();
      const runtime = makeRuntime();
      vi.mocked(runtime.handleMessage)
        .mockRejectedValueOnce(new Error('runtime error'))
        .mockResolvedValueOnce(undefined);
      const handler = makeIngest(db, messenger, runtime);

      await expect(runIngest(handler, makeIncomingMessage({ messageId: 'slot-err-1' }))).resolves.toBeUndefined();
      expect(getIngestStats().active).toBe(0);
      expect(getIngestStats().queued).toBe(0);

      await expect(runIngest(handler, makeIncomingMessage({ messageId: 'slot-err-2' }))).resolves.toBeUndefined();

      expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(2);
      expect(getIngestStats().active).toBe(0);
      expect(getIngestStats().queued).toBe(0);
    } finally {
      if (originalIngestDescriptor) {
        Object.defineProperty(config, 'ingest', originalIngestDescriptor);
      }
    }
  });

  it('unexpected acquireSlot-path throws are caught without corrupting slot counters', async () => {
    const originalIngestDescriptor = Object.getOwnPropertyDescriptor(config, 'ingest');
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    try {
      Object.defineProperty(config, 'ingest', {
        configurable: true,
        get: () => {
          throw new Error('config ingest unavailable');
        },
      });

      await expect(runIngest(handler, makeIncomingMessage({ messageId: 'slot-acquire-fail' }))).resolves.toBeUndefined();
      expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
      expect(getIngestStats().active).toBe(0);
      expect(getIngestStats().queued).toBe(0);
    } finally {
      if (originalIngestDescriptor) {
        Object.defineProperty(config, 'ingest', originalIngestDescriptor);
      }
    }

    await expect(runIngest(handler, makeIncomingMessage({ messageId: 'slot-acquire-ok' }))).resolves.toBeUndefined();
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(1);
    expect(getIngestStats().active).toBe(0);
    expect(getIngestStats().queued).toBe(0);
  });
});

// ===========================================================================
// W3-06: Duplicate delivery dedup
// ===========================================================================

describe('W3-06: duplicate delivery dedup', () => {
  it('second delivery of same messageId is skipped — runtime not called again', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);
    const msg = makeIncomingMessage({ senderJid: '15550000005@s.whatsapp.net' });

    // First delivery — should store and dispatch
    await runIngest(handler, msg);
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    setHappyPath();

    // Second delivery of the exact same message — should be silently dropped
    await runIngest(handler, msg);
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();

    // Only one row in DB
    const rows = getMessagesBySender(db, '15550000005@s.whatsapp.net');
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe(msg.messageId);
  });

  it('different messageId is not treated as duplicate', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const msg1 = makeIncomingMessage({ senderJid: '15550000006@s.whatsapp.net' });
    const msg2 = makeIncomingMessage({ senderJid: '15550000006@s.whatsapp.net' });

    await runIngest(handler, msg1);
    await runIngest(handler, msg2);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(2);

    const rows = getMessagesBySender(db, '15550000006@s.whatsapp.net');
    expect(rows).toHaveLength(2);
  });
});

// ===========================================================================
// shouldRespond receives correct bot identity
// ===========================================================================

describe('Bot identity passed to shouldRespond', () => {
  it('shouldRespond called with botJid and botLid', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID);

    const msg = makeIncomingMessage();
    await runIngest(handler, msg);

    expect(mockShouldRespond).toHaveBeenCalledWith(msg, BOT_JID, BOT_LID, db);
  });

  it('botLid null is passed through', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime, BOT_JID, null);

    const msg = makeIncomingMessage();
    await runIngest(handler, msg);

    expect(mockShouldRespond).toHaveBeenCalledWith(msg, BOT_JID, null, db);
  });
});

// ===========================================================================
// Echo correlation (Task 4)
// ===========================================================================

describe('Echo correlation: isFromMe messages', () => {
  it('isFromMe message calls durabilityEngine.matchEcho with messageId', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    const matchEchoSpy = vi.spyOn(durability, 'matchEcho').mockReturnValue(false);

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    const msg = makeIncomingMessage({ isFromMe: true });

    await runIngest(handler, msg);

    expect(matchEchoSpy).toHaveBeenCalledOnce();
    expect(matchEchoSpy).toHaveBeenCalledWith(msg.messageId);
  });

  it('isFromMe message does NOT dispatch to runtime', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    vi.spyOn(durability, 'matchEcho').mockReturnValue(false);

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    const msg = makeIncomingMessage({ isFromMe: true });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(mockShouldRespond).not.toHaveBeenCalled();
  });

  it('isFromMe message without durability engine — does NOT dispatch to runtime', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();

    // No durability passed — graceful degradation
    const handler = makeIngest(db, messenger, runtime);
    const msg = makeIncomingMessage({ isFromMe: true });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('matchEcho returns true when a submitted outbound_op matches', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);

    // Seed a submitted outbound_op with a known wa_message_id
    const opId = durability.createOutboundOp({
      conversationKey: '15551230008',
      chatJid: '15551230008@s.whatsapp.net',
      opType: 'send_message',
      payload: 'hello',
      replayPolicy: 'safe',
    });
    durability.markSending(opId);
    durability.markSubmitted(opId, 'WA-ECHO-001');

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    const msg = makeIncomingMessage({ isFromMe: true, messageId: 'WA-ECHO-001' });

    await runIngest(handler, msg);

    // Verify the outbound_op transitioned to 'echoed'
    const rows = db.raw.prepare(
      `SELECT status FROM outbound_ops WHERE id = ?`,
    ).get(opId) as { status: string } | undefined;
    expect(rows?.status).toBe('echoed');
  });
});

// ===========================================================================
// Inbound journaling (Task 4)
// ===========================================================================

describe('Inbound journaling: durabilityEngine.journalInbound', () => {
  it('eligible message journals inbound event before dispatch', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(42);
    vi.spyOn(durability, 'getInboundReceivedAtUnixSeconds').mockReturnValue(1_780_000_000);

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    const msg = makeIncomingMessage();

    await runIngest(handler, msg);

    expect(journalSpy).toHaveBeenCalledOnce();
    expect(journalSpy).toHaveBeenCalledWith(
      msg.messageId,
      expect.any(String),   // conversationKey
      msg.chatJid,
      expect.any(String),   // routedTo runtime name
      expect.any(Number),   // receipt captured before admission backpressure
    );
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledWith(msg);
    expect(msg.receivedAtUnixSeconds).toBe(1_780_000_000);
  });

  it('dispatches exact user text when the durable receipt lookup is invalid', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    vi.spyOn(durability, 'journalInbound').mockReturnValue(43);
    vi.spyOn(durability, 'getInboundReceivedAtUnixSeconds')
      .mockImplementation(() => { throw new Error('invalid durable receipt'); });

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    const msg = makeIncomingMessage({ content: 'preserve this exact request' });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'preserve this exact request',
        inboundSeq: 43,
        receivedAtUnixSeconds: undefined,
      }),
    );
  });

  it('journalInbound is called before runtime.handleMessage', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);

    const callOrder: string[] = [];
    vi.spyOn(durability, 'journalInbound').mockImplementation(() => {
      callOrder.push('journalInbound');
      return 1;
    });
    vi.spyOn(durability, 'getInboundReceivedAtUnixSeconds').mockReturnValue(1_780_000_000);
    vi.mocked(runtime.handleMessage).mockImplementation(async () => {
      callOrder.push('handleMessage');
    });

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    await runIngest(handler, makeIncomingMessage());

    expect(callOrder).toEqual(['journalInbound', 'handleMessage']);
  });

  it('access-denied message: journalInbound + markInboundSkipped(access_denied)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);

    mockShouldRespond.mockReturnValue({ respond: false, reason: 'blocked', accessStatus: 'blocked' });

    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(7);
    const skipSpy = vi.spyOn(durability, 'markInboundSkipped');

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    await runIngest(handler, makeIncomingMessage());

    expect(journalSpy).toHaveBeenCalledOnce();
    expect(skipSpy).toHaveBeenCalledWith(7, 'access_denied');
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('admin command: journalInbound + markInboundSkipped(admin_command)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);

    mockIsAdminMessage.mockReturnValue(true);
    mockParseAdminCommand.mockReturnValue({ action: 'allow', subjectType: 'phone', subjectId: '15551234567' });

    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(9);
    const skipSpy = vi.spyOn(durability, 'markInboundSkipped');

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    const msg = makeIncomingMessage({ content: 'allow 15551234567' });
    await runIngest(handler, msg);

    expect(journalSpy).toHaveBeenCalledOnce();
    expect(skipSpy).toHaveBeenCalledWith(9, 'admin_command');
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('runtime error marks inbound failed with classified failure_class (plain Error → unknown)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);

    vi.mocked(runtime.handleMessage).mockRejectedValue(new Error('runtime crash'));

    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(11);
    vi.spyOn(durability, 'getInboundReceivedAtUnixSeconds').mockReturnValue(1_780_000_000);
    const failSpy = vi.spyOn(durability, 'markInboundFailed');

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    await runIngest(handler, makeIncomingMessage());

    expect(journalSpy).toHaveBeenCalledOnce();
    // A generic runtime error is unattributable → 'unknown'.
    expect(failSpy).toHaveBeenCalledWith(11, 'unknown');
  });

  it('runtime SQLITE_FULL error is classified db_error on the failed inbound', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);

    vi.mocked(runtime.handleMessage).mockRejectedValue(
      Object.assign(new Error('SQLITE_FULL: database or disk is full'), { code: 'SQLITE_FULL' }),
    );

    vi.spyOn(durability, 'journalInbound').mockReturnValue(12);
    vi.spyOn(durability, 'getInboundReceivedAtUnixSeconds').mockReturnValue(1_780_000_000);
    const failSpy = vi.spyOn(durability, 'markInboundFailed');

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    await runIngest(handler, makeIncomingMessage());

    expect(failSpy).toHaveBeenCalledWith(12, 'db_error');
  });

  it('no durability engine — existing behaviour unchanged', async () => {
    // Regression: existing callers that pass no durability engine continue to work.
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();

    const handler = makeIngest(db, messenger, runtime); // no durability
    const msg = makeIncomingMessage();

    await expect(runIngest(handler, msg)).resolves.toBeUndefined();
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// REQ-010: Passive instance short-circuit
// ===========================================================================

describe('REQ-010: passive instance short-circuit', () => {
  it('passive: message is stored in DB', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, undefined, 'passive');
    const msg = makeIncomingMessage({ senderJid: '15550000007@s.whatsapp.net' });

    await runIngest(handler, msg);

    const rows = getMessagesBySender(db, '15550000007@s.whatsapp.net');
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe(msg.messageId);
  });

  it('passive: runtime.handleMessage is NEVER called', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, undefined, 'passive');

    await runIngest(handler, makeIncomingMessage());

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('passive + durability: journalInbound and markInboundSkipped called with correct args', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);

    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(55);
    const skipSpy = vi.spyOn(durability, 'markInboundSkipped');

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability, 'passive');
    const msg = makeIncomingMessage();

    await runIngest(handler, msg);

    expect(journalSpy).toHaveBeenCalledOnce();
    expect(journalSpy).toHaveBeenCalledWith(
      msg.messageId,
      expect.any(String),   // conversationKey
      msg.chatJid,
      'passive',
    );
    expect(skipSpy).toHaveBeenCalledWith(55, 'passive_instance');
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('passive: inbound event has processing_status complete with terminal_reason passive_instance', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability, 'passive');
    const msg = makeIncomingMessage();

    await runIngest(handler, msg);

    // Verify the inbound_event row has the correct status and terminal_reason
    const row = db.raw.prepare(
      `SELECT processing_status, terminal_reason FROM inbound_events WHERE message_id = ?`,
    ).get(msg.messageId) as { processing_status: string; terminal_reason: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.processing_status).toBe('complete');
    expect(row?.terminal_reason).toBe('passive_instance');
  });

  it('passive without durability: no crash, runtime still not called', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, undefined, 'passive');

    await expect(runIngest(handler, makeIncomingMessage())).resolves.toBeUndefined();
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('non-passive instance: runtime is still dispatched (regression)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, undefined, 'active');

    await runIngest(handler, makeIncomingMessage());

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// REQ-002.AC-02b: fallback admin command routing
// ===========================================================================

describe('REQ-002.AC-02b: fallback admin command routing', () => {
  it('FALLBACK STATUS consumed as admin command, never reaches runtime.handleMessage', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockIsAdminMessage.mockReturnValue(true);
    mockParseAdminCommand.mockReturnValue({ action: 'fallback', sub: 'status' });

    const msg = makeIncomingMessage({ content: 'fallback status' });
    await runIngest(handler, msg);

    // handleFallbackCommand invoked with runtime + messenger
    expect(mockHandleFallbackCommand).toHaveBeenCalledWith(
      runtime,
      messenger,
      { action: 'fallback', sub: 'status' },
      msg.chatJid,
      undefined,
    );

    // handleAdminCommand NOT called (different code path)
    expect(mockHandleAdminCommand).not.toHaveBeenCalled();

    // Runtime NOT dispatched
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(mockShouldRespond).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Uncovered-branch coverage for src/core/ingest.ts
// Targets: acquireSlot slow path (queue/drop), releaseSlot branches,
// admin-command error tail + dispatch callback, slot transfer on release.
// ===========================================================================

import { deferred } from '../helpers/deferred.ts';
import { resolvePhoneFromJid } from '../../src/core/access-list.ts';
const mockResolvePhoneFromJid = vi.mocked(resolvePhoneFromJid);

describe('ingest.ts uncovered-branch coverage', () => {
  /**
   * Override config.ingest for the duration of fn(), restoring the original
   * property descriptor on exit. Mirrors the pattern used in the backpressure
   * test suite and the existing maxConcurrent-override test above.
   */
  async function withIngestConfig(
    overrides: { maxConcurrent?: number; maxQueueDepth?: number },
    fn: () => Promise<void>,
  ): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(config, 'ingest');
    Object.defineProperty(config, 'ingest', {
      configurable: true,
      value: { ...(config.ingest ?? {}), ...overrides },
    });
    try {
      await fn();
    } finally {
      if (original) {
        Object.defineProperty(config, 'ingest', original);
      }
    }
  }

  /** Wait for getIngestStats() to satisfy the predicate (vi.waitFor wrapper). */
  async function waitForStats(
    pred: (stats: ReturnType<typeof getIngestStats>) => void,
  ): Promise<void> {
    await vi.waitFor(() => pred(getIngestStats()), { timeout: 5_000, interval: 5 });
  }

  // -------------------------------------------------------------------------
  // acquireSlot: slow path — overflow queue (wait-then-acquire branch)
  // -------------------------------------------------------------------------

  it('acquireSlot: beyond maxConcurrent, message is queued then dispatched after a slot frees', async () => {
    await withIngestConfig({ maxConcurrent: 1, maxQueueDepth: 5 }, async () => {
      const hold = deferred<void>();
      const dispatchOrder: string[] = [];

      const db = makeTempDb();
      const messenger = makeMessenger();
      const runtime = makeRuntime();
      vi.mocked(runtime.handleMessage).mockImplementation(async (msg: IncomingMessage) => {
        dispatchOrder.push(msg.messageId);
        if (msg.messageId === 'first') return hold.promise;
      });
      const handler = makeIngest(db, messenger, runtime);

      // Fill the single slot.
      handler(makeIncomingMessage({ messageId: 'first' }));
      await waitForStats((s) => { expect(s.active).toBe(1); });

      // Second message must go through the queue (slow path).
      handler(makeIncomingMessage({ messageId: 'second' }));
      await waitForStats((s) => { expect(s.queued).toBe(1); });
      expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(1);

      // Release the slot — queued message drains (releaseSlot next-branch).
      hold.resolve();
      await vi.waitFor(() => {
        expect(dispatchOrder).toEqual(['first', 'second']);
      });
      await waitForStats((s) => {
        expect(s.active).toBe(0);
        expect(s.queued).toBe(0);
      });
    });
  });

  it('captures the durable receipt before a message waits for an ingest slot', async () => {
    await withIngestConfig({ maxConcurrent: 1, maxQueueDepth: 5 }, async () => {
      const hold = deferred<void>();
      const receivedAt = 1_780_000_000;
      let now = receivedAt;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now * 1000);
      try {
        const db = makeTempDb();
        const messenger = makeMessenger();
        const runtime = makeRuntime();
        const durability = new DurabilityEngine(db);
        vi.mocked(runtime.handleMessage).mockImplementation(async (msg: IncomingMessage) => {
          if (msg.messageId === 'receipt-slot-holder') return hold.promise;
        });
        const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);

        handler(makeIncomingMessage({ messageId: 'receipt-slot-holder' }));
        await waitForStats((s) => { expect(s.active).toBe(1); });

        handler(makeIncomingMessage({
          messageId: 'receipt-slot-waiter',
          content: 'queued exact text',
        }));
        await waitForStats((s) => { expect(s.queued).toBe(1); });

        now += 95;
        hold.resolve();
        await vi.waitFor(() => {
          expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(2);
        });
        const queued = vi.mocked(runtime.handleMessage).mock.calls[1]?.[0];
        expect(queued).toMatchObject({
          messageId: 'receipt-slot-waiter',
          content: 'queued exact text',
          receivedAtUnixSeconds: receivedAt,
        });
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // acquireSlot: slow path — queue full → drop oldest group message
  // (exercises findIndex/splice/dropped.resolve + ingestDropped++ path)
  // -------------------------------------------------------------------------

  it('acquireSlot: when queue is full, oldest group message is dropped (DMs preserved)', async () => {
    await withIngestConfig({ maxConcurrent: 1, maxQueueDepth: 2 }, async () => {
      const hold = deferred<void>();
      const dispatched: string[] = [];

      const db = makeTempDb();
      const messenger = makeMessenger();
      const runtime = makeRuntime();
      vi.mocked(runtime.handleMessage).mockImplementation(async (msg: IncomingMessage) => {
        dispatched.push(msg.messageId);
        if (msg.messageId === 'anchor') return hold.promise;
      });
      const handler = makeIngest(db, messenger, runtime);

      // anchor takes the only slot.
      handler(makeIncomingMessage({ messageId: 'anchor' }));
      await waitForStats((s) => { expect(s.active).toBe(1); });

      // Queue: [dm-1, group-1] (depth = 2 = max).
      handler(makeIncomingMessage({ messageId: 'dm-1', isGroup: false }));
      handler(makeIncomingMessage({ messageId: 'group-1', isGroup: true }));
      await waitForStats((s) => { expect(s.queued).toBe(2); });

      const droppedBefore = getIngestStats().dropped;

      // Next message overflows the queue — group-1 (group) is the preferred drop.
      handler(makeIncomingMessage({ messageId: 'dm-2', isGroup: false }));
      await waitForStats((s) => {
        expect(s.dropped).toBe(droppedBefore + 1);
        expect(s.queued).toBe(2); // dm-2 replaced group-1
      });

      // Drain: anchor + dm-1 + dm-2 run; group-1 was dropped.
      hold.resolve();
      await vi.waitFor(() => {
        expect(dispatched).toContain('dm-2');
      });

      expect(dispatched).toStrictEqual(['anchor', 'dm-1', 'dm-2']);
      expect(dispatched).not.toContain('group-1');
      expect(getIngestStats().dropped).toBe(droppedBefore + 1);
    });
  });

  // -------------------------------------------------------------------------
  // acquireSlot: slow path — queue full, no group messages → drop oldest (idx 0)
  // (exercises the groupIdx === -1 ? 0 fallback)
  // -------------------------------------------------------------------------

  it('acquireSlot: queue full with only DMs drops the oldest queued DM', async () => {
    await withIngestConfig({ maxConcurrent: 1, maxQueueDepth: 1 }, async () => {
      const hold = deferred<void>();
      const dispatched: string[] = [];

      const db = makeTempDb();
      const messenger = makeMessenger();
      const runtime = makeRuntime();
      vi.mocked(runtime.handleMessage).mockImplementation(async (msg: IncomingMessage) => {
        dispatched.push(msg.messageId);
        if (msg.messageId === 'slot') return hold.promise;
      });
      const handler = makeIngest(db, messenger, runtime);

      handler(makeIncomingMessage({ messageId: 'slot' }));
      await waitForStats((s) => { expect(s.active).toBe(1); });

      handler(makeIncomingMessage({ messageId: 'queued-b' }));
      await waitForStats((s) => { expect(s.queued).toBe(1); });

      const droppedBefore = getIngestStats().dropped;

      // Overflow: no group messages in queue → dropIdx falls back to 0 (queued-b).
      handler(makeIncomingMessage({ messageId: 'queued-c' }));
      await waitForStats((s) => {
        expect(s.dropped).toBe(droppedBefore + 1);
        expect(s.queued).toBe(1); // queued-c replaced queued-b
      });

      hold.resolve();
      await vi.waitFor(() => {
        expect(dispatched).toContain('queued-c');
      });

      expect(dispatched).toStrictEqual(['slot', 'queued-c']);
      expect(dispatched).not.toContain('queued-b');
    });
  });

  // -------------------------------------------------------------------------
  // releaseSlot: else branch — _activeSlots-- when queue is empty
  // (covered implicitly by every idle test, asserted explicitly here)
  // -------------------------------------------------------------------------

  it('releaseSlot: decrements active slot when no queued items are waiting', async () => {
    await withIngestConfig({ maxConcurrent: 3, maxQueueDepth: 5 }, async () => {
      const db = makeTempDb();
      const messenger = makeMessenger();
      const runtime = makeRuntime();
      const handler = makeIngest(db, messenger, runtime);

      await runIngest(handler, makeIncomingMessage({ messageId: 'solo' }));

      // After release with empty queue: _activeSlots back to 0, stats clean.
      const stats = getIngestStats();
      expect(stats.active).toBe(0);
      expect(stats.queued).toBe(0);

      // A second message must still acquire a slot (proves _activeSlots was
      // decremented rather than leaking and forcing the slow path).
      const droppedBefore = getIngestStats().dropped;
      await runIngest(handler, makeIncomingMessage({ messageId: 'solo-2' }));
      expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(2);

      // active/queued clean; dropped unchanged by this non-dropping test.
      const finalStats = getIngestStats();
      expect(finalStats.active).toBe(0);
      expect(finalStats.queued).toBe(0);
      expect(finalStats.dropped).toBe(droppedBefore);
    });
  });

  // -------------------------------------------------------------------------
  // getIngestStats: observable transitions while slot is held then released
  // -------------------------------------------------------------------------

  it('getIngestStats: active increments on acquire and returns to 0 on release', async () => {
    await withIngestConfig({ maxConcurrent: 2, maxQueueDepth: 5 }, async () => {
      const hold = deferred<void>();
      const db = makeTempDb();
      const messenger = makeMessenger();
      const runtime = makeRuntime();
      vi.mocked(runtime.handleMessage).mockImplementation(async (msg: IncomingMessage) => {
        if (msg.messageId === 'held') return hold.promise;
      });
      const handler = makeIngest(db, messenger, runtime);

      const droppedBefore = getIngestStats().dropped;
      handler(makeIncomingMessage({ messageId: 'held' }));
      await waitForStats((s) => { expect(s.active).toBe(1); });

      const during = getIngestStats();
      expect(during.active).toBe(1);
      expect(during.queued).toBe(0);

      hold.resolve();
      await waitForStats((s) => { expect(s.active).toBe(0); });

      // active/queued back to 0; dropped is a cumulative module counter so we
      // only assert it did not change during this no-drop test.
      const after = getIngestStats();
      expect(after.active).toBe(0);
      expect(after.queued).toBe(0);
      expect(after.dropped).toBe(droppedBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Admin command tail (lines 289-294): handleAdminCommand rejects → error caught
  // -------------------------------------------------------------------------

  it('admin command: handleAdminCommand rejection is caught and logged (no crash)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockIsAdminMessage.mockReturnValue(true);
    mockParseAdminCommand.mockReturnValue({
      action: 'allow', subjectType: 'phone', subjectId: '15551234567',
    });
    mockHandleAdminCommand.mockRejectedValue(new Error('admin handler blew up'));

    const msg = makeIncomingMessage({ content: 'allow 15551234567' });

    const droppedBefore = getIngestStats().dropped;

    // Must not throw — the try/catch around handleAdminCommand swallows it.
    await expect(runIngest(handler, msg)).resolves.toBeUndefined();

    // handleAdminCommand was invoked and the runtime was never dispatched directly.
    expect(mockHandleAdminCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    const stats = getIngestStats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
    expect(stats.dropped).toBe(droppedBefore);
  });

  // -------------------------------------------------------------------------
  // Admin command tail (line 289): the dispatch callback `(m) => runtime.handleMessage(m)`
  // is invoked by handleAdminCommand — exercises the arrow body.
  // -------------------------------------------------------------------------

  it('admin command: handleAdminCommand receives a dispatch callback that routes to runtime', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    // Capture the dispatch callback handleAdminCommand receives, then invoke it
    // with a synthetic message to exercise the `(m) => runtime.handleMessage(m)` body.
    let captured: ((m: IncomingMessage) => Promise<void>) | undefined;
    mockHandleAdminCommand.mockImplementation(
      async (_db, _ms, _action, _st, _sid, _chat, dispatch: (m: IncomingMessage) => Promise<void>) => {
        captured = dispatch;
      },
    );
    mockIsAdminMessage.mockReturnValue(true);
    mockParseAdminCommand.mockReturnValue({
      action: 'allow', subjectType: 'phone', subjectId: '15551234567',
    });

    await runIngest(handler, makeIncomingMessage({ content: 'allow 15551234567' }));

    expect(captured).toBeDefined();
    const probe = makeIncomingMessage({ messageId: 'probe-via-callback' });
    await captured!(probe);
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledWith(probe);
  });

  // -------------------------------------------------------------------------
  // Admin command: handleFallbackCommand rejection → caught (sister branch of 293)
  // -------------------------------------------------------------------------

  it('admin command: handleFallbackCommand rejection is caught (no crash)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockIsAdminMessage.mockReturnValue(true);
    mockParseAdminCommand.mockReturnValue({ action: 'fallback', sub: 'status' });
    mockHandleFallbackCommand.mockRejectedValue(new Error('fallback handler blew up'));

    const droppedBefore = getIngestStats().dropped;
    await expect(
      runIngest(handler, makeIncomingMessage({ content: 'fallback status' })),
    ).resolves.toBeUndefined();

    expect(mockHandleFallbackCommand).toHaveBeenCalledOnce();
    expect(mockHandleAdminCommand).not.toHaveBeenCalled();
    const stats = getIngestStats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
    expect(stats.dropped).toBe(droppedBefore);
  });

  // -------------------------------------------------------------------------
  // acquireSlot fast path: maxConcurrent default (no config override) covers
  // the `?? 20` fallback branch in the absence of config.ingest.
  // -------------------------------------------------------------------------

  it('acquireSlot: uses default maxConcurrent=20 when config.ingest is absent', async () => {
    // Temporarily make config.ingest undefined to exercise the `?? 20` fallback.
    const original = Object.getOwnPropertyDescriptor(config, 'ingest');
    Object.defineProperty(config, 'ingest', { configurable: true, value: undefined });

    try {
      const db = makeTempDb();
      const messenger = makeMessenger();
      const runtime = makeRuntime();
      const handler = makeIngest(db, messenger, runtime);

      // A single message well under the 20-slot default should take the fast path.
      const droppedBefore = getIngestStats().dropped;
      await runIngest(handler, makeIncomingMessage({ messageId: 'fast-default' }));

      expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
      const stats = getIngestStats();
      expect(stats.active).toBe(0);
      expect(stats.queued).toBe(0);
      expect(stats.dropped).toBe(droppedBefore);
    } finally {
      if (original) {
        Object.defineProperty(config, 'ingest', original);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Paused-chat short-circuit is gated by getAdminCommand() — verify a paused
  // chat that also carries an admin command bypasses the pause and is routed.
  // (Exercises the `&& !getAdminCommand()` false branch.)
  // -------------------------------------------------------------------------

  it('paused chat: admin command bypasses the pause short-circuit and is routed', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const originalPaused = Object.getOwnPropertyDescriptor(config, 'pausedChats');
    Object.defineProperty(config, 'pausedChats', {
      configurable: true,
      value: new Set<string>(['15551230008@s.whatsapp.net']),
    });

    try {
      mockIsAdminMessage.mockReturnValue(true);
      mockParseAdminCommand.mockReturnValue({
        action: 'allow', subjectType: 'phone', subjectId: '15551234567',
      });

      await runIngest(handler, makeIncomingMessage({ content: 'allow 15551234567' }));

      // Admin handler ran — pause did NOT short-circuit.
      expect(mockHandleAdminCommand).toHaveBeenCalledOnce();
      expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    } finally {
      if (originalPaused) {
        Object.defineProperty(config, 'pausedChats', originalPaused);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Paused-chat short-circuit: exercises lines 253-259 (both with and without
  // durability, and both the conversationKey and chatJid lookup arms).
  // -------------------------------------------------------------------------

  it('paused chat (by conversationKey): message stored, dispatch skipped, journal marks chat_paused', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(77);
    const skipSpy = vi.spyOn(durability, 'markInboundSkipped');

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);

    const originalPaused = Object.getOwnPropertyDescriptor(config, 'pausedChats');
    // conversationKey for '15551230008@s.whatsapp.net' is the phone '15551230008'.
    Object.defineProperty(config, 'pausedChats', {
      configurable: true,
      value: new Set<string>(['15551230008']),
    });

    try {
      const msg = makeIncomingMessage({ content: 'hello while paused' });
      await runIngest(handler, msg);

      expect(journalSpy).toHaveBeenCalledWith(msg.messageId, '15551230008', msg.chatJid, 'none');
      expect(skipSpy).toHaveBeenCalledWith(77, 'chat_paused');
      expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    } finally {
      if (originalPaused) {
        Object.defineProperty(config, 'pausedChats', originalPaused);
      }
    }
  });

  it('paused chat (by chatJid): dispatch skipped even without durability', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime); // no durability

    const originalPaused = Object.getOwnPropertyDescriptor(config, 'pausedChats');
    Object.defineProperty(config, 'pausedChats', {
      configurable: true,
      value: new Set<string>(['15551230008@s.whatsapp.net']),
    });

    try {
      const msg = makeIncomingMessage({ content: 'paused via chatJid' });
      await expect(runIngest(handler, msg)).resolves.toBeUndefined();

      // Message WAS stored (storage happens before pause check) but not dispatched.
      expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
      const rows = db.raw.prepare(
        `SELECT content FROM messages WHERE message_id = ?`,
      ).get(msg.messageId) as { content: string } | undefined;
      expect(rows?.content).toBe('paused via chatJid');
    } finally {
      if (originalPaused) {
        Object.defineProperty(config, 'pausedChats', originalPaused);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Unknown-sender approval path: resolvePhoneFromJid is consulted for the
  // approval phone number (line 312) — assert its call args concretely.
  // -------------------------------------------------------------------------

  it('unknown sender: approval request uses resolvePhoneFromJid on senderJid', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    mockShouldRespond.mockReturnValue({ respond: false, reason: 'unknown', accessStatus: 'unknown' });
    mockResolvePhoneFromJid.mockReturnValue('15550000008');

    const msg = makeIncomingMessage({
      senderJid: '15550000008@s.whatsapp.net',
      senderName: 'Carol',
      content: 'ping',
    });
    await runIngest(handler, msg);

    expect(mockResolvePhoneFromJid).toHaveBeenCalledWith(msg.senderJid, db);
    expect(mockSendApprovalRequest).toHaveBeenCalledWith(
      db, messenger, '15550000008', 'Carol', 'ping', undefined,
    );
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Control-plane intercept (lines 149-187): a control-peer message is stored
  // in control_messages (NOT messages), journal marks control_message, never
  // dispatched to runtime.
  // -------------------------------------------------------------------------


  it('control message with protocol prefix from a NON-peer is treated as a normal message', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    // controlPeers does NOT include this sender's phone → not a control message.
    const originalPeers = Object.getOwnPropertyDescriptor(config, 'controlPeers');
    Object.defineProperty(config, 'controlPeers', {
      configurable: true,
      value: new Map<string, string>([['q', '9999999999']]),
    });

    try {
      const msg = makeIncomingMessage({
        senderJid: '15550000001@s.whatsapp.net',
        chatJid: '15550000001@s.whatsapp.net',
        content: '[LOOPS_HEAL] should-be-ignored-as-control',
      });
      await runIngest(handler, msg);

      // Falls through to normal storage + dispatch.
      expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();

      // control_messages table is empty (intercept never ran).
      const ctrl = db.raw.prepare(
        `SELECT COUNT(*) AS n FROM control_messages WHERE message_id = ?`,
      ).get(msg.messageId) as { n: number };
      expect(ctrl.n).toBe(0);
    } finally {
      if (originalPeers) {
        Object.defineProperty(config, 'controlPeers', originalPeers);
      }
    }
  });



  // -------------------------------------------------------------------------
  // LID-DM conversation-key resolution (line 198): non-group DM whose chatJid
  // is a LID resolves conversationKey via resolvePhoneFromJid.
  // -------------------------------------------------------------------------

  it('LID DM: conversationKey resolved via resolvePhoneFromJid, not toConversationKey', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(33);
    vi.spyOn(durability, 'getInboundReceivedAtUnixSeconds').mockReturnValue(1_780_000_000);

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);

    // chatJid is a LID; resolvePhoneFromJid is mocked to return the local part.
    mockResolvePhoneFromJid.mockReturnValue('15550000009');
    const lidJid = '15550000009@lid';

    const msg = makeIncomingMessage({
      chatJid: lidJid,
      senderJid: '15550000009@s.whatsapp.net',
      isGroup: false,
      content: 'lid dm',
    });
    await runIngest(handler, msg);

    // journalInbound received the phone-derived conversationKey '15550000009',
    // proving the LID branch (line 198) ran instead of toConversationKey.
    expect(journalSpy).toHaveBeenCalledWith(
      msg.messageId,
      '15550000009',
      lidJid,
      expect.any(String),
      expect.any(Number),
    );
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  });

  // QR-056 (WhatsApp senderName) + QR-074 (Twilio content): lone surrogates in
  // inbound text reach the spawned-CLI provider sink unsanitized → server-side
  // JSON parsers reject them → turn-level DoS. Sanitize uniformly at the shared
  // ingest chokepoint so the in-memory msg dispatched to the runtime is clean
  // regardless of ingress. (node:sqlite already sanitizes the STORED copy, so
  // the dispatched in-memory object is the load-bearing assertion.)
  it('QR-056/QR-074: strips lone surrogates from content + senderName before dispatch', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);
    const msg = makeIncomingMessage({
      senderJid: '15550000098@s.whatsapp.net',
      content: 'hi\uD800there',      // lone HIGH surrogate (e.g. crafted UCS-2 SMS body)
      senderName: 'Al\uDC00ice',     // lone LOW surrogate (e.g. crafted WhatsApp pushName)
      contentText: 'ctx\uD834text',  // lone high surrogate in contentText
    });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
    const dispatched = vi.mocked(runtime.handleMessage).mock.calls[0]![0] as IncomingMessage;
    // No lone-surrogate code unit survives (input has no valid pairs).
    expect(dispatched.content).not.toMatch(/[\uD800-\uDFFF]/);
    expect(dispatched.senderName).not.toMatch(/[\uD800-\uDFFF]/);
    expect(dispatched.contentText).not.toMatch(/[\uD800-\uDFFF]/);
    // Surrounding text preserved.
    expect(dispatched.content).toContain('there');
    expect(dispatched.senderName).toContain('ice');
  });
});
