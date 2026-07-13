/**
 * Assistant-text egress gate — origin-chat reply evidence.
 *
 * A send_verification classification claims "I already replied via a send
 * tool" and historically disarmed the reply guarantee unconditionally.
 * Observed live (ana-bot, 2026-07-13): the agent sent its reply to a
 * DIFFERENT chat, the verification text still satisfied the origin chat's
 * reply guarantee, and the origin chat went permanently silent.
 *
 * These tests pin the corrected contract: send_verification satisfaction on
 * a user-inbound turn requires a from-me message stored in the ORIGIN
 * conversation after the turn's inbound (byte-derived, via bot.db). noop
 * suppression (deliberate silence) and proactive turns (no inbound) keep
 * their evidence-free semantics.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ─── Mocks (declared before importing the runtime, hoisted by vitest) ──────────

vi.mock('../../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  const clearAlertSource = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media/tmp',
    voiceReply: 'never',
    elevenlabs: {
      defaultVoiceId: 'v',
      defaultModel: 'eleven_multilingual_v2',
      stability: 0.5,
      similarityBoost: 0.75,
    },
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
  };
  return { config };
});

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));

vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => 'present-key'),
  resolveProviderKeyService: vi.fn(() => null),
}));

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { Database } from '../../../src/core/database.ts';
import { storeMessageIfNew, type StoreMessageInput } from '../../../src/core/messages.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const dbPath = join(tmpdir(), `whatsoup-egress-test-${randomBytes(4).toString('hex')}.db`);
const db = new Database(dbPath);
db.open();

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

const ORIGIN_JID = 'origingroup@g.us';
const ORIGIN_KEY = 'origingroup_at_g.us';
const OTHER_JID = 'othergroup@g.us';
const OTHER_KEY = 'othergroup_at_g.us';
const BASE_TS = 1_700_000_000;

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeFakeQueue(targetChatJid: string) {
  return {
    targetChatJid,
    enqueueText: vi.fn(),
    enqueueResultText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
  };
}

function storeMsg(overrides: Partial<StoreMessageInput>): void {
  storeMessageIfNew(db, {
    chatJid: ORIGIN_JID,
    conversationKey: ORIGIN_KEY,
    senderJid: 'alice@s.whatsapp.net',
    senderName: 'Alice',
    messageId: `msg-${randomBytes(4).toString('hex')}`,
    content: 'hello',
    contentType: 'text',
    isFromMe: false,
    timestamp: BASE_TS,
    ...overrides,
  });
}

// Matches SEND_VERIFICATION_PATTERNS (verified … pk N) — the live ana-bot
// suppression was this shape.
const SEND_VERIFICATION_TEXT =
  'Sent to the tracker group and verified landed (pk 24408, isFromMe, matching content).';
// Matches NOOP_ASSISTANT_TEXT.
const NOOP_TEXT = '...';

type RuntimeInternals = {
  gateAssistantTextForOutbound(
    text: string,
    queue: unknown,
    inboundSeq: number | undefined,
    mapKey?: string,
  ): string | null;
  perChatTurnSourceMessageId: Map<string, string>;
  perChatTurnSuppressedReplySatisfaction: Set<string>;
  currentTurnSourceMessageId: string | null;
  turnHadSuppressedReplySatisfaction: boolean;
};

function makeRuntime(): RuntimeInternals {
  return new AgentRuntime(db, makeMessenger(), 'test', {
    model: 'claude-opus-4-8',
  }) as unknown as RuntimeInternals;
}

describe('egress gate origin-chat reply evidence', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM messages').run();
  });

  it('send_verification WITHOUT an origin-chat reply does NOT satisfy the reply guarantee (per-chat)', () => {
    storeMsg({ messageId: 'inbound-a' });
    // The turn's only send went to a DIFFERENT conversation (the live defect).
    storeMsg({
      messageId: 'cross-send',
      chatJid: OTHER_JID,
      conversationKey: OTHER_KEY,
      isFromMe: true,
      senderJid: 'me@s.whatsapp.net',
      timestamp: BASE_TS + 5,
    });

    const runtime = makeRuntime();
    runtime.perChatTurnSourceMessageId.set(ORIGIN_KEY, 'inbound-a');

    const result = runtime.gateAssistantTextForOutbound(
      SEND_VERIFICATION_TEXT,
      makeFakeQueue(ORIGIN_JID),
      42,
      ORIGIN_KEY,
    );

    expect(result).toBeNull();
    expect(runtime.perChatTurnSuppressedReplySatisfaction.has(ORIGIN_KEY)).toBe(false);
  });

  it('send_verification WITH an origin-chat reply satisfies the reply guarantee (per-chat)', () => {
    storeMsg({ messageId: 'inbound-b' });
    storeMsg({
      messageId: 'origin-reply',
      isFromMe: true,
      senderJid: 'me@s.whatsapp.net',
      timestamp: BASE_TS + 5,
    });

    const runtime = makeRuntime();
    runtime.perChatTurnSourceMessageId.set(ORIGIN_KEY, 'inbound-b');

    const result = runtime.gateAssistantTextForOutbound(
      SEND_VERIFICATION_TEXT,
      makeFakeQueue(ORIGIN_JID),
      42,
      ORIGIN_KEY,
    );

    expect(result).toBeNull();
    expect(runtime.perChatTurnSuppressedReplySatisfaction.has(ORIGIN_KEY)).toBe(true);
  });

  it('send_verification without evidence does NOT satisfy on the single/shared path either', () => {
    storeMsg({ messageId: 'inbound-c' });

    const runtime = makeRuntime();
    runtime.currentTurnSourceMessageId = 'inbound-c';

    const result = runtime.gateAssistantTextForOutbound(
      SEND_VERIFICATION_TEXT,
      makeFakeQueue(ORIGIN_JID),
      42,
    );

    expect(result).toBeNull();
    expect(runtime.turnHadSuppressedReplySatisfaction).toBe(false);
  });

  it('send_verification with evidence satisfies on the single/shared path', () => {
    storeMsg({ messageId: 'inbound-d' });
    storeMsg({
      messageId: 'origin-reply-d',
      isFromMe: true,
      senderJid: 'me@s.whatsapp.net',
      timestamp: BASE_TS + 5,
    });

    const runtime = makeRuntime();
    runtime.currentTurnSourceMessageId = 'inbound-d';

    runtime.gateAssistantTextForOutbound(
      SEND_VERIFICATION_TEXT,
      makeFakeQueue(ORIGIN_JID),
      42,
    );

    expect(runtime.turnHadSuppressedReplySatisfaction).toBe(true);
  });

  it('fails closed when the turn source message id is untracked', () => {
    const runtime = makeRuntime();
    // No perChatTurnSourceMessageId entry for the mapKey.
    runtime.gateAssistantTextForOutbound(
      SEND_VERIFICATION_TEXT,
      makeFakeQueue(ORIGIN_JID),
      42,
      ORIGIN_KEY,
    );
    expect(runtime.perChatTurnSuppressedReplySatisfaction.has(ORIGIN_KEY)).toBe(false);
  });

  it('proactive turns (no inbound seq) keep evidence-free satisfaction', () => {
    const runtime = makeRuntime();
    runtime.gateAssistantTextForOutbound(
      SEND_VERIFICATION_TEXT,
      makeFakeQueue(ORIGIN_JID),
      undefined,
      ORIGIN_KEY,
    );
    expect(runtime.perChatTurnSuppressedReplySatisfaction.has(ORIGIN_KEY)).toBe(true);
  });

  it('noop suppression (deliberate silence) keeps evidence-free satisfaction', () => {
    storeMsg({ messageId: 'inbound-e' });

    const runtime = makeRuntime();
    runtime.perChatTurnSourceMessageId.set(ORIGIN_KEY, 'inbound-e');

    runtime.gateAssistantTextForOutbound(
      NOOP_TEXT,
      makeFakeQueue(ORIGIN_JID),
      42,
      ORIGIN_KEY,
    );
    expect(runtime.perChatTurnSuppressedReplySatisfaction.has(ORIGIN_KEY)).toBe(true);
  });
});
