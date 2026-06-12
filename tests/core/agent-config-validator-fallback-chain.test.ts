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

  it('rejects more than four fallback entries', () => {
    const err = validateInstanceConfig(
      agentRaw({
        fallbacks: [
          { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
          { provider: 'openai-api', model: 'gpt-4o-mini' },
          { provider: 'anthropic-api', model: 'claude-sonnet-4-6' },
          { provider: 'codex-cli' },
          { provider: 'gemini-cli' },
        ],
      }),
      createCtx,
    );
    expect(err?.field).toBe('agentOptions.fallbacks');
    expect(err?.message).toContain('at most 4');
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
            { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
            { provider: 'openai-api', model: 'gpt-4o-mini' },
          ],
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
