import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOOP_LAG_RAW_RING_SAMPLES,
  LOOP_LAG_SAMPLE_INTERVAL_MS,
  LoopLagSampler,
} from '../../src/lib/loop-lag-sampler.ts';

// Deterministic clock + cumulative resource readers. The sampler primes its
// previous readings at start(), so the first observation already has deltas.
function makeHarness() {
  let nowMs = 0;
  let elu = { idle: 0, active: 0 };
  let cpu = { user: 0, system: 0 };
  const sampler = new LoopLagSampler({
    now: () => nowMs,
    eluReader: () => ({ ...elu }),
    cpuReader: () => ({ ...cpu }),
  });
  return {
    sampler,
    setNow: (ms: number) => { nowMs = ms; },
    setElu: (next: { idle: number; active: number }) => { elu = next; },
    setCpu: (next: { user: number; system: number }) => { cpu = next; },
  };
}

describe('LoopLagSampler — raw instrumentation (#3253)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('records per-observation provenance: the causal delayed callback is in the ring even when starvation is only observed seconds later', () => {
    const h = makeHarness();
    h.sampler.start(); // expected first tick at 500

    // Tick 1 fires on time.
    h.setNow(500);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    // Tick 2 fires 300ms late — THE causal event.
    h.setNow(1300);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    // A health request observes much later (the #3253 nine-second shape):
    // the warning-side observation lands seconds after the causal sample.
    h.setNow(10300);
    const snap = h.sampler.snapshot();

    const ring = h.sampler.rawSamples();
    expect(ring).toHaveLength(3);
    expect(ring[0]).toMatchObject({ atMs: 500, lagMs: 0, source: 'interval', discontinuity: false });
    expect(ring[1]).toMatchObject({ atMs: 1300, lagMs: 300, source: 'interval', discontinuity: false });
    expect(ring[2]).toMatchObject({ atMs: 10300, lagMs: 8500, source: 'snapshot', discontinuity: false });

    // The window stats carry the source split and extremes the warn log lacks.
    expect(snap.sampleCount).toBe(3);
    expect(snap.intervalSampleCount).toBe(2);
    expect(snap.snapshotSampleCount).toBe(1);
    expect(snap.minLagMs).toBe(0);
    expect(snap.medianLagMs).toBe(300);
    expect(snap.maxLagMs).toBe(8500);
  });

  it('snapshot() between ticks observes nothing (pre-expected early return preserved)', () => {
    const h = makeHarness();
    h.sampler.start();
    h.setNow(499);
    const snap = h.sampler.snapshot();
    expect(snap.sampleCount).toBe(0);
    expect(h.sampler.rawSamples()).toHaveLength(0);
  });

  it('bounds the raw ring and drops oldest first', () => {
    const h = makeHarness();
    h.sampler.start();
    const total = LOOP_LAG_RAW_RING_SAMPLES + 40;
    for (let tick = 1; tick <= total; tick++) {
      h.setNow(tick * LOOP_LAG_SAMPLE_INTERVAL_MS);
      vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    }
    const ring = h.sampler.rawSamples();
    expect(ring).toHaveLength(LOOP_LAG_RAW_RING_SAMPLES);
    expect(ring[0]!.atMs).toBe(41 * LOOP_LAG_SAMPLE_INTERVAL_MS);
    expect(ring.at(-1)!.atMs).toBe(total * LOOP_LAG_SAMPLE_INTERVAL_MS);
  });

  it('a discontinuity resets the window but is retained in the ring with its flag', () => {
    const h = makeHarness();
    h.sampler.start();
    h.setNow(500);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    // Next callback arrives 11s late — beyond the discontinuity threshold.
    h.setNow(12_000);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);

    const ring = h.sampler.rawSamples();
    expect(ring).toHaveLength(2);
    expect(ring[1]).toMatchObject({ atMs: 12_000, lagMs: 11_000, source: 'interval', discontinuity: true });

    h.setNow(12_500);
    const snap = h.sampler.snapshot();
    expect(snap.discontinuityCount).toBe(1);
    // Window restarted after the discontinuity: only the post-reset snapshot sample.
    expect(snap.sampleCount).toBe(1);
  });

  it('captures ELU utilization and CPU delta per observation from cumulative readers', () => {
    const h = makeHarness();
    h.sampler.start(); // primes prev readings at {0,0}

    // Over the first tick: 100ms active, 400ms idle → 0.2; 150ms CPU (µs units).
    h.setElu({ idle: 400, active: 100 });
    h.setCpu({ user: 100_000, system: 50_000 });
    h.setNow(500);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);

    // Over the second tick: fully idle, no CPU.
    h.setElu({ idle: 900, active: 100 });
    h.setCpu({ user: 100_000, system: 50_000 });
    h.setNow(1000);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);

    const ring = h.sampler.rawSamples();
    expect(ring[0]!.eluUtilization).toBeCloseTo(0.2, 5);
    expect(ring[0]!.cpuDeltaMs).toBeCloseTo(150, 5);
    expect(ring[1]!.eluUtilization).toBeCloseTo(0, 5);
    expect(ring[1]!.cpuDeltaMs).toBeCloseTo(0, 5);

    h.setNow(1500);
    const snap = h.sampler.snapshot();
    expect(snap.lastEluUtilization).toBeCloseTo(0, 5);
    expect(snap.lastCpuDeltaMs).toBeCloseTo(0, 5);
  });

  it('the ring survives stop() while the window does not', () => {
    const h = makeHarness();
    h.sampler.start();
    h.setNow(500);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    h.sampler.stop();

    const snapAfterStop = h.sampler.snapshot();
    // stop() cleared the expectation baseline, so this snapshot records NO new
    // observation (ring unchanged at 1) and reports an empty window.
    expect(h.sampler.rawSamples()).toHaveLength(1);
    expect(snapAfterStop).toMatchObject({
      sampleCount: 0,
      p95LagMs: null,
      minLagMs: null,
      medianLagMs: null,
      maxLagMs: null,
      intervalSampleCount: 0,
      snapshotSampleCount: 0,
      locallyStarved: false,
    });
  });
});
