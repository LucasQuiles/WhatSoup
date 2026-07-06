import { describe, expect, it, vi } from 'vitest';

import {
  CREDENTIAL_PROBE_DESCRIPTORS,
  credentialProbeServices,
} from '../../src/lib/provider-credential-probes.ts';
import { PROVIDER_VERIFY_DESCRIPTORS } from '../../src/fleet/routes/providers.ts';
import { verifyFallbackCredential } from '../../src/runtimes/agent/providers/credential-verify.ts';

// Two credential validity probe lists used to diverge:
//   - arm-time fallback pre-flight (credential-verify.ts) probed deepseek,
//     minimax, openai;
//   - the fleet /verify route (providers.ts) probed openai, deepseek,
//     anthropic.
// The same "is this key valid?" question could answer differently depending
// on which path asked, and the providers.ts comment falsely claimed MiniMax
// had no stable list-models endpoint. Both paths now derive from ONE shared
// map (src/lib/provider-credential-probes.ts) — this file locks the
// convergence so a future edit to either consumer without touching the
// shared map fails loudly instead of silently re-diverging.

const EXPECTED_SERVICES = ['anthropic', 'deepseek', 'minimax', 'openai'];

/** Behaviorally derive whether `service` is probed at arm time (no internals exported). */
async function isArmTimeProbed(service: string): Promise<boolean> {
  const fetchSpy = vi.fn(async () => ({ status: 200, ok: true }));
  const result = await verifyFallbackCredential(
    service,
    'probe-list-lock-key',
    fetchSpy as unknown as typeof fetch,
  );
  return result === 'valid' && fetchSpy.mock.calls.length > 0;
}

describe('credential validity probe lists converge on one shared map', () => {
  it('the shared descriptor map is exactly {anthropic, deepseek, minimax, openai}', () => {
    expect(credentialProbeServices()).toEqual(EXPECTED_SERVICES);
    expect(Object.keys(CREDENTIAL_PROBE_DESCRIPTORS).sort()).toEqual(EXPECTED_SERVICES);
  });

  it('the /verify route descriptor set equals the shared map', () => {
    expect(Object.keys(PROVIDER_VERIFY_DESCRIPTORS).sort()).toEqual(EXPECTED_SERVICES);
  });

  it('the arm-time probe set, derived behaviorally, equals the shared map', async () => {
    const probed: string[] = [];
    for (const service of EXPECTED_SERVICES) {
      if (await isArmTimeProbed(service)) probed.push(service);
    }
    expect(probed.sort()).toEqual(EXPECTED_SERVICES);
  });

  it('minimax is probed on both the arm-time and /verify-route paths', async () => {
    expect(await isArmTimeProbed('minimax')).toBe(true);
    expect(PROVIDER_VERIFY_DESCRIPTORS['minimax']).toEqual({
      url: 'https://api.minimax.io/v1/models',
      method: 'GET',
      auth: 'bearer',
    });
  });

  it('anthropic is probed on both the arm-time and /verify-route paths', async () => {
    expect(await isArmTimeProbed('anthropic')).toBe(true);
    expect(PROVIDER_VERIFY_DESCRIPTORS['anthropic']).toEqual({
      url: 'https://api.anthropic.com/v1/models',
      method: 'GET',
      auth: 'x-api-key',
      extraHeaders: { 'anthropic-version': '2023-06-01' },
    });
  });

  it('asserts the per-service auth shape', () => {
    for (const service of ['openai', 'deepseek', 'minimax']) {
      expect(CREDENTIAL_PROBE_DESCRIPTORS[service]!.auth).toBe('bearer');
    }
    expect(CREDENTIAL_PROBE_DESCRIPTORS.anthropic!.auth).toBe('x-api-key');
    expect(CREDENTIAL_PROBE_DESCRIPTORS.anthropic!.extraHeaders).toEqual({
      'anthropic-version': '2023-06-01',
    });
  });
});
