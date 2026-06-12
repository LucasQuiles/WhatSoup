/**
 * Fallback transition observability: alert sources + process-local counters.
 *
 * Every fallback state transition used to be log-only; these tests pin the
 * countable surfaces (decision-journal principle: expensive paths must be
 * countable report fields, never just logs):
 *   - provider_fallback_activated fires exactly once per window, on the FIRST
 *     arm only (fallbackArmReason null-guard) — never on extensions
 *   - provider_fallback_reverted fires on deactivation with reason, turn
 *     counters, and window duration in the evidence — never when idle
 *   - provider_fallback_replayed fires on a successful replay dispatch only —
 *     never on gate-rejected replays (extended / key-absent / tool activity)
 *   - fallbackActivations / fallbackReverts / fallbackReplays count
 *     lifetime-of-process totals and surface via getFallbackState
 *
 * Harness mirrors fallback-probe-stall.test.ts (fake timers, mocked emitAlert,
 * mocked credential/binary preflights, deterministic keyring).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/lib/emit-alert.ts', () => ({ emitAlert: vi.fn() }));

// ─── Mocks (declared before importing the runtime) ────────────────────────────

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
  (globalThis as Record<string, unknown>)['__transitionAlertsTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__transitionAlertsTestConfig__'] as Record<string, unknown>;
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

// Deterministic keyring: a present fallback key suppresses the unrelated
// fallback_credential_missing alert so transition-alert assertions stay clean.
const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => 'present-key');
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

// Fire-and-forget pre-flights must never hit the network / spawn binaries.
vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));
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
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type Activation = {
  primaryProvider: string;
  fallbackProvider: string;
  fallbackModel: string | undefined;
  reason: 'usage-limit' | 'rate-limit' | 'auth-required';
  resetAt: Date | null;
  activeUntil: number;
  extended: boolean;
  keyPresent: boolean | null;
  recoveryProbeRequired: boolean;
};

/** Bracket-access view of the private fallback state machine. */
type FallbackView = {
  fallbackActiveUntil: number | null;
  fallbackTurnsServed: number;
  fallbackTurnsEmpty: number;
  effectiveProvider: string;
  pendingTurnText: Map<string, string>;
  pendingTurnActorJid: Map<string, string | undefined>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required',
  ): Activation | null;
  deactivateProviderFallback(reason: string): void;
  scheduleFallbackReplay(args: {
    activation: Activation;
    chatJid: string;
    mapKey?: string;
    oldSession: unknown;
    hadToolActivity?: boolean;
  }): boolean;
  replayTurnOnFallback(args: unknown): Promise<void>;
  getFallbackState(): {
    fallbackActiveUntil: number | null;
    fallbackActivations: number;
    fallbackReverts: number;
    fallbackReplays: number;
  };
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

function alertsFor(source: string): Array<[string, string, string, string]> {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === source) as Array<[string, string, string, string]>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRuntime — fallback transition alerts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits provider_fallback_activated on the FIRST arm only — never on extensions', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'usage-limit'); // +1h
    const activated = alertsFor('provider_fallback_activated');
    expect(activated).toHaveLength(1);
    const [instance, source, , evidence] = activated[0];
    expect(instance).toBe('test');
    expect(source).toBe('provider_fallback_activated');
    expect(evidence).toContain('reason=usage-limit');
    expect(evidence).toContain('provider=opencode-cli');
    expect(evidence).toContain('model=minimax/MiniMax-M2.7');
    expect(evidence).toContain('until=2026-06-10T11:00:00.000Z');
    expect(evidence).not.toContain('present-key');

    // Extension of the active window: no second activation alert.
    const extended = v.activateProviderFallback(new Date(Date.now() + 3 * 60 * 60 * 1000), 'usage-limit')!;
    expect(extended.extended).toBe(true);
    expect(alertsFor('provider_fallback_activated')).toHaveLength(1);
  });

  it('emits provider_fallback_reverted on window-elapsed with reason, turn counters, and window duration', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'usage-limit'); // +1h
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(0);
    v.fallbackTurnsServed = 3;
    v.fallbackTurnsEmpty = 1;

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(v.fallbackActiveUntil).toBeNull();
    const reverted = alertsFor('provider_fallback_reverted');
    expect(reverted).toHaveLength(1);
    const [instance, , , evidence] = reverted[0];
    expect(instance).toBe('test');
    expect(evidence).toContain('reason=window-elapsed');
    expect(evidence).toContain('turnsServed=3');
    expect(evidence).toContain('turnsEmpty=1');
    expect(evidence).toContain('windowMs=3600000');
  });

  it('emits provider_fallback_reverted on admin-disabled deactivation', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    v.activateProviderFallback(null, 'usage-limit');
    runtime.disableFallback();
    const reverted = alertsFor('provider_fallback_reverted');
    expect(reverted).toHaveLength(1);
    expect(reverted[0][3]).toContain('reason=admin-disabled');
  });

  it('does NOT emit provider_fallback_reverted when deactivation is a no-op (no active window)', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    v.deactivateProviderFallback('admin-disabled');
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(0);
  });

  it('emits provider_fallback_replayed on a successful replay dispatch with reason and target entry', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(null, 'usage-limit')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.pendingTurnActorJid.set('chat-key', 'sender@s.whatsapp.net');
    v.replayTurnOnFallback = vi.fn(async () => {});

    expect(v.scheduleFallbackReplay({
      activation,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(true);

    const replayed = alertsFor('provider_fallback_replayed');
    expect(replayed).toHaveLength(1);
    const [instance, , , evidence] = replayed[0];
    expect(instance).toBe('test');
    expect(evidence).toContain('reason=usage-limit');
    expect(evidence).toContain('provider=opencode-cli');
    expect(evidence).toContain('model=minimax/MiniMax-M2.7');
  });

  it('does NOT emit provider_fallback_replayed on gate-rejected replays', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(null, 'usage-limit')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.replayTurnOnFallback = vi.fn(async () => {});

    // Gate 1: extension never replays.
    expect(v.scheduleFallbackReplay({
      activation: { ...activation, extended: true },
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(false);
    // Gate 2: a known-absent key never replays.
    expect(v.scheduleFallbackReplay({
      activation: { ...activation, keyPresent: false },
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(false);
    // Gate 3: tool activity already started never replays.
    expect(v.scheduleFallbackReplay({
      activation,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
      hadToolActivity: true,
    })).toBe(false);
    // Gate 4: no replay text captured.
    expect(v.scheduleFallbackReplay({
      activation,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'missing-key',
      oldSession: null,
    })).toBe(false);

    expect(alertsFor('provider_fallback_replayed')).toHaveLength(0);
    expect(v.replayTurnOnFallback).not.toHaveBeenCalled();
  });
});

describe('AgentRuntime — fallback transition counters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts all transition counters at zero in getFallbackState', () => {
    const runtime = makeRuntime();
    const state = view(runtime).getFallbackState();
    expect(state.fallbackActivations).toBe(0);
    expect(state.fallbackReverts).toBe(0);
    expect(state.fallbackReplays).toBe(0);
  });

  it('counts activations and reverts across two windows as lifetime-of-process totals', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    // Window 1: activate (+extend — no extra count), then elapse.
    v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'usage-limit');
    v.activateProviderFallback(new Date(Date.now() + 2 * 60 * 60 * 1000), 'usage-limit');
    expect(v.getFallbackState().fallbackActivations).toBe(1);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);
    expect(v.getFallbackState().fallbackReverts).toBe(1);

    // Window 2: activate, then admin-disable. Counters accumulate — no reset.
    v.activateProviderFallback(null, 'usage-limit');
    expect(v.getFallbackState().fallbackActivations).toBe(2);
    runtime.disableFallback();
    expect(v.getFallbackState().fallbackReverts).toBe(2);

    // Idempotent deactivation does not count.
    runtime.disableFallback();
    expect(v.getFallbackState().fallbackReverts).toBe(2);
  });

  it('counts replays on successful dispatch only', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(null, 'usage-limit')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.replayTurnOnFallback = vi.fn(async () => {});

    expect(v.getFallbackState().fallbackReplays).toBe(0);
    v.scheduleFallbackReplay({
      activation: { ...activation, extended: true },
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    });
    expect(v.getFallbackState().fallbackReplays).toBe(0);
    v.scheduleFallbackReplay({
      activation,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    });
    expect(v.getFallbackState().fallbackReplays).toBe(1);
  });
});
