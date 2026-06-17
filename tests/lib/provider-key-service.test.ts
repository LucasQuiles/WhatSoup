import { describe, expect, it } from 'vitest';

import { resolveProviderKeyService, SERVICE_ENV_MAP } from '../../src/lib/provider-key-service.ts';

describe('provider key service mapping', () => {
  it('exports the provider credential environment names used by runtime wrappers', () => {
    expect(SERVICE_ENV_MAP).toMatchObject({
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      minimax: 'MINIMAX_API_KEY',
      pinecone: 'PINECONE_API_KEY',
      'whatsoup-health-token': 'WHATSOUP_HEALTH_TOKEN',
      whatsoup_health: 'WHATSOUP_HEALTH_TOKEN',
    });
  });

  it('honors non-empty HTTP API overrides but ignores empty or non-string values', () => {
    expect(resolveProviderKeyService('openai-api', undefined, { apiKeyService: 'tenant-openai' })).toBe('tenant-openai');
    expect(resolveProviderKeyService('anthropic-api', undefined, { apiKeyService: 'tenant-anthropic' })).toBe('tenant-anthropic');
    expect(resolveProviderKeyService('openai-api', undefined, { apiKeyService: '' })).toBe('openai');
    expect(resolveProviderKeyService('anthropic-api', undefined, { apiKeyService: '' })).toBe('anthropic');
    expect(resolveProviderKeyService('openai-api', undefined, { apiKeyService: 42 })).toBe('openai');
  });

  it('derives opencode service names from model prefixes and leaves non-keyring providers unresolved', () => {
    expect(resolveProviderKeyService('opencode-cli', ' DeepSeek/deepseek-chat ')).toBe('deepseek');
    expect(resolveProviderKeyService('opencode-cli', 'minimax/MiniMax-M2.7', { apiKeyService: 'ignored' })).toBe('minimax');
    expect(resolveProviderKeyService('opencode-cli', '')).toBeNull();
    expect(resolveProviderKeyService('claude-cli', 'claude-sonnet')).toBeNull();
    expect(resolveProviderKeyService(null, 'minimax/model')).toBeNull();
  });
});
