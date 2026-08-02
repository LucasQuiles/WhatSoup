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
    agentFallbacks: undefined,
  };
  (globalThis as Record<string, unknown>)['__fallbackChainTestConfig__'] = config;
  return { config };
});

vi.mock('../../../src/mcp/register-all.ts', () => ({ registerAllTools: vi.fn() }));

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

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';
import { ProviderDataPolicyError } from '../../../src/core/provider-data-policy.ts';
import type { ChatModelPreference } from '../../../src/runtimes/agent/chat-preference-db.ts';

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__fallbackChainTestConfig__'] as Record<string, unknown>;
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

type FallbackEntry = { provider: string; model?: string; dataPolicy?: 'trusted' | 'restricted' };
type ProviderFallbackReason =
  | 'usage-limit'
  | 'rate-limit'
  | 'auth-required'
  | 'model-unavailable'
  | 'server-error'
  | 'empty-output'
  | 'probe-unusable';

function makeRuntime(overrides: {
  agentFallbackProvider?: string;
  agentFallbackModel?: string;
  agentFallbacks?: FallbackEntry[];
  model?: string;
  providerDataPolicy?: 'trusted' | 'restricted' | null;
  providerBoundaryMode?: 'shadow' | 'enforce';
  nlRouting?: boolean;
} = {}): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentProviderConfig'] = undefined;
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  config['agentFallbacks'] = overrides.agentFallbacks;
  config['agentProviderDataPolicy'] = overrides.providerDataPolicy ?? null;
  config['agentProviderBoundaryMode'] = overrides.providerBoundaryMode ?? 'shadow';
  config['nlRouting'] = overrides.nlRouting ?? false;
  config['nlRoutingTiers'] = null;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: overrides.model ?? 'claude-opus-4-8[1m]',
  });
}

type FallbackView = {
  fallbackWindow: { activeUntil: number | null };
  effectiveProvider: string;
  effectiveModel: string | undefined;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: ProviderFallbackReason,
  ): {
    primaryProvider: string;
    fallbackProvider: string;
    fallbackModel: string | undefined;
    reason: ProviderFallbackReason;
    resetAt: Date | null;
    activeUntil: number;
    extended: boolean;
    keyPresent: boolean | null;
    recoveryProbeRequired: boolean;
  } | null;
  restorePersistedFallbackWindow(): void;
  getFallbackState(): {
    effectiveProvider: string;
    activeFallbackEntry?: FallbackEntry | null;
    fallbackChain?: Array<FallbackEntry & { eligible: boolean | null }>;
  };
  createSessionManager(opts: {
    chatJid: string;
    cwd: string | undefined;
    actorJid?: string;
    onEvent: () => void;
    onCrash: () => void;
    notifyUser: () => void;
  }): unknown;
  routablePinTargets(): string[];
  loadSenderPreference(chatJid: string, senderJid: string): ChatModelPreference | null;
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

describe('fallback chain selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T10:00:00Z'));
    lookupCredentialMock.mockReset();
    vi.mocked(emitAlert).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps legacy single-fallback behavior byte-compatible', () => {
    lookupCredentialMock.mockImplementation((svc) => svc === 'minimax' ? 'mm-key' : null);
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2',
    });

    view(runtime).activateProviderFallback(null);

    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'opencode-cli',
      model: 'minimax/MiniMax-M2',
    });
  });

  it('retains dataPolicy through runtime fallback-window cloning and status snapshots', () => {
    lookupCredentialMock.mockImplementation((svc) => svc === 'openai' ? 'oa-key' : null);
    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'openai-api', model: 'gpt-5', dataPolicy: 'restricted' },
      ],
    });

    view(runtime).activateProviderFallback(null);

    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'openai-api',
      model: 'gpt-5',
      dataPolicy: 'restricted',
    });
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'openai-api', model: 'gpt-5', dataPolicy: 'restricted', eligible: true },
    ]);
  });

  it('runs policy admission with NL routing disabled and rethrows typed enforcement errors', () => {
    const runtime = makeRuntime({
      providerDataPolicy: null,
      providerBoundaryMode: 'enforce',
      nlRouting: false,
    });

    expect(() => view(runtime).createSessionManager({
      chatJid: '15550203@s.whatsapp.net',
      cwd: undefined,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
      notifyUser: vi.fn(),
    })).toThrow(ProviderDataPolicyError);
  });

  it('does not let a broad NL route fallback swallow policy enforcement', () => {
    const runtime = makeRuntime({
      providerDataPolicy: null,
      providerBoundaryMode: 'enforce',
      nlRouting: true,
    });
    vi.spyOn(view(runtime), 'routablePinTargets').mockImplementation(() => {
      throw new Error('credential probe unavailable');
    });
    vi.spyOn(view(runtime), 'loadSenderPreference').mockReturnValue({
      chatJid: '15550204@s.whatsapp.net',
      senderJid: '15550205@s.whatsapp.net',
      intent: 'provider_specific',
      requestedProvider: 'codex-cli',
      scope: 'this_thread',
      pinStrict: true,
      fallbackPermitted: false,
      updatedAt: 1,
      expiresAt: 2,
      requestedModel: null,
      validatedProvider: null,
      modelPinVerified: null,
    });

    expect(() => view(runtime).createSessionManager({
      chatJid: '15550204@s.whatsapp.net',
      actorJid: '15550205@s.whatsapp.net',
      cwd: undefined,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
      notifyUser: vi.fn(),
    })).toThrow(ProviderDataPolicyError);
  });

  it('reports configured chain eligibility from credential presence before an arm-time selection pass', () => {
    // Idle eligibility surfaces real credential presence so an uncredentialed
    // fallback tier is visible in /health before any window arms: present key →
    // eligible:true, mapped-but-absent key → eligible:false.
    lookupCredentialMock.mockImplementation((svc) => svc === 'minimax' ? 'mm-key' : null);
    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        { provider: 'openai-api', model: 'gpt-4o-mini' },
      ],
    });

    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: true },
      { provider: 'openai-api', model: 'gpt-4o-mini', eligible: false },
    ]);
  });

  it('selects the first later entry with a present key when an earlier keyed entry is missing credentials', () => {
    lookupCredentialMock.mockImplementation((svc) => svc === 'openai' ? 'oa-key' : null);
    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        { provider: 'openai-api', model: 'gpt-4o-mini' },
      ],
    });

    view(runtime).activateProviderFallback(null);

    expect(view(runtime).effectiveProvider).toBe('openai-api');
    expect(view(runtime).effectiveModel).toBe('gpt-4o-mini');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'openai-api',
      model: 'gpt-4o-mini',
    });
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_credential_missing',
      expect.any(String),
      expect.stringContaining('entry=0'),
    );
  });

  it('keeps same-provider model tiers eligible for usage-limit windows', () => {
    const runtime = makeRuntime({
      model: 'claude-fable-5',
      agentFallbacks: [
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
      ],
    });

    view(runtime).activateProviderFallback(null, 'usage-limit');

    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).effectiveModel).toBe('claude-opus-4-8');
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: true },
      { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: true },
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
    ]);
  });

  it('skips same-provider model tiers for auth-required windows and selects an independent provider', () => {
    lookupCredentialMock.mockImplementation((svc) => svc === 'minimax' ? 'mm-key' : null);
    const runtime = makeRuntime({
      model: 'claude-fable-5',
      agentFallbacks: [
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
      ],
    });

    view(runtime).activateProviderFallback(null, 'auth-required');

    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'opencode-cli',
      model: 'minimax/MiniMax-M2',
    });
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: false },
      { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: false },
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: true },
    ]);
  });

  it('does not arm auth-required fallback when every configured fallback shares the primary provider', () => {
    const runtime = makeRuntime({
      model: 'claude-fable-5',
      agentFallbacks: [
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
      ],
    });

    const activation = view(runtime).activateProviderFallback(null, 'auth-required');

    expect(activation).toBeNull();
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toBeNull();
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: false },
      { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: false },
    ]);
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_no_independent_provider',
      expect.any(String),
      expect.stringContaining('primaryProvider=claude-cli'),
    );
  });

  it.each(['empty-output', 'probe-unusable'] as const)(
    'does not arm %s fallback when every configured fallback shares the primary provider',
    (reason) => {
      const runtime = makeRuntime({
        model: 'claude-fable-5',
        agentFallbacks: [
          { provider: 'claude-cli', model: 'claude-opus-4-8' },
          { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
        ],
      });

      const activation = view(runtime).activateProviderFallback(null, reason);

      expect(activation).toBeNull();
      expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
      expect(view(runtime).effectiveProvider).toBe('claude-cli');
      expect(view(runtime).getFallbackState().activeFallbackEntry).toBeNull();
      expect(view(runtime).getFallbackState().fallbackChain).toEqual([
        { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: false },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: false },
      ]);
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_no_independent_provider',
        'Fallback requires an independent provider target',
        expect.stringContaining(`reason=${reason}`),
      );
    },
  );

  it('fails open to entry zero when every keyed chain entry is missing credentials', () => {
    lookupCredentialMock.mockReturnValue(null);
    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        { provider: 'openai-api', model: 'gpt-4o-mini' },
      ],
    });

    view(runtime).activateProviderFallback(null);

    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2');
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
      { provider: 'openai-api', model: 'gpt-4o-mini', eligible: false },
    ]);
  });
});

describe('fallback chain selection — restore path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T10:00:00Z'));
    lookupCredentialMock.mockReset();
    vi.mocked(emitAlert).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-runs selection against the current chain on restore — a later eligible entry wins when entry zero lost its key', () => {
    // The persisted row stores only the window, never the selected entry.
    // After a restart with entry[0]'s key gone, restore must pick entry[1].
    lookupCredentialMock.mockImplementation((svc) => svc === 'openai' ? 'oa-key' : null);
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'getFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
    });
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        { provider: 'openai-api', model: 'gpt-4o-mini' },
      ],
    });

    view(runtime).restorePersistedFallbackWindow();

    expect(view(runtime).effectiveProvider).toBe('openai-api');
    expect(view(runtime).effectiveModel).toBe('gpt-4o-mini');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'openai-api',
      model: 'gpt-4o-mini',
    });
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
      { provider: 'openai-api', model: 'gpt-4o-mini', eligible: true },
    ]);
    expect(clearSpy).not.toHaveBeenCalled();
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_credential_missing',
      expect.any(String),
      expect.stringContaining('entry=0'),
    );
  });

  it('clears the persisted row and stays on the primary when the chain was emptied from config since persist', () => {
    lookupCredentialMock.mockReturnValue('present-key');
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'getFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
    });
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({ agentFallbacks: [] });

    view(runtime).restorePersistedFallbackWindow();

    expect(clearSpy).toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).getFallbackState().activeFallbackEntry).toBeNull();
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([]);
  });

  it('clears a persisted auth-required window when only same-provider fallbacks remain', () => {
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'getFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'auth-required',
      probeAttempts: 0,
    });
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      model: 'claude-fable-5',
      agentFallbacks: [
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
      ],
    });

    view(runtime).restorePersistedFallbackWindow();

    expect(clearSpy).toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).getFallbackState().activeFallbackEntry).toBeNull();
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: false },
      { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: false },
    ]);
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_no_independent_provider',
      expect.any(String),
      expect.stringContaining('reason=auth-required'),
    );
  });
});
