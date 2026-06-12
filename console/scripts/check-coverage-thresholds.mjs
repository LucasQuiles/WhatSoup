#!/usr/bin/env node
// console/scripts/check-coverage-thresholds.mjs
//
// Per-directory coverage ratchet — report-only until the D6 enforcement promotion wave.
// Spec: docs/design-system/06-implementation/test-coverage-audit.md §Coverage ratchet proposal
//
// Consumes a vitest v8 coverage-summary.json, evaluates per-area glob-keyed thresholds,
// and emits a deterministic machine-readable report (sorted keys, no timestamps) with
// per-area actual-vs-threshold and a pass/fail flag per area.
//
// ALWAYS exits 0 in report-only mode (this commit).  Pass --strict to enable enforcement
// exit codes (reserved for the D6 promotion wave; tested but not wired into any gate).
//
// Fail-closed parsing:
//   - missing summary file  -> exit 2, named error "coverage-not-run"
//   - malformed JSON        -> exit 2, named error "parse-error"
//   - wrong schema shape    -> exit 2, named error "schema-error"
//   - below threshold       -> exit 0 (report-only), stderr WARN; exit 1 under --strict
//
// Usage:
//   node console/scripts/check-coverage-thresholds.mjs
//   node console/scripts/check-coverage-thresholds.mjs /path/to/coverage-summary.json
//   node console/scripts/check-coverage-thresholds.mjs --strict   (D6 promotion -- reserved)
//   node console/scripts/check-coverage-thresholds.mjs --strict /path/to/coverage-summary.json
//
// Prerequisites:
//   Run vitest --coverage first; this script only reads the produced JSON:
//     npx vitest run --pool=forks tests/console \
//       --coverage.enabled \
//       --coverage.provider=v8 \
//       --coverage.include='console/src/**' \
//       --coverage.reportOnFailure
//   The --coverage.reportOnFailure flag is required: vitest 3.2.6 suppresses report
//   emission on any test failure by default.  If the summary is absent and the suite
//   has failures, run with that flag or the script will exit as "coverage-not-run"
//   rather than silently claiming clean coverage.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Threshold config -- single source of truth; cite audit doc above.
// One to two points below current actuals (as of audit HEAD ca799b4f) so the
// gate catches regressions without demanding ratchet bumps on every refactor.
// Raising a threshold is cheap and rides the commit that raised real coverage;
// lowering requires the same justification discipline as a lint-baseline bump.
// ---------------------------------------------------------------------------
const THRESHOLDS = [
  {
    area: 'hooks',
    glob: 'console/src/hooks/**',
    // Actual at audit: statements 99.0%, branches 95.5%
    statements: 97,
    branches: 93,
  },
  {
    area: 'lib',
    glob: 'console/src/lib/**',
    // Actual at audit: statements 85.5%, branches 90.4%
    statements: 84,
    branches: 88,
  },
  {
    area: 'primitives',
    glob: 'console/src/components/primitives/**',
    // Actual at audit: statements 99.1%, branches 95.6%
    statements: 98,
    branches: 94,
  },
  {
    area: 'shared',
    glob: 'console/src/components/shared/**',
    // Actual at audit: statements 100%, branches 95.9%
    statements: 98,
    branches: 93,
  },
  // NOTE: no global threshold; no thresholds on pages/**, wizard/**, or top-level
  // components/** yet -- those directories are owned by named slices (B3w3, B4, C3)
  // and each owning slice raises its directory into the gate as part of its evidence
  // packet.  See audit doc section "Coverage ratchet proposal" for activation schedule.
];

// ---------------------------------------------------------------------------
// Default summary path -- the conventional vitest v8 coverage output location
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
// COVERAGE_SUMMARY_PATH env var allows tests to redirect path resolution.
const DEFAULT_SUMMARY_PATH = process.env.COVERAGE_SUMMARY_PATH
  ?? resolve(here, '..', '..', 'coverage', 'coverage-summary.json');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
const strictMode = rawArgs.includes('--strict');
const positionalArgs = rawArgs.filter(a => !a.startsWith('--'));
const summaryPath = positionalArgs[0] ?? DEFAULT_SUMMARY_PATH;

// ---------------------------------------------------------------------------
// Helper: deep-sort object keys for deterministic output
// ---------------------------------------------------------------------------
function sortedKeys(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(
    Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortedKeys(v)])
  );
}

// ---------------------------------------------------------------------------
// Helper: glob match for the path patterns used in THRESHOLDS.
// Pattern form: "console/src/components/primitives/**"
// We match against the absolute file path that coverage-summary keys use.
// ---------------------------------------------------------------------------
function matchesGlob(filePath, glob) {
  // Strip trailing /** from glob to get the directory prefix.
  const prefix = glob.replace(/\/\*\*$/, '');
  // filePath is an absolute path like /abs/path/console/src/hooks/use-foo.ts
  // Find the glob prefix inside it.
  const idx = filePath.indexOf(prefix);
  if (idx === -1) return false;
  // The character immediately before the prefix match must be '/' (or start-of-string).
  if (idx > 0 && filePath[idx - 1] !== '/') return false;
  // The character after the prefix must be '/' (a file inside the directory,
  // not a sibling directory that starts with the same string).
  const afterIdx = idx + prefix.length;
  return filePath[afterIdx] === '/';
}

// ---------------------------------------------------------------------------
// Load and parse the coverage summary
// ---------------------------------------------------------------------------
let raw;
try {
  raw = readFileSync(summaryPath, 'utf8');
} catch (e) {
  process.stderr.write(
    `ERROR(coverage-not-run): coverage summary not found at ${summaryPath}\n` +
    `  Run vitest with --coverage.enabled --coverage.reportOnFailure first.\n` +
    `  Underlying error: ${e.message}\n`
  );
  process.exit(2);
}

let summary;
try {
  summary = JSON.parse(raw);
} catch (e) {
  process.stderr.write(`ERROR(parse-error): coverage summary JSON is malformed: ${e.message}\n`);
  process.exit(2);
}

if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
  process.stderr.write(
    'ERROR(schema-error): coverage-summary.json root must be an object mapping file paths to metric objects\n'
  );
  process.exit(2);
}

// Warn on missing "total" key (non-fatal -- per-directory computation does not depend on it).
const hasTotalKey = 'total' in summary;

// ---------------------------------------------------------------------------
// Aggregate per-area coverage
// ---------------------------------------------------------------------------

const accumulators = THRESHOLDS.map(t => ({
  area: t.area,
  glob: t.glob,
  threshold_statements: t.statements,
  threshold_branches: t.branches,
  _stmtTotal: 0,
  _stmtCovered: 0,
  _brTotal: 0,
  _brCovered: 0,
  _fileCount: 0,
}));

for (const [filePath, metrics] of Object.entries(summary)) {
  if (filePath === 'total') continue;

  // Validate the shape of each file entry
  if (typeof metrics !== 'object' || metrics === null) {
    process.stderr.write(
      `ERROR(schema-error): coverage entry for "${filePath}" is not an object\n`
    );
    process.exit(2);
  }
  if (
    typeof metrics.statements?.total !== 'number' ||
    typeof metrics.statements?.covered !== 'number' ||
    typeof metrics.branches?.total !== 'number' ||
    typeof metrics.branches?.covered !== 'number'
  ) {
    process.stderr.write(
      `ERROR(schema-error): coverage entry for "${filePath}" is missing expected numeric fields ` +
      `(statements.total, statements.covered, branches.total, branches.covered)\n`
    );
    process.exit(2);
  }

  for (const acc of accumulators) {
    if (matchesGlob(filePath, acc.glob)) {
      acc._stmtTotal += metrics.statements.total;
      acc._stmtCovered += metrics.statements.covered;
      acc._brTotal += metrics.branches.total;
      acc._brCovered += metrics.branches.covered;
      acc._fileCount += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluate thresholds and build results
// ---------------------------------------------------------------------------
const areaResults = accumulators.map(acc => {
  const actualStatements = acc._stmtTotal === 0
    ? 100   // no statements -> vacuously 100% (matches v8 behavior on type-only files)
    : Math.floor((acc._stmtCovered / acc._stmtTotal) * 10000) / 100;
  const actualBranches = acc._brTotal === 0
    ? 100
    : Math.floor((acc._brCovered / acc._brTotal) * 10000) / 100;

  const passStatements = actualStatements >= acc.threshold_statements;
  const passBranches = actualBranches >= acc.threshold_branches;
  const pass = passStatements && passBranches;

  return {
    area: acc.area,
    glob: acc.glob,
    file_count: acc._fileCount,
    actual: {
      statements: actualStatements,
      branches: actualBranches,
    },
    threshold: {
      branches: acc.threshold_branches,
      statements: acc.threshold_statements,
    },
    pass,
    pass_statements: passStatements,
    pass_branches: passBranches,
  };
});

const overallPass = areaResults.every(r => r.pass);
const failingAreas = areaResults.filter(r => !r.pass);

// ---------------------------------------------------------------------------
// Assemble output -- sorted keys, no timestamps
// ---------------------------------------------------------------------------

// Sort area results by area name for determinism
const sortedAreas = areaResults.slice().sort((a, b) => a.area.localeCompare(b.area));

const outputObj = sortedKeys({
  schema_version: 1,
  mode: strictMode ? 'strict' : 'report-only',
  overall_pass: overallPass,
  summary: {
    areas_evaluated: areaResults.length,
    areas_failing: failingAreas.length,
    areas_passing: areaResults.filter(r => r.pass).length,
  },
  areas: sortedAreas.reduce((acc, r) => {
    acc[r.area] = sortedKeys({
      actual_branches: r.actual.branches,
      actual_statements: r.actual.statements,
      file_count: r.file_count,
      glob: r.glob,
      pass: r.pass,
      pass_branches: r.pass_branches,
      pass_statements: r.pass_statements,
      threshold_branches: r.threshold.branches,
      threshold_statements: r.threshold.statements,
    });
    return acc;
  }, {}),
});

const outputJson = JSON.stringify(outputObj, null, 2) + '\n';
process.stdout.write(outputJson);

// ---------------------------------------------------------------------------
// Emit advisory WARN to stderr for any failing areas (report-only) or
// ERROR for --strict mode.
// ---------------------------------------------------------------------------
if (failingAreas.length > 0) {
  const tag = strictMode ? 'ERROR(below-threshold)' : 'WARN(below-threshold)';
  process.stderr.write(
    `${tag}: ${failingAreas.length} area(s) below coverage threshold` +
    (strictMode ? '' : ' [report-only mode -- exits 0]') +
    '\n'
  );
  for (const r of failingAreas.sort((a, b) => a.area.localeCompare(b.area))) {
    if (!r.pass_statements) {
      process.stderr.write(
        `  ${r.area} statements: ${r.actual.statements}% < ${r.threshold.statements}% threshold\n`
      );
    }
    if (!r.pass_branches) {
      process.stderr.write(
        `  ${r.area} branches: ${r.actual.branches}% < ${r.threshold.branches}% threshold\n`
      );
    }
  }
}

if (!hasTotalKey) {
  process.stderr.write(
    'WARN(no-total): coverage-summary.json lacks a "total" key; summary was produced without a totals entry\n'
  );
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------
// Report-only mode: ALWAYS exits 0 (coverage runs should not block pre-push).
// Strict mode: exits 1 when any area is below threshold (reserved for D6).
if (strictMode && !overallPass) {
  process.exit(1);
}
process.exit(0);
