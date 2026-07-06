import { describe, it, expect } from 'vitest';
import { buildFinishPatch } from '../../console/src/lib/wizard-finish.ts';

describe('buildFinishPatch', () => {
  it('drops raw key fields from the PATCH payload and routes them as credential writes', () => {
    const formData = {
      name: 'w', type: 'agent',
      agentOptions: { provider: 'openai-api', providerConfig: { apiKeyService: 'groq' } },
      apiKey: 'sk-ant-x', openaiKey: 'gsk-x', description: 'keep',
    };
    const { patch, credentials } = buildFinishPatch(formData);
    expect(patch).not.toHaveProperty('apiKey');
    expect(patch).not.toHaveProperty('openaiKey');
    expect(patch.description).toBe('keep');
    expect(patch.agentOptions).toEqual(formData.agentOptions);
    expect(credentials).toEqual([
      { service: 'anthropic', value: 'sk-ant-x' },
      { service: 'groq', value: 'gsk-x' },
    ]);
    expect(formData.apiKey).toBe('sk-ant-x'); // input not mutated
  });

  it('no keys -> patch equals input, zero credentials', () => {
    const formData = { name: 'w', type: 'chat' };
    const { patch, credentials } = buildFinishPatch(formData);
    expect(patch).toEqual(formData);
    expect(credentials).toEqual([]);
  });
});
