import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BoundaryDecision = 'pass' | 'warn' | 'block' | 'inconclusive';

export interface EvaluationCase {
  id: string;
  cohort: 'visible-pr' | 'synthetic';
  evidence: 'detector-backed' | 'manual-visible' | 'synthetic';
  expected: BoundaryDecision;
  currentDecision: BoundaryDecision;
  rationale: string;
  sourceRefs: string[];
}

interface Corpus {
  schemaVersion: number;
  lockedAt: string;
  primaryMetric: string;
  target: { minimumAccuracy: number; maximumFalseBlocks: number };
  cases: EvaluationCase[];
}

export interface EvaluationSummary {
  engine: 'baseline';
  corpusLockedAt: string;
  primaryMetric: string;
  correct: number;
  total: number;
  accuracy: number;
  falseBlocks: number;
  missedCritical: number;
  targetMet: boolean;
  byCohort: Record<string, { correct: number; total: number; accuracy: number }>;
  byEvidence: Record<string, { correct: number; total: number; accuracy: number }>;
  mismatches: Array<{
    id: string;
    expected: BoundaryDecision;
    predicted: BoundaryDecision;
    sourceRefs: string[];
  }>;
}

const DEFAULT_CORPUS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/semantic-boundary-eval/cases.json',
);

export function loadCorpus(path = DEFAULT_CORPUS): Corpus {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Corpus;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`invalid semantic boundary evaluation corpus: ${path}`);
  }
  return parsed;
}

function groupScore(
  cases: EvaluationCase[],
  field: 'cohort' | 'evidence',
): Record<string, { correct: number; total: number; accuracy: number }> {
  const scores: Record<string, { correct: number; total: number; accuracy: number }> = {};
  for (const item of cases) {
    const key = item[field];
    const score = (scores[key] ??= { correct: 0, total: 0, accuracy: 0 });
    score.total += 1;
    if (item.currentDecision === item.expected) score.correct += 1;
  }
  for (const score of Object.values(scores)) score.accuracy = score.correct / score.total;
  return scores;
}

export function evaluateBaseline(corpus: Corpus): EvaluationSummary {
  const mismatches = corpus.cases
    .filter((item) => item.currentDecision !== item.expected)
    .map((item) => ({
      id: item.id,
      expected: item.expected,
      predicted: item.currentDecision,
      sourceRefs: item.sourceRefs,
    }));
  const correct = corpus.cases.length - mismatches.length;
  const falseBlocks = corpus.cases.filter(
    (item) => item.currentDecision === 'block' && item.expected === 'pass',
  ).length;
  const missedCritical = corpus.cases.filter(
    (item) => item.expected === 'block' && item.currentDecision !== 'block',
  ).length;
  const accuracy = correct / corpus.cases.length;
  return {
    engine: 'baseline',
    corpusLockedAt: corpus.lockedAt,
    primaryMetric: corpus.primaryMetric,
    correct,
    total: corpus.cases.length,
    accuracy,
    falseBlocks,
    missedCritical,
    targetMet:
      accuracy >= corpus.target.minimumAccuracy && falseBlocks <= corpus.target.maximumFalseBlocks,
    byCohort: groupScore(corpus.cases, 'cohort'),
    byEvidence: groupScore(corpus.cases, 'evidence'),
    mismatches,
  };
}

function parseArgs(argv: string[]): { format: 'human' | 'json'; corpusPath?: string } {
  let format: 'human' | 'json' = 'human';
  let corpusPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--format' && argv[index + 1] === 'json') {
      format = 'json';
      index += 1;
    } else if (arg === '--corpus' && argv[index + 1]) {
      corpusPath = resolve(argv[index + 1]);
      index += 1;
    } else if (arg === '--engine' && argv[index + 1] === 'baseline') {
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { format, corpusPath };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const summary = evaluateBaseline(loadCorpus(args.corpusPath));
  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `baseline: ${summary.correct}/${summary.total} correct (${(summary.accuracy * 100).toFixed(1)}%), ` +
      `${summary.falseBlocks} false blocks, ${summary.missedCritical} missed critical cases\n`,
  );
  for (const mismatch of summary.mismatches) {
    process.stdout.write(
      `MISS ${mismatch.id}: expected=${mismatch.expected} predicted=${mismatch.predicted} ` +
        `source=${mismatch.sourceRefs.join(',')}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
