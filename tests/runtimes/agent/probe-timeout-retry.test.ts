/**
 * One timed-out primary-model probe must not hold the model unusable for an
 * hour.
 *
 * A periodic probe that timed out (status 'timeout': the provider was slow,
 * not refusing) was treated like any other failure: the backoff counter went
 * to 1 and the next probe was armed ~60 minutes out. Until then the evidence
 * read `model_usable=false` and health stayed degraded, even when the
 * provider answered normally a minute later.
 *
 * Fix under test: the first timeout re-probes once after
 * PERIODIC_PROBE_TIMEOUT_RETRY_MS without touching the backoff. If that
 * retry also fails, the normal backoff applies, so a provider that is really
 * down still widens its cadence and never spins. Other failure classes keep
 * the old cadence.
 *
 * Harness as in probe-schedule-consistency.test.ts: the probe dispatch is a
 * synchronous fake that records the next queued result, Math.random is
 * pinned to 1, so delays are 33m at backoff 0 and 66m at backoff 1.
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

import { Database } from '../../../src/core/database.ts';
import { systemClock } from '../../../src/lib/clock.ts';
import type { PrimaryModelUsabilityResult } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import type { RuntimePrimaryModelUsability } from '../../../src/runtimes/agent/runtime.ts';
import { makeRuntimeState, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';

const MINUTE = 60_000;
const START = 1_786_000_000_000;
const USABLE: PrimaryModelUsabilityResult = { status: 'usable', provider: 'claude-cli', model: 'claude-opus-5-5' };
const TIMEOUT: PrimaryModelUsabilityResult = {
  status: 'timeout',
  provider: 'claude-cli',
  model: 'claude-opus-5-5',
  reason: 'probe-timeout',
};
const CRED_FAIL: PrimaryModelUsabilityResult = {
  status: 'credential-unavailable',
  provider: 'claude-cli',
  model: 'claude-opus-5-5',
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

describe('AgentRuntime periodic probe — a timed-out probe retries once within minutes', () => {
  let db: Database;
  let probeCalls: Array<{ at: number; trigger: ProbeTrigger }>;
  let queuedResults: PrimaryModelUsabilityResult[];

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    vi.spyOn(Math, 'random').mockReturnValue(1);
    probeCalls = [];
    queuedResults = [];
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
    vi.spyOn(state.fallback, 'schedulePrimaryModelUsabilityProbe').mockImplementation((trigger: ProbeTrigger) => {
      probeCalls.push({ at: systemClock.now(), trigger });
      state.fallback.recordPrimaryModelUsability(queuedResults.shift() ?? USABLE, trigger);
    });
    const turnCapability = () =>
      (runtime.getHealthSnapshot().details as Record<string, unknown>).turnCapability as Record<string, unknown>;
    return { state, turnCapability };
  }

  it('a periodic timeout re-probes within 5 minutes; a usable retry restores the model and the normal cadence', () => {
    const { state, turnCapability } = armedRuntime();
    const t0 = systemClock.now();

    state.fallback.recordPrimaryModelUsability(TIMEOUT, 'periodic');
    expect(state.periodicUsabilityProbeBackoff).toBe(0);
    expect(state.periodicUsabilityProbeDueAt).toBe(t0 + 5 * MINUTE);
    expect(turnCapability().modelUsable).toBe(false);

    vi.advanceTimersByTime(5 * MINUTE);
    expect(probeCalls).toEqual([{ at: t0 + 5 * MINUTE, trigger: 'periodic' }]);
    const tc = turnCapability();
    expect(tc.modelUsable).toBe(true);
    expect(tc.modelUsableStale).toBe(false);
    expect(state.periodicUsabilityProbeBackoff).toBe(0);
    expect(state.periodicUsabilityProbeDueAt).toBe(t0 + 5 * MINUTE + 33 * MINUTE);
  });

  it('retries only once: a second consecutive timeout falls back to the normal backoff', () => {
    const { state, turnCapability } = armedRuntime();
    const t0 = systemClock.now();
    queuedResults.push(TIMEOUT);

    state.fallback.recordPrimaryModelUsability(TIMEOUT, 'periodic');
    vi.advanceTimersByTime(5 * MINUTE);
    expect(probeCalls).toHaveLength(1);
    expect(state.periodicUsabilityProbeBackoff).toBe(1);
    expect(state.periodicUsabilityProbeDueAt).toBe(t0 + 5 * MINUTE + 66 * MINUTE);

    // Nothing else fires before the backed-off probe, and the evidence is
    // not judged stale while it waits.
    vi.advanceTimersByTime(60 * MINUTE);
    expect(probeCalls).toHaveLength(1);
    expect(turnCapability().modelUsableStale).toBe(false);
  });

  it('a later timeout after a successful probe gets its own single retry', () => {
    const { state } = armedRuntime();
    const t0 = systemClock.now();

    state.fallback.recordPrimaryModelUsability(TIMEOUT, 'periodic');
    vi.advanceTimersByTime(5 * MINUTE); // retry: usable
    state.fallback.recordPrimaryModelUsability(TIMEOUT, 'periodic');
    expect(state.periodicUsabilityProbeBackoff).toBe(0);
    expect(state.periodicUsabilityProbeDueAt).toBe(t0 + 10 * MINUTE);
  });

  it('CONTROL: non-timeout failures keep the doubled cadence', () => {
    const { state } = armedRuntime();
    const t0 = systemClock.now();

    state.fallback.recordPrimaryModelUsability(CRED_FAIL, 'periodic');
    expect(state.periodicUsabilityProbeBackoff).toBe(1);
    expect(state.periodicUsabilityProbeDueAt).toBe(t0 + 66 * MINUTE);
  });
});
