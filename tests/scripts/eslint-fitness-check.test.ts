import { describe, expect, it } from 'vitest';

import { fitnessRules } from '../../scripts/lib/fitness/registry.ts';
// @ts-expect-error -- flat config is a .mjs module with no type declarations; expires 2026-12-31
import { eslintRingRuleIds as eslintRingRuleIdsRaw, enabledFitnessRuleNames as enabledFitnessRuleNamesRaw, eslintRingRuleNames as eslintRingRuleNamesRaw } from '../../eslint.config.fitness.mjs';

const eslintRingRuleIds = eslintRingRuleIdsRaw as string[];
const enabledFitnessRuleNames = enabledFitnessRuleNamesRaw as string[];
const eslintRingRuleNames = eslintRingRuleNamesRaw as string[];

describe('eslint fitness config — registry drift', () => {
  it('enforces exactly the registry rules whose rings include eslint', () => {
    const expected = fitnessRules
      .filter((rule) => (rule.rings as readonly string[]).includes('eslint'))
      .map((rule) => rule.id)
      .sort();

    // If a rule gains/loses the eslint ring in the registry, this fails until the
    // config is updated — the registry stays the single source of truth.
    expect(eslintRingRuleIds).toEqual(expected);
  });

  it('actually ENABLES every eslint-ring rule in a files block (not just lists its id)', () => {
    // Regression guard: an eslint-ring rule mapped in ruleEntriesFor but never spread
    // into a `files` block silently never runs (the timer-rearm-without-clear gap). The
    // id-list assertion above passed over that dead rule; this checks real enablement.
    const enabled = new Set(enabledFitnessRuleNames);
    const missing = eslintRingRuleNames.filter((name) => !enabled.has(name));
    expect(missing).toEqual([]);
  });

  it('covers the nine known eslint-ring rules', () => {
    expect(eslintRingRuleIds).toEqual([
      'arch.approved-api-client',
      'arch.file-size',
      'arch.god-class',
      'arch.ring-boundaries',
      'invariant.fail-closed-scanner',
      'invariant.no-unsafe-type-escapes',
      'invariant.outbox-env-gated',
      'invariant.timer-rearm-without-clear',
      'test.skip-categorization',
    ]);
  });
});

describe('eslint fitness wrapper — exit semantics', () => {
  it('treats warning-only results as non-blocking and reports errors as blocking', async () => {
    const { runEslintFitness } = await import('../../scripts/eslint-fitness-check.ts');
    const result = await runEslintFitness();

    // The repo currently has known fitness warnings (AgentRuntime god-class,
    // oversized files, uncategorized skips, fail-open catches) and NO configured
    // errors. The wrapper must see warnings but zero errors / no fatal parse.
    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.errorCount).toBe(0);
    expect(result.fatal).toBe(false);

    // The flagship dark-ring rule must be live: AgentRuntime is reported.
    const godClass = result.issues.find(
      (i) => i.code === 'fitness/god-class' && i.filePath?.endsWith('runtime.ts'),
    );
    expect(godClass).toBeDefined();
    // This spawns a real ESLint pass over the entire source tree. Under the
    // coverage-instrumented CI step (slower than the plain suite) with the
    // parallel vitest pool contending for CPU, the 60s budget was marginal and
    // flaked intermittently (observed on main too). 180s gives durable headroom
    // without masking a genuine hang.
  }, 180_000);
});
