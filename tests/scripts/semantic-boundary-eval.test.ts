import { describe, expect, it } from 'vitest';

import {
  evaluateBaseline,
  loadCorpus,
  type BoundaryDecision,
} from '../../scripts/experiments/semantic-boundary-eval.ts';

const DECISIONS = new Set<BoundaryDecision>(['pass', 'warn', 'block', 'inconclusive']);

describe('semantic boundary experiment baseline', () => {
  it('loads a locked corpus with sourced labels and unique case ids', () => {
    const corpus = loadCorpus();
    const ids = corpus.cases.map((item) => item.id);

    expect(corpus.lockedAt).toBe('2026-07-15T22:15:00Z');
    expect(corpus.cases).toHaveLength(40);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of corpus.cases) {
      expect(DECISIONS.has(item.expected)).toBe(true);
      expect(DECISIONS.has(item.currentDecision)).toBe(true);
      expect(item.rationale.length).toBeGreaterThan(20);
      expect(item.sourceRefs.length).toBeGreaterThan(0);
    }
  });

  it('scores current-gate decisions without rewriting the labels', () => {
    const summary = evaluateBaseline(loadCorpus());

    expect(summary.total).toBe(40);
    expect(summary.correct).toBeLessThan(summary.total);
    expect(summary.falseBlocks).toBe(0);
    expect(summary.missedCritical).toBeGreaterThan(0);
    expect(summary.byCohort['visible-pr']?.total).toBe(10);
    expect(summary.byEvidence['detector-backed']?.total).toBe(6);
    expect(summary.targetMet).toBe(false);
  });
});
