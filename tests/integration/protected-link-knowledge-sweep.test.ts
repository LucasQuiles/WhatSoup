/**
 * knowledge_search rows of the protected-link outward-surface sweep. Each row
 * drives the registered handler end to end through the production registry,
 * for the standalone (vector) branch and the integrated-index branch. They
 * live beside protected-link-outward-surfaces-sweep.test.ts because they need
 * module mocks (Pinecone, config, keyring) the other sweep rows must not share.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configStub, searchRecordsMock, namespaceQueryMock, rerankMock } = vi.hoisted(() => {
  const profile = (searchMode: string, rerank: boolean) => ({
    namespace: 'ns_main', namespaces: ['ns_main'], searchMode, rerank, rerankModel: 'bge-reranker-v2-m3',
    topK: 5, rerankTopN: 5, description: `${searchMode} index`, embedUrl: 'http://embed.local/embed',
  });
  return {
    configStub: {
      memory: {
        pinecone: {
          apiKeyEnv: 'TEST_PINECONE_API_KEY', projectId: undefined, expectedHostSuffix: undefined,
          namespaces: { facts: 'ns_facts', chunks: 'ns_chunks', summaries: 'ns_summaries' },
          knowledgeProfiles: { 'vector-index': profile('vector', true), 'records-index': profile('records', false) },
        },
      },
    },
    searchRecordsMock: vi.fn(),
    namespaceQueryMock: vi.fn(),
    rerankMock: vi.fn(),
  };
});

vi.mock('@pinecone-database/pinecone', () => ({
  Pinecone: vi.fn().mockImplementation(function () {
    return {
      index: () => ({ searchRecords: searchRecordsMock, namespace: () => ({ query: namespaceQueryMock }) }),
      inference: { rerank: rerankMock },
      listIndexes: vi.fn(async () => ({ indexes: [] })),
    };
  }),
}));
vi.mock('../../src/config.ts', () => ({ config: configStub }));
vi.mock('../../src/lib/keyring.ts', () => ({ lookupCredential: vi.fn(() => null) }));
vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());
vi.mock('../../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal as never));
vi.mock('../../src/lib/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal as never));

import { PROTECTED_MESSAGE_MARKER } from '../../src/core/protected-message.ts';
import { registerKnowledgeTools } from '../../src/mcp/tools/knowledge.ts';
import { TEST_LINK_HOST } from '../helpers/protected-delivery-pins.ts';
import { ToolRegistry } from '../helpers/resolved-tool-registry.ts';

const link = (fill: string): string => `https://${TEST_LINK_HOST}/s/#v3.${fill.repeat(22)}.${'Z'.repeat(43)}`;
const LINK = link('Q');
const CONTENT = `${'word '.repeat(19)}${LINK}`;

interface SearchResult {
  results_count: number;
  results: Array<{ id: string }>;
  formatted: string;
}

async function search(index: string): Promise<SearchResult> {
  const registry = new ToolRegistry();
  registerKnowledgeTools([index], (tool) => registry.register(tool));
  const result = await registry.call('knowledge_search', { index, query: 'protected probe' }, { tier: 'global' });
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]!.text) as SearchResult;
}

function expectNoLink(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(TEST_LINK_HOST.slice(0, 6));
  expect(serialized).not.toMatch(/[QAB]{22}/);
}

beforeEach(() => {
  process.env.TEST_PINECONE_API_KEY = 'pinecone-test-key';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ vectors: [[0.1, 0.2]] }) })));
  searchRecordsMock.mockReset();
  namespaceQueryMock.mockReset();
  rerankMock.mockReset();
  rerankMock.mockImplementation(async ({ documents }: { documents: unknown[] }) => ({
    data: documents.map((_document, index) => ({ index, score: 0.9 - index / 10 })),
  }));
});

describe('knowledge_search never returns or sends a protected link', () => {
  beforeEach(() => {
    namespaceQueryMock.mockResolvedValue({
      matches: [{ id: `doc ${LINK}`, score: 0.9, metadata: { text: CONTENT, summary: CONTENT, filepath: `notes ${LINK}` } }],
    });
  });

  it('vector branch, formatted source', async () => {
    const value = await search('vector-index');
    expectNoLink(value);
    expect(value.formatted.split('\n')[0]).toBe(`[notes ${PROTECTED_MESSAGE_MARKER}]`);
  });

  it('vector branch, formatted summary', async () => {
    const value = await search('vector-index');
    expectNoLink(value);
    expect(value.formatted.split('\n')[1]).toContain(PROTECTED_MESSAGE_MARKER);
  });

  it('vector branch, result id', async () => {
    const value = await search('vector-index');
    expectNoLink(value);
    expect(value.results).toEqual([expect.objectContaining({ id: `doc ${PROTECTED_MESSAGE_MARKER}` })]);
  });

  it('vector branch, external rerank request documents', async () => {
    await search('vector-index');
    expect(rerankMock).toHaveBeenCalledTimes(1);
    const { documents } = rerankMock.mock.calls[0]![0] as { documents: Array<{ id: string; text: string }> };
    expectNoLink(documents);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.text).toContain(PROTECTED_MESSAGE_MARKER);
  });
});

describe('knowledge_search keeps distinct records whose ids differ only by a protected link', () => {
  it('integrated branch returns both records', async () => {
    searchRecordsMock.mockResolvedValue({
      result: {
        hits: [
          { _id: `doc ${link('A')}`, _score: 0.9, fields: { text: 'first neutral body' } },
          { _id: `doc ${link('B')}`, _score: 0.8, fields: { text: 'second neutral body' } },
        ],
      },
    });

    const value = await search('records-index');

    expectNoLink(value);
    expect(value.results_count).toBe(2);
    expect(value.formatted).toContain('first neutral body');
    expect(value.formatted).toContain('second neutral body');
  });

  it('vector branch returns both records', async () => {
    namespaceQueryMock.mockResolvedValue({
      matches: [
        { id: `doc ${link('A')}`, score: 0.9, metadata: { text: 'first neutral body' } },
        { id: `doc ${link('B')}`, score: 0.8, metadata: { text: 'second neutral body' } },
      ],
    });

    const value = await search('vector-index');

    expectNoLink(value);
    expect(value.results_count).toBe(2);
    expect(value.formatted).toContain('first neutral body');
    expect(value.formatted).toContain('second neutral body');
  });
});
