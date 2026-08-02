import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  companionTestCandidates,
  enumerateGuardScripts,
  findGuardsMissingTests,
  run,
} from '../../scripts/guard-test-coverage-check.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('guard-test-');

/**
 * Build a minimal repo fixture with a `scripts/` dir, a `tests/scripts/` dir,
 * and a package.json whose `verify:push:branch` lists the given test paths.
 *
 * Each guard spec declares: the guard filename, whether a companion test file
 * is written, whether that test path is wired into verify:push:branch, and an
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

  const verifyPushBranch = `npm run guard:foo && npm test -- ${wiredTestPaths.join(' ')} --pool=forks`;
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: 'fixture', scripts: { 'verify:push:branch': verifyPushBranch } },
      null,
      2,
    ),
    'utf8',
  );

  return dir;
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
    expect(printed).toContain('guard-test-coverage check failed');
    expect(printed).toContain('sample-guard.ts');
  });

  it('run() passes (exit code untouched) when all guards are covered', () => {
    const dir = makeFixture([
      { file: 'sample-guard.ts', writeTest: true, wired: true },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    run([], dir, {});

    expect(process.exitCode).not.toBe(1);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('guard-test-coverage check passed');
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
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('SEMANTIC-TEST-GAP');
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
    expect(result.covered.length).toBeGreaterThan(0);
  });
});
