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

// Floors are the hard coverage gate (vitest.config.ts coverage.thresholds:
// lines 95 / branches 90 / functions 93). This guard is an EARLY WARNING that
// fires when a metric is within MIN_HEADROOM_POINTS *above* the gate — i.e. before
// coverage:check would break. Keeping the floors below the hard gate (the previous
// 88/80/87) made the guard dead: coverage:check already fails below 95/90/93, so a
// sub-floor warning could never fire first. See QR-audit 2026-07-04.
const THRESHOLDS = {
  lines: 95,
  branches: 90,
  functions: 93,
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
    // Early WARNING only — does not fail the build. The hard coverage gate is
    // coverage:check (vitest thresholds); this guard just flags metrics that have
    // dropped within MIN_HEADROOM_POINTS of that gate so they can be shored up
    // before coverage:check breaks. Never sets a non-zero exit code.
    console.warn('coverage headroom guard: within headroom of the hard gate (warning only)');
    for (const finding of findings) console.warn(finding);
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
