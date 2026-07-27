/**
 * Tests for pausedChatBypassPatterns in the ingest pipeline.
 *
 * P2 defect: the pausedChats short-circuit skips dispatch for ALL non-admin
 * messages in a paused chat — including operator-directed traffic (e.g.
 * "Codex -> Q / gate nudge") in a busy paused bot-traffic group. On one
 * production fleet instance this swallowed 25 operator messages in a day.
 *
 * Fix under test: config.pausedChatBypassPatterns (string[] of case-insensitive
 * regex sources, default []). When inbound content in a paused chat matches any
 * pattern, the message dispatches through the normal path instead of being
 * journaled as 'chat_paused'. Invalid regex entries are skipped with a single
 * warn and must never break ingest. Null content (media) never matches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

// ---------------------------------------------------------------------------
// Module mocks — registered before any imports of the mocked modules
// ---------------------------------------------------------------------------

// Shared logger fns so tests can assert on the module-level ingest logger
// (createChildLogger is called once at ingest.ts import time).
const logFns = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => logFns,
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
    chatJid: '15551230008@s.whatsapp.net',
    senderJid: '15551230008@s.whatsapp.net',
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

const BOT_JID = '15551230004@s.whatsapp.net';

function makeIngest(opts?: { durability?: Record<string, unknown> }) {
  const db = makeDb();
  const messenger = makeMessenger();
  const runtime: Runtime = {
    start: vi.fn().mockResolvedValue(undefined),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setDurability: vi.fn(),
  };
  const durability = opts?.durability as Parameters<typeof createIngestHandler>[5];
  const handler = createIngestHandler(db, messenger, runtime, () => BOT_JID, () => null, durability);
  return { db, messenger, runtime, handler, durability };
}

function makeDurability() {
  return {
    journalInbound: vi.fn().mockReturnValue(42),
    getInboundReceivedAtUnixSeconds: vi.fn().mockReturnValue(1_780_000_000),
    markInboundSkipped: vi.fn(),
    markInboundFailed: vi.fn(),
    matchEcho: vi.fn(),
  };
}

/** Fire the handler and wait until the pipeline drains. */
async function runIngest(handler: (msg: IncomingMessage) => void, msg: IncomingMessage): Promise<void> {
  handler(msg);
  // Real completion signal — see tests/core/_helpers/ingest-drain.ts.
  await drainIngest();
}

// ---------------------------------------------------------------------------
// config state management — save/restore pausedChats + pausedChatBypassPatterns
// ---------------------------------------------------------------------------

let savedPausedChats: PropertyDescriptor | undefined;
let savedBypassPatterns: PropertyDescriptor | undefined;

function setConfigProp(key: string, value: unknown): void {
  Object.defineProperty(config, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreConfigProp(key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(config, key, descriptor);
  } else {
    delete (config as Record<string, unknown>)[key];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  savedPausedChats = Object.getOwnPropertyDescriptor(config, 'pausedChats');
  savedBypassPatterns = Object.getOwnPropertyDescriptor(config, 'pausedChatBypassPatterns');
});

afterEach(() => {
  restoreConfigProp('pausedChats', savedPausedChats);
  restoreConfigProp('pausedChatBypassPatterns', savedBypassPatterns);
});

const PAUSED_GROUP = '555123000000000001@g.us';
const PAUSED_GROUP_KEY = '555123000000000001_at_g.us';
const OPERATOR_SENDER = '15551230008@s.whatsapp.net';

function makePausedGroupMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return makeMsg({
    chatJid: PAUSED_GROUP,
    senderJid: OPERATOR_SENDER,
    isGroup: true,
    ...overrides,
  });
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('pausedChatBypassPatterns — paused chat dispatch bypass', () => {
  // -------------------------------------------------------------------------
  // (a) Defect reproduction / default behavior: with NO bypass patterns
  //     configured, an operator-directed message in a paused chat is skipped
  //     and journaled 'chat_paused'. This is the P2 defect scenario and must
  //     PASS against unmodified code (pre-fix) — the fix keeps it green
  //     because bypass is default-off.
  // -------------------------------------------------------------------------
  it('skips an operator-directed message in a paused chat when no bypass is configured (defect reproduction)', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));

    const durability = makeDurability();
    const { handler, runtime } = makeIngest({ durability });
    const msg = makePausedGroupMsg({ content: 'Codex -> Q / gate nudge' });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(durability.journalInbound).toHaveBeenCalledWith(
      msg.messageId,
      PAUSED_GROUP_KEY,
      PAUSED_GROUP,
      'none',
    );
    expect(durability.markInboundSkipped).toHaveBeenCalledWith(42, 'chat_paused');
  });

  // -------------------------------------------------------------------------
  // (b) Bypass match: same operator-directed message dispatches when a
  //     configured pattern matches the content.
  // -------------------------------------------------------------------------
  it('dispatches an operator-directed message matching a bypass pattern in a paused chat', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));
    setConfigProp('pausedChatBypassPatterns', ['-> Q']);

    const durability = makeDurability();
    const { handler, runtime } = makeIngest({ durability });
    const msg = makePausedGroupMsg({ content: 'Codex -> Q / gate nudge' });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledWith(msg);
    expect(durability.markInboundSkipped).not.toHaveBeenCalledWith(expect.any(Number), 'chat_paused');
    // Info log carries chatJid + messageId only — never message content.
    expect(logFns.info).toHaveBeenCalledWith(
      { chatJid: PAUSED_GROUP, messageId: msg.messageId },
      'paused chat bypass matched — dispatching',
    );
  });

  it('matches bypass patterns case-insensitively', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));
    setConfigProp('pausedChatBypassPatterns', ['escalate to owner']);

    const { handler, runtime } = makeIngest();
    const msg = makePausedGroupMsg({ content: 'ESCALATE TO OWNER: durability gate red' });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // (c) Non-matching content: still skipped as chat_paused.
  // -------------------------------------------------------------------------
  it('still skips a non-matching message in a paused chat when bypass patterns are configured', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));
    setConfigProp('pausedChatBypassPatterns', ['-> Q']);

    const durability = makeDurability();
    const { handler, runtime } = makeIngest({ durability });
    const msg = makePausedGroupMsg({ content: 'routine bot chatter, nothing directed' });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(durability.markInboundSkipped).toHaveBeenCalledWith(42, 'chat_paused');
  });

  // -------------------------------------------------------------------------
  // (d) Empty/default config: behavior identical to today (regression guard).
  // -------------------------------------------------------------------------
  it('keeps paused-chat behavior identical when pausedChatBypassPatterns is empty', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));
    setConfigProp('pausedChatBypassPatterns', []);

    const durability = makeDurability();
    const { handler, runtime } = makeIngest({ durability });
    const msg = makePausedGroupMsg({ content: 'Codex -> Q / gate nudge' });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(durability.markInboundSkipped).toHaveBeenCalledWith(42, 'chat_paused');
  });

  it('dispatches non-paused chats normally regardless of bypass patterns', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));
    setConfigProp('pausedChatBypassPatterns', ['-> Q']);

    const { handler, runtime } = makeIngest();
    const msg = makeMsg({ chatJid: '15551230008@s.whatsapp.net', isGroup: false, content: 'plain DM' });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // (e) Invalid regex entry: skipped with a single warn; ingest keeps working
  //     and the remaining valid patterns still apply.
  // -------------------------------------------------------------------------
  it('skips an invalid regex entry without breaking ingest; valid patterns still apply', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));
    setConfigProp('pausedChatBypassPatterns', ['([', '-> Q']);

    const durability = makeDurability();
    const { handler, runtime } = makeIngest({ durability });

    const matching = makePausedGroupMsg({ content: 'Codex -> Q / gate nudge' });
    const nonMatching = makePausedGroupMsg({ content: 'routine bot chatter' });

    await runIngest(handler, matching);
    await runIngest(handler, nonMatching);

    // Valid pattern still dispatches the matching message…
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledWith(matching);
    // …and the non-matching one is still paused.
    expect(durability.markInboundSkipped).toHaveBeenCalledWith(42, 'chat_paused');

    // The bad entry warns once at compile time — not once per message.
    const invalidWarns = logFns.warn.mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('invalid pausedChatBypassPatterns'),
    );
    expect(invalidWarns).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // (f) Null content (media): treated as non-matching, skipped as today.
  // -------------------------------------------------------------------------
  it('treats null content as non-matching (media message stays paused)', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));
    // '.*' would match empty string — null must never be coerced to ''.
    setConfigProp('pausedChatBypassPatterns', ['.*']);

    const durability = makeDurability();
    const { handler, runtime } = makeIngest({ durability });
    const msg = makePausedGroupMsg({ content: null, contentType: 'image', contentText: '[image]' });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(durability.markInboundSkipped).toHaveBeenCalledWith(42, 'chat_paused');
  });

  // -------------------------------------------------------------------------
  // (g) Bounded scan window: member-supplied content only feeds the operator
  // regexes through the first 4096 chars, so a crafted long message cannot
  // drive pathological backtracking over unbounded input.
  // -------------------------------------------------------------------------
  it('matches a bypass marker inside the scan window of a long message', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));
    setConfigProp('pausedChatBypassPatterns', ['-> Q']);

    const { handler, runtime } = makeIngest();
    const msg = makePausedGroupMsg({ content: `Codex -> Q / gate nudge\n${'x'.repeat(10_000)}` });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  });

  it('does not match a bypass marker positioned beyond the scan window', async () => {
    setConfigProp('pausedChats', new Set([PAUSED_GROUP]));
    setConfigProp('pausedChatBypassPatterns', ['-> Q']);

    const durability = makeDurability();
    const { handler, runtime } = makeIngest({ durability });
    const msg = makePausedGroupMsg({ content: `${'x'.repeat(5_000)}\nCodex -> Q / gate nudge` });

    await runIngest(handler, msg);

    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    expect(durability.markInboundSkipped).toHaveBeenCalledWith(42, 'chat_paused');
  });
});
