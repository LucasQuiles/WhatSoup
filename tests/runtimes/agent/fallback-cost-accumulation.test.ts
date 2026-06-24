/**
 * Provider-reported turn cost accumulation during fallback windows.
 *
 * result events may carry costUsd (opencode-only today, parser-validated
 * finite ≥ 0). The value used to be parsed and then dropped — zero consumers.
 * These tests pin the wiring (cost-pipeline principle: expensive paths must
 * be countable report fields, never just logs):
 *   - a finite costUsd on a result event accumulates into the process-local
 *     fallbackWindowCostUsd while a fallback window is active — on BOTH the
 *     per-chat (handleEventWithContext) and single/shared (handleEvent) paths
 *   - cost on the primary provider (no active window) is logged but NOT
 *     accumulated — the field answers "what did fallback serving cost"
 *   - non-finite and non-numeric costUsd values are ignored
 *   - the accumulator is a lifetime-of-process total (mirrors
 *     fallbackTurnsServed): deactivation does not reset it
 *   - getFallbackState surfaces it additively as fallbackWindowCostUsd
 *
 * Harness mirrors fallback-empty-turn.test.ts (same handlers, same mocks).
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
  (globalThis as Record<string, unknown>)['__costAccumulationTestConfig__'] = config;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__costAccumulationTestConfig__'] as Record<string, unknown>;
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

function makeRuntime(): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentFallbackProvider'] = 'opencode-cli';
  config['agentFallbackModel'] = 'minimax/minimax-m2';
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
  fallbackWindow: { activeUntil: number | null };
  queue: unknown;
  turnHadVisibleOutput: boolean;
  activateProviderFallback(resetAt: Date | null): void;
  deactivateProviderFallback(reason: string): void;
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
  getFallbackState(): { fallbackWindowCostUsd: number };
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

function emitResultPerChat(runtime: AgentRuntime, event: Record<string, unknown>): void {
  v(runtime).handleEventWithContext(event, makeFakeQueue(), null, 'conv', 1, 'mapkey');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('fallback window cost accumulation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts at zero and surfaces additively in getFallbackState', () => {
    const runtime = makeRuntime();
    expect(v(runtime).getFallbackState().fallbackWindowCostUsd).toBe(0);
  });

  it('per-chat path: accumulates finite costUsd while the window is active', () => {
    const runtime = makeRuntime();
    v(runtime).activateProviderFallback(null);

    emitResultPerChat(runtime, { type: 'result', text: 'reply one', costUsd: 0.0006, inputTokens: 10, outputTokens: 20 });
    emitResultPerChat(runtime, { type: 'result', text: 'reply two', costUsd: 0.0004 });

    expect(v(runtime).getFallbackState().fallbackWindowCostUsd).toBeCloseTo(0.001, 10);
  });

  it('single/shared path: accumulates finite costUsd while the window is active', () => {
    const runtime = makeRuntime();
    v(runtime).activateProviderFallback(null);
    v(runtime).queue = makeFakeQueue();
    v(runtime).turnHadVisibleOutput = true;

    v(runtime).handleEvent({ type: 'result', text: 'reply', costUsd: 0.0021 });

    expect(v(runtime).getFallbackState().fallbackWindowCostUsd).toBeCloseTo(0.0021, 10);
  });

  it('does NOT accumulate when no fallback window is active (primary serving)', () => {
    const runtime = makeRuntime();

    emitResultPerChat(runtime, { type: 'result', text: 'reply', costUsd: 0.5 });

    expect(v(runtime).getFallbackState().fallbackWindowCostUsd).toBe(0);
  });

  it('ignores non-finite and non-numeric costUsd values', () => {
    const runtime = makeRuntime();
    v(runtime).activateProviderFallback(null);

    emitResultPerChat(runtime, { type: 'result', text: 'a', costUsd: Number.NaN });
    emitResultPerChat(runtime, { type: 'result', text: 'b', costUsd: Number.POSITIVE_INFINITY });
    emitResultPerChat(runtime, { type: 'result', text: 'c', costUsd: 'free' });
    emitResultPerChat(runtime, { type: 'result', text: 'd' });

    expect(v(runtime).getFallbackState().fallbackWindowCostUsd).toBe(0);
  });

  it('zero is a valid cost (uncatalogued custom providers report 0)', () => {
    const runtime = makeRuntime();
    v(runtime).activateProviderFallback(null);

    emitResultPerChat(runtime, { type: 'result', text: 'reply', costUsd: 0 });

    expect(v(runtime).getFallbackState().fallbackWindowCostUsd).toBe(0);
  });

  it('is a lifetime-of-process total: deactivation does not reset it (mirrors fallbackTurnsServed)', () => {
    const runtime = makeRuntime();
    v(runtime).activateProviderFallback(null);
    emitResultPerChat(runtime, { type: 'result', text: 'reply', costUsd: 0.003 });
    v(runtime).deactivateProviderFallback('admin-disabled');

    expect(v(runtime).getFallbackState().fallbackWindowCostUsd).toBeCloseTo(0.003, 10);

    // Cost on the primary between windows still does not accumulate.
    emitResultPerChat(runtime, { type: 'result', text: 'reply', costUsd: 0.7 });
    expect(v(runtime).getFallbackState().fallbackWindowCostUsd).toBeCloseTo(0.003, 10);

    // A second window keeps accumulating on top.
    v(runtime).activateProviderFallback(null);
    emitResultPerChat(runtime, { type: 'result', text: 'reply', costUsd: 0.002 });
    expect(v(runtime).getFallbackState().fallbackWindowCostUsd).toBeCloseTo(0.005, 10);
  });
});
