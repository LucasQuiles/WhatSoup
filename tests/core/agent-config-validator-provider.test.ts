/**
 * Validator coverage for #447 — agentOptions.provider must be an entry in the
 * shared PROVIDER_IDS registry, not merely a non-empty string. Closes a drift
 * hazard where a typo'd provider ID like "claud-cli" would pass validation
 * and silently fall through the session.ts default branches to Claude.
 */
import { describe, it, expect } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';
import { PROVIDER_IDS } from '../../src/runtimes/agent/providers/index.ts';
import type { ValidatorContext } from '../../src/core/agent-config-validator.ts';

function agentRaw(provider: unknown): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 9095,
    systemPrompt: 'hi',
    agentOptions: {
      sessionScope: 'single',
      provider,
    },
  };
}

describe('validateInstanceConfig — agentOptions.provider (#447)', () => {
  it('accepts every canonical provider ID', () => {
    for (const id of PROVIDER_IDS) {
      const raw = agentRaw(id);
      if (id === 'opencode-cli') raw['model'] = 'glm/glm-5.2';
      const err = validateInstanceConfig(raw, {
        name: 'test-line',
        mode: 'create',
      });
      expect(err, `expected ${id} to be accepted`).toBeNull();
    }
  });

  it('accepts undefined provider (default is applied downstream)', () => {
    const raw = {
      name: 'test-line',
      type: 'agent',
      accessMode: 'self_only',
      healthPort: 9095,
      systemPrompt: 'hi',
      agentOptions: {},
    };
    const err = validateInstanceConfig(raw, { name: 'test-line', mode: 'create' });
    // Absent provider must not surface a provider-field error — the loader
    // applies 'claude-cli' as the default. Pin the exact null return so a
    // future regression that surfaces *any* error (even on a different field)
    // is caught.
    expect(err).toBeNull();
    // Sanity: agentOptions itself must not be the culprit either.
    const fullRaw = { ...raw, agentOptions: { provider: 'claude-cli' } };
    expect(validateInstanceConfig(fullRaw, { name: 'test-line', mode: 'create' })).toBeNull();
  });

  it('rejects an unknown provider ID across create/load/discovery/patch modes', () => {
    const modes: ValidatorContext['mode'][] = ['create', 'load', 'discovery', 'patch'];

    for (const mode of modes) {
      const err = validateInstanceConfig(agentRaw('claud-cli'), {
        name: 'test-line',
        mode,
      });
      expect(err, `expected ${mode} to reject claud-cli`).not.toBeNull();
      expect(err?.field).toBe('agentOptions.provider');
      expect(err?.message).toMatch(/agentOptions\.provider/);
      // The error must enumerate the valid set so operators can self-correct.
      expect(err?.message).toMatch(/claude-cli/);
      expect(err?.message).toMatch(/anthropic-api/);
    }
  });

  it('rejects empty string', () => {
    const err = validateInstanceConfig(agentRaw(''), {
      name: 'test-line',
      mode: 'create',
    });
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.provider');
  });

  it('rejects non-string provider', () => {
    const err = validateInstanceConfig(agentRaw(42), {
      name: 'test-line',
      mode: 'create',
    });
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.provider');
  });

  it('rejects case-variant of a canonical ID (case-sensitive enum)', () => {
    const err = validateInstanceConfig(agentRaw('Claude-CLI'), {
      name: 'test-line',
      mode: 'create',
    });
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.provider');
  });
});

// ---------------------------------------------------------------------------
// providerConfig.baseUrl — the "different cloud provider with opencode" surface.
// Must be a non-empty, parseable URL when present. Used to merge a custom
// OpenAI-compatible `provider` block into the written opencode.json.
// ---------------------------------------------------------------------------

function agentWithProviderConfig(providerConfig: unknown): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 9095,
    systemPrompt: 'hi',
    // opencode-cli + baseUrl requires a resolvable model whose prefix maps to a
    // known credential service (the custom endpoint block is inert without one,
    // and an unmapped prefix is rejected at admission — see
    // agent-config-validator-crossfield coverage); set a mapped one here so this
    // suite isolates the URL-shape rules.
    model: 'minimax/some-model',
    agentOptions: {
      sessionScope: 'single',
      provider: 'opencode-cli',
      providerConfig,
    },
  };
}

describe('validateInstanceConfig — agentOptions.providerConfig.baseUrl', () => {
  it('accepts a valid https URL but rejects the same config with a bad URL', () => {
    const good = validateInstanceConfig(
      agentWithProviderConfig({ baseUrl: 'https://api.cloud.example.com/v1' }),
      { name: 'test-line', mode: 'create' },
    );
    expect(good).toBeNull();
    // Flip only the baseUrl to a non-URL: the very same shape must now be
    // rejected on the baseUrl field — proving the accept above was URL-driven.
    const bad = validateInstanceConfig(
      agentWithProviderConfig({ baseUrl: 'https://api.cloud.example.com/v1'.replace('https://', 'ht!tp ') }),
      { name: 'test-line', mode: 'create' },
    );
    expect(bad?.field).toBe('agentOptions.providerConfig.baseUrl');
  });

  it('accepts providerConfig with no baseUrl, still honoring sibling budget rules', () => {
    const ok = validateInstanceConfig(
      agentWithProviderConfig({ budget: { tokenBudget: 5000 } }),
      { name: 'test-line', mode: 'create' },
    );
    expect(ok).toBeNull();
    // A malformed sibling (budget as array) must still be caught — the absent
    // baseUrl path does not short-circuit the rest of providerConfig validation.
    const bad = validateInstanceConfig(
      agentWithProviderConfig({ budget: [] }),
      { name: 'test-line', mode: 'create' },
    );
    expect(bad?.field).toBe('agentOptions.providerConfig.budget');
  });

  it('rejects a non-string baseUrl on the baseUrl field', () => {
    const err = validateInstanceConfig(
      agentWithProviderConfig({ baseUrl: 42 }),
      { name: 'test-line', mode: 'create' },
    );
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.providerConfig.baseUrl');
  });

  it('rejects an empty-string baseUrl on the baseUrl field', () => {
    const err = validateInstanceConfig(
      agentWithProviderConfig({ baseUrl: '' }),
      { name: 'test-line', mode: 'create' },
    );
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.providerConfig.baseUrl');
  });

  it('rejects a non-URL baseUrl string on the baseUrl field', () => {
    const err = validateInstanceConfig(
      agentWithProviderConfig({ baseUrl: 'not a url' }),
      { name: 'test-line', mode: 'create' },
    );
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.providerConfig.baseUrl');
  });
});
