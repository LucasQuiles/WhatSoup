/**
 * Empty-output ARMS provider fallback (root-cause fix for the silent
 * auth-break degraded loop).
 *
 * A primary whose auth/session is broken (e.g. claude-cli after a silent CLI
 * auto-update invalidated its keychain login) exits cleanly with NO text on
 * every turn. There is no provider-failure MESSAGE to classify, so the normal
 * text-driven arming path never fires — historically the bot stayed pinned to
 * the dead primary, reported `status:degraded`, and looped on watchdog
 * restarts while the configured fallback ladder sat idle.
 *
 * The fix (runtime.ts maybeArmFallbackAfterEmptyPrimaryTurn) arms the fallback
 * deterministically on empty PRIMARY output:
 *   - immediately when the independent usability probe already flags the
 *     primary unusable, OR
 *   - after EMPTY_OUTPUT_FALLBACK_THRESHOLD (=2) consecutive empty primary
 *     turns.
 * Armed with the `auth-required` reason so fallback SELECTION skips
 * same-provider entries (a broken claude-cli login breaks every claude-cli
 * fallback too) and REVERT is gated on a fresh primary probe (self-heals on
 * owner re-login).
 *
 * Mirrors the harness in fallback-empty-turn.test.ts.
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
  (globalThis as Record<string, unknown>)['__emptyOutputArmsTestConfig__'] = config;
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
  return (globalThis as Record<string, unknown>)['__emptyOutputArmsTestConfig__'] as Record<string, unknown>;
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

type RuntimeView = {
  primaryModelUsability: unknown;
  consecutivePrimaryEmptyTurns: number;
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
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

/** Drive one completed primary turn through the per-chat handler. */
function driveTurn(runtime: AgentRuntime, queue: ReturnType<typeof makeFakeQueue>, text: string | null, seq: number) {
  v(runtime).handleEventWithContext({ type: 'result', text }, queue, null, 'conv', seq, 'mapkey');
}

/** A usability probe result that primaryModelUsabilityRequiresAlert() rejects
 *  (status unknown + binary-model-probe-failed) — the exact mini4 shape. */
const UNUSABLE_PROBE = {
  status: 'unknown',
  reason: 'binary-model-probe-failed',
  provider: 'claude-cli',
  model: 'claude-opus-4-8',
  checkedAt: 0,
  probeInFlight: false,
};

const FALLBACK = { agentFallbackProvider: 'opencode-cli', agentFallbackModel: 'minimax/minimax-m2' };

describe('empty-output arms provider fallback', () => {
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

  it('arms after EMPTY_OUTPUT_FALLBACK_THRESHOLD (=2) consecutive empty primary turns', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    // First empty: below threshold, no probe signal — must NOT arm yet.
    driveTurn(runtime, queue, null, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);

    // Second empty: reaches threshold — arms the fallback.
    driveTurn(runtime, queue, null, 2);
    const state = runtime.getFallbackState();
    expect(state.fallbackActiveUntil).not.toBeNull();
    expect(state.fallbackReason).toBe('auth-required');
    expect(state.effectiveProvider).toBe('opencode-cli');
    // Counter resets once armed.
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(0);
  });

  it('arms on the FIRST empty turn when the usability probe flags the primary unusable', () => {
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...UNUSABLE_PROBE };
    const queue = makeFakeQueue();

    driveTurn(runtime, queue, null, 1);
    const state = runtime.getFallbackState();
    expect(state.fallbackActiveUntil).not.toBeNull();
    expect(state.fallbackReason).toBe('auth-required');
    expect(state.effectiveProvider).toBe('opencode-cli');
  });

  it('does NOT arm on a single empty turn with no adverse probe signal', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    driveTurn(runtime, queue, null, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('claude-cli');
  });

  it('does NOT arm when no fallback is configured (and does not throw)', () => {
    const runtime = makeRuntime({}); // no fallback provider
    const queue = makeFakeQueue();

    expect(() => {
      driveTurn(runtime, queue, null, 1);
      driveTurn(runtime, queue, null, 2);
      driveTurn(runtime, queue, null, 3);
    }).not.toThrow();
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
  });

  it('resets the consecutive-empty counter on a successful turn', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    driveTurn(runtime, queue, null, 1); // empty -> count 1
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);
    driveTurn(runtime, queue, 'a real reply', 2); // success -> reset
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(0);

    // A single empty after the reset must NOT arm (count is back at 1).
    driveTurn(runtime, queue, null, 3);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);
  });
});
