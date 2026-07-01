/**
 * Load harness: provider-fallback router storm pressure.
 *
 * This is not a performance benchmark. It is a deterministic pressure test for
 * the routing invariants that are easy to miss in single-turn unit tests:
 * replay storms collapse, transition alerts stay bounded, and failed recovery
 * probes remain visible without stranding the instance on the primary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  const clearAlertSource = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

vi.mock('../../src/config.ts', () => {
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
  (globalThis as Record<string, unknown>)['__fallbackRouterStormConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__fallbackRouterStormConfig__'] as Record<string, unknown>;
}

vi.mock('../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));

const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => 'present-key');
vi.mock('../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

vi.mock('../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

vi.mock('../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

import { AgentRuntime } from '../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../src/core/database.ts';
import type { Messenger } from '../../src/core/types.ts';
import { emitAlert } from '../../src/lib/emit-alert.ts';

const RECHECK_MS = 5 * 60 * 1000;
const STALL_THRESHOLD = 12;

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

function makeRuntime(): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentProviderConfig'] = undefined;
  config['agentFallbackProvider'] = 'opencode-cli';
  config['agentFallbackModel'] = 'minimax/MiniMax-M2.7';
  return new AgentRuntime(makeDb(), makeMessenger(), 'storm-test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type Activation = {
  primaryProvider: string;
  fallbackProvider: string;
  fallbackModel: string | undefined;
  reason: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error';
  resetAt: Date | null;
  activeUntil: number;
  extended: boolean;
  keyPresent: boolean | null;
  recoveryProbeRequired: boolean;
};

type FallbackView = {
  fallbackWindow: { activeUntil: number | null };
  fallbackProbeAttempts: number;
  effectiveProvider: string;
  pendingTurnText: Map<string, string>;
  pendingTurnActorJid: Map<string, string | undefined>;
  probePrimaryProviderRecovered(): boolean | Promise<boolean>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error',
  ): Activation | null;
  scheduleFallbackReplay(args: {
    activation: Activation;
    chatJid: string;
    mapKey?: string;
    oldSession: unknown;
    hadToolActivity?: boolean;
  }): boolean;
  replayTurnOnFallback(args: unknown): Promise<void>;
  getFallbackState(): {
    fallbackActivations: number;
    fallbackReverts: number;
    fallbackReplays: number;
    probeAttempts: number;
    lastProbeAt: number | null;
  };
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

function alertsFor(source: string): unknown[][] {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === source);
}

async function enterExtensionPhase(v: FallbackView, probe: ReturnType<typeof vi.fn>): Promise<void> {
  v.probePrimaryProviderRecovered = probe as unknown as () => boolean;
  v.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required');
  await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
}

describe('fallback router storm harness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a replay storm to one automatic replay for the fallback episode', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    v.replayTurnOnFallback = vi.fn(async () => {});

    const results: boolean[] = [];
    const stormSize = 200;
    for (let i = 0; i < stormSize; i += 1) {
      const mapKey = `chat-${i}`;
      v.pendingTurnText.set(mapKey, `turn ${i}`);
      v.pendingTurnActorJid.set(mapKey, `sender-${i}@s.whatsapp.net`);
      const activation = v.activateProviderFallback(null, 'model-unavailable')!;
      results.push(v.scheduleFallbackReplay({
        activation,
        chatJid: `${mapKey}@s.whatsapp.net`,
        mapKey,
        oldSession: null,
      }));
    }

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(v.replayTurnOnFallback).toHaveBeenCalledTimes(1);
    expect(alertsFor('provider_fallback_activated')).toHaveLength(1);
    // Completion semantics: the replayed alert reports a COMPLETED replay,
    // so nothing is emitted at dispatch time...
    expect(alertsFor('provider_fallback_replayed')).toHaveLength(0);
    expect(v.getFallbackState().fallbackReplays).toBe(0);
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(0);
    expect(alertsFor('runtime_provider_fallback_replay_failed')).toHaveLength(0);

    // ...and the single collapsed replay yields exactly one alert once it
    // resolves — still one per episode under storm load. Flush microtasks
    // only (runAllTimers would fire the revert timer early).
    await vi.advanceTimersByTimeAsync(0);
    expect(alertsFor('provider_fallback_replayed')).toHaveLength(1);

    const active = v.getFallbackState();
    expect(active.fallbackActivations).toBe(1);
    expect(active.fallbackReplays).toBe(1);
    expect(active.fallbackReverts).toBe(0);

    vi.advanceTimersByTime(v.fallbackWindow.activeUntil! - Date.now() + 1);
    const elapsed = v.getFallbackState();
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(1);
    expect(elapsed.fallbackActivations).toBe(1);
    expect(elapsed.fallbackReplays).toBe(1);
    expect(elapsed.fallbackReverts).toBe(1);
  });

  it('keeps a long failed recovery storm visible without alert spam or primary stranding', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);

    await enterExtensionPhase(v, probe);
    const attempts = STALL_THRESHOLD + 40;
    for (let attempt = 2; attempt <= attempts; attempt += 1) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }

    expect(probe).toHaveBeenCalledTimes(attempts);
    expect(v.fallbackProbeAttempts).toBe(attempts);
    expect(v.getFallbackState().probeAttempts).toBe(attempts);
    expect(v.getFallbackState().lastProbeAt).toBeGreaterThanOrEqual(
      Date.now() - RECHECK_MS,
    );
    expect(v.getFallbackState().lastProbeAt).toBeLessThanOrEqual(Date.now());
    // Re-alert fires at T, 2T, 3T, ... — cadenced re-surfacing without per-probe noise.
    // With T=12 and 52 total attempts: alerts at 12, 24, 36, 48 → 4 total.
    const expectedStallAlerts = Math.floor((attempts - STALL_THRESHOLD) / STALL_THRESHOLD) + 1;
    expect(alertsFor('fallback_recovery_stalled')).toHaveLength(expectedStallAlerts);
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(0);
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.fallbackWindow.activeUntil).not.toBeNull();
    expect(v.fallbackWindow.activeUntil!).toBeGreaterThan(Date.now());
  });

  it('recovers cleanly after a failed-probe storm and leaves no stale cadence running', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);

    await enterExtensionPhase(v, probe);
    for (let attempt = 2; attempt <= STALL_THRESHOLD + 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(alertsFor('fallback_recovery_stalled')).toHaveLength(1);

    probe.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.effectiveProvider).toBe('claude-cli');
    expect(v.getFallbackState().probeAttempts).toBe(0);
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECHECK_MS * 10);
    expect(probe).toHaveBeenCalledTimes(STALL_THRESHOLD + 4);
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(1);
    expect(alertsFor('fallback_recovery_stalled')).toHaveLength(1);
  });
});
