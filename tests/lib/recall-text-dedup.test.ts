import { describe, it, expect } from 'vitest';
import {
  isLegacyClaimHashRecordId,
  isSourceSetRecordId,
} from '../../src/lib/recall-text-dedup.ts';
import { consolidationLineage } from '../../src/memory/consolidation-lineage.ts';

const HEX32 = '0123456789abcdef0123456789abcdef';

describe('consolidation record id recognisers', () => {
  it('accepts the source-set id the writer builds and nothing that only resembles it', () => {
    const written = consolidationLineage(
      { chatJid: 'chat-a', senderJid: 'sender-a' },
      ['rec-a'],
      new Set(['rec-a']),
    )?.recordId;
    expect([
      written,
      `durable:l1:${HEX32}`,
      'durable:l1:',
      `durable:l1:${HEX32.slice(1)}`,
      `durable:l1:${HEX32}0`,
      `durable:l1:${HEX32.toUpperCase()}`,
      `durable:l2:${HEX32}`,
      `durable:${HEX32.slice(0, 16)}`,
    ].map(isSourceSetRecordId)).toEqual([true, true, false, false, false, false, false, false]);
  });

  it('accepts a legacy claim-hash id of exactly 16 lowercase hex digits only', () => {
    expect([
      'durable:0123456789abcdef',
      'durable:0123456789abcde',
      'durable:0123456789abcdef0',
      'durable:0123456789ABCDEF',
      `durable:l1:${HEX32}`,
      'rec-0123456789abcdef',
    ].map(isLegacyClaimHashRecordId)).toEqual([true, false, false, false, false, false]);
  });
});
