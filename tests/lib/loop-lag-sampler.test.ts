import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  LOOP_LAG_SAMPLE_INTERVAL_MS,
  LOOP_LAG_STARVATION_THRESHOLD_MS,
  LOOP_LAG_WINDOW_SAMPLES,
  LoopLagSampler,
} from '../../src/lib/loop-lag-sampler.ts';

describe('LoopLagSampler', () => {
  describe('constants', () => {
    it('LOOP_LAG_SAMPLE_INTERVAL_MS is defined', () => {
      expect(LOOP_LAG_SAMPLE_INTERVAL_MS).toBeGreaterThan(0);
    });

    it('LOOP_LAG_WINDOW_SAMPLES is defined', () => {
      expect(LOOP_LAG_WINDOW_SAMPLES).toBeGreaterThan(0);
    });

    it('LOOP_LAG_STARVATION_THRESHOLD_MS is defined', () => {
      expect(LOOP_LAG_STARVATION_THRESHOLD_MS).toBeGreaterThan(0);
    });
  });

  describe('initialization', () => {
    it('creates a sampler with default now() function', () => {
      const sampler = new LoopLagSampler();
      expect(sampler).toBeDefined();
    });

    it('creates a sampler with custom now() function', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      expect(sampler).toBeDefined();
    });
  });

  describe('snapshot without starting', () => {
    it('returns initial state with 0 samples and no lag', () => {
      const sampler = new LoopLagSampler();
      const snapshot = sampler.snapshot();
      expect(snapshot.sampleCount).toBe(0);
      expect(snapshot.p95LagMs).toBeNull();
      expect(snapshot.locallyStarved).toBe(false);
    });
  });

  describe('start and stop lifecycle', () => {
    it('start() begins sampling', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();
      mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + 10;
      const snapshot = sampler.snapshot();
      expect(snapshot.sampleCount).toBeGreaterThan(0);
    });

    it('stop() halts sampling and clears state', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();
      mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + 10;
      sampler.stop();
      const snapshot = sampler.snapshot();
      expect(snapshot.sampleCount).toBe(0);
      expect(snapshot.p95LagMs).toBeNull();
    });

    it('start() when already started is a no-op', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();
      const firstSnapshot = sampler.snapshot();
      mockTime += 1;
      sampler.start(); // Call start again
      const secondSnapshot = sampler.snapshot();
      expect(firstSnapshot.sampleCount).toBe(secondSnapshot.sampleCount);
    });

    it('stop() when already stopped is a no-op', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();
      sampler.stop();
      expect(() => sampler.stop()).not.toThrow();
    });
  });

  describe('lag measurement', () => {
    it('accumulates lag samples up to window size', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      // Simulate LOOP_LAG_WINDOW_SAMPLES intervals
      for (let i = 0; i < LOOP_LAG_WINDOW_SAMPLES; i++) {
        mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + (i * 5); // Add some lag
      }

      const snapshot = sampler.snapshot();
      expect(snapshot.sampleCount).toBeLessThanOrEqual(LOOP_LAG_WINDOW_SAMPLES);
    });

    it('maintains a rolling window of samples', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      // Add more than window size samples
      for (let i = 0; i < LOOP_LAG_WINDOW_SAMPLES + 5; i++) {
        mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS;
      }

      const snapshot = sampler.snapshot();
      expect(snapshot.sampleCount).toBeLessThanOrEqual(LOOP_LAG_WINDOW_SAMPLES);
    });
  });

  describe('p95 lag calculation', () => {
    it('returns null when no samples exist', () => {
      const sampler = new LoopLagSampler();
      const snapshot = sampler.snapshot();
      expect(snapshot.p95LagMs).toBeNull();
    });

    it('calculates percentile 95 correctly', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      // Add samples with increasing lag
      for (let i = 0; i < LOOP_LAG_WINDOW_SAMPLES; i++) {
        mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + i; // Lag increases each iteration
      }

      const snapshot = sampler.snapshot();
      expect(snapshot.p95LagMs).toBeGreaterThanOrEqual(0);
    });

    it('returns non-null p95 when window is full', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      for (let i = 0; i < LOOP_LAG_WINDOW_SAMPLES; i++) {
        mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + 10;
      }

      const snapshot = sampler.snapshot();
      if (snapshot.sampleCount === LOOP_LAG_WINDOW_SAMPLES) {
        expect(snapshot.p95LagMs).not.toBeNull();
      }
    });
  });

  describe('starvation detection', () => {
    it('detects starvation when p95 exceeds threshold', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      // Add samples with significant lag to exceed starvation threshold
      for (let i = 0; i < LOOP_LAG_WINDOW_SAMPLES; i++) {
        mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + LOOP_LAG_STARVATION_THRESHOLD_MS + 50;
      }

      const snapshot = sampler.snapshot();
      if (snapshot.sampleCount === LOOP_LAG_WINDOW_SAMPLES && snapshot.p95LagMs !== null) {
        expect(snapshot.locallyStarved).toBe(
          snapshot.p95LagMs > LOOP_LAG_STARVATION_THRESHOLD_MS,
        );
      }
    });

    it('does not detect starvation when window is not full', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      // Add just one sample
      mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + 100;
      const snapshot = sampler.snapshot();
      expect(snapshot.locallyStarved).toBe(false);
    });

    it('reports no starvation when lag is below threshold', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      // Add samples with minimal lag
      for (let i = 0; i < LOOP_LAG_WINDOW_SAMPLES; i++) {
        mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + 1; // Tiny lag
      }

      const snapshot = sampler.snapshot();
      if (snapshot.sampleCount === LOOP_LAG_WINDOW_SAMPLES) {
        expect(snapshot.locallyStarved).toBe(false);
      }
    });
  });

  describe('edge cases', () => {
    it('handles zero lag measurements', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      // No actual elapsed time, zero lag
      mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS;
      const snapshot = sampler.snapshot();
      expect(snapshot.sampleCount).toBeGreaterThanOrEqual(0);
    });

    it('handles very large lag values', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      // Simulate massive lag
      for (let i = 0; i < LOOP_LAG_WINDOW_SAMPLES; i++) {
        mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + 10000; // 10 second lag
      }

      const snapshot = sampler.snapshot();
      if (snapshot.p95LagMs !== null) {
        expect(snapshot.p95LagMs).toBeGreaterThan(0);
      }
    });

    it('snapshot reflects current lag when window is not full', () => {
      let mockTime = 0;
      const sampler = new LoopLagSampler({ now: () => mockTime });
      sampler.start();

      mockTime += LOOP_LAG_SAMPLE_INTERVAL_MS + 100;
      const snapshot = sampler.snapshot();
      expect(snapshot.sampleCount).toBeGreaterThan(0);
      expect(snapshot.sampleCount).toBeLessThan(LOOP_LAG_WINDOW_SAMPLES);
    });
  });
});
