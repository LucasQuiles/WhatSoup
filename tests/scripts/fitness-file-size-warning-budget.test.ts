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
  'see "Growing past a ceiling" in docs/architecture/fitness-taxonomy.md: extract pure code ' +
  'out of the file to create headroom (precedents 0af939b95, PR #2563)';

function ceilingBumpMessage(measurement: FileSizeMeasurement, actualLines: number): string {
  return [
    `${measurement.filePath} grew to ${actualLines} lines, exceeding the recorded ceiling of ` +
      `${measurement.maxLines} in .claude/fitness/baseline.json.`,
    'Raising the ceiling is blocked: guard:baseline-growth refuses any baseline increase ' +
      '(a baseline may only shrink).',
    `To land this change, ${REQUIRED_BUMP_HINT}.`,
    'If widening is genuinely unavoidable, land it as its own reviewed change that says why.',
  ].join('\n');
}

const EXPECTED_FILE_SIZE_WARNING_FILES = [
  // The q-partition-recovery-bridge merge re-added migratedSchemaSnapshot to
  // this core database module, taking it to 2069 lines — just over the
  // 2000-line arch.file-size warn budget. Grandfathered per the project norm
  // for large core files (cf. durability.ts below); a database.ts slice is a
  // separate follow-up.
  'src/core/database.ts',
  // #1749 recovery-owner reclaim added the bucket-4 sweep query + reclaim
  // wiring to this cohesive core durability engine, taking it just over the
  // 2000-line arch.file-size warn budget (~2076). Grandfathered per the project
  // norm for large core files; a durability.ts slice is a separate follow-up.
  'src/core/durability.ts',
  // #2051's turn-recovery health evidence + degraded-cause classification
  // additions took this file to ~2007 lines, just over the 2000-line
  // arch.file-size warn budget. The new logic is cohesive with the poller's
  // existing evidence-gathering responsibility; grandfathered per the project
  // norm for large core files (cf. database.ts/durability.ts above).
  'src/fleet/health-poller.ts',
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
  // The two-level /model drill-down (Slice 2) added the drill handler cases
  // (bare->L1, brand->L2, leaf pin, recency both orderings, L1/L2 degrade, L2
  // discovery, cap) beside the Slice-1 selector suite, taking this file just
  // over the 2000-line arch.file-size warn budget (~2175). Every case reuses
  // the file's single shared /model host harness (one top-level describe +
  // makeMessenger/makeMsg preamble), so extracting the drill block would
  // duplicate that setup; grandfathered per the project norm for large
  // cohesive test files (cf. the agent runtime/session twins above).
  'tests/runtimes/agent/model-pin.test.ts',
  'tests/runtimes/agent/outbound-queue.test.ts',
  // Hang-hardening regressions reuse this suite's shared agent-runtime harness;
  // extracting them would duplicate the setup, so the cohesive suite is grandfathered.
  'tests/runtimes/agent/runtime-edge-coverage.test.ts',
  // Exact inconclusive-checkpoint finalization reuses the coordinator suite's
  // shared database/runtime/durability harness, taking it from 1992 to 2033
  // lines. Extracting one case would duplicate that integration setup.
  'tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts',
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
  'tests/scripts/bot-errors-dispatcher.test.ts',
  'tests/scripts/bot-errors-health-check.test.ts',
  'tests/transport/reconnect.test.ts',
].sort();

interface OverBudgetEntry {
  file: string;
  actual: number;
  ceiling: number;
}

// Soft-collects EVERY measurement that grew past its recorded ceiling instead
// of throwing on the first one (#1830). Aborting on the first over-ceiling file
// masked additional violations: a PR that tripped 2+ files only ever saw the
// first in CI. Every file is still checked <= its ceiling; the difference is
// that all violations are gathered and reported together.
function collectOverBudget(
  measurements: FileSizeMeasurement[],
  measure: (measurement: FileSizeMeasurement) => number,
): OverBudgetEntry[] {
  const overBudget: OverBudgetEntry[] = [];
  for (const measurement of measurements) {
    const actual = measure(measurement);
    if (actual > measurement.maxLines) {
      overBudget.push({ file: measurement.filePath, actual, ceiling: measurement.maxLines });
    }
  }
  return overBudget;
}

// Enumerates the full set of over-ceiling files (each with the extraction
// remediation) so the single failing assertion documents every violation, not
// just the first.
function formatOverBudgetFailure(overBudget: OverBudgetEntry[]): string {
  return [
    `arch.file-size ceiling exceeded by ${overBudget.length} file(s):`,
    ...overBudget.map(({ file, actual, ceiling }) =>
      ceilingBumpMessage({ filePath: file, lines: actual, maxLines: ceiling }, actual),
    ),
  ].join('\n\n');
}

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

  it('the over-ceiling failure message documents the extraction remediation, not a bump', () => {
    // This pins requirement wording so the remediation text stays intact even
    // if the growth-ceiling assertion below never fails in CI. The message must
    // agree with guard:baseline-growth: ceilings cannot be raised, so it must
    // point at extraction and must NOT resurrect the retired two-twin bump
    // ceremony (the doc-contradicts-guard defect filed in PR #2563).
    const message = ceilingBumpMessage(
      { filePath: 'src/runtimes/agent/runtime.ts', lines: 1, maxLines: 1 },
      2,
    );

    expect(message).toContain('.claude/fitness/baseline.json');
    expect(message).toContain('docs/architecture/fitness-taxonomy.md');
    expect(message).toContain('guard:baseline-growth');
    expect(message).toContain(REQUIRED_BUMP_HINT);
    expect(message).not.toContain('edit BOTH twins');
  });

  it('grandfathered arch.file-size files must not grow past their recorded ceiling', () => {
    const baseline = readBaseline();
    const measurements = baseline.rules['arch.file-size']?.measurements ?? [];
    expect(measurements.length).toBeGreaterThan(0);

    for (const measurement of measurements) {
      expect(
        typeof measurement.maxLines,
        `${measurement.filePath} has no recorded maxLines ceiling in .claude/fitness/baseline.json`,
      ).toBe('number');
    }

    const measure = (measurement: FileSizeMeasurement): number =>
      countLines(resolve(repoRoot, measurement.filePath));

    // Report EVERY over-ceiling file in one assertion rather than aborting on
    // the first (#1830). Each file is still checked <= its ceiling; the only
    // change is that all violations surface together.
    const overBudget = collectOverBudget(measurements, measure);
    expect(overBudget, formatOverBudgetFailure(overBudget)).toEqual([]);

    const shrinkWarnings: string[] = [];
    for (const measurement of measurements) {
      const actualLines = measure(measurement);
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

  it('collects and reports every over-ceiling file, not just the first (#1830)', () => {
    // Regression guard for #1830: the ratchet used to throw on the first
    // over-ceiling file, so a PR that tripped 2+ files only saw one in CI. The
    // synthetic measurements below trip TWO files (with one within-budget file
    // between them); both must be collected and both must appear in the failure
    // message.
    const measurements: FileSizeMeasurement[] = [
      { filePath: 'first-over.ts', lines: 100, maxLines: 100 },
      { filePath: 'within-budget.ts', lines: 50, maxLines: 80 },
      { filePath: 'second-over.ts', lines: 200, maxLines: 200 },
    ];
    const measured: Record<string, number> = {
      'first-over.ts': 137,
      'within-budget.ts': 50,
      'second-over.ts': 271,
    };

    const overBudget = collectOverBudget(measurements, (m) => measured[m.filePath]);

    expect(overBudget).toEqual([
      { file: 'first-over.ts', actual: 137, ceiling: 100 },
      { file: 'second-over.ts', actual: 271, ceiling: 200 },
    ]);

    const message = formatOverBudgetFailure(overBudget);
    expect(message).toContain('first-over.ts');
    expect(message).toContain('second-over.ts');
    expect(message).toContain('arch.file-size ceiling exceeded by 2 file(s):');
  });
});
