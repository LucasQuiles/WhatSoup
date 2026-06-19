import { describe, expect, it } from 'vitest';
import { AGENT_PROVIDERS } from '../../../src/runtimes/agent/providers/types.ts';
import { seamForProvider, assertSeamRoutingConsistency, HANDOFF_SEAM_ROUTING } from '../../../src/runtimes/agent/handoff-seam-routing.ts';

describe('handoff-seam-routing', () => {
  it('routes every known provider (exhaustive)', () => {
    for (const p of AGENT_PROVIDERS) {
      expect(['system', 'first-turn']).toContain(seamForProvider(p));
    }
  });
  it('routes the experiment-validated cheap path to system', () => {
    expect(seamForProvider('opencode-cli')).toBe('system');
  });
  it('boot guard passes for the shipped table', () => {
    expect(() => assertSeamRoutingConsistency()).not.toThrow();
  });
  it('boot guard throws if a provider is unmapped', () => {
    const partial = { ...HANDOFF_SEAM_ROUTING } as Record<string, 'system' | 'first-turn'>;
    delete partial['opencode-cli'];
    expect(() => assertSeamRoutingConsistency(partial)).toThrow(/opencode-cli/);
  });
  it('falls back to first-turn (never lose context) for an unmapped provider', () => {
    // An unmapped/drifted provider hits the `?? 'first-turn'` safe default rather
    // than returning undefined and silently dropping handoff context.
    expect(seamForProvider('drifted-unknown-provider' as (typeof AGENT_PROVIDERS)[number])).toBe('first-turn');
  });
});
