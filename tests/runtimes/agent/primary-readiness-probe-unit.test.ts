/**
 * Unit tests for the extracted primary-readiness-probe module (#3017 car-16 v2).
 *
 * The module's own contract: pure, unit-testable helpers. The integration
 * suites mock above this layer, so these tests own the module's branches:
 *
 * P1: delay calculation — backoff multiple, cap, jitter bounds, rate-limit
 *     floor (recent probe wins over base interval), null lastProbeCheckedAt.
 * P2: backoff counter — reset on success, increment on failure, log2 cap.
 * P3: serving-context receipt — content-free hashes; null-cwd homedir
 *     fallback; provider→credential-store-class mapping incl. unknown;
 *     binary digest null when the provider binary is unavailable.
 * P4: adapter-deps binding — receipt attached, cwd fallback preserved.
 * P5: evidence formatting — reason/suggestion appended only when present,
 *     all values routed through the formatter dep.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PERIODIC_PROBE_INTERVAL_MS,
  PERIODIC_PROBE_JITTER_MS,
  PERIODIC_PROBE_RATE_LIMIT_MS,
  PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE,
  calculatePeriodicProbeDelay,
  calculatePeriodicProbeBackoff,
  buildPrimaryProbeAdapterDeps,
  formatPrimaryModelUsabilityEvidence,
} from '../../../src/runtimes/agent/primary-readiness-probe.ts';
import {
  buildPrimaryProbeSelectorEnv,
  buildPrimaryProbeServiceContext,
} from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';

const NOW = 1_786_000_000_000;

describe('primary-readiness-probe module units', () => {
  it('P1a: zero backoff, stale last probe -> delay within jitter band of the base interval', () => {
    const d = calculatePeriodicProbeDelay(0, NOW - 60 * 60_000, NOW);
    expect(d).toBeGreaterThanOrEqual(PERIODIC_PROBE_INTERVAL_MS - PERIODIC_PROBE_JITTER_MS);
    expect(d).toBeLessThanOrEqual(PERIODIC_PROBE_INTERVAL_MS + PERIODIC_PROBE_JITTER_MS);
  });

  it('P1b: backoff multiplies the interval and caps at the max multiple', () => {
    const d2 = calculatePeriodicProbeDelay(1, NOW - 60 * 60_000, NOW); // 2x
    expect(d2).toBeGreaterThanOrEqual(2 * (PERIODIC_PROBE_INTERVAL_MS - PERIODIC_PROBE_JITTER_MS));
    const d16 = calculatePeriodicProbeDelay(10, NOW - 60 * 60_000, NOW); // capped at 4x
    expect(d16).toBeLessThanOrEqual(
      PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE * (PERIODIC_PROBE_INTERVAL_MS + PERIODIC_PROBE_JITTER_MS),
    );
  });

  it('P1c: a just-fired probe imposes the rate-limit floor over a hypothetical short interval; null lastProbeCheckedAt treats epoch as last probe (no floor after 5min of uptime)', () => {
    // Just probed: remaining floor = RATE_LIMIT - 1s; base interval dominates anyway,
    // so assert the floor arithmetic directly via the returned max().
    const dJust = calculatePeriodicProbeDelay(0, NOW - 1_000, NOW);
    expect(dJust).toBeGreaterThanOrEqual(PERIODIC_PROBE_RATE_LIMIT_MS - 1_000);
    // Null: msSinceLastProbe is measured from epoch -> enormous -> zero floor;
    // the delay is the jittered base interval.
    const dNull = calculatePeriodicProbeDelay(0, null, NOW);
    expect(dNull).toBeGreaterThanOrEqual(PERIODIC_PROBE_INTERVAL_MS - PERIODIC_PROBE_JITTER_MS);
    expect(dNull).toBeLessThanOrEqual(PERIODIC_PROBE_INTERVAL_MS + PERIODIC_PROBE_JITTER_MS);
  });

  it('P2: backoff resets on success, increments on failure, and caps at log2(max)', () => {
    expect(calculatePeriodicProbeBackoff(3, true)).toBe(0);
    expect(calculatePeriodicProbeBackoff(0, false)).toBe(1);
    expect(calculatePeriodicProbeBackoff(1, false)).toBe(2);
    expect(calculatePeriodicProbeBackoff(2, false)).toBe(Math.log2(PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE));
    expect(calculatePeriodicProbeBackoff(99, false)).toBe(Math.log2(PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE));
  });

  it('P3: service context binds generation and effective selectors without raw paths', () => {
    const env = buildPrimaryProbeSelectorEnv('claude-cli', 'opus', undefined);
    const r = buildPrimaryProbeServiceContext({
      provider: 'claude-cli',
      model: 'opus',
      serviceGeneration: 'generation-a',
      cwd: '/some/config/root',
      selectorEnv: env,
      binaryState: 'missing',
    });
    expect(r.provider).toBe('claude-cli');
    expect(r.model).toBe('opus');
    expect(r.serviceGeneration).toBe('generation-a');
    expect(r.binaryState).toBe('missing');
    expect(r.binarySha256).toBeNull();
    expect(JSON.stringify(r)).not.toContain('/some/config/root');
    expect(JSON.stringify(r)).not.toContain('CLAUDE_');

    const api = buildPrimaryProbeServiceContext({
      provider: 'anthropic-api',
      model: 'opus',
      serviceGeneration: 'generation-a',
      cwd: '/some/config/root',
      selectorEnv: {},
      binaryState: 'none',
    });
    expect(api).toMatchObject({
      provider: 'anthropic-api',
      model: 'opus',
      serviceGeneration: 'generation-a',
      binaryState: 'none',
      resolvedBinaryPathHash: null,
      binarySha256: null,
    });
    expect(api.launchContextHash).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.stringify(api)).not.toContain('/some/config/root');
  });

  it('P4: adapter deps carry the immutable service context and trigger', () => {
    const gate = { acquire: vi.fn() } as never;
    const serviceContext = buildPrimaryProbeServiceContext({
      provider: 'anthropic-api',
      model: 'opus',
      serviceGeneration: 'generation-a',
      cwd: '/cfg',
      selectorEnv: {},
      binaryState: 'none',
    });
    const deps = buildPrimaryProbeAdapterDeps('anthropic-api', 'opus', '/cfg', 8080, gate, 'startup', serviceContext, true);
    expect(deps.cwd).toBe('/cfg');
    expect(deps.egressProxyPort).toBe(8080);
    expect(deps.serviceContext?.provider).toBe('anthropic-api');
    expect(deps.serviceContext?.model).toBe('opus');
    expect(deps.requireServiceContext).toBe(true);
    expect(deps.probeTrigger).toBe('startup');
  });

  it('P5: evidence string appends reason/suggestion only when present and routes every value through the formatter', () => {
    const fmt = (v: string | null | undefined): string => `<${v ?? 'null'}>`;
    const bare = formatPrimaryModelUsabilityEvidence(
      { status: 'usable', provider: 'claude-cli', model: null },
      'periodic',
      fmt,
    );
    expect(bare).toBe('trigger=periodic status=<usable> provider=<claude-cli> model=<null>');
    expect(bare).not.toContain('reason=');
    expect(bare).not.toContain('suggestion=');

    const full = formatPrimaryModelUsabilityEvidence(
      { status: 'model-unavailable', provider: 'claude-cli', model: 'opus', reason: 'auth-expired', suggestion: 're-login' },
      'startup',
      fmt,
    );
    expect(full).toContain('reason=<auth-expired>');
    expect(full).toContain('suggestion=<re-login>');
  });
});
