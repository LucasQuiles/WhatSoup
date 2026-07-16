/**
 * Empty-output ARMS provider fallback (root-cause fix for the silent
 * auth-break degraded loop).
 *
 * A primary whose auth/session is broken (e.g. claude-cli after a silent CLI
 * auto-update invalidated its keychain login) exits cleanly with NO text on
 * every turn. There is no provider-failure MESSAGE to classify, so the normal
 * text-driven arming path never fires — historically the bot stayed pinned to
 * the dead primary, reported `status:degraded`, and looped on watchdog
 * restarts while the configured fallback ladder sat idle.
 *
 * The fix (runtime.ts maybeArmFallbackAfterEmptyPrimaryTurn) arms the fallback
 * deterministically on empty PRIMARY output:
 *   - immediately when the independent usability probe already flags the
 *     primary unusable, OR
 *   - after EMPTY_OUTPUT_FALLBACK_THRESHOLD (=2) consecutive empty primary
 *     turns.
 * Armed with first-class empty-output/probe-unusable reasons while preserving
 * the old auth-required control semantics: fallback SELECTION skips same-
 * provider entries (a broken claude-cli login breaks every claude-cli fallback
 * too) and REVERT is gated on a fresh primary probe (self-heals on owner
 * re-login).
 *
 * Mirrors the harness in fallback-empty-turn.test.ts.
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
  (globalThis as Record<string, unknown>)['__emptyOutputArmsTestConfig__'] = config;
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

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: vi.fn(() => 'present-key'),
    resolveProviderKeyService: vi.fn((provider: unknown, model: unknown) => {
      if (provider === 'opencode-cli' && typeof model === 'string') return model.split('/')[0]?.trim().toLowerCase() || null;
      if (provider === 'openai-api') return 'openai';
      if (provider === 'anthropic-api') return 'anthropic';
      return null;
    }),
  };
});

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__emptyOutputArmsTestConfig__'] as Record<string, unknown>;
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

function makeFakeQueue() {
  return {
    targetChatJid: 'fake@s.whatsapp.net',
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueResultText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    markLastTerminal: vi.fn(),
    flush: vi.fn(async () => {}),
    getLastOpId: vi.fn(() => undefined),
    clearLastOpId: vi.fn(),
    indicateTyping: vi.fn(),
    endTurn: vi.fn(),
  };
}

type RuntimeView = {
  primaryModelUsability: unknown;
  consecutivePrimaryEmptyTurns: number;
  handleEventWithContext(
    event: unknown,
    queue: unknown,
    session: unknown,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
    toolScopeKey?: string,
    isSystemResult?: boolean,
  ): void;
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

/** Drive one completed primary turn through the per-chat handler. */
function driveTurn(runtime: AgentRuntime, queue: ReturnType<typeof makeFakeQueue>, text: string | null, seq: number) {
  v(runtime).handleEventWithContext({ type: 'result', text }, queue, null, 'conv', seq, 'mapkey');
}

/** Drive a turn as the synthetic control/repair session (control@heal.internal). */
function driveControlTurn(runtime: AgentRuntime, queue: ReturnType<typeof makeFakeQueue>, text: string | null, seq: number) {
  v(runtime).handleEventWithContext({ type: 'result', text }, queue, null, 'control@heal.internal', seq, 'control@heal.internal');
}

/** A usability probe result that primaryModelUsabilityRequiresAlert() rejects
 *  (status unknown + binary-model-probe-failed) — the transient
 *  startup-unusable shape that triggered the spurious probe-fast-path arming. */
const UNUSABLE_PROBE = {
  status: 'unknown',
  reason: 'binary-model-probe-failed',
  provider: 'claude-cli',
  model: 'claude-opus-4-8',
  checkedAt: 0,
  probeInFlight: false,
};

const FALLBACK = { agentFallbackProvider: 'opencode-cli', agentFallbackModel: 'minimax/minimax-m2' };

function fallbackActivatedAlerts(): Array<[string, string, string, string, string?]> {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === 'provider_fallback_activated') as Array<
    [string, string, string, string, string?]
  >;
}

describe('empty-output arms provider fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T01:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('arms after EMPTY_OUTPUT_FALLBACK_THRESHOLD (=2) consecutive empty primary turns', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();
    vi.advanceTimersByTime(61_000); // past the empty-output arming startup grace

    // First empty: below threshold, no probe signal — must NOT arm yet.
    driveTurn(runtime, queue, null, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);

    // Second empty: reaches threshold — arms the fallback.
    driveTurn(runtime, queue, null, 2);
    const state = runtime.getFallbackState();
    expect(state.fallbackActiveUntil).not.toBeNull();
    // #1421: the consecutive-empty-output trigger reports its TRUE reason, not
    // the 'auth-required' it used to borrow for control side-effects.
    expect(state.fallbackReason).toBe('empty-output');
    expect(state.effectiveProvider).toBe('opencode-cli');
    const activated = fallbackActivatedAlerts();
    expect(activated).toHaveLength(1);
    expect(activated[0][3]).toContain('reason=empty-output');
    expect(activated[0][3]).not.toContain('reason=auth-required');
    // Counter resets once armed.
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(0);
  });

  it('arms on the FIRST empty turn when the usability probe flags the primary unusable', () => {
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...UNUSABLE_PROBE };
    const queue = makeFakeQueue();
    vi.advanceTimersByTime(61_000); // past the empty-output arming startup grace

    driveTurn(runtime, queue, null, 1);
    const state = runtime.getFallbackState();
    expect(state.fallbackActiveUntil).not.toBeNull();
    // #1421: the probe-unusable fast-path reports its TRUE reason, not
    // 'auth-required'.
    expect(state.fallbackReason).toBe('probe-unusable');
    expect(state.effectiveProvider).toBe('opencode-cli');
    const activated = fallbackActivatedAlerts();
    expect(activated).toHaveLength(1);
    expect(activated[0][3]).toContain('reason=probe-unusable');
    expect(activated[0][3]).not.toContain('reason=auth-required');
  });

  it('does NOT arm on a single empty turn with no adverse probe signal', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();
    vi.advanceTimersByTime(61_000); // past the empty-output arming startup grace

    driveTurn(runtime, queue, null, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('claude-cli');
  });

  it('does NOT arm when no fallback is configured (and does not throw)', () => {
    const runtime = makeRuntime({}); // no fallback provider
    const queue = makeFakeQueue();
    vi.advanceTimersByTime(61_000);

    expect(() => {
      driveTurn(runtime, queue, null, 1);
      driveTurn(runtime, queue, null, 2);
      driveTurn(runtime, queue, null, 3);
    }).not.toThrow();
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
  });

  it('resets the consecutive-empty counter on a successful turn', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();
    vi.advanceTimersByTime(61_000); // past the empty-output arming startup grace

    driveTurn(runtime, queue, null, 1); // empty -> count 1
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);
    driveTurn(runtime, queue, 'a real reply', 2); // success -> reset
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(0);

    // A single empty after the reset must NOT arm (count is back at 1).
    driveTurn(runtime, queue, null, 3);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);
  });
});

describe('empty-output arming — startup grace (anti-flap)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T01:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does NOT arm on a SINGLE empty during the startup grace even with an unusable probe (boot-recovery noise)', () => {
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...UNUSABLE_PROBE };
    const queue = makeFakeQueue();

    // Immediately after boot (within grace, no successful turn yet): the
    // transient probe + boot-recovery empty must NOT arm via the single-empty
    // probe fast-path — this is the restart-flap guard. The empty is still
    // COUNTED (so the consecutive-empty threshold can accumulate and a real
    // dead primary still fails over), it just does not arm on its own.
    driveTurn(runtime, queue, null, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('claude-cli');
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);
  });

  it('arms during the startup grace via the consecutive-empty threshold (dead primary on early real traffic — blind spot closed; mirrors #972 replay)', () => {
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...UNUSABLE_PROBE };
    const queue = makeFakeQueue();

    // Two genuine empty inbound turns inside the first 60s against a dead
    // primary. The probe fast-path is suppressed during grace, but the empties
    // still COUNT — so the second reaches EMPTY_OUTPUT_FALLBACK_THRESHOLD and
    // fails over even within the grace window. Without this, an early
    // dead-primary turn would be silent (the blind spot). This is also the
    // path the per-chat empty-output replay (#972) arms through.
    driveTurn(runtime, queue, null, 1); // grace -> fast-path suppressed, counted
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);

    driveTurn(runtime, queue, null, 2); // threshold reached even within grace
    expect(runtime.getFallbackState().fallbackActiveUntil).not.toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('opencode-cli');
  });

  it('arms once the startup grace elapses (genuinely-dead primary still fails over)', () => {
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...UNUSABLE_PROBE };
    const queue = makeFakeQueue();

    driveTurn(runtime, queue, null, 1); // within grace -> no arm
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();

    vi.advanceTimersByTime(61_000); // grace elapses
    driveTurn(runtime, queue, null, 2); // now arms (probe unusable)
    expect(runtime.getFallbackState().fallbackActiveUntil).not.toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('opencode-cli');
  });

  it('arms within the grace once a turn has already succeeded', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();

    // A real reply proves the bot can serve -> grace no longer applies.
    driveTurn(runtime, queue, 'hello', 1);
    v(runtime).primaryModelUsability = { ...UNUSABLE_PROBE };
    driveTurn(runtime, queue, null, 2); // empty + unusable probe -> arms
    expect(runtime.getFallbackState().fallbackActiveUntil).not.toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('opencode-cli');
  });
});

// ─── R1 regression: monotonic grace is immune to wall-clock jumps ─────────────
describe('empty-output arming — startup grace uses monotonic clock (R1 regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T01:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('a forward Date.now() jump does NOT prematurely end the grace (NTP / sleep-wake forward step)', () => {
    // Scenario: bot boots, an NTP correction / sleep-wake steps Date.now()
    // forward by 70s, but no real time has passed (monotonic clock unchanged).
    // Before R1 fix: grace would appear elapsed (Date.now() - bootMs ≥ 60_000)
    // and the probe fast-path would arm on a single empty turn at boot.
    // After R1 fix: performance.now() is unchanged → grace still active → no arm.
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...UNUSABLE_PROBE };
    const queue = makeFakeQueue();

    // Step the wall-clock forward by 70 s (simulates a NTP step or sleep-wake
    // event) WITHOUT advancing performance.now() (only setSystemTime moves Date).
    vi.setSystemTime(new Date('2026-06-17T01:01:10Z')); // +70s wall-clock

    // Single empty turn: probe says unusable but grace is still active
    // (performance.now() hasn't moved). Must NOT arm via probe fast-path.
    driveTurn(runtime, queue, null, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);
  });

  it('a backward Date.now() step does NOT over-extend the grace (NTP correction backward)', () => {
    // Scenario: performance.now() advances past 60s (grace should elapse) but a
    // NTP backward correction steps Date.now() back. Before R1 fix: the elapsed
    // computation could go negative / stay below threshold, silently extending
    // the grace indefinitely. After R1 fix: monotonic clock elapsed → grace
    // correctly ends → probe fast-path fires once.
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...UNUSABLE_PROBE };
    const queue = makeFakeQueue();

    // Advance monotonic time past the grace window.
    vi.advanceTimersByTime(61_000); // performance.now() +61s

    // Now step wall-clock backward (NTP backward correction): Date.now() is back
    // to 30s after boot, so Date.now()-based elapsed would show ~30s (within grace).
    vi.setSystemTime(new Date('2026-06-17T01:00:30Z')); // -30s from +61s wall

    // Single empty turn: grace has elapsed on the monotonic clock. Must ARM
    // (probe unusable + outside monotonic grace window).
    driveTurn(runtime, queue, null, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).not.toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('opencode-cli');
  });
});

// ─── R2 regression: probeInFlight guard ───────────────────────────────────────
describe('empty-output arming — probeInFlight guard (R2 regression)', () => {
  /** A usability result with probeInFlight:true — set when the startup probe
   *  has been dispatched but not yet resolved. Before R2 fix, this was treated
   *  identically to a resolved-unusable probe and could arm the fast-path. */
  const IN_FLIGHT_PROBE = {
    status: 'unknown' as const,
    reason: 'probe-in-flight' as const,
    provider: 'claude-cli',
    model: 'claude-opus-4-8',
    checkedAt: null,
    probeInFlight: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T01:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does NOT arm on a single empty turn when the probe is still in-flight (even outside startup grace)', () => {
    // Core R2 scenario: startup probe takes >60s (slow network, overloaded
    // probe target). The grace window elapses. An empty turn arrives. Before
    // R2 fix: probeInFlight:true → primaryModelUsabilityRequiresAlert() → true
    // → armViaProbe=true → arms against a healthy primary. After R2 fix: the
    // probeInFlight guard short-circuits to false → no arm.
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...IN_FLIGHT_PROBE };
    const queue = makeFakeQueue();

    vi.advanceTimersByTime(61_000); // past grace
    driveTurn(runtime, queue, null, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);
  });

  it('DOES arm after threshold consecutive empties even when probe is in-flight', () => {
    // The probeInFlight guard only suppresses the single-empty probe fast-path.
    // The threshold path (≥2 consecutive empties) is not gated by probeInFlight
    // and must still arm — a genuinely dead primary with a stalled probe cannot
    // hide indefinitely.
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...IN_FLIGHT_PROBE };
    const queue = makeFakeQueue();

    vi.advanceTimersByTime(61_000); // past grace
    driveTurn(runtime, queue, null, 1); // count 1, no arm
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();

    driveTurn(runtime, queue, null, 2); // threshold reached → arms
    expect(runtime.getFallbackState().fallbackActiveUntil).not.toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('opencode-cli');
  });

  it('DOES arm on first empty when the probe has RESOLVED unusable (probeInFlight:false)', () => {
    // Sanity-check: R2 fix must not suppress the existing resolved-unusable
    // fast-path. A completed probe with probeInFlight:false still arms on the
    // first empty turn outside the startup grace.
    const runtime = makeRuntime(FALLBACK);
    v(runtime).primaryModelUsability = { ...UNUSABLE_PROBE }; // probeInFlight:false
    const queue = makeFakeQueue();

    vi.advanceTimersByTime(61_000); // past grace
    driveTurn(runtime, queue, null, 1);
    expect(runtime.getFallbackState().fallbackActiveUntil).not.toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('opencode-cli');
  });
});

// ─── R3 regression: control/repair session empties must NOT feed the counter ──
describe('empty-output arming — control/repair session exclusion (R3 regression)', () => {
  // ml-bot false failover root cause: the control@heal.internal repair probe
  // (dispatched by the /heal endpoint's onCrash path) can legitimately produce
  // empty output. Before R3, that empty bumped the SHARED
  // consecutivePrimaryEmptyTurns counter, so the next real-chat empty tripped
  // the threshold=2 and armed the fallback against a healthy primary.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T01:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('a control/repair session empty turn does NOT increment the consecutive-empty counter', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();
    vi.advanceTimersByTime(61_000); // past grace

    driveControlTurn(runtime, queue, null, 1); // control empty -> must be ignored
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(0);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();

    // A subsequent REAL-chat empty must start counting fresh at 1, not arm.
    driveTurn(runtime, queue, null, 2);
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(1);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
  });

  it('control empties never arm even past the threshold (no real-chat contamination path)', () => {
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();
    vi.advanceTimersByTime(61_000);

    // Three control empties — well past threshold=2 — must NOT arm and must NOT
    // increment the counter.
    driveControlTurn(runtime, queue, null, 1);
    driveControlTurn(runtime, queue, null, 2);
    driveControlTurn(runtime, queue, null, 3);
    expect(v(runtime).consecutivePrimaryEmptyTurns).toBe(0);
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
  });

  it('control empty then two real-chat empties arms exactly at 2 (control did not pre-charge the counter)', () => {
    // The original false-failover replay: control empty (count→1 pre-fix), then
    // ONE real-chat empty armed at threshold=2. Post-R3 the control empty is
    // excluded, so it takes TWO real-chat empties to arm.
    const runtime = makeRuntime(FALLBACK);
    const queue = makeFakeQueue();
    vi.advanceTimersByTime(61_000);

    driveControlTurn(runtime, queue, null, 1); // ignored
    driveTurn(runtime, queue, null, 2); // real empty #1 -> count 1, no arm
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();

    driveTurn(runtime, queue, null, 3); // real empty #2 -> threshold, arms
    expect(runtime.getFallbackState().fallbackActiveUntil).not.toBeNull();
    expect(runtime.getFallbackState().effectiveProvider).toBe('opencode-cli');
  });
});
