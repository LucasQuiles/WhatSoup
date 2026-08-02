/**
 * Pre-flight binary check on armFallbackWindow.
 *
 * When the fallback window is armed (via activateProviderFallback,
 * restorePersistedFallbackWindow, or any future admin-force path that calls
 * armFallbackWindow), the runtime must:
 *
 *  - CLI provider binary missing  → emitAlert source='fallback_binary_missing';
 *                                   window STILL active
 *  - CLI provider binary present  → no alert; window STILL active
 *  - CLI provider binary unknown  → no alert (fail-open); window STILL active
 *  - Managed-loop provider        → probe NOT called (no binary to check)
 *
 * Pre-flight NEVER blocks or reverts the window — window is STILL active in
 * every case.
 *
 * Pattern mirrors fallback-credential-preflight.test.ts. Kept in a separate
 * file from provider-fallback.test.ts to avoid tree-sitter edit-fragment
 * friction.
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
  (globalThis as Record<string, unknown>)['__binaryPreflightTestConfig__'] = config;
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

// Credential lookup — return a valid key so credential preflight never fires
// for the fallback providers under test (we only want to observe binary alerts).
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (_service: string) => 'dummy-key-for-binary-preflight-tests',
  };
});

// Mutable probeFallbackBinary mock — tests control what the probe returns.
const probeFallbackBinaryMock = vi.fn<
  (binary: string) => Promise<{ status: 'present' | 'missing' | 'unknown'; version: string | null }>
>(() => Promise.resolve({ status: 'unknown', version: null }));

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: (binary: string) => probeFallbackBinaryMock(binary),
  // Fail-open stub: model-catalog behavior is covered in
  // fallback-model-preflight.test.ts; here it must simply never alert.
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

// Stub out credential validity probe (never invalid here — credential tests
// are covered in fallback-credential-preflight.test.ts).
vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: () => Promise.resolve('valid'),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)[
    '__binaryPreflightTestConfig__'
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
  agentFallbackProvider?: string;
  agentFallbackModel?: string;
}

function makeRuntime(overrides: RuntimeOverrides = {}): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = overrides.agentProvider ?? 'claude-cli';
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8',
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

describe('armFallbackWindow — binary pre-flight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
    probeFallbackBinaryMock.mockReset();
    probeFallbackBinaryMock.mockResolvedValue({ status: 'unknown', version: null });
    vi.mocked(emitAlert).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── missing binary ─────────────────────────────────────────────────────────

  it('emits fallback_binary_missing alert when binary is absent', async () => {
    probeFallbackBinaryMock.mockResolvedValue({ status: 'missing', version: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_binary_missing',
        expect.any(String),
        expect.stringContaining('binary=opencode'),
      );
    }, { interval: 0 });
  });

  it('window is still active after missing-binary alert', async () => {
    probeFallbackBinaryMock.mockResolvedValue({ status: 'missing', version: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_binary_missing',
        expect.any(String),
        expect.any(String),
      );
    }, { interval: 0 });

    expect(fbView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(fbView(runtime).effectiveProvider).toBe('opencode-cli');
  });

  // ── binary present ─────────────────────────────────────────────────────────

  it('emits NO binary alert when binary is present', async () => {
    probeFallbackBinaryMock.mockResolvedValue({ status: 'present', version: '0.3.14' });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    await Promise.resolve();

    const alertSources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(alertSources).not.toContain('fallback_binary_missing');
  });

  it('window is active when binary is present', async () => {
    probeFallbackBinaryMock.mockResolvedValue({ status: 'present', version: '0.3.14' });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);
    await Promise.resolve();

    expect(fbView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(fbView(runtime).effectiveProvider).toBe('opencode-cli');
  });

  // ── unknown (fail-open) ────────────────────────────────────────────────────

  it('emits NO binary alert when probe returns unknown (fail-open)', async () => {
    probeFallbackBinaryMock.mockResolvedValue({ status: 'unknown', version: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    await Promise.resolve();

    const alertSources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(alertSources).not.toContain('fallback_binary_missing');
  });

  // ── managed-loop provider — probe NOT called ────────────────────────────────

  it('does NOT call probeFallbackBinary when fallbackProvider is openai-api', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'openai-api',
      agentFallbackModel: undefined,
    });

    fbView(runtime).activateProviderFallback(null);

    expect(probeFallbackBinaryMock).not.toHaveBeenCalled();
  });

  it('does NOT call probeFallbackBinary when fallbackProvider is anthropic-api', () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'anthropic-api',
      agentFallbackModel: undefined,
    });

    fbView(runtime).activateProviderFallback(null);

    expect(probeFallbackBinaryMock).not.toHaveBeenCalled();
  });

  // ── no-op path — no fallback provider configured ────────────────────────────

  it('emits no binary alert when no fallback provider is configured', () => {
    const runtime = makeRuntime({});

    fbView(runtime).activateProviderFallback(null);

    const alertSources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(alertSources).not.toContain('fallback_binary_missing');
    expect(probeFallbackBinaryMock).not.toHaveBeenCalled();
  });

  // ── probe never blocks arming ────────────────────────────────────────────────

  it('arms the window synchronously even when the probe never settles', () => {
    // A probe that hangs forever (e.g. a wedged child process the kill-timer
    // somehow misses) must not delay or gate arming: the window fields are set
    // before the probe promise is ever inspected.
    probeFallbackBinaryMock.mockImplementation(() => new Promise(() => {}));

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    // Deliberately NO await / waitFor / microtask drain before these asserts —
    // the synchronous return of activateProviderFallback must already have
    // armed the window while the probe is still pending.
    expect(fbView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(fbView(runtime).effectiveProvider).toBe('opencode-cli');
    expect(probeFallbackBinaryMock).toHaveBeenCalledWith('opencode');
  });

  // ── restore path ───────────────────────────────────────────────────────────

  it('fires fallback_binary_missing when restorePersistedFallbackWindow arms with missing binary', async () => {
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'getFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});

    probeFallbackBinaryMock.mockResolvedValue({ status: 'missing', version: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).restorePersistedFallbackWindow();

    await vi.waitFor(() => {
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_binary_missing',
        expect.any(String),
        expect.any(String),
      );
    }, { interval: 0 });
  });

  // ── extension re-arm (window already active) ────────────────────────────────

  it('does NOT re-probe the binary when an extension re-arms the active window', async () => {
    probeFallbackBinaryMock.mockResolvedValue({ status: 'missing', version: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    // First arm: the binary probe spawns once and alerts once.
    fbView(runtime).activateProviderFallback(null);
    await vi.waitFor(() => {
      expect(probeFallbackBinaryMock).toHaveBeenCalledTimes(1);
    }, { interval: 0 });

    // Extension: a second usage-limit hit while the window is active must not
    // re-spawn the probe nor re-fire the alert (per-turn usage-limits would
    // otherwise spawn an unthrottled probe storm).
    fbView(runtime).activateProviderFallback(null);
    await vi.advanceTimersByTimeAsync(0);

    expect(probeFallbackBinaryMock).toHaveBeenCalledTimes(1);
    const missingAlerts = vi.mocked(emitAlert).mock.calls.filter(
      (c) => c[1] === 'fallback_binary_missing',
    );
    expect(missingAlerts).toHaveLength(1);
  });
});
