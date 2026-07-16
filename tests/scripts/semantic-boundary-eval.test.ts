import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  contentFingerprint,
  evaluateCandidate,
  evaluateBaseline,
  findUnreachableModules,
  loadCorpus,
  type BoundaryDecision,
} from '../../scripts/experiments/semantic-boundary-eval.ts';
import {
  contentFingerprintSha256,
  type PathBlobRecord,
} from '../../scripts/lib/semantic-quality/fingerprint.ts';

const DECISIONS = new Set<BoundaryDecision>(['pass', 'warn', 'block', 'inconclusive']);
const EVALUATOR_SOURCE = readFileSync(
  fileURLToPath(new URL('../../scripts/experiments/semantic-boundary-eval.ts', import.meta.url)),
  'utf8',
);

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
  it('delegates graph, receipt, fingerprint, history, and provenance decisions to production', () => {
    expect(EVALUATOR_SOURCE).toMatch(/from ["']..\/lib\/semantic-quality\/module-graph\.ts["']/);
    expect(EVALUATOR_SOURCE).toContain('buildModuleGraph');
    expect(EVALUATOR_SOURCE).toContain('analyzeReachability');
    expect(EVALUATOR_SOURCE).toMatch(/from ["']..\/lib\/semantic-quality\/receipt\.ts["']/);
    expect(EVALUATOR_SOURCE).toContain('aggregateBoundaryDecision');
    expect(EVALUATOR_SOURCE).toContain('isBoundaryFindingComplete');
    expect(EVALUATOR_SOURCE).toMatch(/from ["']..\/lib\/semantic-quality\/fingerprint\.ts["']/);
    expect(EVALUATOR_SOURCE).toContain('contentFingerprintSha256');
    expect(EVALUATOR_SOURCE).toMatch(/from ["']..\/lib\/semantic-quality\/history\.ts["']/);
    expect(EVALUATOR_SOURCE).toContain('evaluateHistory');
    expect(EVALUATOR_SOURCE).toMatch(/from ["']..\/lib\/semantic-quality\/provenance\.ts["']/);
    expect(EVALUATOR_SOURCE).toContain('evaluateProvenance');
    expect(EVALUATOR_SOURCE).not.toMatch(/from ["']node:crypto["']/);
    expect(EVALUATOR_SOURCE).not.toContain('function runtimeSpecifiers');
    expect(EVALUATOR_SOURCE).not.toContain('function resolveSpecifier');
    expect(EVALUATOR_SOURCE).not.toContain('function reachableModules');
    expect(EVALUATOR_SOURCE).not.toContain('function isFindingComplete');
    expect(EVALUATOR_SOURCE).not.toMatch(/if \(history\?\.exactMatch\)/);
    expect(EVALUATOR_SOURCE).not.toMatch(/if \(provenance &&/);
    expect(EVALUATOR_SOURCE).not.toMatch(/reentry && !reentry\.ownerOverride/);
  });

  it('distinguishes production edges from tests, comments, strings, and unresolved imports', () => {
    const corpus = loadCorpus();
    const roots = corpus.productionRoots;

    expect(findUnreachableModules(corpus.graphs.integrated, roots, ['src/lib/feature.ts'])).toEqual(
      [],
    );
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
    expect(
      findUnreachableModules(corpus.graphs.literalDynamic, roots, ['src/lib/feature.ts']),
    ).toEqual([]);
    expect(
      findUnreachableModules(corpus.graphs.unresolvedDynamic, roots, ['src/lib/feature.ts']),
    ).toEqual(['src/lib/feature.ts']);
  });

  it('canonicalizes path/blob sets independently of record order', () => {
    const left: PathBlobRecord[] = [
      { status: 'added', path: 'src/b.ts', blobOid: 'b'.repeat(40) },
      { status: 'modified', path: 'src/a.ts', blobOid: 'a'.repeat(40) },
    ];
    const right = [...left].reverse();

    expect(contentFingerprint(left)).toBe(contentFingerprint(right));
    expect(contentFingerprint(left)).toBe(contentFingerprintSha256(left));
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

  it('routes synthetic history and provenance cases through the expected production rules', () => {
    const corpus = loadCorpus();
    const caseIds = new Set([
      'synthetic-history-exact-closed',
      'synthetic-history-exact-open',
      'synthetic-history-subset',
      'synthetic-history-renamed-patch',
      'synthetic-history-path-overlap',
      'synthetic-reentry-cosmetic',
      'synthetic-issue-exact',
      'synthetic-issue-similar',
      'synthetic-provenance-stale-tracking',
      'synthetic-provenance-stale-disjoint',
      'synthetic-provenance-stale-overlap',
      'synthetic-provenance-unavailable',
    ]);
    const summary = evaluateCandidate({
      ...corpus,
      cases: corpus.cases.filter((item) => caseIds.has(item.id)),
    });
    const rules = Object.fromEntries(
      summary.receipts.map((receipt) => [
        receipt.caseId,
        receipt.findings.map((result) => `${result.ruleId}:${result.decision}`),
      ]),
    );

    expect(rules).toEqual({
      'synthetic-history-exact-closed': ['history.exact-closed-pr:block'],
      'synthetic-history-exact-open': ['history.exact-open-pr:block'],
      'synthetic-history-subset': ['history.blob-subset:warn'],
      'synthetic-history-renamed-patch': ['history.renamed-patch-closed-pr:block'],
      'synthetic-history-path-overlap': ['history.path-overlap:warn'],
      'synthetic-reentry-cosmetic': ['history.incomplete-reentry:block'],
      'synthetic-issue-exact': ['history.exact-issue:block'],
      'synthetic-issue-similar': ['history.exact-issue:warn'],
      'synthetic-provenance-stale-tracking': ['provenance.stale-tracking-ref:block'],
      'synthetic-provenance-stale-disjoint': ['provenance.stale-disjoint:warn'],
      'synthetic-provenance-stale-overlap': ['provenance.stale-overlap:block'],
      'synthetic-provenance-unavailable': ['provenance.unavailable:inconclusive'],
    });
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
