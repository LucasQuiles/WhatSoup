/**
 * Commit 6 — Characterization: fallback-provider usage-limit cascade.
 *
 * Scenario: a fallback window is already ACTIVE (arms at fake-time T via
 * activateProviderFallback(null)). After 1 hour the result handler receives a
 * usage-limit-shaped text ("Claude usage limit reached. Your limit will reset
 * at 3pm."). Expected outcomes:
 *
 *   - window is EXTENDED (re-saved activeUntil ≥ previous activeUntil)
 *   - effectiveProvider is STILL the fallback provider (not reverted)
 *   - the usage-limit notice text is enqueued to the user queue (re-queued again)
 *   - no unhandled throw
 *
 * This pins both-providers-limited behavior: when the fallback provider also
 * hits a usage limit, the runtime treats it as another extension rather than
 * reverting to an exhausted primary.
 *
 * Also documents: credential validity is probed asynchronously after the window
 * arms — see docs/configuration.md §"Provider fallback behavior" point 4.
 *
 * Harness mirrors fallback-reason-provenance.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fallbackStateDb from '../../../src/runtimes/agent/fallback-state-db.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────────

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
    agentFallbacks: undefined,
  };
  (globalThis as Record<string, unknown>)['__fallbackUsageLimitCascadeConfig__'] = config;
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

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: vi.fn(() => 'present-key'),
    resolveProviderKeyService: vi.fn((provider: unknown, model: unknown) => {
      if (provider === 'opencode-cli' && typeof model === 'string') return model.split('/')[0]?.trim().toLowerCase() || null;
      if (provider === 'openai-api') return 'openai';
      if (provider === 'anthropic-api') return 'anthropic';
      return null;
    }),
  };
});

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

// Unit tests must never spawn the real fallback binary; 'unknown' is the
// safe fail-open value (no alert, no version log).
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeBinaryAuthStatus: vi.fn(() => Promise.resolve({ status: 'unknown', raw: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlertChecked } from '../../../src/lib/emit-alert.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)[
    '__fallbackUsageLimitCascadeConfig__'
  ] as Record<string, unknown>;
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

function makeRuntime(agentFallbacks?: Array<{ provider: string; model?: string }>): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentFallbacks'] = agentFallbacks;
  config['agentFallbackProvider'] = agentFallbacks ? undefined : 'opencode-cli';
  config['agentFallbackModel'] = agentFallbacks ? undefined : 'minimax/minimax-m2';
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type CascadeView = {
  effectiveProvider: string;
  effectiveModel: string | undefined;
  fallbackChain: { failedKeys: Set<string> };
  fallbackWindow: { activeUntil: number | null };
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required',
  ): void;
  getFallbackState(): {
    activeFallbackEntry: { provider: string; model?: string } | null;
    fallbackChain: Array<{ provider: string; model?: string; eligible: boolean | null }>;
  };
  handleEventWithContext(
    event: unknown,
    queue: unknown,
    session: unknown,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
  ): void;
};

function cv(runtime: AgentRuntime): CascadeView {
  return runtime as unknown as CascadeView;
}

function makeFakeQueue(targetChatJid = 'user@s.whatsapp.net') {
  return {
    targetChatJid,
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

// Provider-agnostic usage-limit notice text (matches the runtime's detector).
const USAGE_LIMIT_TEXT = 'Claude usage limit reached. Your limit will reset at 3pm.';
const ANTHROPIC_LOW_CREDIT_TEXT = 'Insufficient credits for Anthropic API request.';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('fallback-provider usage-limit cascade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('window is extended (re-saved activeUntil >= previous) when fallback provider hits usage limit', () => {
    const saveSpy = vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});

    const runtime = makeRuntime();
    // Arm window at T=0.
    cv(runtime).activateProviderFallback(null);

    const initialUntil = cv(runtime).fallbackWindow.activeUntil as number;
    expect(initialUntil).toBeGreaterThan(0);

    // Advance 1 hour.
    vi.advanceTimersByTime(60 * 60 * 1000);

    const savesBeforeCascade = saveSpy.mock.calls.length;

    // Drive a usage-limit-shaped result from the fallback provider.
    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
      'conv-key',
      1,
      'mapkey-cascade',
    );

    // Window must have been extended: saveFallbackState called again with
    // a new activeUntil >= the initial one.
    const newSaves = saveSpy.mock.calls.slice(savesBeforeCascade);
    expect(newSaves.length).toBeGreaterThanOrEqual(1);
    const latestSave = newSaves[newSaves.length - 1];
    expect(latestSave?.[1].activeUntil).toBeGreaterThanOrEqual(initialUntil);
  });

  it('effectiveProvider is still the fallback provider after cascade (not reverted)', () => {
    const runtime = makeRuntime();
    cv(runtime).activateProviderFallback(null);

    vi.advanceTimersByTime(60 * 60 * 1000);

    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
      'conv-key',
      1,
      'mapkey-provider-check',
    );

    expect(cv(runtime).effectiveProvider).toBe('opencode-cli');
  });

  it('usage-limit notice is enqueued to the user queue on cascade', () => {
    const runtime = makeRuntime();
    cv(runtime).activateProviderFallback(null);

    vi.advanceTimersByTime(60 * 60 * 1000);

    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
      'conv-key',
      1,
      'mapkey-notice-check',
    );

    const allEnqueued = [
      ...queue.enqueueText.mock.calls.map((c: unknown[]) => c[0]),
      ...queue.enqueueResultText.mock.calls.map((c: unknown[]) => c[0]),
    ];
    expect(allEnqueued).toHaveLength(1);
    const notice = String(allEnqueued[0]);
    expect(notice).toContain('Primary model hit a usage/quota limit until about');
    expect(notice).toContain('Switching to OpenCode / minimax/minimax-m2.');
    expect(notice).toContain('Please resend your last message.');
  });

  it('does not throw when fallback provider hits usage limit during active fallback window', () => {
    const runtime = makeRuntime();
    cv(runtime).activateProviderFallback(null);

    vi.advanceTimersByTime(60 * 60 * 1000);

    const queue = makeFakeQueue();
    expect(() => {
      cv(runtime).handleEventWithContext(
        { type: 'result', text: USAGE_LIMIT_TEXT },
        queue,
        null,
        'conv-key',
        1,
        'mapkey-no-throw',
      );
    }).not.toThrow();
  });

  it('advances to the next eligible fallback when the active managed fallback hits a billing limit', () => {
    const runtime = makeRuntime([
      { provider: 'anthropic-api', model: 'claude-opus-4-8' },
      { provider: 'openai-api', model: 'gpt-5.5' },
    ]);
    cv(runtime).activateProviderFallback(null, 'auth-required');
    expect(cv(runtime).effectiveProvider).toBe('anthropic-api');
    vi.mocked(emitAlertChecked).mockClear();

    vi.advanceTimersByTime(60 * 60 * 1000);

    const queue = makeFakeQueue();
    const fallbackSession = {
      getStatus: vi.fn(() => ({
        active: true,
        pid: null,
        sessionId: 'anthropic-api-123',
        startedAt: new Date().toISOString(),
        messageCount: 1,
        lastMessageAt: new Date().toISOString(),
      })),
      getDbRowId: vi.fn(() => null),
      clearTurnWatchdog: vi.fn(),
      completeProviderTurn: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    cv(runtime).handleEventWithContext(
      { type: 'result', text: ANTHROPIC_LOW_CREDIT_TEXT },
      queue,
      fallbackSession,
      'conv-key',
      1,
      'mapkey-managed-fallback-billing',
    );

    expect(cv(runtime).effectiveProvider).toBe('openai-api');
    expect(fallbackSession.completeProviderTurn).toHaveBeenCalledOnce();
    expect(cv(runtime).effectiveModel).toBe('gpt-5.5');
    expect(cv(runtime).fallbackChain.failedKeys.has('anthropic-api\u0000claude-opus-4-8')).toBe(true);
    expect(emitAlertChecked).toHaveBeenCalledWith(
      'test',
      'fallback_provider_failed',
      'Active fallback provider failed during fallback window',
      expect.stringContaining('provider=anthropic-api model=claude-opus-4-8 reason=usage-limit'),
    );
    expect(cv(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'openai-api',
      model: 'gpt-5.5',
    });
    expect(cv(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'anthropic-api', model: 'claude-opus-4-8', eligible: false },
      { provider: 'openai-api', model: 'gpt-5.5', eligible: true },
    ]);
  });

  it('uses the session provider instead of session-id prefix when an OpenCode fallback fails', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'minimax/minimax-m2' },
      { provider: 'openai-api', model: 'gpt-5.5' },
    ]);
    cv(runtime).activateProviderFallback(null, 'auth-required');
    expect(cv(runtime).effectiveProvider).toBe('opencode-cli');
    vi.mocked(emitAlertChecked).mockClear();

    vi.advanceTimersByTime(60 * 60 * 1000);

    const queue = makeFakeQueue();
    const fallbackSession = {
      getProviderId: vi.fn(() => 'opencode-cli'),
      getStatus: vi.fn(() => ({
        active: true,
        pid: null,
        sessionId: 'raw-opencode-session-id',
        startedAt: new Date().toISOString(),
        messageCount: 1,
        lastMessageAt: new Date().toISOString(),
      })),
      getDbRowId: vi.fn(() => null),
      clearTurnWatchdog: vi.fn(),
      completeProviderTurn: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      fallbackSession,
      'conv-key',
      1,
      'mapkey-opencode-fallback-raw-session-id',
    );

    expect(cv(runtime).effectiveProvider).toBe('openai-api');
    expect(fallbackSession.completeProviderTurn).toHaveBeenCalledOnce();
    expect(cv(runtime).effectiveModel).toBe('gpt-5.5');
    expect(cv(runtime).fallbackChain.failedKeys.has('opencode-cli\u0000minimax/minimax-m2')).toBe(true);
    expect(emitAlertChecked).toHaveBeenCalledWith(
      'test',
      'fallback_provider_failed',
      'Active fallback provider failed during fallback window',
      expect.stringContaining('provider=opencode-cli model=minimax/minimax-m2 reason=usage-limit'),
    );
    expect(cv(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'opencode-cli', model: 'minimax/minimax-m2', eligible: false },
      { provider: 'openai-api', model: 'gpt-5.5', eligible: true },
    ]);
  });
});
