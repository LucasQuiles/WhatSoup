/**
 * Automatic provider fallback (claude-cli → opencode-cli) on usage limit.
 *
 * Covers the pure reset-time parser plus the AgentRuntime fallback state
 * machine: activation only when a fallback provider is configured,
 * effectiveProvider/effectiveModel flipping during the window, auto-revert
 * after the window elapses, window extension (idempotent activation), and
 * cleanup on shutdown. The state machine fields/methods are private, so the
 * tests reach them through bracket access on the constructed runtime.
 *
 * Timers are driven with vi.useFakeTimers (mirrors budget.test.ts) so the
 * 5-hour default revert window is exercised without real wall-clock delay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fallbackStateDb from '../../../src/runtimes/agent/fallback-state-db.ts';

// ─── Mocks (declared before importing the runtime) ────────────────────────────

// Mutable config object — tests mutate fallback fields, then construct a runtime.
// The object is created inside the vi.mock factory (which is hoisted) and
// stashed on globalThis so the test body can mutate the same reference without
// the factory closing over a not-yet-initialized top-level variable.
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
  (globalThis as Record<string, unknown>)['__providerFallbackTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__providerFallbackTestConfig__'] as Record<string, unknown>;
}

// registerAllTools is a heavy import chain (MCP tools); a no-op satisfies the ctor.
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

// Mock the credential lookup so the key-presence guard is deterministic and
// independent of the host machine's real keychain (the live fleet machine
// genuinely holds deepseek/minimax keys, which would contaminate "absent"
// assertions). Tests drive lookupCredentialMock per-case.
const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => null);
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

// ─── Imports after mocks ──────────────────────────────────────────────────────

import {
  AgentRuntime,
  extractUsageLimitResetTime,
} from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  model?: string;
}

/** Construct a runtime after applying fallback config overrides. */
function makeRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = overrides.agentProvider ?? 'claude-cli';
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: overrides.model ?? 'claude-opus-4-8[1m]',
  });
}

/** Bracket-access view of the private fallback state machine. */
type FallbackView = {
  fallbackActiveUntil: number | null;
  revertTimer: ReturnType<typeof setTimeout> | null;
  effectiveProvider: string;
  effectiveModel: string | undefined;
  activateProviderFallback(resetAt: Date | null): void;
  deactivateProviderFallback(reason: string): void;
  fallbackKeyPresent(provider: string | undefined, model: string | undefined): boolean | null;
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

// ─── extractUsageLimitResetTime ───────────────────────────────────────────────

describe('extractUsageLimitResetTime', () => {
  const now = new Date('2026-06-10T10:00:00');

  it('parses a 12-hour clock time later today ("resets at 3pm")', () => {
    const out = extractUsageLimitResetTime('Usage limit reached. Resets at 3pm.', now);
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(15);
    expect(out!.getMinutes()).toBe(0);
    expect(out!.getDate()).toBe(now.getDate());
  });

  it('parses a 24-hour clock time ("available at 15:00")', () => {
    const out = extractUsageLimitResetTime('Claude will be available at 15:00.', now);
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(15);
    expect(out!.getMinutes()).toBe(0);
  });

  it('parses minutes and am/pm ("try again at 9:30am")', () => {
    const out = extractUsageLimitResetTime('Try again at 9:30am tomorrow.', now);
    // 9:30am is before 10:00 "now", so it rolls forward to tomorrow.
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(9);
    expect(out!.getMinutes()).toBe(30);
    expect(out!.getDate()).toBe(now.getDate() + 1);
  });

  it('rolls a past clock time forward to tomorrow ("resets at 8am" when now is 10am)', () => {
    const out = extractUsageLimitResetTime('Usage cap reached. Resets at 8am.', now);
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(8);
    expect(out!.getDate()).toBe(now.getDate() + 1);
  });

  it('parses a future Unix epoch (seconds)', () => {
    const future = Math.floor(now.getTime() / 1000) + 3600; // +1h
    const out = extractUsageLimitResetTime(`Resets at ${future}.`, now);
    expect(out).not.toBeNull();
    expect(out!.getTime()).toBe(future * 1000);
  });

  it('returns null for messages with no reset time', () => {
    expect(extractUsageLimitResetTime('You are out of extra usage.', now)).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(extractUsageLimitResetTime('', now)).toBeNull();
    expect(extractUsageLimitResetTime(undefined as unknown as string, now)).toBeNull();
  });

  it('returns null for a past epoch (already elapsed)', () => {
    const past = Math.floor(now.getTime() / 1000) - 3600;
    expect(extractUsageLimitResetTime(`old ${past}`, now)).toBeNull();
  });

  it('prefers an explicit clock cue over an incidental long number (no epoch hijack)', () => {
    // The 10-digit order number must NOT be parsed as an epoch and override
    // the explicit "resets at 2pm" clock cue.
    const out = extractUsageLimitResetTime(
      'Order #5551234567 — usage limit reached, resets at 2pm.',
      now,
    );
    expect(out).not.toBeNull();
    expect(out!.getHours()).toBe(14);
    expect(out!.getMinutes()).toBe(0);
    expect(out!.getDate()).toBe(now.getDate());
  });

  it('returns null for a bare long number with no reset cue', () => {
    // An incidental 10-digit quota figure is not a reset time.
    expect(
      extractUsageLimitResetTime('You have 5000000000 tokens of quota remaining.', now),
    ).toBeNull();
  });
});

// ─── Fallback state machine ───────────────────────────────────────────────────

describe('AgentRuntime — provider fallback state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT activate when no fallback provider is configured', () => {
    const runtime = makeRuntime();
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackActiveUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('activates and flips effectiveProvider/effectiveModel during the window', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).effectiveModel).toBe('claude-opus-4-8[1m]');

    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackActiveUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2.7');
  });

  it('uses the default 5h window when no reset time is given', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    const before = Date.now();
    view(runtime).activateProviderFallback(null);
    const until = view(runtime).fallbackActiveUntil!;
    expect(until - before).toBe(5 * 60 * 60 * 1000);
  });

  it('auto-reverts to the primary provider after the window elapses', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');

    // Advance past the 5h default window.
    vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 1);
    expect(view(runtime).fallbackActiveUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('clamps an immediate reset time to the minimum window', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    // resetAt in the past → clamped to now + MIN (1 minute).
    view(runtime).activateProviderFallback(new Date(Date.now() - 1000));
    const until = view(runtime).fallbackActiveUntil!;
    expect(until - Date.now()).toBe(60 * 1000);
  });

  it('clamps an absurdly distant reset time to the maximum window', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(new Date(Date.now() + 999 * 60 * 60 * 1000));
    const until = view(runtime).fallbackActiveUntil!;
    expect(until - Date.now()).toBe(24 * 60 * 60 * 1000);
  });

  it('extends the window to the later of the two on re-activation (idempotent)', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000)); // +1h
    const firstUntil = view(runtime).fallbackActiveUntil!;
    // A second activation with a shorter window must not shorten the active one.
    view(runtime).activateProviderFallback(new Date(Date.now() + 30 * 60 * 1000)); // +30m
    expect(view(runtime).fallbackActiveUntil).toBe(firstUntil);
    // A longer one extends it.
    view(runtime).activateProviderFallback(new Date(Date.now() + 3 * 60 * 60 * 1000)); // +3h
    expect(view(runtime).fallbackActiveUntil!).toBeGreaterThan(firstUntil);
  });

  it('deactivate clears state and timer immediately', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).revertTimer).not.toBeNull();
    view(runtime).deactivateProviderFallback('manual');
    expect(view(runtime).fallbackActiveUntil).toBeNull();
    expect(view(runtime).revertTimer).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('shutdown clears the revert timer and fallback window', async () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackActiveUntil).not.toBeNull();
    await runtime.shutdown();
    expect(view(runtime).fallbackActiveUntil).toBeNull();
    expect(view(runtime).revertTimer).toBeNull();
  });
});

// ─── Key-presence guard at activation (Change 2) ──────────────────────────────

describe('AgentRuntime — fallback key-presence guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a present key for opencode-cli/minimax (service from model prefix)', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    lookupCredentialMock.mockImplementation((svc) => (svc === 'minimax' ? 'mm-key' : null));
    const present = view(runtime).fallbackKeyPresent('opencode-cli', 'minimax/MiniMax-M2.7');
    expect(present).toBe(true);
    expect(lookupCredentialMock).toHaveBeenCalledWith('minimax');
  });

  it('reports an absent key for opencode-cli/minimax when the keyring has none', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    lookupCredentialMock.mockReturnValue(null);
    const present = view(runtime).fallbackKeyPresent('opencode-cli', 'minimax/MiniMax-M2.7');
    expect(present).toBe(false);
  });

  it('maps openai-api to the openai service', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'openai-api' });
    lookupCredentialMock.mockImplementation((svc) => (svc === 'openai' ? 'oa-key' : null));
    const present = view(runtime).fallbackKeyPresent('openai-api', 'gpt-5');
    expect(present).toBe(true);
    expect(lookupCredentialMock).toHaveBeenCalledWith('openai');
  });

  it('returns null (not-applicable) for native-auth CLI providers', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'claude-cli' });
    for (const p of ['claude-cli', 'codex-cli', 'gemini-cli', 'anthropic-api']) {
      expect(view(runtime).fallbackKeyPresent(p, undefined)).toBeNull();
    }
    expect(lookupCredentialMock).not.toHaveBeenCalled();
  });

  it('does NOT block activation when the fallback key is absent (warn-only)', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    lookupCredentialMock.mockReturnValue(null);
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackActiveUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
  });

  it('activates normally when the fallback key is present', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    lookupCredentialMock.mockImplementation((svc) => (svc === 'minimax' ? 'mm-key' : null));
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackActiveUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
  });
});

// ─── assistant_text vs result asymmetry (Change 4) ────────────────────────────

/** IOutboundQueue stub covering all members the usage-limit paths touch. */
function makeFakeQueue() {
  return {
    targetChatJid: 'fake@s.whatsapp.net',
    enqueueText: vi.fn(),
    enqueueResultText: vi.fn(),
    flush: vi.fn(async () => {}),
    getLastOpId: vi.fn(() => undefined),
    clearLastOpId: vi.fn(),
    indicateTyping: vi.fn(),
  };
}

type EventDriveView = {
  fallbackActiveUntil: number | null;
  handleEventWithContext(
    event: unknown,
    queue: unknown,
    session: unknown,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
  ): void;
};

function driveView(runtime: AgentRuntime): EventDriveView {
  return runtime as unknown as EventDriveView;
}

describe('AgentRuntime — usage-limit assistant_text/result asymmetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const USAGE_LIMIT_TEXT = 'Claude usage limit reached. Resets at 3pm.';

  it('does NOT activate fallback on a usage-limit assistant_text event', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'assistant_text', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(driveView(runtime).fallbackActiveUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('DOES activate fallback on a usage-limit result event (the deferred site)', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(driveView(runtime).fallbackActiveUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2.7');
  });

  it('assistant_text then result: fallback stays null until the result fires', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2.7',
    });
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'assistant_text', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(driveView(runtime).fallbackActiveUntil).toBeNull();
    driveView(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(driveView(runtime).fallbackActiveUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
  });
});

// ─── Usage-limit user notice (Change 5) ──────────────────────────────────────

describe('usage-limit user notice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const USAGE_LIMIT_TEXT = 'Claude usage limit reached. Your limit will reset at 3pm.';

  it('enqueues a switch notice when a fallback provider is configured (per-chat path)', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('switching to a backup model'),
    );
  });

  it('enqueues a plain limit notice when no fallback is configured', () => {
    const runtime = makeRuntime({});
    const queue = makeFakeQueue();
    driveView(runtime).handleEventWithContext(
      { type: 'result', text: USAGE_LIMIT_TEXT },
      queue,
      null,
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('try again after the limit resets'),
    );
  });

  it('enqueues the notice on the single/shared path too', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });
    const queue = makeFakeQueue();
    (runtime as unknown as { queue: unknown }).queue = queue;
    (runtime as unknown as { handleEvent(e: unknown): void }).handleEvent(
      { type: 'result', text: USAGE_LIMIT_TEXT },
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('switching to a backup model'),
    );
  });
});

// ─── Persistence hooks (Work item 2) ─────────────────────────────────────────

type PersistenceView = {
  fallbackActiveUntil: number | null;
  effectiveProvider: string;
  activateProviderFallback(resetAt: Date | null): void;
  deactivateProviderFallback(reason: string): void;
  restorePersistedFallbackWindow(): void;
};

function persistView(runtime: AgentRuntime): PersistenceView {
  return runtime as unknown as PersistenceView;
}

describe('AgentRuntime — fallback persistence hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('persists the window on activation and clears it on deactivation', () => {
    // Finding 3: ensureFallbackStateSchema spy removed — not called by this path.
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    persistView(runtime).activateProviderFallback(null);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'usage-limit' }),
    );

    persistView(runtime).deactivateProviderFallback('test');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('restores a persisted future window, preserves original activatedAt, and auto-reverts', () => {
    // Finding 2: verify that armFallbackWindow re-saves with the original activatedAt
    // (not Date.now()) so the persisted record retains provenance across restarts.
    const now = Date.now();
    const activeUntil = now + 60 * 60_000;
    const originalActivatedAt = now - 1000;
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue({
      activeUntil,
      activatedAt: originalActivatedAt,
      reason: 'usage-limit',
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    persistView(runtime).restorePersistedFallbackWindow();
    expect(persistView(runtime).effectiveProvider).toBe('opencode-cli');

    // The re-save must carry the original activatedAt, not a fresh Date.now().
    expect(saveSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        activatedAt: originalActivatedAt,
        reason: 'restored',
      }),
    );

    vi.advanceTimersByTime(61 * 60_000);
    expect(persistView(runtime).effectiveProvider).toBe('claude-cli');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('discards a stale persisted window (past expiry) without re-arming', () => {
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue({
      activeUntil: now - 1000,
      activatedAt: now - 10_000,
      reason: 'usage-limit',
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    persistView(runtime).restorePersistedFallbackWindow();
    expect(persistView(runtime).effectiveProvider).toBe('claude-cli');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('discards a persisted window when no fallback provider is configured', () => {
    // Finding 1: covers the branch where agentFallbackProvider is undefined at restart —
    // the stale row must be cleared and the runtime must remain on the primary.
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'usage-limit',
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    // No agentFallbackProvider configured.
    const runtime = makeRuntime({});

    persistView(runtime).restorePersistedFallbackWindow();
    expect(persistView(runtime).effectiveProvider).toBe('claude-cli');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('a throwing loadFallbackState never crashes restore', () => {
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockImplementation(() => {
      throw new Error('db exploded');
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    expect(() => persistView(runtime).restorePersistedFallbackWindow()).not.toThrow();
    expect(persistView(runtime).effectiveProvider).toBe('claude-cli');
  });
});
