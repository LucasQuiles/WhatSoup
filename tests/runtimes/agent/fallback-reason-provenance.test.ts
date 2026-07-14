/**
 * Reason provenance: the original cause of a fallback window is preserved
 * across extensions, restores, and admin overrides.
 *
 * Harness mirrors provider-fallback.test.ts and fallback-admin-override.test.ts.
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
  (globalThis as Record<string, unknown>)['__reasonProvenanceTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__reasonProvenanceTestConfig__'] as Record<string, unknown>;
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

type PersistView = {
  effectiveProvider: string;
  activateProviderFallback(resetAt: Date | null): void;
  restorePersistedFallbackWindow(): void;
};

function pv(runtime: AgentRuntime): PersistView {
  return runtime as unknown as PersistView;
}

describe('fallback reason provenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
    lookupCredentialMock.mockReset();
    lookupCredentialMock.mockReturnValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('extension preserves original reason in the re-save', () => {
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    // First activation — usage-limit.
    pv(runtime).activateProviderFallback(null);
    const firstCall = saveSpy.mock.calls[0];
    if (!firstCall) throw new Error('saveFallbackState not called on first activation');
    expect(firstCall[1].reason).toBe('usage-limit');

    // Advance time, then extend window.
    vi.advanceTimersByTime(60 * 60 * 1000);
    pv(runtime).activateProviderFallback(new Date(Date.now() + 20 * 60 * 60 * 1000));

    const secondCall = saveSpy.mock.calls[1];
    if (!secondCall) throw new Error('saveFallbackState not called on extension');
    // Must still be the original cause.
    expect(secondCall[1].reason).toBe('usage-limit');
  });

  it('restore re-saves with the persisted reason, not "restored"', () => {
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'loadFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'admin-forced',
      probeAttempts: 0,
    });
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    pv(runtime).restorePersistedFallbackWindow();

    expect(saveSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'admin-forced' }),
    );
  });

  it('admin force overwrites reason even when a usage-limit window is active', () => {
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    // First: automatic usage-limit activation.
    pv(runtime).activateProviderFallback(null);
    const firstCall = saveSpy.mock.calls[0];
    if (!firstCall) throw new Error('saveFallbackState not called on activation');
    expect(firstCall[1].reason).toBe('usage-limit');

    // Admin forces a new window — reason must flip to 'admin-forced'.
    runtime.forceFallback(30 * 60_000);
    const secondCall = saveSpy.mock.calls[1];
    if (!secondCall) throw new Error('saveFallbackState not called on forceFallback');
    expect(secondCall[1].reason).toBe('admin-forced');
  });

  it('usage-limit extension after admin force carries admin-forced reason in DB (belt-and-suspenders)', () => {
    // Sequence: usage-limit activate → FALLBACK ON (forceFallback) → advance 1h
    // → usage-limit hit again (activateProviderFallback extension).
    // The re-save on the extension must carry 'admin-forced', not 'usage-limit',
    // because forceFallback established 'admin-forced' as the new epoch cause.
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/minimax-m2',
    });

    // Step 1: automatic usage-limit activation.
    pv(runtime).activateProviderFallback(null);
    expect(saveSpy.mock.calls[0]?.[1].reason).toBe('usage-limit');

    // Step 2: admin forces a window — new cause epoch 'admin-forced'.
    // Use 3h so the 1h advance below does not expire the window.
    runtime.forceFallback(3 * 60 * 60_000);
    expect(saveSpy.mock.calls[1]?.[1].reason).toBe('admin-forced');

    // Step 3: advance 1 hour (within the 3h admin window), then fallback provider
    // also hits a usage limit.
    vi.advanceTimersByTime(60 * 60 * 1000);
    pv(runtime).activateProviderFallback(null);

    // Extension re-save must carry the admin-forced cause, not 'usage-limit'.
    const extensionCall = saveSpy.mock.calls[2];
    if (!extensionCall) throw new Error('saveFallbackState not called on extension');
    expect(extensionCall[1].reason).toBe('admin-forced');
  });
});
