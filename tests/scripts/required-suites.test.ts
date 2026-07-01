import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isFitnessGuardSuite,
  referenceTokens,
  functionalSuites,
  fitnessGuardSuites,
  computeRequiredSuites,
} from '../../scripts/required-suites.ts';

/**
 * Build a fixture repo with a `tests/` tree. Each entry is a repo-relative test
 * path plus its file body (defaults to an empty test).
 */
function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'required-suites-'));
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
  it('includes ALL fitness/guard suites regardless of what changed', () => {
    const dir = makeFixture({
      'tests/scripts/dedup-reaccumulation-guard.test.ts': 'test',
      'tests/scripts/fitness-file-size-warning-budget.test.ts': 'test',
      'tests/core/plain.test.ts': 'test',
    });
    const fitness = fitnessGuardSuites(dir);
    expect(fitness).toContain('tests/scripts/dedup-reaccumulation-guard.test.ts');
    expect(fitness).toContain('tests/scripts/fitness-file-size-warning-budget.test.ts');
    expect(fitness).not.toContain('tests/core/plain.test.ts');
  });
});

describe('functionalSuites (referencing half — closes the #1507 gap)', () => {
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
