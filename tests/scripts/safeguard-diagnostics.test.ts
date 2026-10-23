import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkSafeguards, formatReport, parseArgs, run } from '../../scripts/safeguard-diagnostics.ts';
import {
  makeNonGitTree,
  makeRepo,
  repoRoot,
  requiredFiles,
  qualityCiJobTimeoutBlock,
  qualityCiSystemDepsTimeoutBlock,
  requiredPackageScripts,
  requiredTagReleaseWorkflow,
} from './safeguard-diagnostics.fixture.ts';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('safeguard diagnostics', () => {
  it('passes the current repository without requiring a clean working tree', () => {
    const result = checkSafeguards(repoRoot);

    expect(result.ok).toBe(true);
    expect(result.summary.fail).toBe(0);
    expect(result.checks.map((check) => check.id)).toContain('no-tracked-instance-health-profiles');
  });

  it('fails when a required guard script is missing', () => {
    const fixture = makeRepo({ scripts: { 'guard:test-integrity': undefined } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'required-package-scripts')).toMatchObject({
      status: 'fail',
      evidence: expect.arrayContaining(['guard:test-integrity']),
    });
  });

  it('fails when the browser motion proof script is missing', () => {
    const fixture = makeRepo({ scripts: { 'test:browser:motion': undefined } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'required-package-scripts')).toMatchObject({
      status: 'fail',
      evidence: expect.arrayContaining(['test:browser:motion']),
    });
  });

  it('fails when the shared browser verification script is missing', () => {
    const fixture = makeRepo({ scripts: { 'verify:console-browser': undefined } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'required-package-scripts')).toMatchObject({
      status: 'fail',
      evidence: expect.arrayContaining(['verify:console-browser']),
    });
  });

  it('fails when a verify chain omits the diagnostic guard', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:push:branch': requiredPackageScripts['verify:push:branch']
          .replace(' && npm run guard:safeguard-diagnostics', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'branch-push-chain')?.evidence)
      .toContain('missing npm run guard:safeguard-diagnostics');
  });

  it('fails when the required test-integrity guard script is missing', () => {
    const fixture = makeRepo({ scripts: { 'guard:test-integrity:required': undefined } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'required-package-scripts')).toMatchObject({
      status: 'fail',
      evidence: expect.arrayContaining(['guard:test-integrity:required']),
    });
  });

  it('fails when release verification uses the optional test-integrity guard', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release']
          .replace('npm run guard:test-integrity:required', 'npm run guard:test-integrity'),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('missing npm run guard:test-integrity:required');
  });

  it('fails when release verification omits the required test-integrity guard', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release']
          .replace(' && npm run guard:test-integrity:required', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('missing npm run guard:test-integrity:required');
  });

  it('fails when release verification runs the required test-integrity guard out of order', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release']
          .replace(
            'npm run verify:semantic:shadow && npm run guard:test-integrity:required',
            'npm run guard:test-integrity:required && npm run verify:semantic:shadow',
          ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('out-of-order npm run guard:test-integrity:required');
  });

  it('fails when release verification mixes pinned npm with bare nested npm commands', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release']
          .replace(
            'bash scripts/run-with-pinned-npm.sh --prefix console ci',
            'npm --prefix console ci && bash scripts/run-with-pinned-npm.sh --prefix console ci',
          ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('forbidden npm --prefix console ci');
  });

  it('fails when the shared console design verification chain omits resilience coverage', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:console-design:live': requiredPackageScripts['verify:console-design:live']
          .replace(' && npm --prefix console run design:resilience', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'console-design-live-chain')?.evidence)
      .toContain('missing npm --prefix console run design:resilience');
  });

  it('fails when the shared console design verification chain omits raw form-control inventory coverage', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:console-design:live': requiredPackageScripts['verify:console-design:live']
          .replace(' && npm --prefix console run design:raw-form-control-inventory', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'console-design-live-chain')?.evidence)
      .toContain('missing npm --prefix console run design:raw-form-control-inventory');
  });

  it('fails when the shared console design verification chain omits scanner fixture tests', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:console-design': requiredPackageScripts['verify:console-design']
          .replace(' && npm run test:design-guards', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'console-design-chain')?.evidence)
      .toContain('missing npm run test:design-guards');
  });

  it('fails when the shared console design verification chain omits frozen shadow inventory coverage', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:console-design:live': requiredPackageScripts['verify:console-design:live']
          .replace(' && npm --prefix console run design:shadow-frozen-inventory', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'console-design-live-chain')?.evidence)
      .toContain('missing npm --prefix console run design:shadow-frozen-inventory');
  });

  it('fails when the shared browser verification chain omits the no-reduce motion proof', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:console-browser': requiredPackageScripts['verify:console-browser']
          .replace(' && npm run test:browser:motion', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'console-browser-chain')?.evidence)
      .toContain('missing npm run test:browser:motion');
  });

  it('fails when release verification omits the browser proof chain', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release']
          .replace(' && npm run verify:console-browser', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('missing npm run verify:console-browser');
  });

  it('accepts parallel coverage as the only root full-suite release command', () => {
    const fixture = makeRepo();
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')).toMatchObject({
      status: 'pass',
    });
  });

  it('rejects release verification without deployment qualification', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release']
          .replace(' && npm run test:deployment-qualification', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')).toMatchObject({
      status: 'fail',
      evidence: expect.arrayContaining(['missing npm run test:deployment-qualification']),
    });
  });

  it('rejects deployment qualification moved after release coverage', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release']
          .replace(' && npm run test:deployment-qualification', '')
          .replace('npm run coverage:check -- --pool=forks',
            'npm run coverage:check -- --pool=forks && npm run test:deployment-qualification'),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')).toMatchObject({
      status: 'fail',
      evidence: expect.arrayContaining(['exact command sequence mismatch']),
    });
  });

  it('rejects a separate root test pass before release coverage', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          'npm run coverage:check',
          'npm test -- --pool=forks --fileParallelism=false && npm run coverage:check',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('forbidden npm test');
  });

  it('rejects duplicate release coverage executions', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          'npm run coverage:check -- --pool=forks',
          'npm run coverage:check -- --pool=forks && npm run coverage:check -- --pool=forks',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('expected exactly one npm run coverage:check; found 2');
  });

  it('rejects release coverage without the forks pool flag', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          'npm run coverage:check -- --pool=forks',
          'npm run coverage:check',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('missing exact npm run coverage:check -- --pool=forks');
  });

  it('rejects release coverage with altered runner flags', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          'coverage:check -- --pool=forks',
          'coverage:check -- --pool=threads',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('missing exact npm run coverage:check -- --pool=forks');
  });

  it('rejects release coverage that re-serializes test files', () => {
    // The release gate runs the suite with CI's parallel workers (vitest.config.ts
    // maxWorkers); a serial run cannot finish inside the full-suite battery bound.
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          'npm run coverage:check -- --pool=forks',
          'npm run coverage:check -- --pool=forks --fileParallelism=false',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('missing exact npm run coverage:check -- --pool=forks');
  });

  it.each([
    ['npm run test', 'npm run test -- --pool=forks --fileParallelism=false', 'forbidden npm run test'],
    ['npm run coverage', 'npm run coverage -- --pool=forks --fileParallelism=false', 'forbidden npm run coverage'],
    ['direct coverage script', 'bash scripts/run-coverage-check.sh --pool=forks --fileParallelism=false', 'forbidden bash scripts/run-coverage-check.sh'],
  ])('rejects an extra full-suite launcher via %s', (_name, extraCommand, expectedEvidence) => {
    const canonical = 'npm run coverage:check -- --pool=forks';
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          canonical,
          `${extraCommand} && ${canonical}`,
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain(expectedEvidence);
  });

  it('rejects any unexpected command in the canonical release sequence', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          'npm run coverage:check -- --pool=forks',
          'node scripts/unexpected-release-step.mjs && npm run coverage:check -- --pool=forks',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('exact command sequence mismatch');
  });

  it('fails when a new non-capture console design script is not wired into shared verification', () => {
    const fixture = makeRepo({
      consoleScripts: {
        'design:new-audit': 'node scripts/check-new-audit.mjs',
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'console-design-script-coverage')?.evidence)
      .toContain('missing npm --prefix console run design:new-audit');
  });

  it('does not require visual capture-only scripts in shared console design verification', () => {
    const fixture = makeRepo();
    const result = checkSafeguards(fixture);
    const coverage = result.checks.find((check) => check.id === 'console-design-script-coverage');

    expect(coverage).toMatchObject({ status: 'pass' });
    expect(coverage?.evidence).not.toContain('npm --prefix console run design:capture');
    expect(coverage?.evidence).not.toContain('npm --prefix console run design:capture:validate');
  });

  it('fails when the pre-commit hook omits design-system documentation hygiene', () => {
    const fixture = makeRepo({
      files: {
        '.husky/pre-commit': requiredFiles['.husky/pre-commit']
          .replace('npm run guard:design-system-hygiene\n', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'pre-commit-design-system-hygiene'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['npm run guard:design-system-hygiene']) });
  });

  it('fails when CI omits the shared console design verification chain', () => {
    const fixture = makeRepo({
      files: {
        '.github/workflows/quality.yml': requiredFiles['.github/workflows/quality.yml']
          .replace('run: npm run verify:console-design:live', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['run: npm run verify:console-design:live']) });
  });

  it('fails when local verification omits semantic shadow feedback', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:push:branch': requiredPackageScripts['verify:push:branch']
          .replace('npm run verify:semantic:shadow && ', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'branch-push-chain'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['missing npm run verify:semantic:shadow']) });
  });

  it('fails when Quality loses the semantic shadow receipt step', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      /      - name: Semantic quality \(shadow\)[\s\S]*?(?=      - name: Install test-integrity plugin)/,
      '',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-semantic-shadow'))
      .toMatchObject({ status: 'fail' });
  });

  it.each([
    {
      name: 'expands workflow permissions',
      mutate: (workflow: string) => workflow.replace('  contents: read', '  contents: write'),
      evidence: 'quality workflow permissions must be exactly contents: read',
    },
    {
      name: 'uses a non-candidate main fallback',
      mutate: (workflow: string) => workflow.replace('base="HEAD^"', 'base="origin/main"'),
      evidence: 'Semantic quality (shadow) run script is missing base="HEAD^"',
    },
    {
      name: 'uploads the semantic receipt',
      mutate: (workflow: string) => workflow.replace(
        '      - name: Upload browser artifacts',
        '      - name: Upload semantic receipt\n        uses: actions/upload-artifact@v4\n        with:\n          path: semantic-quality.json\n      - name: Upload browser artifacts',
      ),
      evidence: 'semantic quality receipts must not be uploaded as artifacts',
    },
  ])('fails when Quality $name', ({ mutate, evidence }) => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = mutate(workflow);
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-semantic-shadow'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining([evidence]) });
  });

  it('fails when a quality-job step is not a mapping (semantic shadow)', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '      - name: Enforce CI disk budget\n        run: bash scripts/ci-disk-reclaim.sh',
      '      - "not a mapping"',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-semantic-shadow'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['every quality-job step must be a mapping']),
      });
  });

  it.each([
    {
      name: 'renames the Node 24 required context',
      mutate: (workflow: string) => workflow.replace('name: quality (24.x)', 'name: quality'),
      evidence: 'jobs.quality name must be exactly quality (24.x)',
    },
    {
      name: 'drops the merge queue trigger',
      mutate: (workflow: string) => workflow.replace('  merge_group:\n', ''),
      evidence: 'quality workflow must declare the merge_group trigger',
    },
    {
      name: 'widens the Node 24 authority setup',
      mutate: (workflow: string) => workflow.replace(
        "          node-version-file: '.nvmrc'",
        "          node-version: '24.x'",
      ),
      evidence: 'quality (24.x) Setup Node 24 must use node-version-file: .nvmrc',
    },
    {
      name: 'drops the strict host dependency profile',
      mutate: (workflow: string) => workflow.replace(
        /      - name: Host dependency profile \(strict\)[\s\S]*?(?=      - name: Validate strict doctor receipt)/,
        '',
      ),
      evidence: 'quality (24.x) must contain exactly one Host dependency profile (strict) step',
    },
    {
      name: 'drops strict doctor receipt validation',
      mutate: (workflow: string) => workflow.replace(
        /      - name: Validate strict doctor receipt[\s\S]*?(?=      - name: Enforce CI disk budget)/,
        '',
      ),
      evidence: 'quality (24.x) must contain exactly one Validate strict doctor receipt step',
    },
    {
      name: 'drops the compatibility-only doctor profile',
      mutate: (workflow: string) => workflow.replace(
        /      - name: Host dependency profile \(compatibility-only\)[\s\S]*?(?=      - name: Install dependencies)/,
        '',
      ),
      evidence: 'quality (25.x) must contain exactly one Host dependency profile (compatibility-only) step',
    },
    {
      name: 'renames the Node 25 required context',
      mutate: (workflow: string) => workflow.replace('name: quality (25.x)', 'name: compatibility (25.x)'),
      evidence: 'jobs.compatibility name must be exactly quality (25.x)',
    },
    {
      name: 'duplicates coverage in the Node 25 lane',
      mutate: (workflow: string) => workflow.replace(
        '      - name: Full compatibility test suite',
        '      - name: Compatibility coverage\n        run: npm run coverage:check -- --pool=forks\n      - name: Full compatibility test suite',
      ),
      evidence: 'quality (25.x) must not duplicate coverage:check',
    },
    {
      name: 'makes the Node 25 lane advisory',
      mutate: (workflow: string) => workflow.replace(
        '    timeout-minutes: 40\n    steps:',
        '    timeout-minutes: 40\n    continue-on-error: true\n    steps:',
      ),
      evidence: 'quality (25.x) compatibility job must be blocking',
    },
    {
      name: 'conditions the Node 25 full suite',
      mutate: (workflow: string) => workflow.replace(
        '        run: npm test -- --pool=forks',
        '        if: github.ref == \'refs/heads/main\'\n        run: npm test -- --pool=forks',
      ),
      evidence: 'quality (25.x) required step must be unconditional and blocking: npm test -- --pool=forks',
    },
    {
      name: 'floats the Test Integrity revision',
      mutate: (workflow: string) => workflow.replace(
        'TEST_INTEGRITY_COMMIT: ea0b01a4e3d99dc58a9a475c57e22ee204b04a7c',
        'TEST_INTEGRITY_COMMIT: main',
      ),
      evidence: 'Test Integrity commit pin must match the reviewed 40-hex object',
    },
    {
      name: 'restores masked unconditional disk cleanup',
      mutate: (workflow: string) => workflow.replace(
        '        run: bash scripts/ci-disk-reclaim.sh',
        '        run: sudo rm -rf /usr/share/dotnet || true',
      ),
      evidence: 'quality workflow must not retain masked unconditional disk cleanup',
    },
  ])('fails when Quality $name', ({ mutate, evidence }) => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = mutate(workflow);
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-lane-partition'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining([evidence]) });
  });

  it('fails when the quality job loses its bounded timeout', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(qualityCiJobTimeoutBlock, [
      'quality:',
      '    name: quality (24.x)',
      '    runs-on: ubuntu-latest',
      '    # Generous cap so it only kills a genuinely hung run, not a slow-but-live',
      '    # one (the quality job runs the full suite + coverage and can take ~40min).',
      '    # Without this a hung run rides to the 6h GitHub default.',
      '    timeout-minutes: 360',
      '    steps:',
    ].join('\n'));
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({
      files: {
        '.github/workflows/quality.yml': mutated,
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['quality job timeout must be exactly 60 minutes']),
      });
  });

  it('does not couple timeout enforcement to rationale comments', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace('full suite + coverage and can take ~40min', 'full suite + coverage can take ~45min');
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({ status: 'pass' });
    expect(result.ok).toBe(true);
  });

  it('accepts explicit false advisory settings on the quality job and bounded step', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const jobExplicit = workflow.replace(
      '    timeout-minutes: 60\n    steps:',
      '    timeout-minutes: 60\n    continue-on-error: false\n    steps:',
    );
    expect(jobExplicit).not.toBe(workflow);
    const mutated = jobExplicit.replace(
      '      - name: Install Playwright system deps',
      '      - continue-on-error: false\n        name: Install Playwright system deps',
    );
    expect(mutated).not.toBe(jobExplicit);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({ status: 'pass' });
    expect(result.ok).toBe(true);
  });

  it('fails when Playwright system dependency installation loses its step timeout', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(qualityCiSystemDepsTimeoutBlock, [
      '      - name: Install Playwright system deps',
      '        run: npx playwright install-deps chromium',
      '',
      '      - name: Install Playwright chromium',
    ].join('\n'));
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({
      files: {
        '.github/workflows/quality.yml': mutated,
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'Playwright system-dependency step timeout must be exactly 5 minutes',
        ]),
      });
  });

  it('fails when Playwright system dependency installation becomes advisory', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(qualityCiSystemDepsTimeoutBlock, [
      '      - name: Install Playwright system deps',
      '        timeout-minutes: 5',
      '        continue-on-error: true',
      '        run: npx playwright install-deps chromium',
      '',
      '      - name: Install Playwright chromium',
    ].join('\n'));
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({
      files: {
        '.github/workflows/quality.yml': mutated,
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'Playwright system-dependency step continue-on-error must be absent or false',
        ]),
      });
  });

  it('fails when the Playwright system-dependency step starts with advisory mode', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '      - name: Install Playwright system deps\n        timeout-minutes: 5',
      '      - continue-on-error: true\n        name: Install Playwright system deps\n        timeout-minutes: 5',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'Playwright system-dependency step continue-on-error must be absent or false',
        ]),
      });
  });

  it('fails when the Playwright system-dependency step starts with a condition', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '      - name: Install Playwright system deps\n        timeout-minutes: 5',
      '      - if: false\n        name: Install Playwright system deps\n        timeout-minutes: 5',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['Playwright system-dependency step must not declare if']),
      });
  });

  it('fails when quoted YAML makes the quality job advisory', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '    timeout-minutes: 60\n    steps:',
      '    timeout-minutes: 60\n    "continue-on-error": true\n    steps:',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['quality job continue-on-error must be absent or false']),
      });
  });

  it('fails when quoted YAML makes the Playwright system-dependency step advisory', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '        timeout-minutes: 5\n        run: npx playwright install-deps chromium',
      '        timeout-minutes: 5\n        "continue-on-error": true\n        run: npx playwright install-deps chromium',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'Playwright system-dependency step continue-on-error must be absent or false',
        ]),
      });
  });

  it('fails when the browser retry reintroduces Playwright system-dependency installation', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '"$TIMEOUT_BIN" 300 npx playwright install chromium',
      '"$TIMEOUT_BIN" 300 npx playwright install chromium --with-deps',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'quality job must not run Playwright system-dependency installation outside the bounded step',
        ]),
      });
  });

  it('fails when the quality job depends on a skippable job', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace('jobs:\n  quality:', [
      'jobs:',
      '  suppress-quality:',
      '    runs-on: ubuntu-latest',
      '    if: false',
      '    steps:',
      "      - run: 'true'",
      '  quality:',
      '    needs: suppress-quality',
    ].join('\n'));
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['quality job must not declare needs']) });
  });

  it('fails when quality-job run defaults can suppress command execution', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace('    timeout-minutes: 60\n    steps:', [
      '    timeout-minutes: 60',
      '    defaults:',
      '      run:',
      '        shell: bash -n {0}',
      '    steps:',
    ].join('\n'));
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['quality job must not declare defaults']) });
  });

  it('fails when the Playwright system-dependency step overrides its shell', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '        timeout-minutes: 5\n        run: npx playwright install-deps chromium',
      '        timeout-minutes: 5\n        shell: bash -n {0}\n        run: npx playwright install-deps chromium',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['Playwright system-dependency step must not declare shell']),
      });
  });

  it('fails when the Playwright system-dependency step runs in the background', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '        timeout-minutes: 5\n        run: npx playwright install-deps chromium',
      '        timeout-minutes: 5\n        background: true\n        run: npx playwright install-deps chromium',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['Playwright system-dependency step must not declare background']),
      });
  });

  it('fails when the Playwright chromium retry runs in the background', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '      - name: Install Playwright chromium\n        run: |',
      '      - name: Install Playwright chromium\n        background: true\n        run: |',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['Playwright chromium install step must not declare background']),
      });
  });

  it('fails when the quality workflow uses an unsupported merge key', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '  quality:\n    name: quality (24.x)',
      '  quality:\n    <<: {}\n    name: quality (24.x)',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['quality workflow must not use YAML merge keys']),
      });
  });

  it('fails when the browser retry only echoes the required install command', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      'if "$TIMEOUT_BIN" 300 npx playwright install chromium; then',
      'if echo "$TIMEOUT_BIN" 300 npx playwright install chromium; then',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'Playwright chromium install step must use the exact bounded retry script',
        ]),
      });
  });

  it('fails when the quality job becomes advisory', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '    timeout-minutes: 60\n    steps:',
      '    timeout-minutes: 60\n    continue-on-error: true\n    steps:',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({
      files: {
        '.github/workflows/quality.yml': mutated,
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['quality job continue-on-error must be absent or false']),
      });
  });

  it('fails when the quality job becomes conditional', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '    timeout-minutes: 60\n    steps:',
      "    timeout-minutes: 60\n    if: github.ref == 'refs/heads/main'\n    steps:",
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['quality job must not declare if']),
      });
  });

  it('fails when a later quality-job timeout overrides the bounded timeout', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '    timeout-minutes: 60\n    steps:',
      '    timeout-minutes: 60\n    timeout-minutes: 360\n    steps:',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          expect.stringContaining('quality workflow YAML must parse without errors: Map keys must be unique'),
        ]),
      });
  });

  it('fails when Playwright system dependency installation has an unbounded duplicate', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace('      - name: Browser test suite', [
      '      - name: Install Playwright system deps again',
      '        run: npx playwright install-deps chromium',
      '',
      '      - name: Browser test suite',
    ].join('\n'));
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({
      files: {
        '.github/workflows/quality.yml': mutated,
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'quality job must contain exactly one Playwright system-dependency install command (found 2)',
        ]),
      });
  });

  it('fails when a quality-job step is not a mapping (playwright timeouts)', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '      - name: Enforce CI disk budget\n        run: bash scripts/ci-disk-reclaim.sh',
      '      - "not a mapping"',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-playwright-timeouts'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['every quality-job step must be a mapping']),
      });
  });

  it('fails when CI omits the no-reduce browser motion proof', () => {
    const fixture = makeRepo({
      files: {
        '.github/workflows/quality.yml': requiredFiles['.github/workflows/quality.yml']
          .replace('run: npm run test:browser:motion', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['run: npm run test:browser:motion']) });
  });

  it('fails when CI makes a browser proof conditional', () => {
    const fixture = makeRepo({
      files: {
        '.github/workflows/quality.yml': requiredFiles['.github/workflows/quality.yml']
          .replace(
            'run: npm run test:browser',
            'if: failure()\n        run: npm run test:browser',
          ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['conditional run: npm run test:browser (if: failure())']),
      });
  });

  it('fails when CI makes a browser proof advisory', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '      - name: Browser test suite\n        run: npm run test:browser',
      '      - name: Browser test suite\n        continue-on-error: true\n        run: npm run test:browser',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'advisory run: npm run test:browser (continue-on-error: true)',
        ]),
      });
  });

  it('fails when quoted YAML makes a browser proof conditional', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '      - name: Browser test suite\n        run: npm run test:browser',
      '      - name: Browser test suite\n        "if": false\n        run: npm run test:browser',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['conditional run: npm run test:browser (if: false)']),
      });
  });

  it('fails when a browser proof overrides its shell', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '      - name: Browser test suite\n        run: npm run test:browser',
      '      - name: Browser test suite\n        shell: bash -n {0}\n        run: npm run test:browser',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['run: npm run test:browser must not declare shell']),
      });
  });

  it('fails when a required browser proof runs in the background', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const mutated = workflow.replace(
      '      - name: Browser test suite\n        run: npm run test:browser',
      '      - name: Browser test suite\n        background: true\n        run: npm run test:browser',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['run: npm run test:browser must not declare background']),
      });
  });

  it('fails when a required browser proof moves outside the quality job', () => {
    const workflow = requiredFiles['.github/workflows/quality.yml'];
    const removed = workflow.replace(
      '      - name: Browser test suite\n        run: npm run test:browser',
      '      - name: Browser test suite\n        run: echo misplaced',
    );
    expect(removed).not.toBe(workflow);
    const mutated = removed.replace('jobs:\n  quality:', [
      'jobs:',
      '  unrelated:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Misplaced browser proof',
      '        run: npm run test:browser',
      '  quality:',
    ].join('\n'));
    expect(mutated).not.toBe(removed);
    const fixture = makeRepo({ files: { '.github/workflows/quality.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'workflow must contain exactly one run: npm run test:browser step (found 0)',
        ]),
      });
  });

  it('fails when CI omits design-system hygiene changed-range coverage', () => {
    const fixture = makeRepo({
      files: {
        '.github/workflows/quality.yml': requiredFiles['.github/workflows/quality.yml']
          .replace('npm run guard:design-system-hygiene -- --changed-since', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['npm run guard:design-system-hygiene -- --changed-since']) });
  });

  it('passes the required process-tree tag-release step', () => {
    const result = checkSafeguards(makeRepo());

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === 'tag-release-process-tree-adoption'))
      .toMatchObject({ status: 'pass' });
  });

  it.each([
    ['version tags', "on:\n  push:\n    tags: ['v*']", true],
    ['additional trigger', "on:\n  push:\n    tags: ['v*']\n  workflow_dispatch:", true],
    ['additional positive tag', "on:\n  push:\n    tags: ['v*', 'release-*']", true],
    ['manual only', 'on:\n  workflow_dispatch:', false],
    ['branch only', 'on:\n  push:\n    branches: [main]', false],
    ['wrong tags', "on:\n  push:\n    tags: ['release-*']", false],
    ['negative tag filter', "on:\n  push:\n    tags: ['v*', '!v2*']", false],
    ['ignored version tags', "on:\n  push:\n    tags-ignore: ['v*']", false],
    ['conflicting tag filters', "on:\n  push:\n    tags: ['v*']\n    tags-ignore: ['other*']", false],
    ['invalid tag pattern', "on:\n  push:\n    tags: ['v*', 42]", false],
  ] as const)('checks process-tree tag-release activation: %s', (_label, trigger, valid) => {
    const workflow = requiredTagReleaseWorkflow;
    const mutated = workflow.replace("on:\n  push:\n    tags:\n      - 'v*'", trigger);
    expect(mutated).not.toBe(workflow);
    const result = checkSafeguards(makeRepo({
      files: { '.github/workflows/tag-release-gate.yml': mutated },
    }));
    const check = result.checks.find((entry) => entry.id === 'tag-release-process-tree-adoption');

    expect(result.ok).toBe(valid);
    expect(check).toMatchObject({ status: valid ? 'pass' : 'fail' });
    if (!valid) {
      expect(check?.evidence).toContain(
        'tag release workflow must include on.push.tags v* with only positive tag patterns and no tags-ignore',
      );
    }
  });

  it.each([
    ['missing', ''],
    ['conditional', '      - if: false\n        run: npm run guard:process-tree-diagnostics'],
    ['advisory', '      - continue-on-error: true\n        run: npm run guard:process-tree-diagnostics'],
    ['masked', '      - run: npm run guard:process-tree-diagnostics || true'],
    ['nonexecuting shell', '      - shell: bash -n {0}\n        run: npm run guard:process-tree-diagnostics'],
  ])('fails a %s process-tree tag-release step', (_label, replacement) => {
    const workflow = requiredTagReleaseWorkflow;
    const mutated = workflow.replace(
      '      - name: Process-tree diagnostic adoption\n        run: npm run guard:process-tree-diagnostics',
      replacement,
    );
    expect(mutated).not.toBe(workflow);
    const result = checkSafeguards(makeRepo({
      files: { '.github/workflows/tag-release-gate.yml': mutated },
    }));

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'tag-release-process-tree-adoption'))
      .toMatchObject({ status: 'fail' });
  });

  it('fails a process-tree tag-release step moved outside the release job', () => {
    const workflow = requiredTagReleaseWorkflow;
    const step = '      - name: Process-tree diagnostic adoption\n        run: npm run guard:process-tree-diagnostics';
    const removed = workflow.replace(step, '');
    expect(removed).not.toBe(workflow);
    const mutated = removed.replace('jobs:\n  release-gate:', [
      'jobs:', '  unrelated:', '    runs-on: ubuntu-latest', '    steps:', step, '  release-gate:',
    ].join('\n'));
    expect(mutated).not.toBe(removed);
    const result = checkSafeguards(makeRepo({
      files: { '.github/workflows/tag-release-gate.yml': mutated },
    }));

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'tag-release-process-tree-adoption'))
      .toMatchObject({ status: 'fail' });
  });

  it('fails when tag release CI omits the shared console design verification chain', () => {
    const fixture = makeRepo({
      files: {
        '.github/workflows/tag-release-gate.yml': requiredFiles['.github/workflows/tag-release-gate.yml']
          .replace('run: npm run verify:console-design', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'tag-release-console-design-chain'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['run: npm run verify:console-design']) });
  });

  it('fails when tag release CI omits the browser motion proof', () => {
    const fixture = makeRepo({
      files: {
        '.github/workflows/tag-release-gate.yml': requiredFiles['.github/workflows/tag-release-gate.yml']
          .replace('run: npm run test:browser:motion', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'tag-release-console-design-chain'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['run: npm run test:browser:motion']) });
  });

  it('fails when tag release CI makes a browser proof conditional', () => {
    const fixture = makeRepo({
      files: {
        '.github/workflows/tag-release-gate.yml': requiredFiles['.github/workflows/tag-release-gate.yml']
          .replace(
            'run: npm run test:browser:motion',
            'if: failure()\n        run: npm run test:browser:motion',
          ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'tag-release-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['conditional run: npm run test:browser:motion (if: failure())']),
      });
  });

  it('fails when a tag-release browser proof overrides its shell', () => {
    const workflow = requiredFiles['.github/workflows/tag-release-gate.yml'];
    const mutated = workflow.replace(
      '      - name: Browser test suite\n        run: npm run test:browser',
      '      - name: Browser test suite\n        shell: bash -n {0}\n        run: npm run test:browser',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/tag-release-gate.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'tag-release-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['run: npm run test:browser must not declare shell']),
      });
  });

  it('fails when a tag-release browser proof runs in the background', () => {
    const workflow = requiredFiles['.github/workflows/tag-release-gate.yml'];
    const mutated = workflow.replace(
      '      - name: Browser test suite\n        run: npm run test:browser',
      '      - name: Browser test suite\n        background: true\n        run: npm run test:browser',
    );
    expect(mutated).not.toBe(workflow);
    const fixture = makeRepo({ files: { '.github/workflows/tag-release-gate.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'tag-release-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining(['run: npm run test:browser must not declare background']),
      });
  });

  it('fails when a required browser proof moves outside the tag-release job', () => {
    const workflow = requiredFiles['.github/workflows/tag-release-gate.yml'];
    const removed = workflow.replace(
      '      - name: Browser test suite\n        run: npm run test:browser',
      '      - name: Browser test suite\n        run: echo misplaced',
    );
    expect(removed).not.toBe(workflow);
    const mutated = removed.replace('jobs:\n  release-gate:', [
      'jobs:',
      '  unrelated:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Misplaced browser proof',
      '        run: npm run test:browser',
      '  release-gate:',
    ].join('\n'));
    expect(mutated).not.toBe(removed);
    const fixture = makeRepo({ files: { '.github/workflows/tag-release-gate.yml': mutated } });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'tag-release-console-design-chain'))
      .toMatchObject({
        status: 'fail',
        evidence: expect.arrayContaining([
          'workflow must contain exactly one run: npm run test:browser step (found 0)',
        ]),
      });
  });

  it('fails when a sensitive-surface anchor is removed', () => {
    const fixture = makeRepo({
      files: {
        'scripts/lib/repo-hygiene-policy.ts': requiredFiles['scripts/lib/repo-hygiene-policy.ts']
          .replace('private-instance-label\n', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'repo-hygiene-sensitive-patterns'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['private-instance-label']) });
  });

  it('fails when tracked health profiles contain unsafe credential paths or generated artifacts are tracked', () => {
    const fixture = makeRepo({
      trackedExtras: {
        'deploy/health-profiles/mwlab.json': '{"role":"bot-host","requiredCredentialFiles":["/var/lib/whatsoup/private/tokens.env"]}\n',
        'coverage-target/index.html': '<html></html>\n',
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'no-tracked-instance-health-profiles')?.evidence)
      .toEqual(['deploy/health-profiles/mwlab.json:unsafe-credential-path']);
    expect(result.checks.find((check) => check.id === 'no-tracked-generated-artifacts')?.evidence)
      .toEqual(['coverage-target/index.html']);
  });

  it('fails when tracked health profiles require the legacy fleet-token file', () => {
    const fixture = makeRepo({
      trackedExtras: {
        'deploy/health-profiles/test-host.json': '{"role":"bot-host","requiredCredentialFiles":["fleet-token"]}\n',
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'no-tracked-instance-health-profiles')?.evidence)
      .toEqual(['deploy/health-profiles/test-host.json:legacy-fleet-token']);
  });

  it('fails closed when required git inventory is unavailable', () => {
    const fixture = makeNonGitTree();

    expect(() => checkSafeguards(fixture)).toThrow(/not a git repository/);
  });

  it('strict mode fails on repo-state warnings', () => {
    const fixture = makeRepo();
    const result = checkSafeguards(fixture, true);

    expect(result.ok).toBe(false);
    expect(result.summary.warn).toBeGreaterThan(0);
  });

  it('prints deterministic text and JSON readouts', () => {
    const fixture = makeRepo();
    const text = formatReport(checkSafeguards(fixture));

    expect(text).toContain('safeguard diagnostics: PASS');
    expect(text).toContain('guard-chain/branch-push-chain');
    expect(parseArgs(['--json', '--strict'])).toEqual({ json: true, strict: true, help: false });
  });

  it('sets exitCode on failed CLI runs', () => {
    const fixture = makeRepo({ scripts: { 'verify:release': 'npm run guard:test-integrity' } });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = run([], fixture);

    expect(result.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(output).toHaveBeenCalled();
  });

  // A2: commandMatches piggyback bypass regression tests
  it('does not treat a semicolon-piggybacked command as matching the expected ordered step', () => {
    // 'npm run guard:safeguard-diagnostics ; rm -rf x' — with space before semicolon.
    // startsWith(expected + ' ') would match; commandMatches must reject this.
    const fixture = makeRepo({
      scripts: {
        'verify:push:branch': requiredPackageScripts['verify:push:branch']
          .replace(
            ' && npm run guard:safeguard-diagnostics',
            ' && npm run guard:safeguard-diagnostics ; rm -rf x',
          ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'branch-push-chain')?.evidence)
      .toContain('missing npm run guard:safeguard-diagnostics');
  });

  it('does not treat a pipe-piggybacked command as matching the expected ordered step', () => {
    // 'npm run guard:safeguard-diagnostics | tee y' — startsWith(expected + ' ') matches.
    // commandMatches must reject this trailing-pipe form.
    const fixture = makeRepo({
      scripts: {
        'verify:push:branch': requiredPackageScripts['verify:push:branch']
          .replace(
            ' && npm run guard:safeguard-diagnostics',
            ' && npm run guard:safeguard-diagnostics | tee y',
          ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'branch-push-chain')?.evidence)
      .toContain('missing npm run guard:safeguard-diagnostics');
  });

  it('does not treat an inline-background-op piggybacked command as matching the expected ordered step', () => {
    // 'npm run guard:safeguard-diagnostics & npm i evil' — startsWith(expected + ' ') matches.
    // commandMatches must reject this trailing-& form.
    const fixture = makeRepo({
      scripts: {
        'verify:push:branch': requiredPackageScripts['verify:push:branch']
          .replace(
            ' && npm run guard:safeguard-diagnostics',
            ' && npm run guard:safeguard-diagnostics & npm i evil',
          ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'branch-push-chain')?.evidence)
      .toContain('missing npm run guard:safeguard-diagnostics');
  });
});
