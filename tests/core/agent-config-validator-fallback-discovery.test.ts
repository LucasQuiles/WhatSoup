/**
 * agentOptions.fallbackDiscovery admission (R6 discovery-mode fallback) + the
 * keyless free-tier route the discovery tail depends on.
 *
 * Discovery mode derives the chain per host from the gateway's model
 * catalogue, so admission's job is narrow: reject malformed policy shapes and
 * refuse the ambiguous combination of a derived AND operator-specified chain.
 */
import { describe, it, expect } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';
import { normalizeFallbackDiscoveryFromAgentOptions } from '../../src/core/fallback-chain.ts';

function agentRaw(
  agentOptions: Record<string, unknown>,
  topLevel: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 9095,
    systemPrompt: 'hi',
    agentOptions: {
      sessionScope: 'single',
      provider: 'claude-cli',
      ...agentOptions,
    },
    ...topLevel,
  };
}

const createCtx = { name: 'test-line', mode: 'create' } as const;

describe('validateInstanceConfig — fallbackDiscovery', () => {
  it('accepts the minimal discovery block', () => {
    expect(validateInstanceConfig(agentRaw({ fallbackDiscovery: { mode: 'auto' } }), createCtx)).toBeNull();
  });

  it('accepts the full tuned shape', () => {
    expect(
      validateInstanceConfig(
        agentRaw({
          fallbackDiscovery: {
            mode: 'auto',
            maxEntries: 4,
            preferModels: { glm: 'glm/glm-5.2' },
            excludeProviders: ['kimi'],
            includeFreeTier: false,
          },
        }),
        createCtx,
      ),
    ).toBeNull();
  });

  it('accepts discovery alongside an EMPTY fallbacks list', () => {
    expect(
      validateInstanceConfig(agentRaw({ fallbackDiscovery: { mode: 'auto' }, fallbacks: [] }), createCtx),
    ).toBeNull();
  });

  it('rejects discovery combined with a non-empty fallbacks list', () => {
    const err = validateInstanceConfig(
      agentRaw({
        fallbackDiscovery: { mode: 'auto' },
        fallbacks: [{ provider: 'opencode-cli', model: 'deepseek/deepseek-v4-pro' }],
      }),
      createCtx,
    );
    expect(err?.field).toBe('agentOptions.fallbackDiscovery');
    expect(err?.message).toMatch(/non-empty agentOptions\.fallbacks/);
  });

  it('rejects discovery combined with the legacy fallbackProvider pair', () => {
    const err = validateInstanceConfig(
      agentRaw({
        fallbackDiscovery: { mode: 'auto' },
        fallbackProvider: 'opencode-cli',
        fallbackModel: 'deepseek/deepseek-v4-pro',
      }),
      createCtx,
    );
    expect(err?.field).toBe('agentOptions.fallbackDiscovery');
    expect(err?.message).toMatch(/fallbackProvider/);
  });

  it.each([
    [{ mode: 'manual' }, /mode must be "auto"/],
    ['auto', /must be an object/],
    [{ mode: 'auto', maxEntries: 0 }, /between 1 and 4/],
    [{ mode: 'auto', maxEntries: 5 }, /between 1 and 4/],
    [{ mode: 'auto', maxEntries: 2.5 }, /between 1 and 4/],
    [{ mode: 'auto', preferModels: { glm: '' } }, /non-empty model id/],
    [{ mode: 'auto', preferModels: ['glm/glm-5.2'] }, /must be an object/],
    [{ mode: 'auto', excludeProviders: 'kimi' }, /array of non-empty provider prefixes/],
    [{ mode: 'auto', excludeProviders: ['kimi', 7] }, /array of non-empty provider prefixes/],
    [{ mode: 'auto', includeFreeTier: 'yes' }, /must be a boolean/],
  ])('rejects malformed shape %j', (fallbackDiscovery, message) => {
    const err = validateInstanceConfig(agentRaw({ fallbackDiscovery }), createCtx);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(message);
  });

  it('accepts a static opencode-cli fallback entry on the KEYLESS free-tier prefix', () => {
    // Previously rejected as an unmapped credential service; buildChildEnv now
    // spawns these keyless, and admission mirrors the same predicate.
    expect(
      validateInstanceConfig(
        agentRaw({ fallbacks: [{ provider: 'opencode-cli', model: 'opencode/big-pickle' }] }),
        createCtx,
      ),
    ).toBeNull();
  });
});

describe('normalizeFallbackDiscoveryFromAgentOptions', () => {
  it('returns null when absent or mode is not auto', () => {
    expect(normalizeFallbackDiscoveryFromAgentOptions({})).toBeNull();
    expect(normalizeFallbackDiscoveryFromAgentOptions(null)).toBeNull();
    expect(normalizeFallbackDiscoveryFromAgentOptions({ fallbackDiscovery: { mode: 'manual' } })).toBeNull();
  });

  it('extracts the well-typed subset and drops junk fields', () => {
    expect(
      normalizeFallbackDiscoveryFromAgentOptions({
        fallbackDiscovery: {
          mode: 'auto',
          maxEntries: 2.9,
          preferModels: { glm: 'glm/glm-5.2', bad: 7 },
          excludeProviders: ['kimi', '', 3],
          includeFreeTier: 'yes',
        },
      }),
    ).toEqual({
      mode: 'auto',
      maxEntries: 2,
      preferModels: { glm: 'glm/glm-5.2' },
      excludeProviders: ['kimi'],
    });
  });
});
