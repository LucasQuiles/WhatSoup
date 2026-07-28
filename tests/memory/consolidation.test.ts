import { describe, it, expect, vi } from 'vitest';

const mockConsolidationLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => mockConsolidationLogger,
}));

import { clusterMemories, consolidateCluster } from '../../src/memory/consolidation.ts';
import type { MemoryCluster } from '../../src/memory/types.ts';

function response(content: unknown) {
  return {
    content: typeof content === 'string' ? content : JSON.stringify(content),
    inputTokens: 1,
    outputTokens: 1,
    model: 'mock',
    durationMs: 1,
  };
}

function providerReturning(content: unknown) {
  return {
    name: 'mock',
    generate: vi.fn(async () => response(content)),
  };
}

function oneRecordCluster(): MemoryCluster {
  return {
    topic: 'test',
    records: [{
      id: 'source-1',
      text: 'synthetic memory',
      claim: 'synthetic memory',
      createdAt: '2026-04-01',
      confidence: 0.5,
      evidence: 'synthetic evidence',
    }],
  };
}

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

  it('clusters by text when records lack a claim, tolerating empty text', () => {
    // UNHAPPY: records without a `claim` fall back to `text` for topic + tokenization;
    // an empty-text record must not crash the tokenizer.
    const records = [
      { id: 'a', text: 'enjoys hiking mountain trails', createdAt: '2026-04-01', confidence: 0.9, evidence: '' },
      { id: 'b', text: 'enjoys hiking mountain paths', createdAt: '2026-04-02', confidence: 0.8, evidence: '' },
      { id: 'c', text: '', createdAt: '2026-04-03', confidence: 0.5, evidence: '' },
    ];
    const clusters = clusterMemories(records);
    const hiking = clusters.find((cl) => cl.records.some((r) => r.id === 'a'));
    expect(hiking).toBeDefined();
    expect(hiking!.topic).toContain('enjoys');
    expect(hiking!.records.some((r) => r.id === 'b')).toBe(true);
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
        { id: '2', text: 'One-off appointment', claim: 'One-off appointment', createdAt: '2026-04-02', confidence: 0.5, evidence: '' },
        { id: '3', text: 'Moved to London', claim: 'Lives in London', createdAt: '2026-04-03', confidence: 0.85, evidence: '' },
      ],
    };

    const result = await consolidateCluster(mockProvider as any, cluster);
    expect(result).toMatchObject({
      status: 'completed_promoted',
      failureCode: 'none',
      retryable: false,
      evidenceCoverage: 'provider_response',
    });
    expect(result.durableKnowledge).toHaveLength(1);
    expect(result.durableKnowledge[0].claim).toBe('User lives in London');
    expect(result.discarded).toHaveLength(1);
  });

  it('distinguishes provider failure from a valid empty decision', async () => {
    const mockProvider = {
      name: 'mock',
      generate: async () => { throw new Error('down'); },
    };
    const failed = await consolidateCluster(mockProvider as any, oneRecordCluster());
    const validEmpty = await consolidateCluster(
      providerReturning({ durableKnowledge: [], discarded: [] }) as any,
      oneRecordCluster(),
    );

    expect(failed).toMatchObject({
      status: 'provider_unavailable',
      failureCode: 'unknown',
      retryable: true,
      evidenceCoverage: 'provider_error',
      durableKnowledge: [],
      discarded: [],
    });
    expect(validEmpty).toMatchObject({
      status: 'completed_discarded',
      failureCode: 'none',
      retryable: false,
      evidenceCoverage: 'provider_response',
      durableKnowledge: [],
      discarded: [],
    });
    expect(failed).not.toEqual(validEmpty);
  });

  it('rejects an empty cluster as an invalid scope without calling the provider', async () => {
    const mockProvider = providerReturning({ durableKnowledge: [], discarded: [] });
    const cluster: MemoryCluster = { topic: 'empty', records: [] };
    const result = await consolidateCluster(mockProvider as any, cluster);
    expect(result).toMatchObject({
      status: 'scope_invalid',
      failureCode: 'invalid_request',
      retryable: false,
      evidenceCoverage: 'local_guard',
      durableKnowledge: [],
      discarded: [],
    });
    expect(mockProvider.generate).not.toHaveBeenCalled();
  });

  it('classifies malformed-but-parseable output as output_invalid', async () => {
    const result = await consolidateCluster(
      providerReturning({ durableKnowledge: 'oops', discarded: null }) as any,
      oneRecordCluster(),
    );
    expect(result).toMatchObject({
      status: 'output_invalid',
      failureCode: 'invalid_request',
      retryable: false,
      evidenceCoverage: 'provider_response',
      durableKnowledge: [],
      discarded: [],
    });
  });

  it('classifies unparseable JSON as output_invalid', async () => {
    const result = await consolidateCluster(
      providerReturning('definitely not json {{{') as any,
      oneRecordCluster(),
    );
    expect(result.status).toBe('output_invalid');
  });

  it('distinguishes provider timeout from caller cancellation', async () => {
    const timeoutProvider = {
      name: 'mock',
      generate: async () => {
        throw new DOMException('timed out', 'AbortError');
      },
    };
    const timedOut = await consolidateCluster(timeoutProvider as any, oneRecordCluster());

    const controller = new AbortController();
    controller.abort(new DOMException('stopped', 'AbortError'));
    const cancelledProvider = providerReturning({ durableKnowledge: [], discarded: [] });
    const cancelled = await consolidateCluster(
      cancelledProvider as any,
      oneRecordCluster(),
      { signal: controller.signal },
    );

    expect(timedOut).toMatchObject({
      status: 'provider_timeout',
      failureCode: 'timeout',
      retryable: true,
    });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      failureCode: 'timeout',
      retryable: true,
    });
    expect(cancelledProvider.generate).not.toHaveBeenCalled();
  });

  it.each([
    ['non-finite confidence', {
      durableKnowledge: [{
        claim: 'valid claim',
        promotionReason: 'valid reason',
        confidence: Number.POSITIVE_INFINITY,
        sourceRecordIds: ['source-1'],
      }],
      discarded: [],
    }],
    ['unknown source id', {
      durableKnowledge: [{
        claim: 'valid claim',
        promotionReason: 'valid reason',
        confidence: 0.8,
        sourceRecordIds: ['not-in-cluster'],
      }],
      discarded: [],
    }],
    ['duplicate source id', {
      durableKnowledge: [{
        claim: 'valid claim',
        promotionReason: 'valid reason',
        confidence: 0.8,
        sourceRecordIds: ['source-1', 'source-1'],
      }],
      discarded: [],
    }],
    ['unknown nested key', {
      durableKnowledge: [{
        claim: 'valid claim',
        promotionReason: 'valid reason',
        confidence: 0.8,
        sourceRecordIds: ['source-1'],
        leaked: 'not allowed',
      }],
      discarded: [],
    }],
    ['overlong claim', {
      durableKnowledge: [{
        claim: 'x'.repeat(1025),
        promotionReason: 'valid reason',
        confidence: 0.8,
        sourceRecordIds: ['source-1'],
      }],
      discarded: [],
    }],
    ['too many promoted items', {
      durableKnowledge: Array.from({ length: 33 }, (_, index) => ({
        claim: `claim ${index}`,
        promotionReason: 'valid reason',
        confidence: 0.8,
        sourceRecordIds: ['source-1'],
      })),
      discarded: [],
    }],
  ])('rejects %s with a bounded output_invalid result', async (_name, content) => {
    const result = await consolidateCluster(
      providerReturning(content) as any,
      oneRecordCluster(),
    );
    expect(result).toMatchObject({
      status: 'output_invalid',
      failureCode: 'invalid_request',
      retryable: false,
      durableKnowledge: [],
      discarded: [],
    });
  });

  it('classifies an all-discarded decision separately through its counters', async () => {
    const result = await consolidateCluster(
      providerReturning({
        durableKnowledge: [],
        discarded: [{ recordId: 'source-1', reason: 'transient observation' }],
      }) as any,
      oneRecordCluster(),
    );

    expect(result).toMatchObject({
      status: 'completed_discarded',
      durableKnowledge: [],
      discarded: [{ recordId: 'source-1', reason: 'transient observation' }],
    });
  });

  it('keeps raw provider exceptions and model output bytes out of logs', async () => {
    const forbiddenException = 'private-raw-exception-value';
    const forbiddenOutput = 'private-model-output-value';
    const rejectingProvider = {
      name: 'mock',
      generate: vi.fn(async () => {
        throw new Error(forbiddenException);
      }),
    };

    await consolidateCluster(rejectingProvider as any, oneRecordCluster());
    await consolidateCluster(
      providerReturning(`not-json-${forbiddenOutput}`) as any,
      oneRecordCluster(),
    );

    const serializedLogs = JSON.stringify([
      ...mockConsolidationLogger.info.mock.calls,
      ...mockConsolidationLogger.warn.mock.calls,
      ...mockConsolidationLogger.error.mock.calls,
      ...mockConsolidationLogger.debug.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(forbiddenException);
    expect(serializedLogs).not.toContain(forbiddenOutput);
  });
});
