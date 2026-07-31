#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { git as runGit, gitList as runGitList, readText } from './lib/guard-core.ts';

export type DiagnosticStatus = 'pass' | 'warn' | 'fail';
export type DiagnosticCategory =
  | 'guard-chain'
  | 'secret-surface'
  | 'runtime-boundary'
  | 'public-exposure'
  | 'portability'
  | 'repo-state';

export interface DiagnosticCheck {
  id: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  message: string;
  evidence: string[];
  remediation?: string;
}

export interface GitContext {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirtyFiles: number | null;
  trackedGeneratedArtifacts: string[];
  trackedInstanceProfiles: string[];
}

export interface SafeguardDiagnosticsReport {
  ok: boolean;
  strict: boolean;
  cwd: string;
  git: GitContext;
  summary: Record<DiagnosticStatus, number>;
  checks: DiagnosticCheck[];
}

interface ChainRequirement {
  id: string;
  scriptName: string;
  orderedSteps: string[];
  forbiddenSteps?: string[];
  exactSteps?: string[];
  singleRunSteps?: string[];
  exactSequence?: boolean;
}

interface AnchorRequirement {
  id: string;
  category: DiagnosticCategory;
  file: string;
  anchors: string[];
  requiredUnconditionalRuns?: string[];
  requiredWorkflowJob?: string;
  validate?: (text: string) => string[];
  remediation: string;
}

interface ParsedArgs {
  json: boolean;
  strict: boolean;
  help: boolean;
}

const REQUIRED_SCRIPTS = [
  'guard:publication',
  'guard:publication:all',
  'guard:publication:release',
  'guard:publication:staged',
  'guard:design-system-hygiene',
  'guard:repo:staged',
  'guard:repo:branch-diff',
  'guard:repo:commit-authors',
  'guard:repo:release-hygiene',
  'guard:test-integrity',
  'guard:test-integrity:required',
  'guard:lint:src',
  'guard:catch-ratchet',
  'guard:claude-settings',
  'guard:agent-decision-polls',
  'guard:semantic-quality',
  'guard:safeguard-diagnostics',
  'guard:fleet-bot-hardening-parity',
  'guard:bot-errors-runtime-manifest',
  'test:design-guards',
  'test:browser',
  'test:browser:motion',
  'verify:console-design:live',
  'verify:console-design',
  'verify:console-browser',
  'verify:semantic',
  'verify:semantic:shadow',
  'verify:push:branch',
  'verify:release',
  'verify:publish',
];

const CHAIN_REQUIREMENTS: ChainRequirement[] = [
  {
    id: 'console-design-live-chain',
    scriptName: 'verify:console-design:live',
    orderedSteps: [
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
    ],
  },
  {
    id: 'console-design-chain',
    scriptName: 'verify:console-design',
    orderedSteps: [
      'npm run verify:console-design:live',
      'npm run test:design-guards',
    ],
    exactSequence: true,
  },
  {
    id: 'branch-push-chain',
    scriptName: 'verify:push:branch',
    orderedSteps: [
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
      'npm run guard:lint:src',
      'npm run typecheck:all',
      'npm test',
      'npm run verify:console-design',
    ],
  },
  {
    id: 'console-browser-chain',
    scriptName: 'verify:console-browser',
    orderedSteps: [
      'npm run test:browser',
      'npm run test:browser:motion',
    ],
  },
  {
    id: 'release-chain',
    scriptName: 'verify:release',
    orderedSteps: [
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
      'npm run guard:platform-patterns',
      'npm run guard:no-destructive-git',
      'npm run guard:catch-ratchet',
      'npm run guard:grant-resolver',
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
      'npm run verify:console-design:live',
      'npm run verify:console-browser',
    ],
    exactSequence: true,
    forbiddenSteps: [
      'npm --prefix tools/whatsoup_guard ci',
      'npm --prefix tools/whatsoup_guard run typecheck',
      'npm --prefix tools/whatsoup_guard test',
      'npm --prefix console ci',
      'npm --prefix console run lint',
      'npm --prefix console run build',
      'npm test',
      'npm run test',
      'npm run coverage',
      'bash scripts/run-coverage-check.sh',
    ],
    exactSteps: [
      'npm run coverage:check -- --pool=forks --fileParallelism=false',
    ],
    singleRunSteps: [
      'npm run coverage:check',
    ],
  },
  {
    id: 'publish-chain',
    scriptName: 'verify:publish',
    orderedSteps: [
      'npm run guard:claude-settings',
      'npm run guard:agent-decision-polls',
      'npm run guard:safeguard-diagnostics',
      'npm run guard:publication:release',
      'npm run verify:release',
    ],
  },
];

const CONSOLE_DESIGN_CHAIN_EXEMPTIONS = new Set([
  'design:capture',
  'design:capture:validate',
]);

const QUALITY_CI_BROWSER_INSTALL_SCRIPT = [
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
  '',
].join('\n');

const ANCHOR_REQUIREMENTS: AnchorRequirement[] = [
  {
    id: 'design-regression-rg-preflight',
    category: 'portability',
    file: 'console/scripts/design-regression.sh',
    anchors: ['command -v rg'],
    remediation:
      'Restore the fail-closed ripgrep preflight in design-regression.sh; without it a missing rg makes rg_count() silently return 0 and every blocking check FALSE-PASSes.',
  },
  {
    id: 'modal-focus-restore',
    category: 'public-exposure',
    file: 'console/src/components/primitives/Modal.tsx',
    anchors: ['useDismissable'],
    remediation:
      'Modal must keep useDismissable wired — it captures document.activeElement on open and restores focus to the opener on close (the FF-C1 modal-must-restore-focus a11y contract). Every dialog composes the Modal primitive, so removing it silently breaks keyboard focus return across all dialogs.',
  },
  {
    id: 'repo-hygiene-sensitive-patterns',
    category: 'secret-surface',
    file: 'scripts/lib/repo-hygiene-policy.ts',
    anchors: [
      'model-attribution',
      'private-instance-label',
      'whatsapp-group-jid',
      'whatsapp-user-jid',
      'github-token',
      'openai-key',
      'pinecone-key',
      'private-key',
      'Co-Authored-By:',
    ],
    remediation: 'Restore repo-hygiene policy patterns before publishing changes.',
  },
  {
    id: 'repo-hygiene-entrypoints',
    category: 'secret-surface',
    file: 'scripts/repo-hygiene-guard.ts',
    anchors: [
      '--commit-authors',
      'scanCommitMessage(commit.message',
    ],
    remediation: 'Restore repo-hygiene entrypoint wiring before publishing changes.',
  },
  {
    id: 'publication-sensitive-patterns',
    category: 'secret-surface',
    file: 'scripts/publication-guard.ts',
    anchors: [
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
    ],
    remediation: 'Restore publication guard coverage for public text and staged internal docs.',
  },
  {
    id: 'fleet-public-bind-guard',
    category: 'public-exposure',
    file: 'src/fleet/bind-guard.ts',
    anchors: [
      'assertSafeFleetBind',
      'non-loopback',
      'WHATSOUP_FLEET_UNSAFE_REMOTE_CONSOLE',
      'root token',
      'refusing non-loopback fleet bind',
    ],
    remediation: 'Restore the fleet bind guard before enabling remote console access.',
  },
  {
    id: 'fleet-public-update-fallback',
    category: 'portability',
    file: 'src/fleet/update-checker.ts',
    anchors: [
      'shouldRetryWithPublicHttps',
      'githubPublicHttpsUrlFromRemote',
      'publicFetchArgs',
      'git SSH fetch failed',
    ],
    remediation: 'Keep public update checks usable for users without private deploy keys.',
  },
  {
    id: 'provider-fallback-boundary-tests',
    category: 'runtime-boundary',
    file: 'tests/runtimes/agent/provider-fallback.test.ts',
    anchors: [
      'does NOT activate fallback on a usage-limit assistant_text event',
      'does not silently replay a turn after tool activity started',
      'keeps %s fallback armed until a primary recovery probe succeeds',
      'does NOT block activation when the fallback key is absent (warn-only)',
      'uses providerConfig.apiKeyService for same-provider API fallback key presence',
    ],
    remediation: 'Restore provider fallback tests before changing runtime fallback behavior.',
  },
  {
    id: 'provider-status-does-not-leak-keys',
    category: 'secret-surface',
    file: 'tests/fleet/routes/provider-status.test.ts',
    anchors: [
      'not.toContain',
      'keyPresent',
      'recoveryProbeRequired',
      'uses providerConfig.apiKeyService',
    ],
    remediation: 'Restore provider-status key-presence tests before exposing provider state.',
  },
  {
    id: 'fleet-bot-hardening-parity-guard',
    category: 'guard-chain',
    file: 'scripts/check-fleet-bot-hardening-parity.ts',
    anchors: [
      'REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES',
      'missing-required-capability',
      'hardened-row-not-proven',
      'sourceAnchors',
      'private-label',
    ],
    remediation: 'Restore the fleet bot-hardening parity guard before changing provider resilience rollout tracking.',
  },
  {
    id: 'agent-decision-polls-guard',
    category: 'runtime-boundary',
    file: 'scripts/agent-decision-polls-guard.ts',
    anchors: [
      'AskUserQuestion',
      'send_poll',
      'multiSelect',
      'guard:agent-decision-polls',
    ],
    remediation: 'Restore the decision-poll guard before changing agent question flows.',
  },
  {
    id: 'test-integrity-required-in-ci',
    category: 'guard-chain',
    file: 'scripts/test-integrity-ci.sh',
    anchors: [
      'WHATSOUP_REQUIRE_TEST_INTEGRITY',
      'CI=true',
      'GITHUB_ACTIONS=true',
      'baseline --check --ci',
    ],
    remediation: 'Restore CI fail-closed behavior for missing test-integrity tooling.',
  },
  {
    id: 'quality-ci-semantic-shadow',
    category: 'guard-chain',
    file: '.github/workflows/quality.yml',
    anchors: [],
    validate: qualityCiSemanticShadowFailures,
    remediation:
      'Restore the single Node 24 semantic shadow step, isolated receipt, read-only permissions, and pre-suite ordering in quality.yml.',
  },
  {
    id: 'quality-ci-lane-partition',
    category: 'guard-chain',
    file: '.github/workflows/quality.yml',
    anchors: [],
    validate: qualityCiLanePartitionFailures,
    remediation:
      'Restore the exact quality (24.x) authority job, quality (25.x) compatibility job, pinned Test Integrity checkout, and measured disk-budget step.',
  },
  {
    id: 'quality-ci-console-design-chain',
    category: 'guard-chain',
    file: '.github/workflows/quality.yml',
    anchors: [
      'name: Install console dependencies',
      'name: Design-system hygiene changed files',
      'npm run guard:design-system-hygiene -- --changed-since',
      'name: Console build',
      'name: Console design verification',
      'run: npm run verify:console-design:live',
      'run: npx playwright install-deps chromium',
      'name: Install Playwright chromium',
      'npx playwright install chromium',
      'name: Browser test suite',
      'run: npm run test:browser',
      'name: Browser motion test suite',
      'run: npm run test:browser:motion',
      'tests/browser/__screenshots__',
      'tests/browser-motion/__screenshots__',
    ],
    requiredUnconditionalRuns: [
      'run: npx playwright install-deps chromium',
      'run: npm run test:browser',
      'run: npm run test:browser:motion',
    ],
    requiredWorkflowJob: 'quality',
    remediation: 'Restore the shared console design verification chain in quality.yml CI.',
  },
  {
    id: 'quality-ci-playwright-timeouts',
    category: 'guard-chain',
    file: '.github/workflows/quality.yml',
    anchors: [],
    validate: qualityCiPlaywrightTimeoutFailures,
    remediation:
      'Restore the 60-minute quality job cap and 5-minute Playwright system-dependency step cap so hosted-runner stalls fail closed.',
  },
  {
    id: 'tag-release-console-design-chain',
    category: 'guard-chain',
    file: '.github/workflows/tag-release-gate.yml',
    anchors: [
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
    ],
    requiredUnconditionalRuns: [
      'run: npx playwright install chromium --with-deps',
      'run: npm run test:browser',
      'run: npm run test:browser:motion',
    ],
    requiredWorkflowJob: 'release-gate',
    remediation: 'Restore the shared console design and browser verification chain in tag-release-gate.yml.',
  },
  {
    id: 'pre-commit-design-system-hygiene',
    category: 'guard-chain',
    file: '.husky/pre-commit',
    anchors: [
      'npm run guard:repo:staged',
      'npm run guard:publication:staged',
      'npm run guard:design-system-hygiene',
      'npm run guard:node-pin-consistency',
      'npm run guard:claude-settings',
      'lint-staged',
    ],
    remediation: 'Restore the pre-commit hook so staged repo, publication, docs-hygiene, node-pin, settings, and console lint checks run before commit.',
  },
  {
    id: 'bot-errors-runtime-manifest-required-paths',
    category: 'guard-chain',
    file: 'scripts/check-bot-errors-runtime-manifest.ts',
    anchors: [
      'REQUIRED_RUNTIME_MANIFEST_PATHS',
      'missing-required-path',
      'deploy/scripts/bot-errors-health-check.py',
      'deploy/scripts/bot-errors-emit.py',
      'src/lib/bot-errors-outbox.ts',
      'src/lib/fault-taxonomy-registry.json',
    ],
    remediation: 'Restore required BOT ERRORS runtime manifest path enforcement before deploying runtime scripts.',
  },
];

function loadPackageScripts(cwd: string, packagePath = 'package.json'): Record<string, string> {
  const text = readText(cwd, packagePath);
  if (text === null) throw new Error(`${packagePath} is missing`);
  const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.scripts ?? {})) {
    if (typeof value === 'string') scripts[name] = value;
  }
  return scripts;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return runGit(args, cwd).trim();
  } catch {
    return null;
  }
}

function gitList(cwd: string, args: string[]): string[] {
  return runGitList(args, cwd);
}

function unsafeTrackedInstanceProfiles(cwd: string, tracked: string[]): string[] {
  const unsafe: string[] = [];
  const secretLiteralPattern = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN [^-]+ PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/i;
  for (const file of tracked.filter((item) => item.startsWith('deploy/health-profiles/') && path.basename(item) !== 'example.json')) {
    const text = readText(cwd, file);
    if (text === null) {
      unsafe.push(`${file}:unreadable`);
      continue;
    }
    if (secretLiteralPattern.test(text)) {
      unsafe.push(`${file}:secret-literal`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      unsafe.push(`${file}:invalid-json`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      unsafe.push(`${file}:not-object`);
      continue;
    }
    const profile = parsed as Record<string, unknown>;
    const required = profile.requiredCredentialFiles;
    const credentials = Array.isArray(required) ? required : [];
    for (const item of credentials) {
      if (typeof item !== 'string') continue;
      if (item === 'fleet-token') {
        unsafe.push(`${file}:legacy-fleet-token`);
        break;
      }
      if (item.startsWith('/') || item.startsWith('~') || item.includes('..')) {
        unsafe.push(`${file}:unsafe-credential-path`);
        break;
      }
    }
  }
  return unsafe;
}


function collectGitContext(cwd: string): GitContext {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']);
  const upstream = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const counts = git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    const [aheadRaw, behindRaw] = counts?.split(/\s+/) ?? [];
    const aheadParsed = Number(aheadRaw);
    const behindParsed = Number(behindRaw);
    ahead = Number.isFinite(aheadParsed) ? aheadParsed : null;
    behind = Number.isFinite(behindParsed) ? behindParsed : null;
  }

  const status = gitList(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  const tracked = gitList(cwd, ['ls-files']);
  return {
    branch,
    head,
    upstream,
    ahead,
    behind,
    dirtyFiles: status.length,
    trackedGeneratedArtifacts: tracked.filter((file) => (
      file.startsWith('.codex-artifacts/')
      || file.startsWith('coverage-target/')
      || file.startsWith('.codex-backups/')
    )),
    trackedInstanceProfiles: unsafeTrackedInstanceProfiles(cwd, tracked),
  };
}

function checkScriptPresence(scripts: Record<string, string>): DiagnosticCheck {
  const missing = REQUIRED_SCRIPTS.filter((scriptName) => scripts[scriptName] === undefined);
  return {
    id: 'required-package-scripts',
    category: 'guard-chain',
    status: missing.length === 0 ? 'pass' : 'fail',
    message: missing.length === 0
      ? 'Required guard and verification scripts are present.'
      : `Missing ${missing.length} required guard/verification script(s).`,
    evidence: missing.length === 0 ? REQUIRED_SCRIPTS : missing,
    remediation: 'Restore package.json guard scripts before publishing.',
  };
}

// Shell metacharacters that indicate a piggybacked command after the expected prefix.
// We reject any suffix that contains these to close the trailing-piggyback bypass.
const SHELL_METACHAR_RE = /[;|&\\$()<>`\n]/;

function commandMatches(expected: string, actual: string): boolean {
  if (actual === expected) return true;
  if (!actual.startsWith(`${expected} `)) return false;
  const suffix = actual.slice(expected.length);
  return !SHELL_METACHAR_RE.test(suffix);
}

function findCommandIndex(chainSteps: string[], expected: string): number {
  return chainSteps.findIndex((actual) => commandMatches(expected, actual));
}

function checkChainRequirement(scripts: Record<string, string>, requirement: ChainRequirement): DiagnosticCheck {
  const chain = scripts[requirement.scriptName];
  if (!chain) {
    return {
      id: requirement.id,
      category: 'guard-chain',
      status: 'fail',
      message: `${requirement.scriptName} is missing.`,
      evidence: [requirement.scriptName],
      remediation: `Restore ${requirement.scriptName} in package.json.`,
    };
  }

  const chainSteps = chain.split(/\s+&&\s+/).map((step) => step.trim()).filter(Boolean);
  const missing = requirement.orderedSteps.filter((step) => findCommandIndex(chainSteps, step) < 0);
  const forbiddenPresent = (requirement.forbiddenSteps ?? []).filter((step) => findCommandIndex(chainSteps, step) >= 0);
  const missingExact = (requirement.exactSteps ?? []).filter((step) => !chainSteps.includes(step));
  const wrongCardinality = (requirement.singleRunSteps ?? [])
    .map((step) => ({
      step,
      count: chainSteps.filter((actual) => commandMatches(step, actual)).length,
    }))
    .filter(({ count }) => count !== 1);
  const exactSequenceMismatch = requirement.exactSequence === true && (
    chainSteps.length !== requirement.orderedSteps.length
    || chainSteps.some((step, index) => step !== requirement.orderedSteps[index])
  );
  const outOfOrder: string[] = [];
  let previousIndex = -1;
  for (const step of requirement.orderedSteps) {
    const index = findCommandIndex(chainSteps, step);
    if (index < 0) continue;
    if (index < previousIndex) outOfOrder.push(step);
    previousIndex = Math.max(previousIndex, index);
  }

  const failures = [
    ...missing.map((step) => `missing ${step}`),
    ...missingExact.map((step) => `missing exact ${step}`),
    ...outOfOrder.map((step) => `out-of-order ${step}`),
    ...forbiddenPresent.map((step) => `forbidden ${step}`),
    ...wrongCardinality.map(({ step, count }) => `expected exactly one ${step}; found ${count}`),
    ...(exactSequenceMismatch ? ['exact command sequence mismatch'] : []),
  ];

  return {
    id: requirement.id,
    category: 'guard-chain',
    status: failures.length === 0 ? 'pass' : 'fail',
    message: failures.length === 0
      ? `${requirement.scriptName} guard chain is present and ordered.`
      : `${requirement.scriptName} guard chain is incomplete or out of order.`,
    evidence: failures.length === 0 ? requirement.orderedSteps : failures,
    remediation: `Restore the intended ${requirement.scriptName} guard order in package.json.`,
  };
}

function consoleDesignScriptSteps(consoleScripts: Record<string, string>): string[] {
  return Object.keys(consoleScripts)
    .filter((scriptName) => scriptName.startsWith('design:'))
    .filter((scriptName) => !CONSOLE_DESIGN_CHAIN_EXEMPTIONS.has(scriptName))
    .sort()
    .map((scriptName) => `npm --prefix console run ${scriptName}`);
}

function checkConsoleDesignScriptCoverage(rootScripts: Record<string, string>, consoleScripts: Record<string, string>): DiagnosticCheck {
  const chain = rootScripts['verify:console-design:live'];
  if (!chain) {
    return {
      id: 'console-design-script-coverage',
      category: 'guard-chain',
      status: 'fail',
      message: 'verify:console-design:live is missing.',
      evidence: ['verify:console-design:live'],
      remediation: 'Restore verify:console-design:live before relying on console design guard coverage.',
    };
  }

  const requiredSteps = consoleDesignScriptSteps(consoleScripts);
  const missing = requiredSteps.filter((step) => !chain.includes(step));
  return {
    id: 'console-design-script-coverage',
    category: 'guard-chain',
    status: missing.length === 0 ? 'pass' : 'fail',
    message: missing.length === 0
      ? 'All non-capture console design scripts are wired into verify:console-design:live.'
      : `verify:console-design:live omits ${missing.length} console design script(s).`,
    evidence: missing.length === 0 ? requiredSteps : missing.map((step) => `missing ${step}`),
    remediation: 'Add the missing console design guard scripts to verify:console-design:live, or explicitly classify them as visual capture-only.',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function containsMappingKey(value: unknown, key: string, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsMappingKey(entry, key, seen));
  const record = value as Record<string, unknown>;
  if (hasOwn(record, key)) return true;
  return Object.values(record).some((entry) => containsMappingKey(entry, key, seen));
}

function collectStringValues(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return entries.flatMap((entry) => collectStringValues(entry, seen));
}

function runControlFailures(step: Record<string, unknown>, label: string): string[] {
  return ['shell', 'env', 'working-directory', 'background']
    .filter((key) => hasOwn(step, key))
    .map((key) => `${label} must not declare ${key}`);
}

function parseWorkflow(text: string, label: string): { root: Record<string, unknown> | null; failures: string[] } {
  const document = parseDocument(text, { merge: false, stringKeys: true, uniqueKeys: true });
  const parseProblems = [...document.errors, ...document.warnings];
  if (parseProblems.length > 0) {
    return {
      root: null,
      failures: parseProblems.map((problem) => `${label} YAML must parse without errors: ${problem.message}`),
    };
  }

  try {
    const root = asRecord(document.toJS({ maxAliasCount: 20 }));
    if (root && containsMappingKey(root, '<<')) {
      return { root: null, failures: [`${label} must not use YAML merge keys`] };
    }
    return root
      ? { root, failures: [] }
      : { root: null, failures: [`${label} must contain a mapping at its root`] };
  } catch (error) {
    return {
      root: null,
      failures: [`${label} YAML conversion failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function qualityCiSemanticShadowFailures(text: string): string[] {
  const { root, failures: parseFailures } = parseWorkflow(text, 'quality workflow');
  if (!root) return parseFailures;
  const failures: string[] = [];
  const triggers = asRecord(root.on);
  if (triggers && hasOwn(triggers, 'pull_request_target')) {
    failures.push('quality workflow must not use pull_request_target');
  }
  const permissions = asRecord(root.permissions);
  if (!permissions
    || permissions.contents !== 'read'
    || Object.keys(permissions).some((key) => key !== 'contents')) {
    failures.push('quality workflow permissions must be exactly contents: read');
  }

  const jobs = asRecord(root.jobs);
  const quality = asRecord(jobs?.quality);
  if (!quality || !Array.isArray(quality.steps)) {
    failures.push('workflow must declare jobs.quality.steps as an array');
    return failures;
  }
  const steps = quality.steps.map(asRecord);
  if (steps.some((step) => step === null)) {
    failures.push('every quality-job step must be a mapping');
    return failures;
  }
  const stepRecords = steps as Record<string, unknown>[];
  const semanticSteps = stepRecords.filter((step) => step.name === 'Semantic quality (shadow)');
  if (semanticSteps.length !== 1) {
    failures.push(`quality job must contain exactly one Semantic quality (shadow) step (found ${semanticSteps.length})`);
    return failures;
  }
  const semantic = semanticSteps[0]!;
  const semanticIndex = stepRecords.indexOf(semantic);
  const integrityIndex = stepRecords.findIndex((step) => step.name === 'Install test-integrity plugin');
  const suiteIndex = stepRecords.findIndex((step) => step.name === 'Test suite + coverage thresholds');
  if (integrityIndex < 0 || semanticIndex > integrityIndex) {
    failures.push('Semantic quality (shadow) must run before Install test-integrity plugin');
  }
  if (suiteIndex < 0 || semanticIndex > suiteIndex) {
    failures.push('Semantic quality (shadow) must run before Test suite + coverage thresholds');
  }
  if (hasOwn(semantic, 'if')) {
    failures.push('Semantic quality (shadow) must be unconditional inside the Node 24 authority job');
  }
  if (hasOwn(semantic, 'continue-on-error') || hasOwn(semantic, 'uses')) {
    failures.push('Semantic quality (shadow) must use a blocking run step without continue-on-error');
  }
  for (const key of ['shell', 'working-directory', 'background']) {
    if (hasOwn(semantic, key)) failures.push(`Semantic quality (shadow) must not declare ${key}`);
  }

  const env = asRecord(semantic.env);
  if (!env || env.SEMANTIC_RECEIPT !== '${{ runner.temp }}/semantic-quality.json') {
    failures.push('Semantic quality (shadow) receipt must live under runner.temp');
  }
  const run = typeof semantic.run === 'string' ? semantic.run : '';
  for (const required of [
    'base="origin/$GITHUB_BASE_REF"',
    'base="HEAD^"',
    'npm run guard:semantic-quality -- --mode shadow --base "$base" --receipt "$SEMANTIC_RECEIPT"',
    'process.env.SEMANTIC_RECEIPT',
    'r.decision',
    'r.findings.length',
    '>> "$GITHUB_STEP_SUMMARY"',
  ]) {
    if (!run.includes(required)) failures.push(`Semantic quality (shadow) run script is missing ${required}`);
  }

  const uploadsSemanticReceipt = stepRecords.some((step) => (
    typeof step.uses === 'string'
    && step.uses.includes('actions/upload-artifact')
    && collectStringValues(step).some((value) => value.includes('semantic-quality'))
  ));
  if (uploadsSemanticReceipt) failures.push('semantic quality receipts must not be uploaded as artifacts');
  return failures;
}

function qualityCiLanePartitionFailures(text: string): string[] {
  const { root, failures: parseFailures } = parseWorkflow(text, 'quality workflow');
  if (!root) return parseFailures;
  const failures: string[] = [];
  const jobs = asRecord(root.jobs);
  const quality = asRecord(jobs?.quality);
  const compatibility = asRecord(jobs?.compatibility);
  if (!quality || !compatibility) {
    return ['quality workflow must declare jobs.quality and jobs.compatibility'];
  }
  if (quality.name !== 'quality (24.x)') failures.push('jobs.quality name must be exactly quality (24.x)');
  if (compatibility.name !== 'quality (25.x)') {
    failures.push('jobs.compatibility name must be exactly quality (25.x)');
  }
  if (hasOwn(quality, 'strategy') || hasOwn(compatibility, 'strategy')) {
    failures.push('quality authority and compatibility jobs must not use a matrix strategy');
  }
  if (compatibility['timeout-minutes'] !== 40) {
    failures.push('quality (25.x) compatibility timeout must be exactly 40 minutes');
  }
  if (compatibility['runs-on'] !== 'ubuntu-latest') {
    failures.push('quality (25.x) compatibility runner must be exactly ubuntu-latest');
  }
  if (hasOwn(compatibility, 'continue-on-error') && compatibility['continue-on-error'] !== false) {
    failures.push('quality (25.x) compatibility job must be blocking');
  }
  for (const forbiddenKey of ['if', 'needs', 'defaults', 'env']) {
    if (hasOwn(compatibility, forbiddenKey)) {
      failures.push(`quality (25.x) compatibility job must not declare ${forbiddenKey}`);
    }
  }

  const qualitySteps = Array.isArray(quality.steps) ? quality.steps.map(asRecord) : [];
  const compatibilitySteps = Array.isArray(compatibility.steps) ? compatibility.steps.map(asRecord) : [];
  if (qualitySteps.some((step) => !step) || compatibilitySteps.some((step) => !step)) {
    failures.push('quality authority and compatibility steps must all be mappings');
    return failures;
  }
  const authority = qualitySteps as Record<string, unknown>[];
  const compat = compatibilitySteps as Record<string, unknown>[];
  const exactRunCount = (steps: Record<string, unknown>[], run: string): number =>
    steps.filter((step) => step.run === run).length;

  const setup24 = authority.filter((step) => step.name === 'Setup Node 24');
  const setup25 = compat.filter((step) => step.name === 'Setup Node 25');
  if (
    setup24.length !== 1
    || setup24[0]?.uses !== 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
    || !collectStringValues(setup24[0]).includes('24.x')
  ) {
    failures.push('quality (24.x) must contain one Setup Node 24 step pinned to 24.x');
  }
  if (
    setup25.length !== 1
    || setup25[0]?.uses !== 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
    || !collectStringValues(setup25[0]).includes('25.x')
  ) {
    failures.push('quality (25.x) must contain one Setup Node 25 step pinned to 25.x');
  }
  for (const run of [
    'npm run coverage:check -- --pool=forks',
    'npm run verify:console-design:live',
    'npm run test:browser',
    'npm run test:browser:motion',
  ]) {
    if (exactRunCount(authority, run) !== 1) failures.push(`quality (24.x) must run exactly once: ${run}`);
  }
  for (const run of [
    'npm ci',
    'npm --prefix console ci',
    'npm test -- --pool=forks',
    'npm --prefix console run build',
  ]) {
    const matchingSteps = compat.filter((step) => step.run === run);
    if (matchingSteps.length !== 1) {
      failures.push(`quality (25.x) must run exactly once: ${run}`);
    } else {
      const matchingStep = matchingSteps[0]!;
      if (hasOwn(matchingStep, 'if') || hasOwn(matchingStep, 'continue-on-error')) {
        failures.push(`quality (25.x) required step must be unconditional and blocking: ${run}`);
      }
    }
  }
  const compatibilityText = collectStringValues(compatibility).join('\n');
  for (const forbidden of [
    'coverage:check',
    'guard:',
    'playwright',
    'setup-python',
    'test-integrity',
    'ci-disk-reclaim',
  ]) {
    if (compatibilityText.toLowerCase().includes(forbidden)) {
      failures.push(`quality (25.x) must not duplicate ${forbidden}`);
    }
  }

  if (exactRunCount(authority, 'bash scripts/ci-disk-reclaim.sh') !== 1) {
    failures.push('quality (24.x) must run the measured CI disk-budget helper exactly once');
  }
  if (text.includes('docker image prune --all --force || true') || text.includes('sudo rm -rf /usr/share/dotnet')) {
    failures.push('quality workflow must not retain masked unconditional disk cleanup');
  }

  const integritySteps = authority.filter((step) => step.name === 'Install test-integrity plugin');
  const integrity = integritySteps[0];
  if (integritySteps.length !== 1 || !integrity) {
    failures.push('quality (24.x) must install Test Integrity exactly once');
  } else {
    const env = asRecord(integrity.env);
    const pin = env?.TEST_INTEGRITY_COMMIT;
    if (pin !== 'ea0b01a4e3d99dc58a9a475c57e22ee204b04a7c') {
      failures.push('Test Integrity commit pin must match the reviewed 40-hex object');
    }
    const run = typeof integrity.run === 'string' ? integrity.run : '';
    for (const required of [
      'mkdir -p "$plugin_dir" "$HOME/.ssh"',
      'fetch --depth 1 origin "$TEST_INTEGRITY_COMMIT"',
      'switch --detach FETCH_HEAD',
      'observed_commit="$(git -C "$plugin_dir" rev-parse HEAD)"',
      'if [ "$observed_commit" != "$TEST_INTEGRITY_COMMIT" ]; then',
    ]) {
      if (!run.includes(required)) failures.push(`Test Integrity install is missing ${required}`);
    }
    if (/\bgit\b[^\n]*\b(?:push|clone)\b/.test(run)) {
      failures.push('Test Integrity install must not use floating clone or any push command');
    }
  }
  return failures;
}

function qualityCiPlaywrightTimeoutFailures(text: string): string[] {
  const { root, failures: parseFailures } = parseWorkflow(text, 'quality workflow');
  if (!root) return parseFailures;
  const jobs = asRecord(root?.jobs);
  const quality = asRecord(jobs?.quality);
  if (!quality) return ['workflow must declare jobs.quality as a mapping'];

  const failures: string[] = [];
  if (hasOwn(root, 'defaults')) failures.push('quality workflow must not declare defaults');
  if (hasOwn(root, 'env')) failures.push('quality workflow must not declare env');
  if (quality['timeout-minutes'] !== 60) {
    failures.push('quality job timeout must be exactly 60 minutes');
  }
  if (hasOwn(quality, 'continue-on-error') && quality['continue-on-error'] !== false) {
    failures.push('quality job continue-on-error must be absent or false');
  }
  if (hasOwn(quality, 'if')) {
    failures.push('quality job must not declare if');
  }
  if (hasOwn(quality, 'needs')) failures.push('quality job must not declare needs');
  if (hasOwn(quality, 'defaults')) failures.push('quality job must not declare defaults');
  if (hasOwn(quality, 'env')) failures.push('quality job must not declare env');

  if (!Array.isArray(quality.steps)) {
    failures.push('quality job must declare steps as an array');
    return failures;
  }
  const steps = quality.steps.map(asRecord);
  if (steps.some((step) => step === null)) {
    failures.push('every quality-job step must be a mapping');
    return failures;
  }
  const stepRecords = steps as Record<string, unknown>[];
  const installCommand = 'npx playwright install-deps chromium';
  const targetSteps = stepRecords.filter((step) => step.run === installCommand);
  if (targetSteps.length !== 1) {
    failures.push(
      `quality job must contain exactly one Playwright system-dependency install command (found ${targetSteps.length})`,
    );
  }

  const target = targetSteps[0];
  if (!target) return failures;
  if (target.name !== 'Install Playwright system deps') {
    failures.push('Playwright system-dependency step must keep its canonical name');
  }
  if (target['timeout-minutes'] !== 5) {
    failures.push('Playwright system-dependency step timeout must be exactly 5 minutes');
  }
  if (hasOwn(target, 'continue-on-error') && target['continue-on-error'] !== false) {
    failures.push('Playwright system-dependency step continue-on-error must be absent or false');
  }
  if (hasOwn(target, 'if')) {
    failures.push('Playwright system-dependency step must not declare if');
  }
  failures.push(...runControlFailures(target, 'Playwright system-dependency step'));

  const browserInstallSteps = stepRecords.filter((step) => step.name === 'Install Playwright chromium');
  if (browserInstallSteps.length !== 1) {
    failures.push(`quality job must contain exactly one Playwright chromium install step (found ${browserInstallSteps.length})`);
  }
  const browserInstall = browserInstallSteps[0];
  if (browserInstall) {
    if (browserInstall.run !== QUALITY_CI_BROWSER_INSTALL_SCRIPT) {
      failures.push('Playwright chromium install step must use the exact bounded retry script');
    }
    if (hasOwn(browserInstall, 'if')) {
      failures.push('Playwright chromium install step must not declare if');
    }
    if (hasOwn(browserInstall, 'continue-on-error') && browserInstall['continue-on-error'] !== false) {
      failures.push('Playwright chromium install step continue-on-error must be absent or false');
    }
    failures.push(...runControlFailures(browserInstall, 'Playwright chromium install step'));
  }

  const unexpectedInstallConfiguration = stepRecords.some((step) => {
    if (step === target) return false;
    return collectStringValues(step).some((value) => {
      const compact = value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (step === browserInstall) {
        return compact.includes('playwrightinstall-deps') || compact.includes('--with-deps');
      }
      return compact.includes('playwrightinstall') || compact.includes('--with-deps');
    });
  });
  if (unexpectedInstallConfiguration) {
    failures.push('quality job must not run Playwright system-dependency installation outside the bounded step');
  }
  return failures;
}

function conditionalRunFailures(text: string, runs: string[], requiredJobId?: string): string[] {
  if (runs.length === 0) return [];
  const { root, failures: parseFailures } = parseWorkflow(text, 'workflow');
  if (!root) return parseFailures;
  const jobs = asRecord(root.jobs);
  if (!jobs) return ['workflow must declare jobs as a mapping'];

  const failures = new Set<string>();
  if (hasOwn(root, 'defaults')) failures.add('workflow must not declare defaults');
  if (hasOwn(root, 'env')) failures.add('workflow must not declare env');
  const jobEntries = requiredJobId
    ? [[requiredJobId, jobs[requiredJobId]] as const]
    : Object.entries(jobs);
  if (requiredJobId && !asRecord(jobs[requiredJobId])) {
    failures.add(`workflow must declare jobs.${requiredJobId} as a mapping`);
  }

  const candidates: Array<{
    jobId: string;
    job: Record<string, unknown>;
    step: Record<string, unknown>;
    run: string;
  }> = [];
  for (const [jobId, jobValue] of jobEntries) {
    const job = asRecord(jobValue);
    if (!job || !Array.isArray(job.steps)) continue;
    if (hasOwn(job, 'needs')) failures.add(`workflow job ${jobId} must not declare needs`);
    if (hasOwn(job, 'defaults')) failures.add(`workflow job ${jobId} must not declare defaults`);
    if (hasOwn(job, 'env')) failures.add(`workflow job ${jobId} must not declare env`);
    for (const stepValue of job.steps) {
      const step = asRecord(stepValue);
      if (step && typeof step.run === 'string') candidates.push({ jobId, job, step, run: step.run });
    }
  }

  const renderValue = (value: unknown): string =>
    typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  for (const requiredRun of runs) {
    const exact = requiredRun.startsWith('run: ');
    const command = exact ? requiredRun.slice('run: '.length) : requiredRun;
    const matches = candidates.filter((candidate) =>
      exact ? candidate.run === command : candidate.run.includes(command));
    if (matches.length !== 1) {
      failures.add(`workflow must contain exactly one ${requiredRun} step (found ${matches.length})`);
    }
    for (const { jobId, job, step } of matches) {
      if (hasOwn(step, 'if')) {
        failures.add(`conditional ${requiredRun} (if: ${renderValue(step.if)})`);
      }
      if (hasOwn(step, 'continue-on-error') && step['continue-on-error'] !== false) {
        failures.add(
          `advisory ${requiredRun} (continue-on-error: ${renderValue(step['continue-on-error'])})`,
        );
      }
      for (const failure of runControlFailures(step, requiredRun)) failures.add(failure);
      if (hasOwn(job, 'if')) {
        failures.add(`conditional job ${jobId} for ${requiredRun} (if: ${renderValue(job.if)})`);
      }
      if (hasOwn(job, 'continue-on-error') && job['continue-on-error'] !== false) {
        failures.add(
          `advisory job ${jobId} for ${requiredRun} (continue-on-error: ${renderValue(job['continue-on-error'])})`,
        );
      }
    }
  }
  return [...failures];
}

function checkAnchors(cwd: string, requirement: AnchorRequirement): DiagnosticCheck {
  const text = readText(cwd, requirement.file);
  if (text === null) {
    return {
      id: requirement.id,
      category: requirement.category,
      status: 'fail',
      message: `${requirement.file} is missing.`,
      evidence: [requirement.file],
      remediation: requirement.remediation,
    };
  }

  const missing = requirement.anchors.filter((anchor) => !text.includes(anchor));
  const conditionalRuns = conditionalRunFailures(
    text,
    requirement.requiredUnconditionalRuns ?? [],
    requirement.requiredWorkflowJob,
  );
  const validationFailures = requirement.validate?.(text) ?? [];
  const failures = [...new Set([
    ...missing,
    ...conditionalRuns,
    ...validationFailures,
  ])];
  return {
    id: requirement.id,
    category: requirement.category,
    status: failures.length === 0 ? 'pass' : 'fail',
    message: failures.length === 0
      ? `${requirement.file} satisfies required safeguard checks.`
      : `${requirement.file} has ${failures.length} safeguard failure(s).`,
    evidence: failures.length === 0 ? requirement.anchors : failures,
    remediation: requirement.remediation,
  };
}

function portableArtifactChecks(gitContext: GitContext): DiagnosticCheck[] {
  return [
    {
      id: 'no-tracked-generated-artifacts',
      category: 'portability',
      status: gitContext.trackedGeneratedArtifacts.length === 0 ? 'pass' : 'fail',
      message: gitContext.trackedGeneratedArtifacts.length === 0
        ? 'Generated local artifacts are not tracked.'
        : 'Generated local artifacts are tracked.',
      evidence: gitContext.trackedGeneratedArtifacts.length === 0
        ? ['.codex-artifacts/', 'coverage-target/', '.codex-backups/']
        : gitContext.trackedGeneratedArtifacts,
      remediation: 'Remove generated local artifacts from tracked commits; keep them as local evidence snapshots.',
    },
    {
      id: 'no-tracked-instance-health-profiles',
      category: 'portability',
      status: gitContext.trackedInstanceProfiles.length === 0 ? 'pass' : 'fail',
      message: gitContext.trackedInstanceProfiles.length === 0
        ? 'Tracked instance health profiles are sanitized.'
        : 'Tracked instance health profiles contain unsafe credential material, paths, or legacy credential requirements.',
      evidence: gitContext.trackedInstanceProfiles.length === 0
        ? ['deploy/health-profiles/*.json contain only sanitized fleet metadata and relative credential requirements.']
        : gitContext.trackedInstanceProfiles,
      remediation: 'Remove inline secrets, absolute/private credential paths, and legacy root fleet-token requirements from tracked health profiles.',
    },
  ];
}

function repoStateChecks(gitContext: GitContext): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  if (!gitContext.upstream) {
    checks.push({
      id: 'git-upstream-visible',
      category: 'repo-state',
      status: 'warn',
      message: 'No upstream is configured for this branch.',
      evidence: [gitContext.branch ?? 'detached'],
      remediation: 'Set an upstream before relying on ahead/behind diagnostics.',
    });
  } else {
    checks.push({
      id: 'git-upstream-visible',
      category: 'repo-state',
      status: 'pass',
      message: 'Branch upstream is visible.',
      evidence: [`${gitContext.branch ?? 'detached'} -> ${gitContext.upstream}`],
    });
  }

  checks.push({
    id: 'git-working-tree-readout',
    category: 'repo-state',
    status: gitContext.dirtyFiles === 0 ? 'pass' : 'warn',
    message: gitContext.dirtyFiles === 0
      ? 'Working tree is clean.'
      : `Working tree has ${gitContext.dirtyFiles ?? 'unknown'} changed path(s).`,
    evidence: [
      `branch=${gitContext.branch ?? 'unknown'}`,
      `head=${gitContext.head ?? 'unknown'}`,
      `ahead=${gitContext.ahead ?? 'unknown'}`,
      `behind=${gitContext.behind ?? 'unknown'}`,
    ],
    remediation: 'Commit, stash, or intentionally preserve WIP before release claims.',
  });

  return checks;
}

function summarize(checks: DiagnosticCheck[]): Record<DiagnosticStatus, number> {
  return {
    pass: checks.filter((check) => check.status === 'pass').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
  };
}

export function checkSafeguards(cwd = process.cwd(), strict = false): SafeguardDiagnosticsReport {
  const scripts = loadPackageScripts(cwd);
  const consoleScripts = loadPackageScripts(cwd, 'console/package.json');
  const gitContext = collectGitContext(cwd);
  const checks = [
    checkScriptPresence(scripts),
    checkConsoleDesignScriptCoverage(scripts, consoleScripts),
    ...CHAIN_REQUIREMENTS.map((requirement) => checkChainRequirement(scripts, requirement)),
    ...ANCHOR_REQUIREMENTS.map((requirement) => checkAnchors(cwd, requirement)),
    ...portableArtifactChecks(gitContext),
    ...repoStateChecks(gitContext),
  ];
  const summary = summarize(checks);
  return {
    ok: summary.fail === 0 && (!strict || summary.warn === 0),
    strict,
    cwd,
    git: gitContext,
    summary,
    checks,
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { json: false, strict: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: npm run guard:safeguard-diagnostics -- [--json] [--strict]

Deterministically maps the repo's safeguard surface: guard-chain wiring,
secret/publication protections, runtime-boundary anchors, public-exposure guards,
portable artifact invariants, and current git readout.

Default mode fails only on missing safeguards. --strict also fails on repo-state warnings.`);
}

export function formatReport(report: SafeguardDiagnosticsReport): string {
  const lines = [
    `safeguard diagnostics: ${report.ok ? 'PASS' : 'FAIL'}`,
    `cwd: ${report.cwd}`,
    `git: branch=${report.git.branch ?? 'unknown'} head=${report.git.head ?? 'unknown'} upstream=${report.git.upstream ?? 'none'} ahead=${report.git.ahead ?? 'unknown'} behind=${report.git.behind ?? 'unknown'} dirty=${report.git.dirtyFiles ?? 'unknown'}`,
    `summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} strict=${report.strict}`,
    'checks:',
  ];

  for (const check of report.checks) {
    lines.push(`  ${check.status.toUpperCase()} ${check.category}/${check.id}: ${check.message}`);
    for (const evidence of check.evidence.slice(0, 8)) lines.push(`    - ${evidence}`);
    if (check.evidence.length > 8) lines.push(`    - ... ${check.evidence.length - 8} more`);
    if (check.status !== 'pass' && check.remediation) lines.push(`    remediation: ${check.remediation}`);
  }

  return `${lines.join('\n')}\n`;
}

export function run(argv: string[] = process.argv.slice(2), cwd = process.cwd()): SafeguardDiagnosticsReport {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return checkSafeguards(cwd, args.strict);
  }

  const report = checkSafeguards(cwd, args.strict);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
