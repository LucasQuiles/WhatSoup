/**
 * Fallback recovery-probe stall cap + surfacing.
 *
 * The revert-timer path extends an auth-required fallback window forever while
 * the primary recovery probe keeps failing. These tests pin the hardening:
 *   - fallbackProbeAttempts increments per failed probe in the revert-timer path
 *   - one fallback_recovery_stalled alert at the threshold (default 12), never
 *     before
 *   - re-alert fires again at 2T, 3T, ... (multiples of the threshold)
 *   - a successful probe / deactivation resets the counter
 *   - the window STILL extends past the threshold (the cap surfaces, it does
 *     not strand the instance on a dead primary)
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
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
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
  fallbackWindow: { activeUntil: number | null };
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
  getFallbackState(): {
    fallbackActiveUntil: number | null;
    probeAttempts: number;
    lastProbeAt: number | null;
  };
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

function stallAlerts(): unknown[][] {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === 'fallback_recovery_stalled');
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

  it('(b) emits fallback_recovery_stalled at threshold, not before, and includes attempts=N in evidence', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe); // attempt 1

    // Attempts 2..threshold-1: no alert yet.
    for (let attempt = 2; attempt < STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      expect(v.fallbackProbeAttempts).toBe(attempt);
    }
    expect(stallAlerts()).toHaveLength(0);

    // Attempt = threshold: exactly one alert, with secret-free evidence.
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackProbeAttempts).toBe(STALL_THRESHOLD);
    const alerts = stallAlerts();
    expect(alerts).toHaveLength(1);
    const [instance, source, , evidence] = alerts[0] as [string, string, string, string];
    expect(instance).toBe('test');
    expect(source).toBe('fallback_recovery_stalled');
    expect(evidence).toContain('reason=auth-required');
    expect(evidence).toContain(`attempts=${STALL_THRESHOLD}`);
    expect(evidence).toContain('windowEnd=');
    expect(evidence).toContain('primaryProvider=claude-cli');
    expect(evidence).not.toContain('present-key');

    // Attempt = threshold+1: no re-alert (not a multiple of T yet).
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackProbeAttempts).toBe(STALL_THRESHOLD + 1);
    expect(stallAlerts()).toHaveLength(1);
  });

  it('(b2) re-alerts at 2T, 3T, ... — cadenced re-surfacing within the same stall episode', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe); // attempt 1

    // Advance to threshold.
    for (let attempt = 2; attempt <= STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(stallAlerts()).toHaveLength(1);

    // Advance from T+1 to 2T-1: no second alert yet.
    for (let attempt = STALL_THRESHOLD + 1; attempt < 2 * STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(stallAlerts()).toHaveLength(1);

    // At exactly 2T: second alert fires, evidence includes attempts=2T.
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.fallbackProbeAttempts).toBe(2 * STALL_THRESHOLD);
    const alerts = stallAlerts();
    expect(alerts).toHaveLength(2);
    const [, , , evidence2] = alerts[1] as [string, string, string, string];
    expect(evidence2).toContain(`attempts=${2 * STALL_THRESHOLD}`);

    // Advance to 3T: third alert fires.
    for (let attempt = 2 * STALL_THRESHOLD + 1; attempt <= 3 * STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(stallAlerts()).toHaveLength(3);
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

    // A fresh stall episode counts from zero and may alert again at threshold.
    await enterExtensionPhase(v, probe);
    expect(v.fallbackProbeAttempts).toBe(1);
    for (let attempt = 2; attempt <= STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(stallAlerts()).toHaveLength(1);
  });

  it('(e) the window STILL extends past the threshold — the cap surfaces, it never strands', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    await enterExtensionPhase(v, probe);
    for (let attempt = 2; attempt <= STALL_THRESHOLD + 3; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(v.fallbackProbeAttempts).toBe(STALL_THRESHOLD + 3);
    expect(v.fallbackWindow.activeUntil).not.toBeNull();
    expect(v.fallbackWindow.activeUntil!).toBeGreaterThan(Date.now());
    expect(v.effectiveProvider).toBe('opencode-cli');
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

  it('(g3) failed early-window probes do not count toward the stall threshold (window not yet expired)', async () => {
    const runtime = makeRuntime();
    const v = view(runtime);
    const probe = vi.fn(() => false);
    v.probePrimaryProviderRecovered = probe as unknown as () => boolean;
    v.activateProviderFallback(null, 'auth-required'); // default 5h window

    await vi.advanceTimersByTimeAsync(3 * RECHECK_MS);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
    // The window has not expired — nothing is extending — so this is not a
    // stall episode; the counter measures consecutive extension probes only.
    expect(v.fallbackProbeAttempts).toBe(0);
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
    expect(v.fallbackProbeAttempts).toBe(0);
    expect(v.fallbackPrimaryProbeTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(v.fallbackWindow.activeUntil).not.toBeNull();
    expect(v.fallbackProbeAttempts).toBe(0);
  });
});
