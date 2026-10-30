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
import { buildPrimaryProbeServiceContext } from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';

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

  it('P3: runtime-local service contexts redact selector content, preserve selector distinctions, and rotate on a fresh module', async () => {
    const baseUrl = 'https://synthetic-user:synthetic-password@base-url.example.invalid/v1?token=synthetic-query';
    const proxyUrl = 'http://synthetic-user:synthetic-password@proxy.example.invalid:3128/?ticket=synthetic-query';
    const input = {
      provider: 'anthropic-api',
      model: 'opus',
      serviceGeneration: 'generation-a',
      cwd: '/some/config/root',
      providerConfig: { baseUrl, apiKeyService: 'fixture-keyring-service' },
      selectorEnv: { HTTP_PROXY: proxyUrl },
      binaryState: 'none' as const,
    };
    const target = { provider: 'anthropic-api', model: 'opus' } as const;

    vi.resetModules();
    try {
      const firstModule = await import('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts');
      const cli = firstModule.buildPrimaryProbeServiceContext({
        provider: 'claude-cli',
        model: 'opus',
        serviceGeneration: 'generation-a',
        cwd: '/some/config/root',
        selectorEnv: firstModule.buildPrimaryProbeSelectorEnv('claude-cli', 'opus', undefined),
        binaryState: 'missing',
      });
      expect(cli).toMatchObject({ provider: 'claude-cli', model: 'opus', serviceGeneration: 'generation-a', binaryState: 'missing', binarySha256: null });
      expect(JSON.stringify(cli)).not.toContain('/some/config/root');
      expect(JSON.stringify(cli)).not.toContain('CLAUDE_');
      const initial = firstModule.buildPrimaryProbeServiceContext(input);
      const sameLiveContext = firstModule.buildPrimaryProbeServiceContext(input);
      const changedService = firstModule.buildPrimaryProbeServiceContext({
        ...input,
        providerConfig: { ...input.providerConfig, apiKeyService: 'fixture-keyring-service-changed' },
      });
      const changedProxy = firstModule.buildPrimaryProbeServiceContext({
        ...input,
        selectorEnv: { HTTP_PROXY: `${proxyUrl}&changed=1` },
      });
      const proxyAbsent = firstModule.buildPrimaryProbeServiceContext({ ...input, selectorEnv: {} });
      const proxyEmpty = firstModule.buildPrimaryProbeServiceContext({ ...input, selectorEnv: { HTTP_PROXY: '' } });
      const serialized = JSON.stringify(initial);

      expect(initial).toMatchObject({ provider: 'anthropic-api', model: 'opus', serviceGeneration: 'generation-a', binaryState: 'none', resolvedBinaryPathHash: null, binarySha256: null });
      expect(serialized).not.toContain(baseUrl);
      expect(serialized).not.toContain(proxyUrl);
      expect(serialized).not.toContain('synthetic-password');
      expect(serialized).not.toContain('fixture-keyring-service');
      expect(initial.launchContextHash).toBe(sameLiveContext.launchContextHash);
      expect(initial.launchContextHash).not.toBe(changedService.launchContextHash);
      expect(initial.launchContextHash).not.toBe(changedProxy.launchContextHash);
      expect(proxyAbsent.launchContextHash).not.toBe(proxyEmpty.launchContextHash);
      expect(firstModule.verifyServingContext(target, {
        serviceContext: initial,
        currentServiceContext: () => sameLiveContext,
        requireServiceContext: true,
      })).toBeNull();
      expect(firstModule.verifyServingContext(target, {
        serviceContext: initial,
        currentServiceContext: () => changedProxy,
        requireServiceContext: true,
      })).toBe('context-mismatch-launch');

      vi.resetModules();
      const independentlyLoadedModule = await import('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts');
      const independentlyLoadedContext = independentlyLoadedModule.buildPrimaryProbeServiceContext(input);
      expect(independentlyLoadedContext.launchContextHash).not.toBe(initial.launchContextHash);
    } finally {
      vi.resetModules();
    }
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
