/**
 * portability.sync-exec-timeout warning budget — held at ZERO.
 *
 * The ESLint fitness ring is warn-only (exits 0) per meta.no-redundant-gates,
 * so this test is the enforcing layer: after the Car-D sweep added `timeout`
 * to the last 7 bare execFileSync sites in scripts/, no execSync /
 * execFileSync / spawnSync call in the linted tree may lack a timeout. A
 * synchronous child process without one blocks its whole process forever on
 * a hung child (the #2620/#2629 fragility class).
 *
 * If this test fails with a NEW entry: add `timeout:` to the flagged call's
 * options (30_000 is the repo convention for git plumbing) — do not grow the
 * grandfather set; its only members are rule false positives.
 */
import { describe, it, expect } from 'vitest';
import { runEslintFitness } from '../../scripts/eslint-fitness-check.ts';

/**
 * Rule false positives, hand-verified: these calls spread
 * `...keyringExecOptions` (src/lib/keyring.ts:118), which DOES carry
 * `timeout: KEYRING_COMMAND_TIMEOUT_MS` — the rule cannot resolve spread
 * identifiers. If keyring.ts shifts these lines, re-verify the spread still
 * carries the timeout, then update the pinned lines.
 */
const SPREAD_CARRIED_TIMEOUT_SITES = [
  'src/lib/keyring.ts:500',
  'src/lib/keyring.ts:524',
  'src/lib/keyring.ts:756',
  'src/lib/keyring.ts:797',
];

describe('portability.sync-exec-timeout warning budget', () => {
  it('no sync exec call in the linted tree lacks a timeout (spread-carried sites pinned)', async () => {
    const result = await runEslintFitness(process.cwd());
    expect(result.filesLinted).toBeGreaterThan(0);
    const offenders = result.issues
      .filter((issue) => issue.code === 'fitness/sync-exec-timeout')
      .map((issue) => `${issue.filePath}:${issue.line}`)
      .sort();

    expect(offenders).toEqual(SPREAD_CARRIED_TIMEOUT_SITES);
    // Same full-repo ESLint run budget as the file-size warning test: the run
    // regularly exceeds vitest's 10s default under coverage instrumentation.
  }, 300_000);
});
