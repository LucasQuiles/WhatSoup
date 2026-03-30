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

vi.mock('../../src/core/command-router.ts', () => ({
  isAdminMessage: vi.fn(),
  parseAdminCommand: vi.fn(),
}));

vi.mock('../../src/core/admin.ts', () => ({
  handleAdminCommand: vi.fn(),
  sendApprovalRequest: vi.fn(),
}));

vi.mock('../../src/core/access-policy.ts', () => ({
  shouldRespond: vi.fn(),
}));

vi.mock('../../src/core/access-list.ts', () => ({
  extractPhone: vi.fn((jid: string) => jid.split('@')[0]),
  lookupAccess: vi.fn(),
  insertPending: vi.fn(),
  updateAccess: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import { createIngestHandler } from '../../src/core/ingest.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { isAdminMessage, parseAdminCommand } from '../../src/core/command-router.ts';
import { handleAdminCommand, sendApprovalRequest } from '../../src/core/admin.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';
import { extractPhone } from '../../src/core/access-list.ts';
import { getMessagesBySender } from '../../src/core/messages.ts';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockIsAdminMessage = vi.mocked(isAdminMessage);
const mockParseAdminCommand = vi.mocked(parseAdminCommand);
const mockHandleAdminCommand = vi.mocked(handleAdminCommand);
const mockSendApprovalRequest = vi.mocked(sendApprovalRequest);
const mockShouldRespond = vi.mocked(shouldRespond);
const mockExtractPhone = vi.mocked(extractPhone);

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
  };
}

function makeIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(3).toString('hex')}`,
    chatJid: '15184194479@s.whatsapp.net',
    senderJid: '15184194479@s.whatsapp.net',
    senderName: 'Alice',
    content: 'hello bot',
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

const BOT_JID = '18455943112@s.whatsapp.net';
const BOT_LID = '81536414179557@lid';

/** Create an ingest handler with given db, messenger, and runtime. */
function makeIngest(
  db: Database,
  messenger: Messenger,
  runtime: Runtime,
  botJid = BOT_JID,
  botLid: string | null = BOT_LID,
  durability?: DurabilityEngine,
) {
  return createIngestHandler(db, messenger, runtime, () => botJid, () => botLid, durability);
}

/** Run the ingest handler and wait for the async fire-and-forget to complete. */
async function runIngest(
  handler: (msg: IncomingMessage) => void,
  msg: IncomingMessage,
): Promise<void> {
  handler(msg);
  // Flush the microtask/promise queue
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Default mock setup for happy path
// ---------------------------------------------------------------------------

function setHappyPath(): void {
  mockIsAdminMessage.mockReturnValue(false);
  mockParseAdminCommand.mockReturnValue(null);
  mockShouldRespond.mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' });
  mockHandleAdminCommand.mockResolvedValue(undefined);
  mockSendApprovalRequest.mockResolvedValue(undefined);
  mockExtractPhone.mockImplementation((jid: string) => jid.split('@')[0]);
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
    const msg = makeIncomingMessage({ senderJid: '19995550001@s.whatsapp.net' });

    await runIngest(handler, msg);

    // Verify stored in DB
    const rows = getMessagesBySender(db, '19995550001@s.whatsapp.net');
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe(msg.messageId);
    expect(rows[0].content).toBe('hello bot');

    // Runtime was called
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  });

  it('stores message even when access policy rejects it (REQ-002.AC-01)', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);
    const msg = makeIncomingMessage({ senderJid: '19995550002@s.whatsapp.net' });

    // Blocked by access policy
    mockShouldRespond.mockReturnValue({ respond: false, reason: 'blocked', accessStatus: 'blocked' });

    await runIngest(handler, msg);

    // Message still stored
    const rows = getMessagesBySender(db, '19995550002@s.whatsapp.net');
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
    mockExtractPhone.mockReturnValue('17779990000');

    const msg = makeIncomingMessage({ senderJid: '17779990000@s.whatsapp.net', senderName: 'Bob', content: 'hi' });
    await runIngest(handler, msg);

    expect(mockSendApprovalRequest).toHaveBeenCalledWith(
      db,
      messenger,
      '17779990000',
      'Bob',
      'hi',
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
    const msg = makeIncomingMessage({ senderJid: '19995550010@s.whatsapp.net' });

    // First delivery — should store and dispatch
    await runIngest(handler, msg);
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    setHappyPath();

    // Second delivery of the exact same message — should be silently dropped
    await runIngest(handler, msg);
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();

    // Only one row in DB
    const rows = getMessagesBySender(db, '19995550010@s.whatsapp.net');
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe(msg.messageId);
  });

  it('different messageId is not treated as duplicate', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const msg1 = makeIncomingMessage({ senderJid: '19995550011@s.whatsapp.net' });
    const msg2 = makeIncomingMessage({ senderJid: '19995550011@s.whatsapp.net' });

    await runIngest(handler, msg1);
    await runIngest(handler, msg2);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(2);

    const rows = getMessagesBySender(db, '19995550011@s.whatsapp.net');
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
      conversationKey: '15184194479',
      chatJid: '15184194479@s.whatsapp.net',
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

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    const msg = makeIncomingMessage();

    await runIngest(handler, msg);

    expect(journalSpy).toHaveBeenCalledOnce();
    expect(journalSpy).toHaveBeenCalledWith(
      msg.messageId,
      expect.any(String),   // conversationKey
      msg.chatJid,
      expect.any(String),   // routedTo runtime name
    );
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledWith(msg);
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

  it('runtime error marks inbound failed', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);

    vi.mocked(runtime.handleMessage).mockRejectedValue(new Error('runtime crash'));

    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(11);
    const failSpy = vi.spyOn(durability, 'markInboundFailed');

    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
    await runIngest(handler, makeIncomingMessage());

    expect(journalSpy).toHaveBeenCalledOnce();
    expect(failSpy).toHaveBeenCalledWith(11);
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
