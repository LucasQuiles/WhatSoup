import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/lib/emit-alert.ts', () => ({ emitAlert: vi.fn() }));

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

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__fallbackChainTestConfig__'] as Record<string, unknown>;
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

type FallbackEntry = { provider: string; model?: string };

function makeRuntime(overrides: {
  agentFallbackProvider?: string;
  agentFallbackModel?: string;
  agentFallbacks?: FallbackEntry[];
  model?: string;
} = {}): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentProviderConfig'] = undefined;
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  config['agentFallbacks'] = overrides.agentFallbacks;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: overrides.model ?? 'claude-opus-4-8[1m]',
  });
}

type FallbackView = {
  fallbackActiveUntil: number | null;
  effectiveProvider: string;
  effectiveModel: string | undefined;
  activateProviderFallback(resetAt: Date | null): void;
  getFallbackState(): {
    effectiveProvider: string;
    activeFallbackEntry?: FallbackEntry | null;
    fallbackChain?: Array<FallbackEntry & { eligible: boolean | null }>;
  };
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

  it('reports configured chain eligibility as unknown before an arm-time selection pass', () => {
    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        { provider: 'openai-api', model: 'gpt-4o-mini' },
      ],
    });

    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: null },
      { provider: 'openai-api', model: 'gpt-4o-mini', eligible: null },
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
