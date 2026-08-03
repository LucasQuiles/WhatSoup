/**
 * Admin override commands for provider fallback: forceFallback / disableFallback.
 *
 * Covers:
 *  - forceFallback sets the window EXACTLY (may shorten an active 5h window to 30m)
 *  - forceFallback clamps 48h -> clamped:true
 *  - forceFallback returns {ok:false} when no fallbackProvider is configured
 *  - disableFallback ends the window and is idempotent
 *  - forced window persists with reason 'admin-forced' (saveFallbackState spy)
 *
 * Harness mirrors provider-fallback.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fallbackStateDb from '../../../src/runtimes/agent/fallback-state-db.ts';

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
  (globalThis as Record<string, unknown>)['__fallbackAdminOverrideTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__fallbackAdminOverrideTestConfig__'] as Record<string, unknown>;
}

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

const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => null);
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

// Unit tests must never spawn the real fallback binary; 'unknown' is the
// safe fail-open value (no alert, no version log).
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ── constants mirrored from runtime (private) ─────────────────────────────────
const DEFAULT_FALLBACK_WINDOW_MS = 5 * 60 * 60 * 1000;
const MIN_FALLBACK_WINDOW_MS = 60 * 1000;
const MAX_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Bracket-access view of the private fallback state. */
type FallbackView = {
  fallbackWindow: { activeUntil: number | null };
  effectiveProvider: string;
  activateProviderFallback(resetAt: Date | null): void;
  deactivateProviderFallback(reason: string): void;
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

// ── forceFallback ─────────────────────────────────────────────────────────────

describe('AgentRuntime.forceFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue(null);
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'getFallbackState').mockReturnValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns {ok:false} when no fallback provider or chain is configured', () => {
    const runtime = makeRuntime();
    const result = runtime.forceFallback();
    expect(result).toEqual({ ok: false, reason: 'no fallback provider or chain configured for this instance' });
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
  });

  it('sets the window EXACTLY to the requested duration (30m)', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    const thirtyMin = 30 * 60_000;
    const result = runtime.forceFallback(thirtyMin);
    expect(result).toMatchObject({ ok: true, clamped: false });
    if (result.ok) {
      expect(result.activeUntil).toBe(Date.now() + thirtyMin);
    }
    expect(view(runtime).fallbackWindow.activeUntil).toBe(Date.now() + thirtyMin);
  });

  it('may SHORTEN an active 5h window down to 30m (operator intent wins)', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    // First arm a full 5h window via normal activation
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackWindow.activeUntil).toBe(Date.now() + DEFAULT_FALLBACK_WINDOW_MS);

    // Now force 30m -- must replace the 5h window
    const thirtyMin = 30 * 60_000;
    const result = runtime.forceFallback(thirtyMin);
    expect(result).toMatchObject({ ok: true, clamped: false });
    expect(view(runtime).fallbackWindow.activeUntil).toBe(Date.now() + thirtyMin);

    // Advance 31m -- window should have elapsed and been cleared
    vi.advanceTimersByTime(thirtyMin + 1);
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('uses DEFAULT_FALLBACK_WINDOW_MS when durationMs is omitted', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    const result = runtime.forceFallback();
    expect(result).toMatchObject({ ok: true, clamped: false });
    if (result.ok) {
      expect(result.activeUntil).toBe(Date.now() + DEFAULT_FALLBACK_WINDOW_MS);
    }
  });

  it('clamps 48h to MAX_FALLBACK_WINDOW_MS (24h) and sets clamped:true', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    const fortyEightHours = 48 * 60 * 60 * 1000;
    const result = runtime.forceFallback(fortyEightHours);
    expect(result).toMatchObject({ ok: true, clamped: true });
    if (result.ok) {
      expect(result.activeUntil).toBe(Date.now() + MAX_FALLBACK_WINDOW_MS);
    }
  });

  it('clamps a very short duration to MIN_FALLBACK_WINDOW_MS (1m) and sets clamped:true', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    const result = runtime.forceFallback(1); // 1ms << MIN
    expect(result).toMatchObject({ ok: true, clamped: true });
    if (result.ok) {
      expect(result.activeUntil).toBe(Date.now() + MIN_FALLBACK_WINDOW_MS);
    }
  });

  it('persists the window with reason "admin-forced"', () => {
    const saveSpy = vi.mocked(fallbackStateDb.saveFallbackState);
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    runtime.forceFallback(30 * 60_000);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'admin-forced' }),
    );
  });
});

// ── disableFallback ───────────────────────────────────────────────────────────

describe('AgentRuntime.disableFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue(null);
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'getFallbackState').mockReturnValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('ends an active window and reverts to primary provider', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(null);
    expect(view(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(view(runtime).effectiveProvider).toBe('opencode-cli');

    const result = runtime.disableFallback();
    expect(result).toEqual({ ok: true });
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
  });

  it('is idempotent when no window is active', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    // Should not throw
    const result = runtime.disableFallback();
    expect(result).toEqual({ ok: true });
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
  });

  it('is idempotent when called twice in a row', () => {
    const runtime = makeRuntime({ agentFallbackProvider: 'opencode-cli' });
    view(runtime).activateProviderFallback(null);
    runtime.disableFallback();
    expect(() => runtime.disableFallback()).not.toThrow();
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
  });

  it('also works when called without a fallbackProvider configured', () => {
    const runtime = makeRuntime();
    // No provider -- no window -- should still return ok:true without error
    const result = runtime.disableFallback();
    expect(result).toEqual({ ok: true });
  });
});
