import { describe, it, expect } from 'vitest';
import { planCredentialWrites } from '../../console/src/lib/credential-routing.ts';

const base = (agentOptions: Record<string, unknown>, keys: Record<string, string>) => ({
  name: 'w', type: 'agent', agentOptions, ...keys,
});

describe('planCredentialWrites — key-to-service routing matrix', () => {
  it('no keys entered -> no writes', () => {
    expect(planCredentialWrites(base({ provider: 'claude-cli' }, {}))).toEqual([]);
  });

  it('anthropic key defaults to service anthropic on a non-anthropic-api provider', () => {
    expect(planCredentialWrites(base(
      { provider: 'claude-cli', providerConfig: { apiKeyService: 'groq' } },
      { apiKey: 'sk-ant-1' },
    ))).toEqual([{ service: 'anthropic', value: 'sk-ant-1' }]);
  });

  it('anthropic key follows the explicit service ONLY on anthropic-api', () => {
    expect(planCredentialWrites(base(
      { provider: 'anthropic-api', providerConfig: { apiKeyService: 'prod-anthropic' } },
      { apiKey: 'sk-ant-2' },
    ))).toEqual([{ service: 'prod-anthropic', value: 'sk-ant-2' }]);
  });

  it('openai key follows the explicit service on openai-api', () => {
    expect(planCredentialWrites(base(
      { provider: 'openai-api', providerConfig: { apiKeyService: 'groq' } },
      { openaiKey: 'gsk-1' },
    ))).toEqual([{ service: 'groq', value: 'gsk-1' }]);
  });

  it('openai key follows the explicit service on opencode-cli ONLY for an openai-prefixed model', () => {
    expect(planCredentialWrites(base(
      { provider: 'opencode-cli', providerConfig: { apiKeyService: 'prod-openai', model: 'openai/gpt-5' } },
      { openaiKey: 'sk-3' },
    ))).toEqual([{ service: 'prod-openai', value: 'sk-3' }]);
    expect(planCredentialWrites(base(
      { provider: 'opencode-cli', providerConfig: { apiKeyService: 'prod-openai', model: 'minimax/MiniMax-M2' } },
      { openaiKey: 'sk-4' },
    ))).toEqual([{ service: 'openai', value: 'sk-4' }]);
  });

  it('a groq/openrouter explicit service NEVER receives the anthropic key', () => {
    const writes = planCredentialWrites(base(
      { provider: 'openai-api', providerConfig: { apiKeyService: 'openrouter' } },
      { apiKey: 'sk-ant-5', openaiKey: 'or-5' },
    ));
    expect(writes).toEqual([
      { service: 'anthropic', value: 'sk-ant-5' },
      { service: 'openrouter', value: 'or-5' },
    ]);
  });

  it('whitespace-only keys are ignored', () => {
    expect(planCredentialWrites(base({ provider: 'openai-api' }, { openaiKey: '   ' }))).toEqual([]);
  });

  it('skips the anthropic key when auth method is Existing Claude session (oauth), even if a stale key sits in form state', () => {
    expect(planCredentialWrites({
      name: 'w', type: 'agent',
      agentOptions: { provider: 'claude-cli' },
      authMethod: 'oauth',
      apiKey: 'sk-ant-stale', // typed, then user switched to session auth
    })).toEqual([]);
  });

  it('leaves the openai key unaffected by anthropic auth method (openai has no session alternative)', () => {
    expect(planCredentialWrites({
      name: 'w', type: 'agent',
      agentOptions: { provider: 'openai-api' },
      authMethod: 'oauth',
      openaiKey: 'sk-o',
    })).toEqual([{ service: 'openai', value: 'sk-o' }]);
  });
});
