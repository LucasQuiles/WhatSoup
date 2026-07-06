import { describe, it, expect } from 'vitest';
import {
  PLAINTEXT_PROVIDER_KEY_FIELDS,
  stripPlaintextProviderKeys,
} from '../../src/lib/config-plaintext-keys.ts';

describe('stripPlaintextProviderKeys', () => {
  it('locks the exact field list', () => {
    expect([...PLAINTEXT_PROVIDER_KEY_FIELDS].sort()).toEqual(['apiKey', 'openaiKey']);
  });

  it('removes top-level plaintext key fields and reports them', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      name: 'x', apiKey: 'sk-ant-secret', openaiKey: 'sk-secret', description: 'keep me',
    });
    expect(removed.sort()).toEqual(['apiKey', 'openaiKey']);
    expect(clean).toEqual({ name: 'x', description: 'keep me' });
  });

  it('is a no-op on clean configs and does not mutate its input', () => {
    const input = { name: 'x', agentOptions: { provider: 'openai-api' } };
    const { clean, removed } = stripPlaintextProviderKeys(input);
    expect(removed).toEqual([]);
    expect(clean).toEqual(input);
    expect(input).toEqual({ name: 'x', agentOptions: { provider: 'openai-api' } });
  });

  it('only strips at the top level — nested same-named fields are untouched', () => {
    const { clean, removed } = stripPlaintextProviderKeys({
      memory: { apiKey: 'nested-not-ours' },
    });
    expect(removed).toEqual([]);
    expect(clean).toEqual({ memory: { apiKey: 'nested-not-ours' } });
  });
});
