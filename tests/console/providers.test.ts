import { describe, it, expect } from 'vitest';
import { PROVIDER_API_KEY_SERVICES } from '../../src/lib/provider-key-service.ts';
import { CHAT_API_KEY_SERVICE_OPTIONS, PROVIDERS, PROVIDER_COLORS, getProvider, getProviderColor, getProviderConfigFields } from '../../console/src/lib/providers.ts';

describe('PROVIDERS', () => {
  it('has 6 providers', () => {
    expect(PROVIDERS).toHaveLength(6);
  });

  it('each provider has required fields', () => {
    for (const p of PROVIDERS) {
      expect(p.id).toBeTruthy();
      expect(p.displayName).toBeTruthy();
      expect(p.type).toMatch(/^(cli|api)$/);
    }
  });

  it('claude-cli is first (default)', () => {
    expect(PROVIDERS[0].id).toBe('claude-cli');
  });
});

describe('getProvider', () => {
  it('returns provider by ID', () => {
    expect(getProvider('codex-cli')?.displayName).toBe('Codex');
  });

  it('returns undefined for unknown ID', () => {
    expect(getProvider('nope')).toBeUndefined();
  });
});

describe('getProviderColor', () => {
  it('has an explicit color entry for every canonical provider', () => {
    expect(Object.keys(PROVIDER_COLORS).sort()).toEqual(PROVIDERS.map((provider) => provider.id).sort());
  });

  it('uses dedicated provider tokens instead of status or mode channels', () => {
    const borrowedChannel = /var\(--(?:color-[mst]-|status-|mode-|data-)/;

    for (const provider of PROVIDERS) {
      const color = getProviderColor(provider.id);
      expect(color.stroke).toMatch(/^var\(--provider-[a-z]+-fg\)$/);
      expect(color.fill).toBe(color.stroke);
      expect(color.stroke).not.toMatch(borrowedChannel);
    }
  });

  it('keeps unknown providers neutral', () => {
    expect(getProviderColor('unknown-provider')).toEqual({
      stroke: 'var(--provider-unknown)',
      fill: 'var(--text-3)',
    });
  });
});

describe('getProviderConfigFields', () => {
  it('returns model for CLI providers', () => {
    const fields = getProviderConfigFields('codex-cli');
    expect(fields.some(f => f.key === 'model')).toBe(true);
  });

  it('returns model + baseUrl + apiKeyService for API providers', () => {
    const fields = getProviderConfigFields('openai-api');
    const keys = fields.map(f => f.key);
    expect(keys).toContain('model');
    expect(keys).toContain('baseUrl');
    expect(keys).toContain('apiKeyService');
  });

  it('returns maxTokens for anthropic-api only', () => {
    const anthropicFields = getProviderConfigFields('anthropic-api');
    const openaiFields = getProviderConfigFields('openai-api');
    expect(anthropicFields.some(f => f.key === 'maxTokens')).toBe(true);
    expect(openaiFields.some(f => f.key === 'maxTokens')).toBe(false);
  });

  it('returns empty array for claude-cli (no extra config needed)', () => {
    expect(getProviderConfigFields('claude-cli')).toHaveLength(0);
  });
});

describe('CHAT_API_KEY_SERVICE_OPTIONS', () => {
  it('stays in lockstep with the backend provider api-key allowlist', () => {
    expect(new Set(CHAT_API_KEY_SERVICE_OPTIONS)).toEqual(PROVIDER_API_KEY_SERVICES);
  });

  it('includes provider services and excludes non-provider secrets', () => {
    expect(CHAT_API_KEY_SERVICE_OPTIONS).toContain('openai');
    expect(CHAT_API_KEY_SERVICE_OPTIONS).toContain('groq');
    expect(CHAT_API_KEY_SERVICE_OPTIONS).not.toContain('pinecone');
    expect(CHAT_API_KEY_SERVICE_OPTIONS).not.toContain('elevenlabs');
    expect(CHAT_API_KEY_SERVICE_OPTIONS).not.toContain('whatsoup-health-token');
    expect(CHAT_API_KEY_SERVICE_OPTIONS).not.toContain('whatsoup_health');
  });
});
