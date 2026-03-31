import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks must come before any imports that transitively load them ──

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
    adminPhones: new Set(['18459780919']),
    dbPath: ':memory:',
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the database message functions
vi.mock('../../../../src/core/messages.ts', () => ({
  getUnprocessedMessages: vi.fn(),
  markMessagesProcessed: vi.fn(),
  markMessagesWithError: vi.fn(),
  incrementEnrichmentRetries: vi.fn(),
}));

// Mock extractor, validator, upserter so we control their output
vi.mock('../../../../src/runtimes/chat/enrichment/extractor.ts', () => ({
  extractFacts: vi.fn(),
}));

vi.mock('../../../../src/runtimes/chat/enrichment/validator.ts', () => ({
  validateFacts: vi.fn(),
}));

vi.mock('../../../../src/runtimes/chat/enrichment/upserter.ts', () => ({
  upsertFacts: vi.fn(),
}));

import { EnrichmentPoller } from '../../../../src/runtimes/chat/enrichment/poller.ts';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';
import type { PineconeMemory } from '../../../../src/runtimes/chat/providers/pinecone.ts';
import type { StoredMessage } from '../../../../src/core/messages.ts';
import {
  getUnprocessedMessages,
  markMessagesProcessed,
  markMessagesWithError,
  incrementEnrichmentRetries,
} from '../../../../src/core/messages.ts';
import { extractFacts } from '../../../../src/runtimes/chat/enrichment/extractor.ts';
import { validateFacts } from '../../../../src/runtimes/chat/enrichment/validator.ts';
import { upsertFacts } from '../../../../src/runtimes/chat/enrichment/upserter.ts';

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
    senderJid: '15184194479@s.whatsapp.net',
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
    db as unknown as import('../../src/core/database.ts').Database,
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
  beforeEach(() => {
    vi.clearAllMocks();
    // Default stubs for mocked modules
    vi.mocked(getUnprocessedMessages).mockReturnValue([]);
    vi.mocked(markMessagesProcessed).mockReturnValue(undefined);
    vi.mocked(markMessagesWithError).mockReturnValue(undefined);
    vi.mocked(incrementEnrichmentRetries).mockReturnValue(undefined);
    vi.mocked(extractFacts).mockResolvedValue([]);
    vi.mocked(validateFacts).mockResolvedValue([]);
    vi.mocked(upsertFacts).mockResolvedValue({ upserted: 0, deduplicated: 0, superseded: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Positive ────────────────────────────────────────────────────────────

  it('normal cycle: fetch → extract → validate → upsert → markProcessed', async () => {
    const msg1 = makeStoredMsg({ pk: 1, chatJid: 'chat1@g.us' });
    const msg2 = makeStoredMsg({ pk: 2, chatJid: 'chat1@g.us', messageId: 'msg-2' });
    vi.mocked(getUnprocessedMessages).mockReturnValue([msg1, msg2]);

    const extractedFact = {
      text: 'Lives in London',
      chatJid: 'chat1@g.us',
      senderJid: '15184194479@s.whatsapp.net',
      senderName: 'TestUser',
      memoryType: 'user_fact' as const,
      confidence: 0.9,
      supersedesText: '',
      sourceMessagePks: [1, 2],
    };
    vi.mocked(extractFacts).mockResolvedValue([extractedFact]);

    const validatedFact = { ...extractedFact, adjustedConfidence: 0.9 };
    vi.mocked(validateFacts).mockResolvedValue([validatedFact]);
    vi.mocked(upsertFacts).mockResolvedValue({ upserted: 1, deduplicated: 0, superseded: 0 });

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    expect(getUnprocessedMessages).toHaveBeenCalledTimes(1);
    expect(extractFacts).toHaveBeenCalledTimes(1);
    expect(validateFacts).toHaveBeenCalledTimes(1);
    expect(upsertFacts).toHaveBeenCalledTimes(1);
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
      senderJid: '15184194479@s.whatsapp.net',
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
    expect(upsertFacts).not.toHaveBeenCalled();
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

    const { poller } = makePoller();
    await triggerOneCycle(poller);

    // With empty batch, runCycle returns early before setting lastRunAt
    expect(poller.lastRunAt).toBeNull();
  });
});
