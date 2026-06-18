import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

type MetricName = 'lines' | 'statements' | 'functions' | 'branches';

const METRICS: MetricName[] = ['lines', 'statements', 'functions', 'branches'];

interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

interface CoverageEntry {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

export interface CoverageSummary {
  total: CoverageEntry;
  [filePath: string]: CoverageEntry;
}

export interface CoverageViolation {
  metric: MetricName | 'freshness';
  actual: number;
  expected: number;
  text: string;
}

export interface CoverageShortfall {
  metric: MetricName;
  total: number;
  covered: number;
  requiredCovered: number;
  unitsToThreshold: number;
}

export interface CoverageGap {
  filePath: string;
  uncoveredLines: number;
  uncoveredStatements: number;
  uncoveredFunctions: number;
  uncoveredBranches: number;
  score: number;
  linesPct: number;
  functionsPct: number;
  branchesPct: number;
}

export interface CoverageProofResult {
  ok: boolean;
  summaryPath: string;
  threshold: number;
  ageMinutes: number | null;
  totals: CoverageEntry;
  violations: CoverageViolation[];
  shortfalls: CoverageShortfall[];
  topGaps: CoverageGap[];
}

interface EvaluateOptions {
  summaryPath: string;
  threshold: number;
  maxAgeMinutes?: number;
  top?: number;
  now?: number;
}

interface CliOptions {
  summaryPath: string;
  threshold: number;
  maxAgeMinutes: number;
  top: number;
}

function assertCoverageMetric(value: unknown, label: string): asserts value is CoverageMetric {
  if (!value || typeof value !== 'object') {
    throw new Error(`coverage proof: ${label} is missing`);
  }
  const metric = value as Partial<CoverageMetric>;
  for (const key of ['total', 'covered', 'skipped', 'pct'] as const) {
    if (typeof metric[key] !== 'number' || Number.isNaN(metric[key])) {
      throw new Error(`coverage proof: ${label}.${key} must be a number`);
    }
  }
}

function assertCoverageEntry(value: unknown, label: string): asserts value is CoverageEntry {
  if (!value || typeof value !== 'object') {
    throw new Error(`coverage proof: ${label} is missing`);
  }
  const entry = value as Partial<CoverageEntry>;
  for (const metric of METRICS) assertCoverageMetric(entry[metric], `${label}.${metric}`);
}

export function parseCoverageSummary(text: string): CoverageSummary {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('coverage proof: summary must be a JSON object');
  }
  const summary = parsed as Partial<CoverageSummary>;
  assertCoverageEntry(summary.total, 'total');
  for (const [filePath, entry] of Object.entries(summary)) {
    if (filePath === 'total') continue;
    assertCoverageEntry(entry, filePath);
  }
  return summary as CoverageSummary;
}

function uncovered(metric: CoverageMetric): number {
  return Math.max(0, metric.total - metric.covered);
}

export function largestCoverageGaps(summary: CoverageSummary, top = 12): CoverageGap[] {
  return Object.entries(summary)
    .filter(([filePath]) => filePath !== 'total')
    .map(([filePath, entry]) => {
      const uncoveredLines = uncovered(entry.lines);
      const uncoveredStatements = uncovered(entry.statements);
      const uncoveredFunctions = uncovered(entry.functions);
      const uncoveredBranches = uncovered(entry.branches);
      return {
        filePath,
        uncoveredLines,
        uncoveredStatements,
        uncoveredFunctions,
        uncoveredBranches,
        score: uncoveredLines + uncoveredStatements + uncoveredFunctions * 4 + uncoveredBranches,
        linesPct: entry.lines.pct,
        functionsPct: entry.functions.pct,
        branchesPct: entry.branches.pct,
      };
    })
    .filter((gap) => gap.score > 0)
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, top);
}

export function evaluateCoverageProof(
  summary: CoverageSummary,
  options: EvaluateOptions,
): CoverageProofResult {
  const threshold = options.threshold;
  const violations: CoverageViolation[] = [];
  const shortfalls: CoverageShortfall[] = [];
  for (const metric of METRICS) {
    const total = summary.total[metric].total;
    const covered = summary.total[metric].covered;
    const actual = summary.total[metric].pct;
    if (actual < threshold) {
      const requiredCovered = Math.ceil(total * (threshold / 100));
      violations.push({
        metric,
        actual,
        expected: threshold,
        text: `${metric}: ${actual.toFixed(2)}% < ${threshold.toFixed(2)}%`,
      });
      shortfalls.push({
        metric,
        total,
        covered,
        requiredCovered,
        unitsToThreshold: Math.max(0, requiredCovered - covered),
      });
    }
  }

  let ageMinutes: number | null = null;
  if (options.maxAgeMinutes !== undefined) {
    const stat = statSync(options.summaryPath);
    ageMinutes = Math.max(0, ((options.now ?? Date.now()) - stat.mtimeMs) / 60_000);
    if (ageMinutes > options.maxAgeMinutes) {
      violations.push({
        metric: 'freshness',
        actual: ageMinutes,
        expected: options.maxAgeMinutes,
        text: `coverage summary age ${ageMinutes.toFixed(1)}m > ${options.maxAgeMinutes.toFixed(1)}m`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    summaryPath: options.summaryPath,
    threshold,
    ageMinutes,
    totals: summary.total,
    violations,
    shortfalls,
    topGaps: largestCoverageGaps(summary, options.top),
  };
}

export function formatCoverageProof(result: CoverageProofResult): string {
  const lines = [
    `coverage proof: ${result.ok ? 'PASS' : 'FAIL'}`,
    `summary: ${result.summaryPath}`,
    `threshold: ${result.threshold.toFixed(2)}%`,
  ];
  if (result.ageMinutes !== null) lines.push(`summary_age_minutes: ${result.ageMinutes.toFixed(1)}`);

  lines.push('totals:');
  for (const metric of METRICS) {
    const value = result.totals[metric];
    lines.push(`  ${metric}: ${value.pct.toFixed(2)}% (${value.covered}/${value.total})`);
  }

  if (result.violations.length > 0) {
    lines.push('violations:');
    for (const violation of result.violations) lines.push(`  - ${violation.text}`);
  }

  if (result.shortfalls.length > 0) {
    lines.push('shortfalls_to_threshold:');
    for (const shortfall of result.shortfalls) {
      lines.push(
        `  - ${shortfall.metric}: need ${shortfall.unitsToThreshold} more covered unit(s) (${shortfall.covered}/${shortfall.total} -> ${shortfall.requiredCovered}/${shortfall.total})`,
      );
    }
  }

  if (result.topGaps.length > 0) {
    lines.push('largest_gaps:');
    for (const gap of result.topGaps) {
      lines.push(
        `  - ${gap.filePath}: lines=${gap.uncoveredLines} statements=${gap.uncoveredStatements} functions=${gap.uncoveredFunctions} branches=${gap.uncoveredBranches} pct=L${gap.linesPct.toFixed(2)} F${gap.functionsPct.toFixed(2)} B${gap.branchesPct.toFixed(2)}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function parseNumberFlag(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`coverage proof: ${flag} must be a non-negative number`);
  }
  return parsed;
}

export function parseCliOptions(argv: string[], cwd = process.cwd()): CliOptions {
  const options: CliOptions = {
    summaryPath: path.resolve(cwd, 'coverage/coverage-summary.json'),
    threshold: 99,
    maxAgeMinutes: 120,
    top: 12,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--summary') {
      options.summaryPath = path.resolve(cwd, argv[++index] ?? '');
    } else if (arg === '--threshold') {
      options.threshold = parseNumberFlag(argv[++index], '--threshold');
    } else if (arg === '--max-age-minutes') {
      options.maxAgeMinutes = parseNumberFlag(argv[++index], '--max-age-minutes');
    } else if (arg === '--top') {
      options.top = parseNumberFlag(argv[++index], '--top');
    } else {
      throw new Error(`coverage proof: unknown argument ${arg}`);
    }
  }

  return options;
}

export function run(argv = process.argv.slice(2), cwd = process.cwd()): number {
  try {
    const options = parseCliOptions(argv, cwd);
    if (!existsSync(options.summaryPath)) {
      console.error(`coverage proof: missing summary ${options.summaryPath}; run npm run coverage:proof`);
      return 2;
    }
    const summary = parseCoverageSummary(readFileSync(options.summaryPath, 'utf8'));
    const result = evaluateCoverageProof(summary, options);
    const output = formatCoverageProof(result);
    if (result.ok) {
      process.stdout.write(output);
      return 0;
    }
    process.stderr.write(output);
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run();
}
