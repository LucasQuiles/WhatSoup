import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDeclaration } from '../../../src/mcp/types.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';

const {
  PineconeMock,
  pineconeCtor,
  configStub,
  routeQueryMock,
  searchRecordsMock,
} = vi.hoisted(() => {
  const pineconeCtor = vi.fn();
  const searchRecordsMock = vi.fn();
  const PineconeMock = vi.fn().mockImplementation(function (this: unknown, ...args: unknown[]) {
    pineconeCtor(...args);
    return {
      index: vi.fn(() => ({
        searchRecords: searchRecordsMock,
      })),
    };
  });
  const configStub = {
    memory: {
      pinecone: {
        apiKeyEnv: 'TEST_PINECONE_API_KEY',
        // project guard disabled to keep tests focused on registration + routing,
        // not the project-validation path (that path requires a real listIndexes mock)
        projectId: undefined,
        expectedHostSuffix: undefined,
        namespaces: { facts: 'ns_facts', chunks: 'ns_chunks', summaries: 'ns_summaries' },
        knowledgeProfiles: {
          'index-a': {
            namespace: 'ns_a',
            namespaces: ['ns_a', 'ns_a_extra'],
            searchMode: 'records',
            rerank: false,
            rerankModel: 'bge-reranker-v2-m3',
            topK: 8,
            rerankTopN: 8,
            description: 'Test index A',
          },
          'index-b': {
            namespace: 'ns_b',
            namespaces: ['ns_b'],
            searchMode: 'records',
            rerank: false,
            rerankModel: 'bge-reranker-v2-m3',
            topK: 8,
            rerankTopN: 8,
            description: 'Test index B',
          },
          'mw-mind': {
            namespace: 'ns_facts',
            namespaces: ['ns_facts', 'ns_summaries', 'ns_chunks'],
            searchMode: 'text',
            rerank: false,
            rerankModel: 'bge-reranker-v2-m3',
            topK: 6,
            rerankTopN: 6,
            description: 'Routed WhatsApp memory',
          },
        },
      },
    },
  };
  return {
    PineconeMock,
    pineconeCtor,
    configStub,
    routeQueryMock: vi.fn(),
    searchRecordsMock,
  };
});

vi.mock('@pinecone-database/pinecone', () => ({
  Pinecone: PineconeMock,
}));

vi.mock('../../../src/config.ts', () => ({
  config: configStub,
}));

vi.mock('../../../src/runtimes/chat/memory/query-router.ts', () => ({
  routeQuery: routeQueryMock,
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { registerKnowledgeTools } from '../../../src/mcp/tools/knowledge.ts';

beforeEach(() => {
  PineconeMock.mockClear();
  pineconeCtor.mockClear();
  routeQueryMock.mockReset();
  routeQueryMock.mockReturnValue({ namespaces: ['ns_summaries'], intent: 'hybrid' });
  searchRecordsMock.mockReset();
  searchRecordsMock.mockResolvedValue({ result: { hits: [] } });
  process.env.TEST_PINECONE_API_KEY = 'pinecone-test-key';
});

afterEach(() => {
  delete process.env.TEST_PINECONE_API_KEY;
});

function collector(): {
  registered: ToolDeclaration[];
  register: (t: ToolDeclaration) => void;
} {
  const registered: ToolDeclaration[] = [];
  return { registered, register: (t) => registered.push(t) };
}

function registryWithKnowledgeTool(indexes: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  registerKnowledgeTools(indexes, (tool) => registry.register(tool));
  return registry;
}

function parseRegistryText(result: Awaited<ReturnType<ToolRegistry['call']>>): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe('registerKnowledgeTools - registration gating', () => {
  it('registers nothing when the allowed-index list is empty', () => {
    const c = collector();
    registerKnowledgeTools([], c.register);
    expect(c.registered).toHaveLength(0);
    expect(PineconeMock).not.toHaveBeenCalled();
  });

  it('registers nothing when the Pinecone API key env is missing', () => {
    delete process.env.TEST_PINECONE_API_KEY;
    const c = collector();
    registerKnowledgeTools(['index-a'], c.register);
    expect(c.registered).toHaveLength(0);
    expect(PineconeMock).not.toHaveBeenCalled();
  });

  it('registers nothing when Pinecone client construction throws', () => {
    PineconeMock.mockImplementationOnce(() => {
      throw new Error('init failed');
    });
    const c = collector();
    registerKnowledgeTools(['index-a'], c.register);
    expect(c.registered).toHaveLength(0);
  });

  it('filters out index names not present in knowledgeProfiles', () => {
    const c = collector();
    registerKnowledgeTools(['index-a', 'unknown-index'], c.register);
    expect(c.registered).toHaveLength(1);
    const tool = c.registered[0]!;
    expect(tool.name).toBe('knowledge_search');
    // Description embeds the allowed index name + description but NOT the unknown
    expect(tool.description).toContain('Test index A');
    expect(tool.description).not.toContain('unknown-index');
  });

  it('registers nothing when all requested indexes are unknown', () => {
    const c = collector();
    registerKnowledgeTools(['unknown-only'], c.register);
    expect(c.registered).toHaveLength(0);
  });

  it('produces a single knowledge_search tool with chat scope and read_only replayPolicy', () => {
    const c = collector();
    registerKnowledgeTools(['index-a', 'index-b'], c.register);
    expect(c.registered).toHaveLength(1);
    const tool = c.registered[0]!;
    expect(tool.name).toBe('knowledge_search');
    expect(tool.scope).toBe('chat');
    expect(tool.replayPolicy).toBe('read_only');
    expect(tool.targetMode).toBe('caller-supplied');
  });

  it('description embeds every registered index name and its description', () => {
    const c = collector();
    registerKnowledgeTools(['index-a', 'index-b'], c.register);
    const tool = c.registered[0]!;
    expect(tool.description).toContain('"index-a"');
    expect(tool.description).toContain('Test index A');
    expect(tool.description).toContain('"index-b"');
    expect(tool.description).toContain('Test index B');
  });

  it('builds the Pinecone client with the api key from configured env var', () => {
    const c = collector();
    registerKnowledgeTools(['index-a'], c.register);
    expect(PineconeMock).toHaveBeenCalledTimes(1);
    expect(pineconeCtor).toHaveBeenCalledWith({ apiKey: 'pinecone-test-key' });
  });
});

describe('knowledge_search handler - input validation', () => {
  it('returns a registry error when params fail schema validation (query too short)', async () => {
    const registry = registryWithKnowledgeTool(['index-a']);

    const result = await registry.call('knowledge_search', { index: 'index-a', query: 'x' }, { tier: 'global' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Invalid parameters for tool "knowledge_search"');
    expect(searchRecordsMock).not.toHaveBeenCalled();
  });

  it('returns a registry error when index is not in the registered enum', async () => {
    const registry = registryWithKnowledgeTool(['index-a']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'never-registered', query: 'a valid query' },
      { tier: 'global' },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Invalid parameters for tool "knowledge_search"');
    expect(searchRecordsMock).not.toHaveBeenCalled();
  });

  it('returns a registry error when top_k exceeds the schema upper bound', async () => {
    const registry = registryWithKnowledgeTool(['index-a']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'index-a', query: 'a valid query', top_k: 999 },
      { tier: 'global' },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Invalid parameters for tool "knowledge_search"');
    expect(searchRecordsMock).not.toHaveBeenCalled();
  });
});

describe('knowledge_search handler - schema enforcement', () => {
  it('rejects query at the empty-string boundary (min length 2)', async () => {
    const c = collector();
    registerKnowledgeTools(['index-a'], c.register);
    const handler = c.registered[0]!.handler;

    const result = await handler({ index: 'index-a', query: '' }, { tier: 'global' });
    expect(result).toEqual({ error: expect.stringContaining('Invalid parameters') });
  });

  it('rejects top_k below the schema lower bound', async () => {
    const c = collector();
    registerKnowledgeTools(['index-a'], c.register);
    const handler = c.registered[0]!.handler;

    const result = await handler({ index: 'index-a', query: 'a valid query', top_k: 0 }, { tier: 'global' });
    expect(result).toEqual({ error: expect.stringContaining('Invalid parameters') });
  });

  it('rejects non-string namespace override', async () => {
    const c = collector();
    registerKnowledgeTools(['index-a'], c.register);
    const handler = c.registered[0]!.handler;

    const result = await handler(
      { index: 'index-a', query: 'a valid query', namespace: 42 },
      { tier: 'global' },
    );
    expect(result).toEqual({ error: expect.stringContaining('Invalid parameters') });
  });

  it('rejects query over the schema upper bound (max length 500)', async () => {
    const c = collector();
    registerKnowledgeTools(['index-a'], c.register);
    const handler = c.registered[0]!.handler;

    const result = await handler({
      index: 'index-a',
      query: 'x'.repeat(501),
    }, { tier: 'global' });
    expect(result).toEqual({ error: expect.stringContaining('Invalid parameters') });
  });
});

describe('knowledge_search handler - Pinecone search behavior', () => {
  it('searches configured namespaces and formats returned hits', async () => {
    searchRecordsMock
      .mockResolvedValueOnce({
        result: {
          hits: [
            {
              _id: 'doc-a',
              _score: 0.61,
              fields: { filepath: 'a.md', summary: 'Alpha summary', text: 'Alpha body' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          hits: [
            {
              _id: 'doc-b',
              _score: 0.91,
              fields: { filepath: 'b.md', summary: 'Beta summary', text: 'Beta body' },
            },
          ],
        },
      });
    const registry = registryWithKnowledgeTool(['index-a']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'index-a', query: 'project notes', top_k: 3 },
      { tier: 'global' },
    );

    expect(searchRecordsMock).toHaveBeenNthCalledWith(1, {
      namespace: 'ns_a',
      query: {
        topK: 3,
        inputs: { text: 'project notes' },
      },
      fields: ['*'],
    });
    expect(searchRecordsMock).toHaveBeenNthCalledWith(2, {
      namespace: 'ns_a_extra',
      query: {
        topK: 3,
        inputs: { text: 'project notes' },
      },
      fields: ['*'],
    });
    expect(result.isError).toBeUndefined();
    expect(parseRegistryText(result)).toEqual({
      index: 'index-a',
      query: 'project notes',
      results_count: 2,
      formatted: '[b.md]\nBeta summary\n\n[a.md]\nAlpha summary',
    });
  });

  it('uses an allowed namespace override instead of profile fan-out', async () => {
    searchRecordsMock.mockResolvedValueOnce({ result: { hits: [] } });
    const registry = registryWithKnowledgeTool(['mw-mind']);

    const result = await registry.call(
      'knowledge_search',
      {
        index: 'mw-mind',
        query: 'message context',
        namespace: 'ns_chunks',
      },
      { tier: 'global' },
    );

    expect(routeQueryMock).not.toHaveBeenCalled();
    expect(searchRecordsMock).toHaveBeenCalledTimes(1);
    expect(searchRecordsMock).toHaveBeenCalledWith({
      namespace: 'ns_chunks',
      query: {
        topK: 6,
        inputs: { text: 'message context' },
      },
      fields: ['*'],
    });
    expect(result.isError).toBeUndefined();
    expect(parseRegistryText(result)).toMatchObject({
      index: 'mw-mind',
      query: 'message context',
      results_count: 0,
    });
  });

  it('routes mw-mind queries before appending remaining profile namespaces', async () => {
    routeQueryMock.mockReturnValue({ namespaces: ['ns_summaries', 'ns_facts'], intent: 'raw-first' });
    const registry = registryWithKnowledgeTool(['mw-mind']);

    await registry.call(
      'knowledge_search',
      { index: 'mw-mind', query: 'recent summary' },
      { tier: 'global' },
    );

    expect(routeQueryMock).toHaveBeenCalledWith('recent summary', {
      namespaces: configStub.memory.pinecone.namespaces,
    });
    expect(searchRecordsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ namespace: 'ns_summaries' }));
    expect(searchRecordsMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ namespace: 'ns_facts' }));
    expect(searchRecordsMock).toHaveBeenNthCalledWith(3, expect.objectContaining({ namespace: 'ns_chunks' }));
  });

  it('rejects namespace overrides outside the selected profile allowlist', async () => {
    const c = collector();
    registerKnowledgeTools(['index-a'], c.register);
    const handler = c.registered[0]!.handler;

    const result = await handler({
      index: 'index-a',
      query: 'project notes',
      namespace: 'ns_b',
    }, { tier: 'global' });

    expect(searchRecordsMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: 'Namespace "ns_b" is not allowed for index "index-a".',
    });
  });
});
