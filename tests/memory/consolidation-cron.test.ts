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
      searchDetailed: vi.fn().mockResolvedValue({
        results: searchResults,
        status: 'ok',
        evidenceCoverage: 'provider_response',
      }),
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

    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'live',
      status: 'completed',
      stage: 'finalize',
      failureCode: 'none',
      retryable: false,
      counters: {
        wouldPromote: 0,
        writeAttempted: 1,
        writeConfirmed: 1,
        clustersAttempted: 1,
        clustersCompleted: 1,
      },
    });
    expect(mockPinecone.upsert).toHaveBeenCalledTimes(1);
    expect(mockPinecone.searchDetailed).toHaveBeenCalledWith(
      'facts about people preferences locations interests',
      {},
      100,
      undefined,
      undefined,
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

    expect(result).toMatchObject({
      mode: 'dry_run',
      status: 'completed',
      counters: {
        wouldPromote: 1,
        writeAttempted: 0,
        writeConfirmed: 0,
      },
    });
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

    expect(result).toMatchObject({
      status: 'no_work',
      failureCode: 'none',
      counters: {
        recordsObserved: 0,
        clustersAttempted: 0,
        clustersCompleted: 0,
      },
    });
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

    expect(result).toMatchObject({
      status: 'no_work',
      counters: {
        skipped: 2,
        clustersAttempted: 0,
        clustersCompleted: 0,
      },
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
      searchDetailed: vi.fn().mockResolvedValue({
        results: [],
        status: 'failed',
        failureCode: 'network_error',
        retryable: true,
      }),
      upsert: vi.fn(),
    };
    const mockProvider = { name: 'test', generate: vi.fn() };

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result).toMatchObject({
      status: 'failed',
      stage: 'search',
      failureCode: 'network_error',
      retryable: true,
      counters: { failed: 1, recordsObserved: 0 },
    });
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

    expect(result).toMatchObject({
      status: 'completed',
      counters: {
        writeConfirmed: 0,
        discarded: 1,
        clustersAttempted: 1,
        clustersCompleted: 1,
        failed: 0,
      },
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
      .mockRejectedValueOnce(new Error('private-write-error'))
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

    expect(result).toMatchObject({
      status: 'partial',
      stage: 'write',
      failureCode: 'write_failed',
      counters: {
        writeAttempted: 2,
        writeConfirmed: 1,
        discarded: 0,
        clustersAttempted: 2,
        clustersCompleted: 1,
        failed: 1,
      },
    });
    expect(mockProvider.generate).toHaveBeenCalledTimes(2);
    expect(mockPinecone.upsert).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockCronLogger.warn.mock.calls))
      .not.toContain('private-write-error');
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

    expect(result.counters.clustersAttempted).toBe(1);
    expect(result.counters.writeConfirmed).toBe(1);
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

    expect(result.counters.writeConfirmed).toBe(2);
    expect(result.counters.clustersAttempted).toBe(2);
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
    expect(serializedLogs).not.toContain('claimHashes');
    expect(serializedLogs).toContain('durableCount');
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

    expect(result.counters.writeConfirmed).toBe(0);
    expect(result.counters.clustersAttempted).toBe(0);
    expect(result.counters.skipped).toBe(1);
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

    expect(result.counters.clustersAttempted).toBe(1);
    expect(result.counters.writeConfirmed).toBe(0);
    expect(result.counters.discarded).toBe(1);
    expect(mockPinecone.upsert).not.toHaveBeenCalled();
  });

  it('distinguishes a swallowed provider failure from an observed empty result', async () => {
    const failedPinecone = {
      searchDetailed: vi.fn().mockResolvedValue({
        results: [],
        status: 'failed',
        failureCode: 'provider_unavailable',
        retryable: true,
      }),
      upsert: vi.fn(),
    };
    const emptyPinecone = makeMockPinecone([]);
    const provider = { name: 'test', generate: vi.fn() };

    const failed = await runConsolidation(
      failedPinecone,
      provider,
      { lookbackDays: 7, dryRun: false },
    );
    const empty = await runConsolidation(
      emptyPinecone,
      provider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(failed.status).toBe('failed');
    expect(empty.status).toBe('no_work');
    expect(failed).not.toEqual(empty);
  });

  it('reports cancellation when ownership expires as a failed search returns', async () => {
    const controller = new AbortController();
    const pinecone = {
      searchDetailed: vi.fn().mockImplementation(async () => {
        controller.abort(new DOMException('expired', 'AbortError'));
        return {
          results: [],
          status: 'failed' as const,
          failureCode: 'provider_unavailable' as const,
          retryable: true,
        };
      }),
      upsert: vi.fn(),
    };

    const result = await runConsolidation(
      pinecone,
      { name: 'test', generate: vi.fn() },
      {
        lookbackDays: 7,
        dryRun: false,
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      status: 'cancelled',
      stage: 'search',
      failureCode: 'cancelled',
      retryable: true,
      evidenceCoverage: 'local_guard',
      counters: { failed: 1, writeAttempted: 0, writeConfirmed: 0 },
    });
  });

  it('returns cancelled and fences writes when the run expires after generation', async () => {
    let writeAllowed = true;
    const mockPinecone = makeMockPinecone([{
      id: 'rec-1',
      score: 0.9,
      record: {
        id: 'rec-1',
        text: 'Synthetic',
        claim: 'Synthetic',
        evidence: '',
        createdAt: new Date().toISOString(),
        confidence: 0.9,
        chatJid: 'chat-1@g.us',
        senderJid: 'sender-1@s.whatsapp.net',
      },
    }]);
    const provider = makeMockProvider({
      durableKnowledge: [{
        claim: 'Synthetic durable claim',
        promotionReason: 'Synthetic reason',
        confidence: 0.9,
        sourceRecordIds: ['rec-1'],
      }],
      discarded: [],
    });
    provider.generate.mockImplementationOnce(async () => {
      writeAllowed = false;
      return {
        content: JSON.stringify({
          durableKnowledge: [{
            claim: 'Synthetic durable claim',
            promotionReason: 'Synthetic reason',
            confidence: 0.9,
            sourceRecordIds: ['rec-1'],
          }],
          discarded: [],
        }),
        inputTokens: 1,
        outputTokens: 1,
        model: 'test',
        durationMs: 1,
      };
    });

    const result = await runConsolidation(
      mockPinecone,
      provider,
      { lookbackDays: 7, dryRun: false, isWriteAllowed: () => writeAllowed },
    );

    expect(result).toMatchObject({
      status: 'cancelled',
      stage: 'write',
      failureCode: 'cancelled',
      counters: { writeAttempted: 0, writeConfirmed: 0, failed: 1 },
    });
    expect(mockPinecone.upsert).not.toHaveBeenCalled();
  });

  it('rechecks ownership after write progress before invoking the provider', async () => {
    let writeAllowed = true;
    const mockPinecone = makeMockPinecone([{
      id: 'rec-1',
      score: 0.9,
      record: {
        id: 'rec-1',
        text: 'Synthetic',
        claim: 'Synthetic',
        evidence: '',
        createdAt: new Date().toISOString(),
        confidence: 0.9,
        chatJid: 'chat-1@g.us',
        senderJid: 'sender-1@s.whatsapp.net',
      },
    }]);
    const provider = makeMockProvider({
      durableKnowledge: [{
        claim: 'Synthetic durable claim',
        promotionReason: 'Synthetic reason',
        confidence: 0.9,
        sourceRecordIds: ['rec-1'],
      }],
      discarded: [],
    });

    const result = await runConsolidation(
      mockPinecone,
      provider,
      {
        lookbackDays: 7,
        dryRun: false,
        isWriteAllowed: () => writeAllowed,
        onProgress: (stage) => {
          if (stage === 'write') writeAllowed = false;
        },
      },
    );

    expect(result).toMatchObject({
      status: 'cancelled',
      stage: 'write',
      failureCode: 'cancelled',
      counters: { writeAttempted: 0, writeConfirmed: 0, failed: 1 },
    });
    expect(mockPinecone.upsert).not.toHaveBeenCalled();
  });
});
