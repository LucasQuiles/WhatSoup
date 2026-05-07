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
import { PineconeMemory, MemoryRecord } from '../../../../src/runtimes/chat/providers/pinecone.ts';
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
      expect(serializedLogs).toContain('queryHash');
      expect(serializedLogs).toContain('queryLength');
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
