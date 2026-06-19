import { describe, it, expect, vi } from 'vitest';
import {
  detectContradictions,
  detectContradictionsDetailed,
} from '../../../../src/runtimes/chat/enrichment/contradiction.ts';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';

function providerWithContent(content: string): LLMProvider {
  return {
    name: 'test-provider',
    generate: async () => ({
      content,
      inputTokens: 10,
      outputTokens: 5,
      model: 'test-model',
      durationMs: 1,
    }),
  };
}

describe('detectContradictions', () => {
  it('detects a direct contradiction', async () => {
    const mockProvider = providerWithContent(JSON.stringify([
      { index: 0, relationship: 'contradiction', explanation: 'Location changed' },
    ]));

    const results = await detectContradictions(
      mockProvider,
      { claim: 'Lives in London', text: 'Lives in London' },
      [{ id: 'fact-1', claim: 'Lives in New York', text: 'Lives in New York', score: 0.85 }],
    );

    expect(results).toEqual([
      {
        existingId: 'fact-1',
        relationship: 'contradiction',
        explanation: 'Location changed',
      },
    ]);
  });

  it('filters out non-contradiction relationships', async () => {
    const mockProvider = providerWithContent(JSON.stringify([
      { index: 0, relationship: 'neutral', explanation: 'Unrelated' },
      { index: 1, relationship: 'entailment', explanation: 'Consistent' },
    ]));

    const results = await detectContradictions(
      mockProvider,
      { claim: 'Likes coffee', text: 'Likes coffee' },
      [
        { id: 'fact-1', claim: 'Lives in London', text: 'Lives in London', score: 0.3 },
        { id: 'fact-2', claim: 'Enjoys hot beverages', text: 'Enjoys hot beverages', score: 0.5 },
      ],
    );

    expect(results).toEqual([]);
  });

  it('returns empty on LLM failure', async () => {
    const mockProvider: LLMProvider = {
      name: 'test-provider',
      generate: async () => {
        throw new Error('API down');
      },
    };

    const results = await detectContradictions(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(results).toEqual([]);
  });

  it('surfaces LLM failure separately from a clean no-contradiction result', async () => {
    const mockProvider: LLMProvider = {
      name: 'test-provider',
      generate: async () => {
        throw new Error('API down');
      },
    };

    const details = await detectContradictionsDetailed(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(details).toMatchObject({
      results: [],
      status: 'llm_failed',
      error: 'API down',
    });
  });

  it('returns empty for empty existing facts', async () => {
    const mockProvider = providerWithContent('[]');
    const results = await detectContradictions(mockProvider, { claim: 'x', text: 'x' }, []);
    expect(results).toEqual([]);
  });

  it('marks empty existing facts as an intentional skip', async () => {
    const mockProvider = providerWithContent('[]');
    const details = await detectContradictionsDetailed(mockProvider, { claim: 'x', text: 'x' }, []);
    expect(details).toEqual({ results: [], status: 'skipped_no_existing_facts' });
  });

  it('handles malformed JSON gracefully', async () => {
    const mockProvider = providerWithContent('not json at all');

    const results = await detectContradictions(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(results).toEqual([]);
  });

  it('surfaces malformed JSON separately from no contradictions', async () => {
    const mockProvider = providerWithContent('not json at all');

    const details = await detectContradictionsDetailed(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(details).toMatchObject({
      results: [],
      status: 'parse_failed',
      rawLength: 'not json at all'.length,
    });
    expect(details.error).toEqual(expect.any(String));
  });

  it('surfaces invalid response shapes separately from no contradictions', async () => {
    const mockProvider = providerWithContent('{"relationship":"contradiction"}');

    const details = await detectContradictionsDetailed(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(details).toEqual({
      results: [],
      status: 'invalid_response',
      rawLength: '{"relationship":"contradiction"}'.length,
    });
  });

  it('handles out-of-bounds index gracefully', async () => {
    const mockProvider = providerWithContent(JSON.stringify([
      { index: 99, relationship: 'contradiction', explanation: 'Invalid index' },
    ]));

    const results = await detectContradictions(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(results).toEqual([]);
  });
});

describe('residual-branch coverage', () => {
  it('strips markdown JSON fences from the LLM response', async () => {
    const fenced = '```json\n' + JSON.stringify([
      { index: 0, relationship: 'contradiction', explanation: 'fenced' },
    ]) + '\n```';
    const mockProvider = providerWithContent(fenced);

    const results = await detectContradictions(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(results).toEqual([
      { existingId: 'f1', relationship: 'contradiction', explanation: 'fenced' },
    ]);
  });

  it('falls back to newFact.text when newFact.claim is missing', async () => {
    const mockProvider = providerWithContent(JSON.stringify([
      { index: 0, relationship: 'contradiction', explanation: 'no-claim-new' },
    ]));

    const results = await detectContradictions(
      mockProvider,
      { text: 'fallback-text' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(results).toEqual([
      { existingId: 'f1', relationship: 'contradiction', explanation: 'no-claim-new' },
    ]);
  });

  it('falls back to existingFact.text when existingFact.claim is missing', async () => {
    const mockProvider = providerWithContent(JSON.stringify([
      { index: 0, relationship: 'contradiction', explanation: 'no-claim-existing' },
    ]));

    const results = await detectContradictions(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', text: 'fallback-existing', score: 0.5 }],
    );

    expect(results).toEqual([
      { existingId: 'f1', relationship: 'contradiction', explanation: 'no-claim-existing' },
    ]);
  });

  it('handles the LLM rejecting with a non-Error value (String(err) fallback)', async () => {
    const mockProvider: LLMProvider = {
      name: 'test-provider',
      generate: () => Promise.reject('string-error'),
    };

    const details = await detectContradictionsDetailed(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(details).toEqual({
      results: [],
      status: 'llm_failed',
      error: 'string-error',
    });
  });

  it('handles JSON.parse rejecting with a non-Error value (String(err) fallback)', async () => {
    const mockProvider = providerWithContent('not json at all');
    const spy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'fake-parse-error';
    });
    try {
      const details = await detectContradictionsDetailed(
        mockProvider,
        { claim: 'x', text: 'x' },
        [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
      );
      expect(details).toEqual({
        results: [],
        status: 'parse_failed',
        error: 'fake-parse-error',
        rawLength: 'not json at all'.length,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('skips array items that are null or non-objects', async () => {
    const mockProvider = providerWithContent(JSON.stringify([
      null,
      'string-item',
      42,
      { index: 0, relationship: 'contradiction', explanation: 'real' },
    ]));

    const results = await detectContradictions(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(results).toEqual([
      { existingId: 'f1', relationship: 'contradiction', explanation: 'real' },
    ]);
  });

  it('skips array items with a non-numeric index (typed as string)', async () => {
    const mockProvider = providerWithContent(JSON.stringify([
      { index: 'zero', relationship: 'contradiction', explanation: 'bad-index' },
      { index: 0, relationship: 'contradiction', explanation: 'real' },
    ]));

    const results = await detectContradictions(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(results).toEqual([
      { existingId: 'f1', relationship: 'contradiction', explanation: 'real' },
    ]);
  });

  it('falls back to empty string when explanation is not a string', async () => {
    const mockProvider = providerWithContent(JSON.stringify([
      { index: 0, relationship: 'contradiction', explanation: 42 },
    ]));

    const results = await detectContradictions(
      mockProvider,
      { claim: 'x', text: 'x' },
      [{ id: 'f1', claim: 'y', text: 'y', score: 0.5 }],
    );

    expect(results).toEqual([
      { existingId: 'f1', relationship: 'contradiction', explanation: '' },
    ]);
  });
});
