export const LOOP_LAG_SAMPLE_INTERVAL_MS = 500;
export const LOOP_LAG_WINDOW_SAMPLES = 20;
export const LOOP_LAG_STARVATION_THRESHOLD_MS = 250;
export const LOOP_LAG_DISCONTINUITY_THRESHOLD_MS =
  LOOP_LAG_SAMPLE_INTERVAL_MS * LOOP_LAG_WINDOW_SAMPLES;

export interface LoopLagSnapshot {
  sampleCount: number;
  p95LagMs: number | null;
  locallyStarved: boolean;
  discontinuityCount: number;
}

export interface LoopLagSamplerOptions {
  now?: () => number;
}

export class LoopLagSampler {
  private timer: NodeJS.Timeout | null = null;
  private samples: number[] = [];
  private expectedAtMs: number | null = null;
  private discontinuityCount = 0;
  private readonly now: () => number;

  constructor(options: LoopLagSamplerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  start(): void {
    if (this.timer !== null) return;
    this.resetWindow();
    this.expectedAtMs = this.now() + LOOP_LAG_SAMPLE_INTERVAL_MS;
    this.timer = setInterval(() => this.sample(), LOOP_LAG_SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resetWindow();
  }

  snapshot(): LoopLagSnapshot {
    this.observe();
    const p95LagMs = this.percentile95(this.samples);
    return {
      sampleCount: this.samples.length,
      p95LagMs,
      locallyStarved:
        this.samples.length === LOOP_LAG_WINDOW_SAMPLES
        && p95LagMs !== null
        && p95LagMs > LOOP_LAG_STARVATION_THRESHOLD_MS,
      discontinuityCount: this.discontinuityCount,
    };
  }

  private sample(): void {
    this.observe();
  }

  private observe(): void {
    const actualAtMs = this.now();
    const expectedAtMs = this.expectedAtMs;
    if (expectedAtMs === null || actualAtMs < expectedAtMs) return;

    const lagMs = Math.max(0, actualAtMs - expectedAtMs);
    if (lagMs > LOOP_LAG_DISCONTINUITY_THRESHOLD_MS) {
      this.resetWindow();
      this.discontinuityCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.discontinuityCount + 1,
      );
    } else {
      this.samples.push(lagMs);
    }
    if (this.samples.length > LOOP_LAG_WINDOW_SAMPLES) this.samples.shift();
    this.expectedAtMs = actualAtMs + LOOP_LAG_SAMPLE_INTERVAL_MS;
  }

  private percentile95(samples: readonly number[]): number | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((left, right) => left - right);
    const index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[index] ?? null;
  }

  private resetWindow(): void {
    this.samples = [];
    this.expectedAtMs = null;
  }
}
