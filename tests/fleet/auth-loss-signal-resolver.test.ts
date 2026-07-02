import { describe, expect, it } from 'vitest';
import { evaluateStableAuthenticatedOpen } from '../../src/fleet/auth-loss-signal-resolver.ts';

const baseSample = {
  connected: true,
  accountStatus: 'present' as const,
  connectionState: 'connected',
  reconnectPhase: null,
  reconnectAttempts: 0,
  recentDisconnectCount: 0,
};

function sampleAt(offsetSeconds: number, overrides: Partial<typeof baseSample> = {}) {
  return {
    sampledAt: new Date(Date.parse('2026-06-30T06:00:00.000Z') + offsetSeconds * 1000).toISOString(),
    ...baseSample,
    ...overrides,
  };
}

describe('evaluateStableAuthenticatedOpen', () => {
  it('resolves when every sampled poll in the quiet dwell window proves linked and connected', () => {
    const result = evaluateStableAuthenticatedOpen({
      windowStartedAt: '2026-06-30T06:00:00.000Z',
      evaluatedAt: '2026-06-30T07:10:00.000Z',
      quietDwellSeconds: 4137,
      pollIntervalSeconds: 600,
      sampleTolerance: 1,
      samples: [0, 600, 1200, 1800, 2400, 3000, 3600, 4200].map(offset => sampleAt(offset)),
    });

    expect(result).toEqual({
      shouldResolve: true,
      reason: 'stable_authenticated_open',
      observedSamples: 8,
      requiredSamples: 5,
    });
  });

  it('does not resolve when a contradiction appears inside the quiet dwell window', () => {
    const result = evaluateStableAuthenticatedOpen({
      windowStartedAt: '2026-06-30T06:00:00.000Z',
      evaluatedAt: '2026-06-30T07:10:00.000Z',
      quietDwellSeconds: 4137,
      pollIntervalSeconds: 600,
      sampleTolerance: 1,
      samples: [
        sampleAt(0),
        sampleAt(600),
        sampleAt(1200, { recentDisconnectCount: 1 }),
        sampleAt(1800),
        sampleAt(2400),
        sampleAt(3000),
        sampleAt(3600),
        sampleAt(4200),
      ],
    });

    expect(result).toMatchObject({
      shouldResolve: false,
      reason: 'contradicting_sample',
      observedSamples: 8,
      requiredSamples: 5,
    });
  });

  it('does not treat missing poll samples as quiet', () => {
    const result = evaluateStableAuthenticatedOpen({
      windowStartedAt: '2026-06-30T06:00:00.000Z',
      evaluatedAt: '2026-06-30T07:10:00.000Z',
      quietDwellSeconds: 4137,
      pollIntervalSeconds: 600,
      sampleTolerance: 1,
      samples: [0, 600, 1200, 1800].map(offset => sampleAt(offset)),
    });

    expect(result).toEqual({
      shouldResolve: false,
      reason: 'insufficient_samples',
      observedSamples: 4,
      requiredSamples: 5,
    });
  });

  it('does not resolve before the quiet dwell window has elapsed', () => {
    const result = evaluateStableAuthenticatedOpen({
      windowStartedAt: '2026-06-30T06:00:00.000Z',
      evaluatedAt: '2026-06-30T06:30:00.000Z',
      quietDwellSeconds: 4137,
      pollIntervalSeconds: 600,
      sampleTolerance: 1,
      samples: [0, 600, 1200, 1800].map(offset => sampleAt(offset)),
    });

    expect(result).toEqual({
      shouldResolve: false,
      reason: 'window_not_elapsed',
      observedSamples: 4,
      requiredSamples: 5,
    });
  });
});
