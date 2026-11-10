import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanGitEnv } from '../../src/lib/git-env.ts';

import {
  isFitnessGuardSuite,
  referenceTokens,
  functionalSuites,
  fitnessGuardSuites,
  computeRequiredSuites,
  resolveChangedFiles,
} from '../../scripts/required-suites.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync), readFileSync: vi.fn(actual.readFileSync) };
});

const fixtureDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of fixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a fixture repo with a `tests/` tree. Each entry is a repo-relative test
 * path plus its file body (defaults to an empty test).
 */
function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'required-suites-'));
  fixtureDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

describe('isFitnessGuardSuite', () => {
  it('classifies tests/scripts/* as fitness/guard suites', () => {
    expect(isFitnessGuardSuite('tests/scripts/dedup-reaccumulation-guard.test.ts')).toBe(true);
    expect(isFitnessGuardSuite('tests/scripts/fitness-file-size-warning-budget.test.ts')).toBe(true);
  });

  it('classifies guard/fitness-named suites outside tests/scripts (inclusive by design)', () => {
    expect(isFitnessGuardSuite('tests/core/echo-guard.test.ts')).toBe(true);
    // basename contains "guard" (guardrails) -> included; a triage aid errs toward inclusion.
    expect(isFitnessGuardSuite('tests/mcp/tools/relay-guardrails.test.ts')).toBe(true);
    // no guard/fitness token in the basename and not under tests/scripts -> excluded.
    expect(isFitnessGuardSuite('tests/mcp/tools/relay-timeout.test.ts')).toBe(false);
  });

  it('rejects non-fitness functional suites and non-test files', () => {
    expect(isFitnessGuardSuite('tests/runtimes/agent/recovery-probe-validity.test.ts')).toBe(false);
    expect(isFitnessGuardSuite('tests/scripts/helper.ts')).toBe(false);
  });

  it('recognizes TSX suites as test suites', () => {
    expect(isFitnessGuardSuite('tests/scripts/console-policy-guard.test.tsx')).toBe(true);
  });
});

describe('referenceTokens', () => {
  it('yields the extensionless module path and bare basename', () => {
    expect(referenceTokens('src/runtimes/agent/providers/primary-model-usability.ts')).toEqual(
      expect.arrayContaining([
        'src/runtimes/agent/providers/primary-model-usability',
        'primary-model-usability',
      ]),
    );
  });
});

describe('fitnessGuardSuites (∪-ALL half — closes the #1514 gap)', () => {
  it('the CLI rejects a missing test root rather than reporting an empty required set', () => {
    const dir = makeFixture({});
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/required-suites.ts'), '--json', 'src/thing.ts',
    ], { cwd: dir, env: cleanGitEnv(), encoding: 'utf8', timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('"required"');
    expect(result.stderr).toContain('ENOENT');
  });

  it('rejects an unreadable subtree instead of reporting a partial suite set', async () => {
    const dir = makeFixture({
      'tests/core/plain.test.ts': 'test',
      'tests/scripts/policy-guard.test.ts': 'test',
    });
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(readdirSync).mockImplementation((...args) => {
      if (String(args[0]) === path.join(dir, 'tests/scripts')) {
        throw Object.assign(new Error('test subtree unreadable'), { code: 'EACCES' });
      }
      return Reflect.apply(actual.readdirSync, actual, args);
    });
    expect(() => computeRequiredSuites(dir, ['src/thing.ts'])).toThrow('test subtree unreadable');
  });

  it('includes ALL fitness/guard suites regardless of what changed', () => {
    const dir = makeFixture({
      'tests/scripts/dedup-reaccumulation-guard.test.ts': 'test',
      'tests/scripts/fitness-file-size-warning-budget.test.ts': 'test',
      'tests/scripts/console-policy-guard.test.tsx': 'test',
      'tests/core/plain.test.ts': 'test',
    });
    const fitness = fitnessGuardSuites(dir);
    expect(fitness).toContain('tests/scripts/dedup-reaccumulation-guard.test.ts');
    expect(fitness).toContain('tests/scripts/fitness-file-size-warning-budget.test.ts');
    expect(fitness).toContain('tests/scripts/console-policy-guard.test.tsx');
    expect(fitness).not.toContain('tests/core/plain.test.ts');
  });
});

describe('functionalSuites (referencing half — closes the #1507 gap)', () => {
  it('rejects an unreadable test file rather than silently omitting its references', async () => {
    const dir = makeFixture({ 'tests/core/thing.test.ts': "import '../../src/thing.ts';" });
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(readFileSync).mockImplementation((...args) => {
      if (String(args[0]) === path.join(dir, 'tests/core/thing.test.ts')) {
        throw Object.assign(new Error('test file unreadable'), { code: 'EACCES' });
      }
      return Reflect.apply(actual.readFileSync, actual, args);
    });
    expect(() => computeRequiredSuites(dir, ['src/thing.ts'])).toThrow('test file unreadable');
  });

  it('includes the suite that references the changed source module', () => {
    const dir = makeFixture({
      'tests/runtimes/agent/recovery-probe-validity.test.ts':
        "import type { X } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';",
      'tests/core/unrelated.test.ts': "import './something-else.ts';",
    });
    const functional = functionalSuites(dir, [
      'src/runtimes/agent/providers/primary-model-usability.ts',
    ]);
    expect(functional).toContain('tests/runtimes/agent/recovery-probe-validity.test.ts');
    expect(functional).not.toContain('tests/core/unrelated.test.ts');
  });

  it('includes a changed file that is itself a test suite', () => {
    const dir = makeFixture({
      'tests/core/thing.test.ts': 'test',
    });
    const functional = functionalSuites(dir, ['tests/core/thing.test.ts']);
    expect(functional).toEqual(['tests/core/thing.test.ts']);
  });

  it('includes a changed TSX suite directly', () => {
    const dir = makeFixture({
      'tests/console/thing.test.tsx': 'test',
    });
    const functional = functionalSuites(dir, ['tests/console/thing.test.tsx']);
    expect(functional).toEqual(['tests/console/thing.test.tsx']);
  });
});

describe('resolveChangedFiles', () => {
  it('does not mistake the --base value for a changed path', () => {
    const result = resolveChangedFiles('/unused', [
      '--base',
      'origin/release',
      'src/console/App.tsx',
    ]);

    expect(result).toEqual({ changed: ['src/console/App.tsx'], source: 'args' });
  });

  it('rejects unknown options, missing option values, and unsafe explicit paths', () => {
    expect(() => resolveChangedFiles('/unused', ['--unexpected'])).toThrow('Unknown option');
    expect(() => resolveChangedFiles('/unused', ['--base'])).toThrow('Missing value for --base');
    expect(() => resolveChangedFiles('/unused', ['../src/core/server.ts'])).toThrow('Unsafe path');
    expect(() => resolveChangedFiles('/unused', ['/tmp/server.ts'])).toThrow('Unsafe path');
    expect(() => resolveChangedFiles('/unused', ['src/core/server\n.ts'])).toThrow('Unsafe path');
  });
});

describe('computeRequiredSuites (the invariant: functional ∪ fitness)', () => {
  it('unions referencing suites with the full fitness/guard batch', () => {
    const dir = makeFixture({
      'tests/runtimes/agent/recovery-probe-validity.test.ts':
        "import '../../../src/runtimes/agent/providers/primary-model-usability.ts';",
      'tests/scripts/dedup-reaccumulation-guard.test.ts': 'test',
      'tests/scripts/fitness-file-size-warning-budget.test.ts': 'test',
      'tests/core/unrelated.test.ts': 'test',
    });
    const result = computeRequiredSuites(dir, [
      'src/runtimes/agent/providers/primary-model-usability.ts',
    ]);
    // Functional half (#1507) present:
    expect(result.required).toContain('tests/runtimes/agent/recovery-probe-validity.test.ts');
    // Fitness half (#1514) present even though those sources were not changed:
    expect(result.required).toContain('tests/scripts/dedup-reaccumulation-guard.test.ts');
    expect(result.required).toContain('tests/scripts/fitness-file-size-warning-budget.test.ts');
    // Unrelated non-referencing, non-fitness suite excluded:
    expect(result.required).not.toContain('tests/core/unrelated.test.ts');
    // required is the sorted de-duplicated union.
    expect(result.required).toEqual([...new Set(result.required)].sort());
  });
});
