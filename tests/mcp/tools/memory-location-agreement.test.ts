// memory_write and knowledge_search must agree on where an instance's memories
// live. The instance below uses the standalone `mw-mind` vector index as its
// memory index, and its knowledge profile lists seven named namespaces (the
// built-in mw-mind profile shape). memory_write writes through PineconeMemory, which opens the
// index without a namespace (the SDK default namespace).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext, ToolDeclaration } from '../../../src/mcp/types.ts';

const { FakePinecone, store, queriedNamespaces } = vi.hoisted(() => {
  type StoredRecord = { id: string; text: string; chatJid: string };
  type ChatFilter = { chat_jid?: { $eq?: string } } | undefined;
  const store = new Map<string, StoredRecord[]>();
  const queriedNamespaces: string[] = [];
  // Models Pinecone's metadata `$eq` filter on chat_jid, the only filter
  // knowledge_search sends.
  const matchesFilter = (record: StoredRecord, filter: ChatFilter) =>
    !filter?.chat_jid?.$eq || record.chatJid === filter.chat_jid.$eq;

  // Models the three SDK behaviours this agreement depends on
  // (@pinecone-database/pinecone dist):
  //   data/index.js:173                  Index target namespace = options.namespace || '__default__'
  //   data/vectors/upsertRecords.js:26   namespace = options.namespace ?? this.namespace
  //   data/vectors/searchRecords.js:20   namespace = searchOptions.namespace ?? this.namespace
  // Vector `query` runs against the handle's target namespace.
  function makeIndex(indexName: string, namespace: string | undefined) {
    const target = namespace || '__default__';
    const key = (ns: string) => `${indexName}/${ns}`;
    return {
      upsertRecords: async (options: { records: Array<Record<string, unknown>>; namespace?: string }) => {
        const ns = options.namespace ?? target;
        const bucket = store.get(key(ns)) ?? [];
        for (const record of options.records) {
          bucket.push({
            id: String(record['_id']),
            text: String(record['text']),
            chatJid: String(record['chat_jid']),
          });
        }
        store.set(key(ns), bucket);
      },
      searchRecords: async (options: { namespace?: string; query: { filter?: ChatFilter } }) => {
        const ns = options.namespace ?? target;
        queriedNamespaces.push(ns);
        const hits = (store.get(key(ns)) ?? [])
          .filter((r) => matchesFilter(r, options.query.filter))
          .map((r) => ({ _id: r.id, _score: 0.9, fields: { text: r.text } }));
        return { result: { hits } };
      },
      query: async (params: { topK: number; filter?: ChatFilter }) => {
        queriedNamespaces.push(target);
        const matches = (store.get(key(target)) ?? [])
          .filter((r) => matchesFilter(r, params.filter))
          .slice(0, params.topK)
          .map((r) => ({ id: r.id, score: 0.9, metadata: { text: r.text } }));
        return { matches };
      },
      namespace: (ns: string) => makeIndex(indexName, ns),
    };
  }

  const FakePinecone = vi.fn(function (this: Record<string, unknown>) {
    this.index = (indexName: string) => makeIndex(indexName, undefined);
    this.listIndexes = async () => ({
      indexes: [{ name: 'mw-mind', host: 'mw-mind-nf9hzvy.svc.aped-4627-b74a.pinecone.io' }],
    });
    this.inference = { rerank: vi.fn() };
  });

  return { FakePinecone, store, queriedNamespaces };
});

vi.mock('@pinecone-database/pinecone', () => ({ Pinecone: FakePinecone }));

vi.mock('../../../src/config.ts', () => {
  const namespaces = {
    facts: 'whatsapp-facts',
    chunks: 'whatsapp-chunks',
    summaries: 'whatsapp-summaries',
    legacy: 'whatsapp',
    contacts: 'whatsapp-contacts',
    localDocs: 'local-docs',
    oneDrive: 'onedrive',
  };
  return {
    config: {
      botName: 'vector-memory-bot',
      pineconeIndex: 'mw-mind',
      pineconeContextTopK: 10,
      pineconeSenderTopK: 5,
      enrichmentDedupThreshold: 0.95,
      recencyHalfLifeDays: 36500,
      maxAgeDays: 36500,
      memory: {
        pinecone: {
          apiKeyEnv: 'AGREEMENT_PINECONE_API_KEY',
          projectId: 'nf9hzvy',
          index: 'mw-mind',
          namespaces,
          allowedIndexes: ['mw-mind'],
          knowledgeProfiles: {
            // Same shape as the built-in mw-mind profile in config.ts.
            'mw-mind': {
              namespace: '',
              namespaces: [
                namespaces.localDocs,
                namespaces.oneDrive,
                namespaces.legacy,
                namespaces.contacts,
                namespaces.facts,
                namespaces.chunks,
                namespaces.summaries,
              ],
              searchMode: 'vector',
              rerank: false,
              rerankModel: '',
              topK: 20,
              rerankTopN: 6,
              embedUrl: 'http://embed.local/embed',
              description: 'Standalone memory index',
            },
          },
        },
      },
    },
  };
});

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => null),
}));

import { registerMemoryWriteTools } from '../../../src/mcp/tools/memory-write.ts';
import { registerKnowledgeTools } from '../../../src/mcp/tools/knowledge.ts';

const chatSession: SessionContext = {
  tier: 'chat-scoped',
  conversationKey: 'synthetic-chat@s.whatsapp.net',
  deliveryJid: 'synthetic-chat@s.whatsapp.net',
  actorJid: 'synthetic-actor@s.whatsapp.net',
};

function registerTools(): { memoryWrite: ToolDeclaration; knowledgeSearch: ToolDeclaration } {
  const tools: ToolDeclaration[] = [];
  const register = (tool: ToolDeclaration) => tools.push(tool);
  registerMemoryWriteTools(register);
  registerKnowledgeTools(['mw-mind'], register);
  const memoryWrite = tools.find((tool) => tool.name === 'memory_write');
  const knowledgeSearch = tools.find((tool) => tool.name === 'knowledge_search');
  if (!memoryWrite || !knowledgeSearch) throw new Error('memory tools did not register');
  return { memoryWrite, knowledgeSearch };
}

beforeEach(() => {
  store.clear();
  queriedNamespaces.length = 0;
  FakePinecone.mockClear();
  process.env.AGREEMENT_PINECONE_API_KEY = 'agreement-test-key';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ vectors: [[0.1, 0.2, 0.3]] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )));
});

describe('memory_write / knowledge_search namespace agreement', () => {
  it('finds a record memory_write wrote, for an instance whose profile lists only named namespaces', async () => {
    const { memoryWrite, knowledgeSearch } = registerTools();

    const written = await memoryWrite.handler(
      {
        chatJid: chatSession.conversationKey,
        text: 'Prefers the quarterly review on Thursdays',
        memory_type: 'preference',
      },
      chatSession,
    );
    expect(written).toMatchObject({ status: 'written' });
    const writtenNamespaces = [...store.keys()];
    expect(writtenNamespaces).toEqual(['mw-mind/__default__']);

    const found = await knowledgeSearch.handler(
      { index: 'mw-mind', query: 'quarterly review day' },
      chatSession,
    ) as { results_count: number; formatted: string };

    expect(queriedNamespaces).toContain('__default__');
    expect(found.results_count).toBe(1);
    expect(found.formatted).toContain('Prefers the quarterly review on Thursdays');
  });

  it('still searches every configured named namespace, and the write namespace once', async () => {
    const { knowledgeSearch } = registerTools();

    await knowledgeSearch.handler({ index: 'mw-mind', query: 'anything at all' }, chatSession);

    expect([...queriedNamespaces].sort()).toEqual([
      '__default__',
      'local-docs',
      'onedrive',
      'whatsapp',
      'whatsapp-chunks',
      'whatsapp-contacts',
      'whatsapp-facts',
      'whatsapp-summaries',
    ]);
  });

  it('keeps the memory_write leg scoped to the caller conversation', async () => {
    const { memoryWrite, knowledgeSearch } = registerTools();
    await memoryWrite.handler(
      { chatJid: chatSession.conversationKey, text: 'Only for the first conversation', memory_type: 'preference' },
      chatSession,
    );

    const otherSession: SessionContext = {
      ...chatSession,
      conversationKey: 'synthetic-other-chat@s.whatsapp.net',
      deliveryJid: 'synthetic-other-chat@s.whatsapp.net',
    };
    const fromOtherChat = await knowledgeSearch.handler(
      { index: 'mw-mind', query: 'first conversation' },
      otherSession,
    ) as { results_count: number };
    expect(queriedNamespaces).toContain('__default__');
    expect(fromOtherChat.results_count).toBe(0);

    queriedNamespaces.length = 0;
    const unpinned: SessionContext = { tier: 'global' };
    await knowledgeSearch.handler({ index: 'mw-mind', query: 'first conversation' }, unpinned);
    expect(queriedNamespaces).not.toContain('__default__');
  });

  it('honours an explicit namespace argument without adding the write namespace', async () => {
    const { knowledgeSearch } = registerTools();

    await knowledgeSearch.handler(
      { index: 'mw-mind', query: 'anything at all', namespace: 'onedrive' },
      chatSession,
    );

    expect(queriedNamespaces).toEqual(['onedrive']);
  });
});
