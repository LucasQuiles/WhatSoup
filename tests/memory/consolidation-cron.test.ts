import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

const mockCronLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => mockCronLogger,
}));

import { runConsolidation } from '../../src/memory/consolidation-cron.ts';

describe('runConsolidation', () => {
  function makeMockPinecone(searchResults: any[] = []) {
    return {
      search: vi.fn().mockResolvedValue(searchResults),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeMockProvider(consolidationResponse: any) {
    return {
      name: 'test-provider',
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify(consolidationResponse),
        inputTokens: 100,
        outputTokens: 50,
        model: 'test',
        durationMs: 100,
      }),
    };
  }

  it('fetches, clusters, consolidates, and upserts', async () => {
    const mockPinecone = makeMockPinecone([
      {
        id: 'rec-1',
        score: 0.9,
        record: {
          id: 'rec-1',
          text: 'Lives in London',
          claim: 'Lives in London',
          evidence: 'Said so',
          createdAt: new Date().toISOString(),
          confidence: 0.9,
          chatJid: 'chat-1@g.us',
          senderJid: 'sender-1@s.whatsapp.net',
        },
      },
    ]);

    const mockProvider = makeMockProvider({
      durableKnowledge: [{
        claim: 'User lives in London',
        promotionReason: 'Consistent across sessions',
        confidence: 0.92,
        sourceRecordIds: ['rec-1'],
      }],
      discarded: [],
    });

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result.promoted).toBe(1);
    expect(result.clustersProcessed).toBe(1);
    expect(mockPinecone.upsert).toHaveBeenCalledTimes(1);
    expect(mockPinecone.search).toHaveBeenCalledWith(
      'facts about people preferences locations interests',
      {},
      100,
    );
  });

  it('respects dryRun by counting but not upserting', async () => {
    const mockPinecone = makeMockPinecone([
      {
        id: 'rec-1',
        score: 0.9,
        record: {
          id: 'rec-1',
          text: 'Test',
          claim: 'Test',
          evidence: '',
          createdAt: new Date().toISOString(),
          confidence: 0.9,
          chatJid: 'chat-1@g.us',
          senderJid: 'sender-1@s.whatsapp.net',
        },
      },
    ]);

    const mockProvider = makeMockProvider({
      durableKnowledge: [{ claim: 'Test claim', promotionReason: 'test', confidence: 0.9, sourceRecordIds: ['rec-1'] }],
      discarded: [],
    });

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: true },
    );

    expect(result.promoted).toBe(1);
    expect(mockPinecone.upsert).not.toHaveBeenCalled();
  });

  it('returns zero counts for empty search results', async () => {
    const mockPinecone = makeMockPinecone([]);
    const mockProvider = { name: 'test', generate: vi.fn() };

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result.promoted).toBe(0);
    expect(result.clustersProcessed).toBe(0);
    expect(mockProvider.generate).not.toHaveBeenCalled();
  });

  it('skips unscoped memories without invoking the provider', async () => {
    const mockPinecone = makeMockPinecone([
      {
        id: 'missing-chat',
        score: 0.9,
        record: {
          id: 'missing-chat',
          text: 'Likes espresso',
          claim: 'Likes espresso',
          evidence: 'mentioned once',
          createdAt: new Date().toISOString(),
          confidence: 0.8,
          senderJid: 'sender-1@s.whatsapp.net',
        },
      },
      {
        id: 'missing-sender',
        score: 0.8,
        record: {
          id: 'missing-sender',
          text: 'Lives in London',
          claim: 'Lives in London',
          evidence: 'mentioned once',
          createdAt: new Date().toISOString(),
          confidence: 0.7,
          chatJid: 'chat-1@g.us',
        },
      },
    ]);
    const mockProvider = { name: 'test', generate: vi.fn() };

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result).toEqual({
      promoted: 0,
      discarded: 0,
      clustersProcessed: 0,
      errors: 0,
    });
    expect(mockProvider.generate).not.toHaveBeenCalled();
    expect(mockPinecone.upsert).not.toHaveBeenCalled();
    expect(mockCronLogger.info).toHaveBeenCalledWith(
      { recordCount: 2, unscopedSkipped: 2 },
      'No scoped memories to consolidate',
    );
  });

  it('handles search failure gracefully', async () => {
    const mockPinecone = {
      search: vi.fn().mockRejectedValue(new Error('Pinecone down')),
      upsert: vi.fn(),
    };
    const mockProvider = { name: 'test', generate: vi.fn() };

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result.errors).toBe(1);
    expect(result.promoted).toBe(0);
  });

  it('continues when a cluster yields only discarded memories', async () => {
    const mockPinecone = makeMockPinecone([
      {
        id: 'transient',
        score: 0.9,
        record: {
          id: 'transient',
          text: 'Meeting at 3pm today',
          claim: 'Meeting at 3pm today',
          evidence: 'single time-bound mention',
          createdAt: new Date().toISOString(),
          confidence: 0.9,
          chatJid: 'chat-1@g.us',
          senderJid: 'sender-1@s.whatsapp.net',
        },
      },
    ]);
    const mockProvider = makeMockProvider({
      durableKnowledge: [],
      discarded: [{ recordId: 'transient', reason: 'time-bound' }],
    });

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result).toEqual({
      promoted: 0,
      discarded: 1,
      clustersProcessed: 1,
      errors: 0,
    });
    expect(mockPinecone.upsert).not.toHaveBeenCalled();
  });

  it('normalizes missing optional claim and evidence fields before provider consolidation', async () => {
    const mockPinecone = makeMockPinecone([
      {
        id: 'text-only',
        score: 0.9,
        record: {
          id: 'text-only',
          text: 'The user prefers early calls',
          createdAt: new Date().toISOString(),
          confidence: 0.8,
          chatJid: 'chat-1@g.us',
          senderJid: 'sender-1@s.whatsapp.net',
        },
      },
    ]);
    const mockProvider = makeMockProvider({
      durableKnowledge: [],
      discarded: [],
    });

    await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    const request = mockProvider.generate.mock.calls[0][0];
    const clusterPayload = JSON.parse(request.messages[0].content);
    expect(clusterPayload.records[0]).toMatchObject({
      id: 'text-only',
      // A missing claim is backfilled from text at payload build (consolidation.ts
      // `claim: r.claim || r.text`), not left empty.
      claim: 'The user prefers early calls',
      text: 'The user prefers early calls',
      confidence: 0.8,
    });
  });

  it('continues after a durable upsert fails for one cluster', async () => {
    const mockPinecone = makeMockPinecone([
      {
        id: 'coffee',
        score: 0.9,
        record: {
          id: 'coffee',
          text: 'Likes coffee',
          claim: 'Likes coffee',
          evidence: '',
          createdAt: new Date().toISOString(),
          confidence: 0.9,
          chatJid: 'chat-a@g.us',
          senderJid: 'sender-a@s.whatsapp.net',
        },
      },
      {
        id: 'tea',
        score: 0.8,
        record: {
          id: 'tea',
          text: 'Likes tea',
          claim: 'Likes tea',
          evidence: '',
          createdAt: new Date().toISOString(),
          confidence: 0.8,
          chatJid: 'chat-b@g.us',
          senderJid: 'sender-b@s.whatsapp.net',
        },
      },
    ]);
    mockPinecone.upsert
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce(undefined);
    const mockProvider = {
      name: 'test-provider',
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: JSON.stringify({
            durableKnowledge: [{ claim: 'User likes coffee', promotionReason: 'consistent', confidence: 0.9, sourceRecordIds: ['coffee'] }],
            discarded: [],
          }),
          inputTokens: 100,
          outputTokens: 50,
          model: 'test',
          durationMs: 100,
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            durableKnowledge: [{ claim: 'User likes tea', promotionReason: 'consistent', confidence: 0.9, sourceRecordIds: ['tea'] }],
            discarded: [],
          }),
          inputTokens: 100,
          outputTokens: 50,
          model: 'test',
          durationMs: 100,
        }),
    };

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result).toEqual({
      promoted: 1,
      discarded: 0,
      clustersProcessed: 2,
      errors: 1,
    });
    expect(mockProvider.generate).toHaveBeenCalledTimes(2);
    expect(mockPinecone.upsert).toHaveBeenCalledTimes(2);
  });

  it('filters out memories older than lookbackDays client-side', async () => {
    const now = new Date();
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const tenDaysAgo = new Date(now);
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

    const mockPinecone = makeMockPinecone([
      {
        id: 'recent',
        score: 0.9,
        record: { id: 'recent', text: 'Recent fact', claim: 'Recent', evidence: '', createdAt: threeDaysAgo.toISOString(), confidence: 0.9, chatJid: 'chat-1@g.us', senderJid: 'sender-1@s.whatsapp.net' },
      },
      {
        id: 'old',
        score: 0.8,
        record: { id: 'old', text: 'Old fact', claim: 'Old', evidence: '', createdAt: tenDaysAgo.toISOString(), confidence: 0.8, chatJid: 'chat-1@g.us', senderJid: 'sender-1@s.whatsapp.net' },
      },
    ]);

    const mockProvider = makeMockProvider({
      durableKnowledge: [{ claim: 'Recent consolidated', promotionReason: 'test', confidence: 0.9, sourceRecordIds: ['recent'] }],
      discarded: [],
    });

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result.clustersProcessed).toBe(1);
    expect(result.promoted).toBe(1);
  });

  it('consolidates each chat and sender scope independently', async () => {
    const mockPinecone = makeMockPinecone([
      {
        id: 'rec-1',
        score: 0.9,
        record: {
          id: 'rec-1',
          text: 'Likes coffee',
          claim: 'Likes coffee',
          evidence: '',
          createdAt: new Date().toISOString(),
          confidence: 0.9,
          chatJid: 'chat-a@g.us',
          senderJid: 'sender-x@s.whatsapp.net',
        },
      },
      {
        id: 'rec-2',
        score: 0.8,
        record: {
          id: 'rec-2',
          text: 'Likes coffee',
          claim: 'Likes coffee',
          evidence: '',
          createdAt: new Date().toISOString(),
          confidence: 0.8,
          chatJid: 'chat-b@g.us',
          senderJid: 'sender-y@s.whatsapp.net',
        },
      },
    ]);

    const mockProvider = {
      name: 'test-provider',
      generate: vi.fn()
        .mockResolvedValueOnce({
          content: JSON.stringify({
            durableKnowledge: [{
              claim: 'User likes coffee',
              promotionReason: 'Consistent',
              confidence: 0.92,
              sourceRecordIds: ['rec-1'],
            }],
            discarded: [],
          }),
          inputTokens: 100,
          outputTokens: 50,
          model: 'test',
          durationMs: 100,
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            durableKnowledge: [{
              claim: 'User likes coffee',
              promotionReason: 'Consistent',
              confidence: 0.91,
              sourceRecordIds: ['rec-2'],
            }],
            discarded: [],
          }),
          inputTokens: 100,
          outputTokens: 50,
          model: 'test',
          durationMs: 100,
        }),
    };

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result.promoted).toBe(2);
    expect(result.clustersProcessed).toBe(2);
    expect(mockProvider.generate).toHaveBeenCalledTimes(2);
    const upsertedRecords = mockPinecone.upsert.mock.calls.map((call) => call[0][0]);
    expect(upsertedRecords.map((r) => [r.chatJid, r.senderJid])).toEqual([
      ['chat-a@g.us', 'sender-x@s.whatsapp.net'],
      ['chat-b@g.us', 'sender-y@s.whatsapp.net'],
    ]);
  });

  it('uses deterministic SHA256 scope-and-claim IDs for durable records', async () => {
    const claim = 'User lives in London';
    const chatJid = 'chat-1@g.us';
    const senderJid = 'sender-1@s.whatsapp.net';
    const expectedHash = createHash('sha256').update(`${chatJid}\0${senderJid}\0${claim}`).digest('hex').slice(0, 16);

    const mockPinecone = makeMockPinecone([
      {
        id: 'rec-1',
        score: 0.9,
        record: {
          id: 'rec-1',
          text: 'Lives in London',
          claim: 'Lives in London',
          evidence: '',
          createdAt: new Date().toISOString(),
          confidence: 0.9,
          chatJid,
          senderJid,
        },
      },
    ]);

    const mockProvider = makeMockProvider({
      durableKnowledge: [{
        claim,
        promotionReason: 'Consistent',
        confidence: 0.92,
        sourceRecordIds: ['rec-1'],
      }],
      discarded: [],
    });

    await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    const upsertedRecords = mockPinecone.upsert.mock.calls[0][0];
    expect(upsertedRecords[0].id).toBe(`durable:${expectedHash}`);
  });

  it('redacts claim text from dry-run logs', async () => {
    const sensitiveClaim = 'Sensitive London address is 221B Baker Street';
    const mockPinecone = makeMockPinecone([
      {
        id: 'rec-1',
        score: 0.9,
        record: {
          id: 'rec-1',
          text: sensitiveClaim,
          claim: sensitiveClaim,
          evidence: '',
          createdAt: new Date().toISOString(),
          confidence: 0.9,
          chatJid: 'chat-1@g.us',
          senderJid: 'sender-1@s.whatsapp.net',
        },
      },
    ]);

    const mockProvider = makeMockProvider({
      durableKnowledge: [{ claim: sensitiveClaim, promotionReason: 'test', confidence: 0.9, sourceRecordIds: ['rec-1'] }],
      discarded: [],
    });

    await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: true },
    );

    const serializedLogs = JSON.stringify(mockCronLogger.info.mock.calls);
    expect(serializedLogs).not.toContain(sensitiveClaim);
    expect(serializedLogs).toContain('claimHashes');
  });

  it('skips unscoped records and returns early when none have chat/sender scope', async () => {
    // UNHAPPY: a record missing chatJid/senderJid cannot be scope-consolidated, so it is
    // skipped (unscopedSkipped) via the `?? ''` fallbacks; when no scoped records remain,
    // consolidation returns early without ever invoking the LLM provider or upserting.
    const mockPinecone = makeMockPinecone([
      {
        id: 'rec-unscoped',
        score: 0.9,
        record: {
          id: 'rec-unscoped',
          text: 'Floating fact with no scope',
          createdAt: new Date().toISOString(),
          confidence: 0.9,
          // claim, evidence, chatJid, senderJid intentionally absent
        },
      },
    ]);
    const mockProvider = { name: 'test', generate: vi.fn() };

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result.promoted).toBe(0);
    expect(result.clustersProcessed).toBe(0);
    expect(mockProvider.generate).not.toHaveBeenCalled();
    expect(mockPinecone.upsert).not.toHaveBeenCalled();
  });

  it('processes the cluster but promotes nothing when the LLM returns no durable knowledge', async () => {
    // UNHAPPY: a scoped cluster whose consolidation yields zero durableKnowledge is counted
    // as processed and its discards tallied, but nothing is promoted or upserted.
    const mockPinecone = makeMockPinecone([
      {
        id: 'rec-1',
        score: 0.9,
        record: {
          id: 'rec-1',
          text: 'Ambiguous fact',
          claim: 'Ambiguous fact',
          evidence: '',
          createdAt: new Date().toISOString(),
          confidence: 0.5,
          chatJid: 'chat-1@g.us',
          senderJid: 'sender-1@s.whatsapp.net',
        },
      },
    ]);
    const mockProvider = makeMockProvider({
      durableKnowledge: [],
      discarded: [{ recordId: 'rec-1', reason: 'transient' }],
    });

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result.clustersProcessed).toBe(1);
    expect(result.promoted).toBe(0);
    expect(result.discarded).toBe(1);
    expect(mockPinecone.upsert).not.toHaveBeenCalled();
  });
});
