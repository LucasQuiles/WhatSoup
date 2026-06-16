import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface CoverageMetric {
  pct: number;
}

interface CoverageSummary {
  total?: {
    lines?: CoverageMetric;
    branches?: CoverageMetric;
    functions?: CoverageMetric;
    statements?: CoverageMetric;
  };
}

const THRESHOLDS = {
  lines: 88,
  branches: 80,
  functions: 87,
} as const;

const MIN_HEADROOM_POINTS = 2;

type EnforcedMetric = keyof typeof THRESHOLDS;

function readSummary(cwd: string): CoverageSummary {
  const file = path.join(cwd, 'coverage', 'coverage-summary.json');
  return JSON.parse(readFileSync(file, 'utf8')) as CoverageSummary;
}

export function checkCoverageHeadroom(cwd = process.cwd()): string[] {
  const summary = readSummary(cwd);
  const findings: string[] = [];

  for (const metric of Object.keys(THRESHOLDS) as EnforcedMetric[]) {
    const threshold = THRESHOLDS[metric];
    const pct = summary.total?.[metric]?.pct;
    if (typeof pct !== 'number') {
      findings.push(`${metric}: missing coverage percentage`);
      continue;
    }

    const headroom = pct - threshold;
    if (headroom < MIN_HEADROOM_POINTS) {
      findings.push(`${metric}: pct=${pct.toFixed(2)} threshold=${threshold} headroom=${headroom.toFixed(2)} < ${MIN_HEADROOM_POINTS}`);
    }
  }

  return findings;
}

export function run(cwd = process.cwd()): string[] {
  const findings = checkCoverageHeadroom(cwd);
  if (findings.length > 0) {
    console.error('coverage headroom guard failed');
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
  } else {
    console.log('coverage headroom guard passed');
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
