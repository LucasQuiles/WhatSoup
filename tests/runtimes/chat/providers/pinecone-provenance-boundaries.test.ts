import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesMetadata } from '../../../helpers/pinecone-metadata.ts';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';

const { state, records, queries, rerank, settings } = vi.hoisted(() => ({
  state: { ignoreFilters: false },
  records: new Map<string, Record<string, unknown>>(),
  queries: [] as Array<Record<string, unknown>>,
  rerank: vi.fn(),
  settings: {
    botName: 'test-line', accountScopeId: 'scope:account-b',
    pineconeIndex: 'test-index', pineconeTopK: 20, pineconeContextTopK: 20,
    pineconeSenderTopK: 20, pineconeSelfFactTopK: 20, pineconeRerank: false,
    recencyHalfLifeDays: 36500, maxAgeDays: 36500,
    models: { validation: 'test-model' },
    // A non-operator instance needs a passing project guard, or every read and write is refused.
    memory: { pinecone: {
      apiKeyEnv: 'TEST_BOUNDARY_KEY', projectId: 'testproj', instanceScopedIds: true, recordVisibility: 'chat_scoped',
    } },
  },
}));

vi.mock('../../../../src/config.ts', () => ({ config: settings }));
vi.mock('../../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../../helpers/logger-mock.ts');
  return loggerMock();
});
vi.mock('../../../../src/lib/keyring.ts', () => ({ lookupCredential: () => null }));
vi.mock('@pinecone-database/pinecone', () => ({
  Pinecone: class {
    inference = { rerank };
    async listIndexes() {
      return { indexes: [{ name: 'test-index', host: 'test-index-testproj.svc.example.pinecone.io' }] };
    }
    index() {
      return {
        upsertRecords: async ({ records: incoming }: { records: Array<Record<string, unknown>> }) => {
          for (const { _id, ...fields } of incoming) records.set(String(_id), fields);
        },
        searchRecords: async ({ query }: { query: { filter?: Record<string, unknown>; topK: number } }) => {
          queries.push(query.filter ?? {});
          return { result: { hits: [...records].filter(([, fields]) =>
            state.ignoreFilters || matchesMetadata(fields, query.filter),
          ).slice(0, query.topK).map(([id, fields]) => ({ _id: id, _score: 0.95, fields })) } };
        },
      };
    }
  },
}));

import { PineconeMemory } from '../../../../src/runtimes/chat/providers/pinecone.ts';
import { runConsolidation } from '../../../../src/memory/consolidation-cron.ts';

function seed(id: string, provenance: Record<string, unknown> = {}) {
  records.set(id, {
    text: id, claim: id, evidence: 'stated preference', confidence: 0.9,
    chat_jid: 'test-chat', sender_jid: 'test-contact', memory_type: 'user_fact',
    created_at: new Date().toISOString(), source: 'business',
    visibility: 'chat_scoped', ...provenance,
  });
}

const own = { source_instance: 'test-line', source_account: 'scope:account-b' };

beforeEach(() => {
  records.clear();
  queries.length = 0;
  state.ignoreFilters = false;
  settings.accountScopeId = 'scope:account-b';
  settings.memory.pinecone.instanceScopedIds = true;
  settings.memory.pinecone.recordVisibility = 'chat_scoped';
  settings.pineconeRerank = false;
  rerank.mockReset();
  vi.stubEnv('TEST_BOUNDARY_KEY', 'test-key');
});

afterEach(() => vi.unstubAllEnvs());

describe('consolidation provenance boundary', () => {
  function provider(): LLMProvider {
    return {
      name: 'fixture',
      generate: vi.fn(async (request) => {
        const input = JSON.parse(String(request.messages[0]!.content)) as { records: Array<{ id: string; text: string }> };
        return {
          content: JSON.stringify({ durableKnowledge: input.records.map((record) => ({
            claim: record.text, sourceRecordIds: [record.id], confidence: 0.9, promotionReason: 'stable preference',
          })), discarded: [] }),
          inputTokens: 1, outputTokens: 1, model: 'fixture', durationMs: 1,
        };
      }),
    };
  }

  it.each([false, true])('never promotes foreign or unstamped content (provider ignores filters: %s)', async (ignoreFilters) => {
    state.ignoreFilters = ignoreFilters;
    seed('previous account content', { ...own, source_account: 'scope:account-a' });
    seed('other instance content', { ...own, source_instance: 'other-line' });
    seed('unstamped content');
    seed('missing account content', { source_instance: 'test-line' });
    seed('current account content', own);
    seed('private current content', { ...own, visibility: 'owner_only' });
    const result = await runConsolidation(new PineconeMemory(), provider(), {
      instanceScope: 'test-line', lookbackDays: 7, dryRun: false,
    });
    const promoted = [...records].filter(([id]) => id.startsWith('durable:')).map(([, fields]) => fields);
    expect(result.status).toBe('completed');
    expect(promoted).toHaveLength(2);
    expect(promoted.map((fields) => fields.text).sort()).toEqual(['current account content', 'private current content']);
    for (const fields of promoted) {
      expect(fields).toMatchObject({ ...own, provenance: 'consolidation' });
      expect(fields.visibility).toBe(fields.text === 'private current content' ? 'owner_only' : 'chat_scoped');
    }
    expect(queries[0]).toMatchObject({ source_instance: { $eq: 'test-line' }, source_account: { $eq: 'scope:account-b' } });
  });

  it('does no work when the writer account is unknown', async () => {
    settings.accountScopeId = '';
    seed('unstamped content');
    const llm = provider();
    const result = await runConsolidation(new PineconeMemory(), llm, { instanceScope: 'test-line', lookbackDays: 7, dryRun: false });
    expect(result.status).toBe('no_work');
    expect(queries).toEqual([]);
    expect(llm.generate).not.toHaveBeenCalled();
    expect([...records.keys()]).toEqual(['unstamped content']);
  });

  it('refuses promotion after the writer changes accounts during generation', async () => {
    seed('current account content', own);
    const llm = provider();
    const generate = llm.generate;
    llm.generate = async (request) => {
      const result = await generate(request);
      settings.accountScopeId = 'scope:account-c';
      return result;
    };
    const result = await runConsolidation(new PineconeMemory(), llm, { instanceScope: 'test-line', lookbackDays: 7, dryRun: false });
    expect(result.counters.writeConfirmed).toBe(0);
    expect([...records.keys()]).toEqual(['current account content']);
  });

  it('preserves chat_scoped inputs after the writer visibility becomes owner_only', async () => {
    settings.memory.pinecone.recordVisibility = 'owner_only';
    seed('current account content', own);
    await runConsolidation(new PineconeMemory(), provider(), { instanceScope: 'test-line', lookbackDays: 7, dryRun: false });
    const promoted = [...records].filter(([id]) => id.startsWith('durable:'));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]![1]).toMatchObject({ ...own, visibility: 'chat_scoped' });
  });
});

describe('supersede provenance boundary', () => {
  it.each([false, true])('rejects another account and keeps legacy records correctable (instanceScopedIds: %s)', async (enabled) => {
    settings.memory.pinecone.instanceScopedIds = enabled;
    seed('foreign account', { ...own, source_account: 'scope:account-a' });
    seed('foreign instance', { ...own, source_instance: 'other-line' });
    seed('legacy candidate');
    seed('own candidate', own);
    const memory = new PineconeMemory();
    expect((await memory.findSupersedeCandidate('test-chat', 'correction'))?.id).toBe('legacy candidate');
    records.delete('legacy candidate');
    expect((await memory.findSupersedeCandidate('test-chat', 'correction'))?.id).toBe('own candidate');
    records.delete('own candidate');
    state.ignoreFilters = true;
    expect(await memory.findSupersedeCandidate('test-chat', 'correction')).toBeNull();
  });
});

describe('provider recall source boundary', () => {
  it('owner query admits foreign accounts only as owner_only records from listed sources', async () => {
    state.ignoreFilters = true;
    seed('listed private', { source_instance: 'listed-line', source_account: 'scope:account-a', visibility: 'owner_only' });
    seed('unlisted private', { source_instance: 'unlisted-line', source_account: 'scope:account-a', visibility: 'owner_only' });
    seed('foreign public', { ...own, source_account: 'scope:account-a' });
    seed('legacy');
    const result = await new PineconeMemory().searchForChatDetailed('test-chat', 'query', undefined, {
      includeOwnerOnly: true, ownerOnlySources: new Set(['test-line', 'listed-line']),
    });
    expect(result.results.map((hit) => hit.id).sort()).toEqual(['legacy', 'listed private']);
    expect([...records].filter(([, fields]) => matchesMetadata(fields, queries[0])).map(([id]) => id))
      .toEqual(['listed private', 'legacy']);
  });

  it.each([false, true])('gates every memory leg before returning results (provider ignores filters: %s)', async (ignoreFilters) => {
    state.ignoreFilters = ignoreFilters;
    seed('foreign', { ...own, source_account: 'scope:account-a', memory_type: 'self_fact' });
    seed('unstamped', { memory_type: 'self_fact' });
    seed('own', { ...own, memory_type: 'self_fact' });
    const memory = new PineconeMemory();
    for (const result of [
      await memory.searchForChatDetailed('test-chat', 'query'),
      await memory.searchForSenderDetailed('test-contact', 'query'),
      await memory.searchSelfFactsDetailed('query'),
    ]) expect(result.results.map((hit) => hit.id)).toEqual(['own']);
    expect(queries).toHaveLength(3);
    for (const filter of queries) {
      expect(matchesMetadata(records.get('own')!, filter)).toBe(true);
      expect(matchesMetadata(records.get('foreign')!, filter)).toBe(false);
      expect(matchesMetadata(records.get('unstamped')!, filter)).toBe(false);
    }
  });

  it('entity search excludes other-account records before rerank and retains unstamped business entities', async () => {
    state.ignoreFilters = true;
    settings.pineconeRerank = true;
    records.set('business', { text: 'business entity', entity_type: 'company', source: 'business' });
    records.set('foreign', { text: 'foreign entity', entity_type: 'company', source: 'business', ...own, source_account: 'scope:account-a' });
    rerank.mockResolvedValue({ data: [{ index: 0, score: 0.9 }] });
    const result = await new PineconeMemory().searchEntitiesDetailed('query');
    expect(result.results.map((hit) => hit.id)).toEqual(['business']);
    expect(JSON.stringify(rerank.mock.calls[0])).not.toContain('foreign entity');
    expect(matchesMetadata(records.get('business')!, queries[0])).toBe(true);
    expect(matchesMetadata(records.get('foreign')!, queries[0])).toBe(false);
  });
});
