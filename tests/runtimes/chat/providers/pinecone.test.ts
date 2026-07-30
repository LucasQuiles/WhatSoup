import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhatSoupError as AppError } from '../../../../src/errors.ts';

// Mock index methods — set up before mock factory so factory can reference them
const mockSearchRecords = vi.fn();
const mockUpsertRecords = vi.fn();
const mockRerank = vi.fn();
const mockPineconeLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockIndex = {
  searchRecords: mockSearchRecords,
  upsertRecords: mockUpsertRecords,
};
const FIXED_NOW_ISO = '2026-01-15T00:00:00.000Z';
const FIXED_NOW_MS = new Date(FIXED_NOW_ISO).getTime();
const DEFAULT_HIT_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 36500;
const DEFAULT_MAX_AGE_DAYS = 36500;
const LN2 = 0.693147;
const MS_PER_DAY = 86_400_000;

function expectedDecayedScore(score: number, createdAt: string = DEFAULT_HIT_TIMESTAMP): number {
  const ageDays = Math.max(0, (FIXED_NOW_MS - new Date(createdAt).getTime()) / MS_PER_DAY);
  if (ageDays > DEFAULT_MAX_AGE_DAYS) return 0;
  return score * Math.exp(-LN2 * ageDays / DEFAULT_RECENCY_HALF_LIFE_DAYS);
}

vi.mock('@pinecone-database/pinecone', () => {
  const MockPinecone = vi.fn();
  return { Pinecone: MockPinecone };
});

vi.mock('../../../../src/config.ts', () => ({
  config: {
    pineconeIndex: 'test-index',
    pineconeContextTopK: 10,
    pineconeSenderTopK: 5,
    enrichmentDedupThreshold: 0.95,
    recencyHalfLifeDays: 36500,   // ~100 years — effectively disable decay in existing tests
    maxAgeDays: 36500,
    memory: {
      pinecone: {
        apiKeyEnv: 'PINECONE_API_KEY',
      },
    },
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => mockPineconeLogger,
}));

import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeMemory, MemoryRecord, decayScore, applyDecay, getPineconeReadiness } from '../../../../src/runtimes/chat/providers/pinecone.ts';
import * as configModule from '../../../../src/config.ts';

let dateNowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
});

afterEach(() => {
  dateNowSpy.mockRestore();
});

function makeMemoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'rec-001',
    text: 'Alice likes coffee',
    chatJid: 'chat-1@g.us',
    senderJid: 'sender-1@s.whatsapp.net',
    senderName: 'Alice',
    memoryType: 'user_fact',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    superseded: '',
    sourceMessagePks: '42',
    ...overrides,
  };
}

function makePineconeHit(id: string, score: number, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    _score: score,
    fields: {
      text: 'sample text',
      chat_jid: 'chat-1@g.us',
      sender_jid: 'sender-1@s.whatsapp.net',
      sender_name: 'Alice',
      memory_type: 'user_fact',
      confidence: 0.85,
      created_at: DEFAULT_HIT_TIMESTAMP,
      updated_at: DEFAULT_HIT_TIMESTAMP,
      superseded: '',
      source_message_pks: '42',
      ...overrides,
    },
  };
}

describe('PineconeMemory', () => {
  let memory: PineconeMemory;

  beforeEach(() => {
    vi.clearAllMocks();
    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
    } as unknown as () => InstanceType<typeof Pinecone>);
    memory = new PineconeMemory();
  });

  // ── search ────────────────────────────────────────────────────────────────

  describe('search', () => {
    it('binds a caller signal to transport fetch without leaking it to another operation', async () => {
      const MockPinecone = vi.mocked(Pinecone);
      const clientConfig = MockPinecone.mock.calls[0][0] as {
        fetchApi?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      };
      expect(clientConfig.fetchApi).toBeTypeOf('function');

      const observedSignals: Array<AbortSignal | null | undefined> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input, init) => {
          observedSignals.push(init?.signal);
          return new Response('{}', { status: 200 });
        },
      );
      mockSearchRecords
        .mockImplementationOnce(async () => {
          await clientConfig.fetchApi?.('https://example.invalid/search');
          return { result: { hits: [] } };
        })
        .mockImplementationOnce(async () => {
          await clientConfig.fetchApi?.('https://example.invalid/search');
          return { result: { hits: [] } };
        });

      const caller = new AbortController();
      await memory.searchDetailed('first', {}, 1, undefined, caller.signal);
      expect(observedSignals[0]?.aborted).toBe(false);
      caller.abort();
      expect(observedSignals[0]?.aborted).toBe(true);

      await memory.searchDetailed('second', {}, 1);
      expect(observedSignals[1]).toBeUndefined();
      fetchSpy.mockRestore();
    });

    it('retries project-guard initialization after a cancelled first check', async () => {
      const mutableConfig = configModule.config as unknown as Record<string, unknown>;
      const previousMemory = mutableConfig.memory;
      const previousBotName = mutableConfig.botName;
      mutableConfig.botName = 'guarded-instance';
      mutableConfig.memory = {
        pinecone: {
          apiKeyEnv: 'PINECONE_API_KEY',
          expectedHostSuffix: '.pinecone.io',
        },
      };
      const listIndexes = vi.fn()
        .mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
        .mockResolvedValueOnce({
          indexes: [{
            name: 'test-index',
            host: 'test-index.svc.pinecone.io',
          }],
        });
      const MockPinecone = vi.mocked(Pinecone);
      MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
        this.index = vi.fn().mockReturnValue(mockIndex);
        this.inference = { rerank: mockRerank };
        this.listIndexes = listIndexes;
      } as unknown as () => InstanceType<typeof Pinecone>);
      memory = new PineconeMemory();
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

      try {
        await expect(memory.searchDetailed('first', {}, 1)).rejects.toThrow();
        await expect(memory.searchDetailed('second', {}, 1)).resolves.toMatchObject({
          status: 'ok',
          results: [],
        });
        expect(listIndexes).toHaveBeenCalledTimes(2);
      } finally {
        mockSearchRecords.mockReset();
        mutableConfig.memory = previousMemory;
        if (previousBotName === undefined) delete mutableConfig.botName;
        else mutableConfig.botName = previousBotName;
      }
    });

    it('times out and replaces a project guard whose transport ignores abort', async () => {
      const nativeSetTimeout = globalThis.setTimeout;
      let guardTimeouts = 0;
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          if (delay === 30_000 && guardTimeouts++ === 0) {
            queueMicrotask(() => callback(...args));
            return 1 as unknown as ReturnType<typeof setTimeout>;
          }
          return nativeSetTimeout(callback, delay, ...args);
        }) as typeof setTimeout,
      );
      const mutableConfig = configModule.config as unknown as Record<string, unknown>;
      const previousMemory = mutableConfig.memory;
      const previousBotName = mutableConfig.botName;
      mutableConfig.botName = 'guarded-instance';
      mutableConfig.memory = {
        pinecone: {
          apiKeyEnv: 'PINECONE_API_KEY',
          expectedHostSuffix: '.pinecone.io',
        },
      };
      const listIndexes = vi.fn()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValueOnce({
          indexes: [{
            name: 'test-index',
            host: 'test-index.svc.pinecone.io',
          }],
        });
      const MockPinecone = vi.mocked(Pinecone);
      MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
        this.index = vi.fn().mockReturnValue(mockIndex);
        this.inference = { rerank: mockRerank };
        this.listIndexes = listIndexes;
      } as unknown as () => InstanceType<typeof Pinecone>);
      memory = new PineconeMemory();
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

      try {
        const first = memory.searchDetailed('first', {}, 1);
        const firstOutcome = await Promise.race([
          first.then(
            () => 'resolved' as const,
            () => 'rejected' as const,
          ),
          new Promise<'hung'>((resolve) => {
            nativeSetTimeout(() => resolve('hung'), 50);
          }),
        ]);
        expect(firstOutcome).toBe('rejected');
        await expect(memory.searchDetailed('second', {}, 1)).resolves.toMatchObject({
          status: 'ok',
          results: [],
        });
        expect(listIndexes).toHaveBeenCalledTimes(2);
      } finally {
        mockSearchRecords.mockReset();
        mutableConfig.memory = previousMemory;
        if (previousBotName === undefined) delete mutableConfig.botName;
        else mutableConfig.botName = previousBotName;
        timeoutSpy.mockRestore();
      }
    });

    it('returns SearchResult array with correct mapping', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: {
          hits: [makePineconeHit('rec-001', 0.92)],
        },
      });
      const results = await memory.search('coffee', {}, 5);
      expect(mockSearchRecords.mock.calls).toEqual([[
        {
          query: {
            topK: 5,
            inputs: { text: 'coffee' },
            filter: {},
          },
          fields: ['*'],
        },
      ]]);
      expect(results).toEqual([
        {
          id: 'rec-001',
          score: expectedDecayedScore(0.92),
          record: {
            id: 'rec-001',
            text: 'sample text',
            chatJid: 'chat-1@g.us',
            senderJid: 'sender-1@s.whatsapp.net',
            senderName: 'Alice',
            memoryType: 'user_fact',
            confidence: 0.85,
            createdAt: DEFAULT_HIT_TIMESTAMP,
            updatedAt: DEFAULT_HIT_TIMESTAMP,
            superseded: '',
            sourceMessagePks: '42',
          },
        },
      ]);
    });

    it('maps hit fields to camelCase record properties', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: {
          hits: [makePineconeHit('rec-002', 0.88, {
            chat_jid: 'chat-x@g.us',
            sender_jid: 'sender-x@s.whatsapp.net',
            sender_name: 'Bob',
            memory_type: 'preference',
            confidence: 0.77,
          })],
        },
      });
      const results = await memory.search('query', {}, 5);
      expect(results).toEqual([
        {
          id: 'rec-002',
          score: expectedDecayedScore(0.88),
          record: {
            id: 'rec-002',
            text: 'sample text',
            chatJid: 'chat-x@g.us',
            senderJid: 'sender-x@s.whatsapp.net',
            senderName: 'Bob',
            memoryType: 'preference',
            confidence: 0.77,
            createdAt: DEFAULT_HIT_TIMESTAMP,
            updatedAt: DEFAULT_HIT_TIMESTAMP,
            superseded: '',
            sourceMessagePks: '42',
          },
        },
      ]);
    });

    it('maps Toulmin metadata fields when present', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: {
          hits: [makePineconeHit('rec-meta', 0.91, {
            promotion_reason: 'grounded by validator',
            claim: 'User lives in London',
            evidence: 'said moved to London',
            warrant: 'direct statement',
            confidence_qualifier: 'stated once',
            contradicts: 'old-rec',
          })],
        },
      });

      const results = await memory.search('query', {}, 5);

      expect(results[0].record).toMatchObject({
        promotionReason: 'grounded by validator',
        claim: 'User lives in London',
        evidence: 'said moved to London',
        warrant: 'direct statement',
        confidenceQualifier: 'stated once',
        contradicts: 'old-rec',
      });
    });

    it('returns multiple results in order', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: {
          hits: [
            makePineconeHit('rec-a', 0.99),
            makePineconeHit('rec-b', 0.80),
            makePineconeHit('rec-c', 0.70),
          ],
        },
      });
      const results = await memory.search('query', {}, 3);
      expect(results.map((r) => ({ id: r.id, score: r.score }))).toEqual([
        { id: 'rec-a', score: expectedDecayedScore(0.99) },
        { id: 'rec-b', score: expectedDecayedScore(0.80) },
        { id: 'rec-c', score: expectedDecayedScore(0.70) },
      ]);
    });

    it('reorders search results by decayed score so older records sink below newer equally-similar records', async () => {
      const mutableConfig = configModule.config as unknown as {
        recencyHalfLifeDays: number;
        maxAgeDays: number;
      };
      const previousHalfLife = mutableConfig.recencyHalfLifeDays;
      const previousMaxAge = mutableConfig.maxAgeDays;
      mutableConfig.recencyHalfLifeDays = 14;
      mutableConfig.maxAgeDays = 90;

      try {
        const now = Date.now();
        const fresh = makePineconeHit('fresh', 0.90, {
          created_at: new Date(now).toISOString(),
        });
        const stale = makePineconeHit('stale', 0.90, {
          created_at: new Date(now - 60 * 86_400_000).toISOString(),
        });

        // Mock returns stale first; search() should apply recency decay and reorder.
        mockSearchRecords.mockResolvedValueOnce({
          result: { hits: [stale, fresh] },
        });

        const out = await memory.search('test query', {}, 2);
        expect(out.map((r) => ({ id: r.id, createdAt: r.record.createdAt }))).toEqual([
          { id: 'fresh', createdAt: fresh.fields.created_at },
          { id: 'stale', createdAt: stale.fields.created_at },
        ]);
      } finally {
        mutableConfig.recencyHalfLifeDays = previousHalfLife;
        mutableConfig.maxAgeDays = previousMaxAge;
      }
    });

    it('context helper searches use their dedicated filters and topK settings', async () => {
      const mutableConfig = configModule.config as unknown as {
        pineconeSelfFactTopK?: number;
      };
      const previousSelfFactTopK = mutableConfig.pineconeSelfFactTopK;
      mutableConfig.pineconeSelfFactTopK = 7;
      try {
        mockSearchRecords
          .mockResolvedValueOnce({ result: { hits: [makePineconeHit('chat-hit', 0.91)] } })
          .mockResolvedValueOnce({ result: { hits: [makePineconeHit('sender-hit', 0.82)] } })
          .mockResolvedValueOnce({ result: { hits: [makePineconeHit('self-hit', 0.73)] } });

        const chatResults = await memory.searchForChat('chat-42@g.us', 'where is the runbook?');
        const senderResults = await memory.searchForSender('sender-17@s.whatsapp.net', 'what does Alice prefer?');
        const selfResults = await memory.searchSelfFacts('what should Q remember about itself?');

        expect(chatResults.map((r) => r.id)).toEqual(['chat-hit']);
        expect(senderResults.map((r) => r.id)).toEqual(['sender-hit']);
        expect(selfResults.map((r) => r.id)).toEqual(['self-hit']);
        expect(mockSearchRecords.mock.calls).toEqual([
          [{
            query: {
              topK: 10,
              inputs: { text: 'where is the runbook?' },
              filter: { chat_jid: { $eq: 'chat-42@g.us' } },
            },
            fields: ['*'],
          }],
          [{
            query: {
              topK: 5,
              inputs: { text: 'what does Alice prefer?' },
              filter: { sender_jid: { $eq: 'sender-17@s.whatsapp.net' } },
            },
            fields: ['*'],
          }],
          [{
            query: {
              topK: 7,
              inputs: { text: 'what should Q remember about itself?' },
              filter: { memory_type: { $eq: 'self_fact' } },
            },
            fields: ['*'],
          }],
        ]);
      } finally {
        mutableConfig.pineconeSelfFactTopK = previousSelfFactTopK;
      }
    });

    it('preserves a successful empty chat lookup through the detailed scoped helper', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

      try {
        await expect(memory.searchForChatDetailed('chat-42@g.us', 'no matching memory')).resolves.toMatchObject({
          results: [],
          status: 'ok',
        });
      } finally {
        mockSearchRecords.mockReset();
      }
    });

    // ── Content-free operation telemetry ────────────────────────────────────

    it('search success log includes bounded counts without candidate ids', async () => {
      const hits = Array.from({ length: 15 }, (_, i) => makePineconeHit(`hit-${i}`, 0.9 - i * 0.01));
      mockSearchRecords.mockResolvedValueOnce({ result: { hits } });

      await memory.search('query', {}, 15);

      const [fields] = mockPineconeLogger.info.mock.calls[0];
      expect(fields).toMatchObject({
        schema: 'whatsoup-memory-operation-v1',
        operation: 'search',
        status: 'completed',
        attempt: 1,
        result_count: 15,
      });
      expect(JSON.stringify(fields)).not.toContain('hit-');
    });

    it('search success log threads a supplied traceId', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [makePineconeHit('hit-1', 0.9)] } });

      await memory.searchDetailed('query', {}, 5, '0123abcd');

      expect(mockPineconeLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ trace_id: '0123abcd' }),
        'memory_operation',
      );
    });

    it('search success log omits traceId when not supplied', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [makePineconeHit('hit-1', 0.9)] } });

      await memory.search('query', {}, 5);

      const [fields] = mockPineconeLogger.info.mock.calls[0];
      expect(fields).not.toHaveProperty('trace_id');
    });

    it('search retry-success log includes attempt count and opaque traceId', async () => {
      mockSearchRecords.mockRejectedValueOnce(new Error('transient'));
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [makePineconeHit('retry-hit', 0.81)] } });

      await memory.searchDetailed('query', {}, 5, '89abcdef');

      expect(mockPineconeLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt: 2,
          result_count: 1,
          trace_id: '89abcdef',
        }),
        'memory_operation',
      );
    });

    it('searchForChat threads a supplied traceId into the completion log without altering the SDK call', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [makePineconeHit('chat-hit', 0.91)] } });

      await memory.searchForChat('chat-42@g.us', 'query', 'abcdef12');

      expect(mockSearchRecords.mock.calls).toEqual([[
        {
          query: {
            topK: 10,
            inputs: { text: 'query' },
            filter: { chat_jid: { $eq: 'chat-42@g.us' } },
          },
          fields: ['*'],
        },
      ]]);
      expect(mockPineconeLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          trace_id: 'abcdef12',
          scope_kind: 'chat',
          filter_shape: 'chat_eq',
        }),
        'memory_operation',
      );
    });

    it('returns empty array when hits is empty', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });
      const results = await memory.search('nothing', {}, 5);
      expect(results).toEqual([]);
    });

    it('returns empty array when hits is undefined', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: {} });
      const results = await memory.search('nothing', {}, 5);
      expect(results).toEqual([]);
    });

    it('returns empty array after retrying search failure once', async () => {
      const expectedCall = {
        query: {
          topK: 5,
          inputs: { text: 'query' },
          filter: {},
        },
        fields: ['*'],
      };
      mockSearchRecords.mockRejectedValueOnce(new Error('Pinecone down'));
      mockSearchRecords.mockRejectedValueOnce(new Error('Pinecone still down'));

      const results = await memory.search('query', {}, 5);

      expect(results).toEqual([]);
      expect(mockSearchRecords.mock.calls).toEqual([[expectedCall], [expectedCall]]);
    });

    it('searchDetailed marks retry-exhausted search failure separately from no matches', async () => {
      mockSearchRecords.mockRejectedValueOnce(new Error('Pinecone down'));
      mockSearchRecords.mockRejectedValueOnce(new Error('Pinecone still down'));

      const details = await memory.searchDetailed('query', {}, 5);

      expect(details).toMatchObject({
        results: [],
        status: 'failed',
        retried: true,
        failureCode: 'unknown',
        retryable: true,
      });
      expect(details).not.toHaveProperty('error');
      expect(details.durationMs).toEqual(expect.any(Number));
    });

    it('returns retry results after transient search failure', async () => {
      const expectedCall = {
        query: {
          topK: 5,
          inputs: { text: 'query' },
          filter: {},
        },
        fields: ['*'],
      };
      mockSearchRecords.mockRejectedValueOnce(new Error('network error'));
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('retry-hit', 0.81)] },
      });

      const results = await memory.search('query', {}, 5);

      expect(results.map((r) => ({ id: r.id, score: r.score }))).toEqual([
        { id: 'retry-hit', score: expectedDecayedScore(0.81) },
      ]);
      expect(mockSearchRecords.mock.calls).toEqual([[expectedCall], [expectedCall]]);
    });

    it('searchDetailed marks retry recovery without losing results', async () => {
      mockSearchRecords.mockRejectedValueOnce(new Error('network error'));
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('retry-hit', 0.81)] },
      });

      const details = await memory.searchDetailed('query', {}, 5);

      expect(details.status).toBe('ok');
      expect(details.retried).toBe(true);
      expect(details.results.map((r) => r.id)).toEqual(['retry-hit']);
    });

    it('skips search for non-q instances without a project guard', async () => {
      (configModule.config as any).botName = 'mini3';
      try {
        const results = await memory.search('query', {}, 5);

        expect(results).toEqual([]);
        expect(mockSearchRecords).not.toHaveBeenCalled();
      } finally {
        delete (configModule.config as any).botName;
      }
    });
  });

  // ── upsert ────────────────────────────────────────────────────────────────

  describe('upsert', () => {
    it('calls upsertRecords with snake_case fields', async () => {
      mockUpsertRecords.mockResolvedValueOnce(undefined);
      await memory.upsert([makeMemoryRecord()]);
      expect(mockUpsertRecords.mock.calls).toEqual([[
        {
          records: [
            {
              _id: 'rec-001',
              text: 'Alice likes coffee',
              chat_jid: 'chat-1@g.us',
              sender_jid: 'sender-1@s.whatsapp.net',
              sender_name: 'Alice',
              memory_type: 'user_fact',
              confidence: 0.9,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              superseded: '',
              source_message_pks: '42',
            },
          ],
        },
      ]]);
    });

    it('blocks upsert for non-q instances without a project guard', async () => {
      (configModule.config as any).botName = 'mini3';
      try {
        await expect(memory.upsert([makeMemoryRecord()])).rejects.toMatchObject({
          code: 'PINECONE_UNAVAILABLE',
        });
        expect(mockUpsertRecords).not.toHaveBeenCalled();
      } finally {
        delete (configModule.config as any).botName;
      }
    });

    it('maps record id to _id field', async () => {
      mockUpsertRecords.mockResolvedValueOnce(undefined);
      await memory.upsert([makeMemoryRecord({ id: 'my-id-123' })]);
      expect(mockUpsertRecords.mock.calls).toEqual([[
        {
          records: [
            {
              _id: 'my-id-123',
              text: 'Alice likes coffee',
              chat_jid: 'chat-1@g.us',
              sender_jid: 'sender-1@s.whatsapp.net',
              sender_name: 'Alice',
              memory_type: 'user_fact',
              confidence: 0.9,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              superseded: '',
              source_message_pks: '42',
            },
          ],
        },
      ]]);
    });

    it('upserts Toulmin metadata fields as snake_case fields', async () => {
      mockUpsertRecords.mockResolvedValueOnce(undefined);
      await memory.upsert([makeMemoryRecord({
        promotionReason: 'grounded by validator',
        claim: 'User lives in London',
        evidence: 'said moved to London',
        warrant: 'direct statement',
        confidenceQualifier: 'stated once',
        contradicts: 'old-rec',
      })]);

      const record = mockUpsertRecords.mock.calls[0][0].records[0];
      expect(record).toMatchObject({
        promotion_reason: 'grounded by validator',
        claim: 'User lives in London',
        evidence: 'said moved to London',
        warrant: 'direct statement',
        confidence_qualifier: 'stated once',
        contradicts: 'old-rec',
      });
    });

    it('strips null values from upserted records', async () => {
      mockUpsertRecords.mockResolvedValueOnce(undefined);
      const record = {
        ...makeMemoryRecord({ confidence: 0 }),
        senderName: undefined,
        superseded: null,
      } as unknown as MemoryRecord;
      await memory.upsert([record]);
      expect(mockUpsertRecords.mock.calls).toEqual([[
        {
          records: [
            {
              _id: 'rec-001',
              text: 'Alice likes coffee',
              chat_jid: 'chat-1@g.us',
              sender_jid: 'sender-1@s.whatsapp.net',
              memory_type: 'user_fact',
              confidence: 0,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              source_message_pks: '42',
            },
          ],
        },
      ]]);
    });

    it('does NOT make API call for empty records array', async () => {
      await memory.upsert([]);
      expect(mockUpsertRecords.mock.calls).toEqual([]);
    });

    it('throws AppError with code PINECONE_UNAVAILABLE on upsert failure', async () => {
      const expectedCall = {
        records: [
          {
            _id: 'rec-001',
            text: 'Alice likes coffee',
            chat_jid: 'chat-1@g.us',
            sender_jid: 'sender-1@s.whatsapp.net',
            sender_name: 'Alice',
            memory_type: 'user_fact',
            confidence: 0.9,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            superseded: '',
            source_message_pks: '42',
          },
        ],
      };
      mockUpsertRecords.mockRejectedValueOnce(new Error('write failed first'));
      mockUpsertRecords.mockRejectedValueOnce(new Error('write failed retry'));

      const error = await memory.upsert([makeMemoryRecord()]).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect({
        isAppError: error instanceof AppError,
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : undefined,
        code: error instanceof AppError ? error.code : undefined,
        retryable: error instanceof AppError ? error.retryable : undefined,
        causeMessage: error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : undefined,
      }).toEqual({
        isAppError: true,
        name: 'WhatSoupError',
        message: 'Pinecone upsert failed',
        code: 'PINECONE_UNAVAILABLE',
        retryable: true,
        causeMessage: 'write failed retry',
      });
      expect(mockUpsertRecords.mock.calls).toEqual([[expectedCall], [expectedCall]]);
    });

    it('throws AppError (not generic Error) on upsert failure', async () => {
      const expectedCall = {
        records: [
          {
            _id: 'rec-001',
            text: 'Alice likes coffee',
            chat_jid: 'chat-1@g.us',
            sender_jid: 'sender-1@s.whatsapp.net',
            sender_name: 'Alice',
            memory_type: 'user_fact',
            confidence: 0.9,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            superseded: '',
            source_message_pks: '42',
          },
        ],
      };
      mockUpsertRecords.mockRejectedValueOnce(new Error('write failed'));
      mockUpsertRecords.mockRejectedValueOnce(new Error('write failed'));

      const error = await memory.upsert([makeMemoryRecord()]).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect({
        isAppError: error instanceof AppError,
        constructorName: error instanceof Error ? error.constructor.name : undefined,
        code: error instanceof AppError ? error.code : undefined,
      }).toEqual({
        isAppError: true,
        constructorName: 'WhatSoupError',
        code: 'PINECONE_UNAVAILABLE',
      });
      expect(mockUpsertRecords.mock.calls).toEqual([[expectedCall], [expectedCall]]);
    });

    it('upserts multiple records in one call', async () => {
      mockUpsertRecords.mockResolvedValueOnce(undefined);
      await memory.upsert([
        makeMemoryRecord({ id: 'r1' }),
        makeMemoryRecord({ id: 'r2' }),
      ]);
      expect(mockUpsertRecords.mock.calls).toEqual([[
        {
          records: [
            {
              _id: 'r1',
              text: 'Alice likes coffee',
              chat_jid: 'chat-1@g.us',
              sender_jid: 'sender-1@s.whatsapp.net',
              sender_name: 'Alice',
              memory_type: 'user_fact',
              confidence: 0.9,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              superseded: '',
              source_message_pks: '42',
            },
            {
              _id: 'r2',
              text: 'Alice likes coffee',
              chat_jid: 'chat-1@g.us',
              sender_jid: 'sender-1@s.whatsapp.net',
              sender_name: 'Alice',
              memory_type: 'user_fact',
              confidence: 0.9,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              superseded: '',
              source_message_pks: '42',
            },
          ],
        },
      ]]);
    });
  });

  // ── checkDuplicate ────────────────────────────────────────────────────────

  describe('checkDuplicate', () => {
    it('returns isDuplicate: true when score >= 0.95', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('dup-id', 0.97)] },
      });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'same text');
      expect(result).toEqual({ isDuplicate: true, existingId: 'dup-id', score: 0.97 });
      expect(mockSearchRecords.mock.calls).toEqual([[
        {
          query: {
            topK: 1,
            inputs: { text: 'same text' },
            filter: {
              chat_jid: { $eq: 'chat-1@g.us' },
              sender_jid: { $eq: 'sender-1@s.whatsapp.net' },
            },
          },
          fields: ['*'],
        },
      ]]);
    });

    it('returns existingId and score when duplicate found', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('existing-123', 0.96)] },
      });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'same text');
      expect(result).toEqual({
        isDuplicate: true,
        existingId: 'existing-123',
        score: 0.96,
      });
    });

    it('returns isDuplicate: true at exactly the threshold (0.95)', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('exact-threshold', 0.95, { created_at: FIXED_NOW_ISO })] },
      });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'text');
      expect(result).toEqual({ isDuplicate: true, existingId: 'exact-threshold', score: 0.95 });
    });

    it('returns isDuplicate: false when score < 0.95', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('low-score', 0.94)] },
      });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'different text');
      expect(result).toEqual({ isDuplicate: false });
    });

    it('returns isDuplicate: false when no results found', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'new text');
      expect(result).toEqual({ isDuplicate: false });
    });

    it('returns isDuplicate: false (gracefully) when search throws', async () => {
      mockSearchRecords.mockRejectedValueOnce(new Error('search failure'));
      mockSearchRecords.mockRejectedValueOnce(new Error('search retry failure'));
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'some text');
      expect(result).toEqual({ isDuplicate: false });
    });

    it('does not include existingId when isDuplicate is false', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'text');
      expect(result).toEqual({ isDuplicate: false });
    });

    it('detects duplicate for old records without decay penalty', async () => {
      const thirtyDaysAgo = new Date(FIXED_NOW_MS - 30 * MS_PER_DAY).toISOString();
      mockSearchRecords.mockResolvedValueOnce({
        result: {
          hits: [makePineconeHit('old-dup', 0.97, {
            created_at: thirtyDaysAgo,
          })],
        },
      });

      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'same old text');

      expect(result).toEqual({ isDuplicate: true, existingId: 'old-dup', score: 0.97 });
    });
  });

  describe('searchClaims', () => {
    it('searches by chat and sender for contradiction candidates', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('claim-hit', 0.82)] },
      });

      const results = await memory.searchClaims('chat-1@g.us', 'sender-1@s.whatsapp.net', 'Lives in London', 5);

      expect(results.map((r) => r.id)).toEqual(['claim-hit']);
      expect(mockSearchRecords.mock.calls).toEqual([[
        {
          query: {
            topK: 5,
            inputs: { text: 'Lives in London' },
            filter: {
              chat_jid: { $eq: 'chat-1@g.us' },
              sender_jid: { $eq: 'sender-1@s.whatsapp.net' },
            },
          },
          fields: ['*'],
        },
      ]]);
    });

    it('returns old contradiction candidates without recency decay filtering', async () => {
      const mutableConfig = configModule.config as unknown as {
        recencyHalfLifeDays: number;
        maxAgeDays: number;
      };
      const previousHalfLife = mutableConfig.recencyHalfLifeDays;
      const previousMaxAge = mutableConfig.maxAgeDays;
      mutableConfig.recencyHalfLifeDays = 14;
      mutableConfig.maxAgeDays = 1;

      try {
        const oldCreatedAt = new Date(FIXED_NOW_MS - 30 * MS_PER_DAY).toISOString();
        mockSearchRecords.mockResolvedValueOnce({
          result: {
            hits: [makePineconeHit('old-claim-hit', 0.88, {
              created_at: oldCreatedAt,
            })],
          },
        });

        const results = await memory.searchClaims('chat-1@g.us', 'sender-1@s.whatsapp.net', 'Lives in London', 5);

        expect(results.map((r) => ({ id: r.id, score: r.score }))).toEqual([
          { id: 'old-claim-hit', score: 0.88 },
        ]);
      } finally {
        mutableConfig.recencyHalfLifeDays = previousHalfLife;
        mutableConfig.maxAgeDays = previousMaxAge;
      }
    });

    it('redacts claim text from failed search logs', async () => {
      const sensitiveClaim = 'Sensitive London address is 221B Baker Street';
      mockSearchRecords.mockRejectedValue(new Error('pinecone unavailable'));

      const results = await memory.searchClaims('chat-1@g.us', 'sender-1@s.whatsapp.net', sensitiveClaim, 5);

      expect(results).toEqual([]);
      const serializedLogs = JSON.stringify(mockPineconeLogger.error.mock.calls);
      expect(serializedLogs).not.toContain(sensitiveClaim);
      expect(serializedLogs).not.toContain('queryHash');
      expect(serializedLogs).not.toContain('queryLength');
      expect(serializedLogs).toContain('whatsoup-memory-operation-v1');
    });
  });
});

// ---------------------------------------------------------------------------
// Entity mode — searchEntities + fromPineconeHitEntity
// ---------------------------------------------------------------------------

function makeEntityHit(
  id: string,
  score: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    _id: id,
    _score: score,
    fields: {
      text: 'BUILDING: 1240 Westchester Ave',
      entity_type: 'building',
      source: 'crm',
      address: '1240 Westchester Ave',
      ...overrides,
    },
  };
}

describe('entity mode', () => {
  let memory: PineconeMemory;
  const mutableConfig = configModule.config as unknown as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Extend the existing config mock with entity-search fields
    mutableConfig.pineconeTopK = 20;
    mutableConfig.pineconeRerank = false;
    mutableConfig.pineconeRerankTopN = 6;

    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
    } as unknown as () => InstanceType<typeof Pinecone>);
    memory = new PineconeMemory();
  });

  afterEach(() => {
    // Remove entity-search fields from shared mock to avoid affecting other tests
    delete mutableConfig.pineconeTopK;
    delete mutableConfig.pineconeRerank;
    delete mutableConfig.pineconeRerankTopN;
  });

  // ── searchEntities — call shape ────────────────────────────────────────────

  it('searchEntities calls searchRecords with source $ne archive_db filter', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    await memory.searchEntities('invoice 17088');

    expect(mockSearchRecords.mock.calls).toEqual([[
      {
        query: {
          topK: 20,
          inputs: { text: 'invoice 17088' },
          filter: { source: { $ne: 'archive_db' } },
        },
        fields: ['*'],
      },
    ]]);
  });

  it('searchEntities does NOT include chat_jid or sender_jid in the filter', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    await memory.searchEntities('find building');

    expect(mockSearchRecords.mock.calls).toEqual([[
      {
        query: {
          topK: 20,
          inputs: { text: 'find building' },
          filter: { source: { $ne: 'archive_db' } },
        },
        fields: ['*'],
      },
    ]]);
  });

  it('searchEntities passes topK from config.pineconeTopK', async () => {
    mutableConfig.pineconeTopK = 15;
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    await memory.searchEntities('query');

    expect(mockSearchRecords.mock.calls).toEqual([[
      {
        query: {
          topK: 15,
          inputs: { text: 'query' },
          filter: { source: { $ne: 'archive_db' } },
        },
        fields: ['*'],
      },
    ]]);
  });

  it('searchEntities skips client-side rerank when config.pineconeRerank is false', async () => {
    mutableConfig.pineconeRerank = false;
    mockSearchRecords.mockResolvedValueOnce({
      result: { hits: [makeEntityHit('ent-1', 0.85)] },
    });

    await memory.searchEntities('query');

    expect(mockRerank.mock.calls).toEqual([]);
  });

  it('searchEntities calls client-side rerank when config.pineconeRerank is true', async () => {
    mutableConfig.pineconeRerank = true;
    mutableConfig.pineconeRerankTopN = 6;
    mockSearchRecords.mockResolvedValueOnce({
      result: { hits: [makeEntityHit('ent-1', 0.85), makeEntityHit('ent-2', 0.70)] },
    });
    mockRerank.mockResolvedValueOnce({
      data: [
        { index: 1, score: 0.95 },
        { index: 0, score: 0.80 },
      ],
    });

    const results = await memory.searchEntities('find contact');

    expect(mockRerank.mock.calls).toEqual([[
      {
        model: 'pinecone-rerank-v0',
        query: 'find contact',
        documents: [
          { id: 'ent-1', text: 'BUILDING: 1240 Westchester Ave' },
          { id: 'ent-2', text: 'BUILDING: 1240 Westchester Ave' },
        ],
        topN: 6,
        rankFields: ['text'],
        returnDocuments: false,
      },
    ]]);
    expect(results).toEqual([
      {
        id: 'ent-2',
        score: 0.95,
        record: {
          id: 'ent-2',
          text: 'BUILDING: 1240 Westchester Ave',
          entityType: 'building',
          source: 'crm',
          metadata: { address: '1240 Westchester Ave' },
        },
      },
      {
        id: 'ent-1',
        score: 0.80,
        record: {
          id: 'ent-1',
          text: 'BUILDING: 1240 Westchester Ave',
          entityType: 'building',
          source: 'crm',
          metadata: { address: '1240 Westchester Ave' },
        },
      },
    ]);
  });

  it('searchEntities returns empty array on API failure without throwing', async () => {
    const expectedCall = {
      query: {
        topK: 20,
        inputs: { text: 'query' },
        filter: { source: { $ne: 'archive_db' } },
      },
      fields: ['*'],
    };
    mockSearchRecords.mockRejectedValueOnce(new Error('entity index down'));
    mockSearchRecords.mockRejectedValueOnce(new Error('entity index still down'));

    const result = await memory.searchEntities('query');

    expect(result).toEqual([]);
    expect(mockSearchRecords.mock.calls).toEqual([[expectedCall], [expectedCall]]);
  });

  it('searchEntitiesDetailed marks retry-exhausted API failure separately from no matches', async () => {
    mockSearchRecords.mockRejectedValueOnce(new Error('entity index down'));
    mockSearchRecords.mockRejectedValueOnce(new Error('entity index still down'));

    const details = await memory.searchEntitiesDetailed('query');

    expect(details).toMatchObject({
      results: [],
      status: 'failed',
      retried: true,
      failureCode: 'unknown',
      retryable: true,
    });
    expect(details).not.toHaveProperty('error');
    expect(details.durationMs).toEqual(expect.any(Number));
  });

  it('searchEntitiesDetailed marks retry recovery without losing entity results', async () => {
    mockSearchRecords.mockRejectedValueOnce(new Error('transient entity index error'));
    mockSearchRecords.mockResolvedValueOnce({
      result: { hits: [makeEntityHit('entity-retry-hit', 0.82)] },
    });

    const details = await memory.searchEntitiesDetailed('query');

    expect(details.status).toBe('ok');
    expect(details.retried).toBe(true);
    expect(details.results.map((r) => r.id)).toEqual(['entity-retry-hit']);
  });

  // ── Content-free operation telemetry ──────────────────────────────────────

  it('searchEntitiesDetailed success log includes counts without candidate ids', async () => {
    const hits = Array.from({ length: 12 }, (_, i) =>
      makeEntityHit(`ent-${i}`, 0.9 - i * 0.01, { entity_type: 'building' }),
    );
    mockSearchRecords.mockResolvedValueOnce({ result: { hits } });

    await memory.searchEntitiesDetailed('query');

    const [fields] = mockPineconeLogger.info.mock.calls[0];
    expect(fields).toMatchObject({
      schema: 'whatsoup-memory-operation-v1',
      operation: 'entity_search',
      status: 'completed',
      result_count: 12,
    });
    expect(JSON.stringify(fields)).not.toContain('ent-');
  });

  it('searchEntitiesDetailed success log threads a supplied traceId', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [makeEntityHit('ent-1', 0.9)] } });

    await memory.searchEntitiesDetailed('query', '1234abcd');

    expect(mockPineconeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: '1234abcd',
        operation: 'entity_search',
      }),
      'memory_operation',
    );
  });

  it('searchEntitiesDetailed success log omits traceId when not supplied', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [makeEntityHit('ent-1', 0.9)] } });

    await memory.searchEntitiesDetailed('query');

    const [fields] = mockPineconeLogger.info.mock.calls[0];
    expect(fields).not.toHaveProperty('trace_id');
  });

  // ── fromPineconeHitEntity — field mapping ──────────────────────────────────

  it('fromPineconeHitEntity maps entity fields correctly (building)', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          makeEntityHit('bld-001', 0.91, {
            text: 'BUILDING: 1240 Westchester Ave',
            entity_type: 'building',
            source: 'crm',
            address: '1240 Westchester Ave',
          }),
        ],
      },
    });

    const results = await memory.searchEntities('Westchester');

    expect(results).toEqual([
      {
        id: 'bld-001',
        score: 0.91,
        record: {
          id: 'bld-001',
          text: 'BUILDING: 1240 Westchester Ave',
          entityType: 'building',
          source: 'crm',
          metadata: { address: '1240 Westchester Ave' },
        },
      },
    ]);
  });

  it('fromPineconeHitEntity maps invoice fields correctly', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          {
            _id: 'inv-001',
            _score: 0.88,
            fields: {
              text: 'CUSTOMER: 370 CPW...',
              entity_type: 'invoice',
              source: 'erp',
              invoice_num: '17088',
            },
          },
        ],
      },
    });

    const results = await memory.searchEntities('invoice 17088');

    expect(results).toEqual([
      {
        id: 'inv-001',
        score: 0.88,
        record: {
          id: 'inv-001',
          text: 'CUSTOMER: 370 CPW...',
          entityType: 'invoice',
          source: 'erp',
          metadata: { invoice_num: '17088' },
        },
      },
    ]);
  });

  it('fromPineconeHitEntity maps contact fields correctly', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          {
            _id: 'con-001',
            _score: 0.85,
            fields: {
              text: 'CONTACT/CUSTOMER: LOGICAL BUILDINGS',
              entity_type: 'contact',
              source: 'crm',
              contact_name: 'LOGICAL BUILDINGS',
            },
          },
        ],
      },
    });

    const results = await memory.searchEntities('logical buildings');

    expect(results).toEqual([
      {
        id: 'con-001',
        score: 0.85,
        record: {
          id: 'con-001',
          text: 'CONTACT/CUSTOMER: LOGICAL BUILDINGS',
          entityType: 'contact',
          source: 'crm',
          metadata: { contact_name: 'LOGICAL BUILDINGS' },
        },
      },
    ]);
  });

  it('fromPineconeHitEntity collects non-reserved fields into metadata', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          makeEntityHit('bld-002', 0.87, {
            entity_type: 'building',
            source: 'crm',
            address: '1240 Westchester Ave',
            floor_count: 12,
          }),
        ],
      },
    });

    const results = await memory.searchEntities('building');

    expect(results).toEqual([
      {
        id: 'bld-002',
        score: 0.87,
        record: {
          id: 'bld-002',
          text: 'BUILDING: 1240 Westchester Ave',
          entityType: 'building',
          source: 'crm',
          metadata: {
            address: '1240 Westchester Ave',
            floor_count: 12,
          },
        },
      },
    ]);
  });

  it('fromPineconeHitEntity defaults entityType to "unknown" when entity_type is missing', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          {
            _id: 'x-001',
            _score: 0.7,
            fields: { text: 'some record' },
          },
        ],
      },
    });

    const results = await memory.searchEntities('unknown entity');

    expect(results).toEqual([
      {
        id: 'x-001',
        score: 0.7,
        record: {
          id: 'x-001',
          text: 'some record',
          entityType: 'unknown',
          source: '',
          metadata: {},
        },
      },
    ]);
  });

  // ── dedup ──────────────────────────────────────────────────────────────────

  it('searchEntities deduplicates by ID, keeping first occurrence', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          makeEntityHit('dup-id', 0.95, { text: 'first occurrence' }),
          makeEntityHit('dup-id', 0.90, { text: 'duplicate occurrence' }),
          makeEntityHit('other-id', 0.80, { text: 'unique record' }),
        ],
      },
    });

    const results = await memory.searchEntities('query');

    expect(results.map((r) => ({ id: r.id, score: r.score, text: r.record.text }))).toEqual([
      { id: 'dup-id', score: 0.95, text: 'first occurrence' },
      { id: 'other-id', score: 0.80, text: 'unique record' },
    ]);
  });

  it('searchEntities dedup: result with no duplicates is returned unchanged', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          makeEntityHit('a', 0.95),
          makeEntityHit('b', 0.90),
          makeEntityHit('c', 0.85),
        ],
      },
    });

    const results = await memory.searchEntities('query');

    expect(results.map((r) => ({ id: r.id, score: r.score }))).toEqual([
      { id: 'a', score: 0.95 },
      { id: 'b', score: 0.90 },
      { id: 'c', score: 0.85 },
    ]);
  });

  // ── notes cap ─────────────────────────────────────────────────────────────

  it('searchEntities caps notes entity_type results at 2', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          makeEntityHit('n1', 0.95, { entity_type: 'notes', text: 'Finance meeting transcript 1' }),
          makeEntityHit('n2', 0.90, { entity_type: 'notes', text: 'Finance meeting transcript 2' }),
          makeEntityHit('n3', 0.85, { entity_type: 'notes', text: 'Finance meeting transcript 3 — should be dropped' }),
          makeEntityHit('b1', 0.80, { entity_type: 'building', text: 'Building record — not capped' }),
        ],
      },
    });

    const results = await memory.searchEntities('finance meeting');

    expect(results.map((r) => ({ id: r.id, entityType: r.record.entityType, text: r.record.text }))).toEqual([
      { id: 'n1', entityType: 'notes', text: 'Finance meeting transcript 1' },
      { id: 'n2', entityType: 'notes', text: 'Finance meeting transcript 2' },
      { id: 'b1', entityType: 'building', text: 'Building record — not capped' },
    ]);
  });

  it('searchEntities keeps all results when notes count is under the cap', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          makeEntityHit('n1', 0.95, { entity_type: 'notes', text: 'Note one' }),
          makeEntityHit('b1', 0.85, { entity_type: 'building', text: 'Building one' }),
        ],
      },
    });

    const results = await memory.searchEntities('query');

    expect(results.map((r) => ({ id: r.id, entityType: r.record.entityType, text: r.record.text }))).toEqual([
      { id: 'n1', entityType: 'notes', text: 'Note one' },
      { id: 'b1', entityType: 'building', text: 'Building one' },
    ]);
  });

  it('searchEntities returns empty array when hits is empty', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    const results = await memory.searchEntities('nothing');

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// decayScore — unit tests for uncovered branches
// ---------------------------------------------------------------------------

describe('decayScore', () => {
  it('returns 0 when similarity is 0', () => {
    expect(decayScore(0, 5, 30)).toBe(0);
  });

  it('returns 0 when similarity is negative', () => {
    expect(decayScore(-0.5, 5, 30)).toBe(0);
  });

  it('returns 0 when ageDays exceeds maxAgeDays', () => {
    expect(decayScore(0.9, 100, 30, 90)).toBe(0);
  });

  it('does not return 0 when ageDays equals maxAgeDays exactly', () => {
    // ageDays === maxAgeDays: NOT strictly greater, so decay is applied
    const result = decayScore(0.9, 90, 30, 90);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(0.9);
  });

  it('returns 0 when halfLifeDays <= 0 and ageDays > 0', () => {
    expect(decayScore(0.8, 1, 0)).toBe(0);
    expect(decayScore(0.8, 5, -1)).toBe(0);
  });

  it('returns similarity unchanged when halfLifeDays <= 0 and ageDays === 0', () => {
    expect(decayScore(0.8, 0, 0)).toBe(0.8);
  });

  it('applies exponential decay for positive halfLife and age', () => {
    const result = decayScore(1.0, 30, 30);
    // After one half-life, score should be ~0.5
    expect(result).toBeCloseTo(0.5, 2);
  });

  it('returns similarity when ageDays === 0', () => {
    expect(decayScore(0.75, 0, 14)).toBeCloseTo(0.75, 10);
  });
});

// ---------------------------------------------------------------------------
// applyDecay — NaN createdAt branch
// ---------------------------------------------------------------------------

describe('applyDecay', () => {
  it('preserves original score when createdAt is invalid (NaN branch)', () => {
    const results = [
      {
        id: 'bad-date',
        score: 0.77,
        record: {
          id: 'bad-date',
          text: 'sample',
          chatJid: `1111111000000000${1}@g.us`,
          senderJid: '15550000001@s.whatsapp.net',
          senderName: 'Tester',
          memoryType: 'user_fact' as const,
          confidence: 0.9,
          createdAt: 'not-a-date',
          updatedAt: '2026-01-01T00:00:00Z',
          superseded: '',
          sourceMessagePks: '1',
        },
      },
    ];
    const out = applyDecay(results, 30, 90);
    // NaN branch: score preserved, no filtering — score=0.77>0 so included
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0.77);
  });

  it('filters out zero-score results after decay', () => {
    const vi_dateNow = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
    try {
      const veryOldDate = new Date(FIXED_NOW_MS - 200 * MS_PER_DAY).toISOString();
      const results = [
        {
          id: 'old-rec',
          score: 0.8,
          record: {
            id: 'old-rec',
            text: 'old',
            chatJid: `1111111000000000${2}@g.us`,
            senderJid: '15550000002@s.whatsapp.net',
            senderName: 'Tester',
            memoryType: 'user_fact' as const,
            confidence: 0.9,
            createdAt: veryOldDate,
            updatedAt: veryOldDate,
            superseded: '',
            sourceMessagePks: '2',
          },
        },
      ];
      // maxAgeDays=100, ageDays=200 → score becomes 0 → filtered
      const out = applyDecay(results, 30, 100);
      expect(out).toHaveLength(0);
    } finally {
      vi_dateNow.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Upsert retry success (lines 655-660): first attempt fails, retry succeeds
// ---------------------------------------------------------------------------

describe('upsert retry success', () => {
  let memory: PineconeMemory;

  beforeEach(() => {
    vi.clearAllMocks();
    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
    } as unknown as () => InstanceType<typeof Pinecone>);
    memory = new PineconeMemory();
  });

  it('succeeds on retry when first upsert attempt fails transiently', async () => {
    mockUpsertRecords
      .mockRejectedValueOnce(new Error('transient write error'))
      .mockResolvedValueOnce(undefined);

    await expect(memory.upsert([{
      id: 'upsert-retry-rec',
      text: 'retry text',
      chatJid: `1111111000000000${5}@g.us`,
      senderJid: '15550000005@s.whatsapp.net',
      senderName: 'Tester',
      memoryType: 'user_fact',
      confidence: 0.9,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      superseded: '',
      sourceMessagePks: '1',
    }])).resolves.toBeUndefined();

    expect(mockUpsertRecords).toHaveBeenCalledTimes(2);
    // Verify the retry success event was emitted.
    expect(mockPineconeLogger.info.mock.calls.some(
      (args: unknown[]) => {
        const event = args[0] as Record<string, unknown>;
        return event.operation === 'upsert' && event.attempt === 2;
      },
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkDuplicate — empty senderJid skips sender_jid filter
// ---------------------------------------------------------------------------

describe('checkDuplicate with empty senderJid', () => {
  let memory: PineconeMemory;

  beforeEach(() => {
    vi.clearAllMocks();
    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
    } as unknown as () => InstanceType<typeof Pinecone>);
    memory = new PineconeMemory();
  });

  it('omits sender_jid filter when senderJid is empty string', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    const result = await memory.checkDuplicate(`1111111000000000${6}@g.us`, '', 'some text');

    expect(result).toEqual({ isDuplicate: false });
    // Verify filter does NOT contain sender_jid
    const callArg = mockSearchRecords.mock.calls[0][0] as { query: { filter: Record<string, unknown> } };
    expect(callArg.query.filter).not.toHaveProperty('sender_jid');
    expect(callArg.query.filter).toHaveProperty('chat_jid');
  });
});

// ---------------------------------------------------------------------------
// searchClaims — empty senderJid skips sender_jid filter
// ---------------------------------------------------------------------------

describe('searchClaims with empty senderJid', () => {
  let memory: PineconeMemory;

  beforeEach(() => {
    vi.clearAllMocks();
    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
    } as unknown as () => InstanceType<typeof Pinecone>);
    memory = new PineconeMemory();
  });

  it('omits sender_jid filter when senderJid is empty string', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    const results = await memory.searchClaims(`1111111000000000${7}@g.us`, '', 'claim text', 5);

    expect(results).toEqual([]);
    const callArg = mockSearchRecords.mock.calls[0][0] as { query: { filter: Record<string, unknown> } };
    expect(callArg.query.filter).not.toHaveProperty('sender_jid');
    expect(callArg.query.filter).toHaveProperty('chat_jid');
  });
});

// ---------------------------------------------------------------------------
// getPineconeReadiness — all branches
// ---------------------------------------------------------------------------

describe('getPineconeReadiness', () => {
  const mockListIndexes = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
      this.listIndexes = mockListIndexes;
    } as unknown as () => InstanceType<typeof Pinecone>);
  });

  it('returns disabled when indexName is empty string', async () => {
    const result = await getPineconeReadiness('   ');
    expect(result).toEqual({ state: 'disabled', index: '' });
  });

  it('returns disabled when PINECONE_API_KEY env is not set', async () => {
    const prev = process.env['PINECONE_API_KEY'];
    delete process.env['PINECONE_API_KEY'];
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'disabled', index: 'test-index' });
    } finally {
      if (prev !== undefined) process.env['PINECONE_API_KEY'] = prev;
    }
  });

  it('returns ready when index found and guard matches', async () => {
    process.env['PINECONE_API_KEY'] = 'test-key-ready';
    mockListIndexes.mockResolvedValueOnce({
      indexes: [{ name: 'test-index', host: 'test-index.svc.pinecone.io' }],
    });
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'ready', index: 'test-index' });
    } finally {
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns index_missing when index not found in list', async () => {
    process.env['PINECONE_API_KEY'] = 'test-key-missing';
    mockListIndexes.mockResolvedValueOnce({ indexes: [] });
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'index_missing', index: 'test-index' });
    } finally {
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns project_mismatch when missingRequiredProjectGuardError fires', async () => {
    const mutableConfig = configModule.config as unknown as Record<string, unknown>;
    mutableConfig.botName = 'mini-bot';
    // No projectId or expectedHostSuffix on config.memory.pinecone
    process.env['PINECONE_API_KEY'] = 'test-key-guard';
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'project_mismatch', index: 'test-index' });
    } finally {
      delete mutableConfig.botName;
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns project_mismatch when index found but host does not match guard', async () => {
    process.env['PINECONE_API_KEY'] = 'test-key-mismatch';
    const mutableConfig = configModule.config as unknown as Record<string, unknown>;
    const prevMemory = mutableConfig.memory;
    mutableConfig.memory = { pinecone: { apiKeyEnv: 'PINECONE_API_KEY', expectedHostSuffix: '.expected-project.pinecone.io' } };
    mockListIndexes.mockResolvedValueOnce({
      indexes: [{ name: 'test-index', host: 'test-index.svc.different-project.pinecone.io' }],
    });
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'project_mismatch', index: 'test-index' });
    } finally {
      mutableConfig.memory = prevMemory;
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns auth_failed when listIndexes throws a 401 error', async () => {
    process.env['PINECONE_API_KEY'] = 'bad-key';
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockListIndexes.mockRejectedValueOnce(authErr);
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'auth_failed', index: 'test-index' });
    } finally {
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns auth_failed when listIndexes throws a 403 error', async () => {
    process.env['PINECONE_API_KEY'] = 'forbidden-key';
    const authErr = Object.assign(new Error('Forbidden'), { status: 403 });
    mockListIndexes.mockRejectedValueOnce(authErr);
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'auth_failed', index: 'test-index' });
    } finally {
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns network_error when listIndexes throws with ECONNREFUSED cause code', async () => {
    process.env['PINECONE_API_KEY'] = 'test-key-econnrefused';
    const netErr = Object.assign(new Error('Connection refused'), {
      cause: { code: 'ECONNREFUSED' },
    });
    mockListIndexes.mockRejectedValueOnce(netErr);
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'network_error', index: 'test-index' });
    } finally {
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns network_error when listIndexes throws with ETIMEDOUT cause code', async () => {
    process.env['PINECONE_API_KEY'] = 'test-key-etimedout';
    const netErr = Object.assign(new Error('Timed out'), {
      cause: { code: 'ETIMEDOUT' },
    });
    mockListIndexes.mockRejectedValueOnce(netErr);
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'network_error', index: 'test-index' });
    } finally {
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns network_error when listIndexes throws an AbortError', async () => {
    process.env['PINECONE_API_KEY'] = 'test-key-abort';
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    mockListIndexes.mockRejectedValueOnce(abortErr);
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'network_error', index: 'test-index' });
    } finally {
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns network_error when listIndexes throws a TypeError', async () => {
    process.env['PINECONE_API_KEY'] = 'test-key-typeerror';
    const typeErr = new TypeError('Failed to fetch');
    mockListIndexes.mockRejectedValueOnce(typeErr);
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'network_error', index: 'test-index' });
    } finally {
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('returns unknown for a generic error rather than misclassifying it as auth_failed', async () => {
    process.env['PINECONE_API_KEY'] = 'test-key-generic';
    mockListIndexes.mockRejectedValueOnce(new Error('some unknown error'));
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'unknown', index: 'test-index' });
    } finally {
      delete process.env['PINECONE_API_KEY'];
    }
  });

  it('uses custom apiKeyEnv from config.memory.pinecone.apiKeyEnv', async () => {
    const mutableConfig = configModule.config as unknown as Record<string, unknown>;
    const prevMemory = mutableConfig.memory;
    mutableConfig.memory = { pinecone: { apiKeyEnv: 'CUSTOM_PINECONE_KEY' } };
    process.env['CUSTOM_PINECONE_KEY'] = 'custom-key-value';
    mockListIndexes.mockResolvedValueOnce({ indexes: [{ name: 'test-index', host: 'host.svc.pinecone.io' }] });
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'ready', index: 'test-index' });
    } finally {
      mutableConfig.memory = prevMemory;
      delete process.env['CUSTOM_PINECONE_KEY'];
    }
  });

  it('falls back to PINECONE_API_KEY when apiKeyEnv is empty string', async () => {
    const mutableConfig = configModule.config as unknown as Record<string, unknown>;
    const prevMemory = mutableConfig.memory;
    mutableConfig.memory = { pinecone: { apiKeyEnv: '   ' } };
    process.env['PINECONE_API_KEY'] = 'fallback-key';
    mockListIndexes.mockResolvedValueOnce({ indexes: [] });
    try {
      const result = await getPineconeReadiness('test-index');
      expect(result).toEqual({ state: 'index_missing', index: 'test-index' });
    } finally {
      mutableConfig.memory = prevMemory;
      delete process.env['PINECONE_API_KEY'];
    }
  });
});

// ---------------------------------------------------------------------------
// Alert clearing — trackSuccess clears alerted operations
// ---------------------------------------------------------------------------

describe('alert clearing on recovery', () => {
  let memory: PineconeMemory;
  const mutableConfig = configModule.config as unknown as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    mutableConfig.botName = 'q'; // q never requires guard
    mutableConfig.pineconeTopK = 20;
    mutableConfig.pineconeRerank = false;
    mutableConfig.pineconeRerankTopN = 6;
    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
    } as unknown as () => InstanceType<typeof Pinecone>);
    memory = new PineconeMemory();
  });

  afterEach(() => {
    delete mutableConfig.botName;
    delete mutableConfig.pineconeTopK;
    delete mutableConfig.pineconeRerank;
    delete mutableConfig.pineconeRerankTopN;
  });

  it('a successful search after 2 prior failures hits trackSuccess (does not trip breaker at 2/3)', async () => {
    // With threshold=3, two double-failures (4 rejects total) record 2 failures.
    // Breaker stays closed. A third search with no failures hits trackSuccess.
    mockSearchRecords
      .mockRejectedValueOnce(new Error('first fail'))
      .mockRejectedValueOnce(new Error('retry fail'))
      .mockRejectedValueOnce(new Error('second first fail'))
      .mockRejectedValueOnce(new Error('second retry fail'))
      .mockResolvedValueOnce({ result: { hits: [] } });

    // Two failures (breaker still closed at 2/3)
    await memory.searchDetailed('trip-1', {}, 1);
    await memory.searchDetailed('trip-2', {}, 1);

    // Third call succeeds — calls trackSuccess (recordSuccess on the breaker)
    const details = await memory.searchDetailed('recover', {}, 1);
    expect(details.status).toBe('ok');
    expect(details.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchEntities — rerank error fallback (line 577-578)
// ---------------------------------------------------------------------------

describe('searchEntities rerank error fallback', () => {
  let memory: PineconeMemory;
  const mutableConfig = configModule.config as unknown as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    mutableConfig.pineconeTopK = 20;
    mutableConfig.pineconeRerank = true;
    mutableConfig.pineconeRerankTopN = 6;
    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
    } as unknown as () => InstanceType<typeof Pinecone>);
    memory = new PineconeMemory();
  });

  afterEach(() => {
    delete mutableConfig.pineconeTopK;
    delete mutableConfig.pineconeRerank;
    delete mutableConfig.pineconeRerankTopN;
  });

  it('falls back to vector scores when rerank call throws', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          { _id: 'e1', _score: 0.88, fields: { text: 'entity one', entity_type: 'building', source: 'crm' } },
          { _id: 'e2', _score: 0.75, fields: { text: 'entity two', entity_type: 'contact', source: 'crm' } },
        ],
      },
    });
    mockRerank.mockRejectedValueOnce(new Error('rerank service unavailable'));

    const results = await memory.searchEntities('query');

    // Should return vector-order results despite rerank failure
    expect(results.map((r) => r.id)).toEqual(['e1', 'e2']);
    expect(results[0].score).toBe(0.88);
    expect(results[1].score).toBe(0.75);
    // A bounded partial rerank event records fallback without exception prose.
    expect(mockPineconeLogger.warn.mock.calls.some(
      (args: unknown[]) => {
        const event = args[0] as Record<string, unknown>;
        return event.operation === 'rerank' &&
          event.status === 'partial' &&
          event.evidence_coverage === 'fallback_scores';
      },
    )).toBe(true);
  });

  it('searchEntities skips rerank call when hits is empty (mapped.length === 0)', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    await memory.searchEntities('empty query');

    // pineconeRerank=true but mapped.length===0 — rerank must not be called
    expect(mockRerank).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker open paths — search, searchEntities, upsert
// NOTE: These tests intentionally trip breakers. They MUST run LAST in this
// file because the breakers object is module-level state that persists for the
// entire test run. Any tests after this block will see open breakers.
// ---------------------------------------------------------------------------

describe('circuit breaker open — must run last', () => {
  let memory: PineconeMemory;

  beforeEach(() => {
    vi.clearAllMocks();
    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
    } as unknown as () => InstanceType<typeof Pinecone>);
    memory = new PineconeMemory();
  });

  it('searchDetailed returns breaker_open status when search breaker trips after 3 failures', async () => {
    // Trip the breaker: threshold=3. Each _searchCoreDetailed: first fail + retry fail = 1 recorded failure.
    // After 3 such calls the 'search' breaker trips to open.
    for (let i = 0; i < 3; i++) {
      mockSearchRecords
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'));
      await memory.searchDetailed(`trip-${i}`, {}, 1);
    }

    // Now breaker is open — next call should short-circuit
    const details = await memory.searchDetailed('blocked', {}, 5);
    expect(details.status).toBe('breaker_open');
    expect(details.results).toEqual([]);
  });

  it('searchEntitiesDetailed returns breaker_open when entity search breaker trips', async () => {
    const mutableConfig = configModule.config as unknown as Record<string, unknown>;
    mutableConfig.pineconeTopK = 20;
    mutableConfig.pineconeRerank = false;
    mutableConfig.pineconeRerankTopN = 6;
    try {
      // Trip the searchEntities breaker (threshold=3)
      for (let i = 0; i < 3; i++) {
        mockSearchRecords
          .mockRejectedValueOnce(new Error('entity fail'))
          .mockRejectedValueOnce(new Error('entity fail retry'));
        await memory.searchEntitiesDetailed(`trip-entity-${i}`);
      }

      const details = await memory.searchEntitiesDetailed('blocked');
      expect(details.status).toBe('breaker_open');
      expect(details.results).toEqual([]);
    } finally {
      delete mutableConfig.pineconeTopK;
      delete mutableConfig.pineconeRerank;
      delete mutableConfig.pineconeRerankTopN;
    }
  });

  it('upsert throws PINECONE_UNAVAILABLE when upsert breaker is open', async () => {
    // Trip the upsert breaker (threshold=3)
    for (let i = 0; i < 3; i++) {
      mockUpsertRecords
        .mockRejectedValueOnce(new Error('upsert fail'))
        .mockRejectedValueOnce(new Error('upsert fail retry'));
      await memory.upsert([{
        id: `trip-${i}`,
        text: 'text',
        chatJid: `1111111000000000${3}@g.us`,
        senderJid: '15550000003@s.whatsapp.net',
        senderName: 'Tester',
        memoryType: 'user_fact',
        confidence: 0.9,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        superseded: '',
        sourceMessagePks: '1',
      }]).catch(() => {});
    }

    // Breaker open — next upsert should throw immediately without calling upsertRecords
    const callsBefore = mockUpsertRecords.mock.calls.length;
    await expect(memory.upsert([{
      id: 'blocked',
      text: 'text',
      chatJid: `1111111000000000${4}@g.us`,
      senderJid: '15550000004@s.whatsapp.net',
      senderName: 'Tester',
      memoryType: 'user_fact',
      confidence: 0.9,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      superseded: '',
      sourceMessagePks: '1',
    }])).rejects.toMatchObject({ code: 'PINECONE_UNAVAILABLE' });
    expect(mockUpsertRecords.mock.calls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// pinecone.ts uncovered-branch coverage
//
// Targets the 18 uncovered branches in src/runtimes/chat/providers/pinecone.ts
// (per coverage report: lines 34, 70, 170, 304-313, 344, 445, 525, 555, 574).
//
// NOTE on breaker state: the `must run last` block above opens the
// `search`, `searchEntities`, `rerank`, and `upsert` breakers. To re-use
// those operations from a fresh `PineconeMemory` instance, the test
// beforeEach advances `Date.now` past the 30s reset window so `isOpen()`
// transitions the breaker to half-open and allows one probe.
// ---------------------------------------------------------------------------

describe('pinecone.ts uncovered-branch coverage', () => {
  let memory: PineconeMemory;
  const mutableConfig = configModule.config as unknown as Record<string, unknown>;
  const mockListIndexes = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // The `must run last` block above opened the `search`, `searchEntities`,
    // and `upsert` breakers (state='open', lastFailureAt=FIXED_NOW_MS).
    // Advance Date.now() past the 30s reset window so `isOpen()` transitions
    // the breaker to half-open and allows one probe.
    dateNowSpy.mockReturnValue(FIXED_NOW_MS + 31_000);
    // Clear the per-test mock queue on the Pinecone API mocks so leftover
    // resolved/rejected values from prior tests don't leak into this test.
    // clearAllMocks() above only clears call history, not the implementation
    // queue — mockReset() is required for that.
    mockSearchRecords.mockReset();
    mockUpsertRecords.mockReset();
    mockRerank.mockReset();
    mockListIndexes.mockReset();
    mutableConfig.pineconeTopK = 20;
    mutableConfig.pineconeRerank = false;
    mutableConfig.pineconeRerankTopN = 6;
    mutableConfig.botName = 'q'; // q does not require a project guard
    const MockPinecone = vi.mocked(Pinecone);
    MockPinecone.mockImplementation(function (this: Record<string, unknown>) {
      this.index = vi.fn().mockReturnValue(mockIndex);
      this.inference = { rerank: mockRerank };
      this.listIndexes = mockListIndexes;
    } as unknown as () => InstanceType<typeof Pinecone>);
    memory = new PineconeMemory();
  });

  afterEach(() => {
    delete mutableConfig.pineconeTopK;
    delete mutableConfig.pineconeRerank;
    delete mutableConfig.pineconeRerankTopN;
    delete mutableConfig.botName;
    delete mutableConfig.memory;
    delete process.env['PINECONE_API_KEY'];
  });

  // ── Bounded failure classification: non-Error branch ─────────────────────

  it('classifies a non-Error upsert failure without serializing it', async () => {
    mockUpsertRecords.mockImplementation(() => {
      throw 'pinecone_string_error';
    });
    const record: MemoryRecord = makeMemoryRecord({ id: 'err-msg-1' });
    await expect(memory.upsert([record])).rejects.toBeInstanceOf(AppError);
    const serializedLogs = JSON.stringify({
      error: mockPineconeLogger.error.mock.calls,
      info: mockPineconeLogger.info.mock.calls,
      warn: mockPineconeLogger.warn.mock.calls,
    });
    expect(serializedLogs).not.toContain('pinecone_string_error');
    expect(mockPineconeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'upsert',
        failure_code: 'unknown',
        retryable: true,
      }),
      'memory_operation',
    );
    // upsertRecords was called exactly twice (initial + retry)
    expect(mockUpsertRecords.mock.calls.length).toBe(2);
  });

  // ── trackSuccess (line 70): clear-alerted branch ──────────────────────────

  it('trackSuccess clears a previously alerted operation on a successful search', async () => {
    // The `must run last` block already pushed `search` into alertedOperations
    // (3 failures → breaker open → alert fired). The beforeEach advances
    // time past the 30s reset window so the breaker transitions to half-open
    // and this single successful call reaches trackSuccess('search'), which
    // hits `if (alertedOperations.has('search'))` → true → clearAlertSourceChecked.
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });
    const details = await memory.searchDetailed('recover', {}, 1);
    expect(details.status).toBe('ok');
    expect(details.results).toEqual([]);
    // Confirm the success path emitted its operation event (proves trackSuccess ran).
    expect(mockPineconeLogger.info.mock.calls.some(
      (args: unknown[]) => {
        const event = args[0] as Record<string, unknown>;
        return event.operation === 'search' && event.status === 'completed';
      },
    )).toBe(true);
  });

  // ── missingRequiredProjectGuardError (line 170): has-guard branch ────────

  it('getPineconeReadiness falls through missingRequiredProjectGuardError when non-q bot has projectId configured', async () => {
    // botName='mini-bot' → pineconeProjectGuardRequired() returns true.
    // projectId='proj-x' → hasPineconeProjectGuard(guard) returns true →
    // missingRequiredProjectGuardError returns null (line 170 true branch).
    // Then the function continues to listIndexes.
    mutableConfig.botName = 'mini-bot';
    mutableConfig.memory = { pinecone: { apiKeyEnv: 'PINECONE_API_KEY', projectId: 'proj-x' } };
    process.env['PINECONE_API_KEY'] = 'test-key-guard';
    mockListIndexes.mockResolvedValueOnce({
      indexes: [{ name: 'test-index', host: 'test-index-proj-x.svc.pinecone.io' }],
    });
    const result = await getPineconeReadiness('test-index');
    // The match for projectId '-proj-x.' inside the host string is satisfied.
    expect(result).toEqual({ state: 'ready', index: 'test-index' });
    // Also verify the host-matching code actually ran (so the branch was reached)
    expect(mockListIndexes).toHaveBeenCalledTimes(1);
  });

  // ── fromPineconeHit (lines 304-313): default-value branches ──────────────

  it('fromPineconeHit defaults every field when hit.fields is an empty object', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          {
            _id: 'rec-defaults',
            _score: 0.5,
            fields: {}, // every field missing → all `??` defaults fire
          },
        ],
      },
    });
    const results = await memory.search('anything', {}, 5);
    expect(results).toEqual([
      {
        id: 'rec-defaults',
        // createdAt defaults to '' → NaN → applyDecay preserves original score (no decay)
        score: 0.5,
        record: {
          id: 'rec-defaults',
          text: '',
          chatJid: '',
          senderJid: '',
          senderName: '',
          memoryType: 'user_fact',
          confidence: 0,
          createdAt: '',
          updatedAt: '',
          superseded: '',
          sourceMessagePks: '',
        },
      },
    ]);
  });

  // ── fromPineconeHitEntity (line 344): text default branch ────────────────

  it('fromPineconeHitEntity defaults text to empty string when fields.text is missing', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          {
            _id: 'ent-notxt',
            _score: 0.42,
            fields: { entity_type: 'building', source: 'crm' }, // no text field
          },
        ],
      },
    });
    const results = await memory.searchEntities('no-text');
    expect(results).toEqual([
      {
        id: 'ent-notxt',
        score: 0.42,
        record: {
          id: 'ent-notxt',
          text: '',
          entityType: 'building',
          source: 'crm',
          metadata: {},
        },
      },
    ]);
  });

  // ── _searchCoreDetailed retry success (line 445): hits undefined on retry ─

  it('searchDetailed retry path treats undefined response.result.hits as empty (line 445 default branch)', async () => {
    mockSearchRecords
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ result: {} }); // hits missing on retry success
    const details = await memory.searchDetailed('q', {}, 3);
    expect(details).toMatchObject({
      results: [],
      status: 'ok',
      retried: true,
    });
    expect(details.durationMs).toEqual(expect.any(Number));
    // Two calls: initial fail + retry
    expect(mockSearchRecords.mock.calls.length).toBe(2);
  });

  // ── searchEntitiesDetailed (line 525): project_guard_failed branch ───────

  it('searchEntitiesDetailed returns project_guard_failed when guard fails on a non-q bot', async () => {
    mutableConfig.botName = 'mini-bot';
    mutableConfig.memory = { pinecone: { apiKeyEnv: 'PINECONE_API_KEY', projectId: 'proj-x' } };
    process.env['PINECONE_API_KEY'] = 'test-key-ent-guard';
    // The PineconeMemory's client.listIndexes will be called by
    // configuredProjectGuardError → pineconeProjectGuardError.
    // Returning an empty list makes the index "missing" → guard error.
    mockListIndexes.mockResolvedValueOnce({ indexes: [] });
    const details = await memory.searchEntitiesDetailed('q');
    expect(details.status).toBe('project_guard_failed');
    expect(details.results).toEqual([]);
    expect(details).toMatchObject({
      failureCode: 'project_guard_failed',
      retryable: false,
    });
    expect(details).not.toHaveProperty('projectGuardError');
    // The underlying searchRecords call must NOT have happened (we short-circuited)
    expect(mockSearchRecords).not.toHaveBeenCalled();
  });

  // ── searchEntitiesDetailed (line 555): hits undefined default branch ──────

  it('searchEntitiesDetailed treats undefined response.result.hits as empty (line 555 default branch)', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: {} }); // hits missing
    const details = await memory.searchEntitiesDetailed('q');
    expect(details.status).toBe('ok');
    expect(details.results).toEqual([]);
    // rerank is not called when hits is empty
    expect(mockRerank).not.toHaveBeenCalled();
  });

  // ── rerank loop (line 574): original undefined branch ───────────────────

  it('searchEntities skips rerank entries that reference a non-existent mapped index (line 574 false branch)', async () => {
    mutableConfig.pineconeRerank = true;
    mutableConfig.pineconeRerankTopN = 6;
    // Two hits, but rerank returns a doc with index=5 (out-of-bounds) AND
    // a valid index=0. The index=5 entry should be silently dropped.
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          makeEntityHit('ent-A', 0.91),
          makeEntityHit('ent-B', 0.72),
        ],
      },
    });
    mockRerank.mockResolvedValueOnce({
      data: [
        { index: 5, score: 0.99 }, // out-of-bounds → `original` undefined → skipped
        { index: 0, score: 0.50 },
      ],
    });
    const results = await memory.searchEntities('rerank-oob');
    // Only the valid rerank entry should be present; ent-A at score 0.50.
    expect(results).toEqual([
      {
        id: 'ent-A',
        score: 0.50,
        record: {
          id: 'ent-A',
          text: 'BUILDING: 1240 Westchester Ave',
          entityType: 'building',
          source: 'crm',
          metadata: { address: '1240 Westchester Ave' },
        },
      },
    ]);
  });
});
