import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

const { mockLineageLogger } = vi.hoisted(() => ({ mockLineageLogger: {} as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock('../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(mockLineageLogger);
  return { createChildLogger };
});

import { resetLoggerMock } from '../helpers/logger-mock.ts';
import {
  canonicalSourceRecordIds,
  CONSOLIDATION_LINEAGE_POLICY_VERSION,
  consolidationLineage,
} from '../../src/memory/consolidation-lineage.ts';
import { runConsolidation } from '../../src/memory/consolidation-cron.ts';

// Synthetic fixture identities only (#2569 packet section 4).
const CHAT = '1111111000@g.us';
const SENDER = '15550000001@s.whatsapp.net';
const OTHER_SENDER = '15550000002@s.whatsapp.net';
const scope = { chatJid: CHAT, senderJid: SENDER };
const cluster = new Set(['rec-a', 'rec-b', 'rec-c']);

function expectedLineageHash(chatJid: string, senderJid: string, ids: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(['whatsoup.memory-consolidation.lineage', 1, chatJid, senderJid, ids]))
    .digest('hex')
    .slice(0, 32);
}

function sourceHits(ids: string[]) {
  // Identical text puts every source in one cluster.
  return ids.map((id) => ({
    id,
    score: 0.9,
    record: {
      id,
      text: 'SYNTH-2569 tea preference',
      claim: 'SYNTH-2569 tea preference',
      evidence: '',
      createdAt: new Date().toISOString(),
      confidence: 0.9,
      chatJid: CHAT,
      senderJid: SENDER,
    },
  }));
}

function makePinecone(ids: string[]) {
  return {
    searchDetailed: vi.fn().mockResolvedValue({ results: sourceHits(ids), status: 'ok' }),
    upsert: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProvider(output: unknown) {
  return {
    name: 'test-provider',
    generate: vi.fn().mockResolvedValue({
      content: JSON.stringify(output),
      inputTokens: 1,
      outputTokens: 1,
      model: 'test',
      durationMs: 1,
    }),
  };
}

function promote(claim: string, sourceRecordIds: string[]) {
  return { claim, promotionReason: 'SYNTH-2569 repeat', confidence: 0.9, sourceRecordIds };
}

describe('consolidationLineage (#2569 A0)', () => {
  it('is a pure function of scope, the canonical source set and the policy version', () => {
    const hash = expectedLineageHash(CHAT, SENDER, ['rec-a', 'rec-b']);
    const forward = consolidationLineage(scope, ['rec-a', 'rec-b'], cluster);
    expect(forward).toEqual({
      lineageId: `l1:${hash}`,
      recordId: `durable:l1:${hash}`,
      sourceRecordIds: ['rec-a', 'rec-b'],
      policyVersion: 1,
    });
    expect(consolidationLineage(scope, ['rec-b', 'rec-a'], cluster)).toEqual(forward);
    expect(CONSOLIDATION_LINEAGE_POLICY_VERSION).toBe(1);
  });

  it('separates different source sets and different scopes', () => {
    const single = consolidationLineage(scope, ['rec-a'], cluster);
    const pair = consolidationLineage(scope, ['rec-a', 'rec-b'], cluster);
    const otherScope = consolidationLineage({ ...scope, senderJid: OTHER_SENDER }, ['rec-a'], cluster);
    expect(new Set([single?.lineageId, pair?.lineageId, otherScope?.lineageId]).size).toBe(3);
  });

  it.each<[string, string[]]>([
    ['an empty', []],
    ['a foreign', ['rec-a', 'rec-z']],
    ['a duplicated', ['rec-a', 'rec-a']],
  ])('fails closed for %s source set', (_name, ids) => {
    expect(consolidationLineage(scope, ids, cluster)).toBeNull();
  });

  it('orders by code unit, not locale, and leaves the input untouched', () => {
    const input = ['b', 'B', 'a', '_'];
    expect(canonicalSourceRecordIds(input)).toEqual(['B', '_', 'a', 'b']);
    expect(input).toEqual(['b', 'B', 'a', '_']);
  });

  it('keeps the durable: prefix and can never equal a legacy claim-hash id', () => {
    const lineage = consolidationLineage(scope, ['rec-a'], cluster);
    expect(lineage?.recordId.startsWith('durable:')).toBe(true);
    expect(lineage?.recordId).not.toMatch(/^durable:[0-9a-f]{16}$/);
  });
});

describe('runConsolidation lineage identity (#2569 A0)', () => {
  it('gives a wording variant of the same source set the same durable id', async () => {
    const ids: string[] = [];
    for (const output of [
      { durableKnowledge: [promote('SYNTH-2569 likes tea', ['rec-a', 'rec-b'])], discarded: [] },
      { durableKnowledge: [promote('SYNTH-2569 enjoys tea', ['rec-b', 'rec-a'])], discarded: [] },
    ]) {
      const pinecone = makePinecone(['rec-a', 'rec-b']);
      await runConsolidation(pinecone, makeProvider(output), { lookbackDays: 7, dryRun: false });
      expect(pinecone.upsert).toHaveBeenCalledTimes(1);
      ids.push(pinecone.upsert.mock.calls[0][0][0].id);
    }
    const hash = expectedLineageHash(CHAT, SENDER, ['rec-a', 'rec-b']);
    expect(ids).toEqual([`durable:l1:${hash}`, `durable:l1:${hash}`]);
  });

  it('writes structured, canonical lineage and no joined evidence string', async () => {
    const pinecone = makePinecone(['rec-a', 'rec-b']);
    await runConsolidation(
      pinecone,
      makeProvider({ durableKnowledge: [promote('SYNTH-2569 likes tea', ['rec-b', 'rec-a'])], discarded: [] }),
      { lookbackDays: 7, dryRun: false },
    );
    const written = pinecone.upsert.mock.calls[0][0][0];
    const hash = expectedLineageHash(CHAT, SENDER, ['rec-a', 'rec-b']);
    expect(written).toMatchObject({
      id: `durable:l1:${hash}`,
      lineageId: `l1:${hash}`,
      lineagePolicyVersion: 1,
      sourceRecordIds: ['rec-a', 'rec-b'],
      confidenceQualifier: 'consolidated',
    });
    expect(written).not.toHaveProperty('evidence');
  });

  it('writes nothing when two promotions cite the same source set', async () => {
    const pinecone = makePinecone(['rec-a']);
    const report = await runConsolidation(
      pinecone,
      makeProvider({
        durableKnowledge: [
          promote('SYNTH-2569 likes tea', ['rec-a']),
          promote('SYNTH-2569 drinks tea daily', ['rec-a']),
        ],
        discarded: [],
      }),
      { lookbackDays: 7, dryRun: false },
    );
    expect(pinecone.upsert).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: 'failed',
      failureCode: 'output_invalid',
      counters: { writeAttempted: 0, writeConfirmed: 0, failed: 1 },
    });
  });

  it('writes nothing when a source is both promoted and discarded', async () => {
    const pinecone = makePinecone(['rec-a', 'rec-b']);
    const report = await runConsolidation(
      pinecone,
      makeProvider({
        durableKnowledge: [promote('SYNTH-2569 likes tea', ['rec-a', 'rec-b'])],
        discarded: [{ recordId: 'rec-b', reason: 'SYNTH-2569 transient' }],
      }),
      { lookbackDays: 7, dryRun: false },
    );
    expect(pinecone.upsert).not.toHaveBeenCalled();
    expect(report).toMatchObject({ status: 'failed', failureCode: 'output_invalid' });
  });

  // Pin, not a new failure: consolidateCluster already rejects a foreign id on
  // f81a1984 (outputMatchesCluster). A0 must keep that true at the write site.
  it('writes nothing when the model cites a source outside the cluster', async () => {
    const pinecone = makePinecone(['rec-a']);
    const report = await runConsolidation(
      pinecone,
      makeProvider({ durableKnowledge: [promote('SYNTH-2569 likes tea', ['rec-a', 'rec-foreign'])], discarded: [] }),
      { lookbackDays: 7, dryRun: false },
    );
    expect(pinecone.upsert).not.toHaveBeenCalled();
    expect(report).toMatchObject({ status: 'failed', failureCode: 'output_invalid' });
  });

  it('keeps source ids, claims and lineage ids out of run logs', async () => {
    resetLoggerMock(mockLineageLogger);
    const pinecone = makePinecone(['rec-a', 'rec-b']);
    await runConsolidation(
      pinecone,
      makeProvider({
        durableKnowledge: [
          promote('SYNTH-2569 likes tea', ['rec-a']),
          promote('SYNTH-2569 drinks tea daily', ['rec-a']),
        ],
        discarded: [],
      }),
      { lookbackDays: 7, dryRun: false },
    );
    const logs = JSON.stringify(Object.values(mockLineageLogger).map((fn) => fn.mock.calls));
    expect(logs).toContain('consolidation output validation failed');
    expect(logs).not.toContain('rec-a');
    expect(logs).not.toContain('SYNTH-2569');
    expect(logs).not.toContain(CHAT);
    expect(logs).not.toContain(SENDER);
  });
});
