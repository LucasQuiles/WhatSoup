import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesMetadata } from '../../../helpers/pinecone-metadata.ts';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';

const { state, records, privateRecords, namespaceQueries, namespaceWrites, scores, queries, rerank, settings } = vi.hoisted(() => ({
  state: { ignoreFilters: false, failNamespace: null as string | null, failOnce: false },
  records: new Map<string, Record<string, unknown>>(),
  privateRecords: new Map<string, Record<string, unknown>>(),
  namespaceQueries: [] as string[],
  namespaceWrites: [] as string[],
  scores: new Map<string, number>(),
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
      const failIfInjected = (target: string): void => {
        if (state.failNamespace !== target) return;
        if (state.failOnce) state.failNamespace = null;
        throw new Error('namespace unavailable');
      };
      const namespace = (name: string) => {
        const store = name === '' ? records : privateRecords;
        return {
          upsertRecords: async ({ records: incoming }: { records: Array<Record<string, unknown>> }) => {
            namespaceWrites.push(name);
            failIfInjected(name);
            for (const { _id, ...fields } of incoming) store.set(String(_id), fields);
          },
          deleteMany: async ({ ids }: { ids?: string[] }) => {
            namespaceWrites.push(`delete:${name}`);
            failIfInjected(`delete:${name}`);
            for (const id of ids ?? []) store.delete(id);
          },
          searchRecords: async ({ query }: { query: { filter?: Record<string, unknown>; topK: number } }) => {
            namespaceQueries.push(name);
            queries.push(query.filter ?? {});
            // A score may be set per namespace (`<namespace>:<id>`) or per id.
            return { result: { hits: [...store].filter(([, fields]) =>
              state.ignoreFilters || matchesMetadata(fields, query.filter),
            ).map(([id, fields]) => ({ _id: id, _score: scores.get(`${name}:${id}`) ?? scores.get(id) ?? 0.95, fields }))
              .sort((a, b) => b._score - a._score).slice(0, query.topK) } };
          },
        };
      };
      return { ...namespace(''), namespace };
    }
  },
}));

import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeMemory, type MemoryRecord } from '../../../../src/runtimes/chat/providers/pinecone.ts';
import { runConsolidation } from '../../../../src/memory/consolidation-cron.ts';

function seed(id: string, provenance: Record<string, unknown> = {}, namespace = '') {
  const store = namespace === '' ? records : privateRecords;
  store.set(id, {
    text: id, claim: id, evidence: 'stated preference', confidence: 0.9,
    chat_jid: 'test-chat', sender_jid: 'test-contact', memory_type: 'user_fact',
    created_at: new Date().toISOString(), source: 'business',
    visibility: 'chat_scoped', ...provenance,
  });
}

const own = { source_instance: 'test-line', source_account: 'scope:account-b' };
const reservedNamespace = 'whatsoup-owner-only-v1';

beforeEach(() => {
  records.clear();
  privateRecords.clear();
  namespaceQueries.length = 0;
  namespaceWrites.length = 0;
  scores.clear();
  queries.length = 0;
  state.ignoreFilters = false;
  state.failNamespace = null;
  state.failOnce = false;
  settings.accountScopeId = 'scope:account-b';
  settings.memory.pinecone.instanceScopedIds = true;
  settings.memory.pinecone.recordVisibility = 'chat_scoped';
  settings.pineconeRerank = false;
  settings.pineconeContextTopK = 20;
  settings.pineconeSenderTopK = 20;
  settings.pineconeSelfFactTopK = 20;
  rerank.mockReset();
  vi.stubEnv('TEST_BOUNDARY_KEY', 'test-key');
});

afterEach(() => vi.unstubAllEnvs());

describe('owner-only namespace compatibility fence', () => {
  const ownerOptions = { includeOwnerOnly: true, ownerOnlySources: new Set(['test-line']) };

  function record(id: string, visibility?: MemoryRecord['visibility']): MemoryRecord {
    return {
      id, text: id, chatJid: 'test-chat', senderJid: 'test-contact', senderName: '',
      memoryType: 'self_fact', confidence: 0.9, createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z', superseded: '', sourceMessagePks: '',
      ...(visibility ? { visibility } : {}),
    };
  }

  function seedPrivate(id: string, score = 0.95) {
    seed(id, { ...own, visibility: 'owner_only', memory_type: 'self_fact' }, reservedNamespace);
    scores.set(id, score);
  }

  it('keeps new private writes invisible to an unfiltered old reader, including after reader rollback', async () => {
    const memory = new PineconeMemory();
    settings.memory.pinecone.recordVisibility = 'owner_only';
    await memory.upsert([record('private configured', 'chat_scoped')]);
    settings.memory.pinecone.recordVisibility = 'chat_scoped';
    await memory.upsert([record('shared'), record('private derived', 'owner_only')]);

    const oldReader = new Pinecone({ apiKey: 'test-key' }).index('test-index');
    const response = await oldReader.searchRecords({ query: { topK: 20, inputs: { text: 'query' } }, fields: ['*'] });
    expect(response.result.hits?.map((hit) => hit._id)).toEqual(['shared']);
    expect([...records.keys()]).toEqual(['shared']);
    expect(records.get('shared')).toMatchObject({ visibility: 'chat_scoped' });
    expect([...privateRecords.keys()]).toEqual(['private configured', 'private derived']);
    expect([...privateRecords.values()].every((fields) => fields.visibility === 'owner_only')).toBe(true);
    expect(namespaceWrites).toEqual([reservedNamespace, 'delete:', '', reservedNamespace, 'delete:']);
  });

  it('keeps old writer records excluded from non-owner recall while admitted recall reaches fenced records', async () => {
    records.set('legacy', { text: 'legacy', chat_jid: 'test-chat', memory_type: 'self_fact' });
    seedPrivate('private');
    const memory = new PineconeMemory();
    const nonOwner = await memory.searchForChatDetailed('test-chat', 'query');
    expect(nonOwner.status).toBe('ok');
    expect(nonOwner.results).toEqual([]);
    expect(namespaceQueries).toEqual(['']);

    namespaceQueries.length = 0;
    const owner = await memory.searchOwnerOnlyDetailed('query', undefined, ownerOptions);
    expect(owner.results.map((hit) => hit.id)).toEqual(['private']);
    expect(namespaceQueries).toEqual([reservedNamespace]);
  });

  it.each(['chat', 'sender', 'self'] as const)('merges admitted %s recall by score and caps the combined topK', async (leg) => {
    seed('shared high', { ...own, memory_type: 'self_fact' });
    seed('shared low', { ...own, memory_type: 'self_fact' });
    scores.set('shared high', 0.99);
    scores.set('shared low', 0.7);
    seedPrivate('private high', 0.98);
    seedPrivate('private low', 0.6);
    settings.pineconeContextTopK = 2;
    settings.pineconeSenderTopK = 2;
    settings.pineconeSelfFactTopK = 2;
    const memory = new PineconeMemory();
    const result = leg === 'chat'
      ? await memory.searchForChatDetailed('test-chat', 'query', undefined, ownerOptions)
      : leg === 'sender'
        ? await memory.searchForSenderDetailed('test-contact', 'query', undefined, ownerOptions)
        : await memory.searchSelfFactsDetailed('query', undefined, ownerOptions);
    expect(result.status).toBe('ok');
    expect(result.results.map((hit) => hit.id)).toEqual(['shared high', 'private high']);
    expect(namespaceQueries).toEqual(['', reservedNamespace]);
    expect(queries[0]).toEqual(queries[1]);
  });

  it('queries only the fence for the owner-only leg and post-filters unlisted sources', async () => {
    state.ignoreFilters = true;
    seedPrivate('private');
    seedPrivate('foreign');
    privateRecords.get('foreign')!.source_instance = 'other-line';
    seed('shared', own);
    const result = await new PineconeMemory().searchOwnerOnlyDetailed('query', undefined, ownerOptions);
    expect(result.results.map((hit) => hit.id)).toEqual(['private']);
    expect(namespaceQueries).toEqual([reservedNamespace]);
  });

  it('retries a failed reserved upsert and rejects the mixed batch without reporting success', async () => {
    state.failNamespace = reservedNamespace;
    await expect(new PineconeMemory().upsert([record('shared'), record('private', 'owner_only')]))
      .rejects.toMatchObject({ code: 'PINECONE_UNAVAILABLE', message: 'Pinecone upsert failed' });
    expect(namespaceWrites.filter((name) => name === reservedNamespace)).toHaveLength(2);
    expect([...records.keys()]).toEqual(['shared']);
    expect(privateRecords.size).toBe(0);
  });

  it('routes writer lookups to both namespaces only when the writer is owner_only', async () => {
    seedPrivate('private');
    const memory = new PineconeMemory();
    expect(await memory.checkDuplicate('test-chat', 'test-contact', 'query', 0.8)).toEqual({ isDuplicate: false });
    expect(await memory.searchClaims('test-chat', 'test-contact', 'query')).toEqual([]);
    expect(await memory.findSupersedeCandidate('test-chat', 'query')).toBeNull();
    expect((await memory.searchEntitiesDetailed('query')).results).toEqual([]);
    expect(namespaceQueries).toEqual(['', '', '', '']);

    namespaceQueries.length = 0;
    settings.memory.pinecone.recordVisibility = 'owner_only';
    expect(await memory.checkDuplicate('test-chat', 'test-contact', 'query', 0.8))
      .toMatchObject({ isDuplicate: true, existingId: 'private' });
    expect((await memory.searchClaims('test-chat', 'test-contact', 'query')).map((hit) => hit.id)).toEqual(['private']);
    expect((await memory.findSupersedeCandidate('test-chat', 'query'))?.id).toBe('private');
    expect(namespaceQueries).toEqual(['', reservedNamespace, '', reservedNamespace, '', reservedNamespace]);
  });

  it('writes a superseded owner_only marker back into its reserved namespace', async () => {
    seedPrivate('private');
    settings.memory.pinecone.recordVisibility = 'owner_only';
    const memory = new PineconeMemory();
    const candidate = await memory.findSupersedeCandidate('test-chat', 'query');
    expect(candidate?.id).toBe('private');
    await memory.upsert([{ ...candidate!.record, superseded: 'replacement', memoryType: 'correction' }], { provenance: 'fact_export' });
    expect(privateRecords.get('private')).toMatchObject({ visibility: 'owner_only', superseded: 'replacement' });
    expect(records.has('private')).toBe(false);
    expect(namespaceWrites).toEqual([reservedNamespace, 'delete:']);
  });

  // A correction rewrites the old record under its own id, and an owner_only
  // writer narrows it to owner_only. The rewrite lands in the reserved
  // namespace, so the shared copy must leave the default namespace or its
  // stale text stays visible to every reader there, old releases included.
  it('moves a shared record that an owner_only correction narrows out of the default namespace', async () => {
    seed('shared fact', own);
    settings.memory.pinecone.recordVisibility = 'owner_only';
    const memory = new PineconeMemory();
    const candidate = await memory.findSupersedeCandidate('test-chat', 'query');
    expect(candidate?.id).toBe('shared fact');
    await memory.upsert([{
      ...candidate!.record, text: 'was: shared fact, now: private update', memoryType: 'correction', superseded: 'private update',
    }], { provenance: 'fact_export' });
    expect(privateRecords.get('shared fact')).toMatchObject({ visibility: 'owner_only', superseded: 'private update' });
    expect(records.has('shared fact')).toBe(false);
    expect(namespaceWrites).toEqual([reservedNamespace, 'delete:']);
  });

  it.each([
    ['the reserved write', reservedNamespace, [reservedNamespace, reservedNamespace]],
    ['the default-copy delete', 'delete:', [reservedNamespace, 'delete:', reservedNamespace, 'delete:']],
  ])('reports a failed move as a failed write when %s fails, and never deletes first', async (_case, failing, writes) => {
    seed('shared fact', own);
    settings.memory.pinecone.recordVisibility = 'owner_only';
    state.failNamespace = failing;
    const memory = new PineconeMemory();
    const candidate = (await memory.findSupersedeCandidate('test-chat', 'query'))!;
    await expect(memory.upsert([{ ...candidate.record, memoryType: 'correction', superseded: 'private update' }], {
      provenance: 'fact_export',
    })).rejects.toMatchObject({ code: 'PINECONE_UNAVAILABLE' });
    // The shared copy keeps its shared text: no private content reaches the default namespace.
    expect(records.get('shared fact')).toMatchObject({ text: 'shared fact', visibility: 'chat_scoped' });
    expect(records.get('shared fact')).not.toHaveProperty('superseded');
    expect(namespaceWrites).toEqual(writes);
  });

  it('a chat_scoped write issues no delete', async () => {
    await new PineconeMemory().upsert([record('shared')]);
    expect(namespaceWrites).toEqual(['']);
  });

  it('a move whose delete fails once succeeds on the retry and leaves only the reserved copy', async () => {
    seed('shared fact', own);
    settings.memory.pinecone.recordVisibility = 'owner_only';
    state.failNamespace = 'delete:';
    state.failOnce = true;
    const memory = new PineconeMemory();
    const candidate = (await memory.findSupersedeCandidate('test-chat', 'query'))!;
    await memory.upsert([{ ...candidate.record, memoryType: 'correction', superseded: 'private update' }], {
      provenance: 'fact_export',
    });
    expect(records.has('shared fact')).toBe(false);
    expect(privateRecords.get('shared fact')).toMatchObject({ visibility: 'owner_only', superseded: 'private update' });
    expect(namespaceWrites).toEqual([reservedNamespace, 'delete:', reservedNamespace, 'delete:']);
  });

  // A move interrupted after the reserved write leaves one id in both
  // namespaces until a later write deletes the shared copy. Merged reads must
  // keep only the reserved copy: it is the narrowed, newer version, and a
  // later duplicate must never relabel it chat_scoped.
  function seedPartialMove() {
    seed('moved', { ...own, text: 'shared original' });
    seed('moved', { ...own, visibility: 'owner_only', text: 'private correction' }, reservedNamespace);
    scores.set(`${reservedNamespace}:moved`, 0.99);
    scores.set(':moved', 0.5);
  }

  it('admitted recall keeps only the reserved copy of an id found in both namespaces', async () => {
    seedPartialMove();
    const result = await new PineconeMemory().searchForChatDetailed('test-chat', 'query', undefined, ownerOptions);
    expect(result.results.map((hit) => [hit.id, hit.record.text, hit.record.visibility])).toEqual([
      ['moved', 'private correction', 'owner_only'],
    ]);
  });

  it('consolidation promotes the reserved copy of an id found in both namespaces, as owner_only', async () => {
    seedPartialMove();
    const result = await runConsolidation(new PineconeMemory(), consolidationProvider(), {
      instanceScope: 'test-line', lookbackDays: 7, dryRun: false,
    });
    expect(result.status).toBe('completed');
    const durable = (store: Map<string, Record<string, unknown>>) =>
      [...store].filter(([id]) => id.startsWith('durable:')).map(([, fields]) => [fields.text, fields.visibility]);
    expect(durable(records)).toEqual([]);
    expect(durable(privateRecords)).toEqual([['private correction', 'owner_only']]);
  });

  it('entity recall for an admitted owner merges reserved records by score', async () => {
    seed('shared entity', own);
    scores.set('shared entity', 0.9);
    seedPrivate('private entity', 0.95);
    const owner = await new PineconeMemory().searchEntitiesDetailed('query', undefined, ownerOptions);
    expect(owner.results.map((hit) => hit.id)).toEqual(['private entity', 'shared entity']);
    expect(namespaceQueries).toEqual(['', reservedNamespace]);
  });

  it('the owner-only leg queries nothing without an explicit grant', async () => {
    seedPrivate('private');
    const result = await new PineconeMemory().searchOwnerOnlyDetailed('query');
    expect(result.results).toEqual([]);
    expect(namespaceQueries).toEqual([]);
  });

  // Without instanceScopedIds, consolidation cannot tell whose an owner_only
  // record is, and a promotion carries this writer's identity: it must never
  // read the reserved namespace, or another line's private text would become
  // recallable as this instance's own.
  it('unscoped consolidation never reads the reserved namespace', async () => {
    settings.memory.pinecone.instanceScopedIds = false;
    seed('shared content', own);
    seed('foreign private', {
      source_instance: 'other-line', source_account: 'scope:account-a', visibility: 'owner_only',
    }, reservedNamespace);
    const result = await runConsolidation(new PineconeMemory(), consolidationProvider(), {
      instanceScope: null, lookbackDays: 7, dryRun: false,
    });
    expect(result.status).toBe('completed');
    expect(namespaceQueries).not.toContain(reservedNamespace);
    const promoted = [...records, ...privateRecords].filter(([id]) => id.startsWith('durable:')).map(([, fields]) => fields.text);
    expect(promoted).toEqual(['shared content']);
  });
});

function consolidationProvider(): LLMProvider {
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
    // A chat_scoped writer: its owner_only records (derived from owner_only
    // inputs) live in the reserved namespace and must still be consolidated.
    seed('previous account content', { ...own, source_account: 'scope:account-a' });
    seed('other instance content', { ...own, source_instance: 'other-line' });
    seed('unstamped content');
    seed('missing account content', { source_instance: 'test-line' });
    seed('current account content', own);
    seed('private current content', { ...own, visibility: 'owner_only' }, reservedNamespace);
    const result = await runConsolidation(new PineconeMemory(), provider(), {
      instanceScope: 'test-line', lookbackDays: 7, dryRun: false,
    });
    const promoted = [...records, ...privateRecords].filter(([id]) => id.startsWith('durable:')).map(([, fields]) => fields);
    expect(result.status).toBe('completed');
    expect(promoted).toHaveLength(2);
    expect(promoted.map((fields) => fields.text).sort()).toEqual(['current account content', 'private current content']);
    for (const fields of promoted) {
      expect(fields).toMatchObject({ ...own, provenance: 'consolidation' });
      expect(fields.visibility).toBe(fields.text === 'private current content' ? 'owner_only' : 'chat_scoped');
    }
    // Each promotion lands in its own namespace.
    const promotedIn = (store: Map<string, Record<string, unknown>>) =>
      [...store].filter(([id]) => id.startsWith('durable:')).map(([, fields]) => fields.text);
    expect(promotedIn(records)).toEqual(['current account content']);
    expect(promotedIn(privateRecords)).toEqual(['private current content']);
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
    seed('listed private', { source_instance: 'listed-line', source_account: 'scope:account-a', visibility: 'owner_only' }, reservedNamespace);
    seed('unlisted private', { source_instance: 'unlisted-line', source_account: 'scope:account-a', visibility: 'owner_only' }, reservedNamespace);
    seed('foreign public', { ...own, source_account: 'scope:account-a' });
    seed('legacy');
    const result = await new PineconeMemory().searchForChatDetailed('test-chat', 'query', undefined, {
      includeOwnerOnly: true, ownerOnlySources: new Set(['test-line', 'listed-line']),
    });
    expect(result.results.map((hit) => hit.id).sort()).toEqual(['legacy', 'listed private']);
    expect([...records, ...privateRecords].filter(([, fields]) => matchesMetadata(fields, queries[0])).map(([id]) => id).sort())
      .toEqual(['legacy', 'listed private']);
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
