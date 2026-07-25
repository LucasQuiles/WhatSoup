// tests/eslint-rules/require-catch-justification.test.ts
// Tests for the fitness/require-catch-justification rule (#2190).
//
// Verifies the rule:
//   1. flags a bare catch {} (no param, empty body) that is not in the baseline
//   2. exempts a catch with a bound variable (catch (e))
//   3. exempts a bare catch with a justification comment
//   4. exempts a bare catch present in the ratchet baseline
//   5. reports nothing when the whole src/ tree is linted with the real baseline
//      (the ratchet invariant: zero new findings today)
import { ESLint } from 'eslint';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import fitnessPlugin from '../../eslint-rules/index.mjs';
import tseslint from 'typescript-eslint';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_BASELINE = resolve(REPO_ROOT, 'eslint-rules/catch-ratchet-baseline.json');
const NO_BASELINE = '/dev/null/nonexistent-baseline.json';

// A synthetic in-repo path matching the `src/**/*.ts` files glob, so lintText
// applies the config. No real file needs to exist for lintText.
const SYNTH_PATH = 'src/__catch_probe__.ts';

async function makeEslint(baselinePath: string): Promise<ESLint> {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['src/**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
      },
      plugins: { fitness: fitnessPlugin },
      rules: {
        'fitness/require-catch-justification': [
          'warn',
          { baselinePath },
        ],
      },
    },
  });
}

type Msg = { ruleId: string | null; line: number };
type Result = { messages: Msg[] };

function ruleHits(results: Result[]): number {
  return results.reduce(
    (sum, r) => sum + r.messages.filter((m) => m.ruleId === 'fitness/require-catch-justification').length,
    0,
  );
}

describe('fitness/require-catch-justification (#2190)', () => {
  it('flags a bare catch {} with no param and empty body', async () => {
    const eslint = await makeEslint(NO_BASELINE);
    const results = await eslint.lintText(
      'export function f() {\n  try { x(); } catch {}\n}\n',
      { filePath: SYNTH_PATH },
    );
    expect(ruleHits(results as Result[])).toBe(1);
  }, 60_000);

  it('exempts a catch with a bound variable', async () => {
    const eslint = await makeEslint(NO_BASELINE);
    const results = await eslint.lintText(
      'export function f() {\n  try { x(); } catch (e) { /* bound */ }\n}\n',
      { filePath: SYNTH_PATH },
    );
    expect(ruleHits(results as Result[])).toBe(0);
  }, 60_000);

  it('exempts a bare catch with a justification comment', async () => {
    const eslint = await makeEslint(NO_BASELINE);
    const results = await eslint.lintText(
      'export function f() {\n  try { x(); } catch { /* intentional: best-effort cleanup */ }\n}\n',
      { filePath: SYNTH_PATH },
    );
    expect(ruleHits(results as Result[])).toBe(0);
  }, 60_000);

  it('exempts a bare catch present in the ratchet baseline', async () => {
    // database-compatibility.ts:172 is in the generated baseline; with the real
    // baseline the rule must not flag it.
    const eslint = await makeEslint(REAL_BASELINE);
    const results = await eslint.lintFiles(['src/core/database-compatibility.ts']);
    expect(ruleHits(results as Result[])).toBe(0);
  }, 60_000);

  it('reports ZERO new findings across the whole src/ tree with the real baseline (ratchet invariant)', async () => {
    // The defining ratchet property: with the committed baseline, the rule emits
    // no findings today. New bare catches will break this test until baselined.
    const eslint = await makeEslint(REAL_BASELINE);
    const results = await eslint.lintFiles(['src/']);
    expect(ruleHits(results as Result[])).toBe(0);
  }, 180_000);
});
