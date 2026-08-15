import { performance as nodePerformance } from 'node:perf_hooks';

import { systemClock } from './clock.ts';

export const LOOP_LAG_SAMPLE_INTERVAL_MS = 500;
export const LOOP_LAG_WINDOW_SAMPLES = 20;
export const LOOP_LAG_STARVATION_THRESHOLD_MS = 250;
export const LOOP_LAG_DISCONTINUITY_THRESHOLD_MS =
  LOOP_LAG_SAMPLE_INTERVAL_MS * LOOP_LAG_WINDOW_SAMPLES;
// Raw forensic ring: ~3 minutes at the 500ms cadence. Bounded and content-free
// (timings and provenance only), so it can sit in the authenticated health doc
// without privacy review per entry.
export const LOOP_LAG_RAW_RING_SAMPLES = 360;
// How many ring entries the health doc serves. ~80s of samples, so a poller
// reading every 60s stitches a gap-free raw stream with overlap.
export const LOOP_LAG_RAW_RECENT_LIMIT = 160;

/**
 * Where an observation was taken. The warning that consumers log fires at
 * health-request time — up to a full window (~10s) after the causal delayed
 * callback — so correlation work MUST use raw per-sample provenance, not
 * warning timestamps (#3253).
 */
export type LoopLagObservationSource = 'interval' | 'snapshot';

export interface RawLoopLagSample {
  /** Monotonic observation time (same clock as `now`). */
  readonly atMs: number;
  /** Unix epoch observation time for correlation with timestamped runtime logs. */
  readonly wallAtMs: number;
  readonly lagMs: number;
  readonly source: LoopLagObservationSource;
  /** True when this observation exceeded the discontinuity threshold and reset the window. */
  readonly discontinuity: boolean;
  /** Event-loop utilization (0..1) over the span since the previous observation; null when unavailable. */
  readonly eluUtilization: number | null;
  /** Process CPU (user+system) milliseconds consumed since the previous observation; null when unavailable. */
  readonly cpuDeltaMs: number | null;
}

export interface LoopLagSnapshot {
  sampleCount: number;
  p95LagMs: number | null;
  minLagMs: number | null;
  medianLagMs: number | null;
  maxLagMs: number | null;
  /** Window samples taken by the interval callback vs by snapshot() observers. */
  intervalSampleCount: number;
  snapshotSampleCount: number;
  locallyStarved: boolean;
  discontinuityCount: number;
  lastEluUtilization: number | null;
  lastCpuDeltaMs: number | null;
}

interface EluReading {
  readonly idle: number;
  readonly active: number;
}

interface CpuReading {
  readonly user: number;
  readonly system: number;
}

interface WindowSample {
  readonly lagMs: number;
  readonly source: LoopLagObservationSource;
}

export interface LoopLagSamplerOptions {
  now?: () => number;
  /** Wall-clock Unix time used only for cross-log correlation, never lag math. */
  wallNow?: () => number;
  /** Cumulative event-loop idle/active reading; defaults to perf_hooks. Injectable for tests. */
  eluReader?: () => EluReading | null;
  /** Cumulative process CPU reading in microseconds; defaults to process.cpuUsage. Injectable for tests. */
  cpuReader?: () => CpuReading | null;
}

function defaultEluReader(): EluReading | null {
  const elu = nodePerformance.eventLoopUtilization?.();
  return elu ? { idle: elu.idle, active: elu.active } : null;
}

function defaultCpuReader(): CpuReading | null {
  const usage = process.cpuUsage();
  return { user: usage.user, system: usage.system };
}

export class LoopLagSampler {
  private timer: NodeJS.Timeout | null = null;
  private window: WindowSample[] = [];
  private rawRing: RawLoopLagSample[] = [];
  private expectedAtMs: number | null = null;
  private discontinuityCount = 0;
  private prevElu: EluReading | null = null;
  private prevCpu: CpuReading | null = null;
  private lastEluUtilization: number | null = null;
  private lastCpuDeltaMs: number | null = null;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly eluReader: () => EluReading | null;
  private readonly cpuReader: () => CpuReading | null;

  constructor(options: LoopLagSamplerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => systemClock.now());
    this.eluReader = options.eluReader ?? defaultEluReader;
    this.cpuReader = options.cpuReader ?? defaultCpuReader;
  }

  start(): void {
    if (this.timer !== null) return;
    this.resetWindow();
    this.expectedAtMs = this.now() + LOOP_LAG_SAMPLE_INTERVAL_MS;
    this.prevElu = this.eluReader();
    this.prevCpu = this.cpuReader();
    this.timer = setInterval(() => this.sample(), LOOP_LAG_SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resetWindow();
    this.prevElu = null;
    this.prevCpu = null;
    // The raw ring deliberately survives stop(): it is the forensic record.
  }

  snapshot(): LoopLagSnapshot {
    this.observe('snapshot');
    const lags = this.window.map((sample) => sample.lagMs);
    const p95LagMs = this.percentile95(lags);
    return {
      sampleCount: this.window.length,
      p95LagMs,
      minLagMs: lags.length > 0 ? Math.min(...lags) : null,
      medianLagMs: this.median(lags),
      maxLagMs: lags.length > 0 ? Math.max(...lags) : null,
      intervalSampleCount: this.window.filter((sample) => sample.source === 'interval').length,
      snapshotSampleCount: this.window.filter((sample) => sample.source === 'snapshot').length,
      locallyStarved:
        this.window.length === LOOP_LAG_WINDOW_SAMPLES
        && p95LagMs !== null
        && p95LagMs > LOOP_LAG_STARVATION_THRESHOLD_MS,
      discontinuityCount: this.discontinuityCount,
      lastEluUtilization: this.lastEluUtilization,
      lastCpuDeltaMs: this.lastCpuDeltaMs,
    };
  }

  /** Bounded raw observation stream, oldest first. Survives window resets and stop(). */
  rawSamples(): readonly RawLoopLagSample[] {
    return [...this.rawRing];
  }

  private sample(): void {
    this.observe('interval');
  }

  private observe(source: LoopLagObservationSource): void {
    const actualAtMs = this.now();
    const expectedAtMs = this.expectedAtMs;
    if (expectedAtMs === null || actualAtMs < expectedAtMs) return;

    const lagMs = Math.max(0, actualAtMs - expectedAtMs);
    // setInterval keeps its original schedule. Keep our deadline on that same
    // phase and advance past every elapsed slot. Rebasing to actualAtMs caused
    // a slightly-late callback to make the next scheduled callback look early;
    // that callback was discarded and the following one became a phantom
    // ~500ms lag sample (#3253).
    const elapsedSlots = Math.floor(lagMs / LOOP_LAG_SAMPLE_INTERVAL_MS) + 1;
    const nextExpectedAtMs = expectedAtMs + elapsedSlots * LOOP_LAG_SAMPLE_INTERVAL_MS;
    const eluUtilization = this.readEluDelta();
    const cpuDeltaMs = this.readCpuDelta();
    this.lastEluUtilization = eluUtilization;
    this.lastCpuDeltaMs = cpuDeltaMs;
    const discontinuity = lagMs > LOOP_LAG_DISCONTINUITY_THRESHOLD_MS;
    this.pushRaw({
      atMs: actualAtMs,
      wallAtMs: this.wallNow(),
      lagMs,
      source,
      discontinuity,
      eluUtilization,
      cpuDeltaMs,
    });
    if (discontinuity) {
      this.resetWindow();
      this.discontinuityCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.discontinuityCount + 1,
      );
    } else {
      this.window.push({ lagMs, source });
    }
    if (this.window.length > LOOP_LAG_WINDOW_SAMPLES) this.window.shift();
    this.expectedAtMs = nextExpectedAtMs;
  }

  private pushRaw(sample: RawLoopLagSample): void {
    this.rawRing.push(sample);
    if (this.rawRing.length > LOOP_LAG_RAW_RING_SAMPLES) this.rawRing.shift();
  }

  private readEluDelta(): number | null {
    const current = this.eluReader();
    if (current === null) return null;
    const previous = this.prevElu;
    this.prevElu = current;
    if (previous === null) return null;
    const active = current.active - previous.active;
    const idle = current.idle - previous.idle;
    const span = active + idle;
    return span > 0 ? active / span : null;
  }

  private readCpuDelta(): number | null {
    const current = this.cpuReader();
    if (current === null) return null;
    const previous = this.prevCpu;
    this.prevCpu = current;
    if (previous === null) return null;
    return (current.user - previous.user + current.system - previous.system) / 1000;
  }

  private percentile95(samples: readonly number[]): number | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((left, right) => left - right);
    const index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[index] ?? null;
  }

  private median(samples: readonly number[]): number | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
  }

  private resetWindow(): void {
    this.window = [];
    this.expectedAtMs = null;
  }
}
