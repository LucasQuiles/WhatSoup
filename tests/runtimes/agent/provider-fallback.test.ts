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
