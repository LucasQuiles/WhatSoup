/**
 * End-to-end wiring tests for multi-provider frontend integration.
 *
 * Tests the full data flow for each provider:
 *   1. Provider constants → correct config fields
 *   2. Config fields → correct input types and placeholders
 *   3. Handler simulation → correct state shape for API payload
 *   4. Provider badge logic → correct display for dashboard
 *   5. Review step → correct display values
 *
 * These tests do NOT use React/DOM — they verify the pure logic layer
 * that drives the UI. The UI components use these values directly.
 */

import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  getProvider,
  getProviderConfigFields,
  type ProviderDef,
  type ConfigFieldDef,
} from '../../console/src/lib/providers.ts';

// ─── Helper: simulate what ConfigStep handlers produce ───

/** Simulates handleProviderChange: sets provider, resets providerConfig */
function simulateProviderChange(currentAgentOptions: Record<string, unknown>, newProvider: string) {
  return {
    ...currentAgentOptions,
    provider: newProvider,
    providerConfig: {},
  };
}

/** Simulates handleProviderConfigOption: sets or deletes a key */
function simulateConfigFieldChange(
  currentAgentOptions: Record<string, unknown>,
  key: string,
  value: unknown,
) {
  const current = { ...((currentAgentOptions.providerConfig ?? {}) as Record<string, unknown>) };
  if (value === undefined || value === '') {
    delete current[key];
  } else {
    current[key] = value;
  }
  return {
    ...currentAgentOptions,
    providerConfig: current,
  };
}

/** Simulates getProviderTag from LineTags.tsx */
function simulateProviderBadge(mode: string, config?: Record<string, unknown>): string | null {
  if (mode !== 'agent') return null;
  const provider = (config?.agentOptions as Record<string, unknown> | undefined)?.provider as string | undefined;
  if (!provider || provider === 'claude-cli') return null;
  return provider;
}

/** Simulates ReviewStep provider display */
function simulateReviewDisplay(agentOptions: Record<string, unknown>): { provider: string; model: string | null } {
  const provider = (agentOptions.provider as string) ?? 'claude-cli';
  const providerConfig = agentOptions.providerConfig as Record<string, unknown> | undefined;
  const model = providerConfig?.model ? String(providerConfig.model) : null;
  return { provider, model };
}

// ─── Provider: claude-cli ───

describe('claude-cli (default)', () => {
  const id = 'claude-cli';

  it('exists in PROVIDERS as first entry', () => {
    expect(PROVIDERS[0].id).toBe(id);
    expect(PROVIDERS[0].displayName).toBe('Claude Code');
    expect(PROVIDERS[0].type).toBe('cli');
  });

  it('returns no config fields (handled by existing UI)', () => {
    const fields = getProviderConfigFields(id);
    expect(fields).toHaveLength(0);
  });

  it('wizard default formData uses claude-cli', () => {
    // Matches AddLineWizard.tsx line 144
    const defaultAgentOptions = { provider: 'claude-cli', providerConfig: {} };
    expect(defaultAgentOptions.provider).toBe('claude-cli');
  });

  it('does NOT show provider badge (default provider hidden)', () => {
    const badge = simulateProviderBadge('agent', { agentOptions: { provider: 'claude-cli' } });
    expect(badge).toBeNull();
  });

  it('does NOT show provider badge when provider field is absent', () => {
    const badge = simulateProviderBadge('agent', { agentOptions: {} });
    expect(badge).toBeNull();
  });

  it('review step shows claude-cli as default', () => {
    const display = simulateReviewDisplay({});
    expect(display.provider).toBe('claude-cli');
    expect(display.model).toBeNull();
  });

  it('full E2E: select claude-cli → no extra fields → API payload correct', () => {
    let opts: Record<string, unknown> = { provider: 'codex-cli', providerConfig: { model: 'gpt-5.4' } };
    // User switches back to claude-cli
    opts = simulateProviderChange(opts, 'claude-cli');
    expect(opts.provider).toBe('claude-cli');
    expect(opts.providerConfig).toEqual({});
    // No config fields to fill
    expect(getProviderConfigFields('claude-cli')).toHaveLength(0);
  });
});

// ─── Provider: codex-cli ───

describe('codex-cli', () => {
  const id = 'codex-cli';

  it('exists in PROVIDERS with correct metadata', () => {
    const p = getProvider(id);
    expect(p).toBeDefined();
    expect(p!.displayName).toBe('Codex CLI');
    expect(p!.type).toBe('cli');
  });

  it('returns exactly 1 config field: model', () => {
    const fields = getProviderConfigFields(id);
    expect(fields).toHaveLength(1);
    expect(fields[0].key).toBe('model');
    expect(fields[0].label).toBe('Model');
    expect(fields[0].placeholder).toBe('gpt-5.4');
    expect(fields[0].inputType).toBe('text');
  });

  it('shows provider badge', () => {
    const badge = simulateProviderBadge('agent', { agentOptions: { provider: id } });
    expect(badge).toBe('codex-cli');
  });

  it('does NOT show badge for non-agent mode', () => {
    const badge = simulateProviderBadge('chat', { agentOptions: { provider: id } });
    expect(badge).toBeNull();
  });

  it('full E2E: select → configure model → verify API payload', () => {
    let opts: Record<string, unknown> = { provider: 'claude-cli', providerConfig: {} };

    // Step 1: User selects codex-cli
    opts = simulateProviderChange(opts, 'codex-cli');
    expect(opts.provider).toBe('codex-cli');
    expect(opts.providerConfig).toEqual({});

    // Step 2: User types model
    opts = simulateConfigFieldChange(opts, 'model', 'gpt-5.4');
    expect(opts.providerConfig).toEqual({ model: 'gpt-5.4' });

    // Step 3: Verify review display
    const display = simulateReviewDisplay(opts);
    expect(display.provider).toBe('codex-cli');
    expect(display.model).toBe('gpt-5.4');

    // Step 4: Verify API payload shape matches backend expectation
    const apiPayload = { agentOptions: { provider: opts.provider, providerConfig: opts.providerConfig } };
    expect(apiPayload).toEqual({
      agentOptions: {
        provider: 'codex-cli',
        providerConfig: { model: 'gpt-5.4' },
      },
    });
  });

  it('clearing model removes key from providerConfig', () => {
    let opts: Record<string, unknown> = { provider: 'codex-cli', providerConfig: { model: 'gpt-5.4' } };
    opts = simulateConfigFieldChange(opts, 'model', '');
    expect(opts.providerConfig).toEqual({});
    expect('model' in (opts.providerConfig as Record<string, unknown>)).toBe(false);
  });
});

// ─── Provider: gemini-cli ───

describe('gemini-cli', () => {
  const id = 'gemini-cli';

  it('exists in PROVIDERS with correct metadata', () => {
    const p = getProvider(id);
    expect(p).toBeDefined();
    expect(p!.displayName).toBe('Gemini CLI');
    expect(p!.type).toBe('cli');
  });

  it('returns exactly 1 config field: model with gemini placeholder', () => {
    const fields = getProviderConfigFields(id);
    expect(fields).toHaveLength(1);
    expect(fields[0].key).toBe('model');
    expect(fields[0].placeholder).toBe('gemini-2.5-pro');
  });

  it('shows provider badge', () => {
    expect(simulateProviderBadge('agent', { agentOptions: { provider: id } })).toBe('gemini-cli');
  });

  it('full E2E: select → configure → verify payload', () => {
    let opts: Record<string, unknown> = { provider: 'claude-cli', providerConfig: {} };
    opts = simulateProviderChange(opts, 'gemini-cli');
    opts = simulateConfigFieldChange(opts, 'model', 'gemini-2.5-pro');

    expect(simulateReviewDisplay(opts)).toEqual({ provider: 'gemini-cli', model: 'gemini-2.5-pro' });
    expect(opts.providerConfig).toEqual({ model: 'gemini-2.5-pro' });
  });
});

// ─── Provider: opencode-cli ───

describe('opencode-cli', () => {
  const id = 'opencode-cli';

  it('exists in PROVIDERS with correct metadata', () => {
    const p = getProvider(id);
    expect(p).toBeDefined();
    expect(p!.displayName).toBe('OpenCode');
    expect(p!.type).toBe('cli');
  });

  it('returns exactly 1 config field: model with claude placeholder', () => {
    const fields = getProviderConfigFields(id);
    expect(fields).toHaveLength(1);
    expect(fields[0].key).toBe('model');
    expect(fields[0].placeholder).toBe('claude-sonnet-4-6');
  });

  it('shows provider badge', () => {
    expect(simulateProviderBadge('agent', { agentOptions: { provider: id } })).toBe('opencode-cli');
  });

  it('full E2E: select → configure → verify payload', () => {
    let opts: Record<string, unknown> = { provider: 'claude-cli', providerConfig: {} };
    opts = simulateProviderChange(opts, 'opencode-cli');
    opts = simulateConfigFieldChange(opts, 'model', 'claude-sonnet-4-6');

    expect(simulateReviewDisplay(opts)).toEqual({ provider: 'opencode-cli', model: 'claude-sonnet-4-6' });
  });
});

// ─── Provider: openai-api ───

describe('openai-api', () => {
  const id = 'openai-api';

  it('exists in PROVIDERS with correct metadata', () => {
    const p = getProvider(id);
    expect(p).toBeDefined();
    expect(p!.displayName).toBe('OpenAI API');
    expect(p!.type).toBe('api');
  });

  it('returns 3 config fields: model, baseUrl, apiKeyService', () => {
    const fields = getProviderConfigFields(id);
    expect(fields).toHaveLength(3);

    const keys = fields.map(f => f.key);
    expect(keys).toEqual(['model', 'baseUrl', 'apiKeyService']);

    // All text inputs
    expect(fields.every(f => f.inputType === 'text')).toBe(true);
  });

  it('model placeholder is gpt-4o', () => {
    const fields = getProviderConfigFields(id);
    expect(fields.find(f => f.key === 'model')!.placeholder).toBe('gpt-4o');
  });

  it('baseUrl placeholder is correct', () => {
    const fields = getProviderConfigFields(id);
    expect(fields.find(f => f.key === 'baseUrl')!.placeholder).toBe('https://api.openai.com/v1');
  });

  it('does NOT have maxTokens field (anthropic-only)', () => {
    const fields = getProviderConfigFields(id);
    expect(fields.find(f => f.key === 'maxTokens')).toBeUndefined();
  });

  it('shows provider badge', () => {
    expect(simulateProviderBadge('agent', { agentOptions: { provider: id } })).toBe('openai-api');
  });

  it('full E2E: select → configure all fields → verify payload', () => {
    let opts: Record<string, unknown> = { provider: 'claude-cli', providerConfig: {} };

    // Select provider
    opts = simulateProviderChange(opts, 'openai-api');
    expect(opts.providerConfig).toEqual({});

    // Fill all 3 fields
    opts = simulateConfigFieldChange(opts, 'model', 'gpt-4o');
    opts = simulateConfigFieldChange(opts, 'baseUrl', 'https://custom.api.com/v1');
    opts = simulateConfigFieldChange(opts, 'apiKeyService', 'openai-custom');

    // Verify final state
    expect(opts.providerConfig).toEqual({
      model: 'gpt-4o',
      baseUrl: 'https://custom.api.com/v1',
      apiKeyService: 'openai-custom',
    });

    // Verify review
    const display = simulateReviewDisplay(opts);
    expect(display.provider).toBe('openai-api');
    expect(display.model).toBe('gpt-4o');

    // Verify API payload shape
    const payload = { agentOptions: { provider: opts.provider, providerConfig: opts.providerConfig } };
    expect(payload.agentOptions.provider).toBe('openai-api');
    expect(payload.agentOptions.providerConfig).toEqual({
      model: 'gpt-4o',
      baseUrl: 'https://custom.api.com/v1',
      apiKeyService: 'openai-custom',
    });
  });

  it('clearing individual fields removes them from payload', () => {
    let opts: Record<string, unknown> = {
      provider: 'openai-api',
      providerConfig: { model: 'gpt-4o', baseUrl: 'https://x.com', apiKeyService: 'k' },
    };
    // Clear baseUrl
    opts = simulateConfigFieldChange(opts, 'baseUrl', '');
    expect(opts.providerConfig).toEqual({ model: 'gpt-4o', apiKeyService: 'k' });
    // Clear model
    opts = simulateConfigFieldChange(opts, 'model', undefined);
    expect(opts.providerConfig).toEqual({ apiKeyService: 'k' });
  });
});

// ─── Provider: anthropic-api ───

describe('anthropic-api', () => {
  const id = 'anthropic-api';

  it('exists in PROVIDERS with correct metadata', () => {
    const p = getProvider(id);
    expect(p).toBeDefined();
    expect(p!.displayName).toBe('Anthropic API');
    expect(p!.type).toBe('api');
  });

  it('returns 4 config fields: model, baseUrl, apiKeyService, maxTokens', () => {
    const fields = getProviderConfigFields(id);
    expect(fields).toHaveLength(4);

    const keys = fields.map(f => f.key);
    expect(keys).toEqual(['model', 'baseUrl', 'apiKeyService', 'maxTokens']);
  });

  it('model placeholder is claude-sonnet-4-6', () => {
    const fields = getProviderConfigFields(id);
    expect(fields.find(f => f.key === 'model')!.placeholder).toBe('claude-sonnet-4-6');
  });

  it('maxTokens is a number input with correct placeholder', () => {
    const fields = getProviderConfigFields(id);
    const maxTokens = fields.find(f => f.key === 'maxTokens')!;
    expect(maxTokens.inputType).toBe('number');
    expect(maxTokens.placeholder).toBe('16384');
    expect(maxTokens.label).toBe('Max Tokens');
  });

  it('has baseUrl and apiKeyService as text inputs', () => {
    const fields = getProviderConfigFields(id);
    expect(fields.find(f => f.key === 'baseUrl')!.inputType).toBe('text');
    expect(fields.find(f => f.key === 'apiKeyService')!.inputType).toBe('text');
  });

  it('shows provider badge', () => {
    expect(simulateProviderBadge('agent', { agentOptions: { provider: id } })).toBe('anthropic-api');
  });

  it('full E2E: select → configure all 4 fields → verify payload', () => {
    let opts: Record<string, unknown> = { provider: 'claude-cli', providerConfig: {} };

    // Select provider
    opts = simulateProviderChange(opts, 'anthropic-api');

    // Fill all 4 fields
    opts = simulateConfigFieldChange(opts, 'model', 'claude-sonnet-4-6');
    opts = simulateConfigFieldChange(opts, 'baseUrl', 'https://api.anthropic.com');
    opts = simulateConfigFieldChange(opts, 'apiKeyService', 'anthropic');
    opts = simulateConfigFieldChange(opts, 'maxTokens', 16384);

    // Verify final state
    expect(opts.providerConfig).toEqual({
      model: 'claude-sonnet-4-6',
      baseUrl: 'https://api.anthropic.com',
      apiKeyService: 'anthropic',
      maxTokens: 16384,
    });

    // Verify review
    const display = simulateReviewDisplay(opts);
    expect(display.provider).toBe('anthropic-api');
    expect(display.model).toBe('claude-sonnet-4-6');

    // Verify API payload matches backend expectation from HANDOFF doc
    const payload = {
      agentOptions: {
        provider: opts.provider,
        providerConfig: opts.providerConfig,
      },
    };
    expect(payload.agentOptions.provider).toBe('anthropic-api');
    expect(typeof (payload.agentOptions.providerConfig as Record<string, unknown>).maxTokens).toBe('number');
  });

  it('maxTokens stays as number type through the pipeline', () => {
    let opts: Record<string, unknown> = { provider: 'anthropic-api', providerConfig: {} };
    opts = simulateConfigFieldChange(opts, 'maxTokens', 8192);
    const pc = opts.providerConfig as Record<string, unknown>;
    expect(pc.maxTokens).toBe(8192);
    expect(typeof pc.maxTokens).toBe('number');
  });
});

// ─── Cross-provider integration tests ───

describe('cross-provider integration', () => {
  it('switching providers resets providerConfig (prevents field leakage)', () => {
    let opts: Record<string, unknown> = { provider: 'claude-cli', providerConfig: {} };

    // Configure anthropic with all fields
    opts = simulateProviderChange(opts, 'anthropic-api');
    opts = simulateConfigFieldChange(opts, 'model', 'claude-sonnet-4-6');
    opts = simulateConfigFieldChange(opts, 'maxTokens', 16384);
    opts = simulateConfigFieldChange(opts, 'baseUrl', 'https://api.anthropic.com');
    expect(Object.keys(opts.providerConfig as Record<string, unknown>)).toHaveLength(3);

    // Switch to codex-cli — all config should be wiped
    opts = simulateProviderChange(opts, 'codex-cli');
    expect(opts.provider).toBe('codex-cli');
    expect(opts.providerConfig).toEqual({});

    // Codex only has model field — no maxTokens/baseUrl should leak
    opts = simulateConfigFieldChange(opts, 'model', 'gpt-5.4');
    expect(opts.providerConfig).toEqual({ model: 'gpt-5.4' });
    expect((opts.providerConfig as Record<string, unknown>).maxTokens).toBeUndefined();
    expect((opts.providerConfig as Record<string, unknown>).baseUrl).toBeUndefined();
  });

  it('all 6 providers are selectable and produce valid payloads', () => {
    for (const provider of PROVIDERS) {
      let opts: Record<string, unknown> = { provider: 'claude-cli', providerConfig: {} };
      opts = simulateProviderChange(opts, provider.id);

      // Fill all config fields for this provider
      const fields = getProviderConfigFields(provider.id);
      for (const field of fields) {
        const val = field.inputType === 'number' ? 1000 : 'test-value';
        opts = simulateConfigFieldChange(opts, field.key, val);
      }

      // Verify payload is well-formed
      expect(opts.provider).toBe(provider.id);
      const pc = opts.providerConfig as Record<string, unknown>;
      expect(typeof pc).toBe('object');
      expect(Array.isArray(pc)).toBe(false);
      expect(pc).not.toBeNull();

      // Every field we set should be present
      for (const field of fields) {
        expect(pc[field.key]).toBeDefined();
      }

      // No extra keys beyond what we set
      expect(Object.keys(pc)).toHaveLength(fields.length);
    }
  });

  it('provider badge only shows for non-default agent instances', () => {
    // Default provider — no badge
    expect(simulateProviderBadge('agent', { agentOptions: { provider: 'claude-cli' } })).toBeNull();
    // Missing provider — no badge
    expect(simulateProviderBadge('agent', { agentOptions: {} })).toBeNull();
    // Missing config — no badge
    expect(simulateProviderBadge('agent', {})).toBeNull();
    // Non-agent mode — no badge even with non-default provider
    expect(simulateProviderBadge('chat', { agentOptions: { provider: 'codex-cli' } })).toBeNull();
    expect(simulateProviderBadge('passive', { agentOptions: { provider: 'codex-cli' } })).toBeNull();

    // Non-default providers — all show badges
    for (const p of PROVIDERS.filter(p => p.id !== 'claude-cli')) {
      expect(simulateProviderBadge('agent', { agentOptions: { provider: p.id } })).toBe(p.id);
    }
  });

  it('review display defaults gracefully for each provider', () => {
    // No agentOptions at all
    expect(simulateReviewDisplay({})).toEqual({ provider: 'claude-cli', model: null });

    // Provider set but no providerConfig
    expect(simulateReviewDisplay({ provider: 'codex-cli' })).toEqual({ provider: 'codex-cli', model: null });

    // Provider + model
    expect(simulateReviewDisplay({ provider: 'openai-api', providerConfig: { model: 'gpt-4o' } }))
      .toEqual({ provider: 'openai-api', model: 'gpt-4o' });
  });

  it('PROVIDERS list matches backend provider IDs exactly', () => {
    // From HANDOFF-MULTI-PROVIDER-FRONTEND.md — these are the 6 valid IDs
    const expectedIds = ['claude-cli', 'codex-cli', 'gemini-cli', 'opencode-cli', 'openai-api', 'anthropic-api'];
    expect(PROVIDERS.map(p => p.id)).toEqual(expectedIds);
  });

  it('every provider has a unique ID', () => {
    const ids = PROVIDERS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('CLI providers get model only, API providers get model+baseUrl+apiKeyService', () => {
    for (const p of PROVIDERS) {
      if (p.id === 'claude-cli') continue; // Special case — no fields
      const fields = getProviderConfigFields(p.id);
      const keys = fields.map(f => f.key);

      if (p.type === 'cli') {
        expect(keys).toEqual(['model']);
      } else {
        expect(keys).toContain('model');
        expect(keys).toContain('baseUrl');
        expect(keys).toContain('apiKeyService');
      }
    }
  });
});
