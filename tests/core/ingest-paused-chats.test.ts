/**
 * Tests for the pausedChats feature in the ingest pipeline.
 *
 * When a chat JID (or its derived conversationKey) is in config.pausedChats,
 * inbound messages are stored but never dispatched to runtime.handleMessage.
 * Durability journals the skip as 'chat_paused'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

// ---------------------------------------------------------------------------
// Module mocks — registered before any imports of the mocked modules
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
import { config } from '../../src/config.ts';
import { isAdminMessage, parseAdminCommand } from '../../src/core/command-router.ts';
import { handleAdminCommand } from '../../src/core/admin.ts';

const mockIsAdminMessage = vi.mocked(isAdminMessage);
const mockParseAdminCommand = vi.mocked(parseAdminCommand);
const mockHandleAdminCommand = vi.mocked(handleAdminCommand);

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

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(4).toString('hex')}`,
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
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

const BOT_JID = '18455943112@s.whatsapp.net';

function makeIngest(opts?: { durability?: Record<string, unknown>; runtimeOverrides?: Partial<Runtime> }) {
  const db = makeDb();
  const messenger = makeMessenger();
  const runtime: Runtime = {
    start: vi.fn().mockResolvedValue(undefined),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setDurability: vi.fn(),
    ...opts?.runtimeOverrides,
  };
  const durability = opts?.durability as Parameters<typeof createIngestHandler>[5];
  const handler = createIngestHandler(db, messenger, runtime, () => BOT_JID, () => null, durability);
  return { db, messenger, runtime, handler, durability };
}

/** Fire the handler and wait until the pipeline drains. */
async function runIngest(handler: (msg: IncomingMessage) => void, msg: IncomingMessage): Promise<void> {
  handler(msg);
  // Real completion signal — see tests/core/_helpers/ingest-drain.ts.
  await drainIngest();
}

// ---------------------------------------------------------------------------
// pausedChats state management
// ---------------------------------------------------------------------------

let savedPausedChats: Set<string>;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAdminMessage.mockReturnValue(false);
  mockParseAdminCommand.mockReturnValue(null);
  mockHandleAdminCommand.mockResolvedValue(undefined);
  savedPausedChats = config.pausedChats;
});

afterEach(() => {
  // Restore the original pausedChats set
  Object.defineProperty(config, 'pausedChats', {
    configurable: true,
    writable: true,
    value: savedPausedChats,
  });
});

function setPausedChats(jids: string[]): void {
  Object.defineProperty(config, 'pausedChats', {
    configurable: true,
    writable: true,
    value: new Set(jids),
  });
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('pausedChats — ingest short-circuit', () => {
  // -------------------------------------------------------------------------
  // 1. Paused group: message from paused group → runtime.handleMessage NOT called
  // -------------------------------------------------------------------------
  it('skips dispatch for a message from a paused group', async () => {
    const groupJid = '120363406689931730@g.us';
    setPausedChats([groupJid]);

    const { handler, runtime } = makeIngest();
    const msg = makeMsg({
      chatJid: groupJid,
      senderJid: '15184194479@s.whatsapp.net',
      isGroup: true,
    });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Non-paused: message from unlisted chat → runtime.handleMessage IS called
  // -------------------------------------------------------------------------
  it('dispatches message from a non-paused chat normally', async () => {
    setPausedChats(['120363406689931730@g.us']); // some other chat is paused

    const { handler, runtime } = makeIngest();
    const msg = makeMsg({
      chatJid: '15184194479@s.whatsapp.net',
      isGroup: false,
    });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledWith(msg);
  });

  // -------------------------------------------------------------------------
  // 3. Durability: paused message gets journalInbound + markInboundSkipped
  // -------------------------------------------------------------------------
  it('journals paused messages as chat_paused when durability is present', async () => {
    const groupJid = '120363406689931730@g.us';
    setPausedChats([groupJid]);

    const journalInbound = vi.fn().mockReturnValue(42);
    const markInboundSkipped = vi.fn();
    const durability = {
      journalInbound,
      markInboundSkipped,
      matchEcho: vi.fn(),
    };

    const { handler, runtime } = makeIngest({ durability });
    const msg = makeMsg({
      chatJid: groupJid,
      senderJid: '15184194479@s.whatsapp.net',
      isGroup: true,
    });

    await runIngest(handler, msg);

    expect(runtime.handleMessage).not.toHaveBeenCalled();
    expect(journalInbound).toHaveBeenCalledOnce();
    // conversationKey for group JID = "120363406689931730_at_g.us"
    expect(journalInbound).toHaveBeenCalledWith(
      msg.messageId,
      '120363406689931730_at_g.us',
      groupJid,
      'none',
    );
    expect(markInboundSkipped).toHaveBeenCalledOnce();
    expect(markInboundSkipped).toHaveBeenCalledWith(42, 'chat_paused');
  });

  it('handles admin commands from paused chats instead of dropping them', async () => {
    const groupJid = '120363406689931730@g.us';
    setPausedChats([groupJid]);
    mockIsAdminMessage.mockReturnValue(true);
    mockParseAdminCommand.mockReturnValue({ action: 'block', subjectType: 'phone', subjectId: '15559876543' });

    const journalInbound = vi.fn().mockReturnValue(43);
    const markInboundSkipped = vi.fn();
    const durability = {
      journalInbound,
      markInboundSkipped,
      matchEcho: vi.fn(),
    };

    const { handler, runtime, messenger, db } = makeIngest({ durability });
    const msg = makeMsg({
      chatJid: groupJid,
      senderJid: '15184194479@s.whatsapp.net',
      content: 'block 15559876543',
      isGroup: true,
    });

    await runIngest(handler, msg);

    expect(runtime.handleMessage).not.toHaveBeenCalled();
    expect(mockHandleAdminCommand).toHaveBeenCalledWith(
      db,
      messenger,
      'block',
      'phone',
      '15559876543',
      groupJid,
      expect.any(Function),
      durability,
    );
    expect(journalInbound).toHaveBeenCalledWith(
      msg.messageId,
      '120363406689931730_at_g.us',
      groupJid,
      'admin',
    );
    expect(markInboundSkipped).toHaveBeenCalledWith(43, 'admin_command');
    expect(markInboundSkipped).not.toHaveBeenCalledWith(expect.any(Number), 'chat_paused');
  });

  // -------------------------------------------------------------------------
  // 4. Both keys checked: either conversationKey or chatJid match triggers pause
  // -------------------------------------------------------------------------
  it('pauses when conversationKey matches (even if chatJid is not in the set)', async () => {
    // For DM jid "15184194479@s.whatsapp.net", conversationKey = "15184194479"
    // Pause using the conversationKey form
    setPausedChats(['15184194479']);

    const { handler, runtime } = makeIngest();
    const msg = makeMsg({
      chatJid: '15184194479@s.whatsapp.net',
      isGroup: false,
    });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  it('pauses when chatJid matches (even if conversationKey is not in the set)', async () => {
    // Pause using the raw chatJid
    setPausedChats(['15184194479@s.whatsapp.net']);

    const { handler, runtime } = makeIngest();
    const msg = makeMsg({
      chatJid: '15184194479@s.whatsapp.net',
      isGroup: false,
    });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Empty pausedChats: no messages blocked
  // -------------------------------------------------------------------------
  it('dispatches all messages when pausedChats is empty', async () => {
    setPausedChats([]);

    const { handler, runtime } = makeIngest();
    const msg1 = makeMsg({ chatJid: '15184194479@s.whatsapp.net', isGroup: false });
    const msg2 = makeMsg({ chatJid: '120363406689931730@g.us', senderJid: '15184194479@s.whatsapp.net', isGroup: true });

    await runIngest(handler, msg1);
    await runIngest(handler, msg2);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Extra: no durability — paused still skips dispatch without crashing
  // -------------------------------------------------------------------------
  it('skips dispatch without crashing when durability is absent', async () => {
    const groupJid = '120363406689931730@g.us';
    setPausedChats([groupJid]);

    const { handler, runtime } = makeIngest(); // no durability
    const msg = makeMsg({
      chatJid: groupJid,
      senderJid: '15184194479@s.whatsapp.net',
      isGroup: true,
    });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });
});
