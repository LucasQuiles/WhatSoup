import { describe, expect, it, vi } from 'vitest';

import { PROVIDER_VERIFY_DESCRIPTORS } from '../../src/fleet/routes/providers.ts';
import { SERVICE_ENV_MAP } from '../../src/lib/provider-key-service.ts';
import { verifyFallbackCredential } from '../../src/runtimes/agent/providers/credential-verify.ts';

// Two credential validity probe lists exist and DIVERGE today:
//   - arm-time fallback pre-flight: PROBE_ENDPOINTS in
//     src/runtimes/agent/providers/credential-verify.ts = deepseek, minimax,
//     openai (derived behaviorally below — the const is module-private);
//   - fleet route POST /api/credentials/:service/verify:
//     PROVIDER_VERIFY_DESCRIPTORS in src/fleet/routes/providers.ts = openai,
//     deepseek, anthropic.
// Neither is a subset of the other (minimax arm-time only; anthropic route
// only), and the providers.ts comment claims MiniMax has no stable
// list-models endpoint while credential-verify.ts probes one. The same "is
// this key valid?" question can answer differently by path. These exact-set
// locks exist so ANY change to either list forces conscious reconciliation
// of both (ideally into one shared map) instead of growing the divergence
// silently.

async function isArmTimeProbed(service: string): Promise<boolean> {
  const fetchSpy = vi.fn(async () => ({ status: 200, ok: true }));
  const result = await verifyFallbackCredential(
    service,
    'probe-list-lock-key',
    fetchSpy as unknown as typeof fetch,
  );
  return result === 'valid' && fetchSpy.mock.calls.length > 0;
}

describe('credential validity probe lists', () => {
  it('locks the fleet verify-route descriptor set', () => {
    expect(Object.keys(PROVIDER_VERIFY_DESCRIPTORS).sort()).toEqual([
      'anthropic',
      'deepseek',
      'openai',
    ]);
  });

  it('locks the arm-time probe set, derived behaviorally', async () => {
    const probed: string[] = [];
    for (const service of Object.keys(SERVICE_ENV_MAP)) {
      if (await isArmTimeProbed(service)) probed.push(service);
    }
    expect(probed.sort()).toEqual(['deepseek', 'minimax', 'openai']);
  });

  it('documents the known divergence between the two lists', () => {
    const routeSet = new Set(Object.keys(PROVIDER_VERIFY_DESCRIPTORS));
    // If either assertion flips, the divergence changed: update this test,
    // the comment block above, and consider merging the lists into one SSOT.
    expect(routeSet.has('minimax')).toBe(false);
    expect(routeSet.has('anthropic')).toBe(true);
  });
});
