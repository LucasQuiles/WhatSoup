import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// Path to the script under test (resolved from repo root = process.cwd())
const SCRIPT = resolve(process.cwd(), 'console/scripts/check-coverage-thresholds.mjs');
const ROOT_PACKAGE_JSON = resolve(process.cwd(), 'package.json');
const ROOT_COVERAGE_WRAPPER = resolve(process.cwd(), 'scripts/run-coverage-check.sh');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Minimal coverage-summary.json entry for a single file.
 * statements/branches use { total, covered, skipped, pct } shape to match vitest v8 output.
 */
function makeFileEntry(stmtTotal: number, stmtCovered: number, brTotal: number, brCovered: number) {
  return {
    lines: { total: stmtTotal, covered: stmtCovered, skipped: 0, pct: stmtTotal === 0 ? 100 : (stmtCovered / stmtTotal) * 100 },
    statements: { total: stmtTotal, covered: stmtCovered, skipped: 0, pct: stmtTotal === 0 ? 100 : (stmtCovered / stmtTotal) * 100 },
    functions: { total: 1, covered: 1, skipped: 0, pct: 100 },
    branches: { total: brTotal, covered: brCovered, skipped: 0, pct: brTotal === 0 ? 100 : (brCovered / brTotal) * 100 },
    branchesTrue: { total: 0, covered: 0, skipped: 0, pct: 100 },
  };
}

/**
 * Build a coverage-summary.json in a temp dir with the given file entries.
 * Returns the path to the summary file.
 */
function makeSummary(entries: Record<string, ReturnType<typeof makeFileEntry>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cov-check-'));
  tmpDirs.push(dir);
  const total = makeFileEntry(100, 90, 50, 45);
  const obj: Record<string, ReturnType<typeof makeFileEntry>> = { total, ...entries };
  const path = join(dir, 'coverage-summary.json');
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

/**
 * Build a summary that passes ALL four area thresholds with comfortable headroom.
 * Uses an absolute prefix that includes the area path segment so glob matching works.
 */
function makePassingSummary(): string {
  // Paths must contain the area directory segments that THRESHOLDS globs match against.
  // The script matches by finding the glob prefix within the absolute file path.
  const prefix = '/fake/repo';
  return makeSummary({
    // primitives -- threshold: 98% stmt, 94% branch
    [`${prefix}/console/src/components/primitives/Button.tsx`]: makeFileEntry(100, 99, 100, 96),
    // hooks -- threshold: 97% stmt, 93% branch
    [`${prefix}/console/src/hooks/use-fleet.ts`]: makeFileEntry(100, 98, 100, 95),
    // shared -- threshold: 98% stmt, 93% branch
    [`${prefix}/console/src/components/shared/SearchInput.tsx`]: makeFileEntry(100, 99, 100, 95),
    // lib -- threshold: 84% stmt, 88% branch
    [`${prefix}/console/src/lib/api.ts`]: makeFileEntry(100, 86, 100, 90),
  });
}

/**
 * Build a summary where one area fails (hooks branches below 93%).
 */
function makeFailingHooksBranchesSummary(): string {
  const prefix = '/fake/repo';
  return makeSummary({
    [`${prefix}/console/src/components/primitives/Button.tsx`]: makeFileEntry(100, 99, 100, 96),
    // hooks branches: 80/100 = 80% < 93% threshold
    [`${prefix}/console/src/hooks/use-fleet.ts`]: makeFileEntry(100, 98, 100, 80),
    [`${prefix}/console/src/components/shared/SearchInput.tsx`]: makeFileEntry(100, 99, 100, 95),
    [`${prefix}/console/src/lib/api.ts`]: makeFileEntry(100, 86, 100, 90),
  });
}

/**
 * Build a summary where lib statements fail (below 84% threshold).
 */
function makeFailingLibStatementsSummary(): string {
  const prefix = '/fake/repo';
  return makeSummary({
    [`${prefix}/console/src/components/primitives/Button.tsx`]: makeFileEntry(100, 99, 100, 96),
    [`${prefix}/console/src/hooks/use-fleet.ts`]: makeFileEntry(100, 98, 100, 95),
    [`${prefix}/console/src/components/shared/SearchInput.tsx`]: makeFileEntry(100, 99, 100, 95),
    // lib statements: 80/100 = 80% < 84% threshold
    [`${prefix}/console/src/lib/api.ts`]: makeFileEntry(100, 80, 100, 90),
  });
}

function makeRootOnlySummary(): string {
  return makeSummary({
    '/fake/repo/src/main.ts': makeFileEntry(100, 100, 100, 100),
  });
}

/**
 * Run the script with a given summary path, optionally in strict mode.
 */
function runScript(summaryPath: string, extraArgs: string[] = []) {
  return spawnSync(
    'node',
    [SCRIPT, ...extraArgs, summaryPath],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }
  );
}

/**
 * Run the script with COVERAGE_SUMMARY_PATH env var instead of positional arg.
 */
function runScriptViaEnv(summaryPath: string, extraArgs: string[] = []) {
  return spawnSync(
    'node',
    [SCRIPT, ...extraArgs],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, COVERAGE_SUMMARY_PATH: summaryPath },
    }
  );
}

// ---------------------------------------------------------------------------
// Tests: passing summary
// ---------------------------------------------------------------------------

describe('check-coverage-thresholds.mjs', () => {
  describe('passing summary', () => {
    it('exits 0 when all areas pass thresholds', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      expect(result.status).toBe(0);
    });

    it('outputs valid JSON to stdout', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    it('JSON output contains required top-level keys', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toHaveProperty('schema_version', 1);
      expect(output).toHaveProperty('mode', 'report-only');
      expect(output).toHaveProperty('overall_pass', true);
      expect(output).toHaveProperty('summary');
      expect(output).toHaveProperty('areas');
    });

    it('areas object contains all four threshold keys', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as { areas: Record<string, unknown> };
      expect(output.areas).toHaveProperty('primitives');
      expect(output.areas).toHaveProperty('hooks');
      expect(output.areas).toHaveProperty('shared');
      expect(output.areas).toHaveProperty('lib');
    });

    it('each area entry has actual, threshold, and pass fields', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as {
        areas: Record<string, {
          actual_statements: number;
          actual_branches: number;
          threshold_statements: number;
          threshold_branches: number;
          pass: boolean;
          pass_statements: boolean;
          pass_branches: boolean;
          file_count: number;
          glob: string;
        }>;
      };
      for (const area of ['primitives', 'hooks', 'shared', 'lib']) {
        const entry = output.areas[area];
        expect(typeof entry.actual_statements).toBe('number');
        expect(typeof entry.actual_branches).toBe('number');
        expect(typeof entry.threshold_statements).toBe('number');
        expect(typeof entry.threshold_branches).toBe('number');
        expect(typeof entry.pass).toBe('boolean');
        expect(typeof entry.pass_statements).toBe('boolean');
        expect(typeof entry.pass_branches).toBe('boolean');
        expect(typeof entry.file_count).toBe('number');
        expect(typeof entry.glob).toBe('string');
      }
    });

    it('threshold values match audit spec numbers', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as {
        areas: Record<string, { threshold_statements: number; threshold_branches: number }>;
      };
      expect(output.areas.primitives.threshold_statements).toBe(98);
      expect(output.areas.primitives.threshold_branches).toBe(94);
      expect(output.areas.hooks.threshold_statements).toBe(97);
      expect(output.areas.hooks.threshold_branches).toBe(93);
      expect(output.areas.shared.threshold_statements).toBe(98);
      expect(output.areas.shared.threshold_branches).toBe(93);
      expect(output.areas.lib.threshold_statements).toBe(84);
      expect(output.areas.lib.threshold_branches).toBe(88);
    });

    it('summary counts reflect all areas passing', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as {
        summary: { areas_evaluated: number; areas_passing: number; areas_failing: number };
      };
      expect(output.summary.areas_evaluated).toBe(4);
      expect(output.summary.areas_passing).toBe(4);
      expect(output.summary.areas_failing).toBe(0);
    });

    it('emits no ERROR or WARN tokens to stderr on a clean run', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      expect(result.stderr).toBe('');
    });

    it('output keys are sorted at the top level', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      const keys = Object.keys(output);
      expect(keys).toEqual([...keys].sort());
    });

    it('area keys are sorted', () => {
      const summary = makePassingSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as { areas: Record<string, unknown> };
      const keys = Object.keys(output.areas);
      expect(keys).toEqual([...keys].sort());
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: below-threshold (report-only behavior)
  // ---------------------------------------------------------------------------

  describe('below threshold -- report-only mode', () => {
    it('exits 0 even when areas are below threshold (report-only)', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary);
      expect(result.status).toBe(0);
    });

    it('overall_pass is false when any area fails', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as { overall_pass: boolean };
      expect(output.overall_pass).toBe(false);
    });

    it('emits WARN(below-threshold) to stderr (not ERROR) in report-only mode', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary);
      expect(result.stderr).toMatch(/WARN\(below-threshold\)/);
      expect(result.stderr).not.toMatch(/^ERROR\(/m);
    });

    it('WARN message mentions the failing area', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary);
      expect(result.stderr).toContain('hooks');
    });

    it('WARN message mentions "report-only"', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary);
      expect(result.stderr).toContain('report-only');
    });

    it('failing area has pass=false in output', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as {
        areas: Record<string, { pass: boolean; pass_branches: boolean; pass_statements: boolean }>;
      };
      expect(output.areas.hooks.pass).toBe(false);
      expect(output.areas.hooks.pass_branches).toBe(false);
      // statements still pass (98% >= 97% threshold)
      expect(output.areas.hooks.pass_statements).toBe(true);
    });

    it('passing areas remain pass=true when another area fails', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as {
        areas: Record<string, { pass: boolean }>;
      };
      expect(output.areas.primitives.pass).toBe(true);
      expect(output.areas.shared.pass).toBe(true);
      expect(output.areas.lib.pass).toBe(true);
    });

    it('summary counts reflect the failing area', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary);
      const output = JSON.parse(result.stdout) as {
        summary: { areas_passing: number; areas_failing: number };
      };
      expect(output.summary.areas_passing).toBe(3);
      expect(output.summary.areas_failing).toBe(1);
    });

    it('stdout remains valid parseable JSON even when areas fail', () => {
      const summary = makeFailingLibStatementsSummary();
      const result = runScript(summary);
      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: --strict flag
  // ---------------------------------------------------------------------------

  describe('--strict flag', () => {
    it('is wired into the root coverage:check gate after Vitest coverage generation', () => {
      const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
        scripts: Record<string, string>;
      };
      const wrapper = readFileSync(ROOT_COVERAGE_WRAPPER, 'utf8');

      expect(pkg.scripts['coverage:check']).toBe('bash scripts/run-coverage-check.sh');
      expect(wrapper).toContain('set -euo pipefail');
      expect(wrapper).toContain('"$VITEST_BIN" run --coverage "$@"');
      expect(wrapper).toContain('npm --prefix console run coverage:check -- --strict');
    });

    it('exits 0 under --strict when all areas pass', () => {
      const summary = makePassingSummary();
      const result = runScript(summary, ['--strict']);
      expect(result.status).toBe(0);
    });

    it('exits 1 under --strict when any area is below threshold', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary, ['--strict']);
      expect(result.status).toBe(1);
    });

    it('reports mode as "strict" in JSON output when --strict is passed', () => {
      const summary = makePassingSummary();
      const result = runScript(summary, ['--strict']);
      const output = JSON.parse(result.stdout) as { mode: string };
      expect(output.mode).toBe('strict');
    });

    it('emits ERROR(below-threshold) to stderr under --strict (not WARN)', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary, ['--strict']);
      expect(result.stderr).toMatch(/ERROR\(below-threshold\)/);
      expect(result.stderr).not.toMatch(/WARN\(below-threshold\)/);
    });

    it('stdout remains valid JSON under --strict even on failure', () => {
      const summary = makeFailingHooksBranchesSummary();
      const result = runScript(summary, ['--strict']);
      expect(result.status).toBe(1);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    it('rejects a misspelled strict option instead of silently using report-only mode', () => {
      const summary = makeRootOnlySummary();
      const result = runScript(summary, ['--strcit']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ERROR(argument-error)');
      expect(result.stdout).toBe('');
    });

    it('rejects duplicate strict options', () => {
      const summary = makePassingSummary();
      const result = runScript(summary, ['--strict', '--strict']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ERROR(argument-error)');
    });

    it('rejects more than one coverage summary path', () => {
      const firstSummary = makePassingSummary();
      const secondSummary = makeRootOnlySummary();
      const result = runScript(firstSummary, [secondSummary]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ERROR(argument-error)');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: fail-closed parsing -- missing / malformed / wrong schema
  // ---------------------------------------------------------------------------

  describe('fail-closed parsing', () => {
    it('exits 2 with named error when coverage summary file is missing', () => {
      const result = runScript('/nonexistent/path/coverage-summary.json');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ERROR(coverage-not-run)');
    });

    it('ERROR(coverage-not-run) message distinguishes "not run" from "below threshold"', () => {
      const result = runScript('/nonexistent/path/coverage-summary.json');
      expect(result.status).toBe(2);
      // Must say coverage-not-run, not parse-error or schema-error
      expect(result.stderr).toMatch(/ERROR\(coverage-not-run\)/);
    });

    it('escapes newlines in a missing summary path diagnostic', () => {
      const missingPath = join(tmpdir(), 'missing\n::error::injected.json');
      const result = runScript(missingPath);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('\\n::error::injected.json');
      expect(result.stderr).not.toContain('\n::error::injected.json');
    });

    it('exits 2 with ERROR(parse-error) when file is not valid JSON', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cov-check-malformed-'));
      tmpDirs.push(dir);
      const path = join(dir, 'coverage-summary.json');
      writeFileSync(path, '{ "total": { INVALID JSON }');
      const result = runScript(path);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/ERROR\(parse-error\)/);
    });

    it('exits 2 with ERROR(schema-error) when root is not an object (array)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cov-check-schema-'));
      tmpDirs.push(dir);
      const path = join(dir, 'coverage-summary.json');
      writeFileSync(path, '["not", "an", "object"]');
      const result = runScript(path);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/ERROR\(schema-error\)/);
    });

    it('exits 2 with ERROR(schema-error) when a file entry lacks statements.total', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cov-check-badentry-'));
      tmpDirs.push(dir);
      const path = join(dir, 'coverage-summary.json');
      writeFileSync(path, JSON.stringify({
        total: makeFileEntry(100, 90, 50, 45),
        '/fake/repo/console/src/hooks/use-foo.ts': {
          // missing statements
          branches: { total: 10, covered: 9, skipped: 0, pct: 90 },
        },
      }));
      const result = runScript(path);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/ERROR\(schema-error\)/);
    });

    it('exits 2 with ERROR(schema-error) when root is a JSON null', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cov-check-null-'));
      tmpDirs.push(dir);
      const path = join(dir, 'coverage-summary.json');
      writeFileSync(path, 'null');
      const result = runScript(path);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/ERROR\(schema-error\)/);
    });

    it('rejects covered counts greater than their totals', () => {
      for (const metric of ['statements', 'branches'] as const) {
        const entry = makeFileEntry(100, 98, 100, 95);
        entry[metric].covered = entry[metric].total + 1;
        const path = makeSummary({
          '/fake/repo/console/src/hooks/use-foo.ts': entry,
        });
        const result = runScript(path, ['--strict']);
        expect(result.status, metric).toBe(2);
        expect(result.stderr, metric).toContain('ERROR(schema-error)');
        expect(result.stderr, metric).toContain(`${metric}.covered`);
      }
    });

    it('rejects negative and fractional coverage counters', () => {
      const invalidCounters = [-1, 1.5];
      for (const value of invalidCounters) {
        const entry = makeFileEntry(100, 98, 100, 95);
        entry.statements.total = value;
        const path = makeSummary({
          '/fake/repo/console/src/hooks/use-foo.ts': entry,
        });
        const result = runScript(path, ['--strict']);
        expect(result.status, String(value)).toBe(2);
        expect(result.stderr, String(value)).toContain('ERROR(schema-error)');
        expect(result.stderr, String(value)).toContain('statements.total');
      }
    });

    it('escapes newlines in malformed coverage entry keys', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cov-check-log-injection-'));
      tmpDirs.push(dir);
      const path = join(dir, 'coverage-summary.json');
      const unsafeKey = '/fake/repo/console/src/hooks/use-foo.ts\n::error::injected';
      writeFileSync(path, JSON.stringify({
        total: makeFileEntry(100, 90, 50, 45),
        [unsafeKey]: null,
      }));
      const result = runScript(path, ['--strict']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('\\n::error::injected');
      expect(result.stderr).not.toContain('\n::error::injected');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: COVERAGE_SUMMARY_PATH env var
  // ---------------------------------------------------------------------------

  describe('COVERAGE_SUMMARY_PATH env var', () => {
    it('reads the summary from env var path when no positional arg given', () => {
      const summary = makePassingSummary();
      const result = runScriptViaEnv(summary);
      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    it('positional arg takes precedence over env var', () => {
      const passingSummary = makePassingSummary();
      const failingSummary = makeFailingHooksBranchesSummary();
      // env var points to failing, positional arg points to passing
      const result = spawnSync(
        'node',
        [SCRIPT, passingSummary],
        {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, COVERAGE_SUMMARY_PATH: failingSummary },
        }
      );
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { overall_pass: boolean };
      // Should use the positional passing summary
      expect(output.overall_pass).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: determinism
  // ---------------------------------------------------------------------------

  describe('determinism', () => {
    it('two sequential runs on the same fixture produce byte-identical stdout', () => {
      const summary = makePassingSummary();
      const r1 = runScript(summary);
      const r2 = runScript(summary);
      expect(r1.status).toBe(0);
      expect(r2.status).toBe(0);
      expect(r1.stdout).toBe(r2.stdout);
    });

    it('two sequential runs on the failing fixture produce byte-identical stdout', () => {
      const summary = makeFailingHooksBranchesSummary();
      const r1 = runScript(summary);
      const r2 = runScript(summary);
      expect(r1.status).toBe(0);
      expect(r2.status).toBe(0);
      expect(r1.stdout).toBe(r2.stdout);
    });

    it('output contains no timestamp or random fields', () => {
      const summary = makePassingSummary();
      const output = JSON.parse(runScript(summary).stdout) as Record<string, unknown>;
      const outputStr = JSON.stringify(output);
      // None of these timestamp-like keys should appear in the output
      expect(outputStr).not.toContain('"timestamp"');
      expect(outputStr).not.toContain('"generated_at"');
      expect(outputStr).not.toContain('"date"');
      expect(outputStr).not.toContain('"time"');
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: configured areas must be present in the coverage artifact
  // ---------------------------------------------------------------------------

  describe('coverage artifact completeness', () => {
    it('fails strict mode when configured areas have no matching files', () => {
      const summary = makeRootOnlySummary();
      const result = runScript(summary, ['--strict']);
      expect(result.status).toBe(1);
      const output = JSON.parse(result.stdout) as {
        overall_pass: boolean;
        summary: { areas_failing: number; areas_passing: number };
        areas: Record<string, {
          file_count: number;
          pass: boolean;
          pass_files: boolean;
          actual_statements: number;
        }>;
      };
      expect(output.overall_pass).toBe(false);
      expect(output.summary.areas_failing).toBe(4);
      expect(output.summary.areas_passing).toBe(0);
      for (const area of ['primitives', 'hooks', 'shared', 'lib']) {
        expect(output.areas[area].file_count).toBe(0);
        expect(output.areas[area].pass_files).toBe(false);
        expect(output.areas[area].pass).toBe(false);
        expect(output.areas[area].actual_statements).toBe(100);
        expect(result.stderr).toContain(area);
      }
      expect(result.stderr).toContain('ERROR(no-matching-files)');
    });

    it('keeps missing-file failures advisory in report-only mode', () => {
      const result = runScript(makeRootOnlySummary());
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { overall_pass: boolean };
      expect(output.overall_pass).toBe(false);
      expect(result.stderr).toContain('WARN(no-matching-files)');
      expect(result.stderr).not.toContain('ERROR(no-matching-files)');
    });

    it('accepts a matched type-only file with zero statements', () => {
      const prefix = '/fake/repo';
      const summary = makeSummary({
        [`${prefix}/console/src/components/primitives/types.ts`]: makeFileEntry(0, 0, 0, 0),
        [`${prefix}/console/src/hooks/types.ts`]: makeFileEntry(0, 0, 0, 0),
        [`${prefix}/console/src/components/shared/types.ts`]: makeFileEntry(0, 0, 0, 0),
        [`${prefix}/console/src/lib/types.ts`]: makeFileEntry(0, 0, 0, 0),
      });
      const result = runScript(summary, ['--strict']);
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        overall_pass: boolean;
        areas: Record<string, {
          file_count: number;
          pass: boolean;
          pass_files: boolean;
          actual_statements: number;
          actual_branches: number;
        }>;
      };
      expect(output.overall_pass).toBe(true);
      for (const area of ['primitives', 'hooks', 'shared', 'lib']) {
        expect(output.areas[area].pass).toBe(true);
        expect(output.areas[area].pass_files).toBe(true);
        expect(output.areas[area].file_count).toBe(1);
        expect(output.areas[area].actual_statements).toBe(100);
        expect(output.areas[area].actual_branches).toBe(100);
      }
    });
  });
});
