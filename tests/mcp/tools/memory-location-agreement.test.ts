// memory_write and knowledge_search must agree on where an instance's memories
// live, and knowledge_search must rank them for the caller without locking out
// the rest of the instance, except in groups (owner decisions 39 and 41).
//
// The instance below uses the standalone `mw-mind` vector index as its memory
// index, and its knowledge profile lists seven named namespaces (the built-in
// mw-mind profile shape). memory_write writes through PineconeMemory, which opens
// the index without a namespace (the SDK default namespace).
//
// The fake index ignores metadata filters on purpose: the client-side gate in
// knowledge_search must hold even when Pinecone returns more than it was asked for.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext, ToolDeclaration } from '../../../src/mcp/types.ts';
import type { GroupParticipantInfo, InstanceIdentities } from '../../../src/core/memory-scope.ts';

const { FakePinecone, store, queries, rerankMock, configState } = vi.hoisted(() => {
  type StoredRecord = { id: string; score: number; fields: Record<string, unknown> };
  const store = new Map<string, StoredRecord[]>();
  const queries: Array<{ namespace: string; filter?: unknown }> = [];
  const rerankMock = vi.fn();
  const configState = { botName: 'vector-memory-bot', profile: {} as Record<string, unknown> };

  // SDK behaviours this agreement depends on (@pinecone-database/pinecone dist):
  //   data/index.js:173                  Index target namespace = options.namespace || '__default__'
  //   data/vectors/upsertRecords.js:26   namespace = options.namespace ?? this.namespace
  // Vector `query` runs against the handle's target namespace.
  function makeIndex(indexName: string, namespace: string | undefined) {
    const target = namespace || '__default__';
    const key = (ns: string) => `${indexName}/${ns}`;
    return {
      upsertRecords: async (options: { records: Array<Record<string, unknown>>; namespace?: string }) => {
        const ns = options.namespace ?? target;
        const bucket = store.get(key(ns)) ?? [];
        for (const record of options.records) {
          const { _id, ...fields } = record;
          bucket.push({ id: String(_id), score: 0.5, fields });
        }
        store.set(key(ns), bucket);
      },
      query: async (params: { topK: number; filter?: unknown }) => {
        queries.push({ namespace: target, ...(params.filter ? { filter: params.filter } : {}) });
        const matches = (store.get(key(target)) ?? [])
          .slice(0, params.topK)
          .map((r) => ({ id: r.id, score: r.score, metadata: r.fields }));
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
    this.inference = { rerank: rerankMock };
  });

  return { FakePinecone, store, queries, rerankMock, configState };
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
  // Same shape as the built-in mw-mind profile in config.ts.
  Object.assign(configState.profile, {
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
  });
  return {
    config: {
      get botName() { return configState.botName; },
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
          knowledgeProfiles: { 'mw-mind': configState.profile },
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
import { registerKnowledgeTools, type KnowledgeSearchDeps } from '../../../src/mcp/tools/knowledge.ts';
import { GroupMembershipCache } from '../../../src/core/memory-scope.ts';
import { Database } from '../../../src/core/database.ts';

const OWNER = '15550000001';
const MEMBER_A = '15550000002';
const MEMBER_B = '15550000003';
const SIBLING = '15550000077';
const BOT_JID = '15550000099@s.whatsapp.net';
const GROUP_JID = '111111100000123@g.us';
const GROUP_KEY = '111111100000123_at_g.us';
const pn = (phone: string) => `${phone}@s.whatsapp.net`;

const identities: InstanceIdentities = {
  adminPhones: new Set([OWNER]),
  siblingPhones: new Set([SIBLING]),
  botJid: BOT_JID,
  botLid: null,
};

// One record per boundary case, in the memory_write namespace.
const RECORDS: Array<{ id: string; score: number; fields: Record<string, unknown> }> = [
  { id: 'g-unattributed', score: 0.50, fields: { text: 'group fact with no member', chat_jid: GROUP_JID, sender_jid: '', memory_type: 'user_fact' } },
  { id: 'g-context', score: 0.60, fields: { text: 'group context', chat_jid: GROUP_KEY, sender_jid: pn(MEMBER_B), memory_type: 'group_context' } },
  { id: 'g-own-a', score: 0.55, fields: { text: 'member A in the group', chat_jid: GROUP_KEY, sender_jid: pn(MEMBER_A), memory_type: 'user_fact' } },
  { id: 'g-own-b', score: 0.90, fields: { text: 'member B in the group', chat_jid: GROUP_JID, sender_jid: pn(MEMBER_B), memory_type: 'user_fact' } },
  { id: 'dm-a', score: 0.95, fields: { text: 'member A direct chat', chat_jid: MEMBER_A, sender_jid: pn(MEMBER_A), memory_type: 'preference' } },
  { id: 'dm-owner', score: 0.97, fields: { text: 'owner direct chat', chat_jid: pn(OWNER), sender_jid: pn(OWNER), memory_type: 'user_fact' } },
  { id: 'untagged', score: 0.99, fields: { text: 'record from before chat attribution' } },
];

function seed(records = RECORDS): void {
  store.set('mw-mind/__default__', records.map((r) => ({ ...r, fields: { ...r.fields } })));
}

function groupSession(actor: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey: GROUP_KEY, deliveryJid: GROUP_JID, actorJid: actor };
}

function dmSession(phone: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey: phone, deliveryJid: pn(phone), actorJid: pn(phone) };
}

function membershipOf(members: string[]): GroupMembershipCache {
  return new GroupMembershipCache(async () => members.map((id): GroupParticipantInfo => ({ id })));
}

function registerTools(deps: KnowledgeSearchDeps = { identities: () => identities }) {
  const tools: ToolDeclaration[] = [];
  const register = (tool: ToolDeclaration) => tools.push(tool);
  registerMemoryWriteTools(register);
  registerKnowledgeTools(['mw-mind'], register, undefined, deps);
  const memoryWrite = tools.find((tool) => tool.name === 'memory_write');
  const knowledgeSearch = tools.find((tool) => tool.name === 'knowledge_search');
  if (!memoryWrite || !knowledgeSearch) throw new Error('memory tools did not register');
  return { memoryWrite, knowledgeSearch };
}

type SearchResult = { results_count: number; results: Array<{ id: string; score: number }>; formatted: string };

async function search(
  tool: ToolDeclaration,
  session: SessionContext,
  extra: Record<string, unknown> = {},
): Promise<string[]> {
  const out = await tool.handler({ index: 'mw-mind', query: 'what do we know', ...extra }, session) as SearchResult;
  return out.results.map((r) => r.id);
}

beforeEach(() => {
  store.clear();
  queries.length = 0;
  rerankMock.mockReset();
  configState.botName = 'vector-memory-bot';
  configState.profile.rerank = false;
  configState.profile.rerankTopN = 6;
  delete configState.profile.minScore;
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
    const session = dmSession(MEMBER_A);

    const written = await memoryWrite.handler(
      { chatJid: session.conversationKey, text: 'Prefers the quarterly review on Thursdays', memory_type: 'preference' },
      session,
    );
    expect(written).toMatchObject({ status: 'written' });
    expect([...store.keys()]).toEqual(['mw-mind/__default__']);

    const found = await knowledgeSearch.handler({ index: 'mw-mind', query: 'quarterly review day' }, session) as SearchResult;
    expect(found.results_count).toBe(1);
    expect(found.formatted).toContain('Prefers the quarterly review on Thursdays');
  });

  it('searches every configured named namespace and the write namespace', async () => {
    const { knowledgeSearch } = registerTools();

    await knowledgeSearch.handler({ index: 'mw-mind', query: 'anything at all' }, dmSession(MEMBER_A));

    expect([...new Set(queries.map((q) => q.namespace))].sort()).toEqual([
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
});

describe('knowledge_search ranking outside configurable groups', () => {
  it('ranks a DM: this chat, then other chats by score, then untagged last', async () => {
    seed();
    const { knowledgeSearch } = registerTools();

    expect(await search(knowledgeSearch, dmSession(MEMBER_A))).toEqual([
      'dm-a', 'dm-owner', 'g-own-b', 'g-context', 'g-own-a', 'g-unattributed', 'untagged',
    ]);
  });

  it('queries this chat in every namespace alongside the unfiltered leg', async () => {
    const { knowledgeSearch } = registerTools();

    await knowledgeSearch.handler({ index: 'mw-mind', query: 'this chat first' }, dmSession(MEMBER_A));

    const defaultLegs = queries.filter((q) => q.namespace === '__default__');
    expect(defaultLegs).toEqual([
      { namespace: '__default__', filter: { chat_jid: { $in: expect.arrayContaining([MEMBER_A, pn(MEMBER_A)]) } } },
      { namespace: '__default__' },
    ]);
  });

  it('does not let duplicate ids from the two legs take result slots', async () => {
    const extra = Array.from({ length: 6 }, (_, i) => ({
      id: `other-${i}`, score: 0.4 - i * 0.01, fields: { text: `other chat ${i}`, chat_jid: `1555000100${i}` },
    }));
    seed([...RECORDS, ...extra]);
    const { knowledgeSearch } = registerTools();

    const ids = await search(knowledgeSearch, dmSession(MEMBER_A));
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(ids[0]).toBe('dm-a');
  });

  it('treats a group of only the owner and bots as a DM lane, and a join ends it', async () => {
    seed();
    let members = [pn(OWNER), BOT_JID, pn(SIBLING)];
    const membership = new GroupMembershipCache(async () => members.map((id) => ({ id })));
    const { knowledgeSearch } = registerTools({ identities: () => identities, membership });
    const siblingSpeaks = groupSession(pn(SIBLING));

    expect(await search(knowledgeSearch, siblingSpeaks)).toEqual([
      'g-own-b', 'g-context', 'g-own-a', 'g-unattributed', 'dm-owner', 'dm-a', 'untagged',
    ]);

    members = [...members, pn(MEMBER_A)];
    membership.invalidate(GROUP_JID);
    expect(await search(knowledgeSearch, siblingSpeaks)).toEqual(['g-context', 'g-unattributed']);
  });

  it('treats the operator instance and a verified admin in a group as unrestricted, group first', async () => {
    seed();
    const expected = ['g-own-b', 'g-context', 'g-own-a', 'g-unattributed', 'dm-owner', 'dm-a', 'untagged'];
    const membership = membershipOf([pn(OWNER), BOT_JID, pn(MEMBER_A)]);
    const withDb = registerTools({ identities: () => identities, membership, db: adminDb() });
    expect(await search(withDb.knowledgeSearch, groupSession(pn(OWNER)))).toEqual(expected);

    configState.botName = 'q';
    const operator = registerTools({ identities: () => identities, membership });
    expect(await search(operator.knowledgeSearch, groupSession(pn(MEMBER_A)))).toEqual(expected);
  });

  it('gives a global session without a conversation the whole instance, untagged last', async () => {
    seed();
    const { knowledgeSearch } = registerTools();

    const ids = await search(knowledgeSearch, { tier: 'global' });
    expect(ids).toHaveLength(7);
    expect(ids.at(-1)).toBe('untagged');
  });

  it('returns nothing from the memory index for a chat session with no conversation', async () => {
    seed();
    const { knowledgeSearch } = registerTools();

    expect(await search(knowledgeSearch, { tier: 'chat-scoped' })).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('keeps tier order after rerank and minScore', async () => {
    seed();
    configState.profile.rerank = true;
    configState.profile.rerankModel = 'test-rerank';
    configState.profile.rerankTopN = 8;
    configState.profile.minScore = 0.2;
    // Rerank scores the untagged record highest and drops one hit below minScore.
    rerankMock.mockImplementation(async ({ documents }: { documents: Array<{ id: string }> }) => ({
      data: documents
        .map((doc, index) => ({ index, score: doc.id === 'untagged' ? 0.99 : doc.id === 'g-own-a' ? 0.1 : 0.5 - index * 0.01 }))
        .sort((a, b) => b.score - a.score),
    }));
    const { knowledgeSearch } = registerTools();

    const ids = await search(knowledgeSearch, dmSession(MEMBER_A));
    expect(rerankMock.mock.calls[0]![0].topN).toBe(7);
    expect(ids).toEqual(['dm-a', 'dm-owner', 'g-own-b', 'g-context', 'g-unattributed', 'untagged']);
  });
});

describe('knowledge_search in configurable groups', () => {
  it('returns this group\'s shared records and the verified sender\'s own, nothing else', async () => {
    seed();
    const { knowledgeSearch } = registerTools({
      identities: () => identities,
      membership: membershipOf([pn(OWNER), BOT_JID, pn(MEMBER_A), pn(MEMBER_B)]),
    });

    expect(await search(knowledgeSearch, groupSession(pn(MEMBER_A)))).toEqual(['g-context', 'g-own-a', 'g-unattributed']);
    for (const query of queries) {
      expect(query.filter).toEqual({ chat_jid: { $in: expect.arrayContaining([GROUP_KEY, GROUP_JID]) } });
    }
  });

  it('fails closed to the group rule when membership cannot be read', async () => {
    seed();
    const { knowledgeSearch } = registerTools({
      identities: () => identities,
      membership: new GroupMembershipCache(async () => { throw new Error('socket down'); }),
    });

    expect(await search(knowledgeSearch, groupSession(pn(SIBLING)))).toEqual(['g-context', 'g-unattributed']);
  });

  it('gives an unverified sender only the shared records', async () => {
    seed();
    const { knowledgeSearch } = registerTools();

    expect(await search(knowledgeSearch, groupSession(`+${MEMBER_A}@sms`))).toEqual(['g-context', 'g-unattributed']);
  });

  it('gives every member all of the group\'s records in a shared-workflow group, still no DMs', async () => {
    seed();
    const { knowledgeSearch } = registerTools({ identities: () => identities, sharedWorkflowGroups: [GROUP_JID] });

    expect(await search(knowledgeSearch, groupSession(pn(MEMBER_A)))).toEqual([
      'g-own-b', 'g-context', 'g-own-a', 'g-unattributed',
    ]);
  });

  it('keeps the boundary under an explicit namespace argument', async () => {
    seed();
    store.set('mw-mind/onedrive', [{ id: 'doc', score: 0.9, fields: { text: 'owner document' } }]);
    const { knowledgeSearch } = registerTools();

    expect(await search(knowledgeSearch, groupSession(pn(MEMBER_A)), { namespace: 'onedrive' })).toEqual([]);
    expect(queries).toEqual([
      { namespace: 'onedrive', filter: { chat_jid: { $in: expect.arrayContaining([GROUP_KEY]) } } },
    ]);
  });
});

// A verified admin needs the lid/phone resolver's database.
function adminDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}
