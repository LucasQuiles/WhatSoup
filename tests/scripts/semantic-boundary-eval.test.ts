import { describe, expect, it } from 'vitest';

import {
  contentFingerprint,
  evaluateCandidate,
  evaluateBaseline,
  findUnreachableModules,
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

describe('semantic boundary experiment candidate', () => {
  it('distinguishes production edges from tests, comments, strings, and unresolved imports', () => {
    const corpus = loadCorpus();
    const roots = corpus.productionRoots;

    expect(findUnreachableModules(corpus.graphs.integrated, roots, ['src/lib/feature.ts'])).toEqual([]);
    expect(findUnreachableModules(corpus.graphs.testOnly, roots, ['src/lib/feature.ts'])).toEqual([
      'src/lib/feature.ts',
    ]);
    expect(
      findUnreachableModules(corpus.graphs.commentAndString, roots, ['src/lib/feature.ts']),
    ).toEqual(['src/lib/feature.ts']);
    expect(
      findUnreachableModules(corpus.graphs.disconnected, roots, [
        'src/island/a.ts',
        'src/island/b.ts',
      ]),
    ).toEqual(['src/island/a.ts', 'src/island/b.ts']);
    expect(findUnreachableModules(corpus.graphs.literalDynamic, roots, ['src/lib/feature.ts'])).toEqual(
      [],
    );
    expect(
      findUnreachableModules(corpus.graphs.unresolvedDynamic, roots, ['src/lib/feature.ts']),
    ).toEqual(['src/lib/feature.ts']);
  });

  it('canonicalizes path/blob sets independently of record order', () => {
    const left = [
      { status: 'added', path: 'src/b.ts', blobOid: 'bbb' },
      { status: 'modified', path: 'src/a.ts', blobOid: 'aaa' },
    ];
    const right = [...left].reverse();

    expect(contentFingerprint(left)).toBe(contentFingerprint(right));
  });

  it('meets the target on the locked synthetic cases without false blocks', () => {
    const corpus = loadCorpus();
    const syntheticCorpus = {
      ...corpus,
      cases: corpus.cases.filter((item) => item.cohort === 'synthetic'),
    };
    const summary = evaluateCandidate(syntheticCorpus);

    expect(summary.total).toBe(30);
    expect(summary.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(summary.falseBlocks).toBe(0);
    expect(summary.targetMet).toBe(true);
    expect(summary.feedbackCompleteness).toBe(1);
  });

  it('renders evidence, correction, rerun, and source references for interventions', () => {
    const corpus = loadCorpus();
    const syntheticCorpus = {
      ...corpus,
      cases: corpus.cases.filter((item) => item.id === 'synthetic-semantic-test-only'),
    };
    const summary = evaluateCandidate(syntheticCorpus);
    const receipt = summary.receipts[0];

    expect(receipt?.decision).toBe('block');
    expect(receipt?.findings[0]).toMatchObject({
      ruleId: 'semantic.production-reachability',
      action: 'push',
      rerun: 'npm run verify:semantic',
    });
    expect(receipt?.findings[0]?.observed.map((item) => item.value).join(' ')).toContain(
      'src/lib/feature.ts',
    );
    expect(receipt?.findings[0]?.correction.length).toBeGreaterThan(0);
    expect(receipt?.findings[0]?.sourceRefs).toEqual(['fixture:graphs.testOnly']);
  });
});
