import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDeclaration } from '../../../src/mcp/types.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';

const {
  PineconeMock,
  pineconeCtor,
  configStub,
  routeQueryMock,
  searchRecordsMock,
  namespaceQueryMock,
  rerankMock,
  listIndexesMock,
} = vi.hoisted(() => {
  const pineconeCtor = vi.fn();
  const searchRecordsMock = vi.fn();
  const namespaceQueryMock = vi.fn();
  const rerankMock = vi.fn();
  const listIndexesMock = vi.fn();
  const PineconeMock = vi.fn().mockImplementation(function (this: unknown, ...args: unknown[]) {
    pineconeCtor(...args);
    return {
      index: vi.fn(() => ({
        searchRecords: searchRecordsMock,
        namespace: vi.fn((namespace: string) => ({
          query: (params: unknown) => namespaceQueryMock(namespace, params),
        })),
      })),
      inference: {
        rerank: rerankMock,
      },
      listIndexes: listIndexesMock,
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
          'single-ns': {
            namespace: 'only_ns',
            namespaces: [],
            searchMode: 'records',
            rerank: false,
            rerankModel: 'bge-reranker-v2-m3',
            topK: 4,
            rerankTopN: 4,
            description: 'Single namespace records index',
          },
          'entity-index': {
            namespace: 'entity_ns',
            namespaces: ['entity_ns'],
            searchMode: 'entity',
            rerank: false,
            rerankModel: 'bge-reranker-v2-m3',
            topK: 5,
            rerankTopN: 5,
            description: 'Entity index',
          },
          'vector-index': {
            namespace: 'vec_a',
            namespaces: ['vec_a', 'vec_b'],
            searchMode: 'vector',
            embedUrl: 'http://embed.local/embed',
            rerank: false,
            rerankModel: 'bge-reranker-v2-m3',
            topK: 5,
            rerankTopN: 5,
            description: 'Vector index',
          },
          'rerank-index': {
            namespace: 'rerank_ns',
            namespaces: ['rerank_ns'],
            searchMode: 'records',
            rerank: true,
            rerankModel: 'bge-reranker-v2-m3',
            topK: 5,
            rerankTopN: 2,
            description: 'Rerank index',
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
    namespaceQueryMock,
    rerankMock,
    listIndexesMock,
  };
});

type MutablePineconeConfig = {
  apiKeyEnv?: string;
  projectId?: string;
  expectedHostSuffix?: string;
};

function mutablePineconeConfig(): MutablePineconeConfig {
  return configStub.memory.pinecone as unknown as MutablePineconeConfig;
}

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

vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => null),
}));

import { registerKnowledgeTools, createPineconeWatchSearch } from '../../../src/mcp/tools/knowledge.ts';

beforeEach(() => {
  PineconeMock.mockClear();
  pineconeCtor.mockClear();
  routeQueryMock.mockReset();
  routeQueryMock.mockReturnValue({ namespaces: ['ns_summaries'], intent: 'hybrid' });
  searchRecordsMock.mockReset();
  searchRecordsMock.mockResolvedValue({ result: { hits: [] } });
  namespaceQueryMock.mockReset();
  namespaceQueryMock.mockResolvedValue({ matches: [] });
  rerankMock.mockReset();
  rerankMock.mockResolvedValue({ data: [] });
  listIndexesMock.mockReset();
  listIndexesMock.mockResolvedValue({ indexes: [] });
  mutablePineconeConfig().apiKeyEnv = 'TEST_PINECONE_API_KEY';
  mutablePineconeConfig().projectId = undefined;
  mutablePineconeConfig().expectedHostSuffix = undefined;
  configStub.memory.pinecone.knowledgeProfiles['entity-index']!.namespaces = ['entity_ns'];
  configStub.memory.pinecone.knowledgeProfiles['vector-index']!.embedUrl = 'http://embed.local/embed';
  process.env.TEST_PINECONE_API_KEY = 'pinecone-test-key';
  vi.unstubAllGlobals();
});

afterEach(() => {
  delete process.env.TEST_PINECONE_API_KEY;
  delete process.env.PINECONE_API_KEY;
  vi.unstubAllGlobals();
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

describe('createPineconeWatchSearch - registration gating', () => {
  it('returns null when the allowed-index list is empty', () => {
    const watchSearch = createPineconeWatchSearch([]);

    expect(watchSearch).toBeNull();
    expect(PineconeMock).not.toHaveBeenCalled();
  });

  it('returns null when the Pinecone API key env is missing', () => {
    delete process.env.TEST_PINECONE_API_KEY;

    const watchSearch = createPineconeWatchSearch(['index-a']);

    expect(watchSearch).toBeNull();
    expect(PineconeMock).not.toHaveBeenCalled();
  });

  it('returns null when Pinecone client construction throws', () => {
    PineconeMock.mockImplementationOnce(() => {
      throw new Error('init failed');
    });

    const watchSearch = createPineconeWatchSearch(['index-a']);

    expect(watchSearch).toBeNull();
    expect(PineconeMock).toHaveBeenCalledTimes(1);
  });

  it('filters out unknown index names', () => {
    const watchSearch = createPineconeWatchSearch(['index-a', 'unknown-index']);

    expect(watchSearch?.allowedIndexes).toEqual(['index-a']);
  });

  it('returns null when all requested indexes are unknown', () => {
    const watchSearch = createPineconeWatchSearch(['unknown-only']);

    expect(watchSearch).toBeNull();
    expect(PineconeMock).toHaveBeenCalledTimes(1);
  });
});

describe('createPineconeWatchSearch - records search', () => {
  it('returns only scores from integrated-record searches', async () => {
    searchRecordsMock.mockResolvedValueOnce({
      result: {
        hits: [
          { _id: 'doc-a', _score: 0.8, fields: { text: 'must not cross boundary' } },
          { _id: 'doc-b', _score: 'not-a-number', fields: { text: 'ignored score' } },
          { _id: 'doc-c', _score: 0.2, fields: { text: 'also hidden' } },
        ],
      },
    });
    const watchSearch = createPineconeWatchSearch(['index-a']);
    expect(watchSearch).not.toBeNull();

    const result = await watchSearch!.search({
      index: 'index-a',
      namespace: 'ns_a',
      query: 'watch query',
      topK: 3,
    });

    expect(searchRecordsMock).toHaveBeenCalledWith({
      namespace: 'ns_a',
      query: { topK: 3, inputs: { text: 'watch query' } },
      fields: [],
    });
    expect(result).toEqual({ matches: [{ score: 0.8 }, { score: 0.2 }] });
  });

  it('throws before querying when the runtime index is not a configured profile', async () => {
    const watchSearch = createPineconeWatchSearch(['index-a']);
    expect(watchSearch).not.toBeNull();

    await expect(watchSearch!.search({
      index: 'unknown-index',
      namespace: 'ns_a',
      query: 'watch query',
      topK: 3,
    })).rejects.toThrow('index "unknown-index" is not an allowlisted knowledge profile');
    expect(searchRecordsMock).not.toHaveBeenCalled();
  });

  it('throws a project-guard error before querying records', async () => {
    mutablePineconeConfig().projectId = 'expected-project';
    listIndexesMock.mockResolvedValueOnce({
      indexes: [{ name: 'index-a', host: 'index-a-wrong-project.svc.pinecone.io' }],
    });
    const watchSearch = createPineconeWatchSearch(['index-a']);
    expect(watchSearch).not.toBeNull();

    await expect(watchSearch!.search({
      index: 'index-a',
      namespace: 'ns_a',
      query: 'watch query',
      topK: 3,
    })).rejects.toThrow('Index "index-a" is in the wrong Pinecone project for this instance.');
    expect(searchRecordsMock).not.toHaveBeenCalled();
  });

  it('throws a missing-index project-guard error before querying records', async () => {
    mutablePineconeConfig().projectId = 'expected-project';
    listIndexesMock.mockResolvedValueOnce({ indexes: [] });
    const watchSearch = createPineconeWatchSearch(['index-a']);
    expect(watchSearch).not.toBeNull();

    await expect(watchSearch!.search({
      index: 'index-a',
      namespace: 'ns_a',
      query: 'watch query',
      topK: 3,
    })).rejects.toThrow('Index "index-a" was not found for the configured Pinecone key.');
    expect(searchRecordsMock).not.toHaveBeenCalled();
  });

  it('returns an empty score list when a records response has no hits', async () => {
    searchRecordsMock.mockResolvedValueOnce({ result: {} });
    const watchSearch = createPineconeWatchSearch(['index-a']);
    expect(watchSearch).not.toBeNull();

    const result = await watchSearch!.search({
      index: 'index-a',
      namespace: 'ns_a',
      query: 'watch query',
      topK: 3,
    });

    expect(result).toEqual({ matches: [] });
    expect(searchRecordsMock).toHaveBeenCalledTimes(1);
  });
});

describe('createPineconeWatchSearch - vector search', () => {
  it('embeds vector queries and returns only scores from Pinecone matches', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vectors: [[0.4, 0.5]] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    namespaceQueryMock.mockResolvedValueOnce({
      matches: [
        { id: 'vec-a', score: 0.95, metadata: { text: 'must not cross boundary' } },
        { id: 'vec-b', score: undefined, metadata: { text: 'ignored score' } },
        { id: 'vec-c', score: 0.4, metadata: { text: 'also hidden' } },
      ],
    });
    const watchSearch = createPineconeWatchSearch(['vector-index']);
    expect(watchSearch).not.toBeNull();

    const result = await watchSearch!.search({
      index: 'vector-index',
      namespace: 'vec_a',
      query: 'vector watch',
      topK: 2,
    });

    expect(fetchMock).toHaveBeenCalledWith('http://embed.local/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['vector watch'], input_type: 'query' }),
    });
    expect(namespaceQueryMock).toHaveBeenCalledWith('vec_a', {
      topK: 2,
      vector: [0.4, 0.5],
      includeMetadata: false,
    });
    expect(result).toEqual({ matches: [{ score: 0.95 }, { score: 0.4 }] });
  });

  it('throws when a vector watch profile has no embed URL', async () => {
    (configStub.memory.pinecone.knowledgeProfiles['vector-index'] as { embedUrl?: string }).embedUrl = undefined;
    const watchSearch = createPineconeWatchSearch(['vector-index']);
    expect(watchSearch).not.toBeNull();

    await expect(watchSearch!.search({
      index: 'vector-index',
      namespace: 'vec_a',
      query: 'vector watch',
      topK: 2,
    })).rejects.toThrow('vector index "vector-index" missing embedUrl');
    expect(namespaceQueryMock).not.toHaveBeenCalled();
  });

  it('throws when the embed service returns a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const watchSearch = createPineconeWatchSearch(['vector-index']);
    expect(watchSearch).not.toBeNull();

    await expect(watchSearch!.search({
      index: 'vector-index',
      namespace: 'vec_a',
      query: 'vector watch',
      topK: 2,
    })).rejects.toThrow('embed service HTTP 503');
    expect(namespaceQueryMock).not.toHaveBeenCalled();
  });

  it('throws when the embed service returns no vectors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vectors: [] }),
    }));
    const watchSearch = createPineconeWatchSearch(['vector-index']);
    expect(watchSearch).not.toBeNull();

    await expect(watchSearch!.search({
      index: 'vector-index',
      namespace: 'vec_a',
      query: 'vector watch',
      topK: 2,
    })).rejects.toThrow('embed service returned no vectors');
    expect(namespaceQueryMock).not.toHaveBeenCalled();
  });

  it('propagates embed transport errors without querying Pinecone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('embed refused')));
    const watchSearch = createPineconeWatchSearch(['vector-index']);
    expect(watchSearch).not.toBeNull();

    await expect(watchSearch!.search({
      index: 'vector-index',
      namespace: 'vec_a',
      query: 'vector watch',
      topK: 2,
    })).rejects.toThrow('embed refused');
    expect(namespaceQueryMock).not.toHaveBeenCalled();
  });

  it('returns an empty score list when a vector response has no matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vectors: [[0.4, 0.5]] }),
    }));
    namespaceQueryMock.mockResolvedValueOnce({});
    const watchSearch = createPineconeWatchSearch(['vector-index']);
    expect(watchSearch).not.toBeNull();

    const result = await watchSearch!.search({
      index: 'vector-index',
      namespace: 'vec_a',
      query: 'vector watch',
      topK: 2,
    });

    expect(result).toEqual({ matches: [] });
    expect(namespaceQueryMock).toHaveBeenCalledTimes(1);
  });
});

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

  it('registers nothing when the knowledgeProfiles map is absent', () => {
    const originalProfiles = configStub.memory.pinecone.knowledgeProfiles;
    (configStub.memory.pinecone as { knowledgeProfiles?: typeof originalProfiles }).knowledgeProfiles = undefined;
    const c = collector();

    try {
      registerKnowledgeTools(['index-a'], c.register);

      expect(c.registered).toHaveLength(0);
    } finally {
      configStub.memory.pinecone.knowledgeProfiles = originalProfiles;
    }
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

  it('falls back to PINECONE_API_KEY when no apiKeyEnv override is configured', () => {
    (configStub.memory.pinecone as { apiKeyEnv?: string }).apiKeyEnv = undefined;
    delete process.env.TEST_PINECONE_API_KEY;
    process.env.PINECONE_API_KEY = 'default-pinecone-key';
    const c = collector();

    registerKnowledgeTools(['index-a'], c.register);

    expect(c.registered).toHaveLength(1);
    expect(pineconeCtor).toHaveBeenCalledWith({ apiKey: 'default-pinecone-key' });
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

  it('falls back to the primary namespace when a profile has no namespace fan-out', async () => {
    const registry = registryWithKnowledgeTool(['single-ns']);

    await registry.call(
      'knowledge_search',
      { index: 'single-ns', query: 'compact profile' },
      { tier: 'global' },
    );

    expect(searchRecordsMock).toHaveBeenCalledTimes(1);
    expect(searchRecordsMock).toHaveBeenCalledWith({
      namespace: 'only_ns',
      query: {
        topK: 4,
        inputs: { text: 'compact profile' },
      },
      fields: ['*'],
    });
  });

  it('skips failed namespaces and formats entity hits grouped by entity_type', async () => {
    searchRecordsMock
      .mockRejectedValueOnce(new Error('one namespace failed'))
      .mockResolvedValueOnce({
        result: {
          hits: [
            { _id: 'alice', _score: 0.8, fields: { text: 'Alice owns budget', entity_type: 'person' } },
            { _id: 'teams', _score: 0.7, fields: { text: 'Ops team', entity_type: 'teams' } },
            { _id: 'unknown', _score: 0.6, fields: null },
          ],
        },
      });
    configStub.memory.pinecone.knowledgeProfiles['entity-index']!.namespaces = ['broken_ns', 'entity_ns'];
    const registry = registryWithKnowledgeTool(['entity-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'entity-index', query: 'who owns budget' },
      { tier: 'global' },
    );

    expect(searchRecordsMock).toHaveBeenCalledTimes(2);
    expect(parseRegistryText(result)).toEqual({
      index: 'entity-index',
      query: 'who owns budget',
      results_count: 3,
      formatted: 'Persons:\n• Alice owns budget\n\nTeams:\n• Ops team\n\nUnknowns:\n• ',
    });
  });

  it('returns a configured project-guard error before querying an index', async () => {
    mutablePineconeConfig().projectId = 'expected-project';
    listIndexesMock.mockResolvedValueOnce({
      indexes: [{ name: 'index-a', host: 'index-a-wrong-project.svc.pinecone.io' }],
    });
    const registry = registryWithKnowledgeTool(['index-a']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'index-a', query: 'project notes' },
      { tier: 'global' },
    );

    expect(listIndexesMock).toHaveBeenCalledTimes(1);
    expect(searchRecordsMock).not.toHaveBeenCalled();
    expect(parseRegistryText(result)).toEqual({
      error: 'Index "index-a" is in the wrong Pinecone project for this instance.',
    });
  });

  it('returns a missing-index project-guard error before querying an index', async () => {
    mutablePineconeConfig().projectId = 'expected-project';
    listIndexesMock.mockResolvedValueOnce({ indexes: [] });
    const registry = registryWithKnowledgeTool(['index-a']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'index-a', query: 'project notes' },
      { tier: 'global' },
    );

    expect(searchRecordsMock).not.toHaveBeenCalled();
    expect(parseRegistryText(result)).toEqual({
      error: 'Index "index-a" was not found for the configured Pinecone key.',
    });
  });

  it('formats text hits with the ID and text when filepath and summary are absent', async () => {
    searchRecordsMock.mockResolvedValueOnce({
      result: {
        hits: [
          { _id: 'raw-doc', _score: 0.7, fields: { text: 'Raw body only' } },
        ],
      },
    });
    const registry = registryWithKnowledgeTool(['single-ns']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'single-ns', query: 'raw body' },
      { tier: 'global' },
    );

    expect(parseRegistryText(result)).toEqual({
      index: 'single-ns',
      query: 'raw body',
      results_count: 1,
      formatted: '[raw-doc]\nRaw body only',
    });
  });

  it('searches vector indexes by embedding once and querying every namespace', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vectors: [[0.1, 0.2, 0.3]] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    namespaceQueryMock
      .mockResolvedValueOnce({
        matches: [
          { id: 'vec-a', score: 0.4, metadata: { filepath: 'a.md', summary: 'Alpha vector' } },
        ],
      })
      .mockResolvedValueOnce({
        matches: [
          { id: 'vec-b', score: 0.9, metadata: { filepath: 'b.md', text: 'Beta vector' } },
          { id: 'vec-b', score: 0.8, metadata: { filepath: 'b-duplicate.md', text: 'Duplicate' } },
        ],
      });
    const registry = registryWithKnowledgeTool(['vector-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'vector-index', query: 'vector query', top_k: 2 },
      { tier: 'global' },
    );

    expect(fetchMock).toHaveBeenCalledWith('http://embed.local/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['vector query'], input_type: 'query' }),
    });
    expect(namespaceQueryMock).toHaveBeenNthCalledWith(1, 'vec_a', {
      topK: 2,
      vector: [0.1, 0.2, 0.3],
      includeMetadata: true,
    });
    expect(namespaceQueryMock).toHaveBeenNthCalledWith(2, 'vec_b', {
      topK: 2,
      vector: [0.1, 0.2, 0.3],
      includeMetadata: true,
    });
    expect(parseRegistryText(result)).toEqual({
      index: 'vector-index',
      query: 'vector query',
      results_count: 2,
      formatted: '[b.md]\nBeta vector\n\n[a.md]\nAlpha vector',
    });
  });

  it('returns vector-specific errors for embed service failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = registryWithKnowledgeTool(['vector-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'vector-index', query: 'vector query' },
      { tier: 'global' },
    );

    expect(namespaceQueryMock).not.toHaveBeenCalled();
    expect(parseRegistryText(result)).toEqual({
      error: 'Embed service unavailable (HTTP 503). Try again in a moment.',
    });
  });

  it('fails vector search when the profile has no embed URL', async () => {
    (configStub.memory.pinecone.knowledgeProfiles['vector-index'] as { embedUrl?: string }).embedUrl = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = registryWithKnowledgeTool(['vector-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'vector-index', query: 'vector query' },
      { tier: 'global' },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(parseRegistryText(result)).toEqual({
      error: 'Vector index "vector-index" is missing memory.pinecone.knowledgeProfiles.vector-index.embedUrl.',
    });
  });

  it('fails vector search when the embed service returns no vectors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vectors: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = registryWithKnowledgeTool(['vector-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'vector-index', query: 'vector query' },
      { tier: 'global' },
    );

    expect(namespaceQueryMock).not.toHaveBeenCalled();
    expect(parseRegistryText(result)).toEqual({
      error: 'Embed service returned no vectors.',
    });
  });

  it('fails vector search when the embed service request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('embed refused')));
    const registry = registryWithKnowledgeTool(['vector-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'vector-index', query: 'vector query' },
      { tier: 'global' },
    );

    expect(namespaceQueryMock).not.toHaveBeenCalled();
    expect(parseRegistryText(result)).toEqual({
      error: 'Knowledge base is temporarily unavailable (embed service). Try again in a moment.',
    });
  });

  it('skips failed vector namespaces while returning hits from healthy namespaces', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vectors: [[0.5, 0.6]] }),
    }));
    namespaceQueryMock
      .mockRejectedValueOnce(new Error('namespace down'))
      .mockResolvedValueOnce({
        matches: [
          { id: 'survivor', score: 0.7, metadata: { filepath: 'survivor.md', text: 'Healthy namespace' } },
        ],
      });
    const registry = registryWithKnowledgeTool(['vector-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'vector-index', query: 'vector query' },
      { tier: 'global' },
    );

    expect(namespaceQueryMock).toHaveBeenCalledTimes(2);
    expect(parseRegistryText(result)).toEqual({
      index: 'vector-index',
      query: 'vector query',
      results_count: 1,
      formatted: '[survivor.md]\nHealthy namespace',
    });
  });

  it('defaults vector hit metadata and score when Pinecone returns sparse matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vectors: [[0.5, 0.6]] }),
    }));
    namespaceQueryMock
      .mockResolvedValueOnce({
        matches: [
          { id: 'sparse', score: 'not-a-number', metadata: null },
        ],
      })
      .mockResolvedValueOnce({ matches: [] });
    const registry = registryWithKnowledgeTool(['vector-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'vector-index', query: 'vector query' },
      { tier: 'global' },
    );

    expect(parseRegistryText(result)).toEqual({
      index: 'vector-index',
      query: 'vector query',
      results_count: 1,
      formatted: '[sparse]\n',
    });
  });

  it('reranks result documents when the profile enables rerank', async () => {
    searchRecordsMock.mockResolvedValueOnce({
      result: {
        hits: [
          { _id: 'doc-a', _score: 0.2, fields: { filepath: 'a.md', text: 'Alpha body' } },
          { _id: 'doc-b', _score: 0.9, fields: { filepath: 'b.md', text: 'Beta body' } },
        ],
      },
    });
    rerankMock.mockResolvedValueOnce({
      data: [
        { index: 1, score: 0.99 },
        { index: 0, score: 0.42 },
        { index: 99, score: 0.1 },
      ],
    });
    const registry = registryWithKnowledgeTool(['rerank-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'rerank-index', query: 'rank these' },
      { tier: 'global' },
    );

    expect(rerankMock).toHaveBeenCalledWith({
      model: 'bge-reranker-v2-m3',
      query: 'rank these',
      documents: [
        { id: 'doc-b', text: 'Beta body' },
        { id: 'doc-a', text: 'Alpha body' },
      ],
      topN: 2,
      rankFields: ['text'],
      returnDocuments: false,
    });
    expect(parseRegistryText(result)).toEqual({
      index: 'rerank-index',
      query: 'rank these',
      results_count: 2,
      formatted: '[a.md]\nAlpha body\n\n[b.md]\nBeta body',
    });
  });

  it('falls back to vector scores when rerank fails', async () => {
    searchRecordsMock.mockResolvedValueOnce({
      result: {
        hits: [
          { _id: 'doc-a', _score: 0.2, fields: { filepath: 'a.md', text: 'Alpha body' } },
          { _id: 'doc-b', _score: 0.9, fields: { filepath: 'b.md', text: 'Beta body' } },
        ],
      },
    });
    rerankMock.mockRejectedValueOnce(new Error('rerank down'));
    const registry = registryWithKnowledgeTool(['rerank-index']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'rerank-index', query: 'rank these' },
      { tier: 'global' },
    );

    expect(parseRegistryText(result)).toEqual({
      index: 'rerank-index',
      query: 'rank these',
      results_count: 2,
      formatted: '[b.md]\nBeta body\n\n[a.md]\nAlpha body',
    });
  });

  it('maps transport and auth failures to operator-friendly tool errors', async () => {
    mutablePineconeConfig().projectId = 'expected-project';
    listIndexesMock
      .mockRejectedValueOnce(new Error('ETIMEDOUT while listing indexes'))
      .mockRejectedValueOnce(new Error('401 unauthorized'));
    const registry = registryWithKnowledgeTool(['single-ns']);

    const transport = await registry.call(
      'knowledge_search',
      { index: 'single-ns', query: 'network down' },
      { tier: 'global' },
    );
    const auth = await registry.call(
      'knowledge_search',
      { index: 'single-ns', query: 'auth down' },
      { tier: 'global' },
    );

    expect(parseRegistryText(transport)).toEqual({
      error: 'Knowledge base is temporarily unavailable. Try again in a moment.',
    });
    expect(parseRegistryText(auth)).toEqual({
      error: 'Knowledge base authentication error. Contact admin.',
    });
  });

  it('maps unexpected top-level failures to a generic search error', async () => {
    mutablePineconeConfig().projectId = 'expected-project';
    listIndexesMock.mockRejectedValueOnce(new Error('unexpected list failure'));
    const registry = registryWithKnowledgeTool(['single-ns']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'single-ns', query: 'generic failure' },
      { tier: 'global' },
    );

    expect(parseRegistryText(result)).toEqual({
      error: 'Search failed: unexpected list failure',
    });
  });

  it('maps non-Error top-level failures to a generic search error', async () => {
    mutablePineconeConfig().projectId = 'expected-project';
    listIndexesMock.mockRejectedValueOnce('plain failure');
    const registry = registryWithKnowledgeTool(['single-ns']);

    const result = await registry.call(
      'knowledge_search',
      { index: 'single-ns', query: 'generic failure' },
      { tier: 'global' },
    );

    expect(parseRegistryText(result)).toEqual({
      error: 'Search failed: plain failure',
    });
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

describe('createPineconeWatchSearch', () => {
  it('returns null for an empty allowlist', () => {
    expect(createPineconeWatchSearch([])).toBeNull();
  });

  it('returns null when the Pinecone API key is unset', () => {
    // UNHAPPY: no key -> poll.pinecone watches disabled.
    delete process.env.TEST_PINECONE_API_KEY;
    expect(createPineconeWatchSearch(['vector-index'])).toBeNull();
  });

  it('returns null when no allowlisted index is a known profile', () => {
    // UNHAPPY: an unknown index name is filtered out, leaving nothing valid.
    expect(createPineconeWatchSearch(['nonexistent-index'])).toBeNull();
  });

  it('search() throws when a vector index has no embedUrl', async () => {
    // UNHAPPY: vector mode requires an embed service URL.
    (configStub.memory.pinecone.knowledgeProfiles['vector-index'] as { embedUrl?: string }).embedUrl = undefined;
    const ws = createPineconeWatchSearch(['vector-index']);
    expect(ws).not.toBeNull();
    await expect(
      ws!.search({ index: 'vector-index', namespace: 'ns_v', query: 'q', topK: 5 }),
    ).rejects.toThrow(/missing embedUrl/);
  });

  it('search() throws when the embed service returns a non-OK status', async () => {
    // UNHAPPY: embed HTTP failure must surface, not silently return empty.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const ws = createPineconeWatchSearch(['vector-index']);
    await expect(
      ws!.search({ index: 'vector-index', namespace: 'ns_v', query: 'q', topK: 5 }),
    ).rejects.toThrow(/embed service HTTP 503/);
  });

  it('search() throws when the embed service returns no vectors', async () => {
    // UNHAPPY: a malformed embed response (empty vectors) must throw.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ vectors: [] }) }));
    const ws = createPineconeWatchSearch(['vector-index']);
    await expect(
      ws!.search({ index: 'vector-index', namespace: 'ns_v', query: 'q', topK: 5 }),
    ).rejects.toThrow(/no vectors/);
  });

  it('search() returns scored matches on the happy vector path, skipping non-numeric scores', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ vectors: [[0.1, 0.2, 0.3]] }) }));
    namespaceQueryMock.mockResolvedValue({ matches: [{ score: 0.91 }, { score: 0.82 }, { id: 'no-score' }] });
    const ws = createPineconeWatchSearch(['vector-index']);
    const result = await ws!.search({ index: 'vector-index', namespace: 'ns_v', query: 'q', topK: 5 });
    expect(result.matches.map((m) => m.score)).toEqual([0.91, 0.82]);
  });
});
