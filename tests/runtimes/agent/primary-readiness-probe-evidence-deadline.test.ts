/**
 * Model-usability evidence TTL must follow the periodic probe scheduler.
 *
 * The scheduler (calculatePeriodicProbeDelay) fires at INTERVAL*backoff with
 * ±10%*backoff jitter, but the freshness window the health verdict used was a
 * flat 30 minutes. With positive jitter the evidence was declared stale for up
 * to 3 minutes every cycle, and at backoffMultiple >= 2 it was stale for the
 * whole second half of the interval — the `turn_capability_degraded` /
 * `turn_capability_evidence_stale` flap observed in the canary soak ledger.
 *
 * `expectedProbeDeadlineMs` is the single pure bound both sides share: the
 * latest instant the scheduler can legitimately fire, plus a documented grace
 * for the probe's own execution, clamped at the maximum backoff multiple so a
 * wedged scheduler (evidence older than any legitimate cycle) still goes stale.
 */
import { describe, expect, it } from 'vitest';
import {
  PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE,
  PERIODIC_PROBE_EVIDENCE_CEILING_MS,
  PERIODIC_PROBE_EVIDENCE_GRACE_MS,
  PERIODIC_PROBE_INTERVAL_MS,
  PERIODIC_PROBE_JITTER_MS,
  calculatePeriodicProbeDelay,
  expectedProbeDeadlineMs,
  periodicProbeBackoffMultiple,
} from '../../../src/runtimes/agent/primary-readiness-probe.ts';

const MINUTE = 60_000;
const NOW = 1_786_000_000_000;

describe('expectedProbeDeadlineMs — scheduler-derived evidence TTL', () => {
  it('backoff 1: interval + full positive jitter + grace (35 min at 30/3/2)', () => {
    expect(expectedProbeDeadlineMs(1)).toBe(
      PERIODIC_PROBE_INTERVAL_MS + PERIODIC_PROBE_JITTER_MS + PERIODIC_PROBE_EVIDENCE_GRACE_MS,
    );
    expect(expectedProbeDeadlineMs(1)).toBe(35 * MINUTE);
  });

  it('backoff 2: interval and jitter both scale with the multiple (68 min)', () => {
    expect(expectedProbeDeadlineMs(2)).toBe(
      2 * PERIODIC_PROBE_INTERVAL_MS + 2 * PERIODIC_PROBE_JITTER_MS + PERIODIC_PROBE_EVIDENCE_GRACE_MS,
    );
    expect(expectedProbeDeadlineMs(2)).toBe(68 * MINUTE);
  });

  it('grace is a constant, documented 2 minutes', () => {
    expect(PERIODIC_PROBE_EVIDENCE_GRACE_MS).toBe(2 * MINUTE);
  });

  it('a rate-limit remainder larger than the scheduled interval dominates, then grace applies', () => {
    const rateLimitRemaining = 60 * MINUTE;
    expect(expectedProbeDeadlineMs(1, rateLimitRemaining))
      .toBe(rateLimitRemaining + PERIODIC_PROBE_EVIDENCE_GRACE_MS);
  });

  it('a rate-limit remainder smaller than the interval does not shorten the deadline', () => {
    expect(expectedProbeDeadlineMs(1, 5 * MINUTE)).toBe(expectedProbeDeadlineMs(1));
  });

  it('hard ceiling: the deadline never exceeds the max-backoff cycle, so a wedged scheduler goes stale', () => {
    expect(PERIODIC_PROBE_EVIDENCE_CEILING_MS).toBe(expectedProbeDeadlineMs(PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE));
    expect(expectedProbeDeadlineMs(100)).toBe(PERIODIC_PROBE_EVIDENCE_CEILING_MS);
    expect(expectedProbeDeadlineMs(Number.POSITIVE_INFINITY)).toBe(PERIODIC_PROBE_EVIDENCE_CEILING_MS);
  });

  it('degenerate multiples fail toward the strictest window (backoff 1)', () => {
    expect(expectedProbeDeadlineMs(0)).toBe(expectedProbeDeadlineMs(1));
    expect(expectedProbeDeadlineMs(-3)).toBe(expectedProbeDeadlineMs(1));
    expect(expectedProbeDeadlineMs(Number.NaN)).toBe(expectedProbeDeadlineMs(1));
  });

  it('periodicProbeBackoffMultiple mirrors the scheduler: 2^backoff capped at the max multiple', () => {
    expect(periodicProbeBackoffMultiple(0)).toBe(1);
    expect(periodicProbeBackoffMultiple(1)).toBe(2);
    expect(periodicProbeBackoffMultiple(2)).toBe(4);
    expect(periodicProbeBackoffMultiple(9)).toBe(PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE);
  });

  it('PROPERTY: the scheduler never fires later than the deadline minus grace, for every backoff counter', () => {
    // 400 samples per backoff level exercise the full ±jitter band; the bound
    // must hold with the grace still unspent (grace covers probe execution).
    for (let backoff = 0; backoff <= 3; backoff += 1) {
      const bound = expectedProbeDeadlineMs(periodicProbeBackoffMultiple(backoff)) - PERIODIC_PROBE_EVIDENCE_GRACE_MS;
      for (let i = 0; i < 400; i += 1) {
        const delay = calculatePeriodicProbeDelay(backoff, NOW - 60 * MINUTE, NOW);
        expect(delay, `backoff=${backoff}`).toBeLessThanOrEqual(bound);
      }
    }
  });
});
