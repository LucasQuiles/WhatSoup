import { describe, expect, it } from 'vitest';
import { validateInstanceConfig, type ValidatorContext } from '../../src/core/agent-config-validator.ts';

const ctx: ValidatorContext = { name: 'distill-agent', mode: 'load' };
const agent = (handoffDistill: unknown): Record<string, unknown> => ({
  name: 'distill-agent',
  type: 'agent',
  accessMode: 'self_only',
  adminPhones: ['15551234567'],
  agentOptions: { sessionScope: 'per_chat', handoffDistill },
});

describe('agentOptions.handoffDistill', () => {
  it('accepts the exact bounded DeepSeek Flash configuration', () => {
    expect(validateInstanceConfig(agent({
      enabled: true,
      contextInjection: false,
      provider: 'deepseek',
      model: 'deepseek-flash',
      growthThreshold: 500,
      maxCallsPerWindow: 1,
      maxTokensPerWindow: 1_000,
      globalConcurrency: 1,
    }), ctx)).toBeNull();
  });

  it('rejects an enabled arbitrary model before the launcher can project a key', () => {
    const result = validateInstanceConfig(agent({
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    }), ctx);
    expect(result?.field).toBe('agentOptions.handoffDistill.model');
  });

  it('accepts an explicit disabled kill switch without a model', () => {
    expect(validateInstanceConfig(agent({ enabled: false }), ctx)).toBeNull();
  });
});
