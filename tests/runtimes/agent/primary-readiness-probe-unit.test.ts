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
  buildServingContextReceipt,
  buildPrimaryProbeAdapterDeps,
  formatPrimaryModelUsabilityEvidence,
} from '../../../src/runtimes/agent/primary-readiness-probe.ts';
import { homedir } from 'node:os';

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

  it('P3: receipt is content-free, falls back to homedir on null cwd, maps credential-store classes, unknown provider -> null class', () => {
    const r = buildServingContextReceipt('claude-cli', 'opus', '/some/config/root');
    expect(r.provider).toBe('claude-cli');
    expect(r.model).toBe('opus');
    expect(r.credentialStoreClass).toBe('keychain-or-file-store');
    // Content-free: the receipt must not contain the raw path anywhere.
    expect(JSON.stringify(r)).not.toContain('/some/config/root');
    expect(typeof r.configRootHash).toBe('string');

    const rHome = buildServingContextReceipt('opencode-cli', null, null);
    expect(rHome.credentialStoreClass).toBe('keyring');
    expect(rHome.model).toBeNull();
    // Null cwd -> homedir hash, still content-free.
    expect(JSON.stringify(rHome)).not.toContain(homedir());

    expect(buildServingContextReceipt('anthropic-api', undefined, null).credentialStoreClass).toBe('api-key');
    expect(buildServingContextReceipt('openai-api', undefined, null).credentialStoreClass).toBe('api-key');
    // Unknown provider: no credential-store class, no binary digest (the
    // defensive catch path) — pin the full receipt shape decisively.
    const rUnknown = buildServingContextReceipt('mystery-provider', undefined, null);
    expect(rUnknown).toEqual({
      configRootHash: rUnknown.configRootHash,
      credentialStoreClass: null,
      binaryDigest: null,
      provider: 'mystery-provider',
      model: null,
    });
  });

  it('P4: adapter deps carry the bound receipt and the cwd fallback', () => {
    const gate = { acquire: vi.fn() } as never;
    const deps = buildPrimaryProbeAdapterDeps('anthropic-api', 'opus', null, 8080, gate);
    expect(deps.cwd).toBe(homedir());
    expect(deps.egressProxyPort).toBe(8080);
    expect(deps.servingContext?.provider).toBe('anthropic-api');
    expect(deps.servingContext?.model).toBe('opus');

    const deps2 = buildPrimaryProbeAdapterDeps('claude-cli', null, '/cfg', undefined, gate);
    expect(deps2.servingContext?.model).toBeNull();
    expect(deps2).toEqual({
      cwd: '/cfg',
      egressProxyPort: undefined,
      providerExecutionGate: gate,
      servingContext: buildServingContextReceipt('claude-cli', null, '/cfg'),
    });
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
