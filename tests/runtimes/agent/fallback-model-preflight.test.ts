/**
 * Pre-flight model-catalog check on armFallbackWindow.
 *
 * After the binary pre-flight resolves 'present' for an opencode-cli fallback
 * with a configured fallback model, the runtime probes the provider's model
 * catalog (`<binary> models`) and must:
 *
 *  - model not in catalog            → emitAlert source='fallback_model_unknown',
 *                                      evidence carries model= (+ suggestion= when a
 *                                      case-insensitive catalog match exists);
 *                                      window STILL active
 *  - model found / probe unknown     → no alert (fail-open); window STILL active
 *  - non-opencode fallback provider  → catalog probe NOT called
 *  - no fallback model configured    → catalog probe NOT called
 *  - binary probe says missing       → catalog probe NOT called
 *
 * Pre-flight NEVER blocks or reverts the window — arming stays synchronous
 * even when the catalog probe never settles.
 *
 * Pattern mirrors fallback-binary-preflight.test.ts. Kept in a separate file
 * to avoid tree-sitter edit-fragment friction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  (globalThis as Record<string, unknown>)['__modelPreflightTestConfig__'] = config;
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
// for the fallback providers under test (we only want to observe model alerts).
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (_service: string) => 'dummy-key-for-model-preflight-tests',
  };
});

// Mutable probe mocks — tests control what each probe returns.
const probeFallbackBinaryMock = vi.fn<
  (binary: string) => Promise<{ status: 'present' | 'missing' | 'unknown'; version: string | null }>
>(() => Promise.resolve({ status: 'present', version: '0.3.14' }));

const probeModelCatalogMock = vi.fn<
  (binary: string, model: string) => Promise<{ status: 'found' | 'not_found' | 'unknown'; suggestion: string | null }>
>(() => Promise.resolve({ status: 'unknown', suggestion: null }));

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: (binary: string) => probeFallbackBinaryMock(binary),
  probeModelCatalog: (binary: string, model: string) => probeModelCatalogMock(binary, model),
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
    '__modelPreflightTestConfig__'
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
};

function fbView(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('armFallbackWindow — model-catalog pre-flight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T10:00:00Z'));
    probeFallbackBinaryMock.mockReset();
    probeFallbackBinaryMock.mockResolvedValue({ status: 'present', version: '0.3.14' });
    probeModelCatalogMock.mockReset();
    probeModelCatalogMock.mockResolvedValue({ status: 'unknown', suggestion: null });
    vi.mocked(emitAlert).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── model not in catalog ─────────────────────────────────────────────────────

  it('emits fallback_model_unknown with the catalog suggestion when only the casing differs', async () => {
    probeModelCatalogMock.mockResolvedValue({
      status: 'not_found',
      suggestion: 'minimax/MiniMax-M2',
    });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_model_unknown',
        expect.any(String),
        expect.stringContaining('suggestion=minimax/MiniMax-M2'),
      );
    }, { interval: 0 });

    const evidence = vi.mocked(emitAlert).mock.calls
      .find((c) => c[1] === 'fallback_model_unknown')?.[3] as string;
    expect(evidence).toContain('model=minimax/minimax-m2');
    expect(evidence).toContain('provider=opencode-cli');
  });

  it('emits fallback_model_unknown without a suggestion when nothing in the catalog matches', async () => {
    probeModelCatalogMock.mockResolvedValue({ status: 'not_found', suggestion: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/no-such-model',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_model_unknown',
        expect.any(String),
        expect.stringContaining('model=minimax/no-such-model'),
      );
    }, { interval: 0 });

    const evidence = vi.mocked(emitAlert).mock.calls
      .find((c) => c[1] === 'fallback_model_unknown')?.[3] as string;
    expect(evidence).not.toContain('suggestion=');
  });

  it('window is still active after a fallback_model_unknown alert', async () => {
    probeModelCatalogMock.mockResolvedValue({
      status: 'not_found',
      suggestion: 'minimax/MiniMax-M2',
    });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_model_unknown',
        expect.any(String),
        expect.any(String),
      );
    }, { interval: 0 });

    expect(fbView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(fbView(runtime).effectiveProvider).toBe('opencode-cli');
  });

  // ── model found / probe unknown → no alert ───────────────────────────────────

  it('emits NO model alert when the model is found in the catalog', async () => {
    probeModelCatalogMock.mockResolvedValue({ status: 'found', suggestion: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(probeModelCatalogMock).toHaveBeenCalled();
    }, { interval: 0 });
    await Promise.resolve();

    const alertSources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(alertSources).not.toContain('fallback_model_unknown');
  });

  it('emits NO model alert when the probe returns unknown (fail-open)', async () => {
    probeModelCatalogMock.mockResolvedValue({ status: 'unknown', suggestion: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(probeModelCatalogMock).toHaveBeenCalled();
    }, { interval: 0 });
    await Promise.resolve();

    const alertSources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(alertSources).not.toContain('fallback_model_unknown');
  });

  // ── gating — when the catalog probe must NOT run ─────────────────────────────

  it('does NOT probe the catalog for a non-opencode CLI fallback provider', async () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'codex-cli',
      agentFallbackModel: 'gpt-5.4-codex',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(probeFallbackBinaryMock).toHaveBeenCalled();
    }, { interval: 0 });
    await Promise.resolve();

    expect(probeModelCatalogMock).not.toHaveBeenCalled();
  });

  it('does NOT probe the catalog for a managed-loop fallback provider', async () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'openai-api',
      agentFallbackModel: 'gpt-5.4',
    });

    fbView(runtime).activateProviderFallback(null);

    await Promise.resolve();
    await Promise.resolve();

    expect(probeModelCatalogMock).not.toHaveBeenCalled();
  });

  it('does NOT probe the catalog when no fallback model is configured', async () => {
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: undefined,
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(probeFallbackBinaryMock).toHaveBeenCalled();
    }, { interval: 0 });
    await Promise.resolve();

    expect(probeModelCatalogMock).not.toHaveBeenCalled();
  });

  it('does NOT probe the catalog when the binary probe says missing', async () => {
    probeFallbackBinaryMock.mockResolvedValue({ status: 'missing', version: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2',
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
    await Promise.resolve();

    expect(probeModelCatalogMock).not.toHaveBeenCalled();
  });

  it('does NOT probe the catalog when the binary probe returns unknown', async () => {
    probeFallbackBinaryMock.mockResolvedValue({ status: 'unknown', version: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2',
    });

    fbView(runtime).activateProviderFallback(null);

    await vi.waitFor(() => {
      expect(probeFallbackBinaryMock).toHaveBeenCalled();
    }, { interval: 0 });
    await Promise.resolve();

    expect(probeModelCatalogMock).not.toHaveBeenCalled();
  });

  // ── probe never blocks arming ────────────────────────────────────────────────

  it('arms the window synchronously even when the catalog probe never settles', async () => {
    // A catalog probe that hangs forever must not delay or gate arming: the
    // window fields are set before either probe promise is ever inspected.
    probeModelCatalogMock.mockImplementation(() => new Promise(() => {}));

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    fbView(runtime).activateProviderFallback(null);

    // Deliberately NO await / waitFor / microtask drain before these asserts —
    // the synchronous return of activateProviderFallback must already have
    // armed the window while the probes are still pending.
    expect(fbView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(fbView(runtime).effectiveProvider).toBe('opencode-cli');

    // The window must remain active after the binary probe resolves and the
    // hung catalog probe is dispatched.
    await vi.waitFor(() => {
      expect(probeModelCatalogMock).toHaveBeenCalledWith('opencode', 'minimax/minimax-m2');
    }, { interval: 0 });
    expect(fbView(runtime).fallbackWindow.activeUntil).not.toBeNull();
    expect(fbView(runtime).effectiveProvider).toBe('opencode-cli');
    const alertSources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(alertSources).not.toContain('fallback_model_unknown');
  });

  // ── extension re-arm (window already active) ────────────────────────────────

  it('does NOT re-probe the model catalog when an extension re-arms the active window', async () => {
    probeModelCatalogMock.mockResolvedValue({ status: 'not_found', suggestion: null });

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    // First arm: the catalog probe spawns once and alerts once.
    fbView(runtime).activateProviderFallback(null);
    await vi.waitFor(() => {
      expect(probeModelCatalogMock).toHaveBeenCalledTimes(1);
    }, { interval: 0 });

    // Extension: a second usage-limit hit while the window is active must not
    // re-spawn the catalog probe nor re-fire fallback_model_unknown.
    fbView(runtime).activateProviderFallback(null);
    await vi.advanceTimersByTimeAsync(0);

    expect(probeModelCatalogMock).toHaveBeenCalledTimes(1);
    const unknownAlerts = vi.mocked(emitAlert).mock.calls.filter(
      (c) => c[1] === 'fallback_model_unknown',
    );
    expect(unknownAlerts).toHaveLength(1);
  });
});
