/**
 * Zero-text fallback turn signal — counters, alert, and per-chat user notice.
 *
 * When AgentRuntime routes a completed turn through the per-chat handler
 * (handleEventWithContext) or the single/shared handler (handleEvent) while
 * a provider-fallback window is active, and the turn produced no visible
 * output (text=null, text=''), it should:
 *   - increment fallbackTurnsServed and fallbackTurnsEmpty
 *   - set lastFallbackTurnAt
 *   - fire emitAlert with source 'fallback_empty_turn'
 *   - on the per-chat path only: enqueue a user-visible notice
 *
 * Kept in a separate file from provider-fallback.test.ts to avoid the
 * tree-sitter grammar limitation triggered by `importOriginal<T>()`.
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

// Config object stashed on globalThis so the test body can mutate the same
// reference without the factory closing over a not-yet-initialized variable.
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
  (globalThis as Record<string, unknown>)['__emptyTurnTestConfig__'] = config;
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

// Keyring — mock the whole module; this test file does not need the real exports.
vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => 'present-key'),
  resolveProviderKeyService: vi.fn((provider: unknown, model: unknown) => {
    if (provider === 'opencode-cli' && typeof model === 'string') return model.split('/')[0]?.trim().toLowerCase() || null;
    if (provider === 'openai-api') return 'openai';
    if (provider === 'anthropic-api') return 'anthropic';
    return null;
  }),
}));

// Credential probe — stub out to prevent real network calls. The probe is
// fire-and-forget (void) and this file does not assert its outcome; 'unknown'
// is the safe fail-open value.
vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

// Unit tests must never spawn the real fallback binary; 'unknown' is the
// safe fail-open value (no alert, no version log).
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__emptyTurnTestConfig__'] as Record<string, unknown>;
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
  agentProvider?: string;
  agentFallbackProvider?: string;
  agentFallbackModel?: string;
}

function makeRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = overrides.agentProvider ?? 'claude-cli';
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

/** IOutboundQueue stub covering all members the result paths touch. */
function makeFakeQueue() {
  return {
    targetChatJid: 'fake@s.whatsapp.net',
    enqueueText: vi.fn(),
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

/** Bracket-access view exposing private fallback telemetry and handlers. */
type RuntimeView = {
  fallbackWindow: { activeUntil: number | null };
  fallbackMetrics: { turnsServed: number; turnsEmpty: number; lastTurnAt: number | null };
  turnHadVisibleOutput: boolean;
  queue: unknown;
  // Private state used by isSilentCompact / isSystemResult in handleEvent.
  // silentCompactScopes (now on the extracted AutoCompactController, reached via
  // runtime.autoCompact) holds NodeJS Timeout handles; Map<string, unknown> avoids
  // the ReturnType construct that some grammars cannot parse.
  autoCompact: { silentCompactScopes: Map<string, unknown> };
  pendingSystemResults: { counts: Map<string, number> };
  activateProviderFallback(resetAt: Date | null): void;
  handleEventWithContext(
    event: unknown,
    queue: unknown,
    session: unknown,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
    toolScopeKey?: string,
    isSystemResult?: boolean,
  ): void;
  handleEvent(event: unknown): void;
  recordFallbackTurnOutcome(
    queue: unknown,
    hadVisibleOutput: boolean,
    hadToolWork: boolean,
    session: unknown,
  ): void;
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

// GLOBAL_TOOL_SCOPE_KEY mirrors the module constant (runtime.ts line 129).
const GLOBAL_SCOPE = '__global__';

// ─── zero-text fallback turn signal ──────────────────────────────────────────

describe('zero-text fallback turn signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('per-chat path, fallback active, empty result: increments counters, alerts, enqueues notice', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue();
    v(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv',
      1,
      'mapkey',
    );

    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(1);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(1);
    expect(runtime.getFallbackState().lastFallbackTurnAt).not.toBeNull();
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_empty_turn',
      expect.any(String),
      expect.stringContaining('chat=fake@s.whatsapp.net'),
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('no reply'),
    );
  });

  it('per-chat path, fallback active, NON-empty result: increments served only, no alert, no notice', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue();
    v(runtime).handleEventWithContext(
      { type: 'result', text: 'hello there' },
      queue,
      null,
      'conv',
      1,
      'mapkey',
    );

    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(1);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(0);
    // Arming fallback emits exactly the activation alert — no fallback_empty_turn.
    expect(vi.mocked(emitAlert).mock.calls.map((c) => c[1])).toEqual(['provider_fallback_activated']);
    expect(queue.enqueueText).not.toHaveBeenCalledWith(
      expect.stringContaining('no reply'),
    );
  });

  it('no fallback window active: empty result does not increment counters, no alert, no notice', () => {
    const runtime = makeRuntime({});
    const queue = makeFakeQueue();
    v(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv',
      1,
      'mapkey',
    );

    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(0);
    expect(vi.mocked(emitAlert)).not.toHaveBeenCalled();
    expect(queue.enqueueText).not.toHaveBeenCalledWith(
      expect.stringContaining('no reply'),
    );
  });

  it('system result is not counted: isSystemResult=true skips counters and notice', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue();
    // 7th arg = toolScopeKey (undefined -> default), 8th arg = isSystemResult
    v(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv',
      1,
      'mapkey',
      undefined,
      true,
    );

    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(0);
    // Arming fallback emits exactly the activation alert — no fallback_empty_turn.
    expect(vi.mocked(emitAlert).mock.calls.map((c) => c[1])).toEqual(['provider_fallback_activated']);
    expect(queue.enqueueText).not.toHaveBeenCalledWith(
      expect.stringContaining('no reply'),
    );
  });

  it('handleEvent path: fallback active, empty result increments fallbackTurnsEmpty but not the per-chat notice', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);

    const fakeQueue = makeFakeQueue();
    v(runtime).queue = fakeQueue;
    v(runtime).turnHadVisibleOutput = false;

    v(runtime).handleEvent({ type: 'result', text: null });

    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(1);
    // The per-chat "backup model returned no reply" notice must NOT be enqueued
    // on this path — the existing "_(no response)_" already covers the user.
    expect(fakeQueue.enqueueText).not.toHaveBeenCalledWith(
      expect.stringContaining('backup model returned no reply'),
    );
  });

  it('usage-limit results are not counted as turns (early break before counter)', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue();
    const USAGE_LIMIT_TEXT = 'Claude usage limit reached. Resets at 3pm.';
    v(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
      'conv',
      1,
      'mapkey',
    );

    // The usage-limit branch breaks early; counters must not be incremented.
    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(0);
  });

  it('handleEvent path: silent-compact turn is not counted', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);

    const fakeQueue = makeFakeQueue();
    v(runtime).queue = fakeQueue;
    // isSilentCompact(GLOBAL_TOOL_SCOPE_KEY) checks silentCompactScopes.has(key).
    // Inject a sentinel value (0) so the presence check is satisfied without
    // creating a real timer — the value is never used, only the key matters.
    v(runtime).autoCompact.silentCompactScopes.set(GLOBAL_SCOPE, 0);
    v(runtime).turnHadVisibleOutput = false;

    v(runtime).handleEvent({ type: 'result', text: null });

    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(0);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(0);
    // Arming fallback emits exactly the activation alert — no fallback_empty_turn.
    expect(vi.mocked(emitAlert).mock.calls.map((c) => c[1])).toEqual(['provider_fallback_activated']);
  });

  it('handleEvent path: system-result turn is not counted', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);

    const fakeQueue = makeFakeQueue();
    v(runtime).queue = fakeQueue;
    // isSystemResult derives from pendingSystemResults.counts.get(GLOBAL_TOOL_SCOPE_KEY) > 0.
    // Setting 1 mirrors what pendingSystemResults.mark writes before a system turn fires.
    v(runtime).pendingSystemResults.counts.set(GLOBAL_SCOPE, 1);
    v(runtime).turnHadVisibleOutput = false;

    v(runtime).handleEvent({ type: 'result', text: null });

    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(0);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(0);
    // Arming fallback emits exactly the activation alert — no fallback_empty_turn.
    expect(vi.mocked(emitAlert).mock.calls.map((c) => c[1])).toEqual(['provider_fallback_activated']);
  });
});

describe('fallback_empty_turn alert — per-chat dedup', () => {
  const DEDUP_MS = 30 * 60 * 1000; // PROVIDER_FALLBACK_NOTICE_DEDUP_MS default

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makeQ(chatJid: string) {
    return {
      targetChatJid: chatJid,
      enqueueText: vi.fn(),
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

  it('two empty turns for the same chat within the dedup window → ONE fallback_empty_turn alert, counters increment twice', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);
    vi.mocked(emitAlert).mockClear();

    const queue = makeQ('chat-a@s.whatsapp.net');
    v(runtime).handleEventWithContext({ type: 'result', text: null }, queue, null, 'conv', 1, 'mapkey');
    v(runtime).handleEventWithContext({ type: 'result', text: null }, queue, null, 'conv', 2, 'mapkey');

    const emptyAlerts = vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === 'fallback_empty_turn');
    expect(emptyAlerts).toHaveLength(1);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(2);
  });

  it('two empty turns for different chats within the dedup window → TWO fallback_empty_turn alerts', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);
    vi.mocked(emitAlert).mockClear();

    const qA = makeQ('chat-a@s.whatsapp.net');
    const qB = makeQ('chat-b@s.whatsapp.net');
    v(runtime).handleEventWithContext({ type: 'result', text: null }, qA, null, 'conv-a', 1, 'key-a');
    v(runtime).handleEventWithContext({ type: 'result', text: null }, qB, null, 'conv-b', 1, 'key-b');

    const emptyAlerts = vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === 'fallback_empty_turn');
    expect(emptyAlerts).toHaveLength(2);
  });

  it('empty turn after the dedup window expires → second alert fires', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);
    vi.mocked(emitAlert).mockClear();

    const queue = makeQ('chat-a@s.whatsapp.net');
    v(runtime).handleEventWithContext({ type: 'result', text: null }, queue, null, 'conv', 1, 'mapkey');

    // Advance past the dedup window.
    vi.advanceTimersByTime(DEDUP_MS + 1);

    v(runtime).handleEventWithContext({ type: 'result', text: null }, queue, null, 'conv', 2, 'mapkey');

    const emptyAlerts = vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === 'fallback_empty_turn');
    expect(emptyAlerts).toHaveLength(2);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(2);
  });
});

// ─── chain advance past a structurally-empty fallback entry ──────────────────
//
// A fallback ENTRY that connects but emits no assistant text (the opencode
// minimax integration: step_start + messageID, zero text — verified 2026-06-17)
// produces no terminal-failure message, so the text-driven advance path never
// fires. Without advancing, the bot pins to the dead entry and emits
// "_backup returned no reply — resend_" every turn while a WORKING entry
// (deepseek) sits behind it. recordFallbackTurnOutcome must, after
// EMPTY_OUTPUT_FALLBACK_THRESHOLD (2) consecutive empty turns on the active
// entry, route it through the same advance path terminal failures use.
describe('fallback chain advance on structurally-empty entry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // A two-entry independent chain: dead minimax in front of working deepseek.
  function makeChainRuntime(): AgentRuntime {
    mockConfigRef()['agentFallbacks'] = [
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2.7' },
      { provider: 'opencode-cli', model: 'deepseek/deepseek-chat' },
    ];
    const runtime = makeRuntime({});
    delete mockConfigRef()['agentFallbacks'];
    return runtime;
  }

  // Session on the opencode fallback provider — markActiveFallbackFailed matches
  // the active entry's provider against this before failing it.
  const ocSession = {
    getProviderId: () => 'opencode-cli',
    getStatus: () => ({ sessionId: 'opencode-cli-1' }),
  };

  it('advances to the next entry after the threshold of consecutive empty turns', () => {
    const runtime = makeChainRuntime();
    v(runtime).activateProviderFallback(null);
    expect(runtime.getFallbackState().activeFallbackEntry?.model).toBe('minimax/MiniMax-M2.7');

    const queue = makeFakeQueue();
    // 1st empty turn: counted, below threshold — still on minimax.
    v(runtime).recordFallbackTurnOutcome(queue, false, false, ocSession);
    expect(runtime.getFallbackState().activeFallbackEntry?.model).toBe('minimax/MiniMax-M2.7');

    // 2nd consecutive empty turn: threshold reached — advance to deepseek.
    v(runtime).recordFallbackTurnOutcome(queue, false, false, ocSession);
    expect(runtime.getFallbackState().activeFallbackEntry?.model).toBe('deepseek/deepseek-chat');
    expect(runtime.getFallbackState().failedEntryCount).toBe(1);
  });

  it('does not advance when a real reply interrupts the empty run', () => {
    const runtime = makeChainRuntime();
    v(runtime).activateProviderFallback(null);
    const queue = makeFakeQueue();

    v(runtime).recordFallbackTurnOutcome(queue, false, false, ocSession); // empty 1
    v(runtime).recordFallbackTurnOutcome(queue, true, false, ocSession);  // real reply → reset
    v(runtime).recordFallbackTurnOutcome(queue, false, false, ocSession); // empty 1 again

    // Counter was reset by the real reply, so we are still below threshold.
    expect(runtime.getFallbackState().activeFallbackEntry?.model).toBe('minimax/MiniMax-M2.7');
    expect(runtime.getFallbackState().failedEntryCount).toBe(0);
  });

  it('does not advance when session is null (advance requires a session to fail the entry)', () => {
    const runtime = makeChainRuntime();
    v(runtime).activateProviderFallback(null);
    const queue = makeFakeQueue();

    v(runtime).recordFallbackTurnOutcome(queue, false, false, null);
    v(runtime).recordFallbackTurnOutcome(queue, false, false, null);

    expect(runtime.getFallbackState().activeFallbackEntry?.model).toBe('minimax/MiniMax-M2.7');
    expect(runtime.getFallbackState().failedEntryCount).toBe(0);
  });
});
