import { describe, it, expect, vi } from 'vitest';
import {
  collapseConsolidationTwins,
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

describe('collapseConsolidationTwins early exit', () => {
  interface Hit { id: string; text: string; score: number }
  const LEGACY = 'durable:0123456789abcdef';
  const SOURCE_SET = `durable:l1:${HEX32}`;

  // Text reaches the text-key function only through `view`, so a view spy
  // that is never called proves no text was read or normalised.
  function collapse(items: Hit[]) {
    const view = vi.fn((hit: Hit) => ({ text: hit.text, scope: 'scope-a', score: hit.score }));
    const result = collapseConsolidationTwins(
      items,
      (hit) => hit.id,
      view,
      (hit, score) => ({ ...hit, score }),
    );
    return { result, view };
  }

  it.each<[string, Hit[]]>([
    ['no source-set id', [
      { id: LEGACY, text: 'fact a', score: 0.9 },
      { id: 'rec-b', text: 'fact a', score: 0.8 },
    ]],
    ['no legacy id', [
      { id: SOURCE_SET, text: 'fact a', score: 0.9 },
      { id: 'rec-b', text: 'fact a', score: 0.8 },
    ]],
    ['nothing (empty list)', []],
  ])('returns the same array and reads no text when the hits hold %s', (_name, items) => {
    const { result, view } = collapse(items);
    expect(result).toBe(items);
    expect(view).not.toHaveBeenCalled();
  });

  it('reads text only for legacy and source-set records once both kinds are present', () => {
    const items: Hit[] = [
      { id: LEGACY, text: 'fact a', score: 0.9 },
      { id: 'rec-b', text: 'fact a', score: 0.8 },
      { id: SOURCE_SET, text: 'fact a', score: 0.7 },
    ];
    const { result, view } = collapse(items);
    expect(view.mock.calls.map(([hit]) => hit.id)).toEqual([LEGACY, SOURCE_SET]);
    expect(result).toEqual([
      { id: SOURCE_SET, text: 'fact a', score: 0.9 },
      { id: 'rec-b', text: 'fact a', score: 0.8 },
    ]);
  });
});
