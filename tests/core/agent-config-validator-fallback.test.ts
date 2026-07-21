/**
 * Validator coverage for automatic provider fallback config — agentOptions
 * .fallbackProvider must be an entry in the shared PROVIDER_IDS registry (same
 * rule as `provider`), and .fallbackModel must be a non-empty string when set.
 * Mirrors agent-config-validator-provider.test.ts (#447) for the new fields.
 */
import { describe, it, expect } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';
import { PROVIDER_IDS } from '../../src/runtimes/agent/providers/index.ts';

function agentRawFallback(
  fallback: { fallbackProvider?: unknown; fallbackModel?: unknown },
): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 9095,
    systemPrompt: 'hi',
    agentOptions: {
      sessionScope: 'single',
      provider: 'claude-cli',
      ...fallback,
    },
  };
}

describe('validateInstanceConfig — agentOptions.fallbackProvider / fallbackModel', () => {
  it('accepts every canonical provider ID as a fallbackProvider', () => {
    for (const id of PROVIDER_IDS) {
      // Managed APIs and OpenCode require an explicit fallbackModel; pair one so
      // this test isolates the provider-ID enum rule. Use a mapped `<provider>/…`
      // prefix so it also satisfies opencode-cli's credential-route rule (the API
      // providers accept the same string verbatim — they do not prefix-check).
      const requiresModel = id === 'openai-api' || id === 'anthropic-api' || id === 'opencode-cli';
      const err = validateInstanceConfig(
        agentRawFallback(
          requiresModel
            ? { fallbackProvider: id, fallbackModel: 'minimax/some-model-id' }
            : { fallbackProvider: id },
        ),
        {
          name: 'test-line',
          mode: 'create',
        },
      );
      expect(err, `expected fallbackProvider ${id} to be accepted`).toBeNull();
    }
  });

  it('accepts undefined fallback fields, and still examines fallbackProvider when present', () => {
    expect(
      validateInstanceConfig(agentRawFallback({}), { name: 'test-line', mode: 'create' }),
      'omitting fallbackProvider/fallbackModel (feature disabled) must validate clean',
    ).toBeNull();
    // Control: proves the accept above is not a vacuous pass — a present-but-bad
    // fallbackProvider is rejected at the expected field.
    const bad = validateInstanceConfig(agentRawFallback({ fallbackProvider: 'nope-cli' }), {
      name: 'test-line',
      mode: 'create',
    });
    expect(bad?.field).toBe('agentOptions.fallbackProvider');
  });

  it('rejects an unknown fallbackProvider ID', () => {
    const err = validateInstanceConfig(agentRawFallback({ fallbackProvider: 'minimax-cli' }), {
      name: 'test-line',
      mode: 'create',
    });
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.fallbackProvider');
    expect(err?.message).toMatch(/agentOptions\.fallbackProvider/);
    expect(err?.message).toMatch(/opencode-cli/);
  });

  it('rejects a non-string fallbackProvider', () => {
    const err = validateInstanceConfig(agentRawFallback({ fallbackProvider: 7 }), {
      name: 'test-line',
      mode: 'create',
    });
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.fallbackProvider');
  });

  it('accepts a non-empty fallbackModel string, and rejects an empty one at the same field', () => {
    expect(
      validateInstanceConfig(
        agentRawFallback({ fallbackProvider: 'opencode-cli', fallbackModel: 'minimax/MiniMax-M2.7' }),
        { name: 'test-line', mode: 'create' },
      ),
      'opencode-cli with a non-empty fallbackModel must validate clean',
    ).toBeNull();
    // Control: the accept above is meaningful only because an empty model is
    // rejected at the same field.
    const bad = validateInstanceConfig(
      agentRawFallback({ fallbackProvider: 'opencode-cli', fallbackModel: '' }),
      { name: 'test-line', mode: 'create' },
    );
    expect(bad?.field).toBe('agentOptions.fallbackModel');
  });

  it('rejects an empty / whitespace-only fallbackModel', () => {
    for (const bad of ['', '   ']) {
      const err = validateInstanceConfig(agentRawFallback({ fallbackModel: bad }), {
        name: 'test-line',
        mode: 'create',
      });
      expect(err, `expected fallbackModel ${JSON.stringify(bad)} to be rejected`).not.toBeNull();
      expect(err?.field).toBe('agentOptions.fallbackModel');
    }
  });

  it('rejects a non-string fallbackModel', () => {
    const err = validateInstanceConfig(agentRawFallback({ fallbackModel: 42 }), {
      name: 'test-line',
      mode: 'create',
    });
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.fallbackModel');
  });
});
