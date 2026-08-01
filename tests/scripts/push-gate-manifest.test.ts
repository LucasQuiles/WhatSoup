import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRANCH_STEPS,
  CI_ONLY_GUARDS,
  CURATED_TEST_PATHS,
  NEUTRALIZED_SKIP_VARS,
  RELEASE_STEPS,
} from '../../scripts/push-gate.ts';

/**
 * Registry test for the declarative push-gate manifest (#2224).
 *
 * Behavior asserted (not implementation detail):
 *  1. No silent gate-drops: every `guard:*` script in package.json is either
 *     a step in a pipeline or explicitly listed as CI-only with a reason.
 *  2. No phantom references: every guard step in the manifest names a real
 *     package.json script.
 *  3. Line-length ratchet: the verify:* entry points never grow back into
 *     unreadable shell strings (≤120 chars each).
 *  4. Anti-drift: every curated test path exists on disk, and the manifest's
 *     own registry test is dogfooded into the curated list.
 *  5. Legacy-parity invariants: the neutralized skip-var list matches the
 *     legacy unset preamble; both lanes keep their distinctive terminal
 *     steps (scope print / console-browser).
 *
 * Accepted-risk note (coverage-honesty, LabRatQ challenge): a guard that is
 * renamed consistently in BOTH package.json and the manifest passes this
 * registry — rename coherence is reviewed by humans, not asserted here.
 * Hermeticity: all assertions are source/disk reads — no wall-clock, no
 * network, no machine state.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

const allGuardScripts = Object.keys(pkg.scripts).filter((name) =>
  name.startsWith('guard:'),
);

const pipelineGuards = new Set(
  [...BRANCH_STEPS, ...RELEASE_STEPS]
    .map((step) => step.name)
    .filter((name) => name.startsWith('guard:')),
);

const ciOnlyNames = new Set(CI_ONLY_GUARDS.map((entry) => entry.name));

describe('push-gate manifest registry (#2224)', () => {
  it('every package.json guard:* script is in a pipeline or explicitly CI-only', () => {
    const unregistered = allGuardScripts.filter(
      (name) => !pipelineGuards.has(name) && !ciOnlyNames.has(name),
    );
    expect(
      unregistered,
      `guard script(s) missing from both pipelines and CI_ONLY_GUARDS: ${unregistered.join(', ')}`,
    ).toEqual([]);
  });

  it('every CI-only entry names a real guard script and carries a reason', () => {
    for (const entry of CI_ONLY_GUARDS) {
      expect(
        allGuardScripts,
        `${entry.name} listed CI-only but does not exist in package.json`,
      ).toContain(entry.name);
      expect(entry.reason.trim().length, `${entry.name} needs a reason`).toBeGreaterThan(0);
      expect(
        pipelineGuards.has(entry.name),
        `${entry.name} is both a pipeline step and CI-only — contradiction`,
      ).toBe(false);
    }
  });

  it('every manifest guard step names a real package.json script', () => {
    for (const name of pipelineGuards) {
      expect(
        allGuardScripts,
        `manifest references ${name} but package.json has no such script`,
      ).toContain(name);
    }
  });

  it('push/release pipeline entry points stay ≤120 chars (never grows back)', () => {
    // Scoped to the push-gate pipelines this issue owns. verify:console-design:live
    // (679 chars) is a separate console lane — a documented follow-up candidate,
    // not this issue's scope.
    const pipelineEntries = Object.keys(pkg.scripts).filter(
      (key) => key.startsWith('verify:push') || key.startsWith('verify:release'),
    );
    expect(pipelineEntries.length).toBeGreaterThan(0);
    for (const name of pipelineEntries) {
      expect(
        pkg.scripts[name].length,
        `${name} is ${pkg.scripts[name].length} chars — orchestration belongs in scripts/push-gate.ts, not in a shell string`,
      ).toBeLessThanOrEqual(120);
    }
  });

  it('entry points invoke the manifest runner for both lanes', () => {
    expect(pkg.scripts['verify:push:branch']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/push-gate.ts branch',
    );
    expect(pkg.scripts['verify:release']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/push-gate.ts release',
    );
  });

  it('every curated test path exists on disk', () => {
    const missing = CURATED_TEST_PATHS.filter((path) => !existsSync(path));
    expect(missing, `curated test path(s) drifted from disk: ${missing.join(', ')}`).toEqual([]);
  });

  it('the curated list dogfoods this registry test', () => {
    expect([...CURATED_TEST_PATHS]).toContain('tests/scripts/push-gate-manifest.test.ts');
  });

  it('curated list has no duplicates and no flags masquerading as paths', () => {
    expect(new Set(CURATED_TEST_PATHS).size).toBe(CURATED_TEST_PATHS.length);
    for (const path of CURATED_TEST_PATHS) {
      expect(path.startsWith('--'), `${path} looks like a flag, not a path`).toBe(false);
      expect(path.endsWith('.test.ts'), `${path} is not a test file`).toBe(true);
    }
  });

  it('neutralized skip-vars match the legacy unset preamble', () => {
    expect([...NEUTRALIZED_SKIP_VARS]).toEqual([
      'WHATSOUP_SKIP_DOC_DRIFT',
      'WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT',
      'WHATSOUP_SKIP_NODE_PIN_CHECK',
      'WHATSOUP_SKIP_BOUNDARY_CHECK',
    ]);
  });

  it('both lanes keep their distinctive terminal steps and mid-block semantic:shadow position', () => {
    expect(BRANCH_STEPS[BRANCH_STEPS.length - 1].cmd).toBe('bash scripts/print-push-gate-scope.sh');
    expect(RELEASE_STEPS[RELEASE_STEPS.length - 1].name).toBe('verify:console-browser');
    // Legacy parity: semantic:shadow runs mid-guard-block, not at the end.
    const branchShadowIndex = BRANCH_STEPS.findIndex((step) => step.name === 'verify:semantic:shadow');
    expect(branchShadowIndex).toBeGreaterThan(0);
    expect(BRANCH_STEPS[branchShadowIndex - 1].name).toBe('guard:safeguard-diagnostics');
    expect(BRANCH_STEPS[branchShadowIndex + 1].name).toBe('guard:test-integrity');
    const releaseShadowIndex = RELEASE_STEPS.findIndex((step) => step.name === 'verify:semantic:shadow');
    expect(RELEASE_STEPS[releaseShadowIndex - 1].name).toBe('guard:safeguard-diagnostics');
    expect(RELEASE_STEPS[releaseShadowIndex + 1].name).toBe('guard:test-integrity:required');
  });

  it('step names are unique within each lane (attribution is unambiguous)', () => {
    for (const steps of [BRANCH_STEPS, RELEASE_STEPS]) {
      const names = steps.map((step) => step.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
