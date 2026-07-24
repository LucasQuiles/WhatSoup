import { describe, it, expect } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';

function agentRaw(
  agentOptions: Record<string, unknown>,
  topLevel: Record<string, unknown> = {},
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
      ...agentOptions,
    },
    ...topLevel,
  };
}

const createCtx = { name: 'test-line', mode: 'create' } as const;

describe('validateInstanceConfig — ordered fallback chain', () => {
  it('accepts the configured Kimi, GLM, and DeepSeek OpenCode fallback chain', () => {
    expect(
      validateInstanceConfig(
        agentRaw({
          fallbacks: [
            { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
            { provider: 'opencode-cli', model: 'glm/glm-5.2' },
            { provider: 'opencode-cli', model: 'deepseek/deepseek-v4-pro' },
          ],
        }),
        createCtx,
      ),
    ).toBeNull();
  });

  it('rejects configs that mix legacy fallbackProvider/fallbackModel with fallbacks[]', () => {
    const err = validateInstanceConfig(
      agentRaw({
        fallbackProvider: 'opencode-cli',
        fallbackModel: 'minimax/MiniMax-M2',
        fallbacks: [{ provider: 'openai-api', model: 'gpt-4o-mini' }],
      }),
      createCtx,
    );
    expect(err?.field).toBe('agentOptions.fallbacks');
    expect(err?.message).toContain('fallbackProvider');
  });

  it('rejects a non-array fallbacks value', () => {
    const err = validateInstanceConfig(agentRaw({ fallbacks: 'opencode-cli' }), createCtx);
    expect(err?.field).toBe('agentOptions.fallbacks');
  });

  it('rejects more than eight fallback entries', () => {
    const err = validateInstanceConfig(
      agentRaw({
        fallbacks: [
          { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
          { provider: 'openai-api', model: 'gpt-4o-mini' },
          { provider: 'anthropic-api', model: 'claude-sonnet-4-6' },
          { provider: 'codex-cli' },
          { provider: 'gemini-cli' },
          { provider: 'claude-cli', model: 'claude-opus-4-8' },
          { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
          { provider: 'opencode-cli', model: 'deepseek/deepseek-chat' },
          { provider: 'openai-api', model: 'gpt-4.1-mini' },
        ],
      }),
      createCtx,
    );
    expect(err?.field).toBe('agentOptions.fallbacks');
    expect(err?.message).toContain('at most 8');
  });

  it('rejects duplicate provider/model pairs', () => {
    const err = validateInstanceConfig(
      agentRaw({
        fallbacks: [
          { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
          { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        ],
      }),
      createCtx,
    );
    expect(err?.field).toBe('agentOptions.fallbacks[1]');
    expect(err?.message).toContain('duplicate');
  });

  it('rejects fallback entries equal to the primary provider/model pair', () => {
    const err = validateInstanceConfig(
      agentRaw(
        {
          provider: 'opencode-cli',
          fallbacks: [{ provider: 'opencode-cli', model: 'minimax/MiniMax-M2' }],
        },
        { model: 'minimax/MiniMax-M2' },
      ),
      createCtx,
    );
    expect(err?.field).toBe('agentOptions.fallbacks[0]');
    expect(err?.message).toContain('primary');
  });

  it('allows a model-less entry on the primary provider when the primary pins an explicit model', () => {
    // A model-less entry targets the provider default model, which differs
    // from a primary that pins an explicit model — a real fallback target.
    expect(
      validateInstanceConfig(
        agentRaw(
          { fallbacks: [{ provider: 'claude-cli' }] },
          { model: 'claude-opus-4-8' },
        ),
        createCtx,
      ),
    ).toBeNull();
  });

  it('rejects a model-less entry on the primary provider when the primary has no explicit model', () => {
    // Both the entry and the primary would use the provider default model —
    // the entry is not a distinct fallback target.
    const err = validateInstanceConfig(
      agentRaw({ fallbacks: [{ provider: 'claude-cli' }] }),
      createCtx,
    );
    expect(err?.field).toBe('agentOptions.fallbacks[0]');
    expect(err?.message).toContain('primary');
  });

  it('applies API-provider model requirements per fallback entry', () => {
    const err = validateInstanceConfig(
      agentRaw({ fallbacks: [{ provider: 'openai-api' }] }),
      createCtx,
    );
    expect(err?.field).toBe('agentOptions.fallbacks[0].model');
    expect(err?.message).toContain('requires model');
  });

  it('accepts a valid chain and keeps legacy single fallback valid', () => {
    expect(
      validateInstanceConfig(
        agentRaw({
          fallbacks: [
            { provider: 'claude-cli', model: 'claude-opus-4-8' },
            { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
            { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
            { provider: 'openai-api', model: 'gpt-4o-mini' },
          ],
        }, {
          models: { conversation: 'claude-fable-5' },
        }),
        createCtx,
      ),
    ).toBeNull();

    expect(
      validateInstanceConfig(
        agentRaw({ fallbackProvider: 'opencode-cli', fallbackModel: 'minimax/MiniMax-M2' }),
        createCtx,
      ),
    ).toBeNull();
  });
});
