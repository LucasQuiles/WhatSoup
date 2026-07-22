/**
 * Pre-flight validity check on armFallbackWindow.
 *
 * When the fallback window is armed (via activateProviderFallback,
 * restorePersistedFallbackWindow, or any future admin-force path that calls
 * armFallbackWindow), the runtime must:
 *
 *  - missing key → emitAlert source='fallback_credential_missing'; no fetch
 *  - invalid key  → emitAlert source='fallback_credential_invalid' (async, after probe)
 *  - unknown      → no credential alert (fail-open)
 *  - valid        → no credential alert
 *  - secrecy      → the key value itself never appears in any emitAlert argument
 *  - restore path → missing-key alert fires on restorePersistedFallbackWindow
 *
 * Pre-flight NEVER blocks or reverts the window — window is STILL active in
 * every case.
 *
 * Kept in a separate file from provider-fallback.test.ts to avoid tree-sitter
 * edit-fragment friction.
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
  (globalThis as Record<string, unknown>)['__credentialPreflightTestConfig__'] = config;
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

// Mutable credential mock — each test drives this independently.
const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => null);
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

// Mutable verifyFallbackCredential mock — tests control what the probe returns.
const verifyFallbackCredentialMock = vi.fn<
  (service: string, key: string) => Promise<'valid' | 'invalid' | 'unknown'>
>(() => Promise.resolve('unknown'));

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: (service: string, key: string) =>
    verifyFallbackCredentialMock(service, key),
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)[
    '__credentialPreflightTestConfig__'
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

interface RuntimeOverrides {
  agentProvider?: string;
  agentProviderConfig?: Record<string, unknown>;
  agentFallbackProvider?: string;
  agentFallbackModel?: string;
}

function makeRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = overrides.agentProvider ?? 'claude-cli';
  config['agentProviderConfig'] = overrides.agentProviderConfig;
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type FallbackView = {
  fallbackWindow: { activeUntil: number | null };
  effectiveProvider: string;
  activateProviderFallback(resetAt: Date | null): void;
  restorePersistedFallbackWindow(): void;
};

function fbView(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('armFallbackWindow — credential pre-flight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue(null);
    verifyFallbackCredentialMock.mockReset();
    verifyFallbackCredentialMock.mockResolvedValue('unknown');
    vi.mocked(emitAlert).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── missing key ─────────────────────────────────────────────────────────────

  it('emits fallback_credential_missing alert when key is absent', () => {
    lookupCredentialMock.mockReturnValue(null);
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_credential_missing',
      expect.any(String),
      expect.any(String),
    );
  });

  it('window is still active after missing-key alert', () => {
    lookupCredentialMock.mockReturnValue(null);
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    expect(fbView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(fbView(runtime).effectiveProvider).toBe('opencode-cli');
  });

  it('does NOT call verifyFallbackCredential when key is absent', () => {
    lookupCredentialMock.mockReturnValue(null);
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    expect(verifyFallbackCredentialMock).not.toHaveBeenCalled();
  });

  it('uses providerConfig.apiKeyService for same-provider API fallback pre-flight', () => {
    lookupCredentialMock.mockImplementation((service) => service === 'groq' ? 'groq-key' : null);
    const runtime = makeRuntime({
      agentProvider: 'openai-api',
      agentProviderConfig: { apiKeyService: 'groq' },
      agentFallbackProvider: 'openai-api',
      agentFallbackModel: 'gpt-4o-mini',
    });

    fbView(runtime).activateProviderFallback(null);

    expect(lookupCredentialMock).toHaveBeenCalledWith('groq');
    expect(lookupCredentialMock).not.toHaveBeenCalledWith('openai');
    expect(verifyFallbackCredentialMock).toHaveBeenCalledWith('groq', 'groq-key');
    expect(vi.mocked(emitAlert)).not.toHaveBeenCalledWith(
      'test',
      'fallback_credential_missing',
      expect.any(String),
      expect.any(String),
    );
  });

  // ── invalid key ─────────────────────────────────────────────────────────────

  it('emits fallback_credential_invalid alert when probe returns invalid', async () => {
    lookupCredentialMock.mockReturnValue('some-key');
    verifyFallbackCredentialMock.mockResolvedValue('invalid');

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    // Settle the async probe.
    await vi.waitFor(() => {
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_credential_invalid',
        expect.any(String),
        expect.any(String),
      );
    }, { interval: 0 });
  });

  it('window is still active after invalid-key alert', async () => {
    lookupCredentialMock.mockReturnValue('some-key');
    verifyFallbackCredentialMock.mockResolvedValue('invalid');

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_credential_invalid',
        expect.any(String),
        expect.any(String),
      );
    }, { interval: 0 });

    // Window must survive regardless of probe result.
    expect(fbView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(fbView(runtime).effectiveProvider).toBe('opencode-cli');
  });

  // ── unknown (fail-open) ──────────────────────────────────────────────────────

  it('emits NO credential alert when probe returns unknown', async () => {
    lookupCredentialMock.mockReturnValue('some-key');
    verifyFallbackCredentialMock.mockResolvedValue('unknown');

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    // Give microtasks a chance to settle.
    await Promise.resolve();

    const alertSources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(alertSources).not.toContain('fallback_credential_missing');
    expect(alertSources).not.toContain('fallback_credential_invalid');
  });

  it('window is active when probe returns unknown', async () => {
    lookupCredentialMock.mockReturnValue('some-key');
    verifyFallbackCredentialMock.mockResolvedValue('unknown');

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);
    await Promise.resolve();

    expect(fbView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(fbView(runtime).effectiveProvider).toBe('opencode-cli');
  });

  // ── valid key ────────────────────────────────────────────────────────────────

  it('emits NO credential alert when probe returns valid', async () => {
    lookupCredentialMock.mockReturnValue('some-key');
    verifyFallbackCredentialMock.mockResolvedValue('valid');

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);
    await Promise.resolve();

    const alertSources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(alertSources).not.toContain('fallback_credential_missing');
    expect(alertSources).not.toContain('fallback_credential_invalid');
  });

  // ── secrecy ─────────────────────────────────────────────────────────────────

  it('never includes the key value in any emitAlert argument', async () => {
    const secretKey = 'SUPER-SECRET-KEY';
    lookupCredentialMock.mockReturnValue(secretKey);
    verifyFallbackCredentialMock.mockResolvedValue('invalid');

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(vi.mocked(emitAlert)).toHaveBeenCalled();
    }, { interval: 0 });

    const allArgs = JSON.stringify(vi.mocked(emitAlert).mock.calls);
    expect(allArgs).not.toContain(secretKey);
  });

  // ── restore path ─────────────────────────────────────────────────────────────

  it('fires fallback_credential_missing when restorePersistedFallbackWindow arms with missing key', () => {
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});

    lookupCredentialMock.mockReturnValue(null);

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).restorePersistedFallbackWindow();

    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_credential_missing',
      expect.any(String),
      expect.any(String),
    );
  });

  // ── no-op paths — provider not configured ────────────────────────────────────

  it('emits no credential alert when no fallback provider is configured', () => {
    lookupCredentialMock.mockReturnValue(null);
    const runtime = makeRuntime({});

    // activateProviderFallback is a no-op without a fallback provider.
    fbView(runtime).activateProviderFallback(null);

    const alertSources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(alertSources).not.toContain('fallback_credential_missing');
    expect(alertSources).not.toContain('fallback_credential_invalid');
  });

  // ── extension re-arm (window already active) ────────────────────────────────

  it('does NOT re-run the credential pre-flight when an extension re-arms the active window', async () => {
    lookupCredentialMock.mockReturnValue('some-key');
    verifyFallbackCredentialMock.mockResolvedValue('invalid');

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    // First arm: the pre-flight verify probe runs once and alerts once.
    fbView(runtime).activateProviderFallback(null);
    await vi.waitFor(() => {
      expect(verifyFallbackCredentialMock).toHaveBeenCalledTimes(1);
    }, { interval: 0 });

    // Extension: a second usage-limit hit while the window is active. Without
    // the first-arm gate every per-turn usage-limit re-spawned the probe and
    // re-fired the alert — an unthrottled storm under load.
    fbView(runtime).activateProviderFallback(null);
    await vi.advanceTimersByTimeAsync(0);

    expect(verifyFallbackCredentialMock).toHaveBeenCalledTimes(1);
    const invalidAlerts = vi.mocked(emitAlert).mock.calls.filter(
      (c) => c[1] === 'fallback_credential_invalid',
    );
    expect(invalidAlerts).toHaveLength(1);
  });
});
