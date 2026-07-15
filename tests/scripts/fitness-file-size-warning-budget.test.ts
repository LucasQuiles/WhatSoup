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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import { runEslintFitness } from '../../scripts/eslint-fitness-check.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface FileSizeMeasurement {
  filePath: string;
  lines: number;
  maxLines: number;
}

interface FitnessBaseline {
  schemaVersion: number;
  generatedAt: string;
  rules: Record<string, { measurements: FileSizeMeasurement[] }>;
}

function readBaseline(): FitnessBaseline {
  return JSON.parse(
    readFileSync(resolve(repoRoot, '.claude/fitness/baseline.json'), 'utf8'),
  ) as FitnessBaseline;
}

// Mirrors wc -l (count of newline characters), not content.split('\n').length,
// which would over-count by one for any file ending in a trailing newline.
function countLines(absolutePath: string): number {
  const content = readFileSync(absolutePath, 'utf8');
  return (content.match(/\n/g) ?? []).length;
}

const REQUIRED_BUMP_HINT =
  'consider docs/architecture/fitness-taxonomy.md twin-handler slicing before bumping runtime.ts';

function ceilingBumpMessage(measurement: FileSizeMeasurement, actualLines: number): string {
  return [
    `${measurement.filePath} grew to ${actualLines} lines, exceeding the recorded ceiling of ` +
      `${measurement.maxLines} in .claude/fitness/baseline.json.`,
    'To bump this ceiling intentionally, edit BOTH twins together:',
    '  1. .claude/fitness/baseline.json -- set the "lines" and "maxLines" fields for this' +
      ' measurement to the freshly measured wc -l count.',
    '  2. docs/architecture/fitness-taxonomy.md -- update the Ratchet Baseline table entry to match.',
    `Before bumping, ${REQUIRED_BUMP_HINT}.`,
  ].join('\n');
}

const EXPECTED_FILE_SIZE_WARNING_FILES = [
  // #1749 recovery-owner reclaim added the bucket-4 sweep query + reclaim
  // wiring to this cohesive core durability engine, taking it just over the
  // 2000-line arch.file-size warn budget (~2076). Grandfathered per the project
  // norm for large core files; a durability.ts slice is a separate follow-up.
  'src/core/durability.ts',
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
    // instrumentation or CI load. The prior 120s override was itself hit on
    // quality(24.x) for PR #1782 (GitHub Actions run 29316490688); 300s gives
    // durable headroom without masking a genuine hang.
  }, 300_000);

  it('the ceiling-bump failure message documents the two-twin bump ceremony', () => {
    // This pins requirement wording so the remediation text stays intact even
    // if the growth-ceiling assertion below never fails in CI.
    const message = ceilingBumpMessage(
      { filePath: 'src/runtimes/agent/runtime.ts', lines: 1, maxLines: 1 },
      2,
    );

    expect(message).toContain('.claude/fitness/baseline.json');
    expect(message).toContain('docs/architecture/fitness-taxonomy.md');
    expect(message).toContain(REQUIRED_BUMP_HINT);
  });

  it('grandfathered arch.file-size files must not grow past their recorded ceiling', () => {
    const baseline = readBaseline();
    const measurements = baseline.rules['arch.file-size']?.measurements ?? [];
    expect(measurements.length).toBeGreaterThan(0);

    const shrinkWarnings: string[] = [];

    for (const measurement of measurements) {
      expect(
        typeof measurement.maxLines,
        `${measurement.filePath} has no recorded maxLines ceiling in .claude/fitness/baseline.json`,
      ).toBe('number');

      const actualLines = countLines(resolve(repoRoot, measurement.filePath));

      expect(actualLines, ceilingBumpMessage(measurement, actualLines)).toBeLessThanOrEqual(
        measurement.maxLines,
      );

      if (actualLines < measurement.maxLines) {
        shrinkWarnings.push(
          `${measurement.filePath}: shrank to ${actualLines} lines (recorded ceiling ` +
            `${measurement.maxLines}); consider lowering the ceiling in .claude/fitness/baseline.json.`,
        );
      }
    }

    if (shrinkWarnings.length > 0) {
      // Non-blocking: shrinkage is always allowed and never auto-lowers the
      // recorded ceiling. This is a nudge for a human to bump it down, not a
      // failure.
      console.warn(`arch.file-size ceiling WARN (non-blocking):\n${shrinkWarnings.join('\n')}`);
    }
  });
});
