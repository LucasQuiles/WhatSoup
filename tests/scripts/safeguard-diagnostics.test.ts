import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  checkSafeguards,
  formatReport,
  parseArgs,
  run,
} from '../../scripts/safeguard-diagnostics.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempRepos: string[] = [];

const requiredPackageScripts = {
  'guard:publication': 'node scripts/publication-guard.ts',
  'guard:publication:all': 'npm run guard:publication -- --all',
  'guard:publication:release': 'npm run guard:publication -- --release',
  'guard:publication:staged': 'npm run guard:publication -- --staged',
  'guard:design-system-hygiene': 'node scripts/design-system-hygiene-guard.ts',
  'guard:repo:staged': 'npm run guard:repo -- --staged',
  'guard:repo:branch-diff': 'npm run guard:repo -- --branch-diff',
  'guard:repo:commit-authors': 'npm run guard:repo -- --commit-authors',
  'guard:repo:release-hygiene': 'npm run guard:repo -- --release-hygiene',
  'guard:test-integrity': 'bash scripts/test-integrity-ci.sh',
  'guard:lint:src': 'node scripts/eslint-fitness-check.ts',
  'guard:claude-settings': 'node scripts/claude-settings-guard.ts --check',
  'guard:agent-decision-polls': 'node scripts/agent-decision-polls-guard.ts',
  'guard:safeguard-diagnostics': 'node scripts/safeguard-diagnostics.ts',
  'guard:fleet-bot-hardening-parity': 'node scripts/check-fleet-bot-hardening-parity.ts',
  'guard:bot-errors-runtime-manifest': 'node scripts/check-bot-errors-runtime-manifest.ts',
  'test:design-guards': 'npm test -- tests/scripts/theme-parity.test.ts tests/scripts/token-spec-drift.test.ts tests/scripts/contrast-matrix.test.ts tests/scripts/shadow-baseline.test.ts tests/scripts/shadow-frozen-inventory.test.ts tests/scripts/raw-form-control-inventory.test.ts tests/scripts/design-regression-guards.test.ts tests/scripts/design-metrics.test.ts tests/scripts/design-burndown-check.test.ts tests/scripts/color-semantics.test.ts tests/scripts/design-resilience-audit.test.ts tests/scripts/font-assets.test.ts tests/scripts/brand-assets.test.ts tests/scripts/design-lint-fixtures.test.ts --pool=forks',
  'test:browser': 'vitest run --config vitest.browser.config.ts',
  'test:browser:motion': 'vitest run --config vitest.browser.motion.config.ts',
  'verify:console-design': [
    'npm --prefix console run design:theme-parity',
    'npm --prefix console run design:token-drift',
    'npm --prefix console run design:contrast',
    'npm --prefix console run lint:shadow:baseline',
    'npm --prefix console run design:shadow-frozen-inventory',
    'npm --prefix console run design:raw-form-control-inventory',
    'npm --prefix console run design:regression',
    'npm --prefix console run design:metrics',
    'npm --prefix console run design:burndown',
    'npm --prefix console run design:color-semantics',
    'npm --prefix console run design:resilience',
    'npm --prefix console run design:font-assets',
    'npm --prefix console run design:brand-assets',
    'npm --prefix console run design:lint-fixtures',
    'npm run test:design-guards',
  ].join(' && '),
  'verify:console-browser': [
    'npm run test:browser',
    'npm run test:browser:motion',
  ].join(' && '),
  'verify:push:branch': [
    'npm run guard:repo:staged',
    'npm run guard:repo:branch-diff',
    'npm run guard:repo:commit-authors',
    'npm run guard:publication:staged',
    'npm run guard:doc-drift',
    'npm run guard:public-surface-drift',
    'npm run guard:work-index',
    'npm run guard:node-pin-consistency',
    'npm run guard:source-runtime-drift',
    'npm run guard:fleet-bot-hardening-parity',
    'npm run guard:bot-errors-runtime-manifest',
    'npm run guard:bot-errors-simulation-matrix',
    'npm run guard:claude-settings',
    'npm run guard:agent-decision-polls',
    'npm run guard:safeguard-diagnostics',
    'npm run guard:test-integrity',
    'npm run guard:boundaries',
    'npm run guard:lint:src',
    'npm run typecheck:all',
    'npm test',
    'npm run verify:console-design',
  ].join(' && '),
  'verify:release': [
    'unset WHATSOUP_SKIP_DOC_DRIFT WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT WHATSOUP_SKIP_NODE_PIN_CHECK WHATSOUP_SKIP_BOUNDARY_CHECK',
    'npm run guard:repo:release-hygiene',
    'npm run guard:repo:commit-authors',
    'npm run guard:publication:all',
    'npm run guard:doc-drift',
    'npm run guard:public-surface-drift',
    'npm run guard:work-index',
    'npm run guard:doc-tally',
    'npm run guard:node-pin-consistency',
    'npm run guard:source-runtime-drift',
    'npm run guard:arc-binding-drift',
    'npm run guard:fleet-bot-hardening-parity',
    'npm run guard:bot-errors-runtime-manifest',
    'npm run guard:bot-errors-simulation-matrix',
    'npm run guard:claude-settings',
    'npm run guard:agent-decision-polls',
    'npm run guard:safeguard-diagnostics',
    'npm run guard:test-integrity',
    'npm run guard:boundaries',
    'npm run guard:fail-closed-gate',
    'npm run guard:service-units',
    'npm run guard:insecure-tempfile',
    'npm run guard:instance-config',
    'npm run guard:guard-test-coverage',
    'npm run guard:lint:src',
    'npm run test:tokenomics',
    'npm run test:drills',
    'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard ci',
    'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard run typecheck',
    'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard test',
    'bash scripts/run-with-pinned-npm.sh --prefix console ci',
    'bash scripts/run-with-pinned-npm.sh --prefix console run lint',
    'npm run typecheck:all',
    'npm run coverage:check -- --pool=forks --fileParallelism=false',
    'bash scripts/run-with-pinned-npm.sh --prefix console run build',
    'npm run verify:console-design',
    'npm run verify:console-browser',
  ].join(' && '),
  'verify:publish': [
    'npm run guard:claude-settings',
    'npm run guard:agent-decision-polls',
    'npm run guard:safeguard-diagnostics',
    'npm run guard:publication:release',
    'npm run verify:release',
  ].join(' && '),
};

const requiredConsolePackageScripts = {
  'design:brand-assets': 'node scripts/check-brand-assets.mjs --fail-on-rule soup/brand-favicon-link-required',
  'design:burndown': 'node scripts/check-design-burndown.mjs',
  'design:capture': 'node scripts/capture-visual-matrix.mjs',
  'design:capture:validate': 'node scripts/validate-visual-manifest.mjs',
  'design:color-semantics': 'node scripts/check-color-semantics.mjs --fail-on-rule soup/no-component-local-palette --fail-on-rule soup/provider-palette-only --fail-on-rule soup/data-series-token-only --fail-on-rule soup/traffic-neutrality',
  'design:contrast': 'node scripts/check-contrast-matrix.mjs',
  'design:font-assets': 'node scripts/check-font-assets.mjs',
  'design:lint-fixtures': 'node scripts/check-design-lint-fixtures.mjs',
  'design:metrics': 'node scripts/design-metrics.mjs',
  'design:raw-form-control-inventory': 'node scripts/check-raw-form-control-inventory.mjs',
  'design:regression': 'bash scripts/design-regression.sh',
  'design:resilience': 'node scripts/check-design-resilience.mjs --fail-on-rule soup/layer-owner-required --fail-on-rule soup/no-hover-only-content --fail-on-rule soup/no-layout-shift-interaction --fail-on-rule soup/no-raw-viewport-js --fail-on-rule soup/no-static-viewport-height --fail-on-rule soup/no-unsafe-truncation --fail-on-rule soup/no-vw-font-size --fail-on-rule soup/scroll-owner-required',
  'design:shadow-frozen-inventory': 'node scripts/check-shadow-frozen-inventory.mjs',
  'design:theme-parity': 'node scripts/check-theme-parity.mjs',
  'design:token-drift': 'node scripts/check-token-spec-drift.mjs',
  'lint:shadow:baseline': 'node scripts/check-shadow-baseline.mjs',
};

const requiredFiles: Record<string, string> = {
  'scripts/repo-hygiene-guard.ts': [
    'model-attribution',
    'private-instance-label',
    'whatsapp-group-jid',
    'whatsapp-user-jid',
    'github-token',
    'openai-key',
    'pinecone-key',
    'private-key',
    'Co-Authored-By:',
    '--commit-authors',
    'scanCommitMessage(commit.message',
  ].join('\n'),
  'scripts/publication-guard.ts': [
    'scanTextForPrivateLiterals',
    'local-home-path',
    'whatsapp-group-jid',
    'whatsapp-user-jid',
    'github-token',
    'openai-key',
    'pinecone-key',
    'private-key',
    'staged-internal-doc-unclassified',
    'release-internal-doc-still-tracked',
  ].join('\n'),
  'src/fleet/bind-guard.ts': [
    'assertSafeFleetBind',
    'non-loopback',
    'WHATSOUP_FLEET_UNSAFE_REMOTE_CONSOLE',
    'root token',
    'refusing non-loopback fleet bind',
  ].join('\n'),
  'src/fleet/update-checker.ts': [
    'shouldRetryWithPublicHttps',
    'githubPublicHttpsUrlFromRemote',
    'publicFetchArgs',
    'git SSH fetch failed',
  ].join('\n'),
  'tests/runtimes/agent/provider-fallback.test.ts': [
    'does NOT activate fallback on a usage-limit assistant_text event',
    'does not silently replay a turn after tool activity started',
    'keeps %s fallback armed until a primary recovery probe succeeds',
    'does NOT block activation when the fallback key is absent (warn-only)',
    'uses providerConfig.apiKeyService for same-provider API fallback key presence',
  ].join('\n'),
  'tests/fleet/routes/provider-status.test.ts': [
    'not.toContain',
    'keyPresent',
    'recoveryProbeRequired',
    'uses providerConfig.apiKeyService',
  ].join('\n'),
  'scripts/check-fleet-bot-hardening-parity.ts': [
    'REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES',
    'missing-required-capability',
    'hardened-row-not-proven',
    'sourceAnchors',
    'private-label',
  ].join('\n'),
  'scripts/agent-decision-polls-guard.ts': [
    'AskUserQuestion',
    'send_poll',
    'multiSelect',
    'guard:agent-decision-polls',
  ].join('\n'),
  'scripts/test-integrity-ci.sh': [
    'WHATSOUP_REQUIRE_TEST_INTEGRITY',
    'CI=true',
    'GITHUB_ACTIONS=true',
    'baseline --check --ci',
  ].join('\n'),
  'console/scripts/design-regression.sh': 'command -v rg',
  'console/src/components/primitives/Modal.tsx': 'useDismissable',
  '.github/workflows/quality.yml': [
    'name: Install console dependencies',
    'name: Design-system hygiene changed files',
    'npm run guard:design-system-hygiene -- --changed-since',
    'name: Console build',
    'name: Console design verification',
    'run: npm run verify:console-design',
    'run: npx playwright install-deps chromium',
    'name: Install Playwright chromium',
    'timeout 300 npx playwright install chromium',
    'name: Browser test suite',
    'run: npm run test:browser',
    'name: Browser motion test suite',
    'run: npm run test:browser:motion',
    'tests/browser/__screenshots__',
    'tests/browser-motion/__screenshots__',
  ].join('\n'),
  '.github/workflows/tag-release-gate.yml': [
    'name: Install console dependencies',
    'name: Console build',
    'name: Console design verification',
    'run: npm run verify:console-design',
    'name: Install Playwright chromium',
    'run: npx playwright install chromium --with-deps',
    'name: Browser test suite',
    'run: npm run test:browser',
    'name: Browser motion test suite',
    'run: npm run test:browser:motion',
    'tests/browser/__screenshots__',
    'tests/browser-motion/__screenshots__',
  ].join('\n'),
  '.husky/pre-commit': [
    'npm run guard:repo:staged',
    'npm run guard:publication:staged',
    'npm run guard:design-system-hygiene',
    'npm run guard:node-pin-consistency',
    'npm run guard:claude-settings',
    'lint-staged',
  ].join('\n'),
  'scripts/check-bot-errors-runtime-manifest.ts': [
    'REQUIRED_RUNTIME_MANIFEST_PATHS',
    'missing-required-path',
    'deploy/scripts/bot-errors-health-check.py',
    'deploy/scripts/bot-errors-emit.py',
    'src/lib/bot-errors-outbox.ts',
  ].join('\n'),
};

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: cleanGitEnv() });
}

function writeRepoFile(repo: string, relativePath: string, text: string): void {
  mkdirSync(path.dirname(path.join(repo, relativePath)), { recursive: true });
  writeFileSync(path.join(repo, relativePath), text);
}

function makeRepo(options: {
  consoleScripts?: Record<string, string | undefined>;
  scripts?: Record<string, string | undefined>;
  files?: Record<string, string | undefined>;
  trackedExtras?: Record<string, string>;
} = {}): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'safeguard-diagnostics-'));
  tempRepos.push(repo);
  const scripts = { ...requiredPackageScripts, ...(options.scripts ?? {}) };
  for (const [name, value] of Object.entries(scripts)) {
    if (value === undefined) delete scripts[name as keyof typeof scripts];
  }
  writeRepoFile(repo, 'package.json', JSON.stringify({ scripts }, null, 2));

  const consoleScripts = { ...requiredConsolePackageScripts, ...(options.consoleScripts ?? {}) };
  for (const [name, value] of Object.entries(consoleScripts)) {
    if (value === undefined) delete consoleScripts[name as keyof typeof consoleScripts];
  }
  writeRepoFile(repo, 'console/package.json', JSON.stringify({ scripts: consoleScripts }, null, 2));

  const files = { ...requiredFiles, ...(options.files ?? {}) };
  for (const [filePath, text] of Object.entries(files)) {
    if (text !== undefined) writeRepoFile(repo, filePath, `${text}\n`);
  }
  for (const [filePath, text] of Object.entries(options.trackedExtras ?? {})) {
    writeRepoFile(repo, filePath, text);
  }

  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'WhatSoup Test']);
  git(repo, ['config', 'user.email', 'whatsoup-test@users.noreply.github.com']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  return repo;
}

function makeNonGitTree(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'safeguard-diagnostics-nongit-'));
  tempRepos.push(repo);
  writeRepoFile(repo, 'package.json', JSON.stringify({ scripts: requiredPackageScripts }, null, 2));
  writeRepoFile(repo, 'console/package.json', JSON.stringify({ scripts: requiredConsolePackageScripts }, null, 2));
  for (const [filePath, text] of Object.entries(requiredFiles)) {
    writeRepoFile(repo, filePath, `${text}\n`);
  }
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const repo of tempRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
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
        'verify:console-design': requiredPackageScripts['verify:console-design']
          .replace(' && npm --prefix console run design:resilience', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'console-design-chain')?.evidence)
      .toContain('missing npm --prefix console run design:resilience');
  });

  it('fails when the shared console design verification chain omits raw form-control inventory coverage', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:console-design': requiredPackageScripts['verify:console-design']
          .replace(' && npm --prefix console run design:raw-form-control-inventory', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'console-design-chain')?.evidence)
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
        'verify:console-design': requiredPackageScripts['verify:console-design']
          .replace(' && npm --prefix console run design:shadow-frozen-inventory', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'console-design-chain')?.evidence)
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

  it('accepts serialized coverage as the only root full-suite release command', () => {
    const fixture = makeRepo();
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')).toMatchObject({
      status: 'pass',
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
          'npm run coverage:check -- --pool=forks --fileParallelism=false',
          'npm run coverage:check -- --pool=forks --fileParallelism=false && npm run coverage:check -- --pool=forks --fileParallelism=false',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('expected exactly one npm run coverage:check; found 2');
  });

  it('rejects release coverage without serialized runner flags', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          'npm run coverage:check -- --pool=forks --fileParallelism=false',
          'npm run coverage:check',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('missing exact npm run coverage:check -- --pool=forks --fileParallelism=false');
  });

  it('rejects release coverage with altered runner flags', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          '--pool=forks --fileParallelism=false',
          '--pool=threads --fileParallelism=false',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('missing exact npm run coverage:check -- --pool=forks --fileParallelism=false');
  });

  it('rejects release coverage without file parallelism disabled', () => {
    const fixture = makeRepo({
      scripts: {
        'verify:release': requiredPackageScripts['verify:release'].replace(
          'npm run coverage:check -- --pool=forks --fileParallelism=false',
          'npm run coverage:check -- --pool=forks',
        ),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.checks.find((check) => check.id === 'release-chain')?.evidence)
      .toContain('missing exact npm run coverage:check -- --pool=forks --fileParallelism=false');
  });

  it.each([
    ['npm run test', 'npm run test -- --pool=forks --fileParallelism=false', 'forbidden npm run test'],
    ['npm run coverage', 'npm run coverage -- --pool=forks --fileParallelism=false', 'forbidden npm run coverage'],
    ['direct coverage script', 'bash scripts/run-coverage-check.sh --pool=forks --fileParallelism=false', 'forbidden bash scripts/run-coverage-check.sh'],
  ])('rejects an extra full-suite launcher via %s', (_name, extraCommand, expectedEvidence) => {
    const canonical = 'npm run coverage:check -- --pool=forks --fileParallelism=false';
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
          'npm run coverage:check -- --pool=forks --fileParallelism=false',
          'node scripts/unexpected-release-step.mjs && npm run coverage:check -- --pool=forks --fileParallelism=false',
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
          .replace('run: npm run verify:console-design', ''),
      },
    });
    const result = checkSafeguards(fixture);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === 'quality-ci-console-design-chain'))
      .toMatchObject({ status: 'fail', evidence: expect.arrayContaining(['run: npm run verify:console-design']) });
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

  it('fails when a sensitive-surface anchor is removed', () => {
    const fixture = makeRepo({
      files: {
        'scripts/repo-hygiene-guard.ts': requiredFiles['scripts/repo-hygiene-guard.ts']
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
