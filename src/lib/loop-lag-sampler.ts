export const LOOP_LAG_SAMPLE_INTERVAL_MS = 500;
export const LOOP_LAG_WINDOW_SAMPLES = 20;
export const LOOP_LAG_STARVATION_THRESHOLD_MS = 250;

export interface LoopLagSnapshot {
  sampleCount: number;
  p95LagMs: number | null;
  locallyStarved: boolean;
}

export interface LoopLagSamplerOptions {
  now?: () => number;
}

export class LoopLagSampler {
  private timer: NodeJS.Timeout | null = null;
  private samples: number[] = [];
  private expectedAtMs: number | null = null;
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
    const completed = this.samples;
    const expectedAtMs = this.expectedAtMs;
    const actualAtMs = this.now();
    const effectiveSamples = expectedAtMs !== null && actualAtMs >= expectedAtMs
      ? [
          ...completed.slice(-(LOOP_LAG_WINDOW_SAMPLES - 1)),
          Math.max(0, actualAtMs - expectedAtMs),
        ]
      : completed;
    const p95LagMs = this.percentile95(effectiveSamples);
    return {
      sampleCount: effectiveSamples.length,
      p95LagMs,
      locallyStarved:
        effectiveSamples.length === LOOP_LAG_WINDOW_SAMPLES
        && p95LagMs !== null
        && p95LagMs > LOOP_LAG_STARVATION_THRESHOLD_MS,
    };
  }

  private sample(): void {
    const actualAtMs = this.now();
    const expectedAtMs = this.expectedAtMs ?? actualAtMs;
    this.samples.push(Math.max(0, actualAtMs - expectedAtMs));
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
