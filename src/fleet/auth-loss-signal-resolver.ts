export interface StableAuthenticatedOpenSample {
  sampledAt: string;
  connected: boolean;
  accountStatus: 'present' | 'missing' | 'not_connected' | string | null;
  connectionState: string | null;
  reconnectPhase: string | null;
  reconnectAttempts: number | null;
  recentDisconnectCount: number | null;
}

export interface StableAuthenticatedOpenEvaluation {
  windowStartedAt: string;
  evaluatedAt: string;
  quietDwellSeconds: number;
  pollIntervalSeconds: number;
  sampleTolerance?: number;
  samples: StableAuthenticatedOpenSample[];
}

export type StableAuthenticatedOpenResult =
  | {
      shouldResolve: true;
      reason: 'stable_authenticated_open';
      observedSamples: number;
      requiredSamples: number;
    }
  | {
      shouldResolve: false;
      reason: 'window_not_elapsed' | 'insufficient_samples' | 'contradicting_sample';
      observedSamples: number;
      requiredSamples: number;
    };

export function evaluateStableAuthenticatedOpen(
  input: StableAuthenticatedOpenEvaluation,
): StableAuthenticatedOpenResult {
  const startedAt = parseIsoMs(input.windowStartedAt);
  const evaluatedAt = parseIsoMs(input.evaluatedAt);
  const quietDwellMs = positiveSeconds(input.quietDwellSeconds, 'quietDwellSeconds') * 1000;
  const pollIntervalSeconds = positiveSeconds(input.pollIntervalSeconds, 'pollIntervalSeconds');
  const tolerance = Math.max(0, Math.floor(input.sampleTolerance ?? 0));
  const requiredSamples = Math.max(1, Math.floor(input.quietDwellSeconds / pollIntervalSeconds) - tolerance);

  const relevantSamples = input.samples.filter((sample) => {
    const sampledAt = parseIsoMs(sample.sampledAt);
    return sampledAt >= startedAt && sampledAt <= evaluatedAt;
  });

  const base = {
    observedSamples: relevantSamples.length,
    requiredSamples,
  };

  if (evaluatedAt - startedAt < quietDwellMs) {
    return { shouldResolve: false, reason: 'window_not_elapsed', ...base };
  }

  if (relevantSamples.length < requiredSamples) {
    return { shouldResolve: false, reason: 'insufficient_samples', ...base };
  }

  if (relevantSamples.some(sample => !isStableAuthenticatedOpenSample(sample))) {
    return { shouldResolve: false, reason: 'contradicting_sample', ...base };
  }

  return { shouldResolve: true, reason: 'stable_authenticated_open', ...base };
}

export function isStableAuthenticatedOpenSample(sample: StableAuthenticatedOpenSample): boolean {
  return (
    sample.connected === true &&
    sample.accountStatus === 'present' &&
    sample.connectionState === 'connected' &&
    sample.reconnectPhase === null &&
    sample.reconnectAttempts === 0 &&
    sample.recentDisconnectCount === 0
  );
}

function parseIsoMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('unsupported stable-authenticated-open timestamp');
  }
  return parsed;
}

function positiveSeconds(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`unsupported stable-authenticated-open ${field}`);
  }
  return value;
}
