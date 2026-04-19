import { describe, it, expect } from 'vitest';
import { clusterMemories, consolidateCluster } from '../../src/memory/consolidation.ts';
import type { MemoryCluster } from '../../src/memory/types.ts';

describe('clusterMemories', () => {
  it('groups records with overlapping keywords', () => {
    const records = [
      { id: '1', text: 'Lives in London', claim: 'Lives in London', createdAt: '2026-04-01', confidence: 0.9, evidence: 'said so' },
      { id: '2', text: 'Works at Acme Corp', claim: 'Works at Acme Corp', createdAt: '2026-04-02', confidence: 0.8, evidence: '' },
      { id: '3', text: 'Moved to London last year', claim: 'Lives in London', createdAt: '2026-04-03', confidence: 0.85, evidence: 'mentioned' },
    ];

    const clusters = clusterMemories(records);
    // Records 1 and 3 share "london" and "lives" — should cluster together
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const londonCluster = clusters.find((c) => c.records.some((r) => r.id === '1'));
    expect(londonCluster).toBeDefined();
    expect(londonCluster!.records.some((r) => r.id === '3')).toBe(true);
  });

  it('returns empty for empty input', () => {
    expect(clusterMemories([])).toEqual([]);
  });

  it('puts unrelated records in separate clusters', () => {
    const records = [
      { id: '1', text: 'Lives in London', claim: 'Lives in London', createdAt: '2026-04-01', confidence: 0.9, evidence: '' },
      { id: '2', text: 'Prefers dark chocolate', claim: 'Prefers dark chocolate', createdAt: '2026-04-02', confidence: 0.8, evidence: '' },
    ];
    const clusters = clusterMemories(records);
    expect(clusters).toHaveLength(2);
  });
});

describe('consolidateCluster', () => {
  it('promotes a repeated pattern', async () => {
    const mockProvider = {
      name: 'mock',
      generate: async () => ({
        content: JSON.stringify({
          durableKnowledge: [{
            claim: 'User lives in London',
            promotionReason: 'Mentioned across 3 sessions over 2 weeks',
            confidence: 0.92,
            sourceRecordIds: ['1', '3'],
          }],
          discarded: [{
            recordId: '2',
            reason: 'Single mention, not a lasting pattern',
          }],
        }),
        inputTokens: 100,
        outputTokens: 50,
        model: 'mock',
        durationMs: 10,
      }),
    };

    const cluster: MemoryCluster = {
      topic: 'location',
      records: [
        { id: '1', text: 'Lives in London', claim: 'Lives in London', createdAt: '2026-04-01', confidence: 0.9, evidence: '' },
        { id: '3', text: 'Moved to London', claim: 'Lives in London', createdAt: '2026-04-03', confidence: 0.85, evidence: '' },
      ],
    };

    const result = await consolidateCluster(mockProvider as any, cluster);
    expect(result.durableKnowledge).toHaveLength(1);
    expect(result.durableKnowledge[0].claim).toBe('User lives in London');
    expect(result.discarded).toHaveLength(1);
  });

  it('returns empty on LLM failure', async () => {
    const mockProvider = {
      name: 'mock',
      generate: async () => { throw new Error('down'); },
    };
    const cluster: MemoryCluster = {
      topic: 'test',
      records: [{ id: '1', text: 'x', claim: 'x', createdAt: '', confidence: 0.5, evidence: '' }],
    };
    const result = await consolidateCluster(mockProvider as any, cluster);
    expect(result.durableKnowledge).toEqual([]);
    expect(result.discarded).toEqual([]);
  });

  it('returns empty for empty cluster', async () => {
    const mockProvider = {
      name: 'mock',
      generate: async () => ({
        content: '{}',
        inputTokens: 10,
        outputTokens: 5,
        model: 'mock',
        durationMs: 5,
      }),
    };
    const cluster: MemoryCluster = { topic: 'empty', records: [] };
    const result = await consolidateCluster(mockProvider as any, cluster);
    expect(result.durableKnowledge).toEqual([]);
  });
});
