import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks must come before any imports that transitively load them ──

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../../src/config.ts', () => ({
  config: {
    models: {
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5-20251001',
    },
    enrichmentIntervalMs: 60_000,
    enrichmentBatchSize: 200,
    enrichmentMinConfidence: 0.7,
    enrichmentDedupThreshold: 0.95,
    enrichmentMaxRetries: 3,
    pineconeIndex: 'test-index',
    pineconeContextTopK: 10,
    pineconeSenderTopK: 5,
    adminPhones: new Set(['15550100001']),
    dbPath: ':memory:',
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => mockLogger,
}));

// Mock the database message functions
vi.mock('../../../../src/core/messages.ts', () => ({
  getUnprocessedMessages: vi.fn(),
  getUnprocessedCount: vi.fn(),
  markMessagesProcessed: vi.fn(),
  markMessagesWithError: vi.fn(),
  incrementEnrichmentRetries: vi.fn(),
}));

// Mock extractor, validator, fact-export-queue so we control their output.
// The poller now enqueues validated facts into SQLite instead of upserting
// to Pinecone directly; the standalone mw-mind pipeline drains the queue.
vi.mock('../../../../src/runtimes/chat/enrichment/extractor.ts', () => ({
  extractFacts: vi.fn(),
}));

vi.mock('../../../../src/runtimes/chat/enrichment/validator.ts', () => ({
  validateFacts: vi.fn(),
}));

vi.mock('../../../../src/runtimes/chat/enrichment/fact-export-queue.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/runtimes/chat/enrichment/fact-export-queue.ts')>();
  return {
    ...actual,
    enqueueFacts: vi.fn(),
  };
});

import { EnrichmentPoller } from '../../../../src/runtimes/chat/enrichment/poller.ts';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';
import type { PineconeMemory } from '../../../../src/runtimes/chat/providers/pinecone.ts';
import type { StoredMessage } from '../../../../src/core/messages.ts';
import {
  getUnprocessedMessages,
  getUnprocessedCount,
  markMessagesProcessed,
  markMessagesWithError,
  incrementEnrichmentRetries,
} from '../../../../src/core/messages.ts';
import { extractFacts } from '../../../../src/runtimes/chat/enrichment/extractor.ts';
import { validateFacts } from '../../../../src/runtimes/chat/enrichment/validator.ts';
import { enqueueFacts } from '../../../../src/runtimes/chat/enrichment/fact-export-queue.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function mockProvider(response: string = '[]'): LLMProvider {
  return {
    name: 'mock',
    generate: vi.fn().mockResolvedValue({
      content: response,
      inputTokens: 100,
      outputTokens: 50,
      model: 'mock-model',
      durationMs: 100,
    }),
  };
}

function makeStoredMsg(overrides?: Partial<StoredMessage>): StoredMessage {
  return {
    pk: 1,
    chatJid: 'chat1@g.us',
    senderJid: '15551230008@s.whatsapp.net',
    senderName: 'TestUser',
    messageId: 'msg-1',
    content: 'I just moved to London',
    contentType: 'text',
    isFromMe: false,
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: new Date().toISOString(),
    conversationKey: 'chat1_at_g.us',
    mediaPath: null,
    contentText: null,
    ...overrides,
  };
}

// Minimal stub for Database — poller.ts calls db.raw.prepare().run() for enrichment_runs
function makeMockDb() {
  const runFn = vi.fn();
  const prepareFn = vi.fn().mockReturnValue({ run: runFn });
  return {
    raw: { prepare: prepareFn },
    _runFn: runFn,
    _prepareFn: prepareFn,
  };
}

function makePinecone(): PineconeMemory {
  return {
    checkDuplicate: vi.fn().mockResolvedValue({ isDuplicate: false }),
    search: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    searchForChat: vi.fn().mockResolvedValue([]),
    searchForSender: vi.fn().mockResolvedValue([]),
  } as unknown as PineconeMemory;
}

function makePoller(dbOverride?: ReturnType<typeof makeMockDb>) {
  const db = dbOverride ?? makeMockDb();
  const pinecone = makePinecone();
  const extractionProvider = mockProvider();
  const validationProvider = mockProvider();
  const poller = new EnrichmentPoller(
    db as unknown as import('../../../../src/core/database.ts').Database,
    pinecone,
    extractionProvider,
    validationProvider,
  );
  return { poller, db, pinecone, extractionProvider, validationProvider };
}

// Call runCycle by starting the poller and triggering the interval.
// Since we don't want real timers, we use vi.useFakeTimers and vi.runAllTimersAsync.
async function triggerOneCycle(poller: EnrichmentPoller): Promise<void> {
  // Access the private runCycle method via casting
  await (poller as unknown as { runCycle(): Promise<void> }).runCycle();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('EnrichmentPoller', () => {
  const originalRunId = process.env.MW_MIND_RUN_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default stubs for mocked modules
    vi.mocked(getUnprocessedMessages).mockReturnValue([]);
    vi.mocked(getUnprocessedCount).mockReturnValue(0);
    vi.mocked(markMessagesProcessed).mockReturnValue(undefined);
    vi.mocked(markMessagesWithError).mockReturnValue(undefined);
    vi.mocked(incrementEnrichmentRetries).mockReturnValue(undefined);
    vi.mocked(extractFacts).mockResolvedValue([]);
    vi.mocked(validateFacts).mockResolvedValue([]);
    vi.mocked(enqueueFacts).mockReturnValue({ attempted: 0, inserted: 0, duplicates: 0, failed: 0 });
  });

  afterEach(() => {
    if (originalRunId === undefined) {
      delete process.env.MW_MIND_RUN_ID;
    } else {
      process.env.MW_MIND_RUN_ID = originalRunId;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Positive ────────────────────────────────────────────────────────────

  it('reports unprocessedCount from the message store for the current DB', () => {
    vi.mocked(getUnprocessedCount).mockReturnValue(17);

    const { poller, db } = makePoller();

    expect(poller.unprocessedCount).toBe(17);
    expect(getUnprocessedCount).toHaveBeenCalledWith(db);
  });

  it('start schedules exactly one recurring tick and stop clears the active timer', async () => {
    vi.useFakeTimers();
    vi.mocked(getUnprocessedMessages).mockReturnValue([]);

    const { poller } = makePoller();

    poller.stop();
    expect((poller as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();

    poller.start();
    const firstTimer = (poller as unknown as { timer: NodeJS.Timeout | null }).timer;
    expect(firstTimer).not.toBeNull();

    poller.start();
    expect((poller as unknown as { timer: NodeJS.Timeout | null }).timer).toBe(firstTimer);
    expect(mockLogger.warn).toHaveBeenCalledWith('EnrichmentPoller.start() called while already running');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getUnprocessedMessages).toHaveBeenCalledTimes(1);
    expect((poller as unknown as { timer: NodeJS.Timeout | null }).timer).not.toBeNull();

    poller.stop();
    expect((poller as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
    expect(mockLogger.info).toHaveBeenCalledWith(
      { intervalMs: 60_000 },
      'Enrichment poller starting',
    );
    expect(mockLogger.info).toHaveBeenCalledWith('Enrichment poller stopped');
  });

  it('normal cycle: fetch → extract → validate → enqueue → markProcessed', async () => {
    const msg1 = makeStoredMsg({ pk: 1, chatJid: 'chat1@g.us' });
    const msg2 = makeStoredMsg({ pk: 2, chatJid: 'chat1@g.us', messageId: 'msg-2' });
    vi.mocked(getUnprocessedMessages).mockReturnValue([msg1, msg2]);

    const extractedFact = {
      text: 'Lives in London',
      chatJid: 'chat1@g.us',
      senderJid: '15551230008@s.whatsapp.net',
      senderName: 'TestUser',
      memoryType: 'user_fact' as const,
      confidence: 0.9,
      supersedesText: '',
      sourceMessagePks: [1, 2],
    };
    vi.mocked(extractFacts).mockResolvedValue([extractedFact]);

    const validatedFact = { ...extractedFact, adjustedConfidence: 0.9 };
    vi.mocked(validateFacts).mockResolvedValue([validatedFact]);
    vi.mocked(enqueueFacts).mockReturnValue({ attempted: 1, inserted: 1, duplicates: 0, failed: 0 });

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    expect(getUnprocessedMessages).toHaveBeenCalledTimes(1);
    expect(extractFacts).toHaveBeenCalledTimes(1);
    expect(validateFacts).toHaveBeenCalledTimes(1);
    expect(enqueueFacts).toHaveBeenCalledTimes(1);
    // Messages are marked processed after successful queueing, NOT after Pinecone write.
    expect(markMessagesProcessed).toHaveBeenCalledWith(expect.anything(), [1, 2]);
    expect(markMessagesWithError).toHaveBeenCalledWith(expect.anything(), [], 'max_retries_exceeded');
  });

  it('updates lastRunAt after a successful cycle', async () => {
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg()]);
    vi.mocked(extractFacts).mockResolvedValue([]);

    const { poller } = makePoller();
    expect(poller.lastRunAt).toBeNull();

    await triggerOneCycle(poller);

    expect(poller.lastRunAt).not.toBeNull();
    expect(typeof poller.lastRunAt).toBe('string');
    // Should be a valid ISO date string
    expect(() => new Date(poller.lastRunAt!)).not.toThrow();
  });

  it('writes an enrichment_runs record after the cycle', async () => {
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg({ pk: 5 })]);
    vi.mocked(extractFacts).mockResolvedValue([]);

    const db = makeMockDb();
    const { poller } = makePoller(db);
    await triggerOneCycle(poller);

    expect(db._prepareFn).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO enrichment_runs'),
    );
    expect(db._runFn).toHaveBeenCalledTimes(1);
  });

  it('marks all messages in a chat segment as processed when 0 facts extracted', async () => {
    const msgs = [
      makeStoredMsg({ pk: 10, chatJid: 'chat2@g.us', messageId: 'x1' }),
      makeStoredMsg({ pk: 11, chatJid: 'chat2@g.us', messageId: 'x2' }),
    ];
    vi.mocked(getUnprocessedMessages).mockReturnValue(msgs);
    vi.mocked(extractFacts).mockResolvedValue([]); // no facts

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    expect(markMessagesProcessed).toHaveBeenCalledWith(expect.anything(), [10, 11]);
  });

  it('marks all messages as processed when validated facts is empty', async () => {
    const msg = makeStoredMsg({ pk: 20 });
    vi.mocked(getUnprocessedMessages).mockReturnValue([msg]);
    vi.mocked(extractFacts).mockResolvedValue([{
      text: 'Some fact',
      chatJid: 'chat1@g.us',
      senderJid: '15551230008@s.whatsapp.net',
      senderName: 'TestUser',
      memoryType: 'user_fact',
      confidence: 0.9,
      supersedesText: '',
      sourceMessagePks: [20],
    }]);
    vi.mocked(validateFacts).mockResolvedValue([]); // all filtered

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    expect(markMessagesProcessed).toHaveBeenCalledWith(expect.anything(), [20]);
  });

  it('messages from different chats are processed in separate extract+validate calls', async () => {
    const msgA = makeStoredMsg({ pk: 1, chatJid: 'chatA@g.us', messageId: 'a1' });
    const msgB = makeStoredMsg({ pk: 2, chatJid: 'chatB@g.us', messageId: 'b1' });
    vi.mocked(getUnprocessedMessages).mockReturnValue([msgA, msgB]);
    vi.mocked(extractFacts).mockResolvedValue([]);

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    expect(extractFacts).toHaveBeenCalledTimes(2);
    // Called with messages from chatA and chatB separately
    const calls = vi.mocked(extractFacts).mock.calls;
    const chatJidsProcessed = calls.map((c) => c[1][0].chatJid);
    expect(chatJidsProcessed).toContain('chatA@g.us');
    expect(chatJidsProcessed).toContain('chatB@g.us');
  });

  // ── Negative ────────────────────────────────────────────────────────────

  it('tick logs unexpected runCycle throws and reschedules while still running', async () => {
    const { poller } = makePoller();
    const err = new Error('unexpected cycle fault');
    vi.spyOn(
      poller as unknown as { runCycle(): Promise<void> },
      'runCycle',
    ).mockRejectedValueOnce(err);

    await (poller as unknown as { tick(): Promise<void> }).tick();

    expect(mockLogger.error).toHaveBeenCalledWith(
      { err },
      'enrichment: unexpected error in tick — rescheduling',
    );
    expect((poller as unknown as { timer: NodeJS.Timeout | null }).timer).not.toBeNull();
    clearTimeout((poller as unknown as { timer: NodeJS.Timeout }).timer);
  });

  it('tick does not reschedule after the poller has been stopped', async () => {
    const { poller } = makePoller();
    vi.spyOn(
      poller as unknown as { runCycle(): Promise<void> },
      'runCycle',
    ).mockResolvedValueOnce(undefined);

    poller.stop();
    await (poller as unknown as { tick(): Promise<void> }).tick();

    expect((poller as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });

  it('self-scheduling: tick() waits for runCycle to finish before scheduling next', async () => {
    // Simulate a long-running cycle by holding extractFacts until we release it
    let resolveFirst!: () => void;
    const firstCycleBlocked = new Promise<void>((resolve) => { resolveFirst = resolve; });

    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg()]);
    vi.mocked(extractFacts).mockReturnValueOnce(
      firstCycleBlocked.then(() => []),
    );

    const { poller } = makePoller();

    // Invoke tick() directly — it clears timer, runs runCycle, then reschedules
    const tickMethod = (poller as unknown as { tick(): Promise<void> }).tick.bind(poller);

    // Start tick (does not await yet — runCycle is blocked inside)
    const tickDone = tickMethod();

    // timer should be null while the cycle is in-flight (cleared at start of tick)
    // and stopped is false (poller was never started via start(), so stopped defaults to false)
    // We just verify tick doesn't reschedule until the cycle finishes.
    // While firstCycleBlocked is unresolved, timer remains null.
    expect((poller as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();

    // Unblock the cycle
    resolveFirst();
    await tickDone;

    // After tick completes with stopped=false, it should have rescheduled (timer is set)
    expect((poller as unknown as { timer: NodeJS.Timeout | null }).timer).not.toBeNull();

    // Clean up the pending timer
    clearTimeout((poller as unknown as { timer: NodeJS.Timeout }).timer);
  });

  it('does NOT mark failed segment PKs as processed (marks them with error after max retries)', async () => {
    vi.mocked(extractFacts).mockRejectedValue(new Error('Extraction exploded'));

    // Simulate DB-persisted retry counts increasing across cycles
    vi.mocked(getUnprocessedMessages)
      .mockReturnValueOnce([makeStoredMsg({ pk: 99, enrichmentRetries: 0 })])  // cycle 1
      .mockReturnValueOnce([makeStoredMsg({ pk: 99, enrichmentRetries: 1 })])  // cycle 2 (DB incremented)
      .mockReturnValueOnce([makeStoredMsg({ pk: 99, enrichmentRetries: 2 })]);  // cycle 3 → 2+1=3 ≥ max

    const { poller } = makePoller();

    await triggerOneCycle(poller); // retries=0 → increment to 1
    await triggerOneCycle(poller); // retries=1 → increment to 2
    await triggerOneCycle(poller); // retries=2 → 3 ≥ max → fail permanently

    // After 3 failures, pk=99 should be in the error list
    const errorCalls = vi.mocked(markMessagesWithError).mock.calls;
    const errorPks = errorCalls.flatMap((c) => c[1] as number[]);
    expect(errorPks).toContain(99);

    // pk=99 must NOT appear in any markMessagesProcessed call
    const processedCalls = vi.mocked(markMessagesProcessed).mock.calls;
    const processedPks = processedCalls.flatMap((c) => c[1] as number[]);
    expect(processedPks).not.toContain(99);

    // incrementEnrichmentRetries should have been called for the first 2 cycles (not the 3rd)
    const incrementCalls = vi.mocked(incrementEnrichmentRetries).mock.calls;
    const incrementedPks = incrementCalls.flatMap((c) => c[1] as number[]);
    expect(incrementedPks.filter(pk => pk === 99)).toHaveLength(2);
  });

  it('does NOT crash on individual segment failure — other segments continue', async () => {
    const msgA = makeStoredMsg({ pk: 1, chatJid: 'chatA@g.us', messageId: 'a1' });
    const msgB = makeStoredMsg({ pk: 2, chatJid: 'chatB@g.us', messageId: 'b1' });
    vi.mocked(getUnprocessedMessages).mockReturnValue([msgA, msgB]);

    vi.mocked(extractFacts)
      .mockRejectedValueOnce(new Error('chatA exploded')) // chatA fails
      .mockResolvedValueOnce([]);                         // chatB succeeds

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    // chatB processed successfully
    const processedCalls = vi.mocked(markMessagesProcessed).mock.calls;
    const processedPks = processedCalls.flatMap((c) => c[1] as number[]);
    expect(processedPks).toContain(2);
  });

  it('skips everything and does NOT call extractFacts on empty batch', async () => {
    vi.mocked(getUnprocessedMessages).mockReturnValue([]);

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    expect(extractFacts).not.toHaveBeenCalled();
    expect(validateFacts).not.toHaveBeenCalled();
    expect(enqueueFacts).not.toHaveBeenCalled();
    expect(markMessagesProcessed).not.toHaveBeenCalled();
  });

  it('does NOT mark messages as processed when DB fetch throws', async () => {
    vi.mocked(getUnprocessedMessages).mockImplementation(() => {
      throw new Error('DB connection lost');
    });

    const { poller } = makePoller();
    await triggerOneCycle(poller); // should not throw

    expect(markMessagesProcessed).not.toHaveBeenCalled();
    expect(extractFacts).not.toHaveBeenCalled();
  });

  it('marks with error only after max retries (3), not before', async () => {
    vi.mocked(extractFacts).mockRejectedValue(new Error('always fails'));

    const { poller } = makePoller();

    // Cycle 1: enrichmentRetries=0, fail → increment to 1, no error mark yet
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg({ pk: 55, enrichmentRetries: 0 })]);
    await triggerOneCycle(poller);
    let errorPksAfter1 = vi.mocked(markMessagesWithError).mock.calls.flatMap((c) => c[1] as number[]);
    expect(errorPksAfter1).not.toContain(55);

    // Cycle 2: enrichmentRetries=1 (DB-persisted), fail → increment to 2, still no error
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg({ pk: 55, enrichmentRetries: 1 })]);
    await triggerOneCycle(poller);
    const errorPksAfter2 = vi.mocked(markMessagesWithError).mock.calls.flatMap((c) => c[1] as number[]);
    expect(errorPksAfter2).not.toContain(55);

    // Cycle 3: enrichmentRetries=2 (DB-persisted), fail → 2+1=3 ≥ max → mark with error
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg({ pk: 55, enrichmentRetries: 2 })]);
    await triggerOneCycle(poller);
    const errorPksAfter3 = vi.mocked(markMessagesWithError).mock.calls.flatMap((c) => c[1] as number[]);
    expect(errorPksAfter3).toContain(55);
  });

  it('retry counters survive poller restart (DB-persisted, not in-memory)', async () => {
    vi.mocked(extractFacts).mockRejectedValue(new Error('always fails'));

    // First poller instance: runs 2 cycles, incrementing retries to 2
    const { poller: poller1 } = makePoller();
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg({ pk: 77, enrichmentRetries: 0 })]);
    await triggerOneCycle(poller1);
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg({ pk: 77, enrichmentRetries: 1 })]);
    await triggerOneCycle(poller1);

    // No permanent error yet — only 2 retries
    let errorPks = vi.mocked(markMessagesWithError).mock.calls.flatMap((c) => c[1] as number[]);
    expect(errorPks).not.toContain(77);

    // Simulate restart: new poller instance, DB state preserved (retries=2)
    const { poller: poller2 } = makePoller();
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg({ pk: 77, enrichmentRetries: 2 })]);
    await triggerOneCycle(poller2);

    // Now it should hit max retries (2+1=3) even though poller2 never saw cycles 1-2
    errorPks = vi.mocked(markMessagesWithError).mock.calls.flatMap((c) => c[1] as number[]);
    expect(errorPks).toContain(77);
  });

  it('lastRunAt is only updated when messages were fetched (not on empty batch)', async () => {
    vi.mocked(getUnprocessedMessages).mockReturnValue([]);

    const { poller, db } = makePoller();
    const previousLastRunAt = '2026-05-07T00:00:00.000Z';
    poller.lastRunAt = previousLastRunAt;

    await triggerOneCycle(poller);

    expect(getUnprocessedMessages).toHaveBeenCalledTimes(1);
    expect(getUnprocessedMessages).toHaveBeenCalledWith(db, 200);
    expect(extractFacts).not.toHaveBeenCalled();
    expect(validateFacts).not.toHaveBeenCalled();
    expect(enqueueFacts).not.toHaveBeenCalled();
    expect(markMessagesProcessed).not.toHaveBeenCalled();
    expect(markMessagesWithError).not.toHaveBeenCalled();
    expect(incrementEnrichmentRetries).not.toHaveBeenCalled();
    expect(db._prepareFn).not.toHaveBeenCalled();
    expect(poller.lastRunAt).toBe(previousLastRunAt);
  });

  it('logs retry counter persistence failures without marking the failed segment processed', async () => {
    const retryErr = new Error('retry write failed');
    vi.mocked(getUnprocessedMessages).mockReturnValue([
      makeStoredMsg({ pk: 88, enrichmentRetries: 0 }),
    ]);
    vi.mocked(extractFacts).mockRejectedValue(new Error('extract failed'));
    vi.mocked(incrementEnrichmentRetries).mockImplementation(() => {
      throw retryErr;
    });

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    expect(incrementEnrichmentRetries).toHaveBeenCalledWith(expect.anything(), [88]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: retryErr },
      'enrichment: failed to persist retry counters',
    );
    const processedPks = vi.mocked(markMessagesProcessed).mock.calls.flatMap((c) => c[1] as number[]);
    expect(processedPks).not.toContain(88);
  });

  it('logs markMessagesProcessed failures and still records the cycle', async () => {
    const markErr = new Error('processed write failed');
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg({ pk: 91 })]);
    vi.mocked(extractFacts).mockResolvedValue([]);
    vi.mocked(markMessagesProcessed).mockImplementation(() => {
      throw markErr;
    });

    const { poller, db } = makePoller();
    await triggerOneCycle(poller);

    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: markErr },
      'enrichment: failed to mark messages processed',
    );
    expect(markMessagesWithError).toHaveBeenCalledWith(expect.anything(), [], 'max_retries_exceeded');
    expect(db._runFn).toHaveBeenCalledTimes(1);
    expect(poller.lastRunAt).not.toBeNull();
  });

  it('logs markMessagesWithError failures without aborting final cycle accounting', async () => {
    const errorErr = new Error('terminal failure write failed');
    vi.mocked(getUnprocessedMessages).mockReturnValue([
      makeStoredMsg({ pk: 92, enrichmentRetries: 2 }),
    ]);
    vi.mocked(extractFacts).mockRejectedValue(new Error('extract failed'));
    vi.mocked(markMessagesWithError).mockImplementation(() => {
      throw errorErr;
    });

    const { poller, db } = makePoller();
    await triggerOneCycle(poller);

    expect(markMessagesWithError).toHaveBeenCalledWith(expect.anything(), [92], 'max_retries_exceeded');
    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: errorErr },
      'enrichment: failed to mark messages with error',
    );
    expect(db._runFn).toHaveBeenCalledTimes(1);
    expect(poller.lastRunAt).not.toBeNull();
  });

  it('logs enrichment_runs insert failures after message accounting completes', async () => {
    const runErr = new Error('run record insert failed');
    vi.mocked(getUnprocessedMessages).mockReturnValue([makeStoredMsg({ pk: 93 })]);
    vi.mocked(extractFacts).mockResolvedValue([]);
    const db = makeMockDb();
    db._runFn.mockImplementationOnce(() => {
      throw runErr;
    });

    const { poller } = makePoller(db);
    await triggerOneCycle(poller);

    expect(markMessagesProcessed).toHaveBeenCalledWith(expect.anything(), [93]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: runErr },
      'enrichment: failed to write enrichment_runs record',
    );
    expect(poller.lastRunAt).not.toBeNull();
  });

  // ── T1 hardening: accounting-gated markMessagesProcessed ─────────────────
  //
  // The pre-T1 poller called markMessagesProcessed on every message in a chat
  // segment whenever enqueueFacts returned anything (bare integer). This hides
  // partial-failure cases: if the SQLite insert loop swallowed 2-of-3 rows,
  // the upstream message rows were still marked processed and the lost facts
  // were never visible downstream.
  //
  // T1 contract: markMessagesProcessed (and appending to successPks) is
  // only permitted when the enqueueFacts accounting object reports
  //   failed === 0  AND  inserted + duplicates === facts.length
  // On mismatch, the poller must:
  //   - NOT mark those messages processed
  //   - log at WARN with run_id (from MW_MIND_RUN_ID), failed count, and the
  //     full accounting object.

  it('does NOT mark messages processed when enqueueFacts returns failed > 0', async () => {
    // Seed a fact segment with 3 messages and 3 extracted/validated facts.
    // enqueueFacts then reports a partial failure (2 failed of 3 attempted).
    const msgs = [
      makeStoredMsg({ pk: 101, chatJid: 'chatFail@g.us', messageId: 'f1' }),
      makeStoredMsg({ pk: 102, chatJid: 'chatFail@g.us', messageId: 'f2' }),
      makeStoredMsg({ pk: 103, chatJid: 'chatFail@g.us', messageId: 'f3' }),
    ];
    vi.mocked(getUnprocessedMessages).mockReturnValue(msgs);

    const extracted = [
      {
        text: 'Fact A', chatJid: 'chatFail@g.us',
        senderJid: '15551230008@s.whatsapp.net', senderName: 'TestUser',
        memoryType: 'user_fact' as const, confidence: 0.9,
        supersedesText: '', sourceMessagePks: [101],
      },
      {
        text: 'Fact B', chatJid: 'chatFail@g.us',
        senderJid: '15551230008@s.whatsapp.net', senderName: 'TestUser',
        memoryType: 'user_fact' as const, confidence: 0.9,
        supersedesText: '', sourceMessagePks: [102],
      },
      {
        text: 'Fact C', chatJid: 'chatFail@g.us',
        senderJid: '15551230008@s.whatsapp.net', senderName: 'TestUser',
        memoryType: 'user_fact' as const, confidence: 0.9,
        supersedesText: '', sourceMessagePks: [103],
      },
    ];
    vi.mocked(extractFacts).mockResolvedValue(extracted);
    vi.mocked(validateFacts).mockResolvedValue(
      extracted.map((f) => ({ ...f, adjustedConfidence: 0.9 })),
    );

    // 3 attempted, 1 inserted, 0 duplicates, 2 failed. Accounting mismatch:
    // inserted + duplicates (1) !== facts.length (3) AND failed > 0.
    vi.mocked(enqueueFacts).mockReturnValue({
      attempted: 3,
      inserted: 1,
      duplicates: 0,
      failed: 2,
    });

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    // markMessagesProcessed must either not be called, or be called with an
    // empty successPks array. (The poller groups by chatJid; all 3 messages
    // are in the failing segment, so nothing should succeed.)
    const processedCalls = vi.mocked(markMessagesProcessed).mock.calls;
    const processedPks = processedCalls.flatMap((c) => (c[1] ?? []) as number[]);
    expect(processedPks).not.toContain(101);
    expect(processedPks).not.toContain(102);
    expect(processedPks).not.toContain(103);
  });

  it('includes run id in queue mismatch and cycle-complete logs when present', async () => {
    process.env.MW_MIND_RUN_ID = 'run-enrich-123';
    const msgs = [
      makeStoredMsg({ pk: 301, chatJid: 'chatRun@g.us', messageId: 'run1' }),
      makeStoredMsg({ pk: 302, chatJid: 'chatRun@g.us', messageId: 'run2' }),
    ];
    vi.mocked(getUnprocessedMessages).mockReturnValue(msgs);
    const extracted = [
      {
        text: 'Fact A',
        chatJid: 'chatRun@g.us',
        senderJid: '15551230008@s.whatsapp.net',
        senderName: 'TestUser',
        memoryType: 'user_fact' as const,
        confidence: 0.9,
        supersedesText: '',
        sourceMessagePks: [301],
      },
      {
        text: 'Fact B',
        chatJid: 'chatRun@g.us',
        senderJid: '15551230008@s.whatsapp.net',
        senderName: 'TestUser',
        memoryType: 'user_fact' as const,
        confidence: 0.9,
        supersedesText: '',
        sourceMessagePks: [302],
      },
    ];
    vi.mocked(extractFacts).mockResolvedValue(extracted);
    vi.mocked(validateFacts).mockResolvedValue(
      extracted.map((fact) => ({ ...fact, adjustedConfidence: 0.9 })),
    );
    vi.mocked(enqueueFacts).mockReturnValue({
      attempted: 2,
      inserted: 1,
      duplicates: 0,
      failed: 0,
    });

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'chatRun@g.us',
        expected: 2,
        attempted: 2,
        inserted: 1,
        duplicates: 0,
        failed: 0,
        segmentMessagePks: [301, 302],
        runId: 'run-enrich-123',
      }),
      'enrichment: queue accounting mismatch — segment messages NOT marked processed',
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        messagesProcessed: 0,
        factsExtracted: 2,
        factsQueued: 1,
        runId: 'run-enrich-123',
      }),
      'enrichment: cycle complete',
    );
  });

  it('marks all processed on full success (attempted === inserted + duplicates, failed === 0)', async () => {
    const msgs = [
      makeStoredMsg({ pk: 201, chatJid: 'chatOK@g.us', messageId: 'ok1' }),
      makeStoredMsg({ pk: 202, chatJid: 'chatOK@g.us', messageId: 'ok2' }),
      makeStoredMsg({ pk: 203, chatJid: 'chatOK@g.us', messageId: 'ok3' }),
    ];
    vi.mocked(getUnprocessedMessages).mockReturnValue(msgs);

    // Validated produces 3 facts for this segment.
    const validated = [
      {
        text: 'A', chatJid: 'chatOK@g.us',
        senderJid: '15551230008@s.whatsapp.net', senderName: 'TestUser',
        memoryType: 'user_fact' as const, confidence: 0.9,
        supersedesText: '', sourceMessagePks: [201],
        adjustedConfidence: 0.9,
      },
      {
        text: 'B', chatJid: 'chatOK@g.us',
        senderJid: '15551230008@s.whatsapp.net', senderName: 'TestUser',
        memoryType: 'user_fact' as const, confidence: 0.9,
        supersedesText: '', sourceMessagePks: [202],
        adjustedConfidence: 0.9,
      },
      {
        text: 'C', chatJid: 'chatOK@g.us',
        senderJid: '15551230008@s.whatsapp.net', senderName: 'TestUser',
        memoryType: 'user_fact' as const, confidence: 0.9,
        supersedesText: '', sourceMessagePks: [203],
        adjustedConfidence: 0.9,
      },
    ];
    vi.mocked(extractFacts).mockResolvedValue(
      validated.map(({ adjustedConfidence: _ac, ...rest }) => rest),
    );
    vi.mocked(validateFacts).mockResolvedValue(validated);

    // Accounting: 3 attempted = 2 inserted + 1 duplicate, 0 failed → full success.
    vi.mocked(enqueueFacts).mockReturnValue({
      attempted: 3,
      inserted: 2,
      duplicates: 1,
      failed: 0,
    });

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    // All 3 messages are marked processed.
    const processedCalls = vi.mocked(markMessagesProcessed).mock.calls;
    const processedPks = processedCalls.flatMap((c) => (c[1] ?? []) as number[]);
    expect(processedPks).toContain(201);
    expect(processedPks).toContain(202);
    expect(processedPks).toContain(203);
  });
});
