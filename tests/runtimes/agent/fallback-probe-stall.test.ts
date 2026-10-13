/**
 * Fallback recovery-probe stall cap + surfacing.
 *
 * Primary recovery is bounded while the fallback route remains available.
 * These tests pin the hardening:
 *   - each failed primary recovery probe consumes the bounded episode budget
 *   - the twelfth failure or 24 elapsed hours terminalizes automation
 *   - a successful fresh probe / explicit retry begins the appropriate state
 *   - terminal and held recovery keep the fallback route in place
 *   - getFallbackState carries probeAttempts / lastProbeAt
 *   - the double-probe is collapsed: exactly one probe per recheck cadence
 *     during the extension phase, while early recovery during a long initial
 *     window is preserved
 *
 * Harness mirrors provider-fallback.test.ts (fake timers, mocked emitAlert,
 * mocked credential/binary preflights, instance-level probe spy — the probe
 * spawns a real binary otherwise).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  const clearAlertSource = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    emitObservationChecked: vi.fn(() => true),
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

// ─── Mocks (declared before importing the runtime) ────────────────────────────

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    // #2192 s4b: provider-fallback tunables live on config (defaults mirror the retired IIFEs).
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-probe-stall/tmp',
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
  (globalThis as Record<string, unknown>)['__probeStallTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__probeStallTestConfig__'] as Record<string, unknown>;
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
// fallback_credential_missing alert so stall-alert assertions stay clean.
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

const RECHECK_MS = 5 * 60 * 1000; // PROVIDER_FALLBACK_PRIMARY_RECHECK_MS default
const STALL_THRESHOLD = 12; // WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD default

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

/** Bracket-access view of the private fallback state machine. */
type FallbackView = {
  fallbackWindow: {
    activeUntil: number | null;
    recoveryEpisodeStartedAt: number | null;
    recoveryState: 'active' | 'terminal' | 'operator-held' | 'unavailable';
  };
  fallbackProbeAttempts: number;
  fallbackLastProbeAt: number | null;
  fallbackPrimaryProbeTimer: ReturnType<typeof setTimeout> | null;
  revertTimer: ReturnType<typeof setTimeout> | null;
  effectiveProvider: string;
  probePrimaryProviderRecovered(): boolean | Promise<boolean>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'server-error',
  ): unknown;
  deactivateProviderFallback(reason: string): void;
  disableFallback(): { ok: true } | { ok: false; reason: string };
  holdFallbackRecovery(): { ok: true } | { ok: false; reason: string };
  retryFallbackRecovery(): { ok: true } | { ok: false; reason: string };
  recoverPrimaryFromFallback(): Promise<{ ok: true } | { ok: false; reason: string }>;
  getFallbackState(): {
    fallbackActiveUntil: number | null;
    probeAttempts: number;
    lastProbeAt: number | null;
    recoveryState: 'active' | 'terminal' | 'operator-held' | 'unavailable';
    recoveryTerminalReason: 'attempt-limit' | 'elapsed-limit' | 'clock-anomaly' | 'probe-outcome-unknown' | 'operator-killed' | 'operator-recovery-failed' | 'failed-provider-evidence-unavailable' | null;
    fallbackReplays: number;
  };
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

function stallAlerts(): unknown[][] {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === 'fallback_recovery_stalled');
}

function terminalAlerts(): unknown[][] {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === 'fallback_recovery_terminal');
}

/** Activate an auth-required fallback whose window ends at the MIN clamp
 *  (1 min — below the 5 min recheck cadence), then expire it so the
 *  revert-timer extension phase is entered with one failed probe recorded. */
async function enterExtensionPhase(v: FallbackView, probe: ReturnType<typeof vi.fn>): Promise<void> {
  v.probePrimaryProviderRecovered = probe as unknown as () => boolean;
  v.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required'); // clamps to +1 min
  await vi.advanceTimersByTimeAsync(60 * 1000 + 1); // revert timer fires → first probe
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRuntime — fallback recovery-probe stall cap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) increments fallbackProbeAttempts per failed probe in the revert-timer path', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe);
    expect(v.fallbackProbeAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackProbeAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackProbeAttempts).toBe(3);
  });

  it('(b) emits a terminal recovery alert at the attempt bound with secret-free evidence', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe); // attempt 1

    // Attempts 2..threshold-1: no terminal alert yet.
    for (let attempt = 2; attempt < STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      expect(v.fallbackProbeAttempts).toBe(attempt);
    }
    expect(terminalAlerts()).toHaveLength(0);

    // Attempt = threshold: exactly one terminal alert, with secret-free evidence.
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackProbeAttempts).toBe(STALL_THRESHOLD);
    const alerts = terminalAlerts();
    expect(alerts).toHaveLength(1);
    const [instance, source, , evidence] = alerts[0] as [string, string, string, string];
    expect(instance).toBe('test');
    expect(source).toBe('fallback_recovery_terminal');
    expect(evidence).toContain('reason=attempt-limit');
    expect(evidence).toContain(`attempts=${STALL_THRESHOLD}`);
    expect(evidence).toContain('accepted_work_replay=false');
    expect(evidence).not.toContain('present-key');

    // No automatic attempt occurs after the terminal transition.
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackProbeAttempts).toBe(STALL_THRESHOLD);
    expect(terminalAlerts()).toHaveLength(1);
  });

  it('(b2) terminates without probing when the recovery episode reaches 24 elapsed hours', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    v.probePrimaryProviderRecovered = probe as unknown as () => Promise<boolean>;
    v.activateProviderFallback(new Date(Date.now() + 1_000), 'auth-required');
    v.fallbackWindow.recoveryEpisodeStartedAt = Date.now() - 24 * 60 * 60 * 1000;

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);

    expect(probe).not.toHaveBeenCalled();
    expect(v.fallbackProbeAttempts).toBe(0);
    expect(v.getFallbackState().recoveryState).toBe('terminal');
    expect(v.getFallbackState().recoveryTerminalReason).toBe('elapsed-limit');
  });

  it('(b2a) treats exactly 24 elapsed hours as terminal before probing', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    v.probePrimaryProviderRecovered = probe as unknown as () => Promise<boolean>;
    v.activateProviderFallback(new Date(Date.now() + 1_000), 'auth-required');
    // The revert timer fires exactly one minute later, at which point the
    // episode is exactly 24h old — the boundary itself is terminal.
    v.fallbackWindow.recoveryEpisodeStartedAt = Date.now() - (24 * 60 * 60 * 1000 - 60 * 1000);

    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(probe).not.toHaveBeenCalled();
    expect(v.getFallbackState().recoveryTerminalReason).toBe('elapsed-limit');
  });

  it('(b2b) holds recovery on a backward-clock anomaly before probing', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    v.probePrimaryProviderRecovered = probe as unknown as () => Promise<boolean>;
    v.activateProviderFallback(new Date(Date.now() + 1_000), 'auth-required');
    v.fallbackWindow.recoveryEpisodeStartedAt = Date.now() + 60 * 1000 + 1;

    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(probe).not.toHaveBeenCalled();
    expect(v.getFallbackState().recoveryState).toBe('terminal');
    expect(v.getFallbackState().recoveryTerminalReason).toBe('clock-anomaly');
  });

  it('(b3) terminates the recovery episode at the twelfth failed probe and does not schedule another automatic retry', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe);

    for (let attempt = 2; attempt <= STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }

    const state = v.getFallbackState();
    expect(probe).toHaveBeenCalledTimes(STALL_THRESHOLD);
    expect(state.probeAttempts).toBe(STALL_THRESHOLD);
    expect(state.recoveryState).toBe('terminal');
    expect(state.recoveryTerminalReason).toBe('attempt-limit');
    expect(v.revertTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(probe).toHaveBeenCalledTimes(STALL_THRESHOLD);
    expect(v.getFallbackState().recoveryState).toBe('terminal');
  });

  it('(c) a successful probe reverts to primary, resets attempts, and emits no stall alert', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe);
    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 2
    expect(v.fallbackProbeAttempts).toBe(2);

    probe.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackWindow.activeUntil).toBeNull();
    expect(v.effectiveProvider).toBe('claude-cli');
    expect(v.fallbackProbeAttempts).toBe(0);
    expect(stallAlerts()).toHaveLength(0);
  });

  it('(d) deactivation resets the attempt counter (new episode alerts again)', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackProbeAttempts).toBe(2);

    v.deactivateProviderFallback('manual');
    expect(v.fallbackProbeAttempts).toBe(0);
    expect(v.getFallbackState().probeAttempts).toBe(0);

    // The new episode starts cleanly, then its first failed probe counts as one.
    await enterExtensionPhase(v, probe);
    expect(v.fallbackProbeAttempts).toBe(1);
    for (let attempt = 2; attempt <= STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(terminalAlerts()).toHaveLength(1);
  });

  it('(e) preserves the fallback route at the terminal bound while stopping automatic primary probes', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe);
    for (let attempt = 2; attempt <= STALL_THRESHOLD + 3; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(v.fallbackProbeAttempts).toBe(STALL_THRESHOLD);
    expect(v.fallbackWindow.activeUntil).not.toBeNull();
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.getFallbackState().recoveryState).toBe('terminal');
  });

  it('(f) getFallbackState carries probeAttempts and lastProbeAt', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);

    // Before any probe: zero attempts, null lastProbeAt.
    expect(v.getFallbackState().probeAttempts).toBe(0);
    expect(v.getFallbackState().lastProbeAt).toBeNull();

    const probe = vi.fn(() => false);
    const armAt = Date.now();
    await enterExtensionPhase(v, probe);
    const firstProbeAt = armAt + 60 * 1000; // the revert timer fires AT window end
    let state = v.getFallbackState();
    expect(state.probeAttempts).toBe(1);
    expect(state.lastProbeAt).toBe(firstProbeAt);

    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    state = v.getFallbackState();
    expect(state.probeAttempts).toBe(2);
    expect(state.lastProbeAt).toBe(firstProbeAt + RECHECK_MS);
  });

  it('(g) collapses the double-probe: exactly one probe per recheck cadence in the extension phase', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe);
    expect(probe).toHaveBeenCalledTimes(1);

    // Pre-fix, the revert timer AND the duplicate cadence probe both fire each
    // RECHECK_MS during the extension phase (2 probes per cadence).
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("(g2) preserves early recovery during a long initial window (the duplicate probe's unique value)", async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => true);
    v.probePrimaryProviderRecovered = probe as unknown as () => boolean;
    v.activateProviderFallback(null, 'auth-required'); // default 5h window
    expect(v.effectiveProvider).toBe('opencode-cli');

    // One recheck cadence in — far before the 5h window end — the standing
    // probe must fire, succeed, and revert to the primary early.
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(v.fallbackWindow.activeUntil).toBeNull();
    expect(v.effectiveProvider).toBe('claude-cli');
    expect(stallAlerts()).toHaveLength(0);
  });

  it.each(['usage-limit', 'rate-limit'] as const)(
    '(g2q) preserves early recovery for %s during a long initial window',
    async (reason) => {
      const runtime = makeRuntime();
      const v = view(runtime);
      const probe = vi.fn(() => true);
      v.probePrimaryProviderRecovered = probe as unknown as () => boolean;
      v.activateProviderFallback(null, reason); // default 5h window
      expect(v.effectiveProvider).toBe('opencode-cli');

      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(v.fallbackWindow.activeUntil).toBeNull();
      expect(v.effectiveProvider).toBe('claude-cli');
      expect(stallAlerts()).toHaveLength(0);
    },
  );

  it('(g2b) ignores a stale successful standing-probe result after the fallback window is re-armed', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    let resolveProbe: ((value: boolean) => void) | null = null;
    const probeResult = new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
    const probe = vi.fn(() => probeResult);
    v.probePrimaryProviderRecovered = probe as unknown as () => Promise<boolean>;

    v.activateProviderFallback(null, 'auth-required');
    const firstWindow = v.fallbackWindow.activeUntil;
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(probe).toHaveBeenCalledTimes(1);

    v.deactivateProviderFallback('test-rearm');
    v.activateProviderFallback(null, 'auth-required');
    const rearmedWindow = v.fallbackWindow.activeUntil;
    expect(rearmedWindow).not.toBe(firstWindow);

    resolveProbe!(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(v.fallbackWindow.activeUntil).toBe(rearmedWindow);
    expect(v.effectiveProvider).toBe('opencode-cli');
  });

  it('(g3) counts failed early-window probes toward the same bounded recovery episode', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    v.probePrimaryProviderRecovered = probe as unknown as () => boolean;
    v.activateProviderFallback(null, 'auth-required'); // default 5h window

    await vi.advanceTimersByTimeAsync(3 * RECHECK_MS);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(v.fallbackProbeAttempts).toBe(3);
    // lastProbeAt still tracks the standing probe for observability.
    expect(v.getFallbackState().lastProbeAt).toBe(Date.now());
  });

  it('(h) tolerates an async probe: Promise<false> extends the window instead of being treated as truthy recovery', async () => {
    // The real probe is an async child-process spawn; a Promise must never be
    // mistaken for a truthy sync result (which deactivated the window as if
    // the primary had recovered — the exact failure mode of the spawnSync
    // call sites before the async port).
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(async () => false);
    v.probePrimaryProviderRecovered = probe as unknown as () => Promise<boolean>;
    v.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required'); // clamps to +1 min

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1); // revert timer fires → async probe fails

    expect(probe).toHaveBeenCalledTimes(1);
    expect(v.fallbackWindow.activeUntil).not.toBeNull();
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.fallbackProbeAttempts).toBe(1);

    // And an async TRUE result still reverts (the recovered branch survives
    // the port too).
    probe.mockImplementation(async () => true);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackWindow.activeUntil).toBeNull();
    expect(v.effectiveProvider).toBe('claude-cli');
    expect(v.fallbackProbeAttempts).toBe(0);
  });

  it('(i) treats a throwing revert-timer probe as failed and keeps fallback armed', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => {
      throw new Error('probe exploded');
    });
    v.probePrimaryProviderRecovered = probe as unknown as () => boolean;
    v.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required');

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(v.fallbackWindow.activeUntil).not.toBeNull();
    expect(v.fallbackWindow.activeUntil!).toBeGreaterThan(Date.now());
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.fallbackProbeAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(v.fallbackProbeAttempts).toBe(2);
  });

  it('(j) ignores a stale successful revert-timer probe result after the fallback window is re-armed', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    let resolveProbe: ((value: boolean) => void) | null = null;
    const probeResult = new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
    const probe = vi.fn(() => probeResult);
    v.probePrimaryProviderRecovered = probe as unknown as () => Promise<boolean>;
    const deactivateSpy = vi.spyOn(v, 'deactivateProviderFallback');

    v.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required');
    const firstWindow = v.fallbackWindow.activeUntil;
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    expect(probe).toHaveBeenCalledTimes(1);

    v.deactivateProviderFallback('test-rearm');
    v.activateProviderFallback(null, 'auth-required');
    deactivateSpy.mockClear();
    const rearmedWindow = v.fallbackWindow.activeUntil;
    expect(rearmedWindow).not.toBe(firstWindow);

    resolveProbe!(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deactivateSpy).not.toHaveBeenCalled();
    expect(v.fallbackWindow.activeUntil).toBe(rearmedWindow);
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.fallbackProbeAttempts).toBe(0);
  });

  it('(k) treats a throwing standing probe as failed without ending the early-recovery cadence', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => {
      throw new Error('standing probe exploded');
    });
    v.probePrimaryProviderRecovered = probe as unknown as () => boolean;
    v.activateProviderFallback(null, 'auth-required');

    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(v.fallbackWindow.activeUntil).not.toBeNull();
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.fallbackProbeAttempts).toBe(1);
    expect(v.fallbackPrimaryProbeTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(v.fallbackWindow.activeUntil).not.toBeNull();
    expect(v.fallbackProbeAttempts).toBe(2);
  });

  it('(l) requires explicit controls and fresh primary proof before returning from a held fallback route', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    v.activateProviderFallback(null, 'auth-required');
    expect(v.effectiveProvider).toBe('opencode-cli');

    expect(v.holdFallbackRecovery()).toEqual({ ok: true });
    expect(v.getFallbackState().recoveryState).toBe('operator-held');
    expect(v.getFallbackState().recoveryTerminalReason).toBe('operator-killed');
    expect(v.disableFallback()).toMatchObject({ ok: false });
    expect(v.effectiveProvider).toBe('opencode-cli');

    expect(v.retryFallbackRecovery()).toEqual({ ok: true });
    expect(v.getFallbackState().recoveryState).toBe('active');
    expect(v.getFallbackState().probeAttempts).toBe(0);
    expect(v.getFallbackState().fallbackReplays).toBe(0);

    const failingProof = vi.fn(() => false);
    v.probePrimaryProviderRecovered = failingProof as unknown as () => Promise<boolean>;
    await expect(v.recoverPrimaryFromFallback()).resolves.toMatchObject({ ok: false });
    expect(failingProof).toHaveBeenCalledTimes(1);
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.getFallbackState().recoveryState).toBe('operator-held');
    expect(v.getFallbackState().recoveryTerminalReason).toBe('operator-recovery-failed');
    expect(v.getFallbackState().fallbackReplays).toBe(0);

    const freshProof = vi.fn(() => true);
    v.probePrimaryProviderRecovered = freshProof as unknown as () => Promise<boolean>;
    await expect(v.recoverPrimaryFromFallback()).resolves.toEqual({ ok: true });
    expect(freshProof).toHaveBeenCalledTimes(1);
    expect(v.effectiveProvider).toBe('claude-cli');
    expect(v.getFallbackState().fallbackReplays).toBe(0);
  });

  it('(m) keeps the fallback route held when KILL wins a pending manual recovery probe', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    v.activateProviderFallback(null, 'auth-required');

    let resolveProbe: ((value: boolean) => void) | null = null;
    const pendingProbe = new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
    const probe = vi.fn(() => pendingProbe);
    v.probePrimaryProviderRecovered = probe as unknown as () => Promise<boolean>;

    const recovering = v.recoverPrimaryFromFallback();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(v.holdFallbackRecovery()).toEqual({ ok: true });

    resolveProbe!(true);
    await expect(recovering).resolves.toMatchObject({ ok: false });
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.getFallbackState().recoveryState).toBe('operator-held');
    expect(v.getFallbackState().recoveryTerminalReason).toBe('operator-killed');
    expect(v.getFallbackState().fallbackReplays).toBe(0);
  });

  it('(n) keeps the fallback route held when KILL wins a pending automatic recovery probe', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    let resolveProbe: ((value: boolean) => void) | null = null;
    const pendingProbe = new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    });
    const probe = vi.fn(() => pendingProbe);
    v.probePrimaryProviderRecovered = probe as unknown as () => Promise<boolean>;
    v.activateProviderFallback(new Date(Date.now() + 1_000), 'auth-required');

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(v.holdFallbackRecovery()).toEqual({ ok: true });

    resolveProbe!(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(v.effectiveProvider).toBe('opencode-cli');
    expect(v.getFallbackState().recoveryState).toBe('operator-held');
    expect(v.getFallbackState().recoveryTerminalReason).toBe('operator-killed');
  });
});
