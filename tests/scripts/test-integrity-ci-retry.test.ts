/**
 * Retry contract of scripts/test-integrity-ci.sh.
 *
 * The test-integrity plugin's tree-sitter pass intermittently faults on CI
 * runners and reports parse errors on files the diff never touched (PRs
 * #3171, #3174, #3175 — roving victims, never reproducible locally on the
 * identical tree). The wrapper retries ONCE when the only net-new findings
 * are that class. These tests pin the discrimination contract with a fake
 * plugin binary (TEST_INTEGRITY_BIN):
 *
 *   - parse-error-only failure, clean retry  → exit 0 (runner fault cleared)
 *   - parse-error-only failure, both runs    → exit 1 (real parse regression)
 *   - any other net-new finding              → exit 1, NO retry
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = join(repoRoot, 'scripts', 'test-integrity-ci.sh');

interface WrapperRun {
  status: number;
  output: string;
  invocations: number;
}

/**
 * Build a fake plugin whose per-invocation stdout lines come from `script`:
 * invocation N (1-based) prints scriptLines[N-1] and exits with exits[N-1];
 * past the end it repeats the last entry.
 */
function runWrapperWithFakePlugin(lines: string[][], exits: number[]): WrapperRun {
  const tmp = mkdtempSync(join(tmpdir(), 'ti-retry-'));
  const counter = join(tmp, 'invocations');
  const plugin = join(tmp, 'fake-test-integrity');
  writeFileSync(counter, '0\n');
  const casesJson = JSON.stringify({ lines, exits });
  writeFileSync(
    plugin,
    [
      '#!/usr/bin/env bash',
      `counter="${counter}"`,
      `cases='${casesJson}'`,
      'n=$(cat "$counter")',
      'n=$((n+1))',
      'printf "%s\\n" "$n" > "$counter"',
      'python3 - "$cases" "$n" << \'PYEOF\'',
      'import json, sys',
      'cases = json.loads(sys.argv[1])',
      'idx = min(int(sys.argv[2]), len(cases["exits"])) - 1',
      'for line in cases["lines"][idx]:',
      '    print(line)',
      'sys.exit(cases["exits"][idx])',
      'PYEOF',
    ].join('\n'),
  );
  chmodSync(plugin, 0o755);

  let status = 0;
  let output = '';
  try {
    output = execFileSync('bash', [wrapper], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, TEST_INTEGRITY_BIN: plugin },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    status = failure.status ?? -1;
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
  const invocations = Number(readFileSync(counter, 'utf8').trim());
  return { status, output, invocations };
}

const PARSE_ERROR_FAIL = [
  'TEST_INTEGRITY_BASELINE_CHECK status=fail exit_class=new total_findings=82 baseline_findings=81 new_findings=1',
  'NEW test-file-tree-sitter-parse-error deploy/some-untouched.sh:1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
];
const REAL_FAIL = [
  'TEST_INTEGRITY_BASELINE_CHECK status=fail exit_class=new total_findings=82 baseline_findings=81 new_findings=1',
  'NEW vacuous-assertion tests/somewhere.test.ts:10 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
];
const CLEAN = [
  'TEST_INTEGRITY_BASELINE_CHECK status=pass exit_class=clean total_findings=81 baseline_findings=81 new_findings=0',
];

describe('test-integrity-ci.sh parse-error retry', () => {
  it('retries once when the only net-new findings are tree-sitter parse errors, and passes on a clean second run', () => {
    const run = runWrapperWithFakePlugin([PARSE_ERROR_FAIL, CLEAN], [1, 0]);
    expect(run.invocations).toBe(2);
    expect(run.status).toBe(0);
    // The second (clean) verdict is the one that stands.
    expect(run.output).toContain('status=pass');
  });

  it('fails when the parse error reproduces on the retry (real parse regression)', () => {
    const run = runWrapperWithFakePlugin([PARSE_ERROR_FAIL, PARSE_ERROR_FAIL], [1, 1]);
    expect(run.invocations).toBe(2);
    expect(run.status).not.toBe(0);
  });

  it('does NOT retry when any net-new finding is outside the parse-error class', () => {
    const run = runWrapperWithFakePlugin([REAL_FAIL, CLEAN], [1, 0]);
    expect(run.invocations).toBe(1);
    expect(run.status).not.toBe(0);
  });

  it('does NOT retry on a mixed failure (parse error plus a real finding)', () => {
    const run = runWrapperWithFakePlugin([[...PARSE_ERROR_FAIL, REAL_FAIL[1]!], CLEAN], [1, 0]);
    expect(run.invocations).toBe(1);
    expect(run.status).not.toBe(0);
  });

  it('does NOT retry when the plugin fails without NEW findings (plugin crash)', () => {
    const run = runWrapperWithFakePlugin([['plugin exploded before scanning'], CLEAN], [2, 0]);
    expect(run.invocations).toBe(1);
    expect(run.status).not.toBe(0);
  });
});
