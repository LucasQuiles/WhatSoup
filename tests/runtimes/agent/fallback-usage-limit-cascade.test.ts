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
 * Notice ETA provenance is pinned at the production notifier
 * (notifyProviderFallbackActivated via handleEventWithContext): only a reset
 * from a failure attributed to the PRIMARY yields "until about <time>"; an
 * unknown reset, the fallback-window end, a fallback entry's parsed reset, or
 * a reset from a session whose route attribution fails closed never does.
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
    emitObservationChecked: vi.fn(() => true),
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    // #2192 s4b: provider-fallback tunables live on config (defaults mirror the retired IIFEs).
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-usage-limit-cascade/tmp',
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
import { formatClockForUser } from '../../../src/runtimes/agent/runtime-presentation.ts';
import { extractUsageLimitResetTime } from '../../../src/runtimes/agent/usage-limit-reset-time.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)[
    '__fallbackUsageLimitCascadeConfig__'
  ] as Record<string, unknown>;
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

/**
 * `primaryModel: null` builds a provider-default primary (no configured model).
 * It is null, not undefined, because an explicit undefined would take the default.
 */
function makeRuntime(
  agentFallbacks?: Array<{ provider: string; model?: string }>,
  primaryModel: string | null = 'claude-opus-4-8[1m]',
): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentFallbacks'] = agentFallbacks;
  config['agentFallbackProvider'] = agentFallbacks ? undefined : 'opencode-cli';
  config['agentFallbackModel'] = agentFallbacks ? undefined : 'minimax/minimax-m2';
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', primaryModel === null ? {} : {
    model: primaryModel,
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

function enqueuedNotices(queue: ReturnType<typeof makeFakeQueue>): string[] {
  return [
    ...queue.enqueueText.mock.calls.map((c: unknown[]) => String(c[0])),
    ...queue.enqueueResultText.mock.calls.map((c: unknown[]) => String(c[0])),
  ];
}

/** The reset the handler parses from `text` at the current (fake) clock. */
function parsedResetMs(text: string): number {
  const reset = extractUsageLimitResetTime(text);
  if (reset === null) throw new Error(`fixture carries no parseable reset: ${text}`);
  return reset.getTime();
}

// Provider-agnostic usage-limit notice text (matches the runtime's detector).
// "reset at 3pm" IS machine-readable: extractUsageLimitResetTime parses it.
const USAGE_LIMIT_TEXT = 'Claude usage limit reached. Your limit will reset at 3pm.';
const USAGE_LIMIT_NO_RESET_TEXT = 'Claude usage limit reached.';
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

  it('usage-limit notice shows the known primary reset as its ETA', () => {
    const runtime = makeRuntime();
    cv(runtime).activateProviderFallback(null);

    vi.advanceTimersByTime(60 * 60 * 1000);
    const primaryResetMs = parsedResetMs(USAGE_LIMIT_TEXT);

    // A null session is attributed to the PRIMARY tier, so the parsed reset is
    // the primary's own and must reach the notice.
    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
      'conv-key',
      1,
      'mapkey-notice-check',
    );

    const notices = enqueuedNotices(queue);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      `Primary model hit a usage/quota limit until about ${formatClockForUser(primaryResetMs)}.`,
    );
    expect(notices[0]).toContain('Switching to OpenCode / minimax/minimax-m2.');
    expect(notices[0]).toContain('Please resend your last message.');
  });

  it('usage-limit notice states no ETA when the primary reset is unknown, and never the window end', () => {
    const runtime = makeRuntime();
    cv(runtime).activateProviderFallback(null);

    vi.advanceTimersByTime(60 * 60 * 1000);

    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_NO_RESET_TEXT },
      queue,
      null,
      'conv-key',
      1,
      'mapkey-notice-unknown-reset',
    );

    const activeUntil = cv(runtime).fallbackWindow.activeUntil;
    expect(activeUntil).not.toBeNull();
    const notices = enqueuedNotices(queue);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Primary model hit a usage/quota limit.');
    expect(notices[0]).not.toContain('until about');
    // The fallback window is still armed, yet its end must not pose as a quota expiry.
    expect(notices[0]).not.toContain(formatClockForUser(activeUntil as number));
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

  it('a fallback-tier usage-limit with a parsed reset gives the notice no primary ETA', () => {
    const runtime = makeRuntime([
      { provider: 'opencode-cli', model: 'minimax/minimax-m2' },
      { provider: 'openai-api', model: 'gpt-5.5' },
    ]);
    cv(runtime).activateProviderFallback(null, 'auth-required');
    expect(cv(runtime).effectiveProvider).toBe('opencode-cli');

    vi.advanceTimersByTime(60 * 60 * 1000);
    // The reset parsed from the FALLBACK entry's message describes that
    // entry's quota, not the primary's.
    const fallbackResetMs = parsedResetMs(USAGE_LIMIT_TEXT);

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
      'mapkey-fallback-tier-reset',
    );

    // Fallback-tier attribution held: the chain advanced past the failing entry.
    expect(cv(runtime).effectiveProvider).toBe('openai-api');
    const notices = enqueuedNotices(queue);
    expect(notices.filter((n) => n.includes('Primary model hit a usage/quota limit.'))).toHaveLength(1);
    for (const notice of notices) {
      expect(notice).not.toContain('until about');
      expect(notice).not.toContain(formatClockForUser(fallbackResetMs));
    }
  });

  // A wildcard (model-undefined) entry on the primary's own provider matches
  // every claude-cli session, so each such session also matches the primary
  // route; only the exact configured primary model resolves it to the primary.
  const WILDCARD_SAME_PROVIDER_CHAIN = [{ provider: 'claude-cli' }];
  // A same-provider entry that names its model: a window route on it carries
  // that model, so it never starts an undefined-model session.
  const NAMED_SAME_PROVIDER_CHAIN = [{ provider: 'claude-cli', model: 'claude-haiku-4-5' }];

  /** Session double; only the provider and the model ref vary. */
  function providerSession(modelRef: string | undefined, provider = 'claude-cli') {
    return new Proxy(
      {
        getProviderId: vi.fn(() => provider),
        getModelRef: vi.fn(() => modelRef),
        getStatus: vi.fn(() => ({
          active: true,
          pid: null,
          sessionId: `${provider}-1`,
          startedAt: new Date().toISOString(),
          messageCount: 1,
          lastMessageAt: new Date().toISOString(),
        })),
        getDbRowId: vi.fn(() => null),
        clearTurnWatchdog: vi.fn(),
        completeProviderTurn: vi.fn(),
        shutdown: vi.fn(async () => {}),
      } as Record<string, unknown>,
      { get: (t, p) => (p in t ? t[p as string] : () => undefined) },
    );
  }

  it('an ambiguous same-provider failure with no window state arms a window but gives the notice no time', () => {
    const runtime = makeRuntime(WILDCARD_SAME_PROVIDER_CHAIN);
    expect(cv(runtime).fallbackWindow.activeUntil).toBeNull();
    // A provider-default session (undefined model ref), for example one the
    // wildcard entry started during an earlier window, cannot be told apart
    // from the primary, so its parsed reset is not proven to be the primary's.
    const resetMs = parsedResetMs(USAGE_LIMIT_TEXT);

    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      providerSession(undefined),
      'conv-key',
      1,
      'mapkey-ambiguous-no-window',
    );

    // Failover still works: the failure armed a fresh window and the notice
    // names the switch (not the credentials-missing template).
    expect(cv(runtime).fallbackWindow.activeUntil).not.toBeNull();
    const notices = enqueuedNotices(queue);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Primary model hit a usage/quota limit');
    expect(notices[0]).toContain('Switching to');
    expect(notices[0]).not.toContain('until about');
    expect(notices[0]).not.toContain(formatClockForUser(resetMs));
  });

  it('a same-provider failure proven primary by the exact configured model still shows its reset as the time', () => {
    const runtime = makeRuntime(WILDCARD_SAME_PROVIDER_CHAIN);
    expect(cv(runtime).fallbackWindow.activeUntil).toBeNull();
    const resetMs = parsedResetMs(USAGE_LIMIT_TEXT);

    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      providerSession('claude-opus-4-8[1m]'),
      'conv-key',
      1,
      'mapkey-proven-primary-no-window',
    );

    expect(cv(runtime).fallbackWindow.activeUntil).not.toBeNull();
    const notices = enqueuedNotices(queue);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      `Primary model hit a usage/quota limit until about ${formatClockForUser(resetMs)}.`,
    );
  });

  it('a provider-default primary keeps its reset as the time when every same-provider entry names a model', () => {
    const runtime = makeRuntime(NAMED_SAME_PROVIDER_CHAIN, null);
    expect(cv(runtime).fallbackWindow.activeUntil).toBeNull();
    // With no configured primary model, primary routes start undefined-model
    // sessions, and a window route on the named entry carries that entry's
    // model, so an undefined-model session on this provider is the primary's.
    const resetMs = parsedResetMs(USAGE_LIMIT_TEXT);

    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      providerSession(undefined),
      'conv-key',
      1,
      'mapkey-default-primary-named-entry',
    );

    expect(cv(runtime).fallbackWindow.activeUntil).not.toBeNull();
    const notices = enqueuedNotices(queue);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Switching to');
    expect(notices[0]).toContain(
      `Primary model hit a usage/quota limit until about ${formatClockForUser(resetMs)}.`,
    );
  });

  it('a provider-default primary beside a wildcard same-provider entry gives the notice no time', () => {
    const runtime = makeRuntime(WILDCARD_SAME_PROVIDER_CHAIN, null);
    expect(cv(runtime).fallbackWindow.activeUntil).toBeNull();
    // A window route on the wildcard entry also starts undefined-model
    // sessions, so this session may be the entry's: attribution fails closed.
    const resetMs = parsedResetMs(USAGE_LIMIT_TEXT);

    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      providerSession(undefined),
      'conv-key',
      1,
      'mapkey-default-primary-wildcard-entry',
    );

    expect(cv(runtime).fallbackWindow.activeUntil).not.toBeNull();
    const notices = enqueuedNotices(queue);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Primary model hit a usage/quota limit');
    expect(notices[0]).toContain('Switching to');
    expect(notices[0]).not.toContain('until about');
    expect(notices[0]).not.toContain(formatClockForUser(resetMs));
  });

  it('a foreign-provider failure with no window state gives the notice no time', () => {
    const runtime = makeRuntime(NAMED_SAME_PROVIDER_CHAIN, null);
    expect(cv(runtime).fallbackWindow.activeUntil).toBeNull();
    // A session on a provider that is neither the primary's nor in the chain
    // (for example a chat pinned to it) matches neither route, so its reset is
    // not the primary's, even with a provider-default primary.
    const resetMs = parsedResetMs(USAGE_LIMIT_TEXT);

    const queue = makeFakeQueue();
    cv(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      providerSession(undefined, 'codex-cli'),
      'conv-key',
      1,
      'mapkey-foreign-provider-no-window',
    );

    expect(cv(runtime).fallbackWindow.activeUntil).not.toBeNull();
    const notices = enqueuedNotices(queue);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Primary model hit a usage/quota limit');
    expect(notices[0]).toContain('Switching to');
    expect(notices[0]).not.toContain('until about');
    expect(notices[0]).not.toContain(formatClockForUser(resetMs));
  });
});
