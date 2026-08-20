/**
 * Probe cadence and evidence window must never diverge.
 *
 * recordPrimaryModelUsability recalculated the backoff counter on EVERY
 * trigger (startup/manual/periodic) but only re-armed the periodic timer on
 * 'periodic'. A periodic failure (backoff 1, timer ~60m) followed by a manual
 * success (backoff reset to 0, evidence refreshed, timer untouched) left the
 * health window computed for multiple 1 (~35m) while the next probe was still
 * ~60m out — a false `turn_capability_evidence_stale` for ~25 minutes.
 *
 * Fix under test: an explicit `periodicUsabilityProbeDueAt` (epoch ms, same
 * clock as checkedAt) is set whenever the timer is armed and is the source of
 * truth for the window (`nextProbeDueAt - checkedAt + grace`, ceiling-bound);
 * the timer is re-armed whenever the backoff changes on any trigger.
 *
 * The probe dispatch is replaced by a synchronous fake that records a usable
 * result for the given trigger, so the real scheduler loop runs under fake
 * timers without spawning a provider. Math.random is pinned to 1 (full
 * positive jitter) so every delay is deterministic: 33m at backoff 0, 66m at
 * backoff 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../../helpers/logger-mock.ts');
  const runtimeLogger = singletonLoggerMock();
  return {
    default: { ...runtimeLogger, child: () => runtimeLogger },
    createChildLogger: () => runtimeLogger,
    flushLogger: () => Promise.resolve(),
  };
});

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  emitAlertChecked: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  clearAlertSourceChecked: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
}));

// The dispatch path is real in the resurrection tests below; only the probe
// ITSELF is a controllable pending promise so a result can arrive after
// shutdown without spawning a provider.
const probeControl = vi.hoisted(() => ({ resolvers: [] as Array<(result: unknown) => void> }));

vi.mock('../../../src/runtimes/agent/providers/primary-model-usability.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/providers/primary-model-usability.ts')>(),
  probePrimaryModelUsability: vi.fn(() => new Promise((resolve) => { probeControl.resolvers.push(resolve); })),
}));

import { Database } from '../../../src/core/database.ts';
import { clearAlertSourceChecked } from '../../../src/lib/emit-alert.ts';
import { systemClock } from '../../../src/lib/clock.ts';
import {
  PERIODIC_PROBE_EVIDENCE_CEILING_MS,
  PERIODIC_PROBE_EVIDENCE_GRACE_MS,
  expectedProbeDeadlineMs,
} from '../../../src/runtimes/agent/primary-readiness-probe.ts';
import type { PrimaryModelUsabilityResult } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import {
  resolveModelUsabilityFreshnessMs,
  type RuntimePrimaryModelUsability,
} from '../../../src/runtimes/agent/runtime.ts';
import { makeRuntimeState, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';

const MINUTE = 60_000;
const START = 1_786_000_000_000;
const USABLE: PrimaryModelUsabilityResult = { status: 'usable', provider: 'claude-cli', model: 'claude-opus-4-8' };
const CRED_FAIL: PrimaryModelUsabilityResult = {
  status: 'credential-unavailable',
  provider: 'claude-cli',
  model: 'claude-opus-4-8',
  reason: 'probe-failed',
};

type ProbeTrigger = 'startup' | 'manual' | 'periodic';
type ProbeState = RuntimeState & {
  primaryModelUsability: RuntimePrimaryModelUsability | null;
  periodicUsabilityProbeTimer: ReturnType<typeof setTimeout> | null;
  periodicUsabilityProbeBackoff: number;
  periodicUsabilityProbeDueAt: number | null;
  fallback: {
    recordPrimaryModelUsability(result: PrimaryModelUsabilityResult, trigger: ProbeTrigger): void;
    schedulePrimaryModelUsabilityProbe(trigger: ProbeTrigger): void;
    scheduleNextPeriodicUsabilityProbe(): void;
  };
};

describe('resolveModelUsabilityFreshnessMs — armed schedule is the source of truth', () => {
  it('armed with a known due instant: window = (due - checkedAt) + grace', () => {
    const checkedAt = START;
    const nextProbeDueAt = START + 50 * MINUTE;
    expect(resolveModelUsabilityFreshnessMs(true, 1, { nextProbeDueAt, checkedAt }))
      .toBe(50 * MINUTE + PERIODIC_PROBE_EVIDENCE_GRACE_MS);
  });

  it('armed and already due (due <= checkedAt): only the grace remains', () => {
    expect(resolveModelUsabilityFreshnessMs(true, 2, { nextProbeDueAt: START - 1, checkedAt: START }))
      .toBe(PERIODIC_PROBE_EVIDENCE_GRACE_MS);
  });

  it('armed with an absurd due instant: the hard ceiling still applies', () => {
    expect(resolveModelUsabilityFreshnessMs(true, 1, { nextProbeDueAt: START + 10 * 60 * MINUTE, checkedAt: START }))
      .toBe(PERIODIC_PROBE_EVIDENCE_CEILING_MS);
  });

  it('armed but no due instant recorded: falls back to the scheduler formula', () => {
    expect(resolveModelUsabilityFreshnessMs(true, 2, { nextProbeDueAt: null, checkedAt: START }))
      .toBe(expectedProbeDeadlineMs(2));
  });

  it('not armed: the flat 30-minute window regardless of any due instant', () => {
    expect(resolveModelUsabilityFreshnessMs(false, 2, { nextProbeDueAt: START + 60 * MINUTE, checkedAt: START }))
      .toBe(30 * MINUTE);
  });
});

describe('AgentRuntime periodic probe — cadence and window reset together on any trigger', () => {
  let db: Database;
  let probeCalls: Array<{ at: number; trigger: ProbeTrigger }>;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    vi.spyOn(Math, 'random').mockReturnValue(1); // full positive jitter: 33m / 66m
    probeCalls = [];
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function armedRuntime() {
    const { runtime, state } = makeRuntimeState<ProbeState>(db);
    // Synchronous fake of the probe dispatch: the real scheduler loop runs,
    // but a fired probe records a usable result instead of spawning a provider.
    vi.spyOn(state.fallback, 'schedulePrimaryModelUsabilityProbe').mockImplementation((trigger: ProbeTrigger) => {
      probeCalls.push({ at: systemClock.now(), trigger });
      state.fallback.recordPrimaryModelUsability(USABLE, trigger);
    });
    const turnCapability = () =>
      (runtime.getHealthSnapshot().details as Record<string, unknown>).turnCapability as Record<string, unknown>;
    return { runtime, state, turnCapability };
  }

  it('periodic failure then manual success: due instant, timer and window all reset; no false-stale window', () => {
    const { state, turnCapability } = armedRuntime();
    const t0 = systemClock.now();

    state.fallback.recordPrimaryModelUsability(CRED_FAIL, 'periodic');
    expect(state.periodicUsabilityProbeBackoff).toBe(1);
    expect(state.periodicUsabilityProbeDueAt).toBe(t0 + 66 * MINUTE);

    vi.advanceTimersByTime(5 * MINUTE);
    state.fallback.recordPrimaryModelUsability(USABLE, 'manual');
    expect(state.periodicUsabilityProbeBackoff).toBe(0);
    // Backoff changed on a manual trigger -> the timer is re-armed for the new cadence.
    expect(state.periodicUsabilityProbeDueAt).toBe(t0 + 5 * MINUTE + 33 * MINUTE);
    let tc = turnCapability();
    expect(tc.nextProbeDueAt).toBe(t0 + 38 * MINUTE);
    expect(tc.modelUsableFreshnessMs).toBe(33 * MINUTE + PERIODIC_PROBE_EVIDENCE_GRACE_MS);

    // t0+45m: before the fix the old 66m timer was still pending while the
    // window was judged at multiple 1 (35m) -> evidence aged 40m read stale.
    vi.advanceTimersByTime(40 * MINUTE);
    expect(probeCalls).toEqual([{ at: t0 + 38 * MINUTE, trigger: 'periodic' }]);
    tc = turnCapability();
    expect(tc.modelUsableStale).toBe(false);
    expect(tc.modelUsable).toBe(true);
    expect(tc.nextProbeDueAt).toBe(t0 + 38 * MINUTE + 33 * MINUTE);
  });

  it('periodic success then manual failure: the cadence widens with the backoff instead of firing early', () => {
    const { state, turnCapability } = armedRuntime();
    const t0 = systemClock.now();

    state.fallback.recordPrimaryModelUsability(USABLE, 'periodic');
    expect(state.periodicUsabilityProbeDueAt).toBe(t0 + 33 * MINUTE);

    vi.advanceTimersByTime(5 * MINUTE);
    state.fallback.recordPrimaryModelUsability(CRED_FAIL, 'manual');
    expect(state.periodicUsabilityProbeBackoff).toBe(1);
    expect(state.periodicUsabilityProbeDueAt).toBe(t0 + 5 * MINUTE + 66 * MINUTE);

    // The old 33m timer must have been replaced: nothing fires at t0+33m.
    vi.advanceTimersByTime(29 * MINUTE);
    expect(probeCalls).toEqual([]);
    let tc = turnCapability();
    expect(tc.modelUsable).toBe(false);
    expect(tc.modelUsableStale).toBe(false);
    expect(tc.modelUsableFreshnessMs).toBe(66 * MINUTE + PERIODIC_PROBE_EVIDENCE_GRACE_MS);

    vi.advanceTimersByTime(37 * MINUTE);
    expect(probeCalls).toEqual([{ at: t0 + 71 * MINUTE, trigger: 'periodic' }]);
    tc = turnCapability();
    expect(tc.modelUsable).toBe(true);
    expect(tc.modelUsableStale).toBe(false);
  });

  it('CONTROL: a probe in flight never reads stale, however old the previous evidence', () => {
    const { state, turnCapability } = armedRuntime();
    state.fallback.recordPrimaryModelUsability(USABLE, 'periodic');
    state.primaryModelUsability = {
      status: 'unknown',
      provider: 'claude-cli',
      model: 'claude-opus-4-8',
      reason: 'probe-in-flight',
      checkedAt: systemClock.now() - 3 * 60 * MINUTE,
      probeInFlight: true,
    } as RuntimePrimaryModelUsability;
    vi.advanceTimersByTime(30 * MINUTE);
    const tc = turnCapability();
    expect(tc.modelUsableStale).toBe(false);
    expect(tc.modelUsable).toBe(null);
  });

  it('shutdown clears the due instant with the timer', async () => {
    const { runtime, state, turnCapability } = armedRuntime();
    state.fallback.recordPrimaryModelUsability(USABLE, 'periodic');
    expect(state.periodicUsabilityProbeDueAt).toBe(systemClock.now() + 33 * MINUTE);
    const shutdown = runtime.shutdown().then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3_000);
    await shutdown;
    expect(state.periodicUsabilityProbeTimer).toBeNull();
    // With no timer armed the snapshot falls back to the flat window and carries no due instant.
    const tc = turnCapability();
    expect({
      dueAt: state.periodicUsabilityProbeDueAt,
      periodicProbeExpected: tc.periodicProbeExpected,
      nextProbeDueAt: tc.nextProbeDueAt,
      modelUsableFreshnessMs: tc.modelUsableFreshnessMs,
    }).toEqual({ dueAt: null, periodicProbeExpected: false, nextProbeDueAt: null, modelUsableFreshnessMs: 30 * MINUTE });
  });
});

describe('AgentRuntime periodic probe — no post-shutdown resurrection', () => {
  let db: Database;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    probeControl.resolvers.length = 0;
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a probe resolving after shutdown neither re-arms the timer nor mutates evidence nor emits clears', async () => {
    const { runtime, state } = makeRuntimeState<ProbeState>(db);
    state.fallback.schedulePrimaryModelUsabilityProbe('periodic');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.primaryModelUsability?.probeInFlight).toBe(true);
    const evidenceBefore = state.primaryModelUsability;

    const shutdown = runtime.shutdown().then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3_000);
    await shutdown;
    expect(state.periodicUsabilityProbeTimer).toBeNull();
    expect(state.periodicUsabilityProbeDueAt).toBeNull();
    vi.mocked(clearAlertSourceChecked).mockClear();

    // The pre-shutdown probe finally resolves — it must be dropped whole.
    probeControl.resolvers.at(-1)?.(USABLE);
    await vi.advanceTimersByTimeAsync(0);

    expect({
      timer: state.periodicUsabilityProbeTimer,
      dueAt: state.periodicUsabilityProbeDueAt,
      evidence: state.primaryModelUsability,
      alertClears: vi.mocked(clearAlertSourceChecked).mock.calls.length,
    }).toEqual({ timer: null, dueAt: null, evidence: evidenceBefore, alertClears: 0 });
  });

  it('scheduleNextPeriodicUsabilityProbe after shutdown never arms a timer or a due instant', async () => {
    const { runtime, state } = makeRuntimeState<ProbeState>(db);
    const shutdown = runtime.shutdown().then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3_000);
    await shutdown;

    state.fallback.scheduleNextPeriodicUsabilityProbe();
    expect({
      timer: state.periodicUsabilityProbeTimer,
      dueAt: state.periodicUsabilityProbeDueAt,
    }).toEqual({ timer: null, dueAt: null });
  });
});
