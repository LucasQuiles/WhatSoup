import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  classifyPrePushInput,
  classifyPrePushLine,
  commandsForDecision,
  ZERO_SHA,
} from '../../scripts/pre-push-guard.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const vitestConfig = readFileSync(resolve(repoRoot, 'vitest.config.ts'), 'utf8');
const qualityWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/quality.yml'), 'utf8');
const whatsoupGuardWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/whatsoup-guard.yml'), 'utf8');
const tagReleaseWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/tag-release-gate.yml'), 'utf8');
const guardPackageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'tools/whatsoup_guard/package.json'), 'utf8'),
) as { scripts: Record<string, string>; devDependencies?: Record<string, string> };

describe('pre-push guard classifier', () => {
  it('classifies delete-only ref updates as metadata-only', () => {
    expect(classifyPrePushLine(
      `refs/heads/topic ${ZERO_SHA} refs/heads/topic 40d37275dcb1c43decfb12e522f2d4f1b5e95a0c`,
    )).toBe('delete');
  });

  it('classifies main branch updates as release verification', () => {
    expect(classifyPrePushLine(
      `refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5`,
    )).toBe('release');
  });

  it('classifies release tag updates as release verification', () => {
    expect(classifyPrePushLine(
      `refs/tags/v1.2.3 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/tags/v1.2.3 ${ZERO_SHA}`,
    )).toBe('release');
  });

  it('classifies feature branch updates as branch verification', () => {
    expect(classifyPrePushLine(
      `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
    )).toBe('branch');
  });

  it('skips verification when every ref update is delete-only', () => {
    const decision = classifyPrePushInput([
      `refs/heads/old-a ${ZERO_SHA} refs/heads/old-a 1111111111111111111111111111111111111111`,
      `refs/heads/old-b ${ZERO_SHA} refs/heads/old-b 2222222222222222222222222222222222222222`,
    ].join('\n'));

    expect(decision).toBe('skip');
    expect(commandsForDecision(decision)).toEqual([]);
  });

  it('uses branch verification for feature branch pushes', () => {
    const decision = classifyPrePushInput(
      `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
    );

    expect(decision).toBe('branch');
    expect(commandsForDecision(decision)).toEqual(['verify:push:branch']);
  });

  it('uses release verification when any pushed ref needs release treatment', () => {
    const decision = classifyPrePushInput([
      `refs/heads/feature/example 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/feature/example ${ZERO_SHA}`,
      `refs/heads/main 8d739e7582b068387411a1d89acca11e3fd31aa4 refs/heads/main ec3ac431eb1811aeb7fa9851d658b27ae724cbb5`,
    ].join('\n'));

    expect(decision).toBe('release');
    expect(commandsForDecision(decision)).toEqual(['verify:release']);
  });

  it('rejects malformed pre-push ref lines', () => {
    expect(() => classifyPrePushLine('refs/heads/main only-two-fields')).toThrow(/Invalid pre-push/);
  });
});

describe('verify chain composition (package.json)', () => {
  it('exposes one production semantic command with explicit enforce and shadow adapters', () => {
    expect(packageJson.scripts['guard:semantic-quality']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/semantic-quality-check.ts',
    );
    expect(packageJson.scripts['verify:semantic']).toBe(
      'npm run guard:semantic-quality -- --mode enforce',
    );
    expect(packageJson.scripts['verify:semantic:shadow']).toBe(
      'npm run guard:semantic-quality -- --mode shadow',
    );
  });

  it('runs semantic shadow feedback before the expensive local push and release suites', () => {
    const push = packageJson.scripts['verify:push:branch'];
    const release = packageJson.scripts['verify:release'];
    expect(push).toContain('npm run verify:semantic:shadow');
    expect(release).toContain('npm run verify:semantic:shadow');
    expect(push.indexOf('npm run verify:semantic:shadow')).toBeLessThan(push.indexOf('npm test'));
    expect(release.indexOf('npm run verify:semantic:shadow')).toBeLessThan(
      release.indexOf('npm run coverage:check'),
    );
  });

  it('runs TypeScript package entrypoints through the pinned Node wrapper', () => {
    const directAmbientScripts = Object.entries(packageJson.scripts)
      .filter(([, command]) => /\bnode\s+--experimental-strip-types\b/.test(command))
      .map(([scriptName]) => scriptName);

    expect(directAmbientScripts).toEqual([]);
  });

  it('verify:push:branch invokes guard:work-index', () => {
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:work-index\b/);
  });

  it('verify:push:branch invokes staged publication guard', () => {
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:publication:staged\b/);
  });

  it('verify:release invokes guard:work-index', () => {
    // Regression guard for #495: verify:release was missing the work-index
    // step that verify:push:branch and CI quality.yml both run, allowing
    // work-index drift to land on main without local detection.
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:work-index\b/);
  });

  it('verify:release invokes the test-integrity baseline gate', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:test-integrity\b/);
  });

  it('verify chains invoke the agent decision polls protocol guard', () => {
    for (const scriptName of ['verify:push:branch', 'verify:release', 'verify:publish']) {
      const chain = packageJson.scripts[scriptName];
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:agent-decision-polls\b/);
    }
  });

  it('verify:push:branch invokes the test-integrity baseline gate', () => {
    // Regression guard: PR #677 surfaced that verify:push:branch did NOT run
    // guard:test-integrity, so a weak-assertion violation slipped past the
    // local pre-push hook and was caught only by CI. The CI quality job runs
    // this gate; the local push gate must too so the dev cycle is fail-fast.
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:test-integrity\b/);
  });

  it('verify:push:branch invokes the fast CI-only checks that drove local-green/CI-red (#1105)', () => {
    // Regression guard for #1105: verify:push:branch omitted console lint/build,
    // guard:design-system-hygiene, guard:harness-maintenance, and test:tokenomics —
    // all blocking steps in the CI quality job — so violations in those surfaces
    // (e.g. console noUnusedLocals/verbatimModuleSyntax, design-system drift,
    // harness node-pin drift, tokenomics regressions) passed the local push gate
    // and failed only in CI. These are fast+deterministic; the slow coverage/
    // drills/browser tail intentionally stays in verify:release (asserted below).
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:design-system-hygiene\b/);
    expect(chain).toMatch(/\bnpm run guard:harness-maintenance\b/);
    expect(chain).toMatch(/\bnpm run test:tokenomics\b/);
    expect(chain).toMatch(/--prefix console run lint\b/);
    expect(chain).toMatch(/--prefix console run build\b/);
  });

  it('quality.yml console lint + build steps are mirrored by the local push gate (#1105)', () => {
    // The CI quality workflow runs console lint + build as blocking steps; the
    // local gate must mirror them so console strict-tsconfig violations fail fast.
    expect(qualityWorkflow).toMatch(/--prefix console run lint/);
    expect(qualityWorkflow).toMatch(/--prefix console run build/);
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain).toMatch(/--prefix console run lint\b/);
    expect(chain).toMatch(/--prefix console run build\b/);
  });

  it('verify:release retains the slow coverage/browser tail intentionally omitted from the push gate (#1105)', () => {
    // Documents the intentional split: the full-suite coverage gate and the
    // browser suites stay in verify:release (and CI), not the fast push gate.
    const release = packageJson.scripts['verify:release'];
    expect(release, 'verify:release script must exist').toBeDefined();
    expect(release).toMatch(/\bnpm run coverage:check\b/);
    expect(release).toMatch(/\bnpm run verify:console-browser\b/);
  });

  it('verify:release runs the root full suite once through serialized coverage', () => {
    const release = packageJson.scripts['verify:release'];
    expect(release, 'verify:release script must exist').toBeDefined();

    const rootFullSuitePatterns = [
      /^npm (?:test|run test)(?:\s|$)/,
      /^npm run coverage(?::check)?(?:\s|$)/,
      /^bash scripts\/run-coverage-check\.sh(?:\s|$)/,
    ];
    const rootFullSuiteCommands = release
      .split(/\s*&&\s*/)
      .filter((command) => rootFullSuitePatterns.some((pattern) => pattern.test(command)));

    expect(rootFullSuiteCommands).toEqual([
      'npm run coverage:check -- --pool=forks --fileParallelism=false',
    ]);
  });

  it('shared console design verification invokes design guard fixture tests', () => {
    const chain = packageJson.scripts['verify:console-design'];
    expect(chain, 'verify:console-design script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run test:design-guards\b/);
  });

  it('design guard fixture lane covers the scanner contracts used by console design verification', () => {
    const chain = packageJson.scripts['test:design-guards'];
    expect(chain, 'test:design-guards script must exist').toBeDefined();
    expect(chain).toContain('npm test -- ');
    expect(chain).toContain('--pool=forks');
    for (const testFile of [
      'tests/scripts/theme-parity.test.ts',
      'tests/scripts/token-spec-drift.test.ts',
      'tests/scripts/contrast-matrix.test.ts',
      'tests/scripts/shadow-baseline.test.ts',
      'tests/scripts/shadow-frozen-inventory.test.ts',
      'tests/scripts/raw-form-control-inventory.test.ts',
      'tests/scripts/design-regression-guards.test.ts',
      'tests/scripts/design-metrics.test.ts',
      'tests/scripts/design-burndown-check.test.ts',
      'tests/scripts/color-semantics.test.ts',
      'tests/scripts/design-resilience-audit.test.ts',
      'tests/scripts/font-assets.test.ts',
      'tests/scripts/brand-assets.test.ts',
      'tests/scripts/design-lint-fixtures.test.ts',
    ]) {
      expect(chain).toContain(testFile);
    }
  });

  it('verify chains invoke the commit-author guard', () => {
    for (const scriptName of ['verify:push:branch', 'verify:release']) {
      const chain = packageJson.scripts[scriptName];
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:repo:commit-authors\b/);
    }
  });

  it('verify:push:branch invokes branch-diff repo hygiene after staged smoke', () => {
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:repo:staged\b/);
    expect(chain).toMatch(/\bnpm run guard:repo:branch-diff\b/);
    expect(chain.indexOf('npm run guard:repo:staged')).toBeLessThan(
      chain.indexOf('npm run guard:repo:branch-diff'),
    );
    expect(chain.indexOf('npm run guard:repo:branch-diff')).toBeLessThan(
      chain.indexOf('npm run guard:repo:commit-authors'),
    );
  });

  it('verify chains invoke BOT ERRORS runtime-source, runtime-manifest, and simulation-matrix guards', () => {
    for (const scriptName of ['verify:push:branch', 'verify:release']) {
      const chain = packageJson.scripts[scriptName];
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:source-runtime-drift\b/);
      expect(chain).toMatch(/\bnpm run guard:bot-errors-runtime-manifest\b/);
      expect(chain).toMatch(/\bnpm run guard:bot-errors-simulation-matrix\b/);
      expect(chain.indexOf('npm run guard:source-runtime-drift')).toBeLessThan(
        chain.indexOf('npm run guard:bot-errors-runtime-manifest'),
      );
      expect(chain.indexOf('npm run guard:bot-errors-runtime-manifest')).toBeLessThan(
        chain.indexOf('npm run guard:bot-errors-simulation-matrix'),
      );
      expect(chain).not.toMatch(/\bnpm run guard:bot-errors-critical-surfaces\b/);
    }
  });

  it('verify:push:branch invokes full test typecheck, not source-only typecheck', () => {
    const chain = packageJson.scripts['verify:push:branch'];
    expect(chain, 'verify:push:branch script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run typecheck:all\b/);
    expect(chain).not.toMatch(/\bnpm run typecheck(?:\s|&&|$)/);
  });

  it('verify:release invokes the standalone whatsoup guard package checks', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix tools\/whatsoup_guard ci\b/);
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix tools\/whatsoup_guard run typecheck\b/);
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix tools\/whatsoup_guard test\b/);
    expect(chain).not.toMatch(/\bnpm --prefix tools\/whatsoup_guard\b/);
    expect(chain).not.toMatch(/\btools\/whatsoup_guard run coverage:proof\b/);
  });

  it('root coverage excludes the standalone whatsoup guard package', () => {
    expect(vitestConfig).toContain('coverageConfigDefaults.exclude');
    expect(vitestConfig).toContain("'tools/whatsoup_guard/**'");
  });

  it('verify:release invokes full publication audit guard', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:publication:all\b/);
    expect(chain).not.toMatch(/\bnpm run guard:publication:release\b/);
  });

  it('verify:release invokes release repo hygiene guard', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:repo:release-hygiene\b/);
  });

  it('verify:publish invokes strict publication release guard before release verification', () => {
    const chain = packageJson.scripts['verify:publish'];
    expect(chain, 'verify:publish script must exist').toBeDefined();
    expect(chain).toMatch(/\bnpm run guard:publication:release\b/);
    expect(chain).toMatch(/\bnpm run verify:release\b/);
    expect(chain.indexOf('npm run guard:publication:release')).toBeLessThan(
      chain.indexOf('npm run verify:release'),
    );
  });

  it('verify:release invokes console lint', () => {
    const chain = packageJson.scripts['verify:release'];
    expect(chain, 'verify:release script must exist').toBeDefined();
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix console ci\b/);
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix console run lint\b/);
    expect(chain).toMatch(/\bbash scripts\/run-with-pinned-npm\.sh --prefix console run build\b/);
    expect(chain).not.toMatch(/\bnpm --prefix console\b/);
  });

  it('exposes coverage headroom as an explicit guard script', () => {
    expect(packageJson.scripts['guard:coverage-headroom']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/check-coverage-headroom.ts',
    );
  });

  it('coverage thresholds are scoped to production source files', () => {
    expect(vitestConfig).toContain("include: ['src/**/*.ts', 'src/**/*.tsx']");
  });
});

describe('quality workflow composition', () => {
  it('runs one read-only Node 24 semantic shadow step before integrity and expensive suites', () => {
    const semanticMatches = qualityWorkflow.match(/name: Semantic quality \(shadow\)/g) ?? [];
    const semanticIndex = qualityWorkflow.indexOf('name: Semantic quality (shadow)');
    const integrityInstallIndex = qualityWorkflow.indexOf('name: Install test-integrity plugin');
    const suiteIndex = qualityWorkflow.indexOf('name: Test suite + coverage thresholds');

    expect(semanticMatches).toHaveLength(1);
    expect(semanticIndex).toBeGreaterThanOrEqual(0);
    expect(semanticIndex).toBeLessThan(integrityInstallIndex);
    expect(semanticIndex).toBeLessThan(suiteIndex);
    expect(qualityWorkflow).toContain("if: matrix.node == '24.x'");
    expect(qualityWorkflow).toContain('SEMANTIC_RECEIPT: ${{ runner.temp }}/semantic-quality.json');
    expect(qualityWorkflow).toContain('base="origin/$GITHUB_BASE_REF"');
    expect(qualityWorkflow).toContain('base="HEAD^"');
    expect(qualityWorkflow).toContain('--mode shadow --base "$base" --receipt "$SEMANTIC_RECEIPT"');
    expect(qualityWorkflow).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(qualityWorkflow).toMatch(/permissions:\n  contents: read/);
    expect(qualityWorkflow).not.toContain('pull_request_target');
    expect(qualityWorkflow).not.toContain('path: semantic-quality.json');
  });

  it('installs the private test-integrity plugin before requiring the baseline gate', () => {
    const installIndex = qualityWorkflow.indexOf('name: Install test-integrity plugin');
    const gateIndex = qualityWorkflow.indexOf('name: Test integrity baseline check');

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(installIndex);
    expect(qualityWorkflow).toContain('TEST_INTEGRITY_DEPLOY_KEY');
    expect(qualityWorkflow).toContain('LucasQuiles/test-integrity.git');
    expect(qualityWorkflow).toContain("WHATSOUP_REQUIRE_TEST_INTEGRITY: '1'");
  });

  it('sets up Python 3.12 with pytest-cov before Python-backed gates run', () => {
    const setupPythonIndex = qualityWorkflow.indexOf('name: Setup Python 3.12');
    const pythonDepsIndex = qualityWorkflow.indexOf('name: Install Python test dependencies');
    const testIntegrityIndex = qualityWorkflow.indexOf('name: Test integrity baseline check');

    expect(setupPythonIndex).toBeGreaterThanOrEqual(0);
    expect(pythonDepsIndex).toBeGreaterThan(setupPythonIndex);
    expect(testIntegrityIndex).toBeGreaterThan(pythonDepsIndex);
    expect(qualityWorkflow).toContain('uses: actions/setup-python@v5');
    expect(qualityWorkflow).toContain("python-version: '3.12'");
    expect(qualityWorkflow).toContain('python3 -m pip install --user pytest pytest-cov');
  });

  it('runs the commit-author guard in CI quality workflow', () => {
    expect(qualityWorkflow).toContain('npm run guard:repo:commit-authors');
  });

  it('runs branch-diff repo hygiene in CI before commit-author scanning', () => {
    const branchDiffIndex = qualityWorkflow.indexOf('npm run guard:repo:branch-diff');
    const commitAuthorIndex = qualityWorkflow.indexOf('npm run guard:repo:commit-authors');

    expect(branchDiffIndex).toBeGreaterThanOrEqual(0);
    expect(commitAuthorIndex).toBeGreaterThan(branchDiffIndex);
    expect(qualityWorkflow).toContain('--base "origin/$GITHUB_BASE_REF"');
  });

  it('runs BOT ERRORS runtime manifest verification before the simulation matrix in CI', () => {
    const runtimeManifestIndex = qualityWorkflow.indexOf('npm run guard:bot-errors-runtime-manifest');
    const simulationIndex = qualityWorkflow.indexOf('npm run guard:bot-errors-simulation-matrix');

    expect(runtimeManifestIndex).toBeGreaterThanOrEqual(0);
    expect(simulationIndex).toBeGreaterThan(runtimeManifestIndex);
  });

  it('runs the sentinel coverage and deployer mutation gate in CI after the simulation matrix', () => {
    const simulationIndex = qualityWorkflow.indexOf('npm run guard:bot-errors-simulation-matrix');
    const sentinelGateIndex = qualityWorkflow.indexOf('bash deploy/scripts/run-sentinel-tests.sh');
    const testSuiteIndex = qualityWorkflow.indexOf('name: Test suite');

    expect(simulationIndex).toBeGreaterThanOrEqual(0);
    expect(sentinelGateIndex).toBeGreaterThan(simulationIndex);
    expect(testSuiteIndex).toBeGreaterThan(sentinelGateIndex);
    expect(qualityWorkflow).toContain('name: BOT ERRORS sentinel coverage and deployer mutation gate');
  });

  it('runs the standalone guard package test workflow', () => {
    expect(whatsoupGuardWorkflow).toContain('run: npm test');
    expect(whatsoupGuardWorkflow).not.toContain('npm run coverage:proof');
  });

  it('documents tag commit-author gate range semantics without changing enforcement', () => {
    const commentIndex = tagReleaseWorkflow.indexOf('keeps guard:repo:commit-authors wired on tag pushes');
    const stepIndex = tagReleaseWorkflow.indexOf('name: Repo commit-authors');

    expect(commentIndex).toBeGreaterThanOrEqual(0);
    expect(stepIndex).toBeGreaterThan(commentIndex);
    expect(tagReleaseWorkflow).toContain('PR and local push gates remain the authoritative non-vacuous author scans.');
    expect(tagReleaseWorkflow).toContain('run: npm run guard:repo:commit-authors');
  });
});
