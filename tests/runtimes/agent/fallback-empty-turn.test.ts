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

vi.mock('../../../src/lib/emit-alert.ts', () => ({ emitAlert: vi.fn() }));

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
  };
}

/** Bracket-access view exposing private fallback telemetry and handlers. */
type RuntimeView = {
  fallbackActiveUntil: number | null;
  fallbackTurnsServed: number;
  fallbackTurnsEmpty: number;
  lastFallbackTurnAt: number | null;
  turnHadVisibleOutput: boolean;
  queue: unknown;
  // Private state maps used by isSilentCompact / isSystemResult in handleEvent.
  // silentCompactScopes values are NodeJS Timeout handles; Map<string, unknown>
  // avoids the ReturnType construct that some grammars cannot parse.
  silentCompactScopes: Map<string, unknown>;
  perChatPendingSystemResults: Map<string, number>;
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
      expect.any(String),
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
    expect(vi.mocked(emitAlert)).not.toHaveBeenCalled();
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
    expect(vi.mocked(emitAlert)).not.toHaveBeenCalled();
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
    v(runtime).silentCompactScopes.set(GLOBAL_SCOPE, 0);
    v(runtime).turnHadVisibleOutput = false;

    v(runtime).handleEvent({ type: 'result', text: null });

    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(0);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(0);
    expect(vi.mocked(emitAlert)).not.toHaveBeenCalled();
  });

  it('handleEvent path: system-result turn is not counted', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    v(runtime).activateProviderFallback(null);

    const fakeQueue = makeFakeQueue();
    v(runtime).queue = fakeQueue;
    // isSystemResult derives from perChatPendingSystemResults.get(GLOBAL_TOOL_SCOPE_KEY) > 0.
    // Setting 1 mirrors what markPendingSystemResult writes before a system turn fires.
    v(runtime).perChatPendingSystemResults.set(GLOBAL_SCOPE, 1);
    v(runtime).turnHadVisibleOutput = false;

    v(runtime).handleEvent({ type: 'result', text: null });

    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(0);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(0);
    expect(vi.mocked(emitAlert)).not.toHaveBeenCalled();
  });
});
