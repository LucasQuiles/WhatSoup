import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhatSoupError as AppError } from '../../../../src/errors.ts';

// Mock index methods — set up before mock factory so factory can reference them
const mockSearchRecords = vi.fn();
const mockUpsertRecords = vi.fn();
const mockRerank = vi.fn();
const mockIndex = {
  searchRecords: mockSearchRecords,
  upsertRecords: mockUpsertRecords,
};

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

import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeMemory, MemoryRecord } from '../../../../src/runtimes/chat/providers/pinecone.ts';
import * as configModule from '../../../../src/config.ts';

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
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
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
    MockPinecone.mockImplementation(function (this: InstanceType<typeof Pinecone>) {
      (this as unknown as { index: unknown }).index = vi.fn().mockReturnValue(mockIndex);
      (this as unknown as { inference: unknown }).inference = { rerank: mockRerank };
    });
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
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('rec-001');
      expect(results[0].score).toBe(0.92);
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
      const rec = results[0].record;
      expect(rec.chatJid).toBe('chat-x@g.us');
      expect(rec.senderJid).toBe('sender-x@s.whatsapp.net');
      expect(rec.senderName).toBe('Bob');
      expect(rec.memoryType).toBe('preference');
      expect(rec.confidence).toBe(0.77);
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
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('rec-a');
      expect(results[1].id).toBe('rec-b');
      expect(results[2].id).toBe('rec-c');
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

    it('returns empty array (does NOT throw) on search failure', async () => {
      mockSearchRecords.mockRejectedValueOnce(new Error('Pinecone down'));
      await expect(memory.search('query', {}, 5)).resolves.toEqual([]);
    });

    it('never throws on search failure', async () => {
      mockSearchRecords.mockRejectedValueOnce(new Error('network error'));
      let threw = false;
      try {
        await memory.search('query', {}, 5);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });
  });

  // ── upsert ────────────────────────────────────────────────────────────────

  describe('upsert', () => {
    it('calls upsertRecords with snake_case fields', async () => {
      mockUpsertRecords.mockResolvedValueOnce(undefined);
      await memory.upsert([makeMemoryRecord()]);
      expect(mockUpsertRecords).toHaveBeenCalledOnce();
      const callArg = mockUpsertRecords.mock.calls[0][0];
      const record = callArg.records[0];
      expect(record.chat_jid).toBe('chat-1@g.us');
      expect(record.sender_jid).toBe('sender-1@s.whatsapp.net');
      expect(record.sender_name).toBe('Alice');
      expect(record.memory_type).toBe('user_fact');
      expect(record.created_at).toBe('2026-01-01T00:00:00Z');
      expect(record.updated_at).toBe('2026-01-01T00:00:00Z');
    });

    it('maps record id to _id field', async () => {
      mockUpsertRecords.mockResolvedValueOnce(undefined);
      await memory.upsert([makeMemoryRecord({ id: 'my-id-123' })]);
      const callArg = mockUpsertRecords.mock.calls[0][0];
      expect(callArg.records[0]._id).toBe('my-id-123');
    });

    it('strips null values from upserted records', async () => {
      mockUpsertRecords.mockResolvedValueOnce(undefined);
      // superseded is an empty string but never null — but confidence being 0 is valid
      const record = makeMemoryRecord({ superseded: '' });
      await memory.upsert([record]);
      const callArg = mockUpsertRecords.mock.calls[0][0];
      const pineconeRecord = callArg.records[0];
      const hasNullOrUndefined = Object.values(pineconeRecord).some(
        (v) => v === null || v === undefined,
      );
      expect(hasNullOrUndefined).toBe(false);
    });

    it('does NOT make API call for empty records array', async () => {
      await memory.upsert([]);
      expect(mockUpsertRecords).not.toHaveBeenCalled();
    });

    it('throws AppError with code PINECONE_UNAVAILABLE on upsert failure', async () => {
      mockUpsertRecords.mockRejectedValueOnce(new Error('write failed'));
      mockUpsertRecords.mockRejectedValueOnce(new Error('write failed'));
      await expect(memory.upsert([makeMemoryRecord()])).rejects.toMatchObject({
        code: 'PINECONE_UNAVAILABLE',
      });
    });

    it('throws AppError (not generic Error) on upsert failure', async () => {
      mockUpsertRecords.mockRejectedValueOnce(new Error('write failed'));
      mockUpsertRecords.mockRejectedValueOnce(new Error('write failed'));
      await expect(memory.upsert([makeMemoryRecord()])).rejects.toBeInstanceOf(AppError);
    });

    it('upserts multiple records in one call', async () => {
      mockUpsertRecords.mockResolvedValueOnce(undefined);
      await memory.upsert([
        makeMemoryRecord({ id: 'r1' }),
        makeMemoryRecord({ id: 'r2' }),
      ]);
      const callArg = mockUpsertRecords.mock.calls[0][0];
      expect(callArg.records).toHaveLength(2);
    });
  });

  // ── checkDuplicate ────────────────────────────────────────────────────────

  describe('checkDuplicate', () => {
    it('returns isDuplicate: true when score >= 0.95', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('dup-id', 0.97)] },
      });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'same text');
      expect(result.isDuplicate).toBe(true);
    });

    it('returns existingId and score when duplicate found', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('existing-123', 0.96)] },
      });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'same text');
      expect(result.existingId).toBe('existing-123');
      expect(result.score).toBe(0.96);
    });

    it('returns isDuplicate: true at exactly the threshold (0.95)', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('exact-threshold', 0.95)] },
      });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'text');
      expect(result.isDuplicate).toBe(true);
    });

    it('returns isDuplicate: false when score < 0.95', async () => {
      mockSearchRecords.mockResolvedValueOnce({
        result: { hits: [makePineconeHit('low-score', 0.94)] },
      });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'different text');
      expect(result.isDuplicate).toBe(false);
    });

    it('returns isDuplicate: false when no results found', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'new text');
      expect(result.isDuplicate).toBe(false);
    });

    it('returns isDuplicate: false (gracefully) when search throws', async () => {
      mockSearchRecords.mockRejectedValueOnce(new Error('search failure'));
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'some text');
      expect(result.isDuplicate).toBe(false);
    });

    it('does not include existingId when isDuplicate is false', async () => {
      mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });
      const result = await memory.checkDuplicate('chat-1@g.us', 'sender-1@s.whatsapp.net', 'text');
      expect(result.existingId).toBeUndefined();
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
    MockPinecone.mockImplementation(function (this: InstanceType<typeof Pinecone>) {
      (this as unknown as { index: unknown }).index = vi.fn().mockReturnValue(mockIndex);
      (this as unknown as { inference: unknown }).inference = { rerank: mockRerank };
    });
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

    expect(mockSearchRecords).toHaveBeenCalledOnce();
    const callArg = mockSearchRecords.mock.calls[0][0];
    expect(callArg.query.filter).toEqual({ source: { $ne: 'archive_db' } });
  });

  it('searchEntities does NOT include chat_jid or sender_jid in the filter', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    await memory.searchEntities('find building');

    const callArg = mockSearchRecords.mock.calls[0][0];
    const filterKeys = Object.keys(callArg.query.filter ?? {});
    expect(filterKeys).not.toContain('chat_jid');
    expect(filterKeys).not.toContain('sender_jid');
  });

  it('searchEntities passes topK from config.pineconeTopK', async () => {
    mutableConfig.pineconeTopK = 15;
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    await memory.searchEntities('query');

    const callArg = mockSearchRecords.mock.calls[0][0];
    expect(callArg.query.topK).toBe(15);
  });

  it('searchEntities skips client-side rerank when config.pineconeRerank is false', async () => {
    mutableConfig.pineconeRerank = false;
    mockSearchRecords.mockResolvedValueOnce({
      result: { hits: [makeEntityHit('ent-1', 0.85)] },
    });

    await memory.searchEntities('query');

    expect(mockRerank).not.toHaveBeenCalled();
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

    expect(mockRerank).toHaveBeenCalledOnce();
    const rerankArg = mockRerank.mock.calls[0][0];
    expect(rerankArg.model).toBe('pinecone-rerank-v0');
    expect(rerankArg.rankFields).toEqual(['text']);
    expect(rerankArg.topN).toBe(6);
    // Results should be reordered by rerank scores
    expect(results[0].id).toBe('ent-2');
    expect(results[0].score).toBe(0.95);
    expect(results[1].id).toBe('ent-1');
    expect(results[1].score).toBe(0.80);
  });

  it('searchEntities returns empty array on API failure without throwing', async () => {
    mockSearchRecords.mockRejectedValueOnce(new Error('entity index down'));

    const result = await memory.searchEntities('query');

    expect(result).toEqual([]);
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

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.id).toBe('bld-001');
    expect(r.score).toBe(0.91);
    expect(r.record.entityType).toBe('building');
    expect(r.record.source).toBe('crm');
    expect(r.record.text).toBe('BUILDING: 1240 Westchester Ave');
  });

  it('fromPineconeHitEntity maps invoice fields correctly', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          makeEntityHit('inv-001', 0.88, {
            text: 'CUSTOMER: 370 CPW...',
            entity_type: 'invoice',
            source: 'erp',
            invoice_num: '17088',
          }),
        ],
      },
    });

    const results = await memory.searchEntities('invoice 17088');

    const r = results[0];
    expect(r.record.entityType).toBe('invoice');
    expect(r.record.text).toBe('CUSTOMER: 370 CPW...');
  });

  it('fromPineconeHitEntity maps contact fields correctly', async () => {
    mockSearchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          makeEntityHit('con-001', 0.85, {
            text: 'CONTACT/CUSTOMER: LOGICAL BUILDINGS',
            entity_type: 'contact',
            source: 'crm',
            contact_name: 'LOGICAL BUILDINGS',
          }),
        ],
      },
    });

    const results = await memory.searchEntities('logical buildings');

    const r = results[0];
    expect(r.record.entityType).toBe('contact');
    expect(r.record.text).toBe('CONTACT/CUSTOMER: LOGICAL BUILDINGS');
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

    const meta = results[0].record.metadata;
    expect(meta['address']).toBe('1240 Westchester Ave');
    expect(meta['floor_count']).toBe(12);
    // Reserved fields must NOT appear in metadata
    expect(meta['text']).toBeUndefined();
    expect(meta['entity_type']).toBeUndefined();
    expect(meta['source']).toBeUndefined();
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

    expect(results[0].record.entityType).toBe('unknown');
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

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('dup-id');
    expect(results[0].record.text).toBe('first occurrence');
    expect(results[1].id).toBe('other-id');
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

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
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

    const notesResults = results.filter((r) => r.record.entityType === 'notes');
    expect(notesResults).toHaveLength(2);
    expect(results.find((r) => r.record.text.includes('should be dropped'))).toBeUndefined();
    // Non-notes entities pass through unaffected
    expect(results.find((r) => r.record.entityType === 'building')).toBeDefined();
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

    expect(results).toHaveLength(2);
  });

  it('searchEntities returns empty array when hits is empty', async () => {
    mockSearchRecords.mockResolvedValueOnce({ result: { hits: [] } });

    const results = await memory.searchEntities('nothing');

    expect(results).toEqual([]);
  });
});
