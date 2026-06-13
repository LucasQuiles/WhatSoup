/**
 * arch.file-size warning budget ratchet.
 *
 * The ESLint fitness ring is warn-only (exits 0) per meta.no-redundant-gates —
 * arch.file-size is already blocked by the guard/ci ring against
 * .claude/fitness/baseline.json. This test enforces that the advisory ESLint
 * warning count for arch.file-size (enforced via the built-in max-lines rule)
 * must not grow beyond the current grandfathered count.
 *
 * If this test fails, either a new over-size file was introduced (fix: split the
 * file before merging) or the baseline was legitimately extended (fix: update
 * BUDGET_MAX and add a baseline entry to .claude/fitness/baseline.json).
 */
import { describe, it, expect } from 'vitest';
import { runEslintFitness } from '../../scripts/eslint-fitness-check.ts';

// Current grandfathered over-size files: src/runtimes/agent/runtime.ts,
// src/transport/connection.ts, tests/core/health.test.ts,
// tests/fleet/health-poller.test.ts, tests/runtimes/agent/runtime.test.ts,
// tests/runtimes/agent/session.test.ts, tests/scripts/bot-errors-health-check.test.ts
const BUDGET_MAX = 7;

describe('arch.file-size warning budget', () => {
  it(`arch.file-size ESLint warnings must not exceed ${BUDGET_MAX}`, async () => {
    const result = await runEslintFitness(process.cwd());
    const fileSizeWarnings = result.issues.filter(
      (issue) => issue.code === 'max-lines',
    );
    expect(fileSizeWarnings.length).toBeLessThanOrEqual(BUDGET_MAX);
    // Full-repo ESLint run regularly exceeds the default 10s under coverage
    // instrumentation or CI load.
  }, 120_000);
});
