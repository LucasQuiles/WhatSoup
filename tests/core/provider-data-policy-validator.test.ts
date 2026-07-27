import { describe, expect, it } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';

const ctx = { name: 'policy-test', mode: 'create' } as const;

function raw(agentOptions: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'policy-test',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 19095,
    systemPrompt: 'hi',
    agentOptions: { sessionScope: 'single', provider: 'claude-cli', ...agentOptions },
  };
}

describe('provider data policy config admission', () => {
  it('accepts missing policy in compatibility shadow mode', () => {
    expect(validateInstanceConfig(raw({}), ctx)).toBeNull();
    expect(validateInstanceConfig(raw({ providerBoundaryMode: 'shadow' }), ctx)).toBeNull();
  });

  it('requires primary and every fallback policy in enforce mode', () => {
    expect(validateInstanceConfig(raw({ providerBoundaryMode: 'enforce' }), ctx)?.field)
      .toBe('agentOptions.providerDataPolicy');
    expect(validateInstanceConfig(raw({
      providerBoundaryMode: 'enforce',
      providerDataPolicy: 'trusted',
      fallbacks: [{ provider: 'openai-api', model: 'gpt-5' }],
    }), ctx)?.field).toBe('agentOptions.fallbacks[0].dataPolicy');
  });

  it('validates primary, fallback-array, and legacy policy spellings', () => {
    expect(validateInstanceConfig(raw({ providerDataPolicy: 'private' }), ctx)?.field)
      .toBe('agentOptions.providerDataPolicy');
    expect(validateInstanceConfig(raw({
      fallbacks: [{ provider: 'openai-api', model: 'gpt-5', dataPolicy: 'private' }],
    }), ctx)?.field).toBe('agentOptions.fallbacks[0].dataPolicy');
    expect(validateInstanceConfig(raw({
      fallbackProvider: 'openai-api', fallbackModel: 'gpt-5', fallbackDataPolicy: 'private',
    }), ctx)?.field).toBe('agentOptions.fallbackDataPolicy');
    expect(validateInstanceConfig(raw({ providerBoundaryMode: 'active' }), ctx)?.field)
      .toBe('agentOptions.providerBoundaryMode');
  });

  it('rejects restricted CLI routes with a mechanical-isolation explanation', () => {
    const primary = validateInstanceConfig(raw({ providerDataPolicy: 'restricted' }), ctx);
    expect(primary?.field).toBe('agentOptions.providerDataPolicy');
    expect(primary?.message).toMatch(/mechanical isolation/i);

    const fallback = validateInstanceConfig(raw({
      providerDataPolicy: 'trusted',
      fallbacks: [{ provider: 'codex-cli', dataPolicy: 'restricted' }],
    }), ctx);
    expect(fallback?.field).toBe('agentOptions.fallbacks[0].dataPolicy');
    expect(fallback?.message).toMatch(/mechanical isolation/i);
  });

  it('distinguishes duplicate entries from conflicting policies on one route', () => {
    const conflict = validateInstanceConfig(raw({
      fallbacks: [
        { provider: 'openai-api', model: 'gpt-5', dataPolicy: 'trusted' },
        { provider: 'openai-api', model: 'gpt-5', dataPolicy: 'restricted' },
      ],
    }), ctx);
    expect(conflict?.field).toBe('agentOptions.fallbacks[1].dataPolicy');
    expect(conflict?.message).toMatch(/conflict/i);
  });

  it('accepts a fully classified managed fallback in enforce mode', () => {
    expect(validateInstanceConfig(raw({
      providerBoundaryMode: 'enforce',
      providerDataPolicy: 'trusted',
      fallbackProvider: 'openai-api',
      fallbackModel: 'gpt-5',
      fallbackDataPolicy: 'restricted',
    }), ctx)).toBeNull();
  });
});
