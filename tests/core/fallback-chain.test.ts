import { describe, expect, it } from 'vitest';
import {
  fallbackEntryKey,
  isSameAsPrimaryFallbackEntry,
  normalizeFallbackEntriesFromAgentOptions,
  normalizeFallbackEntriesFromInstanceConfig,
} from '../../src/core/fallback-chain.ts';

describe('fallback chain helpers', () => {
  it('normalizes ordered fallback entries and skips malformed rows', () => {
    expect(
      normalizeFallbackEntriesFromAgentOptions({
        fallbacks: [
          null,
          'opencode-cli',
          {},
          { provider: '   ' },
          { provider: ' opencode-cli ', model: ' minimax/MiniMax-M2 ', dataPolicy: 'trusted' },
          { provider: ' openai-api ', model: '   ', dataPolicy: 'restricted' },
        ],
      }),
    ).toEqual([
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', dataPolicy: 'trusted' },
      { provider: 'openai-api', dataPolicy: 'restricted' },
    ]);
  });

  it('normalizes legacy fallbackProvider options and instance config wrappers', () => {
    expect(normalizeFallbackEntriesFromAgentOptions(null)).toEqual([]);
    expect(normalizeFallbackEntriesFromAgentOptions({ fallbackProvider: '   ' })).toEqual([]);
    expect(
      normalizeFallbackEntriesFromAgentOptions({
        fallbackProvider: ' opencode-cli ',
        fallbackModel: ' minimax/MiniMax-M2 ',
        fallbackDataPolicy: ' trusted ',
      }),
    ).toEqual([{ provider: 'opencode-cli', model: 'minimax/MiniMax-M2', dataPolicy: 'trusted' }]);
    expect(
      normalizeFallbackEntriesFromInstanceConfig({
        agentOptions: {
          fallbackProvider: ' openai-api ',
        },
      }),
    ).toEqual([{ provider: 'openai-api' }]);
    expect(normalizeFallbackEntriesFromInstanceConfig({ agentOptions: 'bad' })).toEqual([]);
  });

  it('builds stable provider/model keys', () => {
    expect(fallbackEntryKey({ provider: 'opencode-cli' })).toBe('["opencode-cli",null]');
    expect(fallbackEntryKey({ provider: 'opencode-cli', model: 'minimax/MiniMax-M2' }))
      .toBe('["opencode-cli","minimax/MiniMax-M2"]');
  });

  it('detects fallback entries that collide with the primary provider target', () => {
    expect(isSameAsPrimaryFallbackEntry({ provider: 'openai-api' }, {})).toBe(false);
    expect(isSameAsPrimaryFallbackEntry({ provider: 'claude-cli' }, {})).toBe(true);
    expect(
      isSameAsPrimaryFallbackEntry(
        { provider: 'claude-cli' },
        { model: 'claude-opus-4-8' },
      ),
    ).toBe(false);
    expect(
      isSameAsPrimaryFallbackEntry(
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        {
          agentOptions: { provider: 'opencode-cli' },
          models: { conversation: 'minimax/MiniMax-M2' },
        },
      ),
    ).toBe(true);
    expect(
      isSameAsPrimaryFallbackEntry(
        { provider: 'opencode-cli', model: 'deepseek/deepseek-chat' },
        {
          agentOptions: { provider: 'opencode-cli' },
          model: 'minimax/MiniMax-M2',
        },
      ),
    ).toBe(false);
  });
});
