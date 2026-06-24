import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  companionTestCandidates,
  enumerateGuardScripts,
  findGuardsMissingTests,
  run,
} from '../../scripts/guard-test-coverage-check.ts';

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
  }[],
): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-test-coverage-'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'tests', 'scripts'), { recursive: true });

  const wiredTestPaths: string[] = [];

  for (const guard of guards) {
    const guardBody = guard.allowlist
      ? `// meta-guard:no-test ${guard.allowlist}\nexport const x = 1;\n`
      : 'export const x = 1;\n';
    writeFileSync(path.join(dir, 'scripts', guard.file), guardBody, 'utf8');

    if (guard.writeTest) {
      const base = guard.testBasename ?? guard.file.replace(/\.ts$/, '');
      writeFileSync(
        path.join(dir, 'tests', 'scripts', `${base}.test.ts`),
        'import { it } from "vitest"; it("noop", () => {});\n',
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
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-test-coverage-missing-scripts-'));
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
