/**
 * Fallback admin command routing through ingest — FALLBACK ON, FALLBACK OFF,
 * and FALLBACK HELP.
 *
 * Added as a separate file because tree-sitter's grammar rejects the top-level
 * `await importOriginal<T>()` pattern used in ingest.test.ts, blocking Edit.
 * The harness is copied from ingest.test.ts following the established pattern.
 *
 * ON/OFF call-through assertions (forceFallback / disableFallback): removed in
 * the fix-round review — they were circular because the mock itself wired the
 * call-through, making the assertion measure the mock not the production path.
 * Routing is verified by: parsed-command shape, handleFallbackCommand called,
 * handleAdminCommand not called, journal/skip sequence, handleMessage never
 * reached. That set is sufficient and non-circular.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());

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
  lookupAccess: vi.fn(),
  insertPending: vi.fn(),
  updateAccess: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import { createIngestHandler } from '../../src/core/ingest.ts';
import { drainIngest } from './_helpers/ingest-drain.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { isAdminMessage, parseAdminCommand } from '../../src/core/command-router.ts';
import { handleAdminCommand, handleFallbackCommand } from '../../src/core/admin.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockIsAdminMessage = vi.mocked(isAdminMessage);
const mockParseAdminCommand = vi.mocked(parseAdminCommand);
const mockHandleAdminCommand = vi.mocked(handleAdminCommand);
const mockHandleFallbackCommand = vi.mocked(handleFallbackCommand);
const mockShouldRespond = vi.mocked(shouldRespond);

// ---------------------------------------------------------------------------
// Temp DB helpers
// ---------------------------------------------------------------------------

const tempDbPaths: string[] = [];

function makeTempDb(): Database {
  const path = join(tmpdir(), `ingest-fallback-test-${randomBytes(4).toString('hex')}.db`);
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
    chatJid: '15550001234@s.whatsapp.net',
    senderJid: '15550001234@s.whatsapp.net',
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

const BOT_JID = '15559990099@s.whatsapp.net';
const BOT_LID = '81536414179000@lid';

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

async function runIngest(
  handler: (msg: IncomingMessage) => void,
  msg: IncomingMessage,
): Promise<void> {
  handler(msg);
  await drainIngest();
}

// ---------------------------------------------------------------------------
// Default mock setup
// ---------------------------------------------------------------------------

function setHappyPath(): void {
  mockIsAdminMessage.mockReturnValue(false);
  mockParseAdminCommand.mockReturnValue(null);
  mockShouldRespond.mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' });
  mockHandleFallbackCommand.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  setHappyPath();
});

// ===========================================================================
// REQ-002.AC-02c: fallback help routing — FALLBACK HELP
// ===========================================================================

describe('REQ-002.AC-02c: fallback help routing — FALLBACK HELP', () => {
  it('FALLBACK HELP consumed as admin command, calls handleFallbackCommand, never reaches runtime.handleMessage', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);

    mockIsAdminMessage.mockReturnValue(true);
    const helpCmd = { action: 'fallback' as const, sub: 'help' as const };
    mockParseAdminCommand.mockReturnValue(helpCmd);
    mockHandleFallbackCommand.mockResolvedValue(undefined);

    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(44);
    const skipSpy = vi.spyOn(durability, 'markInboundSkipped');

    const msg = makeIncomingMessage({ content: 'FALLBACK HELP' });
    await runIngest(handler, msg);

    // Routed to handleFallbackCommand with the help command shape.
    expect(mockHandleFallbackCommand).toHaveBeenCalledWith(
      runtime,
      messenger,
      helpCmd,
      msg.chatJid,
      durability,
    );
    // Other handlers must not fire.
    expect(mockHandleAdminCommand).not.toHaveBeenCalled();
    expect(journalSpy).toHaveBeenCalledOnce();
    expect(skipSpy).toHaveBeenCalledWith(44, 'admin_command');
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(mockShouldRespond).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// REQ-002.AC-02b: fallback admin command routing — FALLBACK ON / OFF
// ===========================================================================

describe('REQ-002.AC-02b: fallback admin command routing — ON / OFF', () => {
  it('FALLBACK ON 5m: parsed command shape routed to handleFallbackCommand, never reaches runtime.handleMessage', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);

    mockIsAdminMessage.mockReturnValue(true);
    const onCmd = { action: 'fallback' as const, sub: 'on' as const, durationMs: 5 * 60_000 };
    mockParseAdminCommand.mockReturnValue(onCmd);
    mockHandleFallbackCommand.mockResolvedValue(undefined);

    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(42);
    const skipSpy = vi.spyOn(durability, 'markInboundSkipped');

    const msg = makeIncomingMessage({ content: 'fallback on 5m' });
    await runIngest(handler, msg);

    // Routing: handleFallbackCommand called with correct shape.
    expect(mockHandleFallbackCommand).toHaveBeenCalledWith(
      runtime,
      messenger,
      onCmd,
      msg.chatJid,
      durability,
    );
    // Different code path — handleAdminCommand must not be called.
    expect(mockHandleAdminCommand).not.toHaveBeenCalled();
    // Journaled as 'admin' and marked skipped.
    expect(journalSpy).toHaveBeenCalledOnce();
    expect(skipSpy).toHaveBeenCalledWith(42, 'admin_command');
    // Never dispatched to the agent runtime.
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(mockShouldRespond).not.toHaveBeenCalled();
  });

  it('FALLBACK OFF: parsed command shape routed to handleFallbackCommand, never reaches runtime.handleMessage', async () => {
    const db = makeTempDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const durability = new DurabilityEngine(db);
    const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);

    mockIsAdminMessage.mockReturnValue(true);
    const offCmd = { action: 'fallback' as const, sub: 'off' as const };
    mockParseAdminCommand.mockReturnValue(offCmd);
    mockHandleFallbackCommand.mockResolvedValue(undefined);

    const journalSpy = vi.spyOn(durability, 'journalInbound').mockReturnValue(43);
    const skipSpy = vi.spyOn(durability, 'markInboundSkipped');

    const msg = makeIncomingMessage({ content: 'fallback off' });
    await runIngest(handler, msg);

    // Routing: handleFallbackCommand called with correct shape.
    expect(mockHandleFallbackCommand).toHaveBeenCalledWith(
      runtime,
      messenger,
      offCmd,
      msg.chatJid,
      durability,
    );
    expect(mockHandleAdminCommand).not.toHaveBeenCalled();
    expect(journalSpy).toHaveBeenCalledOnce();
    expect(skipSpy).toHaveBeenCalledWith(43, 'admin_command');
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(mockShouldRespond).not.toHaveBeenCalled();
  });
});
