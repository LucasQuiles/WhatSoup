import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = trackTmpDirs('');

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
  'guard:test-integrity:required': 'WHATSOUP_REQUIRE_TEST_INTEGRITY=1 npm run guard:test-integrity',
  'guard:lint:src': 'node scripts/eslint-fitness-check.ts',
  'guard:catch-ratchet': 'node scripts/generate-catch-ratchet.mjs --check',
  'guard:claude-settings': 'node scripts/claude-settings-guard.ts --check',
  'guard:agent-decision-polls': 'node scripts/agent-decision-polls-guard.ts',
  'guard:process-tree-diagnostics': 'node scripts/process-tree-diagnostic-adoption-guard.ts',
  'guard:semantic-quality': 'node scripts/semantic-quality-check.ts',
  'guard:safeguard-diagnostics': 'node scripts/safeguard-diagnostics.ts',
  'guard:fleet-bot-hardening-parity': 'node scripts/check-fleet-bot-hardening-parity.ts',
  'guard:bot-errors-runtime-manifest': 'node scripts/check-bot-errors-runtime-manifest.ts',
  'test:design-guards': 'npm test -- tests/scripts/theme-parity.test.ts tests/scripts/token-spec-drift.test.ts tests/scripts/contrast-matrix.test.ts tests/scripts/shadow-baseline.test.ts tests/scripts/shadow-frozen-inventory.test.ts tests/scripts/raw-form-control-inventory.test.ts tests/scripts/design-regression-guards.test.ts tests/scripts/design-metrics.test.ts tests/scripts/design-burndown-check.test.ts tests/scripts/color-semantics.test.ts tests/scripts/design-resilience-audit.test.ts tests/scripts/font-assets.test.ts tests/scripts/brand-assets.test.ts tests/scripts/design-lint-fixtures.test.ts --pool=forks',
  'test:browser': 'vitest run --config vitest.browser.config.ts',
  'test:browser:motion': 'vitest run --config vitest.browser.motion.config.ts',
  'verify:console-design:live': [
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
  ].join(' && '),
  'verify:console-design': [
    'npm run verify:console-design:live',
    'npm run test:design-guards',
  ].join(' && '),
  'verify:console-browser': [
    'npm run test:browser',
    'npm run test:browser:motion',
  ].join(' && '),
  'verify:semantic': 'npm run guard:semantic-quality -- --mode enforce',
  'verify:semantic:shadow': 'npm run guard:semantic-quality -- --mode shadow',
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
    'npm run verify:semantic:shadow',
    'npm run guard:test-integrity',
    'npm run guard:boundaries',
    'npm run guard:catch-ratchet',
    'npm run guard:process-tree-diagnostics',
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
    'npm run verify:semantic:shadow',
    'npm run guard:test-integrity:required',
    'npm run guard:boundaries',
    'npm run guard:fail-closed-gate',
    'npm run guard:durability-writer',
    'npm run guard:service-units',
    'npm run guard:insecure-tempfile',
    'npm run guard:zero-byte-tracked',
    'npm run guard:sql-schema',
    'npm run guard:platform-patterns',
    'npm run guard:no-destructive-git',
    'npm run guard:catch-ratchet',
    'npm run guard:grant-resolver',
    'npm run guard:resolved-override',
    'npm run guard:instance-config',
    'npm run guard:process-tree-diagnostics',
    'npm run guard:guard-test-coverage -- --semantic-mode enforce',
    'npm run guard:lint:src',
    'npm run test:tokenomics',
    'npm run test:deployment-qualification',
    'npm run test:drills',
    'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard ci',
    'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard run typecheck',
    'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard test',
    'bash scripts/run-with-pinned-npm.sh --prefix console ci',
    'bash scripts/run-with-pinned-npm.sh --prefix console run lint',
    'npm run typecheck:all',
    'npm run coverage:check -- --pool=forks',
    'bash scripts/run-with-pinned-npm.sh --prefix console run build',
    'npm run verify:console-design:live',
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
  'design:contrast': 'node scripts/check-contrast-matrix.mjs --no-write',
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

export const qualityCiJobTimeoutBlock = [
  'quality:',
  '    name: quality (24.x)',
  '    runs-on: ubuntu-latest',
  '    # Generous cap so it only kills a genuinely hung run, not a slow-but-live',
  '    # one (the quality job runs the full suite + coverage and can take ~40min).',
  '    # Without this a hung run rides to the 6h GitHub default.',
  '    timeout-minutes: 60',
  '    steps:',
].join('\n');

export const qualityCiSystemDepsTimeoutBlock = [
  '      - name: Install Playwright system deps',
  '        timeout-minutes: 5',
  '        run: npx playwright install-deps chromium',
  '',
  '      - name: Install Playwright chromium',
].join('\n');

const qualityCiBrowserInstallScript = [
  'TIMEOUT_BIN="$(bash scripts/resolve-timeout-bin.sh)"',
  'for attempt in 1 2 3; do',
  '  echo "::group::Playwright chromium download attempt ${attempt}/3"',
  '  if "$TIMEOUT_BIN" 300 npx playwright install chromium; then',
  '    echo "::endgroup::"',
  '    echo "Playwright chromium download succeeded on attempt ${attempt}"',
  '    exit 0',
  '  fi',
  '  echo "::endgroup::"',
  '  echo "Playwright chromium download attempt ${attempt} failed or timed out; retrying after backoff"',
  '  sleep $((attempt * 15))',
  'done',
  'echo "Playwright chromium download failed after 3 attempts"',
  'exit 1',
].join('\n');

const requiredQualityWorkflow = [
  'name: Quality',
  'on:',
  '  pull_request:',
  '  merge_group:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  quality:',
  '    name: quality (24.x)',
  '    runs-on: ubuntu-latest',
  '    # Generous cap so it only kills a genuinely hung run, not a slow-but-live',
  '    # one (the quality job runs the full suite + coverage and can take ~40min).',
  '    # Without this a hung run rides to the 6h GitHub default.',
  '    timeout-minutes: 60',
  '    steps:',
  '      - name: Setup Node 24',
  '        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  '        with:',
  "          node-version-file: '.nvmrc'",
  '      - name: Host dependency profile (strict)',
  '        run: |',
  '          bash deploy/scripts/install-host-dependencies.sh --profile quality --apply --yes --json > "$RUNNER_TEMP/whatsoup-doctor-quality.json"',
  '          echo "$HOME/.local/share/whatsoup/quality-venv/bin" >> "$GITHUB_PATH"',
  '      - name: Validate strict doctor receipt',
  '        run: |',
  '          set -o pipefail',
  '          bash deploy/scripts/whatsoup-host-doctor.sh --profile quality --json | tee "$RUNNER_TEMP/whatsoup-doctor-quality.json"',
  '          node -e \'const r=require(process.env.RUNNER_TEMP + "/whatsoup-doctor-quality.json"); if (r.outcome !== "pass") process.exit(1)\'',
  '      - name: Enforce CI disk budget',
  '        run: bash scripts/ci-disk-reclaim.sh',
  '      - name: Semantic quality (shadow)',
  '        env:',
  '          SEMANTIC_RECEIPT: ${{ runner.temp }}/semantic-quality.json',
  '        run: |',
  '          if [ -n "${GITHUB_BASE_REF:-}" ]; then',
  '            base="origin/$GITHUB_BASE_REF"',
  '          else',
  '            base="HEAD^"',
  '          fi',
  '          npm run guard:semantic-quality -- --mode shadow --base "$base" --receipt "$SEMANTIC_RECEIPT"',
  '          node -e \'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.env.SEMANTIC_RECEIPT,"utf8")); process.stdout.write(`### Semantic quality (shadow)\\n\\nDecision: **${r.decision}**\\n\\nFindings: ${r.findings.length}\\n`)\' >> "$GITHUB_STEP_SUMMARY"',
  '      - name: Install test-integrity plugin',
  '        env:',
  '          TEST_INTEGRITY_COMMIT: ea0b01a4e3d99dc58a9a475c57e22ee204b04a7c',
  '        run: |',
  '          mkdir -p "$plugin_dir" "$HOME/.ssh"',
  '          git -C "$plugin_dir" fetch --depth 1 origin "$TEST_INTEGRITY_COMMIT"',
  '          git -C "$plugin_dir" switch --detach FETCH_HEAD',
  '          observed_commit="$(git -C "$plugin_dir" rev-parse HEAD)"',
  '          if [ "$observed_commit" != "$TEST_INTEGRITY_COMMIT" ]; then',
  '            exit 2',
  '          fi',
  '      - name: Test integrity baseline check',
  '        run: npm run guard:test-integrity',
  '      - name: Install console dependencies',
  '        run: npm --prefix console ci',
  '      - name: Design-system hygiene changed files',
  '        run: npm run guard:design-system-hygiene -- --changed-since',
  '      - name: Console build',
  '        run: npm --prefix console run build',
  '      - name: Console design verification',
  '        run: npm run verify:console-design:live',
  '      - name: Install Playwright system deps',
  '        timeout-minutes: 5',
  '        run: npx playwright install-deps chromium',
  '',
  '      - name: Install Playwright chromium',
  '        run: |',
  ...qualityCiBrowserInstallScript.split('\n').map((line) => `          ${line}`),
  '      - name: Browser test suite',
  '        run: npm run test:browser',
  '      - name: Browser motion test suite',
  '        run: npm run test:browser:motion',
  '      - name: Test suite + coverage thresholds',
  '        run: npm run coverage:check -- --pool=forks',
  '      - name: Upload browser artifacts',
  '        uses: actions/upload-artifact@v4',
  '        with:',
  '          path: |',
  '            tests/browser/__screenshots__',
  '            tests/browser-motion/__screenshots__',
  '  compatibility:',
  '    name: quality (25.x)',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 40',
  '    steps:',
  '      - name: Setup Node 25',
  '        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  '        with:',
  "          node-version: '25.x'",
  '      - name: Install compatibility host dependencies',
  '        run: |',
  '          bash deploy/scripts/install-host-dependencies.sh --profile quality --node-policy compatibility --apply --yes --json > "$RUNNER_TEMP/whatsoup-host-install-compatibility.json"',
  '          echo "$HOME/.local/share/whatsoup/quality-venv/bin" >> "$GITHUB_PATH"',
  '      - name: Host dependency profile (compatibility-only)',
  '        run: |',
  '          set -o pipefail',
  '          bash deploy/scripts/whatsoup-host-doctor.sh --profile quality --node-policy compatibility --json | tee "$RUNNER_TEMP/whatsoup-doctor-compatibility.json"',
  '          node -e \'const r=require(process.env.RUNNER_TEMP + "/whatsoup-doctor-compatibility.json"); if (r.outcome !== "compatibility_only") process.exit(1)\'',
  '      - name: Install dependencies',
  '        run: npm ci',
  '      - name: Install console dependencies',
  '        run: npm --prefix console ci',
  '      - name: Full compatibility test suite',
  '        run: npm test -- --pool=forks',
  '      - name: Console compatibility build',
  '        run: npm --prefix console run build',
  '  bot-errors-health-macos:',
  '    runs-on: macos-14',
  '    steps:',
  '      - name: Portable Python and release-proof prerequisites (real macOS)',
  '        run: npm test -- tests/helpers/python-interpreter.test.ts tests/scripts/bot-errors-python-atomic-write-guard.test.ts tests/scripts/bot-errors-release-proof-installer.test.ts tests/scripts/bot-errors-release-proof-run.test.ts --pool=forks --maxWorkers=1',
].join('\n');

const requiredTagReleaseWorkflow = [
  'name: tag-release-gate',
  'on:',
  '  push:',
  '    tags:',
  "      - 'v*'",
  'jobs:',
  '  release-gate:',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 60',
  '    steps:',
  '      - name: Process-tree diagnostic adoption',
  '        run: npm run guard:process-tree-diagnostics',
  '      - name: Install console dependencies',
  '        run: npm --prefix console ci',
  '      - name: Console build',
  '        run: npm --prefix console run build',
  '      - name: Console design verification',
  '        run: npm run verify:console-design',
  '      - name: Install Playwright chromium',
  '        run: npx playwright install chromium --with-deps',
  '      - name: Browser test suite',
  '        run: npm run test:browser',
  '      - name: Browser motion test suite',
  '        run: npm run test:browser:motion',
  '      - name: Upload browser artifacts',
  '        uses: actions/upload-artifact@v4',
  '        with:',
  '          path: |',
  '            tests/browser/__screenshots__',
  '            tests/browser-motion/__screenshots__',
].join('\n');

const requiredFiles: Record<string, string> = {
  'scripts/lib/repo-hygiene-policy.ts': [
    'model-attribution',
    'private-instance-label',
    'whatsapp-group-jid',
    'whatsapp-user-jid',
    'github-token',
    'openai-key',
    'pinecone-key',
    'private-key',
    'Co-Authored-By:',
  ].join('\n'),
  'scripts/repo-hygiene-guard.ts': [
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
  '.github/workflows/quality.yml': requiredQualityWorkflow,
  '.github/workflows/tag-release-gate.yml': requiredTagReleaseWorkflow,
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
    'src/lib/fault-taxonomy-registry.json',
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
  const repo = tmp.make('safeguard-diagnostics');
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
  const repo = tmp.make('safeguard-diagnostics-nongit');
  writeRepoFile(repo, 'package.json', JSON.stringify({ scripts: requiredPackageScripts }, null, 2));
  writeRepoFile(repo, 'console/package.json', JSON.stringify({ scripts: requiredConsolePackageScripts }, null, 2));
  for (const [filePath, text] of Object.entries(requiredFiles)) {
    writeRepoFile(repo, filePath, `${text}\n`);
  }
  return repo;
}

export {
  makeNonGitTree,
  makeRepo,
  repoRoot,
  requiredFiles,
  requiredPackageScripts,
  requiredQualityWorkflow,
  requiredTagReleaseWorkflow,
};
