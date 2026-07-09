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
      'ms365-hub': 'MS365_HUB_API_KEY',
    });
  });

  it('locks the exact service list so additions consciously reconcile the coupled surfaces', () => {
    // Forcing function, not redundancy: SERVICE_ENV_MAP is the only
    // code-enforced "known service" list, but hand-maintained copies drift
    // silently without this lock — the env-var table and the no-probe prose in
    // docs/configuration.md, and the seam table in
    // docs/specs/2026-07-03-openai-compatible-byok-providers-design.md. When
    // this test flips: reconcile those in the same PR, and decide probe
    // coverage in src/runtimes/agent/providers/credential-verify.ts (only
    // endpoints proven to 401/403 on a bad key qualify — see the probe
    // qualification comment there).
    expect(SERVICE_ENV_MAP).toEqual({
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      minimax: 'MINIMAX_API_KEY',
      glm: 'ZAI_API_KEY',
      xai: 'XAI_API_KEY',
      groq: 'GROQ_API_KEY',
      mistral: 'MISTRAL_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      google: 'GOOGLE_API_KEY',
      'fireworks-ai': 'FIREWORKS_API_KEY',
      togetherai: 'TOGETHER_API_KEY',
      pinecone: 'PINECONE_API_KEY',
      elevenlabs: 'ELEVENLABS_API_KEY',
      'whatsoup-health-token': 'WHATSOUP_HEALTH_TOKEN',
      whatsoup_health: 'WHATSOUP_HEALTH_TOKEN',
      'ms365-hub': 'MS365_HUB_API_KEY',
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
    // Documented fail-open: an UNREGISTERED vendor prefix still resolves to a
    // service name (no SERVICE_ENV_MAP membership check here) — downstream
    // lookupCredential simply misses. Locked so a future membership check is
    // a conscious behavior change.
    expect(resolveProviderKeyService('opencode-cli', 'unknown-vendor/some-model')).toBe('unknown-vendor');
    expect(resolveProviderKeyService('opencode-cli', '')).toBeNull();
    expect(resolveProviderKeyService('claude-cli', 'claude-sonnet')).toBeNull();
    expect(resolveProviderKeyService(null, 'minimax/model')).toBeNull();
  });
});
