import type {
  AuthLossSignalClassifier,
  AuthLossSignalInput,
  AuthLossSignalRecordResult,
} from './auth-loss-signal-store.ts';
import { AuthLossSignalStore } from './auth-loss-signal-store.ts';
import {
  evaluateStableAuthenticatedOpen,
  isStableAuthenticatedOpenSample,
  type StableAuthenticatedOpenSample,
} from './auth-loss-signal-resolver.ts';

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
  private readonly store: AuthLossSignalStore;
  private readonly options: AuthLossSignalTransitionOptions;

  constructor(
    store: AuthLossSignalStore,
    options: AuthLossSignalTransitionOptions,
  ) {
    this.store = store;
    this.options = options;
  }

  recordAuthLoss(input: AuthLossSignalInput): AuthLossSignalRecordResult {
    const result = this.store.record(input);
    const key = this.key(input.instance, input.classifier);
    if (result.inserted) {
      this.active.set(key, {
        windowStartedAt: input.observedAt ?? new Date().toISOString(),
        samples: [],
      });
    }
    return result;
  }

  observeHealthSample(input: ObserveHealthSampleInput): ObserveHealthSampleResult {
    const key = this.key(input.instance, input.classifier);
    const active = this.active.get(key);
    if (!active) {
      return {
        resolved: false,
        reason: 'no_open_signal',
        observedSamples: 0,
        requiredSamples: this.requiredSamples(),
      };
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
