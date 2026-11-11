#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { git as runGit, gitList as runGitList, readText } from './lib/guard-core.ts';
import { asRecord } from '../src/lib/type-guards.ts';
import { BRANCH_STEPS, NEUTRALIZED_SKIP_VARS, RELEASE_STEPS } from './push-gate.ts';
import type { GateStep } from './push-gate.ts';

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
      'unset WHATSOUP_SKIP_DOC_DRIFT WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT WHATSOUP_SKIP_NODE_PIN_CHECK WHATSOUP_SKIP_BOUNDARY_CHECK WHATSOUP_SKIP_ESLINT_FITNESS',
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
      'bash scripts/run-with-pinned-npm.sh --prefix console run build',
      'npm run verify:console-design:live',
      'npm run coverage:check -- --pool=forks',
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
      'npm run coverage:check -- --pool=forks',
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
      'Restore the exact quality (24.x) authority job, quality (25.x) compatibility job, direct v* trigger, and measured disk-budget step.',
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
    requiredWorkflowJob: 'full',
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
    anchors: [],
    validate: tagReleaseDelegationFailures,
    remediation: 'Consume every direct-tag Quality completion and let the authenticated receipt consumer fail closed.',
  },
  {
    id: 'private-test-integrity-trusted-receipt',
    category: 'secret-surface',
    file: '.github/workflows/private-test-integrity.yml',
    anchors: [],
    validate: privateTestIntegrityFailures,
    remediation: 'Keep private credentials and scanner execution in the trusted workflow_run receipt producer.',
  },
  {
    id: 'whatsoup-guard-node25-compatibility',
    category: 'guard-chain',
    file: '.github/workflows/whatsoup-guard.yml',
    anchors: [],
    validate: whatsoupGuardNode25CompatibilityFailures,
    remediation: 'Keep the standalone Node 25 Whatsoup guard compatibility lane; Quality owns the redundant Node 24 work.',
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

/**
 * Chain source resolution (#2224). Gate composition lives in the declarative
 * manifest (scripts/push-gate.ts); verify:push:branch/verify:release in
 * package.json are thin entry points into it. The manifest chain view
 * prepends a synthetic `unset` line DERIVED from NEUTRALIZED_SKIP_VARS, so
 * the release-chain requirement keeps validating the skip-neutralization —
 * if a var is dropped from the manifest, the synthetic line diverges from
 * the requirement's expected text and the check fails. A package.json value
 * that is NOT the one-line entry point (fixture repos, stale checkouts) is
 * treated as a legacy-format chain and used directly.
 */
const MANIFEST_ENTRY_POINT_RE = /^bash scripts\/run-with-pinned-node\.sh scripts\/push-gate\.ts (?:branch|release)\s*$/;

function manifestChainView(scriptName: string): string | null {
  const steps: readonly GateStep[] | null =
    scriptName === 'verify:push:branch'
      ? BRANCH_STEPS
      : scriptName === 'verify:release'
        ? RELEASE_STEPS
        : null;
  if (!steps) return null;
  return [`unset ${NEUTRALIZED_SKIP_VARS.join(' ')}`, ...steps.map((step) => step.cmd)].join(' && ');
}

function resolveChainSource(scriptName: string, scripts: Record<string, string>): string | undefined {
  const fromPackage = scripts[scriptName];
  if (fromPackage && !MANIFEST_ENTRY_POINT_RE.test(fromPackage.trim())) {
    return fromPackage;
  }
  return manifestChainView(scriptName) ?? fromPackage;
}

function chainRemediation(scriptName: string): string {
  return scriptName === 'verify:push:branch' || scriptName === 'verify:release'
    ? `Restore the intended ${scriptName} guard order in scripts/push-gate.ts (${scriptName === 'verify:push:branch' ? 'BRANCH_STEPS' : 'RELEASE_STEPS'}).`
    : `Restore the intended ${scriptName} guard order in package.json.`;
}

function checkChainRequirement(scripts: Record<string, string>, requirement: ChainRequirement): DiagnosticCheck {
  const chain = resolveChainSource(requirement.scriptName, scripts);
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
    remediation: chainRemediation(requirement.scriptName),
  };
}

function consoleDesignScriptSteps(consoleScripts: Record<string, string>): string[] {
  return Object.keys(consoleScripts)
    .filter((scriptName) => scriptName.startsWith('design:'))
    .filter((scriptName) => !CONSOLE_DESIGN_CHAIN_EXEMPTIONS.has(scriptName))
    .sort()
    .map((scriptName) => `npm --prefix console run ${scriptName}`);
}

function consoleDesignChainView(cwd: string, scripts: Record<string, string>, consoleScripts: Record<string, string>): Record<string, string> {
  const chain = scripts['verify:console-design:live'];
  const combined = 'npm --prefix console run lint:shadow:baseline -- --with-inventories';
  if (!chain?.split(/\s+&&\s+/).includes(combined)) return scripts;
  const source = readText(cwd, 'console/scripts/check-shadow-baseline.mjs') ?? '';
  const consumers = ['shadow-frozen', 'raw-form-control'];
  const connected = consoleScripts['lint:shadow:baseline'] === 'node scripts/check-shadow-baseline.mjs'
    && consumers.every((name) => consoleScripts[`design:${name}-inventory`] === `node scripts/check-${name}-inventory.mjs`
      && source.includes(`'check-${name}-inventory.mjs'`))
    && ['if (withInventories)', 'spawnSync(process.execPath', "'--eslint-json', report", 'result.status !== 0'].every((anchor) => source.includes(anchor));
  if (!connected) return scripts;
  // Expand the verified shared consumer for the existing order/coverage checks.
  return {
    ...scripts,
    'verify:console-design:live': chain.replace(combined, [
      'npm --prefix console run lint:shadow:baseline',
      ...consumers.map((name) => `npm --prefix console run design:${name}-inventory`),
    ].join(' && ')),
  };
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

function runControlFailures(
  step: Record<string, unknown>,
  label: string,
  allowed: readonly string[] = [],
): string[] {
  return ['shell', 'env', 'working-directory', 'background']
    .filter((key) => !allowed.includes(key) && hasOwn(step, key))
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
  const full = asRecord(jobs?.full);
  if (!full || !Array.isArray(full.steps)) {
    failures.push('workflow must declare jobs.full.steps as an array');
    return failures;
  }
  const steps = full.steps.map(asRecord);
  if (steps.some((step) => !step)) {
    failures.push('every quality-job step must be a mapping');
    return failures;
  }
  const stepRecords = steps as Record<string, unknown>[];
  const semanticSteps = stepRecords.filter((step) => step.name === 'Semantic quality (shadow)');
  if (semanticSteps.length !== 1) {
    failures.push(`full job must contain exactly one Semantic quality (shadow) step (found ${semanticSteps.length})`);
    return failures;
  }
  const semantic = semanticSteps[0]!;
  const semanticIndex = stepRecords.indexOf(semantic);
  const suiteIndex = stepRecords.findIndex((step) => step.name === 'Test suite + coverage thresholds');
  if (suiteIndex < 0 || semanticIndex > suiteIndex) {
    failures.push('Semantic quality (shadow) must run before Test suite + coverage thresholds');
  }
  if (hasOwn(semantic, 'if')) {
    failures.push('Semantic quality (shadow) must be unconditional inside the full Node 24 job');
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
    '>> "$GITHUB_STEP_SUMMARY"',
  ]) {
    if (!run.includes(required)) failures.push(`Semantic quality (shadow) run script is missing ${required}`);
  }
  if (!run.includes('r.decision') && !run.includes('receipt.decision')) {
    failures.push('Semantic quality (shadow) run script is missing a receipt decision summary');
  }
  if (!run.includes('r.findings.length') && !run.includes('receipt.findings.length')) {
    failures.push('Semantic quality (shadow) run script is missing a receipt finding count');
  }

  const uploadsSemanticReceipt = stepRecords.some((step) => (
    typeof step.uses === 'string'
    && step.uses.includes('actions/upload-artifact')
    && collectStringValues(step).some((value) => value.includes('semantic-quality'))
  ));
  if (uploadsSemanticReceipt) failures.push('semantic quality receipts must not be uploaded as artifacts');
  return failures;
}

function tagReleaseDelegationFailures(text: string): string[] {
  const { root, failures: parseFailures } = parseWorkflow(text, 'tag release workflow');
  if (!root) return parseFailures;
  const failures: string[] = [];
  const triggers = asRecord(root.on);
  const workflowRun = asRecord(triggers?.workflow_run);
  if (
    !workflowRun
    || !Array.isArray(workflowRun.workflows)
    || workflowRun.workflows.length !== 1
    || workflowRun.workflows[0] !== 'Quality'
    || !Array.isArray(workflowRun.types)
    || workflowRun.types.length !== 1
    || workflowRun.types[0] !== 'completed'
    || hasOwn(triggers ?? {}, 'push')
  ) {
    failures.push('tag release gate must consume completed Quality workflow runs');
  }
  const concurrency = asRecord(root.concurrency);
  if (
    concurrency?.group !== 'tag-release-${{ github.event.workflow_run.head_branch }}'
    || concurrency['cancel-in-progress'] !== false
  ) {
    failures.push('tag release gate must preserve per-tag non-cancelling concurrency');
  }
  const permissions = asRecord(root.permissions);
  if (
    !permissions
    || permissions.contents !== 'read'
    || permissions.actions !== 'read'
    || Object.keys(permissions).length !== 2
  ) {
    failures.push('tag release gate permissions must be exactly actions: read and contents: read');
  }
  const releaseGate = asRecord(asRecord(root.jobs)?.['release-gate']);
  const condition = typeof releaseGate?.if === 'string' ? releaseGate.if : '';
  for (const required of [
    "github.event.workflow_run.event == 'push'",
    "startsWith(github.event.workflow_run.head_branch, 'v')",
  ]) {
    if (!condition.includes(required)) {
      failures.push(required.includes('head_branch')
          ? 'tag release gate must require a v* Quality source ref'
          : 'tag release gate must require a push Quality source run');
    }
  }
  if (condition.includes("github.event.workflow_run.conclusion == 'success'")) {
    failures.push('tag release gate must not skip failed Quality tag runs');
  }
  if (!releaseGate || releaseGate['runs-on'] !== 'ubuntu-latest' || releaseGate['timeout-minutes'] !== 35) {
    failures.push('tag release gate must retain the bounded public receipt-consumer job');
  }
  if (hasOwn(releaseGate ?? {}, 'uses') || hasOwn(releaseGate ?? {}, 'secrets')) {
    failures.push('tag release gate must not access private scanner credentials');
  }
  const steps = Array.isArray(releaseGate?.steps)
    ? releaseGate.steps.map(asRecord).filter(Boolean) as Record<string, unknown>[]
    : [];
  const checkout = steps.filter((step) => step.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  if (checkout.length !== 1 || asRecord(checkout[0]?.with)?.ref !== '${{ github.sha }}') {
    failures.push('tag release gate must pin checkout to the trusted workflow revision');
  }
  const node = steps.filter((step) => step.uses === 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
  if (node.length !== 1 || asRecord(node[0]?.with)?.['node-version-file'] !== '.nvmrc') {
    failures.push('tag release gate must run the receipt consumer under Node from .nvmrc');
  }
  const select = steps.filter((step) => step.id === 'select');
  if (select.length !== 1 || select[0]?.run !== 'node scripts/private-integrity-release.ts select') {
    failures.push('tag release gate must select the authenticated private receipt');
  }
  const selectEnv = asRecord(select[0]?.env);
  if (
    !selectEnv
    || selectEnv.QUALITY_RUN_ID !== '${{ github.event.workflow_run.id }}'
    || selectEnv.QUALITY_RUN_ATTEMPT !== '${{ github.event.workflow_run.run_attempt }}'
    || selectEnv.QUALITY_HEAD_SHA !== '${{ github.event.workflow_run.head_sha }}'
    || selectEnv.GH_TOKEN !== '${{ github.token }}'
    || Object.keys(selectEnv).length !== 4
  ) failures.push('tag release gate must bind receipt selection to the exact Quality attempt');
  const downloads = steps.filter((step) => step.uses === 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093');
  const downloadWith = asRecord(downloads[0]?.with);
  if (
    downloads.length !== 1
    || downloadWith?.['artifact-ids'] !== '${{ steps.select.outputs.artifact-id }}'
    || downloadWith?.['run-id'] !== '${{ steps.select.outputs.scanner-run-id }}'
    || downloadWith?.path !== '${{ runner.temp }}/private-integrity'
    || downloadWith?.['github-token'] !== '${{ github.token }}'
    || downloadWith?.['merge-multiple'] !== true
  ) failures.push('tag release gate must download only the authenticated scanner artifact');
  const verify = steps.filter((step) => step.name === 'Verify private integrity receipt');
  if (
    verify.length !== 1
    || verify[0]?.run !== 'node scripts/private-integrity-release.ts verify --receipt "$RUNNER_TEMP/private-integrity/receipt.json"'
    || asRecord(verify[0]?.env)?.SCANNER_ARTIFACT_ID !== '${{ steps.select.outputs.artifact-id }}'
    || asRecord(verify[0]?.env)?.SCANNER_RUN_ID !== '${{ steps.select.outputs.scanner-run-id }}'
  ) failures.push('tag release gate must verify the exact downloaded private receipt');
  return failures;
}

export function privateTestIntegrityFailures(text: string): string[] {
  const { root, failures: parseFailures } = parseWorkflow(text, 'private test integrity workflow');
  if (!root) return parseFailures;
  const failures: string[] = [];
  const workflowRun = asRecord(asRecord(root.on)?.workflow_run);
  if (
    !workflowRun
    || !Array.isArray(workflowRun.workflows)
    || workflowRun.workflows.length !== 1
    || workflowRun.workflows[0] !== 'Quality'
    || !Array.isArray(workflowRun.types)
    || workflowRun.types.length !== 1
    || workflowRun.types[0] !== 'completed'
  ) failures.push('private test integrity must trigger only from completed Quality workflow runs');
  const scanner = asRecord(asRecord(root.jobs)?.['private-scanner']);
  const condition = typeof scanner?.if === 'string' ? scanner.if : '';
  for (const required of [
    "github.repository == 'LucasQuiles/WhatSoup'",
    "github.event.workflow_run.status == 'completed'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
    "github.event.workflow_run.event == 'pull_request'",
    "github.event.workflow_run.head_branch == 'main'",
    "startsWith(github.event.workflow_run.head_branch, 'v')",
    "github.event.workflow_run.event == 'schedule'",
  ]) {
    if (!condition.includes(required)) {
      failures.push(required.includes("'v'")
        ? 'private test integrity must admit successful same-repository v* Quality pushes'
        : 'private test integrity must retain its trusted source admission predicate');
    }
  }
  if (scanner?.['runs-on'] !== 'ubuntu-24.04' || scanner.environment !== 'private-scanner-trusted') {
    failures.push('private test integrity must remain an environment-protected trusted runner');
  }
  const steps = Array.isArray(scanner?.steps)
    ? scanner.steps.map(asRecord).filter(Boolean) as Record<string, unknown>[]
    : [];
  const scan = steps.filter((step) => step.name === 'Qualify runtime and scan exact pull request data');
  if (scan.length !== 1) {
    failures.push('private test integrity must run one trusted scanner step');
    return failures;
  }
  if (hasOwn(scan[0]!, 'continue-on-error')) {
    failures.push('private test integrity scanner must not mask its terminal result');
  }
  const scanEnv = asRecord(scan[0]?.env);
  if (
    !scanEnv
    || scanEnv.QUALITY_RUN_ID !== '${{ github.event.workflow_run.id }}'
    || scanEnv.QUALITY_EVENT !== '${{ github.event.workflow_run.event }}'
    || scanEnv.QUALITY_RUN_ATTEMPT !== '${{ github.event.workflow_run.run_attempt }}'
    || scanEnv.QUALITY_HEAD_SHA !== '${{ github.event.workflow_run.head_sha }}'
    || scanEnv.GITHUB_RUN_ID !== '${{ github.run_id }}'
    || scanEnv.GITHUB_RUN_ATTEMPT !== '${{ github.run_attempt }}'
    || scanEnv.GITHUB_TOKEN !== '${{ github.token }}'
  ) failures.push('private test integrity must bind the scanner to exact source and producer attempts');
  const scanRun = typeof scan[0]?.run === 'string' ? scan[0].run : '';
  for (const required of [
    'GITHUB_TOKEN="$GITHUB_TOKEN"',
    'QUALITY_RUN_ID="$QUALITY_RUN_ID"',
    'QUALITY_EVENT="$QUALITY_EVENT"',
    'QUALITY_RUN_ATTEMPT="$QUALITY_RUN_ATTEMPT"',
    'QUALITY_HEAD_SHA="$QUALITY_HEAD_SHA"',
    'GITHUB_RUN_ID="$GITHUB_RUN_ID"',
    'GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT"',
  ]) {
    if (!scanRun.includes(required)) {
      failures.push(required.startsWith('GITHUB_TOKEN')
        ? 'private test integrity must pass the GitHub token to the isolated driver'
        : 'private test integrity must pass the trusted scanner run identity to the isolated driver');
    }
  }
  if (
    !scanRun.includes('RECEIPT_PATH="$SCANNER_ROOT/receipt.json"')
    || !scanRun.includes('receipt_args=(--receipt "$RECEIPT_PATH")')
    || !scanRun.includes('test -s "$RECEIPT_PATH"')
    || !scanRun.includes('mv -- "$RECEIPT_PATH" "$RUNNER_TEMP/private-integrity/receipt.json"')
    || !scanRun.includes('scanner-exit=')
    || (scanRun.match(/if \[\[ "\$QUALITY_EVENT" != 'pull_request' \]\]; then/g)?.length ?? 0) !== 2
  ) {
    failures.push('private test integrity must produce a receipt only for non-PR sources');
  }
  const cleanupIndex = steps.findIndex((step) => step.name === 'Remove owned scanner scratch');
  const cleanup = steps[cleanupIndex];
  const uploads = steps.filter((step) => step.name === 'Upload private integrity receipt');
  const uploadIndex = steps.findIndex((step) => step.name === 'Upload private integrity receipt');
  const uploadWith = asRecord(uploads[0]?.with);
  if (
    uploads.length !== 1
    || cleanupIndex < 0
    || uploadIndex <= cleanupIndex
    || cleanup?.id !== 'cleanup'
    || uploads[0]?.if !== "always() && github.event.workflow_run.event != 'pull_request' && steps.cleanup.outcome == 'success'"
    || uploads[0]?.uses !== 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
    || uploadWith?.name !== 'private-integrity-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}'
    || uploadWith?.path !== '${{ runner.temp }}/private-integrity/receipt.json'
    || uploadWith?.['if-no-files-found'] !== 'error'
    || uploadWith?.overwrite !== true
    || uploadWith?.['retention-days'] !== 30
  ) failures.push('private test integrity must upload only the receipt after scanner scratch cleanup');
  const terminal = steps.filter((step) => step.name === 'Enforce private scanner conclusion');
  if (
    terminal.length !== 1
    || terminal[0]?.if !== 'always()'
    || String(terminal[0]?.run).trim() !== 'case "$SCANNER_EXIT" in\n  0|1|2) exit "$SCANNER_EXIT" ;;\n  *) exit 2 ;;\nesac'
    || asRecord(terminal[0]?.env)?.SCANNER_EXIT !== '${{ steps.scan.outputs.scanner-exit }}'
    || hasOwn(terminal[0]!, 'continue-on-error')
  ) failures.push('private test integrity must return the scanner result after receipt publication');
  return failures;
}

function whatsoupGuardNode25CompatibilityFailures(text: string): string[] {
  const { root, failures: parseFailures } = parseWorkflow(text, 'whatsoup guard workflow');
  if (!root) return parseFailures;
  const failures: string[] = [];
  const triggers = asRecord(root.on);
  if (!triggers || Object.keys(triggers).length !== 1 || !hasOwn(triggers, 'workflow_call') || hasOwn(root, 'concurrency')) {
    failures.push('whatsoup guard workflow must be callable only through Quality without separate concurrency');
  }
  const test = asRecord(asRecord(root.jobs)?.test);
  const matrix = asRecord(asRecord(test?.strategy)?.matrix);
  const nodes = matrix?.node;
  if (!Array.isArray(nodes) || nodes.length !== 1 || nodes[0] !== '25.x') {
    failures.push('whatsoup guard workflow must retain exactly the Node 25 compatibility lane');
  }
  const steps = Array.isArray(test?.steps)
    ? test.steps.map(asRecord).filter(Boolean) as Record<string, unknown>[]
    : [];
  const setup = steps.filter((step) => step.uses === 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
  if (setup.length !== 1 || asRecord(setup[0]?.with)?.['node-version'] !== '${{ matrix.node }}') {
    failures.push('whatsoup guard workflow must select its setup Node from the retained matrix lane');
  }
  const commands = ['npm ci', 'npm run typecheck', 'npm test'];
  const runSteps = steps.filter((step) => hasOwn(step, 'run'));
  if (
    !test || hasOwn(test, 'if') || hasOwn(test, 'continue-on-error')
    || asRecord(asRecord(test.defaults)?.run)?.['working-directory'] !== 'tools/whatsoup_guard'
    || runSteps.length !== commands.length
    || commands.some((command, index) => runSteps[index]?.run !== command)
    || steps.some((step) => hasOwn(step, 'if') || hasOwn(step, 'continue-on-error'))
    || runSteps.some((step) => runControlFailures(step, 'guard validation').length > 0)
  ) {
    failures.push('whatsoup guard validation must run npm ci, typecheck and tests unconditionally and block on failure');
  }
  return failures;
}

function qualityCiLanePartitionFailures(text: string): string[] {
  const { root, failures: parseFailures } = parseWorkflow(text, 'quality workflow');
  if (!root) return parseFailures;
  const failures: string[] = [];
  const triggers = asRecord(root.on);
  if (!triggers || !hasOwn(triggers, 'merge_group')) {
    failures.push('quality workflow must declare the merge_group trigger');
  }
  const jobs = asRecord(root.jobs);
  const quality = asRecord(jobs?.quality);
  const compatibility = asRecord(jobs?.compatibility);
  const docs = asRecord(jobs?.docs);
  const affected = asRecord(jobs?.affected);
  const compatibilityAffected = asRecord(jobs?.['compatibility-affected']);
  const full = asRecord(jobs?.full);
  const compatibilityFull = asRecord(jobs?.['compatibility-full']);
  const guardCompatibility = asRecord(jobs?.['guard-compatibility']);
  if (!quality || !compatibility || !docs || !affected || !compatibilityAffected || !full || !compatibilityFull) {
    return ['quality workflow must declare stable aggregators and every selected-profile validation job'];
  }
  const directTags = asRecord(triggers?.push)?.tags;
  if (!Array.isArray(directTags) || directTags.length !== 1 || directTags[0] !== 'v*') {
    failures.push('quality workflow must trigger directly on v* tags');
  }
  if (hasOwn(triggers ?? {}, 'workflow_call')) {
    failures.push('quality workflow must not expose a reusable workflow entrypoint');
  }
  if (text.includes('TEST_INTEGRITY_DEPLOY_KEY') || text.includes('LucasQuiles/test-integrity.git')) {
    failures.push('quality workflow must not access private Test Integrity credentials');
  }
  if (quality.name !== 'quality (24.x)') failures.push('jobs.quality name must be exactly quality (24.x)');
  if (compatibility.name !== 'quality (25.x)') {
    failures.push('jobs.compatibility name must be exactly quality (25.x)');
  }
  if (hasOwn(full, 'strategy') || hasOwn(compatibilityFull, 'strategy')) {
    failures.push('full validation workers must not use a matrix strategy');
  }
  if (full.name !== 'Quality full (24.x)' || full['timeout-minutes'] !== 60) {
    failures.push('full Node 24 worker must retain its 60-minute authority contract');
  }
  if (compatibilityFull.name !== 'Quality full (25.x)' || compatibilityFull['timeout-minutes'] !== 40) {
    failures.push('full Node 25 worker must retain its 40-minute compatibility contract');
  }
  if (full['runs-on'] !== 'ubuntu-latest' || compatibilityFull['runs-on'] !== 'ubuntu-latest') {
    failures.push('full validation workers must run on ubuntu-latest');
  }
  if (
    (hasOwn(full, 'continue-on-error') && full['continue-on-error'] !== false)
    || (hasOwn(compatibilityFull, 'continue-on-error') && compatibilityFull['continue-on-error'] !== false)
  ) {
    failures.push('quality (25.x) compatibility job must be blocking');
  }
  const fullGate = "needs.selection.outputs.profile == 'full'";
  const needsSelection = (job: Record<string, unknown>): boolean => Array.isArray(job.needs)
    ? job.needs.length === 1 && job.needs[0] === 'selection'
    : job.needs === 'selection';
  if (full.if !== fullGate || compatibilityFull.if !== fullGate || !needsSelection(full) || !needsSelection(compatibilityFull)) {
    failures.push('full validation workers must be selected only by the full profile after selection');
  }
  const aggregate = (job: Record<string, unknown>, matrix: string, requiredNeeds: string[]): void => {
    if (job.if !== 'always()') failures.push(`quality (${matrix}) aggregator must use if: always()`);
    const jobNeeds = job.needs;
    if (
      !Array.isArray(jobNeeds)
      || jobNeeds.length !== requiredNeeds.length
      || requiredNeeds.some((need) => !jobNeeds.includes(need))
    ) {
      failures.push(`quality (${matrix}) aggregator must depend exactly on every selected validation job`);
    }
    if (hasOwn(job, 'continue-on-error') && job['continue-on-error'] !== false) {
      failures.push(`quality (${matrix}) aggregator must be blocking`);
    }
    const steps = Array.isArray(job.steps) ? job.steps.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
    const checks = steps.filter((step) => typeof step.run === 'string' && step.run.includes('scripts/check-test-jobs.ts'));
    const checkerRun = 'node --experimental-strip-types scripts/check-test-jobs.ts';
    if (checks.length !== 1 || checks[0]?.run !== checkerRun) {
      failures.push(`quality (${matrix}) aggregator must run the exact check-test-jobs command`);
      return;
    }
    const checker = checks[0]!;
    if (hasOwn(checker, 'if') || (hasOwn(checker, 'continue-on-error') && checker['continue-on-error'] !== false)) {
      failures.push(`quality (${matrix}) aggregator checker must be unconditional and blocking`);
    }
    failures.push(...runControlFailures(checker, `quality (${matrix}) aggregator checker`, ['env']));
    const checkerEnv = asRecord(checker.env);
    if (checkerEnv?.TEST_JOB_MATRIX !== matrix) {
      failures.push(`quality (${matrix}) aggregator checker must receive TEST_JOB_MATRIX: ${matrix}`);
    }
    if (checkerEnv?.TEST_PLAN_JSON !== '${{ needs.selection.outputs.plan }}') {
      failures.push(`quality (${matrix}) aggregator checker must receive TEST_PLAN_JSON from selection`);
    }
    if (checkerEnv?.TEST_JOB_RESULTS !== '${{ toJSON(needs) }}') {
      failures.push(`quality (${matrix}) aggregator checker must receive TEST_JOB_RESULTS from needs`);
    }
    if (!checkerEnv || Object.keys(checkerEnv).length !== 3) {
      failures.push(`quality (${matrix}) aggregator checker must expose only authoritative inputs`);
    }
  };
  aggregate(quality, 'node24', ['selection', 'docs', 'affected', 'full', 'bot-errors-health-macos']);
  aggregate(compatibility, 'node25', ['selection', 'docs', 'compatibility-affected', 'compatibility-full', 'guard-compatibility']);
  if (
    !guardCompatibility || !needsSelection(guardCompatibility)
    || guardCompatibility.if !== 'fromJSON(needs.selection.outputs.lanes).guard'
    || guardCompatibility.uses !== './.github/workflows/whatsoup-guard.yml'
    || Object.keys(guardCompatibility).some((key) => !['needs', 'if', 'uses', 'name'].includes(key))
  ) {
    failures.push('guard compatibility must call the local guard workflow after guard selection without overrides');
  }
  if (hasOwn(quality, 'strategy') || hasOwn(compatibility, 'strategy')) {
    failures.push('required-context aggregators must not use a matrix strategy');
  }

  const requireSelectedWorker = (
    id: string,
    job: Record<string, unknown>,
    selectionCondition: string,
    terminalStep: string,
  ): void => {
    if (job.if !== selectionCondition || !needsSelection(job)) {
      failures.push(`${id} validation job must retain its selection condition`);
    }
    if (hasOwn(job, 'continue-on-error') && job['continue-on-error'] !== false) {
      failures.push(`${id} validation job must be blocking`);
    }
    const steps = Array.isArray(job.steps) ? job.steps.map(asRecord) : [];
    const terminals = steps.filter((step) => step?.name === terminalStep);
    if (terminals.length !== 1) {
      failures.push(`${id} validation job must contain exactly one ${terminalStep} step`);
      return;
    }
    const terminal = terminals[0]!;
    if (hasOwn(terminal, 'if') || hasOwn(terminal, 'continue-on-error')) {
      failures.push(`${id} validation terminal step must be unconditional and blocking`);
    }
  };
  requireSelectedWorker('docs', docs, "needs.selection.outputs.profile == 'docs'", 'Documentation drift guard');
  requireSelectedWorker('affected', affected, "needs.selection.outputs.profile == 'affected'", 'Run affected Quality suites');
  requireSelectedWorker(
    'compatibility-affected',
    compatibilityAffected,
    "needs.selection.outputs.profile == 'affected' && fromJSON(needs.selection.outputs.lanes).compatibility",
    'Run affected compatibility root suite',
  );
  requireSelectedWorker('full', full, fullGate, 'Test suite + coverage thresholds');
  requireSelectedWorker('compatibility-full', compatibilityFull, fullGate, 'Full compatibility test suite');

  const affectedSteps = Array.isArray(affected.steps)
    ? affected.steps.map(asRecord).filter(Boolean) as Record<string, unknown>[]
    : [];
  const requireAffectedRootGuard = (name: string, run: string): void => {
    const named = affectedSteps.filter((step) => step.name === name);
    const runCount = affectedSteps.filter((step) => step.run === run).length;
    if (named.length !== 1 || runCount !== 1 || named[0]?.run !== run) {
      failures.push(`affected root lane must run exactly once: ${run}`);
      return;
    }
    const step = named[0]!;
    if (step.if !== 'fromJSON(needs.selection.outputs.lanes).root') {
      failures.push(`affected root guard must be selected by root lane: ${run}`);
    }
    if (hasOwn(step, 'continue-on-error') && step['continue-on-error'] !== false) {
      failures.push(`affected root guard must be blocking: ${run}`);
    }
  };
  requireAffectedRootGuard('Import cycle guard when selected', 'npm run guard:import-cycle');
  requireAffectedRootGuard('Phantom dependency guard when selected', 'npm run guard:phantom-deps');

  const qualitySteps = Array.isArray(full.steps) ? full.steps.map(asRecord) : [];
  const compatibilitySteps = Array.isArray(compatibilityFull.steps) ? compatibilityFull.steps.map(asRecord) : [];
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
    || asRecord(setup24[0]?.with)?.['node-version-file'] !== '.nvmrc'
    || hasOwn(asRecord(setup24[0]?.with) ?? {}, 'node-version')
  ) {
    failures.push('quality (24.x) Setup Node 24 must use node-version-file: .nvmrc');
  }
  if (
    setup25.length !== 1
    || setup25[0]?.uses !== 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
    || !collectStringValues(setup25[0]).includes('25.x')
  ) {
    failures.push('quality (25.x) must contain one Setup Node 25 step pinned to 25.x');
  }

  const requireNamedStep = (
    steps: Record<string, unknown>[],
    name: string,
    lane: string,
    requiredRunFragments: string[],
  ): void => {
    const matches = steps.filter((step) => step.name === name);
    if (matches.length !== 1) {
      failures.push(`${lane} must contain exactly one ${name} step`);
      return;
    }
    const step = matches[0]!;
    if (hasOwn(step, 'if') || hasOwn(step, 'continue-on-error')) {
      failures.push(`${lane} ${name} step must be unconditional and blocking`);
    }
    const run = typeof step.run === 'string' ? step.run : '';
    for (const fragment of requiredRunFragments) {
      if (!run.includes(fragment)) failures.push(`${lane} ${name} step is missing ${fragment}`);
    }
  };

  requireNamedStep(authority, 'Host dependency profile (strict)', 'quality (24.x)', [
    'bash deploy/scripts/install-host-dependencies.sh --profile quality --apply --yes --json',
    '$RUNNER_TEMP/whatsoup-doctor-quality.json',
    '>> "$GITHUB_PATH"',
  ]);
  requireNamedStep(authority, 'Validate strict doctor receipt', 'quality (24.x)', [
    'set -o pipefail',
    'bash deploy/scripts/whatsoup-host-doctor.sh --profile quality --json',
    'tee "$RUNNER_TEMP/whatsoup-doctor-quality.json"',
    'r.outcome !== "pass"',
  ]);
  requireNamedStep(compat, 'Install compatibility host dependencies', 'quality (25.x)', [
    'bash deploy/scripts/install-host-dependencies.sh --profile quality --node-policy compatibility --apply --yes --json',
    '>> "$GITHUB_PATH"',
  ]);
  requireNamedStep(compat, 'Host dependency profile (compatibility-only)', 'quality (25.x)', [
    'set -o pipefail',
    'bash deploy/scripts/whatsoup-host-doctor.sh --profile quality --node-policy compatibility --json',
    'tee "$RUNNER_TEMP/whatsoup-doctor-compatibility.json"',
    'r.outcome !== "compatibility_only"',
  ]);

  const macos = asRecord(jobs?.['bot-errors-health-macos']);
  // GitHub refuses the retired macos-14 image (jobs are cancelled, not failed),
  // and a floating label such as macos-latest can silently change the proof host.
  if (macos?.['runs-on'] !== 'macos-15') {
    failures.push('bot-errors-health-macos runs-on must be exactly macos-15');
  }
  const macosSteps = Array.isArray(macos?.steps) ? macos.steps.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  const macosPortableRun = 'npm test -- tests/helpers/python-interpreter.test.ts tests/scripts/bot-errors-python-atomic-write-guard.test.ts tests/scripts/bot-errors-release-proof-installer.test.ts tests/scripts/bot-errors-release-proof-run.test.ts --pool=forks --maxWorkers=1';
  if (exactRunCount(macosSteps, macosPortableRun) !== 1) {
    failures.push('bot-errors-health-macos must run the portable Python and release-proof prerequisite suites exactly once');
  }
  if (macos?.['timeout-minutes'] !== 10) {
    failures.push('bot-errors-health-macos must retain its 10-minute qualification budget');
  }
  if (macos?.if !== fullGate || !needsSelection(macos)) {
    failures.push('bot-errors-health-macos must remain a full-profile validation job');
  }
  if (macos) {
    requireSelectedWorker(
      'bot-errors-health-macos',
      macos,
      fullGate,
      'Portable Python and release-proof prerequisites (real macOS)',
    );
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
    'node --experimental-strip-types scripts/full-suite-battery.ts --pool=forks',
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
  const compatibilityText = collectStringValues(compatibilityFull).join('\n');
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
  for (const run of [
    'npm --prefix tools/whatsoup_guard ci',
    'npm --prefix tools/whatsoup_guard run typecheck',
    'npm --prefix tools/whatsoup_guard test -- --maxWorkers=2',
  ]) {
    if (exactRunCount(authority, run) !== 1) failures.push(`full Node 24 worker must run exactly once: ${run}`);
  }
  const tagReleaseHygiene = authority.filter((step) => step.name === 'Release hygiene guard (tags)');
  if (
    tagReleaseHygiene.length !== 1
    || tagReleaseHygiene[0]?.if !== "startsWith(github.ref, 'refs/tags/')"
    || tagReleaseHygiene[0]?.run !== 'npm run guard:repo:release-hygiene'
    || hasOwn(tagReleaseHygiene[0]!, 'continue-on-error')
  ) {
    failures.push('full Node 24 worker must run release hygiene on tag refs');
  }
  if (text.includes('docker image prune --all --force || true') || text.includes('sudo rm -rf /usr/share/dotnet')) {
    failures.push('quality workflow must not retain masked unconditional disk cleanup');
  }

  if (authority.some((step) => step.name === 'Install test-integrity plugin' || step.name === 'Test integrity baseline check')) {
    failures.push('quality workflow must keep private Test Integrity execution in the trusted scanner');
  }
  return failures;
}

function qualityCiPlaywrightTimeoutFailures(text: string): string[] {
  const { root, failures: parseFailures } = parseWorkflow(text, 'quality workflow');
  if (!root) return parseFailures;
  const jobs = asRecord(root?.jobs);
  const full = asRecord(jobs?.full);
  if (!full) return ['workflow must declare jobs.full as a mapping'];

  const failures: string[] = [];
  if (hasOwn(root, 'defaults')) failures.push('quality workflow must not declare defaults');
  if (hasOwn(root, 'env')) failures.push('quality workflow must not declare env');
  if (full['timeout-minutes'] !== 60) {
    failures.push('quality job timeout must be exactly 60 minutes');
  }
  if (hasOwn(full, 'continue-on-error') && full['continue-on-error'] !== false) {
    failures.push('quality job continue-on-error must be absent or false');
  }
  if (full.if !== "needs.selection.outputs.profile == 'full'") {
    failures.push('full job must be gated by the full selection profile');
  }
  if (full.needs !== 'selection') failures.push('full job must depend only on selection');
  if (hasOwn(full, 'defaults')) failures.push('quality job must not declare defaults');
  if (hasOwn(full, 'env')) failures.push('full job must not declare env');

  if (!Array.isArray(full.steps)) {
    failures.push('full job must declare steps as an array');
    return failures;
  }
  const steps = full.steps.map(asRecord);
  if (steps.some((step) => !step)) {
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
    const fullProfileWorker = jobId === 'full'
      && job.if === "needs.selection.outputs.profile == 'full'"
      && job.needs === 'selection';
    if (hasOwn(job, 'needs') && !fullProfileWorker) failures.add(`workflow job ${jobId} must not declare needs`);
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
      const fullProfileWorker = jobId === 'full'
        && job.if === "needs.selection.outputs.profile == 'full'"
        && job.needs === 'selection';
      if (hasOwn(step, 'if')) {
        failures.add(`conditional ${requiredRun} (if: ${renderValue(step.if)})`);
      }
      if (hasOwn(step, 'continue-on-error') && step['continue-on-error'] !== false) {
        failures.add(
          `advisory ${requiredRun} (continue-on-error: ${renderValue(step['continue-on-error'])})`,
        );
      }
      for (const failure of runControlFailures(step, requiredRun)) failures.add(failure);
      if (hasOwn(job, 'if') && !fullProfileWorker) {
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
  const chainScripts = consoleDesignChainView(cwd, scripts, consoleScripts);
  const gitContext = collectGitContext(cwd);
  const checks = [
    checkScriptPresence(scripts),
    checkConsoleDesignScriptCoverage(chainScripts, consoleScripts),
    ...CHAIN_REQUIREMENTS.map((requirement) => checkChainRequirement(chainScripts, requirement)),
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
