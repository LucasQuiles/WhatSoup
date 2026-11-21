import { describe, it, expect } from 'vitest';
import {
  fromPineconeHit,
  toPineconeRecord,
  type MemoryRecord,
} from '../../../../src/runtimes/chat/providers/pinecone.ts';

// Consolidation lineage at the Pinecone record boundary (#2569). The lineage
// travels as structured fields; it is never parsed from `evidence`.

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'durable:l1:lineage',
    text: 'consolidated claim',
    chatJid: 'chat-1@g.us',
    senderJid: 'sender-1@s.whatsapp.net',
    senderName: 'user-a',
    memoryType: 'user_fact',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    superseded: '',
    sourceMessagePks: '',
    ...overrides,
  };
}

function memoryHit(id: string, fields: Record<string, unknown>) {
  return {
    _id: id,
    _score: 0.9,
    fields: {
      text: 'consolidated claim',
      chat_jid: 'chat-1@g.us',
      sender_jid: 'sender-1@s.whatsapp.net',
      sender_name: 'user-a',
      memory_type: 'user_fact',
      confidence: 0.9,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      superseded: '',
      source_message_pks: '',
      ...fields,
    },
  };
}

describe('Pinecone record boundary: consolidation lineage', () => {
  it('writes the lineage as structured snake_case fields', () => {
    const record = toPineconeRecord(memoryRecord({
      lineageId: 'l1:lineage',
      lineagePolicyVersion: 1,
      sourceRecordIds: ['rec-a', 'rec-b'],
    }));

    expect(record).toMatchObject({
      _id: 'durable:l1:lineage',
      lineage_id: 'l1:lineage',
      lineage_policy_version: 1,
      source_record_ids: ['rec-a', 'rec-b'],
    });
  });

  it('maps the lineage back from a hit and drops a malformed source list', () => {
    const lineage = fromPineconeHit(memoryHit('durable:l1:lineage', {
      lineage_id: 'l1:lineage',
      lineage_policy_version: 1,
      source_record_ids: ['rec-a', 'rec-b'],
    }));
    const malformed = fromPineconeHit(memoryHit('durable:l1:malformed', {
      lineage_id: 'l1:malformed',
      source_record_ids: ['rec-a', 7],
    }));

    expect(lineage.id).toBe('durable:l1:lineage');
    expect(lineage.record).toMatchObject({
      lineageId: 'l1:lineage',
      lineagePolicyVersion: 1,
      sourceRecordIds: ['rec-a', 'rec-b'],
    });
    // Only the malformed list is dropped: the mapped record has no
    // sourceRecordIds key at all, while its lineage id still maps.
    expect(malformed.id).toBe('durable:l1:malformed');
    expect(malformed.record).toStrictEqual({
      ...memoryRecord({ id: 'durable:l1:malformed' }),
      lineageId: 'l1:malformed',
    });
  });
});
