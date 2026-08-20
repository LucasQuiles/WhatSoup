/**
 * The model-usability freshness window must follow the periodic probe
 * scheduler when the periodic probe is armed, and keep the flat 30-minute
 * window when it is not.
 *
 * Before this fix the runtime hardcoded 30 minutes while the scheduler fired
 * at 30min*backoff ± 10%*backoff jitter, so `modelUsableStale` flipped true
 * for up to 3 minutes every cycle (positive jitter) and for the whole second
 * half of every backoff>=2 cycle — surfacing as the `turn_capability_degraded`
 * + `turn_capability_evidence_stale` flap in the canary soak ledger.
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
}));

import { Database } from '../../../src/core/database.ts';
import { fakeClock, systemClock } from '../../../src/lib/clock.ts';
import {
  PERIODIC_PROBE_EVIDENCE_CEILING_MS,
  expectedProbeDeadlineMs,
} from '../../../src/runtimes/agent/primary-readiness-probe.ts';
import {
  deriveModelUsable,
  resolveModelUsabilityFreshnessMs,
  type RuntimePrimaryModelUsability,
} from '../../../src/runtimes/agent/runtime.ts';
import { makeRuntimeState, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';

const MINUTE = 60_000;
const START = 1_786_000_000_000;

function usableEvidence(checkedAt: number): RuntimePrimaryModelUsability {
  return {
    status: 'usable',
    provider: 'claude-cli',
    model: 'claude-opus-4-8',
    checkedAt,
    probeInFlight: false,
  } as RuntimePrimaryModelUsability;
}

describe('resolveModelUsabilityFreshnessMs + deriveModelUsable (pure, fakeClock)', () => {
  it('probe armed, backoff multiple 1: evidence aged 30m+1s is NOT stale', () => {
    const clock = fakeClock(START);
    const checkedAt = clock.now();
    clock.advance(30 * MINUTE + 1_000);
    const window = resolveModelUsabilityFreshnessMs(true, 1);
    expect(deriveModelUsable(usableEvidence(checkedAt), clock.now(), window))
      .toEqual({ modelUsable: true, modelUsableStale: false, modelUsableCheckedAt: checkedAt });
  });

  it('probe armed, backoff multiple 2: evidence aged 60m is NOT stale', () => {
    const clock = fakeClock(START);
    const checkedAt = clock.now();
    clock.advance(60 * MINUTE);
    const window = resolveModelUsabilityFreshnessMs(true, 2);
    expect(deriveModelUsable(usableEvidence(checkedAt), clock.now(), window))
      .toEqual({ modelUsable: true, modelUsableStale: false, modelUsableCheckedAt: checkedAt });
  });

  it('probe armed, backoff multiple 1: evidence aged past expectedProbeDeadlineMs(1) IS stale', () => {
    const clock = fakeClock(START);
    const checkedAt = clock.now();
    clock.advance(expectedProbeDeadlineMs(1) + 1);
    const window = resolveModelUsabilityFreshnessMs(true, 1);
    expect(deriveModelUsable(usableEvidence(checkedAt), clock.now(), window))
      .toEqual({ modelUsable: null, modelUsableStale: true, modelUsableCheckedAt: checkedAt });
  });

  it('probe armed, backoff multiple 2: evidence aged past expectedProbeDeadlineMs(2) IS stale', () => {
    const clock = fakeClock(START);
    const checkedAt = clock.now();
    clock.advance(expectedProbeDeadlineMs(2) + 1);
    const window = resolveModelUsabilityFreshnessMs(true, 2);
    expect(deriveModelUsable(usableEvidence(checkedAt), clock.now(), window).modelUsableStale).toBe(true);
  });

  it('probe armed with an absurd multiple: the ceiling still declares wedged evidence stale', () => {
    const clock = fakeClock(START);
    const checkedAt = clock.now();
    clock.advance(PERIODIC_PROBE_EVIDENCE_CEILING_MS + 1);
    const window = resolveModelUsabilityFreshnessMs(true, 1_000);
    expect(deriveModelUsable(usableEvidence(checkedAt), clock.now(), window).modelUsableStale).toBe(true);
  });

  it('timer NOT armed: the flat 30-minute window is preserved (30m+1s IS stale)', () => {
    const clock = fakeClock(START);
    const checkedAt = clock.now();
    clock.advance(30 * MINUTE + 1_000);
    const window = resolveModelUsabilityFreshnessMs(false, 1);
    expect(window).toBe(30 * MINUTE);
    expect(deriveModelUsable(usableEvidence(checkedAt), clock.now(), window))
      .toEqual({ modelUsable: null, modelUsableStale: true, modelUsableCheckedAt: checkedAt });
  });

  it('timer NOT armed: the backoff multiple is ignored', () => {
    expect(resolveModelUsabilityFreshnessMs(false, 4)).toBe(30 * MINUTE);
  });
});

type ProbeState = RuntimeState & {
  primaryModelUsability: RuntimePrimaryModelUsability | null;
  periodicUsabilityProbeTimer: ReturnType<typeof setTimeout> | null;
  periodicUsabilityProbeBackoff: number;
};

describe('AgentRuntime health snapshot — turnCapability follows the probe scheduler', () => {
  let db: Database;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function turnCapabilityOf(runtime: ReturnType<typeof makeRuntimeState>['runtime']) {
    const details = runtime.getHealthSnapshot().details as Record<string, unknown>;
    return details.turnCapability as Record<string, unknown>;
  }

  it('armed timer + backoff counter 1 (multiple 2): 60m-old usable evidence reads green, not stale', () => {
    const { runtime, state } = makeRuntimeState<ProbeState>(db);
    state.primaryModelUsability = usableEvidence(systemClock.now());
    state.periodicUsabilityProbeTimer = setTimeout(() => {}, 24 * 60 * MINUTE);
    state.periodicUsabilityProbeBackoff = 1;
    vi.advanceTimersByTime(60 * MINUTE);

    const tc = turnCapabilityOf(runtime);
    expect(tc.periodicProbeExpected).toBe(true);
    expect(tc.modelUsableStale).toBe(false);
    expect(tc.modelUsable).toBe(true);
    // The scheduler inputs are threaded into the snapshot for observability.
    expect(tc.periodicProbeBackoffMultiple).toBe(2);
    expect(tc.modelUsableFreshnessMs).toBe(expectedProbeDeadlineMs(2));
  });

  it('armed timer + backoff counter 0: 30m+1s-old usable evidence reads green, not stale', () => {
    const { runtime, state } = makeRuntimeState<ProbeState>(db);
    state.primaryModelUsability = usableEvidence(systemClock.now());
    state.periodicUsabilityProbeTimer = setTimeout(() => {}, 24 * 60 * MINUTE);
    state.periodicUsabilityProbeBackoff = 0;
    vi.advanceTimersByTime(30 * MINUTE + 1_000);

    const tc = turnCapabilityOf(runtime);
    expect(tc.modelUsableStale).toBe(false);
    expect(tc.modelUsable).toBe(true);
    expect(tc.periodicProbeBackoffMultiple).toBe(1);
  });

  it('armed timer: evidence older than the scheduler deadline goes stale', () => {
    const { runtime, state } = makeRuntimeState<ProbeState>(db);
    state.primaryModelUsability = usableEvidence(systemClock.now());
    state.periodicUsabilityProbeTimer = setTimeout(() => {}, 24 * 60 * MINUTE);
    state.periodicUsabilityProbeBackoff = 0;
    vi.advanceTimersByTime(expectedProbeDeadlineMs(1) + 1);

    const tc = turnCapabilityOf(runtime);
    expect(tc.modelUsableStale).toBe(true);
    expect(tc.modelUsable).toBe(null);
  });

  it('timer not armed: the flat 30-minute window is preserved on the live snapshot', () => {
    const { runtime, state } = makeRuntimeState<ProbeState>(db);
    state.primaryModelUsability = usableEvidence(systemClock.now());
    state.periodicUsabilityProbeTimer = null;
    state.periodicUsabilityProbeBackoff = 0;
    vi.advanceTimersByTime(30 * MINUTE + 1_000);

    const tc = turnCapabilityOf(runtime);
    expect(tc.periodicProbeExpected).toBe(false);
    expect(tc.modelUsableStale).toBe(true);
    expect(tc.modelUsableFreshnessMs).toBe(30 * MINUTE);
  });
});
