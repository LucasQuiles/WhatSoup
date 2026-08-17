import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

const { mockCronLogger } = vi.hoisted(() => ({ mockCronLogger: {} as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock('../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(mockCronLogger);
  return { createChildLogger };
});

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
      {
        $or: [
          { confidence_qualifier: { $exists: false } },
          { confidence_qualifier: { $ne: 'consolidated' } },
        ],
      },
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

describe('recursive eligibility guard (#2569)', () => {
  // Previously-promoted durable knowledge re-enters the top-K selector as an
  // ordinary record (memoryType 'user_fact'), so a run can consume its own
  // prior output as a source. Promoted records are identifiable by the
  // 'durable:' id prefix and the 'consolidated' confidence qualifier; both
  // markers must exclude a record from consolidation input.
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

  it('excludes already-consolidated records from clustering and promotion', async () => {
    const nowIso = new Date().toISOString();
    const scoped = {
      createdAt: nowIso,
      confidence: 0.9,
      chatJid: 'chat-1@g.us',
      senderJid: 'sender-1@s.whatsapp.net',
    };
    const mockPinecone = makeMockPinecone([
      {
        id: 'rec-raw',
        score: 0.9,
        record: { id: 'rec-raw', text: 'Lives in London', claim: 'Lives in London', evidence: '', ...scoped },
      },
      {
        // Promoted output carrying the consolidated qualifier under a plain id.
        id: 'fact-consolidated',
        score: 0.85,
        record: { id: 'fact-consolidated', text: 'Lives in London town', claim: 'Lives in London town', evidence: 'rec-0', confidenceQualifier: 'consolidated', ...scoped },
      },
      {
        // Legacy promoted output identifiable only by its id prefix.
        id: 'durable:0123456789abcdef',
        score: 0.8,
        record: { id: 'durable:0123456789abcdef', text: 'Lives around London', claim: 'Lives around London', evidence: 'rec-0', ...scoped },
      },
    ]);
    const mockProvider = makeMockProvider({
      durableKnowledge: [{ claim: 'User lives in London', promotionReason: 'repeat', confidence: 0.9, sourceRecordIds: ['rec-raw'] }],
      discarded: [],
    });

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result).toMatchObject({
      status: 'completed',
      counters: {
        recordsObserved: 1,
        skipped: 2,
        clustersAttempted: 1,
        clustersCompleted: 1,
        writeConfirmed: 1,
      },
    });

    // Neither consolidated record may reach the model as source material.
    expect(mockProvider.generate).toHaveBeenCalledTimes(1);
    const promptPayload = JSON.stringify(mockProvider.generate.mock.calls);
    expect(promptPayload).not.toContain('fact-consolidated');
    expect(promptPayload).not.toContain('durable:0123456789abcdef');

    // The promotion write consumes only the raw source.
    expect(mockPinecone.upsert).toHaveBeenCalledTimes(1);
    const upsertPayload = JSON.stringify(mockPinecone.upsert.mock.calls);
    expect(upsertPayload).not.toContain('fact-consolidated');
    expect(upsertPayload).not.toContain('durable:0123456789abcdef');
  });

  it('excludes a non-canonical qualifier casing and survives undefined ids (review findings B/C)', async () => {
    const nowIso = new Date().toISOString();
    const scoped = {
      createdAt: nowIso,
      confidence: 0.9,
      chatJid: 'chat-1@g.us',
      senderJid: 'sender-1@s.whatsapp.net',
    };
    const mockPinecone = makeMockPinecone([
      {
        id: 'rec-raw',
        score: 0.9,
        record: { id: 'rec-raw', text: 'Lives in London', claim: 'Lives in London', evidence: '', ...scoped },
      },
      {
        // Qualifier casing must not bypass the guard.
        id: 'fact-cased',
        score: 0.85,
        record: { id: 'fact-cased', text: 'Lives in London town', claim: 'Lives in London town', evidence: 'rec-0', confidenceQualifier: 'Consolidated', ...scoped },
      },
      {
        // Undefined top-level id must not throw in the filter; the record-id
        // marker still excludes it.
        id: undefined,
        score: 0.8,
        record: { id: 'durable:fedcba9876543210', text: 'Lives around London', claim: 'Lives around London', evidence: 'rec-0', ...scoped },
      },
    ]);
    const mockProvider = makeMockProvider({
      durableKnowledge: [{ claim: 'User lives in London', promotionReason: 'repeat', confidence: 0.9, sourceRecordIds: ['rec-raw'] }],
      discarded: [],
    });

    const result = await runConsolidation(
      mockPinecone,
      mockProvider,
      { lookbackDays: 7, dryRun: false },
    );

    expect(result).toMatchObject({
      status: 'completed',
      counters: { recordsObserved: 1, skipped: 2, clustersAttempted: 1, writeConfirmed: 1 },
    });
    expect(mockProvider.generate).toHaveBeenCalledTimes(1);
    const promptPayload = JSON.stringify(mockProvider.generate.mock.calls);
    expect(promptPayload).not.toContain('fact-cased');
    expect(promptPayload).not.toContain('durable:fedcba9876543210');
  });
});

describe('pre-selection eligibility filtering (#2569)', () => {
  // A corpus-backed fake that behaves like the real index: the metadata filter
  // is applied BEFORE top-K, so excluded records cannot consume selection
  // slots. The post-retrieval guard cannot recover a record the search never
  // returned, which is exactly the starvation this car fixes.
  const FIELD_READERS: Record<string, (record: any) => unknown> = {
    confidence_qualifier: (record) => record.confidenceQualifier,
  };

  // Models the STRICT reading of the provider's operators: $ne matches only
  // records that HAVE a differing value, so an absent field does NOT satisfy
  // $ne. A fake that let absent fields pass $ne would be kinder than the
  // index and would hide legacy-record starvation behind a green suite.
  function matchesFilter(record: any, filters: Record<string, unknown>): boolean {
    for (const [key, condition] of Object.entries(filters ?? {})) {
      if (key === '$or') {
        const clauses = condition as Array<Record<string, unknown>>;
        if (!clauses.some((clause) => matchesFilter(record, clause))) return false;
        continue;
      }
      const reader = FIELD_READERS[key];
      if (!reader) continue;
      const present = reader(record) !== undefined;
      const value = reader(record);
      if (condition && typeof condition === 'object' && '$exists' in (condition as object)) {
        if (present !== (condition as { $exists: boolean }).$exists) return false;
        continue;
      }
      if (condition && typeof condition === 'object' && '$ne' in (condition as object)) {
        if (!present) return false;
        if (value === (condition as { $ne: unknown }).$ne) return false;
        continue;
      }
      if (value !== condition) return false;
    }
    return true;
  }

  function makeProvider(consolidationResponse: any) {
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

  /** `corpus` is ordered by descending similarity, as a vector index returns. */
  function makeCorpusPinecone(corpus: any[]) {
    return {
      searchDetailed: vi.fn(
        async (_query: string, filters: Record<string, unknown>, topK: number) => ({
          results: corpus.filter((entry) => matchesFilter(entry.record, filters)).slice(0, topK),
          status: 'ok',
          evidenceCoverage: 'provider_response',
        }),
      ),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
  }

  function consolidatedEntry(index: number) {
    return {
      id: `durable:prior${index}`,
      score: 0.99,
      record: {
        id: `durable:prior${index}`,
        text: `prior consolidation ${index}`,
        claim: `prior consolidation ${index}`,
        evidence: 'prior run',
        createdAt: new Date().toISOString(),
        confidence: 0.9,
        chatJid: 'chat-sat@g.us',
        senderJid: 'sender-sat@s.whatsapp.net',
        confidenceQualifier: 'consolidated',
      } as Record<string, unknown>,
    };
  }

  function eligibleEntry(index: number) {
    return {
      id: `fresh-${index}`,
      score: 0.5,
      record: {
        id: `fresh-${index}`,
        text: `fresh observation ${index}`,
        claim: `fresh observation ${index}`,
        evidence: 'said so',
        createdAt: new Date().toISOString(),
        confidence: 0.8,
        chatJid: 'chat-sat@g.us',
        senderJid: 'sender-sat@s.whatsapp.net',
      } as Record<string, unknown>,
    };
  }

  it('the fake rejects absent-field records under a bare $ne, as the index does', () => {
    // Pins the FAKE's own semantics (reviewer coverage nit). Without this,
    // relaxing matchesFilter to let an absent field satisfy $ne stays green,
    // and the $exists arm below becomes untestable — a later bare-$ne source
    // regression would then pass a suite that no longer models the index.
    const legacy = eligibleEntry(1).record;
    const output = consolidatedEntry(1).record;
    const bare = { confidence_qualifier: { $ne: 'consolidated' } };
    expect(matchesFilter(legacy, bare), 'an absent field must FAIL a bare $ne').toBe(false);
    expect(matchesFilter(output, bare), 'the qualifier value must FAIL its own $ne').toBe(false);
    expect(matchesFilter({ confidenceQualifier: 'other' }, bare)).toBe(true);

    const hardened = {
      $or: [{ confidence_qualifier: { $exists: false } }, bare],
    };
    expect(matchesFilter(legacy, hardened), 'the $exists arm readmits absent-field records').toBe(true);
    expect(matchesFilter(output, hardened), 'prior outputs stay excluded under the $or').toBe(false);
  });

  it('eligible records survive a top-K saturated by prior consolidation outputs', async () => {
    // 100 prior outputs outrank every eligible record and exactly fill topK.
    const corpus = [
      ...Array.from({ length: 100 }, (_unused, index) => consolidatedEntry(index)),
      eligibleEntry(1),
      eligibleEntry(2),
    ];
    const pinecone = makeCorpusPinecone(corpus);
    const provider = makeProvider({
      durableKnowledge: [{
        claim: 'Fresh observations consolidated',
        promotionReason: 'Repeated across sessions',
        confidence: 0.85,
        sourceRecordIds: ['fresh-1', 'fresh-2'],
      }],
      discarded: [],
    });

    const report = await runConsolidation(pinecone as never, provider as never, {
      lookbackDays: 7,
      dryRun: false,
    });

    expect(
      report.counters.recordsObserved,
      'eligible records must not be starved by prior outputs holding every top-K slot',
    ).toBe(2);
    expect(report.counters.clustersAttempted).toBe(1);
    expect(pinecone.upsert).toHaveBeenCalledTimes(1);
  });

  it('excludes prior consolidation outputs through the provider filter, not only after retrieval', async () => {
    const pinecone = makeCorpusPinecone([eligibleEntry(1)]);
    const provider = makeProvider({ durableKnowledge: [], discarded: [] });

    await runConsolidation(pinecone as never, provider as never, { lookbackDays: 7, dryRun: true });

    const filters = pinecone.searchDetailed.mock.calls[0]?.[1];
    expect(filters, 'selection must carry a provider-side eligibility filter').toEqual({
      $or: [
        { confidence_qualifier: { $exists: false } },
        { confidence_qualifier: { $ne: 'consolidated' } },
      ],
    });
  });

  it('records written before the qualifier existed are not starved by the filter', async () => {
    // Metadata rejects nulls, so a qualifier-less record has no key at all.
    // A bare $ne would exclude it — starving legacy sources instead of prior
    // outputs, the inverse of the defect this car fixes.
    const legacy = eligibleEntry(9);
    expect(legacy.record.confidenceQualifier, 'fixture must model an absent field').toBeUndefined();
    const pinecone = makeCorpusPinecone([legacy]);
    const provider = makeProvider({ durableKnowledge: [], discarded: [] });

    const report = await runConsolidation(pinecone as never, provider as never, {
      lookbackDays: 7,
      dryRun: true,
    });

    expect(
      report.counters.recordsObserved,
      'a record with no confidence_qualifier field must remain eligible',
    ).toBe(1);
  });

  it('keeps the post-retrieval guard for markers the provider filter cannot express', async () => {
    // A durable: id whose qualifier is absent passes the metadata filter, so
    // the id-prefix guard must still exclude it after retrieval.
    const unqualified = consolidatedEntry(7);
    delete unqualified.record.confidenceQualifier;
    const pinecone = makeCorpusPinecone([unqualified, eligibleEntry(1)]);
    const provider = makeProvider({ durableKnowledge: [], discarded: [] });

    const report = await runConsolidation(pinecone as never, provider as never, {
      lookbackDays: 7,
      dryRun: true,
    });

    expect(report.counters.recordsObserved, 'durable: ids stay excluded post-retrieval').toBe(1);
  });
});
