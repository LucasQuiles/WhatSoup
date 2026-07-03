/**
 * arch.file-size warning budget ratchet.
 *
 * The ESLint fitness ring is warn-only (exits 0) per meta.no-redundant-gates —
 * arch.file-size is already blocked by the guard/ci ring against
 * .claude/fitness/baseline.json. This test enforces that the advisory ESLint
 * warning identity set for arch.file-size (enforced via the built-in max-lines
 * rule) must exactly match the current grandfathered files.
 *
 * If this test fails, either a new over-size file was introduced (fix: split the
 * file before merging) or the baseline was legitimately extended (fix: update
 * EXPECTED_FILE_SIZE_WARNING_FILES and add a baseline entry to
 * .claude/fitness/baseline.json).
 */
import { describe, it, expect } from 'vitest';
import { runEslintFitness } from '../../scripts/eslint-fitness-check.ts';

const EXPECTED_FILE_SIZE_WARNING_FILES = [
  'src/runtimes/agent/runtime.ts',
  'src/runtimes/agent/session.ts',
  'src/transport/connection.ts',
  'tests/config.test.ts',
  'tests/core/health.test.ts',
  // The substrate poller suite intentionally keeps the SQL/file/url/throttle
  // edge cases beside the shared in-memory database scaffolding while this
  // coverage stack closes fail-closed behavior gaps.
  'tests/core/substrate/poller.test.ts',
  'tests/fleet/health-poller.test.ts',
  'tests/fleet/index.test.ts',
  'tests/fleet/routes/feed.test.ts',
  'tests/fleet/routes/ops.test.ts',
  'tests/runtimes/agent/outbound-queue.test.ts',
  'tests/runtimes/agent/runtime.test.ts',
  'tests/runtimes/agent/session.test.ts',
  'tests/runtimes/chat/providers/pinecone.test.ts',
  // BEAD-056 added 4 regression tests (#1064 inbound-close parity) to the
  // DurabilityEngine integration block, taking this file 1929→2022 lines, just
  // over the 2000-line arch.file-size warn budget. The new tests reuse the
  // file's shared scaffolding (makeHandler/makeDurability/handleAndDrain), so
  // extracting them would duplicate that setup; grandfathered per the project
  // norm for large cohesive test files (cf. the agent runtime/session twins).
  'tests/runtimes/chat/runtime.test.ts',
  'tests/scripts/bot-errors-health-check.test.ts',
  'tests/transport/reconnect.test.ts',
].sort();

describe('arch.file-size warning budget', () => {
  it('arch.file-size ESLint warning files must match the grandfathered identity set', async () => {
    const result = await runEslintFitness(process.cwd());
    const fileSizeWarningFiles = result.issues
      .filter((issue) => issue.code === 'max-lines')
      .map((issue) => issue.filePath)
      .sort();

    expect(fileSizeWarningFiles).toEqual(EXPECTED_FILE_SIZE_WARNING_FILES);
    // Full-repo ESLint run regularly exceeds the default 10s under coverage
    // instrumentation or CI load.
  }, 120_000);
});
