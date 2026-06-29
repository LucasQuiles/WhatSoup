/**
 * per_chat scope: empty-output fallback arms AND replays the interrupted turn.
 *
 * Regression test for the defect where handleEventPerChat deleted
 * pendingTurnText[mapKey] BEFORE calling handleEventWithContext, so
 * maybeArmFallbackAfterEmptyPrimaryTurn → scheduleFallbackReplay read
 * undefined from the map and silently dropped the replay (returned false).
 *
 * Coverage goals:
 *   1. per_chat path: after EMPTY_OUTPUT_FALLBACK_THRESHOLD consecutive empty
 *      primary turns, scheduleFallbackReplay successfully reads the turn text
 *      and dispatches a replay (replayTurnOnFallback called with correct text).
 *   2. singleton/handleEvent path: still works — currentTurnReplayText is the
 *      source of truth there and is cleared AFTER arming, so it is unaffected.
 *   3. per_chat path: pendingTurnText entry is NOT leaked — it is cleaned up
 *      once the replay text has been captured (no map-grow over repeated turns).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fallbackStateDb from '../../../src/runtimes/agent/fallback-state-db.ts';

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
  (globalThis as Record<string, unknown>)['__perChatReplayTestConfig__'] = config;
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
  resolveProviderKeyService: vi.fn((provider: unknown, model: unknown) => {
    if (provider === 'opencode-cli' && typeof model === 'string') return model.split('/')[0]?.trim().toLowerCase() || null;
    if (provider === 'openai-api') return 'openai';
    if (provider === 'anthropic-api') return 'anthropic';
    return null;
  }),
}));

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
  probeBinaryAuthStatus: vi.fn(() => Promise.resolve({ status: 'ok', output: '' })),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__perChatReplayTestConfig__'] as Record<string, unknown>;
}

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

interface RuntimeOverrides {
  agentFallbackProvider?: string;
  agentFallbackModel?: string;
}

function makeRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentProviderConfig'] = undefined;
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

/** IOutboundQueue stub covering all members that the result path touches. */
function makeFakeQueue(chatJid = 'chat@s.whatsapp.net') {
  return {
    targetChatJid: chatJid,
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueResultText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    markLastTerminal: vi.fn(),
    flush: vi.fn(async () => {}),
    getLastOpId: vi.fn(() => undefined),
    clearLastOpId: vi.fn(),
    indicateTyping: vi.fn(),
    endTurn: vi.fn(),
  };
}

/** Bracket-access view of private runtime state. */
type RuntimeView = {
  // Maps used by handleEventPerChat
  chatQueues: Map<string, unknown>;
  chatSessions: Map<string, unknown>;
  perChatInboundSeqQueue: Map<string, number[]>;
  pendingSystemResults: { counts: Map<string, number> };
  pendingTurnText: Map<string, string>;
  pendingTurnActorJid: Map<string, string | undefined>;
  // Singleton replay state
  currentTurnReplayText: string | null;
  currentTurnReplayActorJid: string | undefined;
  queue: unknown;
  session: unknown;
  turnHadVisibleOutput: boolean;
  consecutivePrimaryEmptyTurns: number;
  // Methods
  handleEventPerChat(mapKey: string, event: unknown, toolScopeKey: string): void;
  handleEvent(event: unknown): void;
  replayTurnOnFallback(args: unknown): Promise<void>;
  activateProviderFallback(resetAt: Date | null, reason?: string): unknown;
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

const FALLBACK_CFG = {
  agentFallbackProvider: 'opencode-cli',
  agentFallbackModel: 'minimax/minimax-m2',
};

// EMPTY_OUTPUT_FALLBACK_THRESHOLD = 2 (mirrors the module constant).
const THRESHOLD = 2;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('per_chat empty-output fallback — replay sees pendingTurnText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T00:00:00Z'));
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('per_chat: replay fires with the correct turn text when primary hits empty-output threshold', async () => {
    const runtime = makeRuntime(FALLBACK_CFG);
    const rv = v(runtime);

    // Stub replayTurnOnFallback so no real sessions are spawned.
    rv.replayTurnOnFallback = vi.fn(async () => {});

    const mapKey = 'chat@s.whatsapp.net';
    const queue = makeFakeQueue(mapKey);

    // Wire up the per-chat queue and a minimal inbound-seq queue (no session
    // needed — handleEventPerChat falls through to null session fine).
    rv.chatQueues.set(mapKey, queue);
    rv.perChatInboundSeqQueue.set(mapKey, [1, 2]);

    // Simulate sendTurnPerChat setting the pending text before dispatch.
    const turnText = 'What is the meaning of life?';
    rv.pendingTurnText.set(mapKey, turnText);
    rv.pendingTurnActorJid.set(mapKey, 'user@s.whatsapp.net');

    // Drive THRESHOLD - 1 empty turns: below threshold, no arm yet.
    // With the fix, empty turns do not delete pendingTurnText, so the entry
    // persists across consecutive empty turns without needing re-population.
    for (let i = 0; i < THRESHOLD - 1; i++) {
      rv.handleEventPerChat(mapKey, { type: 'result', text: null }, mapKey);
    }
    expect(rv.replayTurnOnFallback).not.toHaveBeenCalled();
    // Entry must still be present after the below-threshold empty turn.
    expect(rv.pendingTurnText.get(mapKey)).toBe(turnText);

    rv.perChatInboundSeqQueue.set(mapKey, [2]);

    // Drive the THRESHOLD-th empty turn: this must arm the fallback AND replay.
    rv.handleEventPerChat(mapKey, { type: 'result', text: null }, mapKey);

    // Allow the void promise chain inside scheduleFallbackReplay to settle
    // without advancing unrelated fallback recovery timers.
    await Promise.resolve();

    // The replay must have been dispatched with the interrupted turn text.
    expect(rv.replayTurnOnFallback).toHaveBeenCalledTimes(1);
    const callArgs = (rv.replayTurnOnFallback as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      replayText: string;
      mapKey: string;
      chatJid: string;
    };
    expect(callArgs.replayText).toBe(turnText);
    expect(callArgs.mapKey).toBe(mapKey);
    expect(callArgs.chatJid).toBe(mapKey);
  });

  it('per_chat: pendingTurnText is cleared when the turn produces visible output (no stale text on success)', () => {
    // Verify the symmetric case: a turn with actual output still clears
    // pendingTurnText so successful turns do not accumulate stale entries.
    // This guards against the fix over-retaining entries on the success path.
    const runtime = makeRuntime(FALLBACK_CFG);
    const rv = v(runtime);

    const mapKey = 'chat@s.whatsapp.net';
    const queue = makeFakeQueue(mapKey);
    rv.chatQueues.set(mapKey, queue);
    rv.perChatInboundSeqQueue.set(mapKey, [1]);

    const turnText = 'Help me with something';
    rv.pendingTurnText.set(mapKey, turnText);
    rv.pendingTurnActorJid.set(mapKey, 'user@s.whatsapp.net');

    // A result with real visible text: the delete guard (event.text && fallbackReason === null)
    // must be satisfied, so the entry is removed after the turn completes.
    rv.handleEventPerChat(mapKey, { type: 'result', text: 'Here is my answer!' }, mapKey);

    expect(rv.pendingTurnText.has(mapKey)).toBe(false);
    expect(rv.pendingTurnActorJid.has(mapKey)).toBe(false);
  });

  it('singleton path: replay still fires when primary hits threshold (regression guard)', async () => {
    const runtime = makeRuntime(FALLBACK_CFG);
    const rv = v(runtime);

    rv.replayTurnOnFallback = vi.fn(async () => {});

    // Singleton uses handleEvent and currentTurnReplayText — not pendingTurnText.
    const singletonQueue = makeFakeQueue('chat@s.whatsapp.net');
    rv.queue = singletonQueue;
    rv.turnHadVisibleOutput = false;

    const turnText = 'Please answer my question';
    rv.currentTurnReplayText = turnText;
    rv.currentTurnReplayActorJid = undefined;

    // Drive THRESHOLD - 1 empty singleton turns.
    for (let i = 0; i < THRESHOLD - 1; i++) {
      rv.handleEvent({ type: 'result', text: null });
      // Repopulate for next turn (handleEvent clears after arming).
      rv.currentTurnReplayText = turnText;
      rv.turnHadVisibleOutput = false;
    }
    expect(rv.replayTurnOnFallback).not.toHaveBeenCalled();

    // Drive the threshold turn.
    rv.handleEvent({ type: 'result', text: null });
    await Promise.resolve();

    expect(rv.replayTurnOnFallback).toHaveBeenCalledTimes(1);
    const args = (rv.replayTurnOnFallback as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      replayText: string;
      mapKey: undefined;
    };
    expect(args.replayText).toBe(turnText);
    // Singleton path passes undefined mapKey (not a per-chat key).
    expect(args.mapKey).toBeUndefined();
    // Confirm the replay was dispatched to the correct chat JID.
    const argsWithJid = (rv.replayTurnOnFallback as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      chatJid: string;
    };
    expect(argsWithJid.chatJid).toBe('chat@s.whatsapp.net');
  });
});
