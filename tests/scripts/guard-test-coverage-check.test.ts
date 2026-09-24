import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_GUARD_COVERAGE_FINDINGS,
  companionTestCandidates,
  enumerateGuardScripts,
  findGuardsMissingTests,
  parseGuardTestCoverageReportBytes,
  run,
  runGuardTestCoverageCli,
} from '../../scripts/guard-test-coverage-check.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('guard-test-');

/**
 * Build a minimal repo fixture with a `scripts/` dir, a `tests/scripts/` dir,
 * and a `scripts/push-gate.ts` manifest whose `CURATED_TEST_PATHS` lists the
 * given test paths (the push-gate SSOT since #2224 — the guard text-parses
 * the manifest so fixtures can simulate wired/unwired states).
 *
 * Each guard spec declares: the guard filename, whether a companion test file
 * is written, whether that test path is wired into the manifest, and an
 * optional allowlist comment body.
 */
function makeFixture(
  guards: {
    file: string;
    writeTest?: boolean;
    /** Override the test basename written (to model the check-<x> alias). */
    testBasename?: string;
    wired?: boolean;
    /** Override the wired test path (to model the alias). */
    wiredPath?: string;
    allowlist?: string;
    testBody?: string;
  }[],
): string {
  const dir = tmp.make('coverage');
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'tests', 'scripts'), { recursive: true });

  const wiredTestPaths: string[] = [];

  for (const guard of guards) {
    const guardBody = guard.allowlist
      ? `// meta-guard:no-test ${guard.allowlist}\nexport const x = 1;\n`
      : [
          'export function analyzeGuard(input: string) {',
          "  return input === 'safe' ? { ok: true, findings: [] } : { ok: false, findings: ['unsafe'] };",
          '}',
          "export function scanGuard(input: string) { return analyzeGuard(input).findings; }",
          "export function runGuard(input: string) { return analyzeGuard(input).ok ? 0 : 1; }",
          '',
        ].join('\n');
    writeFileSync(path.join(dir, 'scripts', guard.file), guardBody, 'utf8');

    if (guard.writeTest) {
      const base = guard.testBasename ?? guard.file.replace(/\.ts$/, '');
      writeFileSync(
        path.join(dir, 'tests', 'scripts', `${base}.test.ts`),
        guard.testBody ?? 'import { it } from "vitest"; it("noop", () => {});\n',
        'utf8',
      );
    }

    if (guard.wired) {
      const wiredPath =
        guard.wiredPath ??
        `tests/scripts/${guard.testBasename ?? guard.file.replace(/\.ts$/, '')}.test.ts`;
      wiredTestPaths.push(wiredPath);
    }
  }

  const manifest = [
    '// Fixture manifest mirroring scripts/push-gate.ts structure (#2224).',
    'export const CURATED_TEST_PATHS = [',
    ...wiredTestPaths.map((testPath) => `  '${testPath}',`),
    '] as const;',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'scripts', 'push-gate.ts'), manifest, 'utf8');

  return dir;
}

function failureProofTestBody(guardFile = 'sample-guard.ts'): string {
  return [
    `import { expect, it } from 'vitest';`,
    `import { analyzeGuard } from '../../scripts/${guardFile}';`,
    `it('proves the unsafe case', () => {`,
    `  const result = analyzeGuard('unsafe');`,
    `  expect(result.ok).toBe(false);`,
    `});`,
  ].join('\n');
}

function invokeCli(args: string[], cwd: string): {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = runGuardTestCoverageCli(args, cwd, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('guard-test-coverage meta-guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('enumerates *guard*.ts and check-*.ts but ignores unrelated scripts', () => {
    const dir = makeFixture([
      { file: 'repo-hygiene-guard.ts', writeTest: true, wired: true },
      { file: 'check-instance-config.ts', writeTest: true, wired: true },
    ]);
    // A non-guard script must not be enumerated.
    writeFileSync(path.join(dir, 'scripts', 'build-something.ts'), 'export const y = 1;\n', 'utf8');

    const guards = enumerateGuardScripts(dir);
    expect(guards).toContain('scripts/repo-hygiene-guard.ts');
    expect(guards).toContain('scripts/check-instance-config.ts');
    expect(guards).not.toContain('scripts/build-something.ts');
  });

  it('fails closed when the scripts directory cannot be scanned', () => {
    const dir = tmp.make('coverage-missing-scripts');
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { 'verify:push:branch': 'npm test --' } }),
      'utf8',
    );

    expect(() => findGuardsMissingTests({ cwd: dir })).toThrow(/unable to scan guard scripts/i);
  });

  it('derives the check-<x> alias companion candidate', () => {
    expect(companionTestCandidates('scripts/check-node-pin-consistency.ts')).toEqual([
      'tests/scripts/check-node-pin-consistency.test.ts',
      'tests/scripts/node-pin-consistency.test.ts',
    ]);
    expect(companionTestCandidates('scripts/repo-hygiene-guard.ts')).toEqual([
      'tests/scripts/repo-hygiene-guard.test.ts',
    ]);
  });

  it('(1) passes a guard whose companion test exists and is wired into verify:push:branch', () => {
    const dir = makeFixture([
      { file: 'sample-guard.ts', writeTest: true, wired: true },
    ]);
    const result = findGuardsMissingTests({ cwd: dir });
    expect(result.gaps).toEqual([]);
    expect(result.covered).toContain('scripts/sample-guard.ts');
  });

  it('(2) fails a guard with NO companion test, listing it', () => {
    const dir = makeFixture([
      { file: 'sample-guard.ts', writeTest: false, wired: false },
    ]);
    const result = findGuardsMissingTests({ cwd: dir });
    expect(result.covered).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      guard: 'scripts/sample-guard.ts',
      reason: 'no-test',
      expectedTest: 'tests/scripts/sample-guard.test.ts',
    });
  });

  it('(3) fails a guard whose test exists but is NOT wired into verify:push:branch', () => {
    const dir = makeFixture([
      { file: 'sample-guard.ts', writeTest: true, wired: false },
    ]);
    const result = findGuardsMissingTests({ cwd: dir });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      guard: 'scripts/sample-guard.ts',
      reason: 'test-not-wired',
      expectedTest: 'tests/scripts/sample-guard.test.ts',
    });
  });

  it('(4) passes a guard carrying a meta-guard:no-test allowlist comment, recording the reason', () => {
    const dir = makeFixture([
      {
        file: 'sample-guard.ts',
        writeTest: false,
        wired: false,
        allowlist: 'covered by the broader integration suite',
      },
    ]);
    const result = findGuardsMissingTests({ cwd: dir });
    expect(result.gaps).toEqual([]);
    expect(result.allowlisted).toEqual([
      {
        guard: 'scripts/sample-guard.ts',
        reason: 'covered by the broader integration suite',
      },
    ]);
  });

  it('accepts the check-<x> alias: check-foo.ts covered by foo.test.ts when foo.test.ts is wired', () => {
    const dir = makeFixture([
      {
        file: 'check-foo.ts',
        writeTest: true,
        testBasename: 'foo',
        wired: true,
        wiredPath: 'tests/scripts/foo.test.ts',
      },
    ]);
    const result = findGuardsMissingTests({ cwd: dir });
    expect(result.gaps).toEqual([]);
    expect(result.covered).toContain('scripts/check-foo.ts');
  });

  it('run() exits non-zero and prints diagnostics when a guard lacks a wired test', () => {
    const dir = makeFixture([
      { file: 'sample-guard.ts', writeTest: false, wired: false },
    ]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run([], dir, {});

    expect(process.exitCode).toBe(1);
    expect(result.gaps.length).toBeGreaterThan(0);
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('BLOCK test.guard-coverage');
    expect(printed).toContain('test.guard-coverage.test-missing');
    expect(printed).toContain('sample-guard.ts');
  });

  it('run() passes (exit code untouched) when all guards are covered', () => {
    const dir = makeFixture([
      {
        file: 'sample-guard.ts',
        writeTest: true,
        wired: true,
        testBody: failureProofTestBody(),
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    run([], dir, {});

    expect(process.exitCode).not.toBe(1);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('PASS test.guard-coverage');
  });

  it('does not count a comment or string containing the guard name as import/invocation proof', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `it('mentions a guard', () => {`,
        `  // import { analyzeGuard } from '../../scripts/sample-guard.ts'; analyzeGuard('unsafe');`,
        `  const note = "../../scripts/sample-guard.ts analyzeGuard('unsafe')";`,
        `  expect(note).toContain('sample-guard');`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toContainEqual(
      expect.objectContaining({
        guard: 'scripts/sample-guard.ts',
        reason: 'test-does-not-import-or-invoke-guard',
      }),
    );
  });

  it('does not count an imported guard binding that is never called', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { analyzeGuard } from '../../scripts/sample-guard.ts';`,
        `it('imports only', () => { expect(analyzeGuard).toBeDefined(); });`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toContainEqual(
      expect.objectContaining({ reason: 'test-does-not-import-or-invoke-guard' }),
    );
  });

  it('does not count a guard call with success-only assertions', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { analyzeGuard } from '../../scripts/sample-guard.ts';`,
        `it('checks only success', () => {`,
        `  const result = analyzeGuard('safe');`,
        `  expect(result.ok).toBe(true);`,
        `  expect(result.findings).toHaveLength(0);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toContainEqual(
      expect.objectContaining({ reason: 'test-does-not-exercise-failure' }),
    );
  });

  it('does not count a guard call made outside an it/test body', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { analyzeGuard } from '../../scripts/sample-guard.ts';`,
        `const result = analyzeGuard('unsafe');`,
        `it('asserts a top-level result', () => {`,
        `  expect(result.findings).not.toHaveLength(0);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toContainEqual(
      expect.objectContaining({ reason: 'test-does-not-import-or-invoke-guard' }),
    );
  });

  it('does not count a negative control inside a skipped test', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { analyzeGuard } from '../../scripts/sample-guard.ts';`,
        [`it`, `.skip('disabled proof', () => {`].join(''),
        `  const result = analyzeGuard('unsafe');`,
        `  expect(result.findings).not.toHaveLength(0);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toContainEqual(
      expect.objectContaining({ reason: 'test-does-not-import-or-invoke-guard' }),
    );
  });

  it('accepts an unsafe analyzer call with a non-empty findings assertion', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { analyzeGuard } from '../../scripts/sample-guard.ts';`,
        `it('proves the unsafe case', () => {`,
        `  const result = analyzeGuard('unsafe');`,
        `  expect(result.ok).toBe(false);`,
        `  expect(result.findings).not.toHaveLength(0);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toEqual([]);
  });

  it("accepts vitest's two-argument expect(actual, 'message') form", () => {
    // REGRESSION. `parseExpectation` bailed on any expect() with more than one argument,
    // so vitest's idiomatic `expect(actual, 'why this matters')` was invisible to the
    // failure-proof check. 54 of the 123 files in tests/scripts/ use that form, and a
    // guard whose ONLY failure assertion carried a message was reported as
    // `test-does-not-exercise-failure` — pushing the author toward the allowlist or
    // toward dropping the message. The second argument is the assertion message; the
    // subject is still arguments[0], so parsing it changes nothing else.
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { analyzeGuard } from '../../scripts/sample-guard.ts';`,
        `it('proves the unsafe case', () => {`,
        `  const result = analyzeGuard('unsafe');`,
        `  expect(result.ok, 'an unsafe input must not report ok').toBe(false);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toEqual([]);
  });

  it('still rejects a two-argument expect whose assertion only proves success', () => {
    // Widening the argument count must not weaken the verdict: a message-carrying
    // assertion that proves ok=true is still not a failure proof.
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { analyzeGuard } from '../../scripts/sample-guard.ts';`,
        `it('only proves the happy path', () => {`,
        `  const result = analyzeGuard('safe');`,
        `  expect(result.ok, 'a safe input should report ok').toBe(true);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toContainEqual(
      expect.objectContaining({ reason: 'test-does-not-exercise-failure' }),
    );
  });

  it('accepts a linked throw assertion for an imported guard call', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { analyzeGuard } from '../../scripts/sample-guard.ts';`,
        `it('proves a rejection', () => {`,
        `  expect(() => analyzeGuard('unsafe')).toThrow();`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toEqual([]);
  });

  it('accepts a direct non-empty finding-array assertion', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { scanGuard } from '../../scripts/sample-guard.ts';`,
        `it('proves a returned violation', () => {`,
        `  expect(scanGuard('unsafe')).toHaveLength(1);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toEqual([]);
  });

  it('accepts a linked findings.some(...) assertion', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { analyzeGuard } from '../../scripts/sample-guard.ts';`,
        `it('proves a matching finding', () => {`,
        `  const result = analyzeGuard('unsafe');`,
        `  expect(result.findings.some((finding) => finding === 'unsafe')).toBe(true);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toEqual([]);
  });

  it('accepts a direct nonzero run result', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { expect, it } from 'vitest';`,
        `import { runGuard } from '../../scripts/sample-guard.ts';`,
        `it('proves a blocking exit', () => {`,
        `  expect(runGuard('unsafe')).toBe(1);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toEqual([]);
  });

  it('rejects a guard subprocess invocation whose status is never asserted', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { spawnSync } from 'node:child_process';`,
        `import { expect, it } from 'vitest';`,
        `it('runs without checking failure', () => {`,
        `  const result = spawnSync(process.execPath, ['scripts/sample-guard.ts']);`,
        `  expect(result.stdout).toBeDefined();`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toContainEqual(
      expect.objectContaining({ reason: 'test-does-not-exercise-failure' }),
    );
  });

  it('accepts a guard subprocess invocation with a nonzero status assertion', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: [
        `import { spawnSync } from 'node:child_process';`,
        `import { expect, it } from 'vitest';`,
        `it('proves process failure', () => {`,
        `  const result = spawnSync(process.execPath, ['scripts/sample-guard.ts', '--unsafe']);`,
        `  expect(result.status).not.toBe(0);`,
        `});`,
      ].join('\n'),
    }]);

    expect(findGuardsMissingTests({ cwd: dir }).semanticGaps).toEqual([]);
  });

  it('reports semantic gaps without changing the process exit in shadow mode', () => {
    const dir = makeFixture([
      { file: 'sample-guard.ts', writeTest: true, wired: true },
    ]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run(['--semantic-mode', 'shadow'], dir, {});

    expect(result.semanticGaps).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('test.guard-coverage.guard-not-invoked');
  });

  it('exits nonzero for the same semantic gap in enforce mode', () => {
    const dir = makeFixture([
      { file: 'sample-guard.ts', writeTest: true, wired: true },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = run(['--semantic-mode', 'enforce'], dir, {});

    expect(result.semanticGaps).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it('distinguishes an unparseable companion test from a missing guard invocation', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: "import { it } from 'vitest'; it('broken', () => { const = ; });",
    }]);

    const report = parseGuardTestCoverageReportBytes(Buffer.from(
      invokeCli(['--semantic-mode', 'enforce', '--format', 'json'], dir).stdout,
    ));

    expect(report).toMatchObject({
      outcome: 'block',
      causeCodes: ['test.guard-coverage.test-unparseable'],
      findings: [{
        code: 'test.guard-coverage.test-unparseable',
        decision: 'block',
      }],
    });
  });

  it('emits one deterministic native-schema JSON document for a proved pass', () => {
    const dir = makeFixture([{
      file: 'sample-guard.ts',
      writeTest: true,
      wired: true,
      testBody: failureProofTestBody(),
    }]);

    const invoked = invokeCli(['--semantic-mode', 'enforce', '--format', 'json'], dir);
    const report = parseGuardTestCoverageReportBytes(Buffer.from(invoked.stdout));

    expect(invoked.exitCode).toBe(0);
    expect(invoked.stderr).toBe('');
    expect(report).toMatchObject({
      schemaVersion: 1,
      controlId: 'test.guard-coverage',
      outcome: 'pass',
      exitCode: 0,
      code: 'test.guard-coverage.pass',
      semanticMode: 'enforce',
      counts: {
        scanned: 1,
        covered: 1,
        allowlisted: 0,
        structuralGaps: 0,
        semanticGaps: 0,
        reportedFindings: 0,
      },
      causeCodes: [],
      findings: [],
      truncation: { truncated: false, omittedFindings: 0 },
      reproduce: 'npm run guard:guard-test-coverage -- --semantic-mode enforce --format json',
    });
    expect(invoked.stdout.endsWith('\n')).toBe(true);
  });

  it('uses stable per-finding codes and exit 1 for actionable structural gaps', () => {
    const dir = makeFixture([{ file: 'sample-guard.ts' }]);

    const invoked = invokeCli(['--format', 'json'], dir);
    const report = parseGuardTestCoverageReportBytes(Buffer.from(invoked.stdout));

    expect(invoked.exitCode).toBe(1);
    expect(invoked.stderr).toBe('');
    expect(report).toMatchObject({
      outcome: 'block',
      exitCode: 1,
      code: 'test.guard-coverage.block',
      causeCodes: ['test.guard-coverage.test-missing'],
      findings: [{
        code: 'test.guard-coverage.test-missing',
        decision: 'block',
        guard: 'scripts/sample-guard.ts',
        expectedTest: 'tests/scripts/sample-guard.test.ts',
      }],
    });
    expect(invoked.stdout).not.toContain(dir);
  });

  it('keeps a semantic gap advisory in shadow mode and blocking in enforce mode', () => {
    const dir = makeFixture([{ file: 'sample-guard.ts', writeTest: true, wired: true }]);

    const shadow = parseGuardTestCoverageReportBytes(Buffer.from(
      invokeCli(['--semantic-mode', 'shadow', '--format', 'json'], dir).stdout,
    ));
    const enforcedInvocation = invokeCli(['--semantic-mode', 'enforce', '--format', 'json'], dir);
    const enforced = parseGuardTestCoverageReportBytes(Buffer.from(enforcedInvocation.stdout));

    expect(shadow).toMatchObject({ outcome: 'warn', exitCode: 0, code: 'test.guard-coverage.semantic-shadow' });
    expect(shadow.findings[0]).toMatchObject({
      code: 'test.guard-coverage.guard-not-invoked',
      decision: 'warn',
    });
    expect(shadow.reproduce)
      .toBe('npm run guard:guard-test-coverage -- --semantic-mode shadow --format json');
    expect(enforcedInvocation.exitCode).toBe(1);
    expect(enforced).toMatchObject({ outcome: 'block', exitCode: 1, code: 'test.guard-coverage.block' });
    expect(enforced.findings[0]).toMatchObject({ decision: 'block' });
    expect(enforced.reproduce)
      .toBe('npm run guard:guard-test-coverage -- --semantic-mode enforce --format json');
  });

  it.each([
    { args: ['--format', 'json', '--unknown'], code: 'ci.input.option-unknown' },
    { args: ['--format', 'json', '--verbose', '--verbose'], code: 'ci.input.duplicate-option' },
    { args: ['--format', 'json', '--semantic-mode'], code: 'ci.input.option-value-missing' },
    { args: ['--format', 'json', '--semantic-mode', 'future'], code: 'ci.input.option-value-invalid' },
    { args: ['--format', 'json', '--format', 'yaml'], code: 'ci.input.duplicate-option' },
  ])('maps malformed invocation to exit 2 without raw argv ($code)', ({ args, code }) => {
    const dir = makeFixture([{ file: 'sample-guard.ts', allowlist: 'fixture' }]);

    const invoked = invokeCli(args, dir);
    const report = parseGuardTestCoverageReportBytes(Buffer.from(invoked.stdout));

    expect(invoked.exitCode).toBe(2);
    expect(invoked.stderr).toBe('');
    expect(report).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code });
    expect(invoked.stdout).not.toContain('--unknown');
    expect(invoked.stdout).not.toContain('future');
  });

  it('maps an unavailable scan to exit 2 without exposing the absolute root or exception', () => {
    const dir = tmp.make('coverage-cli-missing-scripts');

    const invoked = invokeCli(['--format', 'json'], dir);
    const report = parseGuardTestCoverageReportBytes(Buffer.from(invoked.stdout));

    expect(invoked.exitCode).toBe(2);
    expect(invoked.stderr).toBe('');
    expect(report).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'test.guard-coverage.scan-unavailable',
    });
    expect(invoked.stdout).not.toContain(dir);
    expect(invoked.stdout).not.toMatch(/ENOENT|no such file/i);
  });

  it('refuses an empty guard inventory as inconclusive instead of passing vacuously', () => {
    const dir = makeFixture([]);

    const invoked = invokeCli(['--format', 'json'], dir);
    const report = parseGuardTestCoverageReportBytes(Buffer.from(invoked.stdout));

    expect(invoked.exitCode).toBe(2);
    expect(report).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'test.guard-coverage.inventory-empty',
    });
  });

  it('distinguishes an over-limit guard inventory from an unavailable scan', () => {
    const guards = Array.from(
      { length: 2_049 },
      (_, index) => ({ file: `limit-${String(index).padStart(4, '0')}-guard.ts` }),
    );
    const dir = makeFixture(guards);

    const invoked = invokeCli(['--format', 'json'], dir);
    const report = parseGuardTestCoverageReportBytes(Buffer.from(invoked.stdout));

    expect(invoked.exitCode).toBe(2);
    expect(report).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'test.guard-coverage.inventory-limit-exceeded',
    });
  });

  it('bounds machine findings and reports omitted evidence explicitly', () => {
    const guards = Array.from(
      { length: MAX_GUARD_COVERAGE_FINDINGS + 3 },
      (_, index) => ({
        file: `missing-${String(index).padStart(3, '0')}-${'x'.repeat(200)}-guard.ts`,
      }),
    );
    const dir = makeFixture(guards);

    const output = invokeCli(['--format', 'json'], dir).stdout;
    const report = parseGuardTestCoverageReportBytes(Buffer.from(output));

    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(report.findings).toHaveLength(MAX_GUARD_COVERAGE_FINDINGS);
    expect(report.truncation).toEqual({ truncated: true, omittedFindings: 3 });
    expect(report.causeCodes).toContain('test.guard-coverage.output-truncated');
    expect(report.counts.structuralGaps).toBe(MAX_GUARD_COVERAGE_FINDINGS + 3);
    expect(report.counts.reportedFindings).toBe(MAX_GUARD_COVERAGE_FINDINGS);
  });

  it('sorts machine findings deterministically regardless of fixture creation order', () => {
    const left = makeFixture([
      { file: 'ä-guard.ts' },
      { file: 'z-guard.ts' },
      { file: 'a-guard.ts' },
    ]);
    const right = makeFixture([
      { file: 'a-guard.ts' },
      { file: 'z-guard.ts' },
      { file: 'ä-guard.ts' },
    ]);

    const leftJson = invokeCli(['--format', 'json'], left).stdout;
    const rightJson = invokeCli(['--format', 'json'], right).stdout;

    expect(leftJson).toBe(rightJson);
    expect(parseGuardTestCoverageReportBytes(Buffer.from(leftJson)).findings.map(({ guard }) => guard))
      .toEqual(['scripts/a-guard.ts', 'scripts/z-guard.ts', 'scripts/ä-guard.ts']);
  });

  it('removes the blocking finding only after a real failure proof is added', () => {
    const dir = makeFixture([{ file: 'sample-guard.ts', wired: true }]);
    expect(invokeCli(['--semantic-mode', 'enforce', '--format', 'json'], dir).exitCode).toBe(1);

    writeFileSync(
      path.join(dir, 'tests/scripts/sample-guard.test.ts'),
      failureProofTestBody(),
      'utf8',
    );

    const repaired = parseGuardTestCoverageReportBytes(Buffer.from(
      invokeCli(['--semantic-mode', 'enforce', '--format', 'json'], dir).stdout,
    ));
    expect(repaired).toMatchObject({ outcome: 'pass', exitCode: 0, findings: [] });
  });

  it('adds bounded covered and allowlisted inventories only in verbose text mode', () => {
    const dir = makeFixture([
      {
        file: 'covered-guard.ts',
        writeTest: true,
        wired: true,
        testBody: failureProofTestBody('covered-guard.ts'),
      },
      { file: 'allowlisted-guard.ts', allowlist: 'covered by a fixture integration proof' },
    ]);

    const concise = invokeCli([], dir);
    const verbose = invokeCli(['--verbose'], dir);

    expect(concise.stdout).not.toContain('COVERED scripts/covered-guard.ts');
    expect(verbose.stdout).toContain('COVERED scripts/covered-guard.ts');
    expect(verbose.stdout).toContain('ALLOWLISTED scripts/allowlisted-guard.ts');
    expect(verbose.stdout.length).toBeLessThan(32_768);
  });

  it('rejects extra native-report keys instead of accepting schema drift', () => {
    const dir = makeFixture([{ file: 'sample-guard.ts', allowlist: 'fixture' }]);
    const report = JSON.parse(invokeCli(['--format', 'json'], dir).stdout) as Record<string, unknown>;
    report.extra = true;

    expect(() => parseGuardTestCoverageReportBytes(Buffer.from(JSON.stringify(report))))
      .toThrow(/test\.guard-coverage\.report\.invalid-keys/);
  });

  it('rejects cause codes that are not supported by the verdict and visible findings', () => {
    const passingDir = makeFixture([{ file: 'sample-guard.ts', allowlist: 'fixture' }]);
    const passingReport = JSON.parse(
      invokeCli(['--format', 'json'], passingDir).stdout,
    ) as { causeCodes: string[] };
    passingReport.causeCodes = ['test.guard-coverage.test-missing'];

    expect(() => parseGuardTestCoverageReportBytes(Buffer.from(JSON.stringify(passingReport))))
      .toThrow(/test\.guard-coverage\.report\.cause-code-mismatch/);

    const blockingDir = makeFixture([{ file: 'sample-guard.ts' }]);
    const blockingReport = JSON.parse(
      invokeCli(['--format', 'json'], blockingDir).stdout,
    ) as { causeCodes: string[] };
    blockingReport.causeCodes = [
      'test.guard-coverage.failure-not-proved',
      'test.guard-coverage.test-missing',
    ];

    expect(() => parseGuardTestCoverageReportBytes(Buffer.from(JSON.stringify(blockingReport))))
      .toThrow(/test\.guard-coverage\.report\.cause-code-mismatch/);
  });

  it('rejects a report that hides findings behind a false truncation boundary', () => {
    const dir = makeFixture([{ file: 'a-guard.ts' }, { file: 'b-guard.ts' }]);
    const report = JSON.parse(invokeCli(['--format', 'json'], dir).stdout) as {
      counts: { reportedFindings: number };
      causeCodes: string[];
      findings: unknown[];
      truncation: { truncated: boolean; omittedFindings: number };
    };
    report.counts.reportedFindings = 0;
    report.findings = [];
    report.causeCodes = [
      'test.guard-coverage.output-truncated',
      'test.guard-coverage.test-missing',
    ];
    report.truncation = { truncated: true, omittedFindings: 2 };

    expect(() => parseGuardTestCoverageReportBytes(Buffer.from(JSON.stringify(report))))
      .toThrow(/test\.guard-coverage\.report\.count-mismatch/);
  });

  it('rejects machine findings that are not unique and canonically sorted', () => {
    const dir = makeFixture([{ file: 'a-guard.ts' }, { file: 'b-guard.ts' }]);
    const report = JSON.parse(invokeCli(['--format', 'json'], dir).stdout) as {
      findings: unknown[];
    };
    report.findings.reverse();

    expect(() => parseGuardTestCoverageReportBytes(Buffer.from(JSON.stringify(report))))
      .toThrow(/test\.guard-coverage\.report\.invalid-finding-order/);
  });

  it('publishes a closed help contract without scanning the repository', () => {
    const dir = tmp.make('coverage-help-no-repo');
    const invoked = invokeCli(['--help'], dir);

    expect(invoked).toMatchObject({ exitCode: 0, stderr: '' });
    expect(invoked.stdout).toContain('--semantic-mode <shadow|enforce>');
    expect(invoked.stdout).toContain('--format <text|json>');
    expect(invoked.stdout).toContain('--verbose');
  });

  it('loads through the pinned runtime strip-only TypeScript path', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const invoked = spawnSync(process.execPath, [
      '--experimental-strip-types',
      path.join(repoRoot, 'scripts/guard-test-coverage-check.ts'),
      '--semantic-mode',
      'enforce',
      '--format',
      'json',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(invoked.status, invoked.stderr).toBe(0);
    expect(parseGuardTestCoverageReportBytes(Buffer.from(invoked.stdout)))
      .toMatchObject({ outcome: 'pass', exitCode: 0 });
  });
});

describe('guard-test-coverage meta-guard — real repo', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('passes against the real repository (all current guards are covered)', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const result = findGuardsMissingTests({ cwd: repoRoot });
    // Every current guard script must ship a wired companion test (or carry an
    // honest allowlist comment). If this fails, a guard shipped untested.
    expect(result.gaps).toEqual([]);
    expect(result.semanticGaps).toEqual([]);
    expect(result.covered.length).toBeGreaterThan(0);
  });
});
