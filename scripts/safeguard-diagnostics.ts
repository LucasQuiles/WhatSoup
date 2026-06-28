#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
}

interface AnchorRequirement {
  id: string;
  category: DiagnosticCategory;
  file: string;
  anchors: string[];
  requiredUnconditionalRuns?: string[];
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
  'guard:lint:src',
  'guard:claude-settings',
  'guard:agent-decision-polls',
  'guard:safeguard-diagnostics',
  'guard:fleet-bot-hardening-parity',
  'guard:bot-errors-runtime-manifest',
  'test:design-guards',
  'test:browser',
  'test:browser:motion',
  'verify:console-design',
  'verify:console-browser',
  'verify:push:branch',
  'verify:release',
  'verify:publish',
];

const CHAIN_REQUIREMENTS: ChainRequirement[] = [
  {
    id: 'console-design-chain',
    scriptName: 'verify:console-design',
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
      'npm run test:design-guards',
    ],
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
      'npm run guard:test-integrity',
      'npm run guard:boundaries',
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
      'npm run guard:repo:release-hygiene',
      'npm run guard:repo:commit-authors',
      'npm run guard:publication:all',
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
      'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard ci',
      'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard run typecheck',
      'bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard test',
      'bash scripts/run-with-pinned-npm.sh --prefix console ci',
      'bash scripts/run-with-pinned-npm.sh --prefix console run lint',
      'npm run typecheck:all',
      'npm test',
      'npm run coverage:check',
      'bash scripts/run-with-pinned-npm.sh --prefix console run build',
      'npm run verify:console-design',
      'npm run verify:console-browser',
    ],
    forbiddenSteps: [
      'npm --prefix tools/whatsoup_guard ci',
      'npm --prefix tools/whatsoup_guard run typecheck',
      'npm --prefix tools/whatsoup_guard test',
      'npm --prefix console ci',
      'npm --prefix console run lint',
      'npm --prefix console run build',
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
    file: 'scripts/repo-hygiene-guard.ts',
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
      '--commit-authors',
      'scanCommitMessage(commit.message',
    ],
    remediation: 'Restore repo-hygiene patterns before publishing changes.',
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
    id: 'quality-ci-console-design-chain',
    category: 'guard-chain',
    file: '.github/workflows/quality.yml',
    anchors: [
      'name: Install console dependencies',
      'name: Design-system hygiene changed files',
      'npm run guard:design-system-hygiene -- --changed-since',
      'name: Console build',
      'name: Console design verification',
      'run: npm run verify:console-design',
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
      'timeout 300 npx playwright install chromium',
      'run: npm run test:browser',
      'run: npm run test:browser:motion',
    ],
    remediation: 'Restore the shared console design verification chain in quality.yml CI.',
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
    ...outOfOrder.map((step) => `out-of-order ${step}`),
    ...forbiddenPresent.map((step) => `forbidden ${step}`),
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
  const chain = rootScripts['verify:console-design'];
  if (!chain) {
    return {
      id: 'console-design-script-coverage',
      category: 'guard-chain',
      status: 'fail',
      message: 'verify:console-design is missing.',
      evidence: ['verify:console-design'],
      remediation: 'Restore verify:console-design before relying on console design guard coverage.',
    };
  }

  const requiredSteps = consoleDesignScriptSteps(consoleScripts);
  const missing = requiredSteps.filter((step) => !chain.includes(step));
  return {
    id: 'console-design-script-coverage',
    category: 'guard-chain',
    status: missing.length === 0 ? 'pass' : 'fail',
    message: missing.length === 0
      ? 'All non-capture console design scripts are wired into verify:console-design.'
      : `verify:console-design omits ${missing.length} console design script(s).`,
    evidence: missing.length === 0 ? requiredSteps : missing.map((step) => `missing ${step}`),
    remediation: 'Add the missing console design guard scripts to verify:console-design, or explicitly classify them as visual capture-only.',
  };
}

function conditionalRunFailures(text: string, runs: string[]): string[] {
  const lines = text.split(/\r?\n/);
  const failures: string[] = [];
  for (const run of runs) {
    const runLineIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trim() === run);
    for (const { index } of runLineIndexes) {
      let start = index;
      while (start > 0 && !/^\s*-\s+name:/.test(lines[start])) start -= 1;
      let end = index + 1;
      while (end < lines.length && !/^\s*-\s+name:/.test(lines[end])) end += 1;
      const conditional = lines.slice(start, end).find((line) => /^\s*if\s*:/.test(line));
      if (conditional) failures.push(`conditional ${run} (${conditional.trim()})`);
    }
  }
  return failures;
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
  const conditionalRuns = conditionalRunFailures(text, requirement.requiredUnconditionalRuns ?? []);
  const failures = [
    ...missing,
    ...conditionalRuns,
  ];
  return {
    id: requirement.id,
    category: requirement.category,
    status: failures.length === 0 ? 'pass' : 'fail',
    message: failures.length === 0
      ? `${requirement.file} contains required safeguard anchors.`
      : `${requirement.file} has ${failures.length} safeguard anchor failure(s).`,
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
