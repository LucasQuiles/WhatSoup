/**
 * Unknown-terminal ARMS provider fallback (Lane 2 — unknown-terminal fallback net).
 *
 * CONFIRMED DEFECT: an UNCLASSIFIED terminal provider failure
 * (classifyProviderFailure→null AND event.isError===true) reaches the
 * default-deny "unknown-terminal" branch, which historically only emitted a
 * generic notice + ops alert and armed NO fallback. A live bot with a healthy,
 * eligible fallback idle would stall on the broken primary turn after turn.
 *
 * The fix (runtime.ts maybeArmFallbackAfterUnknownTerminal) arms the fallback
 * deterministically after UNKNOWN_TERMINAL_FALLBACK_THRESHOLD (=2) consecutive
 * unknown-terminal USER turns, replacing the generic notice on the arming turn
 * with a fallback activation (reason 'unknown-terminal-repeated'). Below
 * threshold, or with no eligible fallback, today's behavior (generic notice +
 * alert) is unchanged.
 *
 * Mirrors the harness in fallback-empty-output-arms.test.ts.
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
  (globalThis as Record<string, unknown>)['__unknownTerminalArmsTestConfig__'] = config;
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
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__unknownTerminalArmsTestConfig__'] as Record<string, unknown>;
}

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
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
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

function makeFakeQueue() {
  return {
    targetChatJid: 'fake@s.whatsapp.net',
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

function makeEventSession() {
  return {
    clearTurnWatchdog: vi.fn(),
    completeProviderTurn: vi.fn(),
    getDbRowId: vi.fn(() => null),
    getProviderId: vi.fn(() => 'claude-cli'),
    getStatus: vi.fn(() => ({ active: true })),
    shutdown: vi.fn(async () => {}),
    tickWatchdog: vi.fn(),
    trackToolStart: vi.fn(),
    trackToolEnd: vi.fn(),
  };
}

type RuntimeView = {
  consecutiveUnknownTerminalTurns: number;
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
  // Single/shared (global) driving surface.
  queue: unknown;
  session: unknown;
  sessionEventToolScopes: WeakMap<object, string>;
  managerIdFor(session: object): string;
  publishLegacyProviderTurn(session: object, scopeKey: string, routeChatJid: string): unknown;
  handleEvent(sourceSession: object, event: unknown): void;
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

// An is_error result whose text classifyProviderFailure() cannot classify — the
// exact default-deny "unknown-terminal" shape.
const UNKNOWN_TEXT = 'the agent glorp fizzled unexpectedly';
// An is_error result that classifies as transient-network (peeled off BEFORE the
// unknown-terminal branch) — used to prove it never feeds the counter.
const TRANSIENT_TEXT = 'socket hang up';

const FALLBACK = { agentFallbackProvider: 'opencode-cli', agentFallbackModel: 'minimax/minimax-m2' };

/** Drive one unknown-terminal (unclassified is_error) per-chat turn. */
function driveUnknown(runtime: AgentRuntime, queue: ReturnType<typeof makeFakeQueue>, seq: number) {
  v(runtime).handleEventWithContext({ type: 'result', text: UNKNOWN_TEXT, isError: true }, queue, null, 'conv', seq, 'mapkey');
}

/** Drive one successful per-chat turn. */
function driveSuccess(runtime: AgentRuntime, queue: ReturnType<typeof makeFakeQueue>, seq: number) {
  v(runtime).handleEventWithContext({ type: 'result', text: 'a real reply', isError: false }, queue, null, 'conv', seq, 'mapkey');
}

/** Drive one transient-network is_error per-chat turn. */
function driveTransient(runtime: AgentRuntime, queue: ReturnType<typeof makeFakeQueue>, seq: number) {
  v(runtime).handleEventWithContext({ type: 'result', text: TRANSIENT_TEXT, isError: true }, queue, null, 'conv', seq, 'mapkey');
}

/** Drive an unknown-terminal turn as the synthetic control/repair session. */
function driveControlUnknown(runtime: AgentRuntime, queue: ReturnType<typeof makeFakeQueue>, seq: number) {
  v(runtime).handleEventWithContext(
    { type: 'result', text: UNKNOWN_TEXT, isError: true },
    queue,
    null,
    'control@heal.internal',
    seq,
    'control@heal.internal',
  );
}

/** Drive an unknown-terminal turn as a SYSTEM result (isSystemResult=true). */
function driveSystemUnknown(runtime: AgentRuntime, queue: ReturnType<typeof makeFakeQueue>, seq: number) {
  v(runtime).handleEventWithContext(
    { type: 'result', text: UNKNOWN_TEXT, isError: true },
    queue,
    null,
    'conv',
    seq,
    'mapkey',
    'mapkey',
    true,
  );
}

const UNKNOWN_NOTICE_FRAGMENT = 'automatic recovery failed';
const ACTIVATION_FRAGMENT = 'Switching to OpenCode / minimax/minimax-m2';

function fallbackActivatedAlerts(): Array<[string, string, string, string, string?]> {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === 'provider_fallback_activated') as Array<
    [string, string, string, string, string?]
  >;
}

function enqueuedTexts(queue: ReturnType<typeof makeFakeQueue>): string[] {
  return queue.enqueueText.mock.calls.map((c) => String(c[0]));
}

describe('unknown-terminal arms provider fallback (per-chat)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T01:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('arms after 2 consecutive unknown-terminal user turns; replaces the generic notice with a fallback activation', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    // First unknown-terminal: below threshold — must NOT arm; generic notice fires.
    driveUnknown(runtime, queue, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(1);
    expect(enqueuedTexts(queue).some((t) => t.includes(UNKNOWN_NOTICE_FRAGMENT))).toBe(true);

    // Second unknown-terminal: reaches threshold — arms the fallback.
    queue.enqueueText.mockClear();
    driveUnknown(runtime, queue, 2);

    const state = runtime.getFallbackState();
    expect(state.fallbackActiveUntil).not.toBeNull();
    expect(state.fallbackReason).toBe('unknown-terminal-repeated');
    expect(state.effectiveProvider).toBe('opencode-cli');

    const activated = fallbackActivatedAlerts();
    expect(activated).toHaveLength(1);
    expect(activated[0][3]).toContain('reason=unknown-terminal-repeated');

    // The generic unknown-terminal notice is REPLACED by the activation notice.
    expect(enqueuedTexts(queue).some((t) => t.includes(UNKNOWN_NOTICE_FRAGMENT))).toBe(false);
    expect(enqueuedTexts(queue).some((t) => t.includes(ACTIVATION_FRAGMENT))).toBe(true);

    // Counter resets once armed.
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(0);
  });

  it('does NOT re-arm once a window is active — the active-window guard short-circuits before the counter (invariant c)', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    driveUnknown(runtime, queue, 1);
    driveUnknown(runtime, queue, 2); // arms
    const armedUntil = runtime.getFallbackState().fallbackActiveUntil;
    expect(armedUntil).not.toBeNull();
    expect(fallbackActivatedAlerts()).toHaveLength(1);
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(0);

    // A further unknown-terminal turn WHILE the window is active must not
    // re-arm, re-activate, or advance the counter (no infinite arm loop).
    driveUnknown(runtime, queue, 3);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBe(armedUntil);
    expect(fallbackActivatedAlerts()).toHaveLength(1);
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(0);
  });

  it('does NOT arm on a single unknown-terminal turn (below threshold); keeps the generic notice', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    driveUnknown(runtime, queue, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('claude-cli');
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(1);
    expect(enqueuedTexts(queue).some((t) => t.includes(UNKNOWN_NOTICE_FRAGMENT))).toBe(true);
  });

  it('does NOT arm when no fallback is configured — generic notice on every turn, no throw', () => {
    const runtime = makeRuntime({}); // no fallback provider
    const queue = makeFakeQueue();

    expect(() => {
      driveUnknown(runtime, queue, 1);
      driveUnknown(runtime, queue, 2);
      driveUnknown(runtime, queue, 3);
    }).not.toThrow();
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    // The counter never advances without a configured fallback (invariant b).
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(0);
    // Every unknown-terminal turn still surfaces the generic notice.
    expect(enqueuedTexts(queue).filter((t) => t.includes(UNKNOWN_NOTICE_FRAGMENT)).length).toBe(3);
  });

  it('a transient-network is_error turn does NOT feed the unknown-terminal counter (invariant a)', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    driveUnknown(runtime, queue, 1);
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(1);

    // Transient network drop is peeled off before the unknown-terminal branch —
    // it must neither increment nor reset the consecutive-unknown counter, and
    // must NOT arm a fallback.
    driveTransient(runtime, queue, 2);
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
  });

  it('a successful turn between unknown-terminal turns resets the counter (invariant e)', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    driveUnknown(runtime, queue, 1);
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(1);

    driveSuccess(runtime, queue, 2); // reset
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(0);

    // A single unknown-terminal after the reset must NOT arm (count back at 1).
    driveUnknown(runtime, queue, 3);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(1);
  });

  it('control/heal-session unknown-terminal turns do NOT feed the counter or arm (invariant d)', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    // Three control/repair unknown-terminal turns — well past threshold — must
    // NOT increment the shared counter and must NOT arm a fallback.
    driveControlUnknown(runtime, queue, 1);
    driveControlUnknown(runtime, queue, 2);
    driveControlUnknown(runtime, queue, 3);
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(0);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
  });

  it('system-turn unknown-terminal results do NOT feed the counter or arm (invariant d)', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    driveSystemUnknown(runtime, queue, 1);
    driveSystemUnknown(runtime, queue, 2);
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(0);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
  });
});

describe('unknown-terminal arms provider fallback (single/shared path)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T01:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function driveGlobalUnknown(runtime: AgentRuntime, queue: ReturnType<typeof makeFakeQueue>, session: object) {
    const state = v(runtime);
    state.queue = queue;
    state.session = session;
    state.managerIdFor(session);
    state.sessionEventToolScopes.set(session, '__global__');
    state.publishLegacyProviderTurn(session, '__global__', queue.targetChatJid);
    state.handleEvent(session, { type: 'result', text: UNKNOWN_TEXT, isError: true });
  }

  it('arms after 2 consecutive unknown-terminal turns on the single/shared path', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();
    const session = makeEventSession();

    driveGlobalUnknown(runtime, queue, session);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(1);

    queue.enqueueText.mockClear();
    driveGlobalUnknown(runtime, queue, session);

    const state = runtime.getFallbackState();
    expect(state.fallbackActiveUntil).not.toBeNull();
    expect(state.fallbackReason).toBe('unknown-terminal-repeated');
    expect(state.effectiveProvider).toBe('opencode-cli');
    expect(enqueuedTexts(queue).some((t) => t.includes(UNKNOWN_NOTICE_FRAGMENT))).toBe(false);
    expect(v(runtime).consecutiveUnknownTerminalTurns).toBe(0);
    // No replay was scheduled (no pending replay text), so the errored primary
    // session is torn down — mirroring the sibling terminal branches (divergent
    // from the empty-output path, which never shuts down).
    expect(session.shutdown).toHaveBeenCalled();
  });

  it('a single below-threshold unknown-terminal turn enqueues ONLY the notice — no trailing "_(no response)_" (regression: single/shared double-send)', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();
    const session = makeEventSession();

    driveGlobalUnknown(runtime, queue, session);

    // Below threshold: fallback not armed; the generic notice is shown once.
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    const texts = enqueuedTexts(queue);
    expect(texts.some((t) => t.includes(UNKNOWN_NOTICE_FRAGMENT))).toBe(true);
    // CONFIRMED code-review defect: the single/shared finalizer's
    // '_(no response)_' guard fired AFTER the unknown-terminal notice because
    // the branch fell through instead of returning like every sibling terminal
    // branch (usage-limit/rate-limit/…). Two enqueued messages = the double-send.
    expect(texts.some((t) => t.includes('(no response)'))).toBe(false);
    expect(texts.length).toBe(1);
  });
});
