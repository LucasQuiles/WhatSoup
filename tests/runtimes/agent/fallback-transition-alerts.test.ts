/**
 * Fallback transition observability: alert sources + process-local counters.
 *
 * Every fallback state transition used to be log-only; these tests pin the
 * countable surfaces (decision-journal principle: expensive paths must be
 * countable report fields, never just logs):
 *   - provider_fallback_activated fires exactly once per window, on the FIRST
 *     arm only (fallbackArmReason null-guard) — never on extensions
 *   - provider_fallback_reverted fires on deactivation with reason, PER-WINDOW
 *     turn counters (deltas against an arm-time snapshot — never the lifetime
 *     totals), and window duration in the evidence — never when idle
 *   - provider_fallback_replayed fires only after the replay COMPLETES —
 *     never on gate-rejected replays (extended-with-expired-window /
 *     key-absent / tool activity) and never for a replay that fails
 *   - restoring a persisted window after a restart re-arms WITHOUT re-counting
 *     or re-emitting activation (the pre-restart arm already did; the
 *     once-per-window contract spans restarts)
 *   - fallbackActivations / fallbackReverts / fallbackReplays count
 *     lifetime-of-process totals and surface via getFallbackState
 *
 * Harness mirrors fallback-probe-stall.test.ts (fake timers, mocked emitAlert,
 * mocked credential/binary preflights, deterministic keyring).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Overridable persisted-window source for the restore-path tests; all other
// fallback-state-db functions keep their real implementations (they are
// harmless against the mocked db).
const { loadFallbackStateMock } = vi.hoisted(() => ({
  loadFallbackStateMock: vi.fn<() => unknown>(() => null),
}));
vi.mock('../../../src/runtimes/agent/fallback-state-db.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/fallback-state-db.ts')>();
  return {
    ...actual,
    loadFallbackState: () => loadFallbackStateMock(),
  };
});

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
import { emitAlert, clearAlertSource } from '../../../src/lib/emit-alert.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  reason: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error';
  resetAt: Date | null;
  activeUntil: number;
  extended: boolean;
  keyPresent: boolean | null;
  recoveryProbeRequired: boolean;
};

/** Bracket-access view of the private fallback state machine. */
type FallbackView = {
  fallbackWindow: { activeUntil: number | null };
  fallbackMetrics: { turnsServed: number; turnsEmpty: number };
  effectiveProvider: string;
  pendingTurnText: Map<string, string>;
  pendingTurnActorJid: Map<string, string | undefined>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error',
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
  restorePersistedFallbackWindow(): void;
  getFallbackState(): {
    fallbackActiveUntil: number | null;
    fallbackTurnsServed: number;
    fallbackTurnsEmpty: number;
    fallbackActivations: number;
    fallbackReverts: number;
    fallbackReplays: number;
  };
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

function alertsFor(source: string): Array<[string, string, string, string, string?]> {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === source) as Array<
    [string, string, string, string, string?]
  >;
}

function clearsFor(source: string): Array<[string, string, string]> {
  return vi.mocked(clearAlertSource).mock.calls.filter((c) => c[1] === source) as Array<
    [string, string, string]
  >;
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

    v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'model-unavailable'); // +1h
    const activated = alertsFor('provider_fallback_activated');
    expect(activated).toHaveLength(1);
    const [instance, source, , evidence, severity] = activated[0];
    expect(instance).toBe('test');
    expect(source).toBe('provider_fallback_activated');
    // Activation is a FAULT (primary provider failed) — keeps the critical
    // default. Asymmetry with the revert (info) is the point.
    expect(severity ?? 'critical').toBe('critical');
    expect(evidence).toContain('reason=model-unavailable');
    expect(evidence).toContain('provider=opencode-cli');
    expect(evidence).toContain('model=minimax/MiniMax-M2.7');
    expect(evidence).toContain('until=2026-06-10T11:00:00.000Z');
    expect(evidence).not.toContain('present-key');

    // Extension of the active window: no second activation alert.
    const extended = v.activateProviderFallback(new Date(Date.now() + 3 * 60 * 60 * 1000), 'model-unavailable')!;
    expect(extended.extended).toBe(true);
    expect(alertsFor('provider_fallback_activated')).toHaveLength(1);
  });

  it('emits provider_fallback_reverted on window-elapsed with reason, per-window turn counters, and window duration', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'model-unavailable'); // +1h
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(0);
    v.fallbackMetrics.turnsServed = 3;
    v.fallbackMetrics.turnsEmpty = 1;

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(v.fallbackWindow.activeUntil).toBeNull();
    const reverted = alertsFor('provider_fallback_reverted');
    expect(reverted).toHaveLength(1);
    const [instance, , , evidence, severity] = reverted[0];
    expect(instance).toBe('test');
    // A revert is a RECOVERY — it must emit at info, never the critical
    // default. Pre-fix this paged "Q investigate, remediate" for clean cycles.
    expect(severity).toBe('info');
    expect(evidence).toContain('reason=window-elapsed');
    expect(evidence).toContain('turnsServed=3');
    expect(evidence).toContain('turnsEmpty=1');
    expect(evidence).toContain('windowMs=3600000');

    // Recovery clears the activation incident this window opened.
    const cleared = clearsFor('provider_fallback_activated');
    expect(cleared).toHaveLength(1);
    expect(cleared[0][0]).toBe('test');
  });

  it('reports per-window turn DELTAS in revert evidence — window 2 never re-reports window 1 turns', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    // Window 1: 3 turns served (1 empty), then elapse.
    v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'model-unavailable'); // +1h
    v.fallbackMetrics.turnsServed = 3;
    v.fallbackMetrics.turnsEmpty = 1;
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    const first = alertsFor('provider_fallback_reverted');
    expect(first).toHaveLength(1);
    expect(first[0][3]).toContain('turnsServed=3');
    expect(first[0][3]).toContain('turnsEmpty=1');

    // Window 2 in the SAME process: 2 more turns (1 empty). The lifetime
    // counters keep accruing (5/2 — getFallbackState contract), but the
    // revert evidence must report only THIS window's delta (2/1).
    v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'model-unavailable');
    v.fallbackMetrics.turnsServed = 5;
    v.fallbackMetrics.turnsEmpty = 2;
    runtime.disableFallback();

    const reverted = alertsFor('provider_fallback_reverted');
    expect(reverted).toHaveLength(2);
    expect(reverted[1][3]).toContain('turnsServed=2');
    expect(reverted[1][3]).toContain('turnsEmpty=1');

    // The lifetime getter semantics are unchanged: totals, never deltas.
    const state = v.getFallbackState();
    expect(state.fallbackTurnsServed).toBe(5);
    expect(state.fallbackTurnsEmpty).toBe(2);
  });

  it('emits provider_fallback_reverted on admin-disabled deactivation', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    v.activateProviderFallback(null, 'model-unavailable');
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

  it('emits provider_fallback_replayed after a successful replay with reason and target entry', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(null, 'model-unavailable')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.pendingTurnActorJid.set('chat-key', 'sender@s.whatsapp.net');
    v.replayTurnOnFallback = vi.fn(async () => {});

    expect(v.scheduleFallbackReplay({
      activation,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(true);
    // The alert reports a COMPLETED action: nothing may be emitted at
    // dispatch time, only after the replay resolves (pins the timing — a
    // revert to emit-before-await fails here).
    expect(alertsFor('provider_fallback_replayed')).toHaveLength(0);
    expect(v.getFallbackState().fallbackReplays).toBe(0);
    await vi.runAllTimersAsync();

    const replayed = alertsFor('provider_fallback_replayed');
    expect(replayed).toHaveLength(1);
    const [instance, , , evidence] = replayed[0];
    expect(instance).toBe('test');
    expect(evidence).toContain('reason=model-unavailable');
    expect(evidence).toContain('provider=opencode-cli');
    expect(evidence).toContain('model=minimax/MiniMax-M2.7');
    expect(v.getFallbackState().fallbackReplays).toBe(1);
  });

  it('a FAILED replay emits only the failure alert — never provider_fallback_replayed, never the counter', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(null, 'model-unavailable')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.pendingTurnActorJid.set('chat-key', 'sender@s.whatsapp.net');
    v.replayTurnOnFallback = vi.fn(async () => {
      throw new Error('fallback provider refused the turn');
    });

    // Dispatch still happens (the gates passed), so schedule returns true...
    expect(v.scheduleFallbackReplay({
      activation,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(true);
    await vi.runAllTimersAsync();

    // ...but the telemetry must not claim a replay happened: success-and-
    // failure for the same turn is contradictory.
    expect(alertsFor('provider_fallback_replayed')).toHaveLength(0);
    expect(v.getFallbackState().fallbackReplays).toBe(0);
    expect(alertsFor('runtime_provider_fallback_replay_failed')).toHaveLength(1);
  });

  it('does NOT emit provider_fallback_replayed on gate-rejected replays', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(null, 'model-unavailable')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.replayTurnOnFallback = vi.fn(async () => {});

    // Gate 1: an extended fallback with an EXPIRED window does not replay
    // (target route not usable — the #2354 route-aware safety gate).
    expect(v.scheduleFallbackReplay({
      activation: {
        ...activation,
        extended: true,
        activeUntil: Date.now() - 1000, // expired
      },
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

  // ── #2354: already-active fallback replay eligibility ──────────────

  it('replays a retained turn when an already-active fallback is usable and distinct (#2354)', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    // First activation arms the fallback (extended=false).
    const initial = v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'usage-limit')!;
    expect(initial.extended).toBe(false);

    // Second activation while window is active → extended=true (primary failed again).
    const extended = v.activateProviderFallback(new Date(Date.now() + 2 * 60 * 60 * 1000), 'usage-limit')!;
    expect(extended.extended).toBe(true);
    expect(extended.fallbackProvider).not.toBe(extended.primaryProvider);

    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.replayTurnOnFallback = vi.fn(async () => {});

    // Under the old gate, extended=true would reject. Under #2354, the retained
    // turn replays to the healthy, distinct, still-active fallback exactly once.
    const scheduled = v.scheduleFallbackReplay({
      activation: extended,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    });
    expect(scheduled).toBe(true);
    // Shadow decision alert fires to record eligibility for promotion monitoring.
    expect(alertsFor('provider_fallback_extended_replay_eligible')).toHaveLength(1);
  });

  it('does NOT replay an extended turn when the fallback target is the same as the failing primary', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'usage-limit')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.replayTurnOnFallback = vi.fn(async () => {});

    // Simulate the pathological case: fallback target == primary provider.
    // The route-aware gate must suppress replay (no distinct usable target).
    expect(v.scheduleFallbackReplay({
      activation: {
        ...activation,
        extended: true,
        fallbackProvider: activation.primaryProvider, // same provider!
      },
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(false);
    expect(alertsFor('provider_fallback_extended_replay_suppressed')).toHaveLength(1);
    expect(v.replayTurnOnFallback).not.toHaveBeenCalled();
  });

  it('does NOT replay an extended turn when the fallback window has expired', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'usage-limit')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.replayTurnOnFallback = vi.fn(async () => {});

    expect(v.scheduleFallbackReplay({
      activation: {
        ...activation,
        extended: true,
        activeUntil: Date.now() - 1, // expired
      },
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(false);
    expect(alertsFor('provider_fallback_extended_replay_suppressed')).toHaveLength(1);
    expect(v.replayTurnOnFallback).not.toHaveBeenCalled();
  });

  it('LabRatQ challenge: extended replay suppressed when visible output was already delivered (no duplicate)', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'usage-limit')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    // The turn already delivered visible output — replaying would duplicate it.
    v.perChatTurnText.set('chat-key', 'previous visible reply');
    v.replayTurnOnFallback = vi.fn(async () => {});

    expect(v.scheduleFallbackReplay({
      activation: { ...activation, extended: true },
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    })).toBe(false);
    expect(alertsFor('provider_fallback_replayed')).toHaveLength(0);
    expect(v.replayTurnOnFallback).not.toHaveBeenCalled();
  });

  it('LabRatQ challenge: extended replay suppressed when tool activity already started', () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'usage-limit')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.replayTurnOnFallback = vi.fn(async () => {});

    expect(v.scheduleFallbackReplay({
      activation: { ...activation, extended: true },
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
      hadToolActivity: true,
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
    v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'model-unavailable');
    v.activateProviderFallback(new Date(Date.now() + 2 * 60 * 60 * 1000), 'model-unavailable');
    expect(v.getFallbackState().fallbackActivations).toBe(1);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);
    expect(v.getFallbackState().fallbackReverts).toBe(1);

    // Window 2: activate, then admin-disable. Counters accumulate — no reset.
    v.activateProviderFallback(null, 'model-unavailable');
    expect(v.getFallbackState().fallbackActivations).toBe(2);
    runtime.disableFallback();
    expect(v.getFallbackState().fallbackReverts).toBe(2);

    // Idempotent deactivation does not count.
    runtime.disableFallback();
    expect(v.getFallbackState().fallbackReverts).toBe(2);
  });

  it('counts completed replays only', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    const activation = v.activateProviderFallback(null, 'model-unavailable')!;
    v.pendingTurnText.set('chat-key', 'please continue the task');
    v.replayTurnOnFallback = vi.fn(async () => {});

    expect(v.getFallbackState().fallbackReplays).toBe(0);
    // A gate-rejected replay (absent key) does not count.
    v.scheduleFallbackReplay({
      activation: { ...activation, keyPresent: false },
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    });
    await vi.runAllTimersAsync();
    expect(v.getFallbackState().fallbackReplays).toBe(0);
    // An eligible replay counts on completion.
    v.scheduleFallbackReplay({
      activation,
      chatJid: 'chat@s.whatsapp.net',
      mapKey: 'chat-key',
      oldSession: null,
    });
    await vi.runAllTimersAsync();
    expect(v.getFallbackState().fallbackReplays).toBe(1);
  });
});

// ─── Restore-path telemetry (restart resumes a persisted window) ──────────────

describe('AgentRuntime — fallback window restore telemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
    loadFallbackStateMock.mockReturnValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    loadFallbackStateMock.mockReturnValue(null);
  });

  it('restoring a persisted window re-arms WITHOUT re-counting or re-emitting activation', () => {
    const until = Date.now() + 60 * 60 * 1000;
    loadFallbackStateMock.mockReturnValue({
      activeUntil: until,
      activatedAt: Date.now() - 30 * 60 * 1000,
      reason: 'model-unavailable',
    });
    const runtime = makeRuntime();
    const v = view(runtime);

    v.restorePersistedFallbackWindow();

    // The window IS restored and armed...
    expect(v.fallbackWindow.activeUntil).toBe(until);
    // ...but the activation alert + counter belong to the pre-restart arm:
    // "exactly once per window" spans restarts.
    expect(alertsFor('provider_fallback_activated')).toHaveLength(0);
    expect(v.getFallbackState().fallbackActivations).toBe(0);
  });

  it('emits provider_fallback_restored (additive source) when a persisted window is restored', () => {
    const until = Date.now() + 60 * 60 * 1000;
    loadFallbackStateMock.mockReturnValue({
      activeUntil: until,
      activatedAt: Date.now() - 30 * 60 * 1000,
      reason: 'model-unavailable',
    });
    const runtime = makeRuntime();
    const v = view(runtime);

    v.restorePersistedFallbackWindow();

    const restored = alertsFor('provider_fallback_restored');
    expect(restored).toHaveLength(1);
    const [instance, source, , evidence] = restored[0];
    expect(instance).toBe('test');
    expect(source).toBe('provider_fallback_restored');
    expect(evidence).toContain('reason=model-unavailable');
    expect(evidence).toContain('provider=opencode-cli');
    expect(evidence).toContain('model=minimax/MiniMax-M2.7');
    expect(evidence).toContain('until=2026-06-10T11:00:00.000Z');
    expect(evidence).not.toContain('present-key');
    // The restore alert is a RESTORE, never an activation.
    expect(alertsFor('provider_fallback_activated')).toHaveLength(0);
    expect(v.getFallbackState().fallbackActivations).toBe(0);
  });

  it('three restarts of one window: exactly one activated + two restored (the crash-loop repro)', () => {
    // Process 1: the window first arms — the one true activation.
    const first = makeRuntime();
    view(first).activateProviderFallback(new Date(Date.now() + 2 * 60 * 60 * 1000), 'model-unavailable');
    expect(alertsFor('provider_fallback_activated')).toHaveLength(1);

    // The window persists; two subsequent process restarts restore it.
    const persisted = {
      activeUntil: Date.now() + 2 * 60 * 60 * 1000,
      activatedAt: Date.now(),
      reason: 'model-unavailable',
    };
    loadFallbackStateMock.mockReturnValue(persisted);
    for (let restart = 0; restart < 2; restart++) {
      const restartedRuntime = makeRuntime();
      view(restartedRuntime).restorePersistedFallbackWindow();
      expect(view(restartedRuntime).getFallbackState().fallbackActivations).toBe(0);
    }

    // Pre-fix this repro produced 3 activation alerts; the contract is
    // 1 activated + 2 restored across the three processes.
    expect(alertsFor('provider_fallback_activated')).toHaveLength(1);
    expect(alertsFor('provider_fallback_restored')).toHaveLength(2);
  });

  it('a fresh window after the restored one reverts still counts and emits once', () => {
    const until = Date.now() + 60 * 60 * 1000;
    loadFallbackStateMock.mockReturnValue({
      activeUntil: until,
      activatedAt: Date.now() - 30 * 60 * 1000,
      reason: 'model-unavailable',
    });
    const runtime = makeRuntime();
    const v = view(runtime);
    v.restorePersistedFallbackWindow();

    // The restore arm snapshots the (fresh-process, zero) turn counters too,
    // so the restored window's revert reports the turns served since restart.
    v.fallbackMetrics.turnsServed = 2;
    v.fallbackMetrics.turnsEmpty = 1;

    // Restored window expires → reverts (and clears fallbackArmReason).
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(v.fallbackWindow.activeUntil).toBeNull();
    const reverted = alertsFor('provider_fallback_reverted');
    expect(reverted).toHaveLength(1);
    expect(reverted[0][3]).toContain('turnsServed=2');
    expect(reverted[0][3]).toContain('turnsEmpty=1');

    // A genuinely new window must still alert + count exactly once — the
    // restore suppression must not over-suppress future activations.
    v.activateProviderFallback(new Date(Date.now() + 60 * 60 * 1000), 'rate-limit');
    expect(alertsFor('provider_fallback_activated')).toHaveLength(1);
    expect(v.getFallbackState().fallbackActivations).toBe(1);
  });
});
