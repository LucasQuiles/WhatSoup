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
  let wallNowMs = 1_785_000_000_000;
  let elu = { idle: 0, active: 0 };
  let cpu = { user: 0, system: 0 };
  const sampler = new LoopLagSampler({
    now: () => nowMs,
    wallNow: () => wallNowMs,
    eluReader: () => ({ ...elu }),
    cpuReader: () => ({ ...cpu }),
  });
  return {
    sampler,
    setNow: (ms: number) => { nowMs = ms; },
    setWallNow: (ms: number) => { wallNowMs = ms; },
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
    h.setWallNow(1_785_000_000_500);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    // Tick 2 fires 300ms late — THE causal event.
    h.setNow(1300);
    h.setWallNow(1_785_000_001_300);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    // A health request observes much later (the #3253 nine-second shape):
    // the warning-side observation lands seconds after the causal sample.
    h.setNow(10300);
    h.setWallNow(1_785_000_010_300);
    const snap = h.sampler.snapshot();

    const ring = h.sampler.rawSamples();
    expect(ring).toHaveLength(3);
    expect(ring[0]).toMatchObject({
      atMs: 500,
      wallAtMs: 1_785_000_000_500,
      lagMs: 0,
      source: 'interval',
      discontinuity: false,
    });
    expect(ring[1]).toMatchObject({
      atMs: 1300,
      wallAtMs: 1_785_000_001_300,
      lagMs: 300,
      source: 'interval',
      discontinuity: false,
    });
    // 8500 = how overdue the next fire is at 10300: the loop went silent right
    // after the 1300 fire, whose successor was due at 1800.
    expect(ring[2]).toMatchObject({
      atMs: 10300,
      wallAtMs: 1_785_000_010_300,
      lagMs: 8500,
      source: 'snapshot',
      discontinuity: false,
    });

    // The window stats carry the source split and extremes the warn log lacks.
    expect(snap.sampleCount).toBe(3);
    expect(snap.intervalSampleCount).toBe(2);
    expect(snap.snapshotSampleCount).toBe(1);
    expect(snap.minLagMs).toBe(0);
    expect(snap.medianLagMs).toBe(300);
    expect(snap.maxLagMs).toBe(8500);
  });

  it('snapshot() between ticks observes nothing (pre-due early return preserved)', () => {
    const h = makeHarness();
    h.sampler.start();
    h.setNow(499);
    const snap = h.sampler.snapshot();
    expect(snap.sampleCount).toBe(0);
    expect(h.sampler.rawSamples()).toHaveLength(0);
  });

  it('ordinary timer jitter records as ~zero lag and no fire is ever discarded as early', () => {
    const h = makeHarness();
    h.sampler.start();

    // Fires at 502, 1001, 1501: small jitter around the cadence. Every fire
    // must land in the ring (a deadline model that discards "early" fires
    // manufactured phantom ~500ms samples — #3253), and none of the jitter
    // may read as meaningful lag.
    h.setNow(502);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    h.setNow(1001);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    h.setNow(1501);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);

    expect(h.sampler.rawSamples().map((sample) => sample.lagMs)).toEqual([2, 0, 0]);
    expect(h.sampler.snapshot()).toMatchObject({
      sampleCount: 3,
      maxLagMs: 2,
      locallyStarved: false,
    });
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
    expect(ring[0]!.sequence).toBe(41);
    expect(ring.at(-1)!.sequence).toBe(total);
    expect(ring[0]!.atMs).toBe(41 * LOOP_LAG_SAMPLE_INTERVAL_MS);
    expect(ring.at(-1)!.atMs).toBe(total * LOOP_LAG_SAMPLE_INTERVAL_MS);
  });

  it('allocates process-local sequence once per accepted observation across stop/start', () => {
    const h = makeHarness();
    h.sampler.start();
    h.setNow(500);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    h.setNow(1_000);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    h.sampler.stop();
    h.sampler.start();
    h.setNow(1_500);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);

    expect(h.sampler.rawSamples().map((sample) => sample.sequence)).toEqual([1, 2, 3]);

    const fresh = makeHarness();
    fresh.sampler.start();
    fresh.setNow(500);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    expect(fresh.sampler.rawSamples()[0]!.sequence).toBe(1);
  });

  it('uses wall time only as correlation metadata, never for lag math', () => {
    const h = makeHarness();
    h.sampler.start();
    h.setWallNow(9_999_999_999_999);
    h.setNow(510);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);

    expect(h.sampler.rawSamples()[0]).toMatchObject({
      wallAtMs: 9_999_999_999_999,
      lagMs: 10,
    });
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

    h.setNow(12_501);
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
    // The snapshot at exactly the due boundary records nothing (strict-overdue
    // gate), so these are genuinely the second fire's readings. Previously the
    // snapshot recorded a zero-span ELU read (null) and toBeCloseTo silently
    // coerced that null to 0 — a vacuous pass.
    expect(snap.lastEluUtilization).toBeCloseTo(0, 5);
    expect(snap.lastCpuDeltaMs).toBeCloseTo(0, 5);
  });

  it('normalizes negative, non-finite, and out-of-range resource deltas to null', () => {
    const cases = [
      {
        elu: { idle: 100, active: -200 },
        cpu: { user: -1, system: 0 },
      },
      {
        elu: { idle: -50, active: 100 },
        cpu: { user: Number.POSITIVE_INFINITY, system: 0 },
      },
      {
        elu: { idle: Number.NaN, active: 1 },
        cpu: { user: Number.NaN, system: 0 },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const h = makeHarness();
      h.sampler.start();
      h.setElu(testCase.elu);
      h.setCpu(testCase.cpu);
      h.setNow(500);
      vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
      expect(h.sampler.rawSamples()[0], `case ${index}`).toMatchObject({
        eluUtilization: null,
        cpuDeltaMs: null,
      });
      h.sampler.stop();
    }
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

describe('LoopLagSampler — raw sample page', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function record(h: ReturnType<typeof makeHarness>, count: number): void {
    for (let sequence = 1; sequence <= count; sequence++) {
      h.setNow(sequence * LOOP_LAG_SAMPLE_INTERVAL_MS);
      h.setWallNow(1_785_000_000_000 + sequence * LOOP_LAG_SAMPLE_INTERVAL_MS);
      vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    }
  }

  it('pins empty-page cursors with and without an input cursor', () => {
    const h = makeHarness();
    expect(h.sampler.rawSamplePage({ limit: 160 })).toEqual({
      oldestSequence: null,
      latestSequence: null,
      nextAfter: 0,
      truncated: false,
      gap: null,
      samples: [],
    });
    expect(h.sampler.rawSamplePage({ after: 41, limit: 160 })).toMatchObject({
      oldestSequence: null,
      latestSequence: null,
      nextAfter: 41,
      truncated: false,
      gap: null,
      samples: [],
    });
  });

  it('returns the newest no-cursor page oldest-first', () => {
    const h = makeHarness();
    h.sampler.start();
    record(h, 5);

    const page = h.sampler.rawSamplePage({ limit: 3 });
    expect(page).toMatchObject({
      oldestSequence: 1,
      latestSequence: 5,
      nextAfter: 5,
      truncated: true,
      gap: null,
    });
    expect(page.samples.map((sample) => sample.sequence)).toEqual([3, 4, 5]);
  });

  it('returns the oldest matching cursor page and reports exact truncation', () => {
    const h = makeHarness();
    h.sampler.start();
    record(h, 5);

    const first = h.sampler.rawSamplePage({ after: 1, limit: 2 });
    expect(first.samples.map((sample) => sample.sequence)).toEqual([2, 3]);
    expect(first.nextAfter).toBe(3);
    expect(first.truncated).toBe(true);

    const last = h.sampler.rawSamplePage({ after: first.nextAfter, limit: 2 });
    expect(last.samples.map((sample) => sample.sequence)).toEqual([4, 5]);
    expect(last.nextAfter).toBe(5);
    expect(last.truncated).toBe(false);
  });

  it('reports cursor eviction only when the missing cursor range is real', () => {
    const h = makeHarness();
    h.sampler.start();
    record(h, LOOP_LAG_RAW_RING_SAMPLES + 2);

    const oldest = 3;
    expect(h.sampler.rawSamplePage({ after: 1, limit: 2 }).gap).toEqual({
      kind: 'cursor_evicted',
      after: 1,
      firstAvailableSequence: oldest,
    });
    expect(h.sampler.rawSamplePage({ after: oldest - 1, limit: 2 }).gap).toBeNull();
  });

  it('returns a detached immutable page that later observations cannot change', () => {
    const h = makeHarness();
    h.sampler.start();
    record(h, 2);
    const page = h.sampler.rawSamplePage({ limit: 2 });

    h.setNow(3 * LOOP_LAG_SAMPLE_INTERVAL_MS);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);

    expect(page.latestSequence).toBe(2);
    expect(page.samples.map((sample) => sample.sequence)).toEqual([1, 2]);
    expect(Object.isFrozen(page.samples)).toBe(true);
    expect(page.samples.every((sample) => Object.isFrozen(sample))).toBe(true);
  });

  it('rejects unsafe cursors and limits at the sampler boundary', () => {
    const h = makeHarness();
    expect(() => h.sampler.rawSamplePage({ after: -1, limit: 1 })).toThrow(/after/);
    expect(() => h.sampler.rawSamplePage({ after: Number.MAX_SAFE_INTEGER + 1, limit: 1 })).toThrow(/after/);
    expect(() => h.sampler.rawSamplePage({ limit: 0 })).toThrow(/limit/);
    expect(() => h.sampler.rawSamplePage({ limit: 161 })).toThrow(/limit/);
    expect(() => h.sampler.rawSamplePage({ limit: 1.5 })).toThrow(/limit/);
  });
});

describe('LoopLagSampler — interval re-arm drift (#3253 canary rollback)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('per-fire wake latency must not accumulate into false starvation on an idle loop', () => {
    const h = makeHarness();
    h.sampler.start();
    // Node re-arms each interval fire from its own processing time (ms
    // granularity), so real fires land ~1ms past the previous fire every
    // time — observed as steady 501.1ms deltas on Node 24.15.0 — and never
    // return to the original grid. 300 such fires (~2.5 min) reproduce the
    // canary rollback shape: an idle loop reading as starved.
    let at = 0;
    for (let fire = 1; fire <= 300; fire++) {
      at += LOOP_LAG_SAMPLE_INTERVAL_MS + 1;
      h.setNow(at);
      vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    }
    const snap = h.sampler.snapshot();
    expect(snap.locallyStarved).toBe(false);
    expect(snap.maxLagMs ?? 0).toBeLessThanOrEqual(10);
  });

  it('sustained genuine starvation is still detected after the drift correction', () => {
    const h = makeHarness();
    h.sampler.start();
    // Every fire arrives 300ms past due: a loop that is really blocked
    // ~300ms out of every 800ms. The full 20-sample window must trip.
    let at = 0;
    for (let fire = 1; fire <= 21; fire++) {
      at += LOOP_LAG_SAMPLE_INTERVAL_MS + 300;
      h.setNow(at);
      vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    }
    const snap = h.sampler.snapshot();
    expect(snap.locallyStarved).toBe(true);
    expect(snap.p95LagMs).toBeGreaterThanOrEqual(300);
  });

  it('an overdue snapshot observation is not double-counted by the next interval fire', () => {
    const h = makeHarness();
    h.sampler.start();
    h.setNow(500);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);
    // Loop blocks; a health request observes the stall at 9300 (8300ms past
    // the 1000 due point), then the delayed fire itself lands at 9400.
    h.setNow(9300);
    h.sampler.snapshot();
    h.setNow(9400);
    vi.advanceTimersByTime(LOOP_LAG_SAMPLE_INTERVAL_MS);

    const lags = h.sampler.rawSamples().map((sample) => sample.lagMs);
    expect(lags[0]).toBe(0);
    expect(lags[1]).toBe(8300);
    // The fire after the snapshot reports only the residual delay since the
    // snapshot consumed the stall — not the same 8+ seconds again.
    expect(lags[2]).toBeLessThanOrEqual(100);
  });
});
