import type {
  AuthLossSignalClassifier,
  AuthLossSignalInput,
  AuthLossSignalRecordResult,
  AuthLossSignalResolutionInput,
  AuthLossSignalResolutionResult,
} from './auth-loss-signal-store.ts';
import {
  evaluateStableAuthenticatedOpen,
  isStableAuthenticatedOpenSample,
  type StableAuthenticatedOpenSample,
} from './auth-loss-signal-resolver.ts';

/**
 * Structural store contract so a caller that opens the per-instance database
 * per call (FleetDbReader.queryWrite) can supply a routing adapter instead of
 * a long-lived AuthLossSignalStore (#1786). AuthLossSignalStore satisfies it.
 */
export interface AuthLossSignalStorePort {
  record(input: AuthLossSignalInput): AuthLossSignalRecordResult;
  resolve(input: AuthLossSignalResolutionInput): AuthLossSignalResolutionResult;
  hasUnresolved(instance: string, classifier: AuthLossSignalClassifier): boolean;
}

export interface AuthLossSignalTransitionOptions {
  quietDwellSeconds: number;
  pollIntervalSeconds: number;
  sampleTolerance?: number;
}

export interface ObserveHealthSampleInput {
  instance: string;
  classifier: AuthLossSignalClassifier;
  sample: StableAuthenticatedOpenSample;
}

export type ObserveHealthSampleResult =
  | { resolved: true; reason: 'stable_authenticated_open'; observedSamples: number; requiredSamples: number }
  | {
      resolved: false;
      reason: 'no_open_signal' | 'window_not_elapsed' | 'insufficient_samples' | 'contradicting_sample';
      observedSamples: number;
      requiredSamples: number;
    };

interface ActiveSignalWindow {
  windowStartedAt: string;
  samples: StableAuthenticatedOpenSample[];
}

export class AuthLossSignalTransitionController {
  private readonly active = new Map<string, ActiveSignalWindow>();
  // Keys whose store state this process has already probed (or written). Rows
  // can only appear through this controller's own record path afterwards, so
  // one probe per key per process lifetime is sufficient (#1786).
  private readonly discovered = new Set<string>();
  private readonly store: AuthLossSignalStorePort;
  private readonly options: AuthLossSignalTransitionOptions;

  constructor(
    store: AuthLossSignalStorePort,
    options: AuthLossSignalTransitionOptions,
  ) {
    this.store = store;
    this.options = options;
  }

  recordAuthLoss(input: AuthLossSignalInput): AuthLossSignalRecordResult {
    const result = this.store.record(input);
    const key = this.key(input.instance, input.classifier);
    // Arm on duplicate too when no window is held: a duplicate means an
    // unresolved row already exists (e.g. persisted by a previous process run)
    // while the loss is being observed NOW — the quiet window must start no
    // earlier than this observation (#1786).
    if (result.inserted || !this.active.has(key)) {
      this.active.set(key, {
        windowStartedAt: input.observedAt ?? new Date().toISOString(),
        samples: [],
      });
    }
    this.discovered.add(key);
    return result;
  }

  observeHealthSample(input: ObserveHealthSampleInput): ObserveHealthSampleResult {
    const key = this.key(input.instance, input.classifier);
    let active = this.active.get(key);
    if (!active) {
      // Restart discovery (#1786): a previous process may have persisted an
      // unresolved row whose loss condition no longer fires, so recordAuthLoss
      // never re-arms in this process. Probe the store once per key; the
      // window starts at the CURRENT sample — never the persisted
      // observed_at — so a bare reconnect is never sufficient proof.
      if (this.discovered.has(key) || !this.store.hasUnresolved(input.instance, input.classifier)) {
        this.discovered.add(key);
        return {
          resolved: false,
          reason: 'no_open_signal',
          observedSamples: 0,
          requiredSamples: this.requiredSamples(),
        };
      }
      this.discovered.add(key);
      active = { windowStartedAt: input.sample.sampledAt, samples: [] };
      this.active.set(key, active);
    }

    if (!isStableAuthenticatedOpenSample(input.sample)) {
      active.windowStartedAt = input.sample.sampledAt;
      active.samples = [];
      return {
        resolved: false,
        reason: 'contradicting_sample',
        observedSamples: 0,
        requiredSamples: this.requiredSamples(),
      };
    }

    active.samples.push(input.sample);
    const evaluation = evaluateStableAuthenticatedOpen({
      windowStartedAt: active.windowStartedAt,
      evaluatedAt: input.sample.sampledAt,
      quietDwellSeconds: this.options.quietDwellSeconds,
      pollIntervalSeconds: this.options.pollIntervalSeconds,
      sampleTolerance: this.options.sampleTolerance,
      samples: active.samples,
    });

    if (!evaluation.shouldResolve) {
      return { resolved: false, ...evaluation };
    }

    const resolved = this.store.resolve({
      instance: input.instance,
      classifier: input.classifier,
      reason: 'stable_authenticated_open',
      resolvedAt: input.sample.sampledAt,
    });
    if (!resolved.resolved) {
      return {
        resolved: false,
        reason: 'no_open_signal',
        observedSamples: evaluation.observedSamples,
        requiredSamples: evaluation.requiredSamples,
      };
    }

    this.active.delete(key);
    return {
      resolved: true,
      reason: 'stable_authenticated_open',
      observedSamples: evaluation.observedSamples,
      requiredSamples: evaluation.requiredSamples,
    };
  }

  private key(instance: string, classifier: AuthLossSignalClassifier): string {
    return `${instance}:${classifier}`;
  }

  private requiredSamples(): number {
    const tolerance = Math.max(0, Math.floor(this.options.sampleTolerance ?? 0));
    return Math.max(1, Math.floor(this.options.quietDwellSeconds / this.options.pollIntervalSeconds) - tolerance);
  }
}
