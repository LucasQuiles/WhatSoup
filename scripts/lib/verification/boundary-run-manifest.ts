import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { cleanGitEnv } from '../../../src/lib/git-env.ts';

export const BOUNDARY_RUN_SCHEMA = 1 as const;

const OBSERVATION_ATTEMPT_IDS = [
  'validator-suite-postcommit',
  'validator-typecheck-postcommit',
  'upstream-root',
  'upstream-head',
  'upstream-status',
  'upstream-remote',
  'upstream-fetch',
  'upstream-origin-oid',
  'upstream-merge-base',
  'upstream-ahead-behind',
  'upstream-remote-diff',
  'upstream-local-diff',
  'merge-preview',
] as const;

const DOC_PATHS = [
  'docs/public-surface.md',
  'docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md',
  'docs/work-index.json',
  'docs/work-index.md',
] as const;

export const RUN_CONTRACT_PROFILES = {
  'bcf00-observation': {
    profileId: 'bcf00-observation',
    taskId: 'BCF-00',
    phase: 'observation',
    terminalLifecycle: 'closed',
    requiredAttemptIds: OBSERVATION_ATTEMPT_IDS,
    requiredChildren: [],
    transition: null,
    mayComplete: false,
    chainAppend: false,
    predecessorProfileId: null,
    allowedPaths: [],
  },
  'bcf00-reconciliation': {
    profileId: 'bcf00-reconciliation', taskId: 'BCF-00', phase: 'reconciliation',
    terminalLifecycle: 'completed', mayComplete: true, chainAppend: true,
    transition: 'merge', predecessorProfileId: 'bcf00-observation',
    requiredChildren: ['upstream-observation:observation'], allowedPaths: 'observation-preview',
    requiredAttemptIds: [
      'merge-transition', 'postmerge-validator-suite', 'postmerge-validator-typecheck',
      'predecessor-focused', 'predecessor-typecheck-scripts', 'predecessor-typecheck-all',
      'predecessor-baseline-eval', 'predecessor-candidate-eval', 'predecessor-holdout-eval',
      'predecessor-branch-gate', 'readiness-check',
    ],
  },
  'bcf01-parser': {
    profileId: 'bcf01-parser', taskId: 'BCF-01', phase: 'task01', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: 'commit',
    predecessorProfileId: 'bcf00-reconciliation', requiredChildren: [],
    allowedPaths: ['scripts/semantic-quality-check.ts', 'tests/scripts/semantic-quality-check.test.ts'],
    requiredAttemptIds: ['parser-red', 'parser-green', 'parser-typecheck', 'parser-scope', 'parser-commit-transition'],
  },
  'bcf02-catalog': {
    profileId: 'bcf02-catalog', taskId: 'BCF-02', phase: 'task02', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: 'commit', predecessorProfileId: 'bcf01-parser',
    requiredChildren: [],
    allowedPaths: [
      'scripts/lib/semantic-quality/boundary-contract.ts',
      'scripts/lib/semantic-quality/boundary-types.ts',
      'scripts/lib/semantic-quality/rule-guidance.ts',
      'tests/scripts/semantic-boundary-contract.test.ts',
      'tests/scripts/semantic-rule-guidance.test.ts',
    ],
    requiredAttemptIds: [
      'catalog-inventory-raw', 'catalog-inventory-strip', 'catalog-inventory-sort',
      'catalog-inventory-count', 'catalog-red', 'catalog-green', 'catalog-typecheck',
      'catalog-scope', 'catalog-commit-transition',
    ],
  },
  'bcf03-contract': {
    profileId: 'bcf03-contract', taskId: 'BCF-03', phase: 'task03', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: 'commit', predecessorProfileId: 'bcf02-catalog',
    requiredChildren: [],
    allowedPaths: [
      'scripts/lib/semantic-quality/boundary-contract.ts',
      'scripts/lib/semantic-quality/boundary-types.ts',
      'tests/scripts/semantic-boundary-contract.test.ts',
    ],
    requiredAttemptIds: ['contract-red', 'contract-green', 'contract-typecheck', 'contract-scope', 'contract-commit-transition'],
  },
  'bcf04-receipt': {
    profileId: 'bcf04-receipt', taskId: 'BCF-04', phase: 'task04', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: 'commit', predecessorProfileId: 'bcf03-contract',
    requiredChildren: [],
    allowedPaths: [
      'scripts/experiments/semantic-boundary-eval.ts',
      'scripts/lib/semantic-quality/history.ts',
      'scripts/lib/semantic-quality/policy.ts',
      'scripts/lib/semantic-quality/provenance.ts',
      'scripts/lib/semantic-quality/receipt.ts',
      'scripts/semantic-quality-check.ts',
      'tests/scripts/semantic-boundary-contract.test.ts',
      'tests/scripts/semantic-boundary-eval.test.ts',
      'tests/scripts/semantic-history.test.ts',
      'tests/scripts/semantic-provenance.test.ts',
      'tests/scripts/semantic-quality-check.test.ts',
      'tests/scripts/semantic-quality-policy.test.ts',
    ],
    requiredAttemptIds: [
      'receipt-red', 'receipt-green', 'receipt-typecheck', 'receipt-producer-scan',
      'receipt-staged-scope', 'receipt-commit-transition',
    ],
  },
  'bcf05-feedback': {
    profileId: 'bcf05-feedback', taskId: 'BCF-05', phase: 'task05', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: 'commit', predecessorProfileId: 'bcf04-receipt',
    requiredChildren: [],
    allowedPaths: [
      'scripts/lib/semantic-quality/receipt.ts',
      'tests/scripts/semantic-boundary-contract.test.ts',
      'tests/scripts/semantic-quality-check.test.ts',
    ],
    requiredAttemptIds: [
      'feedback-red', 'feedback-green', 'feedback-budget', 'feedback-typecheck',
      'feedback-scope', 'feedback-commit-transition',
    ],
  },
  'bcf06-provider': {
    profileId: 'bcf06-provider', taskId: 'BCF-06', phase: 'task06', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: 'commit', predecessorProfileId: 'bcf05-feedback',
    requiredChildren: [],
    allowedPaths: ['scripts/lib/semantic-quality/history-provider.ts', 'tests/scripts/semantic-history-provider.test.ts'],
    requiredAttemptIds: [
      'provider-red', 'provider-green-one', 'provider-green-two', 'provider-typecheck',
      'provider-scope', 'provider-commit-transition',
    ],
  },
  'bcf07-integration': {
    profileId: 'bcf07-integration', taskId: 'BCF-07', phase: 'task07', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: 'commit', predecessorProfileId: 'bcf06-provider',
    requiredChildren: [],
    allowedPaths: [
      'scripts/experiments/semantic-boundary-eval.ts',
      'scripts/semantic-quality-check.ts',
      'tests/scripts/semantic-boundary-eval.test.ts',
      'tests/scripts/semantic-quality-check.test.ts',
    ],
    requiredAttemptIds: [
      'integration-red', 'integration-focused', 'integration-typecheck-scripts',
      'integration-baseline-eval', 'integration-candidate-eval', 'integration-holdout-eval',
      'integration-scope', 'integration-commit-transition',
    ],
  },
  'bcf-review-contract': {
    profileId: 'bcf-review-contract', taskId: 'BCF-REVIEW', phase: 'review', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: false, transition: null, predecessorProfileId: 'bcf07-integration',
    requiredChildren: [], allowedPaths: [], requiredAttemptIds: ['review-schema-check', 'review-scope-check'],
  },
  'bcf-review-redaction': {
    profileId: 'bcf-review-redaction', taskId: 'BCF-REVIEW', phase: 'review', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: false, transition: null, predecessorProfileId: 'bcf07-integration',
    requiredChildren: [], allowedPaths: [], requiredAttemptIds: ['review-schema-check', 'review-scope-check'],
  },
  'bcf-review-integration': {
    profileId: 'bcf-review-integration', taskId: 'BCF-REVIEW', phase: 'review', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: false, transition: null, predecessorProfileId: 'bcf07-integration',
    requiredChildren: [], allowedPaths: [], requiredAttemptIds: ['review-schema-check', 'review-scope-check'],
  },
  'bcf-reproduction': {
    profileId: 'bcf-reproduction', taskId: 'BCF-REPRODUCTION', phase: 'reproduction', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: false, transition: null, predecessorProfileId: 'bcf07-integration',
    requiredChildren: [], allowedPaths: [], requiredAttemptIds: ['reproduction-suite', 'reproduction-scope-check'],
  },
  'bcf08a-docs': {
    profileId: 'bcf08a-docs', taskId: 'BCF-08A', phase: 'docs-a', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: null, predecessorProfileId: 'bcf07-integration',
    requiredChildren: [
      'review-contract:review', 'review-redaction:review', 'review-integration:review',
      'lead-reproduction:reproduction',
    ],
    allowedPaths: DOC_PATHS,
    requiredAttemptIds: [
      'docs-work-index-regen', 'docs-work-index-guard', 'docs-publication', 'docs-drift',
      'docs-tally', 'docs-authoring-scope',
    ],
  },
  'bcf08b-docs': {
    profileId: 'bcf08b-docs', taskId: 'BCF-08B', phase: 'docs-b', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: 'commit', predecessorProfileId: 'bcf08a-docs',
    requiredChildren: ['docs-precommit:docs'], allowedPaths: DOC_PATHS,
    requiredAttemptIds: [
      'docs-focused', 'docs-typecheck-scripts', 'docs-typecheck-all',
      'docs-test-integrity-preflight', 'docs-test-integrity-scan', 'docs-baseline-eval',
      'docs-candidate-eval', 'docs-holdout-eval', 'docs-work-index-regen',
      'docs-work-index-guard', 'docs-publication', 'docs-drift', 'docs-tally',
      'docs-lineage-scope', 'docs-staged-scope', 'docs-commit-transition',
    ],
  },
  'bcf08-final': {
    profileId: 'bcf08-final', taskId: 'BCF-08C', phase: 'final', terminalLifecycle: 'completed',
    mayComplete: true, chainAppend: true, transition: null, predecessorProfileId: 'bcf08b-docs',
    requiredChildren: [
      'docs:docs', 'review-contract:review', 'review-redaction:review',
      'review-integration:review', 'lead-reproduction:reproduction',
    ],
    allowedPaths: [],
    requiredAttemptIds: [
      'final-upstream-remote', 'final-upstream-refresh', 'final-upstream-origin-oid',
      'final-upstream-merge-base', 'final-upstream-ahead-behind', 'final-upstream-remote-diff',
      'final-upstream-local-diff', 'watchdog-canary', 'watchdog-parent-dead',
      'watchdog-child-dead', 'watchdog-group-dead', 'final-branch-gate',
    ],
  },
} as const;

export const RUN_CHILD_CONTRACTS = {
  'bcf00-reconciliation/upstream-observation': {
    parentProfileId: 'bcf00-reconciliation', alias: 'upstream-observation', kind: 'observation',
    taskId: 'BCF-00', profileId: 'bcf00-observation', dedupeKey: 'upstream-observation',
    headRelation: 'both-parent-entry', maxDepth: 2,
  },
  'bcf08a-docs/review-contract': {
    parentProfileId: 'bcf08a-docs', alias: 'review-contract', kind: 'review', taskId: 'BCF-REVIEW',
    profileId: 'bcf-review-contract', dedupeKey: 'contract-cli-review',
    headRelation: 'both-parent-entry', maxDepth: 2,
  },
  'bcf08a-docs/review-redaction': {
    parentProfileId: 'bcf08a-docs', alias: 'review-redaction', kind: 'review', taskId: 'BCF-REVIEW',
    profileId: 'bcf-review-redaction', dedupeKey: 'redaction-async-review',
    headRelation: 'both-parent-entry', maxDepth: 2,
  },
  'bcf08a-docs/review-integration': {
    parentProfileId: 'bcf08a-docs', alias: 'review-integration', kind: 'review', taskId: 'BCF-REVIEW',
    profileId: 'bcf-review-integration', dedupeKey: 'integration-blast-review',
    headRelation: 'both-parent-entry', maxDepth: 2,
  },
  'bcf08a-docs/lead-reproduction': {
    parentProfileId: 'bcf08a-docs', alias: 'lead-reproduction', kind: 'reproduction',
    taskId: 'BCF-REPRODUCTION', profileId: 'bcf-reproduction', dedupeKey: 'lead-reproduction',
    headRelation: 'both-parent-entry', maxDepth: 2,
  },
  'bcf08b-docs/docs-precommit': {
    parentProfileId: 'bcf08b-docs', alias: 'docs-precommit', kind: 'docs', taskId: 'BCF-08A',
    profileId: 'bcf08a-docs', dedupeKey: 'docs-precommit', headRelation: 'both-parent-entry',
    maxDepth: 3,
  },
  'bcf08-final/docs': {
    parentProfileId: 'bcf08-final', alias: 'docs', kind: 'docs', taskId: 'BCF-08B',
    profileId: 'bcf08b-docs', dedupeKey: 'docs', headRelation: 'terminal-parent-entry', maxDepth: 3,
  },
  'bcf08-final/review-contract': {
    parentProfileId: 'bcf08-final', alias: 'review-contract', kind: 'review', taskId: 'BCF-REVIEW',
    profileId: 'bcf-review-contract', dedupeKey: 'contract-cli-review',
    headRelation: 'both-docs-entry', maxDepth: 3,
  },
  'bcf08-final/review-redaction': {
    parentProfileId: 'bcf08-final', alias: 'review-redaction', kind: 'review', taskId: 'BCF-REVIEW',
    profileId: 'bcf-review-redaction', dedupeKey: 'redaction-async-review',
    headRelation: 'both-docs-entry', maxDepth: 3,
  },
  'bcf08-final/review-integration': {
    parentProfileId: 'bcf08-final', alias: 'review-integration', kind: 'review', taskId: 'BCF-REVIEW',
    profileId: 'bcf-review-integration', dedupeKey: 'integration-blast-review',
    headRelation: 'both-docs-entry', maxDepth: 3,
  },
  'bcf08-final/lead-reproduction': {
    parentProfileId: 'bcf08-final', alias: 'lead-reproduction', kind: 'reproduction',
    taskId: 'BCF-REPRODUCTION', profileId: 'bcf-reproduction', dedupeKey: 'lead-reproduction',
    headRelation: 'both-docs-entry', maxDepth: 3,
  },
} as const;

export const RUN_SOURCE_REVIEW_CONTRACTS = {
  'bcf-review-contract': {
    profileId: 'bcf-review-contract', alias: 'review-contract', dedupeKey: 'contract-cli-review',
  },
  'bcf-review-redaction': {
    profileId: 'bcf-review-redaction', alias: 'review-redaction', dedupeKey: 'redaction-async-review',
  },
  'bcf-review-integration': {
    profileId: 'bcf-review-integration', alias: 'review-integration', dedupeKey: 'integration-blast-review',
  },
} as const;

const BOUNDARY_CHILD_ENVIRONMENT = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'] as const;

type BoundaryHeadAnchor = 'entry' | 'terminal' | 'transition';

interface BoundaryAttemptContract {
  operation: 'command' | 'internal-check' | 'git-transition';
  argv: readonly string[];
  environmentKeys: readonly string[];
  toolName: string | null;
  expectedExit: string;
  watchdogOwner: 'helper-watchdog' | null;
  innerTimeoutOwner: 'gnu-timeout' | null;
  deadlineMs: number;
  killGraceMs: number;
  outputPaths: readonly string[];
  headAnchor: BoundaryHeadAnchor;
  stdinSource: string | null;
  stdoutPredicate: string | null;
  resultPredicate: string | null;
  structuredResultPath: string | null;
  internalCheck: string | null;
  transitionKind: 'commit' | 'merge' | null;
  messageSubject: string | null;
  allowlistSource: 'profile-paths' | 'observation-preview' | null;
}

interface CommandContractOptions {
  expectedExit?: string;
  deadlineMs?: number;
  innerTimeoutOwner?: 'gnu-timeout' | null;
  outputPaths?: readonly string[];
  headAnchor?: BoundaryHeadAnchor;
  stdinSource?: string | null;
  stdoutPredicate?: string | null;
  resultPredicate?: string | null;
  toolName?: string;
}

function commandContract(
  argv: readonly string[],
  options: CommandContractOptions = {},
): BoundaryAttemptContract {
  return {
    operation: 'command',
    argv,
    environmentKeys: BOUNDARY_CHILD_ENVIRONMENT,
    toolName: options.toolName ?? argv[0] ?? null,
    expectedExit: options.expectedExit ?? '0',
    watchdogOwner: 'helper-watchdog',
    innerTimeoutOwner: options.innerTimeoutOwner ?? null,
    deadlineMs: options.deadlineMs ?? 120_000,
    killGraceMs: 30_000,
    outputPaths: options.outputPaths ?? [],
    headAnchor: options.headAnchor ?? 'entry',
    stdinSource: options.stdinSource ?? null,
    stdoutPredicate: options.stdoutPredicate ?? null,
    resultPredicate: options.resultPredicate ?? null,
    structuredResultPath: null,
    internalCheck: null,
    transitionKind: null,
    messageSubject: null,
    allowlistSource: null,
  };
}

function internalCheckContract(
  name: string,
  headAnchor: BoundaryHeadAnchor = 'entry',
  toolName: string | null = null,
  outputPaths: readonly string[] = [],
): BoundaryAttemptContract {
  return {
    operation: 'internal-check',
    argv: [],
    environmentKeys: [],
    toolName,
    expectedExit: '0',
    watchdogOwner: null,
    innerTimeoutOwner: null,
    deadlineMs: 120_000,
    killGraceMs: 30_000,
    outputPaths,
    headAnchor,
    stdinSource: null,
    stdoutPredicate: null,
    resultPredicate: null,
    structuredResultPath: null,
    internalCheck: name,
    transitionKind: null,
    messageSubject: null,
    allowlistSource: null,
  };
}

function transitionContract(
  kind: 'commit' | 'merge',
  messageSubject: string | null,
): BoundaryAttemptContract {
  return {
    operation: 'git-transition',
    argv: [],
    environmentKeys: BOUNDARY_CHILD_ENVIRONMENT,
    toolName: 'git',
    expectedExit: '0',
    watchdogOwner: 'helper-watchdog',
    innerTimeoutOwner: null,
    deadlineMs: 300_000,
    killGraceMs: 30_000,
    outputPaths: [],
    headAnchor: 'transition',
    stdinSource: null,
    stdoutPredicate: null,
    resultPredicate: null,
    structuredResultPath: null,
    internalCheck: null,
    transitionKind: kind,
    messageSubject,
    allowlistSource: kind === 'commit' ? 'profile-paths' : 'observation-preview',
  };
}

const VALIDATOR_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/verify-boundary-run.test.ts', '--run',
] as const;
const TYPECHECK_SCRIPTS = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'typecheck:scripts'] as const;
const TYPECHECK_ALL = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'typecheck:all'] as const;
const PARSER_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-quality-check.test.ts', '--pool=forks', '--fileParallelism=false',
] as const;
const CATALOG_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-rule-guidance.test.ts', '--pool=forks', '--fileParallelism=false',
] as const;
const CONTRACT_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-boundary-contract.test.ts', '--pool=forks', '--fileParallelism=false',
] as const;
const RECEIPT_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-boundary-contract.test.ts', 'tests/scripts/semantic-quality-check.test.ts',
  '--pool=forks', '--fileParallelism=false',
] as const;
const PROVIDER_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-history-provider.test.ts', '--pool=forks', '--fileParallelism=false',
] as const;
const INTEGRATION_RED_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-quality-check.test.ts', 'tests/scripts/semantic-boundary-eval.test.ts',
  '--pool=forks', '--fileParallelism=false',
] as const;
const INTEGRATION_FOCUSED_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-boundary-contract.test.ts',
  'tests/scripts/semantic-rule-guidance.test.ts',
  'tests/scripts/semantic-quality-check.test.ts',
  'tests/scripts/semantic-history-provider.test.ts',
  'tests/scripts/semantic-history.test.ts',
  'tests/scripts/semantic-provenance.test.ts',
  'tests/scripts/semantic-boundary-eval.test.ts',
  '--pool=forks', '--fileParallelism=false',
] as const;
const PREDECESSOR_FOCUSED_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-fingerprint.test.ts',
  'tests/scripts/semantic-history-provider.test.ts',
  'tests/scripts/semantic-history.test.ts',
  'tests/scripts/semantic-provenance.test.ts',
  'tests/scripts/semantic-quality-check.test.ts',
  'tests/scripts/semantic-boundary-eval.test.ts',
  '--pool=forks', '--fileParallelism=false',
] as const;
const BASELINE_EVAL = [
  'bash', 'scripts/run-with-pinned-node.sh', 'scripts/experiments/semantic-boundary-eval.ts',
  '--engine', 'baseline', '--corpus', 'tests/fixtures/semantic-boundary-eval/cases.json', '--format', 'json',
] as const;
const CANDIDATE_EVAL = [
  'bash', 'scripts/run-with-pinned-node.sh', 'scripts/experiments/semantic-boundary-eval.ts',
  '--engine', 'candidate', '--corpus', 'tests/fixtures/semantic-boundary-eval/cases.json',
  '--verify-git', '--format', 'json',
] as const;
const HOLDOUT_EVAL = [
  'bash', 'scripts/run-with-pinned-node.sh', 'scripts/experiments/semantic-boundary-eval.ts',
  '--engine', 'candidate', '--corpus', 'tests/fixtures/semantic-boundary-eval/holdout.json',
  '--verify-git', '--format', 'json',
] as const;
const BRANCH_GATE = [
  'gnu-timeout', '--kill-after=30s', '30m',
  'loadgate', '--label', 'boundary-contract-branch', '--max-wait', '120', '--strict', '--',
  'bash', 'scripts/run-with-pinned-npm.sh', 'run', 'verify:push:branch',
] as const;
const DOC_WORK_INDEX_REGEN = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen'] as const;
const DOC_WORK_INDEX_GUARD = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'guard:work-index'] as const;
const DOC_PUBLICATION = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'guard:publication:all'] as const;
const DOC_DRIFT = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'guard:doc-drift'] as const;
const DOC_TALLY = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'guard:doc-tally'] as const;

const attemptEntries: Array<readonly [string, BoundaryAttemptContract]> = [
  ['validator-suite-postcommit', commandContract(VALIDATOR_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf00-green' })],
  ['validator-typecheck-postcommit', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000 })],
  ['upstream-root', commandContract(['git', 'rev-parse', '--show-toplevel'])],
  ['upstream-head', commandContract(['git', 'rev-parse', 'HEAD'], { stdoutPredicate: 'oid' })],
  ['upstream-status', commandContract(['git', 'status', '--short'])],
  ['upstream-remote', commandContract(['git', 'remote', 'get-url', 'origin'], { stdoutPredicate: 'ssh-origin' })],
  ['upstream-fetch', commandContract(['git', 'fetch', 'origin'], { deadlineMs: 300_000 })],
  ['upstream-origin-oid', commandContract(['git', 'rev-parse', 'origin/main'], { stdoutPredicate: 'oid' })],
  ['upstream-merge-base', commandContract(['git', 'merge-base', 'HEAD', 'origin/main'], { stdoutPredicate: 'oid' })],
  ['upstream-ahead-behind', commandContract(['git', 'rev-list', '--left-right', '--count', 'origin/main...HEAD'], { stdoutPredicate: 'ahead-behind' })],
  ['upstream-remote-diff', commandContract(['git', 'diff', '--name-status', '<observed-merge-base>...origin/main'])],
  ['upstream-local-diff', commandContract(['git', 'diff', '--name-status', '<observed-merge-base>...HEAD'])],
  ['merge-preview', commandContract(['git', 'merge-tree', '--write-tree', 'HEAD', 'origin/main'], { stdoutPredicate: 'merge-preview' })],

  ['merge-transition', transitionContract('merge', null)],
  ['postmerge-validator-suite', commandContract(VALIDATOR_TEST, { deadlineMs: 900_000, headAnchor: 'terminal', resultPredicate: 'bcf00-green' })],
  ['postmerge-validator-typecheck', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000, headAnchor: 'terminal' })],
  ['predecessor-focused', commandContract(PREDECESSOR_FOCUSED_TEST, { deadlineMs: 900_000, headAnchor: 'terminal', resultPredicate: 'predecessor-focused' })],
  ['predecessor-typecheck-scripts', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000, headAnchor: 'terminal' })],
  ['predecessor-typecheck-all', commandContract(TYPECHECK_ALL, { deadlineMs: 900_000, headAnchor: 'terminal' })],
  ['predecessor-baseline-eval', commandContract(BASELINE_EVAL, { deadlineMs: 300_000, headAnchor: 'terminal', resultPredicate: 'baseline-13-of-40' })],
  ['predecessor-candidate-eval', commandContract(CANDIDATE_EVAL, { deadlineMs: 300_000, headAnchor: 'terminal', resultPredicate: 'candidate-39-of-40' })],
  ['predecessor-holdout-eval', commandContract(HOLDOUT_EVAL, { deadlineMs: 300_000, headAnchor: 'terminal', resultPredicate: 'holdout-18-of-18' })],
  ['predecessor-branch-gate', commandContract(BRANCH_GATE, { deadlineMs: 1_860_000, innerTimeoutOwner: 'gnu-timeout', headAnchor: 'terminal', toolName: 'gnu-timeout' })],
  ['readiness-check', internalCheckContract('readiness-contract', 'terminal', null, ['readiness.json'])],

  ['parser-red', commandContract(PARSER_TEST, { expectedExit: 'nonzero', deadlineMs: 900_000, resultPredicate: 'bcf01-red' })],
  ['parser-green', commandContract(PARSER_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf01-green' })],
  ['parser-typecheck', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000 })],
  ['parser-scope', internalCheckContract('worktree-scope')],
  ['parser-commit-transition', transitionContract('commit', 'fix(quality): fail closed on invalid semantic options')],

  ['catalog-inventory-raw', commandContract([
    'rg', '--no-filename', '-o', "'(?:boundary|semantic|history|provenance|supply-chain|process)\\.[a-z0-9.-]+'",
    'scripts/lib/semantic-quality/policy.ts', 'scripts/lib/semantic-quality/history.ts',
    'scripts/lib/semantic-quality/provenance.ts', 'scripts/semantic-quality-check.ts',
    'scripts/experiments/semantic-boundary-eval.ts',
  ])],
  ['catalog-inventory-strip', commandContract(['tr', '-d', "'"], { stdinSource: 'catalog-inventory-raw' })],
  ['catalog-inventory-sort', commandContract(['sort', '-u'], { stdinSource: 'catalog-inventory-strip' })],
  ['catalog-inventory-count', commandContract(['wc', '-l'], { stdinSource: 'catalog-inventory-sort', stdoutPredicate: 'decimal-equals-29' })],
  ['catalog-red', commandContract(CATALOG_TEST, { expectedExit: 'nonzero', deadlineMs: 900_000, resultPredicate: 'bcf02-red' })],
  ['catalog-green', commandContract(CATALOG_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf02-green' })],
  ['catalog-typecheck', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000 })],
  ['catalog-scope', internalCheckContract('worktree-scope')],
  ['catalog-commit-transition', transitionContract('commit', 'feat(quality): add boundary rule guidance catalog')],

  ['contract-red', commandContract(CONTRACT_TEST, { expectedExit: 'nonzero', deadlineMs: 900_000, resultPredicate: 'bcf03-red' })],
  ['contract-green', commandContract(CONTRACT_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf03-green' })],
  ['contract-typecheck', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000 })],
  ['contract-scope', internalCheckContract('worktree-scope')],
  ['contract-commit-transition', transitionContract('commit', 'feat(quality): validate boundary runtime contracts')],

  ['receipt-red', commandContract(RECEIPT_TEST, { expectedExit: 'nonzero', deadlineMs: 900_000, resultPredicate: 'bcf04-red' })],
  ['receipt-green', commandContract(RECEIPT_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf04-green' })],
  ['receipt-typecheck', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000 })],
  ['receipt-producer-scan', internalCheckContract('producer-inventory-contract', 'entry', 'rg', ['consumer-version-decision.json'])],
  ['receipt-staged-scope', commandContract(['git', 'diff', '--cached', '--name-only'], { stdoutPredicate: 'exact-profile-allowlist' })],
  ['receipt-commit-transition', transitionContract('commit', 'feat(quality): bind boundary receipts to evidence')],

  ['feedback-red', commandContract(RECEIPT_TEST, { expectedExit: 'nonzero', deadlineMs: 900_000, resultPredicate: 'bcf05-red' })],
  ['feedback-green', commandContract(RECEIPT_TEST, { deadlineMs: 900_000, outputPaths: ['feedback-measurements.json'], resultPredicate: 'bcf05-green' })],
  ['feedback-budget', internalCheckContract('output-budget-contract')],
  ['feedback-typecheck', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000 })],
  ['feedback-scope', internalCheckContract('worktree-scope')],
  ['feedback-commit-transition', transitionContract('commit', 'feat(quality): bound contextual boundary feedback')],

  ['provider-red', commandContract(PROVIDER_TEST, { expectedExit: 'nonzero', deadlineMs: 900_000, resultPredicate: 'bcf06-red' })],
  ['provider-green-one', commandContract(PROVIDER_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf06-green' })],
  ['provider-green-two', commandContract(PROVIDER_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf06-green' })],
  ['provider-typecheck', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000 })],
  ['provider-scope', internalCheckContract('worktree-scope')],
  ['provider-commit-transition', transitionContract('commit', 'fix(quality): bound history provider decisions')],

  ['integration-red', commandContract(INTEGRATION_RED_TEST, { expectedExit: 'nonzero', deadlineMs: 900_000, resultPredicate: 'bcf07-red' })],
  ['integration-focused', commandContract(INTEGRATION_FOCUSED_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf07-green' })],
  ['integration-typecheck-scripts', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000 })],
  ['integration-baseline-eval', commandContract(BASELINE_EVAL, { deadlineMs: 300_000, resultPredicate: 'baseline-13-of-40' })],
  ['integration-candidate-eval', commandContract(CANDIDATE_EVAL, { deadlineMs: 300_000, resultPredicate: 'candidate-39-of-40' })],
  ['integration-holdout-eval', commandContract(HOLDOUT_EVAL, { deadlineMs: 300_000, resultPredicate: 'holdout-18-of-18' })],
  ['integration-scope', internalCheckContract('worktree-scope')],
  ['integration-commit-transition', transitionContract('commit', 'feat(quality): integrate evidence-bound boundary receipts')],

  ['review-schema-check', internalCheckContract('review-contract')],
  ['review-scope-check', internalCheckContract('read-only-scope')],
  ['reproduction-suite', commandContract(INTEGRATION_FOCUSED_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf07-green' })],
  ['reproduction-scope-check', internalCheckContract('worktree-scope')],

  ['docs-work-index-regen', commandContract(DOC_WORK_INDEX_REGEN, { deadlineMs: 600_000 })],
  ['docs-work-index-guard', commandContract(DOC_WORK_INDEX_GUARD, { deadlineMs: 600_000 })],
  ['docs-publication', commandContract(DOC_PUBLICATION, { deadlineMs: 600_000 })],
  ['docs-drift', commandContract(DOC_DRIFT, { deadlineMs: 600_000 })],
  ['docs-tally', commandContract(DOC_TALLY, { deadlineMs: 600_000 })],
  ['docs-authoring-scope', internalCheckContract('docs-authoring-scope')],
  ['docs-focused', commandContract(INTEGRATION_FOCUSED_TEST, { deadlineMs: 900_000, resultPredicate: 'bcf07-green' })],
  ['docs-typecheck-scripts', commandContract(TYPECHECK_SCRIPTS, { deadlineMs: 900_000 })],
  ['docs-typecheck-all', commandContract(TYPECHECK_ALL, { deadlineMs: 900_000 })],
  ['docs-test-integrity-preflight', commandContract(['test', '-x', '<test-integrity-real-path>'], { toolName: 'test' })],
  ['docs-test-integrity-scan', commandContract([
    'test-integrity', 'scan',
    'tests/scripts/semantic-boundary-contract.test.ts',
    'tests/scripts/semantic-rule-guidance.test.ts',
    'tests/scripts/semantic-quality-check.test.ts',
    'tests/scripts/semantic-history-provider.test.ts',
    'tests/scripts/semantic-boundary-eval.test.ts',
  ], { deadlineMs: 600_000, toolName: 'test-integrity' })],
  ['docs-baseline-eval', commandContract(BASELINE_EVAL, { deadlineMs: 300_000, resultPredicate: 'baseline-13-of-40' })],
  ['docs-candidate-eval', commandContract(CANDIDATE_EVAL, { deadlineMs: 300_000, resultPredicate: 'candidate-39-of-40' })],
  ['docs-holdout-eval', commandContract(HOLDOUT_EVAL, { deadlineMs: 300_000, resultPredicate: 'holdout-18-of-18' })],
  ['docs-lineage-scope', internalCheckContract('docs-lineage-scope', 'entry', 'git', ['docs-lineage.json'])],
  ['docs-staged-scope', internalCheckContract('staged-scope')],
  ['docs-commit-transition', transitionContract('commit', 'docs(quality): record boundary feedback hardening')],

  ['final-upstream-remote', commandContract(['git', 'remote', 'get-url', 'origin'], { stdoutPredicate: 'ssh-origin' })],
  ['final-upstream-refresh', commandContract(['git', 'fetch', 'origin'], { deadlineMs: 300_000 })],
  ['final-upstream-origin-oid', commandContract(['git', 'rev-parse', 'origin/main'], { stdoutPredicate: 'oid' })],
  ['final-upstream-merge-base', commandContract(['git', 'merge-base', 'HEAD', 'origin/main'], { stdoutPredicate: 'oid' })],
  ['final-upstream-ahead-behind', commandContract(['git', 'rev-list', '--left-right', '--count', 'origin/main...HEAD'], { stdoutPredicate: 'ahead-behind' })],
  ['final-upstream-remote-diff', commandContract(['git', 'diff', '--name-status', '<observed-merge-base>...origin/main'])],
  ['final-upstream-local-diff', commandContract(['git', 'diff', '--name-status', '<observed-merge-base>...HEAD'])],
  ['watchdog-canary', commandContract([
    'gnu-timeout', '--kill-after=1s', '1s', 'bash', '-c',
    'trap "" TERM; bash -c \'trap "" TERM; sleep 300\' & child=$!; pgid=$(ps -o pgid= -p $$); pgid=${pgid//[[:space:]]/}; printf "parent=%s\\nchild=%s\\npgid=%s\\n" "$$" "$child" "$pgid" > "$1"; wait "$child"',
    '_', '<run-dir>/watchdog-canary/pids.txt',
  ], {
    expectedExit: '124,137', deadlineMs: 61_000, innerTimeoutOwner: 'gnu-timeout',
    outputPaths: ['watchdog-canary/pids.txt'], toolName: 'gnu-timeout',
  })],
  ['watchdog-parent-dead', commandContract(['kill', '-0', '<watchdog-parent-pid>'], { expectedExit: 'nonzero', toolName: 'kill' })],
  ['watchdog-child-dead', commandContract(['kill', '-0', '<watchdog-child-pid>'], { expectedExit: 'nonzero', toolName: 'kill' })],
  ['watchdog-group-dead', commandContract(['kill', '-0', '-<watchdog-group-pgid>'], { expectedExit: 'nonzero', toolName: 'kill' })],
  ['final-branch-gate', commandContract(BRANCH_GATE, { deadlineMs: 1_860_000, innerTimeoutOwner: 'gnu-timeout', toolName: 'gnu-timeout' })],
];

function buildAttemptContracts(
  entries: readonly (readonly [string, BoundaryAttemptContract])[],
): Readonly<Record<string, BoundaryAttemptContract>> {
  const contracts: Record<string, BoundaryAttemptContract> = {};
  for (const [id, source] of entries) {
    if (id in contracts) throw new Error(`duplicate run attempt contract: ${id}`);
    contracts[id] = {
      ...source,
      structuredResultPath: source.resultPredicate === null
        ? null
        : /^(?:baseline|candidate|holdout)-/.test(source.resultPredicate)
          ? `attempts/${id}/stdout.log`
          : `attempts/${id}/structured-result.json`,
    };
  }
  const required = [...new Set(Object.values(RUN_CONTRACT_PROFILES).flatMap((profile) => profile.requiredAttemptIds))].sort();
  const actual = Object.keys(contracts).sort();
  if (canonicalizeBoundaryRun(actual) !== canonicalizeBoundaryRun(required)) {
    throw new Error('run attempt contracts do not exactly cover the profile-required attempt union');
  }
  return Object.freeze(contracts);
}

export const RUN_ATTEMPT_CONTRACTS = buildAttemptContracts(attemptEntries);

const BCF00_MARKER_IDS = [
  '[BCF00-B01]',
  '[BCF00-U01]',
  '[BCF00-U02]',
  '[BCF00-U03]',
  '[BCF00-U04]',
  '[BCF00-U05]',
  '[BCF00-U06]',
  '[BCF00-U07]',
  '[BCF00-U08]',
  '[BCF00-U09]',
  '[BCF00-U10]',
  '[BCF00-U11]',
  '[BCF00-U12]',
  '[BCF00-U13]',
  '[BCF00-U14]',
  '[BCF00-U15]',
  '[BCF00-U16]',
  '[BCF00-N01]',
  '[BCF00-N02]',
  '[BCF00-N03]',
  '[BCF00-N04]',
  '[BCF00-N05]',
  '[BCF00-N06]',
  '[BCF00-N07]',
  '[BCF00-N08]',
  '[BCF00-N09]',
  '[BCF00-N10]',
  '[BCF00-N11]',
  '[BCF00-N12]',
  '[BCF00-N13]',
  '[BCF00-N14]',
  '[BCF00-N15]',
  '[BCF00-N16]',
] as const;

export const RUN_TEST_CONTRACTS = {
  bcf00: {
    testFile: 'tests/scripts/verify-boundary-run.test.ts',
    testFiles: ['tests/scripts/verify-boundary-run.test.ts'],
    markerIds: BCF00_MARKER_IDS,
    unsafeMarkerIds: BCF00_MARKER_IDS.filter((id) => id.includes('-U')),
    safeMarkerIds: BCF00_MARKER_IDS.filter((id) => id.includes('-B')),
    neighborMarkerIds: BCF00_MARKER_IDS.filter((id) => id.includes('-N')),
  },
  bcf01: taskTestContract('BCF01', 6, 1, 6, ['tests/scripts/semantic-quality-check.test.ts']),
  bcf02: taskTestContract('BCF02', 4, 1, 4, ['tests/scripts/semantic-rule-guidance.test.ts']),
  bcf03: taskTestContract('BCF03', 10, 1, 10, ['tests/scripts/semantic-boundary-contract.test.ts']),
  bcf04: taskTestContract('BCF04', 9, 1, 9, [
    'tests/scripts/semantic-boundary-contract.test.ts',
    'tests/scripts/semantic-quality-check.test.ts',
  ]),
  bcf05: taskTestContract('BCF05', 10, 1, 10, [
    'tests/scripts/semantic-boundary-contract.test.ts',
    'tests/scripts/semantic-quality-check.test.ts',
  ]),
  bcf06: taskTestContract('BCF06', 1, 3, 0, ['tests/scripts/semantic-history-provider.test.ts']),
  bcf07: taskTestContract('BCF07', 4, 2, 4, [
    'tests/scripts/semantic-quality-check.test.ts',
    'tests/scripts/semantic-boundary-eval.test.ts',
  ]),
} as const;

function numberedMarkers(prefix: string, kind: 'U' | 'S' | 'N', count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `[${prefix}-${kind}${String(index + 1).padStart(2, '0')}]`,
  );
}

function taskTestContract(
  prefix: string,
  unsafeCount: number,
  safeCount: number,
  neighborCount: number,
  testFiles: readonly string[],
) {
  const unsafeMarkerIds = numberedMarkers(prefix, 'U', unsafeCount);
  const safeMarkerIds = numberedMarkers(prefix, 'S', safeCount);
  const neighborMarkerIds = numberedMarkers(prefix, 'N', neighborCount);
  return Object.freeze({
    testFiles: Object.freeze([...testFiles]),
    markerIds: Object.freeze([...unsafeMarkerIds, ...safeMarkerIds, ...neighborMarkerIds]),
    unsafeMarkerIds: Object.freeze(unsafeMarkerIds),
    safeMarkerIds: Object.freeze(safeMarkerIds),
    neighborMarkerIds: Object.freeze(neighborMarkerIds),
  });
}

const PREDECESSOR_TEST_FILES = [
  'tests/scripts/semantic-fingerprint.test.ts',
  'tests/scripts/semantic-history-provider.test.ts',
  'tests/scripts/semantic-history.test.ts',
  'tests/scripts/semantic-provenance.test.ts',
  'tests/scripts/semantic-quality-check.test.ts',
  'tests/scripts/semantic-boundary-eval.test.ts',
] as const;

const INTEGRATION_TEST_FILES = [
  'tests/scripts/semantic-boundary-contract.test.ts',
  'tests/scripts/semantic-rule-guidance.test.ts',
  'tests/scripts/semantic-quality-check.test.ts',
  'tests/scripts/semantic-history-provider.test.ts',
  'tests/scripts/semantic-history.test.ts',
  'tests/scripts/semantic-provenance.test.ts',
  'tests/scripts/semantic-boundary-eval.test.ts',
] as const;

type BoundaryTestContractId = keyof typeof RUN_TEST_CONTRACTS;

interface BoundaryVitestPredicateContract {
  mode: 'red' | 'green';
  testContractIds: readonly BoundaryTestContractId[];
  testFiles: readonly string[];
}

export const RUN_VITEST_PREDICATES: Readonly<Record<string, BoundaryVitestPredicateContract>> = Object.freeze({
  'bcf00-green': { mode: 'green', testContractIds: ['bcf00'], testFiles: RUN_TEST_CONTRACTS.bcf00.testFiles },
  'predecessor-focused': { mode: 'green', testContractIds: [], testFiles: PREDECESSOR_TEST_FILES },
  'bcf01-red': { mode: 'red', testContractIds: ['bcf01'], testFiles: RUN_TEST_CONTRACTS.bcf01.testFiles },
  'bcf01-green': { mode: 'green', testContractIds: ['bcf01'], testFiles: RUN_TEST_CONTRACTS.bcf01.testFiles },
  'bcf02-red': { mode: 'red', testContractIds: ['bcf02'], testFiles: RUN_TEST_CONTRACTS.bcf02.testFiles },
  'bcf02-green': { mode: 'green', testContractIds: ['bcf02'], testFiles: RUN_TEST_CONTRACTS.bcf02.testFiles },
  'bcf03-red': { mode: 'red', testContractIds: ['bcf03'], testFiles: RUN_TEST_CONTRACTS.bcf03.testFiles },
  'bcf03-green': { mode: 'green', testContractIds: ['bcf03'], testFiles: RUN_TEST_CONTRACTS.bcf03.testFiles },
  'bcf04-red': { mode: 'red', testContractIds: ['bcf04'], testFiles: RUN_TEST_CONTRACTS.bcf04.testFiles },
  'bcf04-green': { mode: 'green', testContractIds: ['bcf04'], testFiles: RUN_TEST_CONTRACTS.bcf04.testFiles },
  'bcf05-red': { mode: 'red', testContractIds: ['bcf05'], testFiles: RUN_TEST_CONTRACTS.bcf05.testFiles },
  'bcf05-green': { mode: 'green', testContractIds: ['bcf05'], testFiles: RUN_TEST_CONTRACTS.bcf05.testFiles },
  'bcf06-red': { mode: 'red', testContractIds: ['bcf06'], testFiles: RUN_TEST_CONTRACTS.bcf06.testFiles },
  'bcf06-green': { mode: 'green', testContractIds: ['bcf06'], testFiles: RUN_TEST_CONTRACTS.bcf06.testFiles },
  'bcf07-red': { mode: 'red', testContractIds: ['bcf07'], testFiles: RUN_TEST_CONTRACTS.bcf07.testFiles },
  'bcf07-green': {
    mode: 'green', testContractIds: ['bcf01', 'bcf02', 'bcf03', 'bcf04', 'bcf05', 'bcf06', 'bcf07'],
    testFiles: INTEGRATION_TEST_FILES,
  },
});

export function boundaryTestFilesForProfile(profileId: string): string[] {
  const profile = RUN_CONTRACT_PROFILES[profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (profile === undefined) return [];
  return [...new Set(profile.requiredAttemptIds.flatMap((id) => {
    const predicate = RUN_ATTEMPT_CONTRACTS[id]?.resultPredicate;
    return predicate === null || predicate === undefined ? [] : RUN_VITEST_PREDICATES[predicate]?.testFiles ?? [];
  }))].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export const RUN_EVAL_CONTRACTS = Object.freeze({
  'baseline-13-of-40': {
    engine: 'baseline', corpusPath: 'tests/fixtures/semantic-boundary-eval/cases.json',
    correct: 13, total: 40, falseBlocks: 0, missedCritical: 19, mismatchIds: null,
  },
  'candidate-39-of-40': {
    engine: 'candidate', corpusPath: 'tests/fixtures/semantic-boundary-eval/cases.json',
    correct: 39, total: 40, falseBlocks: 0, missedCritical: 0,
    mismatchIds: ['synthetic-issue-similar'],
  },
  'holdout-18-of-18': {
    engine: 'candidate', corpusPath: 'tests/fixtures/semantic-boundary-eval/holdout.json',
    correct: 18, total: 18, falseBlocks: 0, missedCritical: 0, mismatchIds: [],
  },
} as const);

export const BOUNDARY_SUPPORTED_RESULT_PREDICATES = Object.freeze([
  ...Object.keys(RUN_VITEST_PREDICATES),
  ...Object.keys(RUN_EVAL_CONTRACTS),
].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));

export const RUN_PREDECESSOR_CONTRACTS = {
  'bcf00-reconciliation': {
    taskId: 'BCF-00',
    predecessorTaskId: 'BCF-00',
    predecessorProfileId: 'bcf00-observation',
  },
  'bcf01-parser': {
    taskId: 'BCF-01',
    predecessorTaskId: 'BCF-00',
    predecessorProfileId: 'bcf00-reconciliation',
  },
  'bcf02-catalog': {
    taskId: 'BCF-02',
    predecessorTaskId: 'BCF-01',
    predecessorProfileId: 'bcf01-parser',
  },
  'bcf03-contract': {
    taskId: 'BCF-03',
    predecessorTaskId: 'BCF-02',
    predecessorProfileId: 'bcf02-catalog',
  },
  'bcf04-receipt': {
    taskId: 'BCF-04',
    predecessorTaskId: 'BCF-03',
    predecessorProfileId: 'bcf03-contract',
  },
  'bcf05-feedback': {
    taskId: 'BCF-05',
    predecessorTaskId: 'BCF-04',
    predecessorProfileId: 'bcf04-receipt',
  },
  'bcf06-provider': {
    taskId: 'BCF-06',
    predecessorTaskId: 'BCF-05',
    predecessorProfileId: 'bcf05-feedback',
  },
  'bcf07-integration': {
    taskId: 'BCF-07',
    predecessorTaskId: 'BCF-06',
    predecessorProfileId: 'bcf06-provider',
  },
  'bcf-review-contract': {
    taskId: 'BCF-REVIEW',
    predecessorTaskId: 'BCF-07',
    predecessorProfileId: 'bcf07-integration',
  },
  'bcf-review-redaction': {
    taskId: 'BCF-REVIEW',
    predecessorTaskId: 'BCF-07',
    predecessorProfileId: 'bcf07-integration',
  },
  'bcf-review-integration': {
    taskId: 'BCF-REVIEW',
    predecessorTaskId: 'BCF-07',
    predecessorProfileId: 'bcf07-integration',
  },
  'bcf-reproduction': {
    taskId: 'BCF-REPRODUCTION',
    predecessorTaskId: 'BCF-07',
    predecessorProfileId: 'bcf07-integration',
  },
  'bcf08a-docs': {
    taskId: 'BCF-08A',
    predecessorTaskId: 'BCF-07',
    predecessorProfileId: 'bcf07-integration',
  },
  'bcf08b-docs': {
    taskId: 'BCF-08B',
    predecessorTaskId: 'BCF-08A',
    predecessorProfileId: 'bcf08a-docs',
  },
  'bcf08-final': {
    taskId: 'BCF-08C',
    predecessorTaskId: 'BCF-08B',
    predecessorProfileId: 'bcf08b-docs',
  },
} as const;

export type BoundaryVerdict = 'Pass' | 'Fail' | 'Inconclusive' | 'Blocked';

export interface BoundaryValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface BoundaryValidationResult {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  verdict: BoundaryVerdict;
  issues: BoundaryValidationIssue[];
}

export interface BoundaryPathRecord {
  path: string;
  type: 'regular';
  mode: string;
  bytes: number;
  sha256: string;
}

export interface BoundaryWorktreeSnapshot {
  head: string;
  indexTreeOid: string;
  trackedPatchSha256: string;
  unstagedPatchSha256: string;
  allowedUntracked: BoundaryPathRecord[];
  preservedOwner: BoundaryPathRecord[];
  digestSha256: string;
}

export interface BoundarySnapshotDeclarations {
  allowedUntrackedPaths: readonly string[];
  preservedOwnerPaths: readonly string[];
}

export interface BoundarySnapshotCaptureResult {
  ok: boolean;
  snapshot: BoundaryWorktreeSnapshot | null;
  issues: BoundaryValidationIssue[];
}

export type BoundaryDerivedRootKind = 'run' | 'completion' | 'closeout' | 'closeout-failure';

export interface BoundaryDerivedRootReservation {
  kind: BoundaryDerivedRootKind;
  path: string;
  parentPath: string;
  parentDevice: number;
  parentInode: number;
  ancestors: Array<{ path: string; device: number; inode: number }>;
}

export interface BoundaryDerivedRootResult {
  ok: boolean;
  reservation: BoundaryDerivedRootReservation | null;
  record?: {
    kind: BoundaryDerivedRootKind;
    path: string;
    parentDevice: number;
    parentInode: number;
    state: 'created';
  };
  issues: BoundaryValidationIssue[];
}

export interface BoundaryAttemptStatus {
  expectedExit: string;
  rawExit: number | null;
  rawSignal: string | null;
  expectationMet: boolean;
  watchdogOwner: 'helper-watchdog' | null;
  innerTimeoutOwner: 'gnu-timeout' | null;
  deadlineMs: number;
  killGraceMs: number;
}

export type BoundaryAttemptStatusContract = Pick<
  BoundaryAttemptStatus,
  'expectedExit' | 'watchdogOwner' | 'innerTimeoutOwner' | 'deadlineMs' | 'killGraceMs'
>;

export type BoundaryArtifactRole =
  | 'input'
  | 'output'
  | 'receipt'
  | 'review'
  | 'lifecycle'
  | 'oracle'
  | 'scope'
  | 'measurement';

export interface BoundaryStreamRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BoundaryOutputAdmission {
  path: string;
  state: 'missing' | 'pending' | 'admitted';
  role: BoundaryArtifactRole | null;
  sha256: string | null;
  bytes: number | null;
}

export interface BoundaryAttemptRecord {
  id: string;
  operation: 'command' | 'internal-check' | 'git-transition';
  headAnchor: 'entry' | 'terminal' | 'transition';
  argv: string[];
  cwd: string;
  startedAtUtc: string;
  endedAtUtc: string;
  expectedExit: string;
  rawExit: number | null;
  rawSignal: string | null;
  expectationMet: boolean;
  watchdogOwner: 'helper-watchdog' | null;
  innerTimeoutOwner: null | 'gnu-timeout';
  deadlineMs: number;
  killGraceMs: number;
  preSnapshot: BoundaryWorktreeSnapshot;
  postSnapshot: BoundaryWorktreeSnapshot;
  stdout: BoundaryStreamRecord;
  stderr: BoundaryStreamRecord;
  declaredOutputs: string[];
  outputAdmissions: BoundaryOutputAdmission[];
  structuredResult: BoundaryStreamRecord | null;
  verdict: BoundaryVerdict;
}

export interface BoundaryArtifactRecord {
  path: string;
  role: BoundaryArtifactRole;
  producerAttemptId: string;
  sha256: string;
  bytes: number;
}

export interface BoundaryChildRecord {
  alias: string;
  kind: 'observation' | 'docs' | 'review' | 'reproduction' | 'predecessor';
  taskId: string;
  profileId: string;
  runId: string;
  entryHead: string;
  terminalHead: string;
  snapshotDigestSha256: string;
  sourceManifestSha256: string;
  importedFiles: BoundaryImportedFileRecord[];
  treeDigestSha256: string;
  overallVerdict: BoundaryVerdict;
  dedupeKey: string;
}

export interface BoundaryImportedFileRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BoundaryPredecessorPin {
  taskId: string;
  profileId: string;
  runId: string;
  terminalHead: string;
  manifestSha256: string;
  completionReceiptSha256: string;
  ledgerSha256: string;
}

export interface BoundaryPredecessorRecord {
  pin: BoundaryPredecessorPin;
  sourceManifestSha256: string;
  importedFiles: BoundaryImportedFileRecord[];
  treeDigestSha256: string;
  overallVerdict: BoundaryVerdict;
}

export interface BoundaryFindingRecord {
  findingId: string;
  severity: 'blocker' | 'critical' | 'major' | 'minor' | 'note';
  requiresFix: boolean;
  requiresReproduction: boolean;
  evidencePath: string;
  evidenceSha256: string;
  disposition: 'accepted' | 'rejected' | 'deferred';
  resolution: 'open' | 'fixed' | 'not-applicable';
  reason: string | null;
  counterevidenceRefs: string[];
  reproductionAttemptIds: string[];
  counterReproductionAttemptIds: string[];
  fixedAtHead: string | null;
  fixReproductionAttemptIds: string[];
  fixReviewId: string | null;
}

export interface BoundaryReviewRecord {
  reviewId: string;
  alias: string;
  dedupeKey: string;
  head: string;
  snapshotDigestSha256: string;
  reportPath: string;
  reportSha256: string;
  metaPath: string;
  metaSha256: string;
  stderrPath: string;
  stderrSha256: string;
  findings: BoundaryFindingRecord[];
  reproductionContracts: BoundaryReproductionContractRecord[];
}

export interface BoundaryReviewInputRecord extends Omit<BoundaryReviewRecord, 'alias'> {
  schemaVersion: 1;
}

export interface BoundaryReproductionContractRecord {
  attemptId: string;
  argv: string[];
  expectedExit: string;
  toolName: string;
  deadlineMs: 900000;
  killGraceMs: 30000;
}

export interface BoundaryLifecycleRecord {
  status: 'pending' | 'active' | 'completed' | 'deferred' | 'closed' | 'blocked';
  completionCommit: string | null;
  finalGate: 'not-run' | 'pass' | 'fail' | 'inconclusive' | 'blocked';
  artifactSha256: string | null;
  successor: string | null;
  supersededBy: string | null;
  oracle: 'not-applicable' | 'current' | 'superseded-invalid-oracle';
  branchDeletionAuthorized: false;
}

export interface BoundaryUpstreamRecord {
  remoteUrl: string | 'not-observed';
  observedOid: string | 'not-observed';
  mergeBase: string | 'not-observed';
  ahead: number | 'not-observed';
  behind: number | 'not-observed';
  remotePaths: string[];
  localPaths: string[];
  observationManifestSha256: string | 'not-observed';
  mergeCommit: string | 'not-observed';
  mergeParents: [] | [string, string];
}

export interface BoundaryToolRecord {
  name: string;
  realPath: string;
  version: string;
  sha256: string;
}

export interface BoundaryReservedDerivedRootRecord {
  kind: BoundaryDerivedRootKind;
  path: string;
  parentDevice: number;
  parentInode: number;
  state: 'reserved' | 'created';
}

export interface BoundaryChildPinRecord {
  alias: string;
  head: string;
  runId: string;
  manifestSha256: string;
}

export interface BoundaryRunRecord {
  runId: string;
  taskId: string;
  profileId: string;
  phase: string;
  createdAtUtc: string;
  finalizedAtUtc: string | null;
  entryHead: string;
  terminalHead: string | null;
  reconciledBase: string | 'not-observed';
  helperCommit: string;
  helperSha256: string;
  allowedPaths: string[];
  allowedUntrackedPaths: string[];
  preservedOwnerPaths: string[];
  requiredAttemptIds: string[];
  requiredChildAliases: string[];
  requiredChildPins: BoundaryChildPinRecord[];
  transitionCount: 0 | 1;
  mayComplete: boolean;
  chainAppend: boolean;
  requestedTools: string[];
  observedTools: BoundaryToolRecord[];
  reservedDerivedRoots: BoundaryReservedDerivedRootRecord[];
}

export interface BoundaryEntryTestRoster {
  files: Array<{ path: string; state: 'present' | 'absent'; testNames: string[] }>;
  digestSha256: string;
}

export interface BoundaryDocumentHashRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BoundaryRunManifest {
  schemaVersion: typeof BOUNDARY_RUN_SCHEMA;
  manifestState: 'active' | 'finalized' | 'verified-pass-closeout-rejected';
  run: BoundaryRunRecord;
  entrySnapshot: BoundaryWorktreeSnapshot;
  currentSnapshot: BoundaryWorktreeSnapshot;
  attempts: BoundaryAttemptRecord[];
  artifacts: BoundaryArtifactRecord[];
  children: BoundaryChildRecord[];
  predecessor: BoundaryPredecessorRecord | null;
  entryTestRoster: BoundaryEntryTestRoster;
  reviews: BoundaryReviewRecord[];
  lifecycle: BoundaryLifecycleRecord;
  documentHashes: {
    spec: BoundaryDocumentHashRecord;
    plan: BoundaryDocumentHashRecord;
    notes: BoundaryDocumentHashRecord;
    helper: BoundaryDocumentHashRecord;
  };
  upstream: BoundaryUpstreamRecord;
  overallVerdict: BoundaryVerdict;
}

export interface BoundaryRunInitAnchor {
  schemaVersion: typeof BOUNDARY_RUN_SCHEMA;
  runId: string;
  taskId: string;
  profileId: string;
  phase: string;
  createdAtUtc: string;
  entryHead: string;
  entrySnapshotDigestSha256: string;
  helperCommit: string;
  helperSha256: string;
  allowedPaths: string[];
  allowedUntrackedPaths: string[];
  preservedOwnerPaths: string[];
  requiredAttemptIds: string[];
  requiredChildAliases: string[];
  requiredChildPins: BoundaryChildPinRecord[];
  predecessorPin: BoundaryPredecessorPin | null;
  predecessorTreeDigestSha256: string | null;
  mayComplete: boolean;
  chainAppend: boolean;
  requestedTools: string[];
  observedTools: BoundaryToolRecord[];
  reservedDerivedRoots: BoundaryReservedDerivedRootRecord[];
  entryTestRosterDigestSha256: string;
  documentHashesDigestSha256: string;
}

export function createBoundaryRunInitAnchor(manifest: BoundaryRunManifest): BoundaryRunInitAnchor {
  return {
    schemaVersion: BOUNDARY_RUN_SCHEMA,
    runId: manifest.run.runId,
    taskId: manifest.run.taskId,
    profileId: manifest.run.profileId,
    phase: manifest.run.phase,
    createdAtUtc: manifest.run.createdAtUtc,
    entryHead: manifest.run.entryHead,
    entrySnapshotDigestSha256: manifest.entrySnapshot.digestSha256,
    helperCommit: manifest.run.helperCommit,
    helperSha256: manifest.run.helperSha256,
    allowedPaths: structuredClone(manifest.run.allowedPaths),
    allowedUntrackedPaths: structuredClone(manifest.run.allowedUntrackedPaths),
    preservedOwnerPaths: structuredClone(manifest.run.preservedOwnerPaths),
    requiredAttemptIds: structuredClone(manifest.run.requiredAttemptIds),
    requiredChildAliases: structuredClone(manifest.run.requiredChildAliases),
    requiredChildPins: structuredClone(manifest.run.requiredChildPins),
    predecessorPin: manifest.predecessor === null ? null : structuredClone(manifest.predecessor.pin),
    predecessorTreeDigestSha256: manifest.predecessor?.treeDigestSha256 ?? null,
    mayComplete: manifest.run.mayComplete,
    chainAppend: manifest.run.chainAppend,
    requestedTools: structuredClone(manifest.run.requestedTools),
    observedTools: structuredClone(manifest.run.observedTools),
    reservedDerivedRoots: structuredClone(manifest.run.reservedDerivedRoots),
    entryTestRosterDigestSha256: manifest.entryTestRoster.digestSha256,
    documentHashesDigestSha256: sha256Bytes(canonicalizeBoundaryRun(manifest.documentHashes)),
  };
}

function issue(code: string, message: string, path?: string): BoundaryValidationIssue {
  return path === undefined ? { code, message } : { code, message, path };
}

const ROOT_KEYS = [
  'schemaVersion',
  'manifestState',
  'run',
  'entrySnapshot',
  'currentSnapshot',
  'attempts',
  'artifacts',
  'children',
  'predecessor',
  'entryTestRoster',
  'reviews',
  'lifecycle',
  'documentHashes',
  'upstream',
  'overallVerdict',
] as const;

const RUN_INIT_ANCHOR_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'phase', 'createdAtUtc', 'entryHead',
  'entrySnapshotDigestSha256', 'helperCommit', 'helperSha256', 'allowedPaths',
  'allowedUntrackedPaths', 'preservedOwnerPaths', 'requiredAttemptIds', 'requiredChildAliases',
  'requiredChildPins', 'predecessorPin', 'predecessorTreeDigestSha256', 'mayComplete', 'chainAppend', 'requestedTools', 'observedTools',
  'reservedDerivedRoots', 'entryTestRosterDigestSha256', 'documentHashesDigestSha256',
] as const;

const RUN_KEYS = [
  'runId', 'taskId', 'profileId', 'phase', 'createdAtUtc', 'finalizedAtUtc', 'entryHead',
  'terminalHead', 'reconciledBase', 'helperCommit', 'helperSha256', 'allowedPaths',
  'allowedUntrackedPaths', 'preservedOwnerPaths', 'requiredAttemptIds', 'requiredChildAliases',
  'requiredChildPins', 'transitionCount', 'mayComplete', 'chainAppend', 'requestedTools', 'observedTools',
  'reservedDerivedRoots',
] as const;

const SNAPSHOT_KEYS = [
  'head', 'indexTreeOid', 'trackedPatchSha256', 'unstagedPatchSha256', 'allowedUntracked',
  'preservedOwner', 'digestSha256',
] as const;

const ENTRY_TEST_ROSTER_KEYS = ['files', 'digestSha256'] as const;
const LIFECYCLE_KEYS = [
  'status', 'completionCommit', 'finalGate', 'artifactSha256', 'successor', 'supersededBy',
  'oracle', 'branchDeletionAuthorized',
] as const;
const DOCUMENT_HASH_KEYS = ['spec', 'plan', 'notes', 'helper'] as const;
const UPSTREAM_KEYS = [
  'remoteUrl', 'observedOid', 'mergeBase', 'ahead', 'behind', 'remotePaths', 'localPaths',
  'observationManifestSha256', 'mergeCommit', 'mergeParents',
] as const;
const SNAPSHOT_PATH_KEYS = ['path', 'type', 'mode', 'bytes', 'sha256'] as const;
const ATTEMPT_KEYS = [
  'id', 'operation', 'headAnchor', 'argv', 'cwd', 'startedAtUtc', 'endedAtUtc', 'expectedExit',
  'rawExit', 'rawSignal', 'expectationMet', 'watchdogOwner', 'innerTimeoutOwner', 'deadlineMs',
  'killGraceMs', 'preSnapshot', 'postSnapshot', 'stdout', 'stderr', 'declaredOutputs',
  'outputAdmissions', 'structuredResult', 'verdict',
] as const;
const STREAM_KEYS = ['path', 'sha256', 'bytes'] as const;
const OUTPUT_ADMISSION_KEYS = ['path', 'state', 'role', 'sha256', 'bytes'] as const;
const ARTIFACT_KEYS = ['path', 'role', 'producerAttemptId', 'sha256', 'bytes'] as const;
const CHILD_KEYS = [
  'alias', 'kind', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead',
  'snapshotDigestSha256', 'sourceManifestSha256', 'importedFiles', 'treeDigestSha256',
  'overallVerdict', 'dedupeKey',
] as const;
const CHILD_PIN_KEYS = ['alias', 'head', 'runId', 'manifestSha256'] as const;
const IMPORTED_FILE_KEYS = ['path', 'sha256', 'bytes'] as const;
const PREDECESSOR_KEYS = ['pin', 'sourceManifestSha256', 'importedFiles', 'treeDigestSha256', 'overallVerdict'] as const;
const PREDECESSOR_PIN_KEYS = [
  'taskId', 'profileId', 'runId', 'terminalHead', 'manifestSha256', 'completionReceiptSha256',
  'ledgerSha256',
] as const;
const TEST_ROSTER_FILE_KEYS = ['path', 'state', 'testNames'] as const;
const REVIEW_KEYS = [
  'reviewId', 'alias', 'dedupeKey', 'head', 'snapshotDigestSha256', 'reportPath', 'reportSha256',
  'metaPath', 'metaSha256', 'stderrPath', 'stderrSha256', 'findings', 'reproductionContracts',
] as const;
const REVIEW_INPUT_KEYS = [
  'schemaVersion', 'reviewId', 'dedupeKey', 'head', 'snapshotDigestSha256', 'reportPath',
  'reportSha256', 'metaPath', 'metaSha256', 'stderrPath', 'stderrSha256', 'findings',
  'reproductionContracts',
] as const;
const FINDING_KEYS = [
  'findingId', 'severity', 'requiresFix', 'requiresReproduction', 'evidencePath',
  'evidenceSha256', 'disposition', 'resolution', 'reason', 'counterevidenceRefs',
  'reproductionAttemptIds', 'counterReproductionAttemptIds', 'fixedAtHead',
  'fixReproductionAttemptIds', 'fixReviewId',
] as const;
const REPRODUCTION_CONTRACT_KEYS = [
  'attemptId', 'argv', 'expectedExit', 'toolName', 'deadlineMs', 'killGraceMs',
] as const;
const DOCUMENT_HASH_ROW_KEYS = ['path', 'sha256', 'bytes'] as const;
const TOOL_KEYS = ['name', 'realPath', 'version', 'sha256'] as const;
const RESERVED_DERIVED_ROOT_KEYS = ['kind', 'path', 'parentDevice', 'parentInode', 'state'] as const;
const COMPLETION_RECEIPT_KEYS = [
  'schemaVersion', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead', 'manifestSha256',
  'manifestLockSha256', 'ledgerSha256', 'predecessorReceiptSha256', 'predecessorLedgerSha256',
  'reconciledBase', 'upstreamObservedOid', 'corpusDigests', 'oracleDigest', 'lifecycleStatus',
  'finalGate', 'overallVerdict',
] as const;
const CHAIN_LEDGER_KEYS = [
  'schemaVersion', 'rows', 'reconciledBase', 'upstreamObservedOid', 'corpusDigests', 'oracleDigest',
] as const;
const CHAIN_ROW_KEYS = [
  'ordinal', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead', 'manifestSha256',
  'previousLedgerSha256', 'overallVerdict',
] as const;
const CORPUS_DIGEST_KEYS = ['cases', 'holdout'] as const;
const CLOSEOUT_CORE_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'terminalHead', 'snapshotDigestSha256',
  'helperCommit', 'helperSha256', 'runManifestSha256', 'runManifestLockSha256',
  'finalizeRawExit', 'finalizeRawSignal', 'verifyRawExit', 'verifyRawSignal',
  'completionReceiptSha256', 'completionReceiptLockSha256', 'ledgerSha256', 'ledgerLockSha256',
  'startedAtUtc', 'endedAtUtc', 'lifecycleStatus', 'requiredAttemptIds', 'requiredChildAliases',
  'internalStatus', 'overallVerdict',
] as const;
const CLOSEOUT_INTERNAL_STATUS_KEYS = [
  'stage', 'rawExit', 'rawSignal', 'expectationMet', 'verdict',
] as const;
const CLOSEOUT_NEGATIVE_REPORT_KEYS = [
  'schemaVersion', 'runId', 'closeoutCoreSha256', 'cases', 'startedAtUtc', 'endedAtUtc',
  'overallVerdict',
] as const;
const CLOSEOUT_NEGATIVE_CASE_KEYS = [
  'ordinal', 'mutationId', 'fixturePath', 'expectedReasonCode', 'rawExit', 'rawSignal',
  'expectationMet', 'stdoutSha256', 'stderrSha256', 'treeDigestSha256', 'verdict',
] as const;
const CLOSEOUT_RECEIPT_KEYS = [
  'schemaVersion', 'kind', 'runId', 'taskId', 'profileId', 'terminalHead',
  'snapshotDigestSha256', 'helperCommit', 'helperSha256', 'runManifestSha256',
  'runManifestLockSha256', 'finalizeRawExit', 'finalizeRawSignal', 'verifyRawExit',
  'verifyRawSignal', 'completionReceiptSha256', 'completionReceiptLockSha256', 'ledgerSha256',
  'ledgerLockSha256', 'startedAtUtc', 'endedAtUtc', 'lifecycleStatus', 'requiredAttemptIds',
  'requiredChildAliases', 'closeoutCoreSha256', 'negativeControlReportSha256', 'failedStage',
  'runVerdict', 'rawExit', 'rawSignal', 'reasonCode', 'manifestState', 'overallVerdict',
] as const;
const READINESS_RECORD_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'head', 'snapshotDigestSha256',
  'readinessState', 'evaluatedAtUtc', 'evidence', 'assumptions', 'risks', 'blockers',
  'decisionRationale', 'decisionAuthority', 'nextAllowedAction', 'overallVerdict',
] as const;
const READINESS_EVIDENCE_KEYS = [
  'evidenceId', 'artifactPath', 'producerAttemptId', 'sha256', 'verdict',
] as const;
const READINESS_ASSUMPTION_KEYS = ['assumptionId', 'disposition', 'evidenceRefs'] as const;
const READINESS_RISK_KEYS = [
  'riskId', 'owner', 'checkpoint', 'artifactPath', 'artifactSha256', 'stopCondition',
] as const;
const READINESS_BLOCKER_KEYS = ['blockerId', 'reason', 'evidenceRefs'] as const;
const CONSUMER_VERSION_DECISION_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'head', 'snapshotDigestSha256',
  'packageVersion', 'currentProducerSchema', 'proposedProducerSchema', 'supportStage',
  'inventoryQuerySha256', 'inventoryMatches', 'localConsumers', 'externalConsumers',
  'compatibilityReader', 'rollbackCommit', 'decision', 'releaseNoteRequired', 'limitations',
  'overallVerdict',
] as const;
const CONSUMER_INVENTORY_MATCH_KEYS = [
  'path', 'line', 'column', 'matchKind', 'matchedToken', 'lineSha256',
] as const;
const LOCAL_CONSUMER_KEYS = [
  'consumerId', 'kind', 'path', 'symbol', 'schemaSupport', 'matchRefs',
] as const;
const FEEDBACK_MEASUREMENTS_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'producerAttemptId', 'head',
  'snapshotDigestSha256', 'tokenSha256', 'budgets', 'scenarios', 'overallVerdict',
] as const;
const BOUNDARY_BUDGET_KEYS = [
  'maxFindings', 'maxObservedPerFinding', 'maxArtifactsPerFinding',
  'maxLimitationsPerFinding', 'maxTopLevelLimitations', 'maxFingerprints',
  'maxCanonicalRecords', 'maxCorrectionsPerFinding', 'maxVerificationPerFinding',
  'maxSourcesPerFinding', 'maxPublicTextBytes', 'maxJsonBytes', 'maxHumanBytes',
  'maxHumanReservedSummaryBytes', 'maxHumanDetailedFindings',
] as const;
const FEEDBACK_SCENARIO_KEYS = [
  'ordinal', 'scenario', 'subject', 'inputBytes', 'limitBytes', 'humanBytes', 'jsonBytes',
  'detailedFindings', 'omittedFindings', 'renderedObservations', 'omittedObservations',
  'evidenceDigestSha256', 'descriptorDigestSha256', 'expectedDisposition',
  'observedDisposition',
] as const;
const EXPECTED_BOUNDARY_BUDGETS = {
  maxFindings: 128,
  maxObservedPerFinding: 64,
  maxArtifactsPerFinding: 16,
  maxLimitationsPerFinding: 8,
  maxTopLevelLimitations: 16,
  maxFingerprints: 64,
  maxCanonicalRecords: 2_048,
  maxCorrectionsPerFinding: 4,
  maxVerificationPerFinding: 8,
  maxSourcesPerFinding: 16,
  maxPublicTextBytes: 512,
  maxJsonBytes: 1024 * 1024,
  maxHumanBytes: 64 * 1024,
  maxHumanReservedSummaryBytes: 16 * 1024,
  maxHumanDetailedFindings: 12,
} as const;
const DOCS_LINEAGE_REPORT_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'head', 'snapshotDigestSha256',
  'anchors', 'operations', 'pathClasses', 'bEntryIdentity', 'overallVerdict',
] as const;
const DOCS_LINEAGE_ANCHOR_KEYS = [
  'validatorBase', 'validatorCommit', 'upstreamMerge', 'upstreamFirstParent',
  'upstreamSecondParent', 'originMain', 'reconciledBase', 'docsEntryHead', 'docsCurrentHead',
] as const;
const DOCS_LINEAGE_OPERATION_KEYS = [
  'ordinal', 'operationId', 'argv', 'rawExit', 'rawSignal', 'stdoutSha256', 'stderrSha256',
  'parsedOids', 'parsedPaths', 'expectationMet', 'verdict',
] as const;
const DOCS_LINEAGE_PATH_CLASS_KEYS = ['path', 'status', 'source'] as const;
const DOCS_B_ENTRY_IDENTITY_KEYS = [
  'snapshotDigestSha256', 'publicSurfaceSha256', 'publicationAuditSha256', 'handoffSha256',
  'workIndexJsonSha256', 'workIndexMarkdownSha256',
] as const;
const MERGE_CONFLICT_RESOLUTION_REPORT_KEYS = [
  'schemaVersion', 'policy', 'beforeHead', 'expectedSecondParent', 'conflictPaths',
  'indexStages', 'generatorArgv', 'generatorRawExit', 'generatorRawSignal', 'resolvedPaths',
  'unmergedPaths', 'conflictMarkerPaths', 'diffCheckRawExit', 'diffCheckRawSignal',
  'workIndexGuardRawExit', 'workIndexGuardRawSignal', 'preStateDigestSha256',
  'resolvedStateDigestSha256', 'verdict',
] as const;
const MERGE_CONFLICT_INDEX_STAGE_KEYS = ['path', 'stage', 'mode', 'oid'] as const;

export const RUN_WIRE_SCHEMAS = {
  RunManifest: ROOT_KEYS,
  RunInitAnchor: RUN_INIT_ANCHOR_KEYS,
  run: RUN_KEYS,
  snapshot: SNAPSHOT_KEYS,
  snapshotPath: SNAPSHOT_PATH_KEYS,
  attempt: ATTEMPT_KEYS,
  stream: STREAM_KEYS,
  outputAdmission: OUTPUT_ADMISSION_KEYS,
  artifact: ARTIFACT_KEYS,
  child: CHILD_KEYS,
  childPin: CHILD_PIN_KEYS,
  importedFile: IMPORTED_FILE_KEYS,
  predecessor: PREDECESSOR_KEYS,
  predecessorPin: PREDECESSOR_PIN_KEYS,
  entryTestRoster: ENTRY_TEST_ROSTER_KEYS,
  testRosterFile: TEST_ROSTER_FILE_KEYS,
  reviewInput: REVIEW_INPUT_KEYS,
  review: REVIEW_KEYS,
  finding: FINDING_KEYS,
  reproductionContract: REPRODUCTION_CONTRACT_KEYS,
  lifecycle: LIFECYCLE_KEYS,
  documentHashes: DOCUMENT_HASH_KEYS,
  documentHash: DOCUMENT_HASH_ROW_KEYS,
  upstream: UPSTREAM_KEYS,
  tool: TOOL_KEYS,
  reservedDerivedRoot: RESERVED_DERIVED_ROOT_KEYS,
  CompletionReceipt: COMPLETION_RECEIPT_KEYS,
  ChainLedger: CHAIN_LEDGER_KEYS,
  ChainRow: CHAIN_ROW_KEYS,
  corpusDigests: CORPUS_DIGEST_KEYS,
  ReadinessRecord: READINESS_RECORD_KEYS,
  readinessEvidence: READINESS_EVIDENCE_KEYS,
  readinessAssumption: READINESS_ASSUMPTION_KEYS,
  readinessRisk: READINESS_RISK_KEYS,
  readinessBlocker: READINESS_BLOCKER_KEYS,
  ConsumerVersionDecision: CONSUMER_VERSION_DECISION_KEYS,
  consumerInventoryMatch: CONSUMER_INVENTORY_MATCH_KEYS,
  localConsumer: LOCAL_CONSUMER_KEYS,
  FeedbackMeasurements: FEEDBACK_MEASUREMENTS_KEYS,
  boundaryBudgets: BOUNDARY_BUDGET_KEYS,
  feedbackScenario: FEEDBACK_SCENARIO_KEYS,
  DocsLineageReport: DOCS_LINEAGE_REPORT_KEYS,
  docsLineageAnchors: DOCS_LINEAGE_ANCHOR_KEYS,
  docsLineageOperation: DOCS_LINEAGE_OPERATION_KEYS,
  docsLineagePathClass: DOCS_LINEAGE_PATH_CLASS_KEYS,
  docsBEntryIdentity: DOCS_B_ENTRY_IDENTITY_KEYS,
  MergeConflictResolutionReport: MERGE_CONFLICT_RESOLUTION_REPORT_KEYS,
  mergeConflictIndexStage: MERGE_CONFLICT_INDEX_STAGE_KEYS,
  CloseoutCore: CLOSEOUT_CORE_KEYS,
  CloseoutInternalStatus: CLOSEOUT_INTERNAL_STATUS_KEYS,
  CloseoutNegativeReport: CLOSEOUT_NEGATIVE_REPORT_KEYS,
  CloseoutNegativeCase: CLOSEOUT_NEGATIVE_CASE_KEYS,
  CloseoutReceipt: CLOSEOUT_RECEIPT_KEYS,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function requireExactObject(
  parent: Record<string, unknown>,
  key: string,
  expected: readonly string[],
  issues: BoundaryValidationIssue[],
): void {
  const value = parent[key];
  if (!isRecord(value) || !hasExactKeys(value, expected)) {
    issues.push(issue(`invalid-${key}-keys`, `${key} keys must be exactly: ${expected.join(', ')}`, key));
  }
}

function requireExactRecord(
  value: unknown,
  expected: readonly string[],
  issues: BoundaryValidationIssue[],
  code: string,
  path: string,
): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, expected)) {
    issues.push(issue(code, `${path} keys must be exactly: ${expected.join(', ')}`, path));
    return false;
  }
  return true;
}

function requireRows(
  value: unknown,
  expected: readonly string[],
  issues: BoundaryValidationIssue[],
  code: string,
  path: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    issues.push(issue(code, `${path} must be an array`, path));
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const [index, row] of value.entries()) {
    if (requireExactRecord(row, expected, issues, code, `${path}[${index}]`)) rows.push(row);
  }
  return rows;
}

function validateSnapshotShape(value: unknown, issues: BoundaryValidationIssue[], path: string): void {
  if (!requireExactRecord(value, SNAPSHOT_KEYS, issues, 'invalid-snapshot-keys', path)) return;
  requireRows(value['allowedUntracked'], SNAPSHOT_PATH_KEYS, issues, 'invalid-snapshot-path-keys', `${path}.allowedUntracked`);
  requireRows(value['preservedOwner'], SNAPSHOT_PATH_KEYS, issues, 'invalid-snapshot-path-keys', `${path}.preservedOwner`);
}

function validateImportedFiles(value: unknown, issues: BoundaryValidationIssue[], path: string): void {
  requireRows(value, IMPORTED_FILE_KEYS, issues, 'invalid-imported-file-keys', path);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isSafePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > 1_024) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function check(condition: boolean, issues: BoundaryValidationIssue[], code: string, path: string): void {
  if (!condition) issues.push(issue(code, `${path} violates the closed wire contract`, path));
}

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBytes(cwd: string, args: readonly string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    env: cleanGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitText(cwd: string, args: readonly string[]): string {
  return gitBytes(cwd, args).toString('utf8').trim();
}

function validateDeclarationSet(
  values: readonly string[],
  name: string,
  issues: BoundaryValidationIssue[],
): void {
  const sorted = [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (new Set(values).size !== values.length || values.some((value) => !isSafePath(value))) {
    issues.push(issue('snapshot-invalid-declaration', `${name} must contain unique normalized repository paths`, name));
  }
  if (values.some((value, index) => value !== sorted[index])) {
    issues.push(issue('snapshot-invalid-declaration-order', `${name} must be sorted by UTF-8 bytes`, name));
  }
}

function capturePathRecord(repo: string, repoPath: string): BoundaryPathRecord {
  const absolute = path.resolve(repo, repoPath);
  const relative = path.relative(repo, absolute).split(path.sep).join('/');
  if (relative !== repoPath || relative.startsWith('../')) throw new Error(`${repoPath} escapes the repository`);
  const stat = lstatSync(absolute);
  if (!stat.isFile()) throw new Error(`${repoPath} is not a regular file`);
  const bytes = readFileSync(absolute);
  return {
    path: repoPath,
    type: 'regular',
    mode: stat.mode.toString(8).padStart(6, '0').slice(-6),
    bytes: stat.size,
    sha256: sha256Bytes(bytes),
  };
}

function snapshotResult(issues: BoundaryValidationIssue[]): BoundaryValidationResult {
  return {
    ok: issues.length === 0,
    exitCode: issues.length === 0 ? 0 : 1,
    verdict: issues.length === 0 ? 'Pass' : 'Inconclusive',
    issues,
  };
}

function isOperationalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function isBoundedText(value: unknown, maxBytes = 4_096): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isVerdict(value: unknown): value is BoundaryVerdict {
  return value === 'Pass' || value === 'Fail' || value === 'Inconclusive' || value === 'Blocked';
}

function hasDirectStatus(rawExit: unknown, rawSignal: unknown, expectedExit: number | null = null): boolean {
  const exitValid = Number.isInteger(rawExit) && Number(rawExit) >= 0 && Number(rawExit) <= 255;
  const signalValid = typeof rawSignal === 'string' && /^SIG[A-Z0-9]+$/.test(rawSignal);
  if (Number(exitValid) + Number(signalValid) !== 1) return false;
  return expectedExit === null || (rawExit === expectedExit && rawSignal === null);
}

const PINNED_GENERATED_INDEX_PARENT = '5d16cd401e1250f417f7bde481a4cc8b0ad1df55';
const GENERATED_INDEX_PATHS = ['docs/work-index.json', 'docs/work-index.md'] as const;
const GENERATED_INDEX_ARGV = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen'] as const;

export function validateBoundaryStructuredRecord(
  schema: keyof typeof RUN_WIRE_SCHEMAS,
  value: Record<string, unknown>,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const keys = RUN_WIRE_SCHEMAS[schema];
  if (keys === undefined || !hasExactKeys(value, keys)) {
    return snapshotResult([issue('structured-record-shape', `${schema} has a missing or foreign key`)]);
  }
  if (value['schemaVersion'] !== 1) {
    issues.push(issue('structured-record-version', `${schema} requires schemaVersion 1`, 'schemaVersion'));
  }

  if (schema === 'ReadinessRecord') {
    const evidence = requireRows(value['evidence'], READINESS_EVIDENCE_KEYS, issues, 'structured-record-shape', 'evidence');
    const assumptions = requireRows(value['assumptions'], READINESS_ASSUMPTION_KEYS, issues, 'structured-record-shape', 'assumptions');
    const risks = requireRows(value['risks'], READINESS_RISK_KEYS, issues, 'structured-record-shape', 'risks');
    const blockers = requireRows(value['blockers'], READINESS_BLOCKER_KEYS, issues, 'structured-record-shape', 'blockers');
    check(isOperationalId(value['runId']) && value['taskId'] === 'BCF-00' && value['profileId'] === 'bcf00-reconciliation', issues, 'readiness-identity-invalid', 'identity');
    check(isOid(value['head']) && isSha256(value['snapshotDigestSha256']) && isTimestamp(value['evaluatedAtUtc']), issues, 'readiness-identity-invalid', 'head');
    check(isBoundedText(value['decisionRationale']) && value['decisionAuthority'] === 'implementation-lead', issues, 'readiness-decision-invalid', 'decision');
    const evidenceIds = evidence.map((row) => row['evidenceId']);
    check(isSortedUniqueStrings(evidenceIds, isOperationalId), issues, 'readiness-evidence-invalid', 'evidence');
    for (const row of evidence) {
      check(
        isOperationalId(row['evidenceId']) && isOperationalId(row['producerAttemptId'])
          && isSafePath(row['artifactPath']) && isSha256(row['sha256']) && isVerdict(row['verdict']),
        issues, 'readiness-evidence-invalid', String(row['evidenceId']),
      );
    }
    const expectedAssumptions = ['A-08', 'A-09', 'A-10'];
    check(
      assumptions.length === 3 && assumptions.every((row, index) => row['assumptionId'] === expectedAssumptions[index]),
      issues, 'readiness-assumption-invalid', 'assumptions',
    );
    for (const row of assumptions) {
      check(
        (row['disposition'] === 'validated' || row['disposition'] === 'blocked')
          && isSortedUniqueStrings(row['evidenceRefs'], isOperationalId)
          && (row['evidenceRefs'] as string[]).every((entry) => evidenceIds.includes(entry)),
        issues, 'readiness-assumption-invalid', String(row['assumptionId']),
      );
    }
    const riskIds = risks.map((row) => row['riskId']);
    check(isSortedUniqueStrings(riskIds, isOperationalId), issues, 'readiness-risk-invalid', 'risks');
    for (const row of risks) {
      const evidenceRow = evidence.find((entry) => entry['artifactPath'] === row['artifactPath']);
      check(
        isOperationalId(row['riskId']) && isBoundedText(row['owner'], 512)
          && isBoundedText(row['checkpoint'], 1_024) && isSafePath(row['artifactPath'])
          && isSha256(row['artifactSha256']) && isBoundedText(row['stopCondition'], 1_024)
          && evidenceRow?.['sha256'] === row['artifactSha256'],
        issues, 'readiness-risk-invalid', String(row['riskId']),
      );
    }
    const blockerIds = blockers.map((row) => row['blockerId']);
    check(isSortedUniqueStrings(blockerIds, isOperationalId), issues, 'readiness-blocker-invalid', 'blockers');
    for (const row of blockers) {
      check(
        isOperationalId(row['blockerId']) && isBoundedText(row['reason'])
          && isSortedUniqueStrings(row['evidenceRefs'], isOperationalId)
          && (row['evidenceRefs'] as string[]).every((entry) => evidenceIds.includes(entry)),
        issues, 'readiness-blocker-invalid', String(row['blockerId']),
      );
    }
    const ready = value['readinessState'] === 'Ready with Constraints';
    if (ready) {
      check(assumptions.every((row) => row['disposition'] === 'validated') && blockers.length === 0 && risks.length > 0, issues, 'readiness-decision-invalid', 'readinessState');
      check(value['nextAllowedAction'] === 'BCF-01' && value['overallVerdict'] === 'Pass', issues, 'readiness-decision-invalid', 'overallVerdict');
    } else {
      check(value['readinessState'] === 'Not Ready' && value['nextAllowedAction'] === null && value['overallVerdict'] !== 'Pass' && isVerdict(value['overallVerdict']), issues, 'readiness-decision-invalid', 'readinessState');
      check(blockers.length > 0 || assumptions.some((row) => row['disposition'] === 'blocked'), issues, 'readiness-decision-invalid', 'blockers');
    }
  } else if (schema === 'ConsumerVersionDecision') {
    const matches = requireRows(value['inventoryMatches'], CONSUMER_INVENTORY_MATCH_KEYS, issues, 'structured-record-shape', 'inventoryMatches');
    const consumers = requireRows(value['localConsumers'], LOCAL_CONSUMER_KEYS, issues, 'structured-record-shape', 'localConsumers');
    check(
      value['packageVersion'] === '0.1.0' && value['currentProducerSchema'] === 1
        && value['proposedProducerSchema'] === 2 && value['supportStage'] === 'beta-shadow-only'
        && value['externalConsumers'] === 'unknown' && value['compatibilityReader'] === 'schema-1-read-render'
        && value['decision'] === 'pre-1.0-shadow-compatible' && value['releaseNoteRequired'] === false
        && canonicalizeBoundaryRun(value['limitations']) === canonicalizeBoundaryRun(['external-consumers-unknown'])
        && value['overallVerdict'] === 'Pass',
      issues, 'consumer-decision-invalid', 'decision',
    );
    const inventoryQuery = [
      'rg', '-n', 'buildBoundaryReceipt\\(|buildSemanticReceipt\\(|schemaVersion',
      'scripts', 'tests', 'docs', '--glob', '*.ts', '--glob', '*.md',
    ];
    check(isOid(value['head']) && isOid(value['rollbackCommit']) && isSha256(value['snapshotDigestSha256']) && value['inventoryQuerySha256'] === sha256Bytes(canonicalizeBoundaryRun(inventoryQuery)), issues, 'consumer-decision-invalid', 'identity');
    const refs = new Set<string>();
    for (const row of matches) {
      const ref = `${String(row['path'])}:${String(row['line'])}:${String(row['column'])}:${String(row['matchKind'])}:${String(row['matchedToken'])}`;
      check(isSafePath(row['path']) && Number.isSafeInteger(row['line']) && Number(row['line']) > 0 && Number.isSafeInteger(row['column']) && Number(row['column']) > 0 && ['producer-call', 'compatibility-read', 'schema-reference'].includes(String(row['matchKind'])) && isBoundedText(row['matchedToken'], 512) && isSha256(row['lineSha256']) && !refs.has(ref), issues, 'consumer-inventory-invalid', ref);
      refs.add(ref);
    }
    const claimedRefs: string[] = [];
    for (const row of consumers) {
      check(isOperationalId(row['consumerId']) && ['producer', 'reader', 'test', 'documentation'].includes(String(row['kind'])) && isSafePath(row['path']) && isBoundedText(row['symbol'], 512) && ['schema-1', 'schema-1-read-schema-2-write', 'schema-1-and-2'].includes(String(row['schemaSupport'])) && isSortedUniqueStrings(row['matchRefs'], (entry) => typeof entry === 'string' && refs.has(entry)), issues, 'consumer-inventory-invalid', String(row['consumerId']));
      claimedRefs.push(...(Array.isArray(row['matchRefs']) ? row['matchRefs'] as string[] : []));
    }
    check(claimedRefs.length === refs.size && new Set(claimedRefs).size === claimedRefs.length, issues, 'consumer-inventory-invalid', 'localConsumers.matchRefs');
  } else if (schema === 'FeedbackMeasurements') {
    if (!requireExactRecord(value['budgets'], BOUNDARY_BUDGET_KEYS, issues, 'structured-record-shape', 'budgets')) return snapshotResult(issues);
    const scenarios = requireRows(value['scenarios'], FEEDBACK_SCENARIO_KEYS, issues, 'structured-record-shape', 'scenarios');
    check(canonicalizeBoundaryRun(value['budgets']) === canonicalizeBoundaryRun(EXPECTED_BOUNDARY_BUDGETS), issues, 'feedback-budget-invalid', 'budgets');
    const expectedScenarios = ['ordinary', 'human-at-limit', 'human-one-over', 'json-at-limit', 'json-one-over', 'multibyte'];
    check(scenarios.length === expectedScenarios.length && scenarios.every((row, index) => row['ordinal'] === index + 1 && row['scenario'] === expectedScenarios[index]), issues, 'feedback-scenario-invalid', 'scenarios');
    for (const row of scenarios) {
      check(['aggregate', 'public-text', 'canonical-json', 'utf8-text'].includes(String(row['subject'])) && ['inputBytes', 'limitBytes', 'humanBytes', 'jsonBytes', 'detailedFindings', 'omittedFindings', 'renderedObservations', 'omittedObservations'].every((key) => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) && isSha256(row['evidenceDigestSha256']) && isSha256(row['descriptorDigestSha256']) && ['accepted', 'diagnostic-inconclusive'].includes(String(row['expectedDisposition'])) && row['observedDisposition'] === row['expectedDisposition'], issues, 'feedback-scenario-invalid', String(row['scenario']));
      check(Number(row['humanBytes']) <= EXPECTED_BOUNDARY_BUDGETS.maxHumanBytes && Number(row['jsonBytes']) <= EXPECTED_BOUNDARY_BUDGETS.maxJsonBytes && Number(row['detailedFindings']) <= EXPECTED_BOUNDARY_BUDGETS.maxHumanDetailedFindings, issues, 'feedback-budget-invalid', String(row['scenario']));
    }
    const scenarioByName = new Map(scenarios.map((row) => [row['scenario'], row]));
    const exactLimit = (name: string, limit: number, delta: 0 | 1, disposition: string): void => {
      const row = scenarioByName.get(name);
      check(row !== undefined && row['inputBytes'] === limit + delta && row['limitBytes'] === limit && row['expectedDisposition'] === disposition, issues, 'feedback-budget-invalid', name);
    };
    exactLimit('human-at-limit', EXPECTED_BOUNDARY_BUDGETS.maxHumanBytes, 0, 'accepted');
    exactLimit('human-one-over', EXPECTED_BOUNDARY_BUDGETS.maxHumanBytes, 1, 'diagnostic-inconclusive');
    exactLimit('json-at-limit', EXPECTED_BOUNDARY_BUDGETS.maxJsonBytes, 0, 'accepted');
    exactLimit('json-one-over', EXPECTED_BOUNDARY_BUDGETS.maxJsonBytes, 1, 'diagnostic-inconclusive');
    check(scenarioByName.get('ordinary')?.['expectedDisposition'] === 'accepted' && scenarioByName.get('multibyte')?.['subject'] === 'utf8-text', issues, 'feedback-scenario-invalid', 'semantic-order');
    check(value['producerAttemptId'] === 'feedback-green' && isOid(value['head']) && isSha256(value['snapshotDigestSha256']) && isSha256(value['tokenSha256']) && value['overallVerdict'] === 'Pass', issues, 'feedback-measurement-invalid', 'identity');
  } else if (schema === 'DocsLineageReport') {
    const operations = requireRows(value['operations'], DOCS_LINEAGE_OPERATION_KEYS, issues, 'structured-record-shape', 'operations');
    const pathClasses = requireRows(value['pathClasses'], DOCS_LINEAGE_PATH_CLASS_KEYS, issues, 'structured-record-shape', 'pathClasses');
    if (requireExactRecord(value['anchors'], DOCS_LINEAGE_ANCHOR_KEYS, issues, 'structured-record-shape', 'anchors')) {
      check(Object.values(value['anchors']).every(isOid), issues, 'docs-lineage-anchor-invalid', 'anchors');
    }
    if (requireExactRecord(value['bEntryIdentity'], DOCS_B_ENTRY_IDENTITY_KEYS, issues, 'structured-record-shape', 'bEntryIdentity')) {
      check(Object.values(value['bEntryIdentity']).every(isSha256), issues, 'docs-lineage-identity-invalid', 'bEntryIdentity');
    }
    const operationIds = ['diff-check', 'status-short', 'validator-endpoints', 'validator-name-status', 'validator-stat', 'merge-origin', 'upstream-name-status', 'upstream-stat', 'authored-name-status', 'authored-stat'];
    check(operations.length === 10 && operations.every((row, index) => row['ordinal'] === index + 1 && row['operationId'] === operationIds[index] && Array.isArray(row['argv']) && row['argv'].every((entry) => typeof entry === 'string') && hasDirectStatus(row['rawExit'], row['rawSignal'], 0) && isSha256(row['stdoutSha256']) && isSha256(row['stderrSha256']) && isSortedUniqueStrings(row['parsedOids'], isOid) && isSortedUniqueStrings(row['parsedPaths'], isSafePath) && row['expectationMet'] === true && row['verdict'] === 'Pass'), issues, 'docs-lineage-operation-invalid', 'operations');
    check(pathClasses.every((row) => isSafePath(row['path']) && typeof row['status'] === 'string' && /^(?:[ACDMRTUXB]|R\d{1,3}|C\d{1,3})$/.test(row['status']) && ['validator', 'upstream', 'authored', 'b-delta'].includes(String(row['source']))), issues, 'docs-lineage-path-invalid', 'pathClasses');
    check(isOid(value['head']) && isSha256(value['snapshotDigestSha256']) && value['overallVerdict'] === 'Pass', issues, 'docs-lineage-identity-invalid', 'identity');
  } else if (schema === 'MergeConflictResolutionReport') {
    const stages = requireRows(value['indexStages'], MERGE_CONFLICT_INDEX_STAGE_KEYS, issues, 'structured-record-shape', 'indexStages');
    const expectedPaths = [...GENERATED_INDEX_PATHS];
    check(
      value['policy'] === 'regenerate-generated-work-index'
        && isOid(value['beforeHead']) && value['expectedSecondParent'] === PINNED_GENERATED_INDEX_PARENT
        && canonicalizeBoundaryRun(value['conflictPaths']) === canonicalizeBoundaryRun(expectedPaths)
        && canonicalizeBoundaryRun(value['resolvedPaths']) === canonicalizeBoundaryRun(expectedPaths)
        && canonicalizeBoundaryRun(value['generatorArgv']) === canonicalizeBoundaryRun(GENERATED_INDEX_ARGV),
      issues, 'merge-conflict-policy-mismatch', 'policy',
    );
    check(
      stages.length === 6 && expectedPaths.every((conflictPath, pathIndex) => [1, 2, 3].every((stage, stageIndex) => {
        const row = stages[pathIndex * 3 + stageIndex];
        return row?.['path'] === conflictPath && row['stage'] === stage && typeof row['mode'] === 'string'
          && /^[0-7]{6}$/.test(row['mode']) && isOid(row['oid']);
      })),
      issues, 'merge-conflict-stage-invalid', 'indexStages',
    );
    check(hasDirectStatus(value['generatorRawExit'], value['generatorRawSignal'], 0) && hasDirectStatus(value['diffCheckRawExit'], value['diffCheckRawSignal'], 0) && hasDirectStatus(value['workIndexGuardRawExit'], value['workIndexGuardRawSignal'], 0), issues, 'merge-conflict-status-invalid', 'status');
    check(Array.isArray(value['unmergedPaths']) && value['unmergedPaths'].length === 0 && Array.isArray(value['conflictMarkerPaths']) && value['conflictMarkerPaths'].length === 0, issues, 'merge-conflict-unresolved', 'unmergedPaths');
    check(isSha256(value['preStateDigestSha256']) && isSha256(value['resolvedStateDigestSha256']) && value['verdict'] === 'Pass', issues, 'merge-conflict-policy-mismatch', 'verdict');
  }
  return snapshotResult(issues);
}

export function parseBoundaryChildPins(
  profileId: string,
  entryHead: string,
  values: readonly string[],
): { result: BoundaryValidationResult; pins: BoundaryChildPinRecord[] | null } {
  const issues: BoundaryValidationIssue[] = [];
  const profile = RUN_CONTRACT_PROFILES[profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (profile === undefined || !isOid(entryHead)) {
    issues.push(issue('child-pin-profile-invalid', 'child pins require one known profile and exact entry head'));
    return { result: snapshotResult(issues), pins: null };
  }
  const expectedAliases = (profile.requiredChildren as readonly string[])
    .map((entry) => entry.split(':', 1)[0]!)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const pins: BoundaryChildPinRecord[] = [];
  for (const [index, value] of values.entries()) {
    const fields = value.split(',');
    if (fields.length !== 4) {
      issues.push(issue('child-pin-invalid', 'child pin must contain exactly alias,head,run-id,manifest-sha256', `values[${index}]`));
      continue;
    }
    const [alias, head, runId, manifestSha256] = fields as [string, string, string, string];
    const contract = RUN_CHILD_CONTRACTS[`${profileId}/${alias}` as keyof typeof RUN_CHILD_CONTRACTS];
    if (
      contract === undefined
      || !/^[a-z][a-z0-9-]{0,63}$/.test(alias)
      || !/^[a-z][a-z0-9-]{0,63}$/.test(runId)
      || !isOid(head)
      || !isSha256(manifestSha256)
    ) {
      issues.push(issue('child-pin-invalid', 'child pin identity violates the profile-owned contract', `values[${index}]`));
      continue;
    }
    if (contract.headRelation !== 'both-docs-entry' && head !== entryHead) {
      issues.push(issue('child-pin-head-mismatch', 'child pin head differs from the parent entry relation', `values[${index}]`));
    }
    pins.push({ alias, head, runId, manifestSha256 });
  }
  pins.sort((left, right) => Buffer.from(left.alias).compare(Buffer.from(right.alias)));
  const aliases = pins.map((entry) => entry.alias);
  if (
    canonicalizeBoundaryRun(aliases) !== canonicalizeBoundaryRun(expectedAliases)
    || new Set(aliases).size !== aliases.length
  ) {
    issues.push(issue('child-pin-set-mismatch', 'child pin aliases differ from the exact profile-required set'));
  }
  const runIds = pins.map((entry) => entry.runId);
  const manifestDigests = pins.map((entry) => entry.manifestSha256);
  if (new Set(runIds).size !== runIds.length || new Set(manifestDigests).size !== manifestDigests.length) {
    issues.push(issue('child-pin-identity-collision', 'direct child run IDs and manifest digests must be unique'));
  }
  return { result: snapshotResult(issues), pins: issues.length === 0 ? pins : null };
}

export function captureBoundaryWorktreeSnapshot(
  repoPath: string,
  declarations: BoundarySnapshotDeclarations,
): BoundarySnapshotCaptureResult {
  const issues: BoundaryValidationIssue[] = [];
  validateDeclarationSet(declarations.allowedUntrackedPaths, 'allowedUntrackedPaths', issues);
  validateDeclarationSet(declarations.preservedOwnerPaths, 'preservedOwnerPaths', issues);
  const declared = new Set([...declarations.allowedUntrackedPaths, ...declarations.preservedOwnerPaths]);
  if (declared.size !== declarations.allowedUntrackedPaths.length + declarations.preservedOwnerPaths.length) {
    issues.push(issue('snapshot-overlapping-declaration', 'allowed-untracked and preserved-owner paths must be disjoint'));
  }
  if (issues.length > 0) return { ok: false, snapshot: null, issues };

  try {
    const repo = realpathSync(repoPath);
    const untracked = gitBytes(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    const unexpected = untracked.filter((entry) => !declared.has(entry));
    for (const entry of unexpected) {
      issues.push(issue('snapshot-unexpected-untracked', `unexpected untracked path: ${entry}`, entry));
    }
    if (issues.length > 0) return { ok: false, snapshot: null, issues };

    const allowedUntracked = declarations.allowedUntrackedPaths.map((entry) => capturePathRecord(repo, entry));
    const preservedOwner = declarations.preservedOwnerPaths.map((entry) => capturePathRecord(repo, entry));
    const withoutDigest = {
      head: gitText(repo, ['rev-parse', 'HEAD']),
      indexTreeOid: gitText(repo, ['write-tree']),
      trackedPatchSha256: sha256Bytes(gitBytes(repo, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff'])),
      unstagedPatchSha256: sha256Bytes(gitBytes(repo, ['diff', '--binary', '--full-index', '--no-ext-diff'])),
      allowedUntracked,
      preservedOwner,
    };
    const snapshot: BoundaryWorktreeSnapshot = {
      ...withoutDigest,
      digestSha256: sha256Bytes(canonicalizeBoundaryRun(withoutDigest)),
    };
    return { ok: true, snapshot, issues: [] };
  } catch (error) {
    issues.push(issue('snapshot-capture-failed', `failed to capture worktree snapshot: ${(error as Error).message}`));
    return { ok: false, snapshot: null, issues };
  }
}

export function verifyBoundaryWorktreeSnapshot(
  repoPath: string,
  expected: unknown,
  declarations: BoundarySnapshotDeclarations,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  if (!requireExactRecord(expected, SNAPSHOT_KEYS, issues, 'invalid-snapshot-keys', 'snapshot')) {
    return snapshotResult(issues);
  }
  const current = captureBoundaryWorktreeSnapshot(repoPath, declarations);
  if (!current.ok || current.snapshot === null) return snapshotResult(current.issues);

  if (expected['head'] !== current.snapshot.head) {
    issues.push(issue('snapshot-head-drift', 'worktree HEAD changed', 'head'));
  }
  if (
    expected['indexTreeOid'] !== current.snapshot.indexTreeOid
    || expected['trackedPatchSha256'] !== current.snapshot.trackedPatchSha256
  ) {
    issues.push(issue('snapshot-index-drift', 'worktree index changed', 'indexTreeOid'));
  }
  if (expected['unstagedPatchSha256'] !== current.snapshot.unstagedPatchSha256) {
    issues.push(issue('snapshot-unstaged-drift', 'unstaged worktree state changed', 'unstagedPatchSha256'));
  }
  if (canonicalizeBoundaryRun(expected['allowedUntracked']) !== canonicalizeBoundaryRun(current.snapshot.allowedUntracked)) {
    issues.push(issue('snapshot-allowed-untracked-drift', 'allowed-untracked state changed', 'allowedUntracked'));
  }
  if (canonicalizeBoundaryRun(expected['preservedOwner']) !== canonicalizeBoundaryRun(current.snapshot.preservedOwner)) {
    issues.push(issue('snapshot-owner-drift', 'preserved-owner state changed', 'preservedOwner'));
  }
  if (expected['digestSha256'] !== current.snapshot.digestSha256 && issues.length === 0) {
    issues.push(issue('snapshot-digest-drift', 'snapshot digest changed', 'digestSha256'));
  }
  return snapshotResult(issues);
}

function derivedRootFailure(code: string, message: string): BoundaryDerivedRootResult {
  return { ok: false, reservation: null, issues: [issue(code, message)] };
}

function isPathOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

export function reserveBoundaryDerivedRoot(input: {
  evidenceRoot: string;
  parentSegments: readonly string[];
  runId: string;
  kind: BoundaryDerivedRootKind;
  protectedPaths: readonly string[];
}): BoundaryDerivedRootResult {
  if (
    !path.isAbsolute(input.evidenceRoot)
    || input.parentSegments.length === 0
    || input.parentSegments.some(
      (segment) => segment === '' || segment === '.' || segment === '..' || path.basename(segment) !== segment,
    )
    || !/^[a-z][a-z0-9-]{0,63}$/.test(input.runId)
  ) {
    return derivedRootFailure('derived-root-path-invalid', 'derived root components must be closed canonical segments');
  }

  try {
    const requestedRoot = path.resolve(input.evidenceRoot);
    const evidenceRoot = realpathSync(requestedRoot);
    if (evidenceRoot !== requestedRoot) {
      return derivedRootFailure('derived-root-symlink', 'evidence root must not resolve through a symlink');
    }
    const ancestors: BoundaryDerivedRootReservation['ancestors'] = [];
    let current = evidenceRoot;
    for (const segment of input.parentSegments) {
      current = path.join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        return derivedRootFailure('derived-root-symlink', `derived root ancestor is a symlink: ${current}`);
      }
      if (!stat.isDirectory()) {
        return derivedRootFailure('derived-root-path-invalid', `derived root ancestor is not a directory: ${current}`);
      }
      if (realpathSync(current) !== current) {
        return derivedRootFailure('derived-root-symlink', `derived root ancestor resolves elsewhere: ${current}`);
      }
      ancestors.push({ path: current, device: Number(stat.dev), inode: Number(stat.ino) });
    }
    const parent = ancestors.at(-1)!;
    const leaf = path.join(parent.path, input.runId);
    for (const protectedPath of input.protectedPaths) {
      if (!path.isAbsolute(protectedPath) || isPathOverlap(leaf, path.resolve(protectedPath))) {
        return derivedRootFailure('derived-root-overlap', `derived root overlaps protected path: ${protectedPath}`);
      }
    }
    try {
      lstatSync(leaf);
      return derivedRootFailure('derived-root-exists', `derived root leaf already exists: ${leaf}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const reservation: BoundaryDerivedRootReservation = {
      kind: input.kind,
      path: leaf,
      parentPath: parent.path,
      parentDevice: parent.device,
      parentInode: parent.inode,
      ancestors,
    };
    return { ok: true, reservation, issues: [] };
  } catch (error) {
    return derivedRootFailure(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'derived-root-path-invalid' : 'derived-root-reservation-failed',
      `failed to reserve derived root: ${(error as Error).message}`,
    );
  }
}

export function createBoundaryDerivedRoot(reservation: BoundaryDerivedRootReservation): BoundaryDerivedRootResult {
  try {
    for (const ancestor of reservation.ancestors) {
      const stat = lstatSync(ancestor.path);
      if (stat.isSymbolicLink()) {
        return derivedRootFailure('derived-root-symlink', `derived root ancestor became a symlink: ${ancestor.path}`);
      }
      if (Number(stat.dev) !== ancestor.device || Number(stat.ino) !== ancestor.inode) {
        return derivedRootFailure('derived-root-parent-raced', `derived root ancestor identity changed: ${ancestor.path}`);
      }
    }
    const parent = lstatSync(reservation.parentPath);
    if (Number(parent.dev) !== reservation.parentDevice || Number(parent.ino) !== reservation.parentInode) {
      return derivedRootFailure('derived-root-parent-raced', 'derived root parent identity changed before creation');
    }
    try {
      lstatSync(reservation.path);
      return derivedRootFailure('derived-root-exists', `derived root leaf already exists: ${reservation.path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(reservation.path, { recursive: false, mode: 0o700 });
    const created = lstatSync(reservation.path);
    const resolved = realpathSync(reservation.path);
    const parentAfter = lstatSync(reservation.parentPath);
    if (
      !created.isDirectory()
      || resolved !== reservation.path
      || path.dirname(resolved) !== reservation.parentPath
      || Number(parentAfter.dev) !== reservation.parentDevice
      || Number(parentAfter.ino) !== reservation.parentInode
    ) {
      if (created.isDirectory()) {
        try {
          rmdirSync(reservation.path);
        } catch {
          // A non-empty or replaced leaf is foreign state and is intentionally retained.
        }
      }
      return derivedRootFailure('derived-root-postcreate-mismatch', 'derived root identity changed during creation');
    }
    return {
      ok: true,
      reservation,
      record: {
        kind: reservation.kind,
        path: reservation.path,
        parentDevice: reservation.parentDevice,
        parentInode: reservation.parentInode,
        state: 'created',
      },
      issues: [],
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return derivedRootFailure('derived-root-exists', 'derived root leaf already exists');
    if (code === 'ENOENT') return derivedRootFailure('derived-root-parent-raced', 'derived root ancestor disappeared');
    return derivedRootFailure('derived-root-creation-failed', `failed to create derived root: ${(error as Error).message}`);
  }
}

function parseExpectedExit(value: string): Set<number> | 'nonzero' | null {
  if (value === 'nonzero') return 'nonzero';
  if (!/^(?:0|[1-9]\d?\d?)(?:,(?:0|[1-9]\d?\d?))*$/.test(value)) return null;
  const statuses = value.split(',').map(Number);
  if (
    statuses.some((status) => status > 255)
    || new Set(statuses).size !== statuses.length
    || statuses.some((status, index) => index > 0 && status <= statuses[index - 1]!)
  ) return null;
  return new Set(statuses);
}

export function validateBoundaryAttemptStatus(
  recorded: BoundaryAttemptStatus,
  observed: Pick<BoundaryAttemptStatus, 'rawExit' | 'rawSignal'>,
  contract: BoundaryAttemptStatusContract,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const statusCount = Number(recorded.rawExit !== null) + Number(recorded.rawSignal !== null);
  const observedStatusCount = Number(observed.rawExit !== null) + Number(observed.rawSignal !== null);
  if (statusCount !== 1 || observedStatusCount !== 1) {
    issues.push(issue('attempt-status-missing', 'exactly one direct exit or signal status is required'));
  }
  if (recorded.rawExit !== observed.rawExit || recorded.rawSignal !== observed.rawSignal) {
    issues.push(issue('attempt-status-rewritten', 'recorded child status differs from the direct observed status'));
  }
  if (recorded.rawExit !== null && (!Number.isInteger(recorded.rawExit) || recorded.rawExit < 0 || recorded.rawExit > 255)) {
    issues.push(issue('attempt-exit-invalid', 'raw exit must be an integer in 0..255'));
  }
  if (recorded.rawSignal !== null && !/^SIG[A-Z0-9]+$/.test(recorded.rawSignal)) {
    issues.push(issue('attempt-signal-invalid', 'raw signal must be a POSIX signal name'));
  }
  const expected = parseExpectedExit(recorded.expectedExit);
  if (expected === null) {
    issues.push(issue('attempt-expected-exit-invalid', 'expected exit declaration is not normalized'));
  }
  const expectationMet = recorded.rawExit !== null && expected !== null
    ? expected === 'nonzero' ? recorded.rawExit !== 0 : expected.has(recorded.rawExit)
    : false;
  if (recorded.rawSignal !== null && recorded.expectationMet) {
    issues.push(issue('attempt-signal-not-exit', 'a signal cannot satisfy a numeric or nonzero exit declaration'));
  }
  if (recorded.expectationMet !== expectationMet) {
    issues.push(issue('attempt-expectation-rewritten', 'expectationMet does not match the direct status predicate'));
  }
  if (recorded.expectedExit !== contract.expectedExit) {
    issues.push(issue('attempt-expected-exit-mismatch', 'expected exit differs from the frozen attempt contract'));
  }
  if (recorded.watchdogOwner !== contract.watchdogOwner) {
    issues.push(issue('attempt-watchdog-owner-mismatch', 'watchdog owner differs from the frozen attempt contract'));
  }
  if (recorded.innerTimeoutOwner !== contract.innerTimeoutOwner) {
    issues.push(issue('attempt-inner-timeout-owner-mismatch', 'inner timeout owner differs from the frozen attempt contract'));
  }
  if (recorded.deadlineMs !== contract.deadlineMs || recorded.killGraceMs !== contract.killGraceMs) {
    issues.push(issue('attempt-deadline-mismatch', 'deadline or kill grace differs from the frozen attempt contract'));
  }
  if (
    !Number.isSafeInteger(recorded.deadlineMs)
    || recorded.deadlineMs <= 0
    || !Number.isSafeInteger(recorded.killGraceMs)
    || recorded.killGraceMs <= 0
  ) {
    issues.push(issue('attempt-deadline-invalid', 'deadline and kill grace must be positive safe integers'));
  }
  return snapshotResult(issues);
}

const ARTIFACT_ROLES = new Set<BoundaryArtifactRole>([
  'input',
  'output',
  'receipt',
  'review',
  'lifecycle',
  'oracle',
  'scope',
  'measurement',
]);

export function admitBoundaryOutput(input: {
  runDir: string;
  attempt: BoundaryAttemptRecord;
  artifacts: BoundaryArtifactRecord[];
  path: string;
  role: string;
  producerAttemptId: string;
}): {
  result: BoundaryValidationResult;
  attempt: BoundaryAttemptRecord;
  artifacts: BoundaryArtifactRecord[];
} {
  const attempt = structuredClone(input.attempt);
  const artifacts = structuredClone(input.artifacts);
  const issues: BoundaryValidationIssue[] = [];
  const declarationCount = attempt.declaredOutputs.filter((entry) => entry === input.path).length;
  const admission = attempt.outputAdmissions.find((entry) => entry.path === input.path);
  if (!isSafePath(input.path) || declarationCount !== 1 || admission === undefined) {
    issues.push(issue('output-undeclared', 'artifact path was not uniquely declared by the attempt', input.path));
  } else if (admission.state === 'missing') {
    issues.push(issue('output-missing', 'a missing output cannot be admitted', input.path));
  } else if (admission.state === 'admitted') {
    issues.push(issue('output-duplicate-admission', 'an output can be admitted only once', input.path));
  }
  if (input.producerAttemptId !== attempt.id) {
    issues.push(issue('output-producer-mismatch', 'artifact producer does not own the declared output', input.path));
  }
  if (!ARTIFACT_ROLES.has(input.role as BoundaryArtifactRole)) {
    issues.push(issue('output-role-invalid', 'artifact role is outside the closed role set', input.path));
  }
  if (artifacts.some((artifact) => artifact.path === input.path)) {
    issues.push(issue('output-duplicate-admission', 'artifact path is already registered', input.path));
  }
  if (issues.length > 0 || admission === undefined) {
    return { result: snapshotResult(issues), attempt, artifacts };
  }

  try {
    const runDir = realpathSync(input.runDir);
    const record = capturePathRecord(runDir, input.path);
    admission.state = 'admitted';
    admission.role = input.role as BoundaryArtifactRole;
    admission.sha256 = record.sha256;
    admission.bytes = record.bytes;
    artifacts.push({
      path: input.path,
      role: input.role as BoundaryArtifactRole,
      producerAttemptId: input.producerAttemptId,
      sha256: record.sha256,
      bytes: record.bytes,
    });
    if (attempt.expectationMet && attempt.outputAdmissions.every((entry) => entry.state === 'admitted')) {
      attempt.verdict = 'Pass';
    }
    return { result: snapshotResult([]), attempt, artifacts };
  } catch (error) {
    issues.push(issue('output-file-invalid', `declared output is not a confined regular file: ${(error as Error).message}`, input.path));
    return { result: snapshotResult(issues), attempt, artifacts };
  }
}

export function validateBoundaryOutputClosure(
  runDirInput: string,
  attempt: BoundaryAttemptRecord,
  artifacts: BoundaryArtifactRecord[],
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  if (
    new Set(attempt.declaredOutputs).size !== attempt.declaredOutputs.length
    || new Set(attempt.outputAdmissions.map((entry) => entry.path)).size !== attempt.outputAdmissions.length
  ) {
    issues.push(issue('output-duplicate-admission', 'declared output or admission paths are duplicated'));
  }
  const declarationSet = new Set(attempt.declaredOutputs);
  const admissionSet = new Set(attempt.outputAdmissions.map((entry) => entry.path));
  if (
    declarationSet.size !== admissionSet.size
    || [...declarationSet].some((entry) => !admissionSet.has(entry))
  ) {
    issues.push(issue('output-undeclared', 'declared outputs and admission rows differ'));
  }
  if (new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length) {
    issues.push(issue('output-duplicate-admission', 'artifact paths are duplicated'));
  }

  let runDir: string;
  try {
    runDir = realpathSync(runDirInput);
  } catch (error) {
    return snapshotResult([issue('output-root-invalid', `output root cannot be resolved: ${(error as Error).message}`)]);
  }
  for (const admission of attempt.outputAdmissions) {
    if (admission.state === 'pending') {
      issues.push(issue('output-pending', 'pending output blocks closure', admission.path));
      continue;
    }
    if (admission.state === 'missing') {
      if (attempt.expectationMet) issues.push(issue('output-missing', 'expected-success output is missing', admission.path));
      continue;
    }
    const matches = artifacts.filter((artifact) => artifact.path === admission.path);
    const artifact = matches[0];
    if (
      matches.length !== 1
      || artifact === undefined
      || artifact.producerAttemptId !== attempt.id
      || artifact.role !== admission.role
      || artifact.sha256 !== admission.sha256
      || artifact.bytes !== admission.bytes
    ) {
      issues.push(issue('output-artifact-mismatch', 'admission does not match one producer-bound artifact', admission.path));
      continue;
    }
    try {
      const current = capturePathRecord(runDir, admission.path);
      if (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes) {
        issues.push(issue('output-content-drift', 'admitted output bytes changed', admission.path));
      }
    } catch (error) {
      issues.push(issue('output-content-drift', `admitted output is unavailable: ${(error as Error).message}`, admission.path));
    }
  }
  return snapshotResult(issues);
}

export interface BoundaryToolCapability {
  name: string;
  realPath: string;
  version: string;
  sha256: string;
}

export function resolveBoundaryToolCapability(name: string): BoundaryToolCapability {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error(`unsupported tool name: ${name}`);
  const candidates = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  let executable: string | null = null;
  const executableNames = name === 'gnu-timeout' ? ['gtimeout', 'timeout'] : [name];
  for (const executableName of executableNames) {
    for (const directory of candidates) {
      const candidate = path.join(directory, executableName);
      try {
        accessSync(candidate, fsConstants.X_OK);
        executable = realpathSync(candidate);
        break;
      } catch {
        // Continue through the closed PATH search until one executable is found.
      }
    }
    if (executable !== null) break;
  }
  if (executable === null) throw new Error(`required tool is unavailable: ${name}`);
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split(/\r?\n/, 1)[0]!.trim();
  if (name === 'gnu-timeout' && !version.includes('GNU coreutils')) {
    throw new Error('resolved timeout executable is not GNU coreutils');
  }
  if (Buffer.byteLength(version, 'utf8') > 256) throw new Error(`tool version is over bound: ${name}`);
  return {
    name,
    realPath: executable,
    version,
    sha256: sha256Bytes(readFileSync(executable)),
  };
}

export function validateBoundaryProfileSelection(input: Record<string, unknown>): BoundaryValidationResult {
  const profileId = input['profileId'];
  const expected = typeof profileId === 'string'
    ? RUN_CONTRACT_PROFILES[profileId as keyof typeof RUN_CONTRACT_PROFILES]
    : undefined;
  if (expected === undefined || canonicalizeBoundaryRun(input) !== canonicalizeBoundaryRun(expected)) {
    return snapshotResult([issue('profile-contract-mismatch', 'task/profile and immutable required sets must equal one generated profile')]);
  }
  return snapshotResult([]);
}

export function validateBoundaryAttemptInvocation(
  id: string,
  input: Record<string, unknown>,
): BoundaryValidationResult {
  const contract = RUN_ATTEMPT_CONTRACTS[id as keyof typeof RUN_ATTEMPT_CONTRACTS];
  if (contract === undefined) {
    return snapshotResult([issue('attempt-contract-unknown', `attempt ID is not reserved: ${id}`)]);
  }
  const issues: BoundaryValidationIssue[] = [];
  for (const key of [
    'operation',
    'argv',
    'expectedExit',
    'watchdogOwner',
    'innerTimeoutOwner',
    'deadlineMs',
    'killGraceMs',
    'outputPaths',
    'headAnchor',
  ] as const) {
    if (canonicalizeBoundaryRun(input[key]) !== canonicalizeBoundaryRun(contract[key])) {
      issues.push(issue('attempt-contract-mismatch', `${id}.${key} differs from the generated attempt contract`, key));
    }
  }
  const environment = input['environment'];
  if (!isRecord(environment) || !hasExactKeys(environment, contract.environmentKeys)) {
    issues.push(issue('attempt-environment-mismatch', 'child environment keys differ from the closed allowlist', 'environment'));
  } else if (Object.values(environment).some((value) => typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4_096)) {
    issues.push(issue('attempt-environment-mismatch', 'child environment values must be bounded strings', 'environment'));
  }
  let capability: BoundaryToolCapability | null = null;
  if (contract.toolName === null) {
    if (input['capability'] !== null) {
      issues.push(issue('attempt-tool-capability-mismatch', 'internal checks must not accept a caller tool capability', 'capability'));
    }
  } else {
    try {
      capability = resolveBoundaryToolCapability(contract.toolName);
    } catch (error) {
      issues.push(issue('attempt-tool-unavailable', (error as Error).message, 'capability'));
    }
  }
  if (capability !== null && canonicalizeBoundaryRun(input['capability']) !== canonicalizeBoundaryRun(capability)) {
    issues.push(issue('attempt-tool-capability-mismatch', 'tool capability does not match the helper preflight', 'capability'));
  }
  return snapshotResult(issues);
}

export interface BoundaryStructuredTestRow {
  marker: string;
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  failureReason: string | null;
}

export interface BoundaryStructuredTestResult {
  testFile: string;
  registeredMarkerIds: string[];
  tests: BoundaryStructuredTestRow[];
  collectionErrors: string[];
  unhandledErrors: string[];
}

export function validateBoundaryStructuredTestResult(
  mode: 'red' | 'green',
  result: BoundaryStructuredTestResult,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const contract = RUN_TEST_CONTRACTS.bcf00;
  const markerIds = [...contract.markerIds];
  const selectedIds = mode === 'green'
    ? markerIds
    : markerIds.filter((id) => id.includes('-B') || id.includes('-U'));
  if (result.testFile !== contract.testFile) {
    issues.push(issue('test-file-mismatch', 'structured result names the wrong test file', 'testFile'));
  }
  if (canonicalizeBoundaryRun(result.registeredMarkerIds) !== canonicalizeBoundaryRun(markerIds)) {
    issues.push(issue('test-registration-mismatch', 'registered marker roster differs from the generated contract'));
  }
  if (result.tests.length === 0) issues.push(issue('test-zero-collected', 'structured result collected zero tests'));
  const collectedIds = result.tests.map((row) => row.marker);
  if (
    new Set(collectedIds).size !== collectedIds.length
    || canonicalizeBoundaryRun([...collectedIds].sort()) !== canonicalizeBoundaryRun([...selectedIds].sort())
  ) {
    issues.push(issue('test-marker-roster-mismatch', 'collected marker roster differs from the selected contract'));
  }
  if (result.collectionErrors.length > 0) {
    issues.push(issue('test-collection-error', 'structured result contains collection or import errors'));
  }
  if (result.unhandledErrors.length > 0) {
    issues.push(issue('test-unhandled-error', 'structured result contains unhandled errors'));
  }
  for (const row of result.tests) {
    if (row.status === 'skipped' || row.status === 'todo') {
      issues.push(issue('test-nonterminal-status', `registered test is ${row.status}: ${row.marker}`, row.marker));
      continue;
    }
    if (mode === 'green') {
      if (row.status !== 'passed' || row.failureReason !== null) {
        issues.push(issue('test-green-predicate-mismatch', `GREEN marker did not pass cleanly: ${row.marker}`, row.marker));
      }
      continue;
    }
    if (row.marker.includes('-B')) {
      if (row.status !== 'passed' || row.failureReason !== null) {
        issues.push(issue('test-red-safe-control-failed', `RED safe control did not pass: ${row.marker}`, row.marker));
      }
    } else if (row.status !== 'failed' || row.failureReason !== `unsafe:${row.marker}`) {
      issues.push(issue('test-red-sentinel-mismatch', `RED unsafe marker failed for the wrong reason: ${row.marker}`, row.marker));
    }
  }
  return snapshotResult(issues);
}

const VITEST_JSON_REPORT_KEYS = [
  'numFailedTestSuites', 'numFailedTests', 'numPassedTestSuites', 'numPassedTests',
  'numPendingTestSuites', 'numPendingTests', 'numTodoTests', 'numTotalTestSuites',
  'numTotalTests', 'snapshot', 'startTime', 'success', 'testResults',
] as const;

export function validateBoundaryVitestJsonReport(input: Record<string, unknown>): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const predicate = input['predicate'];
  if (typeof predicate !== 'string') {
    return snapshotResult([issue('test-result-predicate-unsupported', 'structured result predicate is not implemented')]);
  }
  if (predicate in RUN_EVAL_CONTRACTS) return validateBoundaryEvaluatorJsonReport(input);
  const predicateContract = RUN_VITEST_PREDICATES[predicate];
  if (predicateContract === undefined) {
    return snapshotResult([issue('test-result-predicate-unsupported', 'structured result predicate is not implemented')]);
  }
  const report = input['report'];
  if (!requireExactRecord(report, VITEST_JSON_REPORT_KEYS, issues, 'test-report-shape', 'report')) {
    return snapshotResult(issues);
  }
  const countKeys = [
    'numFailedTestSuites', 'numFailedTests', 'numPassedTestSuites', 'numPassedTests',
    'numPendingTestSuites', 'numPendingTests', 'numTodoTests', 'numTotalTestSuites',
    'numTotalTests', 'startTime',
  ] as const;
  if (countKeys.some((key) => !Number.isSafeInteger(report[key]) || Number(report[key]) < 0)) {
    issues.push(issue('test-report-count-invalid', 'Vitest report counts must be nonnegative safe integers'));
  }
  if (report['numPendingTestSuites'] !== 0 || report['numPendingTests'] !== 0 || report['numTodoTests'] !== 0) {
    issues.push(issue('test-report-nonpass', 'Vitest report contains a skip, todo, or pending result'));
  }
  if (predicateContract.mode === 'green') {
    if (report['success'] !== true || report['numFailedTestSuites'] !== 0 || report['numFailedTests'] !== 0) {
      issues.push(issue('test-report-nonpass', 'GREEN Vitest report contains a failure'));
    }
  } else if (report['success'] !== false || report['numFailedTests'] === 0) {
    issues.push(issue('test-red-status-mismatch', 'RED Vitest report must fail through its declared unsafe assertions'));
  }
  const cwd = input['cwd'];
  const entryTestRoster = input['entryTestRoster'];
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !isRecord(entryTestRoster) || !Array.isArray(entryTestRoster['files'])) {
    issues.push(issue('test-entry-roster-invalid', 'entry roster or repository root is malformed'));
    return snapshotResult(issues);
  }
  const entryFiles = new Map<string, Record<string, unknown>>();
  for (const row of entryTestRoster['files']) {
    if (isRecord(row) && typeof row['path'] === 'string') entryFiles.set(row['path'], row);
  }
  for (const expectedFile of predicateContract.testFiles) {
    const entryFile = entryFiles.get(expectedFile);
    if (!isRecord(entryFile) || !['present', 'absent'].includes(String(entryFile['state'])) || !Array.isArray(entryFile['testNames'])) {
      issues.push(issue('test-entry-roster-invalid', `entry roster does not contain the required test file: ${expectedFile}`));
    }
  }
  if (issues.some((entry) => entry.code === 'test-entry-roster-invalid')) return snapshotResult(issues);
  const testResults = report['testResults'];
  if (!Array.isArray(testResults) || testResults.length !== predicateContract.testFiles.length || testResults.some((row) => !isRecord(row))) {
    issues.push(issue('test-file-mismatch', 'Vitest report must contain every and only required test file'));
    return snapshotResult(issues);
  }
  const requiredContracts = predicateContract.testContractIds.map((id) => RUN_TEST_CONTRACTS[id]);
  const registeredMarkers = requiredContracts.flatMap((contract) => [...contract.markerIds]);
  const selectedMarkers = predicateContract.mode === 'red'
    ? requiredContracts.flatMap((contract) => [...contract.unsafeMarkerIds, ...contract.safeMarkerIds])
    : registeredMarkers;
  const unsafeMarkers = new Set(requiredContracts.flatMap((contract) => [...contract.unsafeMarkerIds]));
  const safeMarkers = new Set(requiredContracts.flatMap((contract) => [...contract.safeMarkerIds]));
  const observedMarkers: string[] = [];
  let assertionCount = 0;
  let passedCount = 0;
  let failedCount = 0;
  const observedFiles: string[] = [];
  for (const row of testResults) {
    const testFile = row as Record<string, unknown>;
    const observedName = testFile['name'];
    const observedPath = typeof observedName === 'string' && path.isAbsolute(observedName)
      ? path.relative(cwd, observedName)
      : observedName;
    if (typeof observedPath !== 'string') {
      issues.push(issue('test-file-mismatch', 'Vitest result has no canonical file path'));
      continue;
    }
    observedFiles.push(observedPath);
    const assertions = testFile['assertionResults'];
    if (!Array.isArray(assertions) || assertions.length === 0) {
      issues.push(issue('test-zero-collected', `Vitest report collected zero assertions for ${observedPath}`));
      continue;
    }
    const titles: string[] = [];
    for (const assertion of assertions) {
      if (
        !isRecord(assertion)
        || typeof assertion['title'] !== 'string'
        || typeof assertion['fullName'] !== 'string'
        || !Array.isArray(assertion['failureMessages'])
      ) {
        issues.push(issue('test-report-shape', 'Vitest assertion row is malformed'));
        continue;
      }
      assertionCount += 1;
      const fullName = assertion['fullName'];
      titles.push(fullName);
      const markerMatches = fullName.match(/\[BCF\d{2}-(?:B|U|S|N)\d{2}\]/g) ?? [];
      if (markerMatches.length > 1) {
        issues.push(issue('test-marker-roster-mismatch', 'one assertion contains multiple registered markers'));
        continue;
      }
      const observedMarker = markerMatches[0] ?? null;
      if (observedMarker !== null) observedMarkers.push(observedMarker);
      const status = assertion['status'];
      const failures = assertion['failureMessages'] as unknown[];
      if (status === 'passed') passedCount += 1;
      if (status === 'failed') failedCount += 1;
      if (predicateContract.mode === 'green') {
        if (status !== 'passed' || failures.length !== 0) {
          issues.push(issue('test-report-nonpass', `GREEN assertion is not a clean pass: ${assertion['title']}`));
        }
      } else if (observedMarker === null || !selectedMarkers.includes(observedMarker)) {
        issues.push(issue('test-marker-roster-mismatch', 'RED selected an unregistered or unmarked assertion'));
      } else if (safeMarkers.has(observedMarker)) {
        if (status !== 'passed' || failures.length !== 0) {
          issues.push(issue('test-red-safe-control-failed', `RED safe control did not pass: ${observedMarker}`));
        }
      } else if (unsafeMarkers.has(observedMarker)) {
        const sentinel = `BCF_EXPECTATION_UNMET:${observedMarker.slice(1, 6)}-${observedMarker.slice(-3, -1)}`;
        const stripped = failures.map((value) => stripBoundaryAnsi(String(value))).join('\n');
        const sentinels = stripped.match(/BCF_EXPECTATION_UNMET:BCF\d{2}-\d{2}/g) ?? [];
        if (status !== 'failed' || sentinels.length !== 1 || sentinels[0] !== sentinel) {
          issues.push(issue('test-red-sentinel-mismatch', `RED unsafe marker failed for the wrong reason: ${observedMarker}`));
        }
      }
    }
    if (predicateContract.mode === 'green') {
      const entryFile = entryFiles.get(observedPath)!;
      const retained = new Set((entryFile['testNames'] as unknown[]).map(String));
      for (const title of retained) {
        if (!titles.includes(title)) issues.push(issue('test-entry-roster-mismatch', `entry test was removed or renamed: ${observedPath} :: ${title}`));
      }
      for (const title of titles) {
        const markerMatches = title.match(/\[BCF\d{2}-(?:B|U|S|N)\d{2}\]/g) ?? [];
        if (!retained.has(title) && (markerMatches.length !== 1 || !registeredMarkers.includes(markerMatches[0]!))) {
          issues.push(issue('test-entry-roster-mismatch', `unregistered test was added to the selected roster: ${observedPath} :: ${title}`));
        }
      }
    }
  }
  const sortBytes = (values: readonly string[]) => [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (canonicalizeBoundaryRun(sortBytes(observedFiles)) !== canonicalizeBoundaryRun(sortBytes(predicateContract.testFiles))) {
    issues.push(issue('test-file-mismatch', 'Vitest result file set differs from the predicate contract'));
  }
  if (canonicalizeBoundaryRun(sortBytes(observedMarkers)) !== canonicalizeBoundaryRun(sortBytes(selectedMarkers))) {
    issues.push(issue('test-marker-roster-mismatch', 'collected marker roster differs from the predicate contract'));
  }
  if (
    report['numTotalTests'] !== assertionCount
    || report['numPassedTests'] !== passedCount
    || report['numFailedTests'] !== failedCount
    || passedCount + failedCount !== assertionCount
  ) issues.push(issue('test-report-count-invalid', 'Vitest report totals differ from its assertion rows'));
  return snapshotResult(issues);
}

function stripBoundaryAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

const EVALUATOR_BASE_KEYS = [
  'engine', 'corpusLockedAt', 'primaryMetric', 'correct', 'total', 'accuracy', 'falseBlocks',
  'missedCritical', 'targetMet', 'byCohort', 'byEvidence', 'mismatches',
] as const;
const EVALUATOR_CANDIDATE_KEYS = [
  ...EVALUATOR_BASE_KEYS, 'feedbackCompleteness', 'receipts', 'detectorVerification',
] as const;

function validateBoundaryEvaluatorJsonReport(input: Record<string, unknown>): BoundaryValidationResult {
  const predicate = input['predicate'];
  const contract = typeof predicate === 'string'
    ? RUN_EVAL_CONTRACTS[predicate as keyof typeof RUN_EVAL_CONTRACTS]
    : undefined;
  if (contract === undefined) {
    return snapshotResult([issue('evaluator-predicate-unsupported', 'evaluator predicate is not implemented')]);
  }
  const issues: BoundaryValidationIssue[] = [];
  const report = input['report'];
  const cwd = input['cwd'];
  const expectedKeys = contract.engine === 'candidate' ? EVALUATOR_CANDIDATE_KEYS : EVALUATOR_BASE_KEYS;
  if (
    typeof cwd !== 'string'
    || !path.isAbsolute(cwd)
    || !requireExactRecord(report, expectedKeys, issues, 'evaluator-result-shape', 'report')
  ) return snapshotResult(issues.length > 0 ? issues : [issue('evaluator-input-invalid', 'evaluator cwd is invalid')]);
  let corpus: Record<string, unknown>;
  try {
    const parsed = parseBoundaryJsonBytes(readFileSync(path.join(cwd, contract.corpusPath)));
    if (!parsed.result.ok || parsed.value === null || !isRecord(parsed.value)) throw new Error('corpus is not canonical JSON');
    corpus = parsed.value;
  } catch (error) {
    return snapshotResult([issue('evaluator-corpus-invalid', (error as Error).message)]);
  }
  const cases = corpus['cases'];
  if (!Array.isArray(cases) || cases.length !== contract.total || cases.some((row) => !isRecord(row))) {
    return snapshotResult([issue('evaluator-corpus-invalid', 'corpus case roster is malformed')]);
  }
  const caseRows = cases as Array<Record<string, unknown>>;
  const caseIds = caseRows.map((row) => row['id']);
  if (
    caseIds.some((id) => typeof id !== 'string')
    || new Set(caseIds).size !== caseIds.length
    || caseRows.some((row) => !['pass', 'warn', 'block', 'inconclusive'].includes(String(row['expected'])))
  ) return snapshotResult([issue('evaluator-corpus-invalid', 'corpus IDs or expected labels are invalid')]);
  const predictions = new Map<string, string>();
  if (contract.engine === 'baseline') {
    for (const row of caseRows) predictions.set(String(row['id']), String(row['currentDecision']));
  } else {
    const receipts = report['receipts'];
    if (!Array.isArray(receipts) || receipts.length !== caseRows.length || receipts.some((row) => !isRecord(row))) {
      issues.push(issue('evaluator-case-roster-mismatch', 'candidate receipts do not cover every corpus case'));
    } else {
      for (const receipt of receipts as Array<Record<string, unknown>>) {
        const caseId = receipt['caseId'];
        const decision = receipt['decision'];
        if (
          typeof caseId !== 'string'
          || !['pass', 'warn', 'block', 'inconclusive'].includes(String(decision))
          || predictions.has(caseId)
        ) {
          issues.push(issue('evaluator-case-roster-mismatch', 'candidate receipt identity or decision is invalid'));
          continue;
        }
        predictions.set(caseId, String(decision));
      }
      if (canonicalizeBoundaryRun([...predictions.keys()].sort()) !== canonicalizeBoundaryRun(caseIds.map(String).sort())) {
        issues.push(issue('evaluator-case-roster-mismatch', 'candidate receipt case IDs differ from the corpus'));
      }
    }
    if (report['feedbackCompleteness'] !== 1) {
      issues.push(issue('evaluator-feedback-incomplete', 'candidate feedback completeness must equal one'));
    }
    const detector = report['detectorVerification'];
    if (
      !isRecord(detector)
      || !hasExactKeys(detector, ['requested', 'revisions', 'modulesChecked'])
      || detector['requested'] !== true
      || !Number.isSafeInteger(detector['revisions'])
      || Number(detector['revisions']) < 0
      || !Number.isSafeInteger(detector['modulesChecked'])
      || Number(detector['modulesChecked']) < 0
    ) issues.push(issue('evaluator-detector-verification-invalid', 'candidate detector verification is malformed'));
  }
  if (predictions.size !== caseRows.length) return snapshotResult(issues);
  const mismatchRows = caseRows.filter((row) => predictions.get(String(row['id'])) !== row['expected']).map((row) => ({
    id: row['id'], expected: row['expected'], predicted: predictions.get(String(row['id'])), sourceRefs: row['sourceRefs'],
  }));
  const correct = caseRows.length - mismatchRows.length;
  const falseBlocks = caseRows.filter((row) => predictions.get(String(row['id'])) === 'block' && row['expected'] === 'pass').length;
  const missedCritical = caseRows.filter((row) => row['expected'] === 'block' && predictions.get(String(row['id'])) !== 'block').length;
  const accuracy = correct / caseRows.length;
  const target = isRecord(corpus['target']) ? corpus['target'] : {};
  const targetMet = accuracy >= Number(target['minimumAccuracy']) && falseBlocks <= Number(target['maximumFalseBlocks']);
  const group = (field: 'cohort' | 'evidence') => {
    const grouped: Record<string, { correct: number; total: number; accuracy: number }> = {};
    for (const row of caseRows) {
      const key = String(row[field]);
      const value = (grouped[key] ??= { correct: 0, total: 0, accuracy: 0 });
      value.total += 1;
      if (predictions.get(String(row['id'])) === row['expected']) value.correct += 1;
    }
    for (const value of Object.values(grouped)) value.accuracy = value.correct / value.total;
    return grouped;
  };
  const expectedFields: Record<string, unknown> = {
    engine: contract.engine,
    corpusLockedAt: corpus['lockedAt'],
    primaryMetric: corpus['primaryMetric'],
    correct,
    total: caseRows.length,
    accuracy,
    falseBlocks,
    missedCritical,
    targetMet,
    byCohort: group('cohort'),
    byEvidence: group('evidence'),
    mismatches: mismatchRows,
  };
  for (const [key, expected] of Object.entries(expectedFields)) {
    if (canonicalizeBoundaryRun(report[key]) !== canonicalizeBoundaryRun(expected)) {
      issues.push(issue('evaluator-result-mismatch', `evaluator field differs from independently derived corpus evidence: ${key}`, key));
    }
  }
  if (
    correct !== contract.correct
    || falseBlocks !== contract.falseBlocks
    || missedCritical !== contract.missedCritical
  ) issues.push(issue('evaluator-score-mismatch', 'evaluator score differs from the frozen contract'));
  if (
    contract.mismatchIds !== null
    && canonicalizeBoundaryRun(mismatchRows.map((row) => row.id)) !== canonicalizeBoundaryRun([...contract.mismatchIds])
  ) issues.push(issue('evaluator-mismatch-identity', 'evaluator mismatch identity differs from the frozen contract'));
  return snapshotResult(issues);
}

export function validateBoundaryStdoutPredicate(
  predicate: string | null,
  stdout: string,
  allowedPaths: readonly string[],
): BoundaryValidationResult {
  if (predicate === null) return snapshotResult([]);
  const trimmed = stdout.trim();
  let valid = false;
  switch (predicate) {
    case 'oid':
    case 'merge-preview':
      valid = /^[0-9a-f]{40}$/.test(trimmed);
      break;
    case 'ssh-origin':
      valid = /^git@[^:\s]+:[^\s]+$/.test(trimmed);
      break;
    case 'ahead-behind':
      valid = /^\d+\s+\d+$/.test(trimmed) && trimmed.split(/\s+/).length === 2;
      break;
    case 'decimal-equals-29':
      valid = trimmed === '29';
      break;
    case 'exact-profile-allowlist': {
      const observed = trimmed === '' ? [] : stdout.replace(/\n$/, '').split('\n');
      valid = canonicalizeBoundaryRun(observed) === canonicalizeBoundaryRun(allowedPaths);
      break;
    }
    default:
      return snapshotResult([issue('attempt-stdout-predicate-unknown', `unknown stdout predicate: ${predicate}`)]);
  }
  return valid
    ? snapshotResult([])
    : snapshotResult([issue('attempt-stdout-predicate-mismatch', `stdout failed predicate: ${predicate}`)]);
}

export function validateAndAppendBoundaryPredecessor(input: Record<string, unknown>): {
  result: BoundaryValidationResult;
  ledger: Record<string, unknown> | null;
} {
  const issues: BoundaryValidationIssue[] = [];
  const profileId = input['profileId'];
  const relation = typeof profileId === 'string'
    ? RUN_PREDECESSOR_CONTRACTS[profileId as keyof typeof RUN_PREDECESSOR_CONTRACTS]
    : undefined;
  if (relation === undefined) {
    issues.push(issue('predecessor-profile-mismatch', 'profile has no matching predecessor contract'));
  }
  const pin = input['pin'];
  if (pin === null || pin === undefined) {
    issues.push(issue('predecessor-missing', 'profile requires one immutable predecessor pin'));
    return { result: snapshotResult(issues), ledger: null };
  }
  if (!requireExactRecord(pin, PREDECESSOR_PIN_KEYS, issues, 'predecessor-pin-mismatch', 'pin')) {
    return { result: snapshotResult(issues), ledger: null };
  }
  const receipt = input['receipt'];
  const ledger = input['ledger'];
  const currentRow = input['currentRow'];
  if (!requireExactRecord(receipt, COMPLETION_RECEIPT_KEYS, issues, 'predecessor-receipt-shape', 'receipt')) {
    return { result: snapshotResult(issues), ledger: null };
  }
  if (!requireExactRecord(ledger, CHAIN_LEDGER_KEYS, issues, 'predecessor-ledger-shape', 'ledger')) {
    return { result: snapshotResult(issues), ledger: null };
  }
  if (!requireExactRecord(currentRow, CHAIN_ROW_KEYS, issues, 'predecessor-current-row-shape', 'currentRow')) {
    return { result: snapshotResult(issues), ledger: null };
  }
  requireExactRecord(receipt['corpusDigests'], CORPUS_DIGEST_KEYS, issues, 'predecessor-corpus-shape', 'receipt.corpusDigests');
  requireExactRecord(ledger['corpusDigests'], CORPUS_DIGEST_KEYS, issues, 'predecessor-corpus-shape', 'ledger.corpusDigests');

  if (
    relation !== undefined
    && (pin['taskId'] !== relation.predecessorTaskId || pin['profileId'] !== relation.predecessorProfileId)
  ) {
    issues.push(issue('predecessor-profile-mismatch', 'predecessor task/profile differs from the generated relation'));
  }
  for (const [pinKey, receiptKey] of [
    ['taskId', 'taskId'],
    ['profileId', 'profileId'],
    ['runId', 'runId'],
    ['terminalHead', 'terminalHead'],
    ['manifestSha256', 'manifestSha256'],
  ] as const) {
    if (pin[pinKey] !== receipt[receiptKey]) {
      issues.push(issue('predecessor-pin-mismatch', `pin ${pinKey} differs from the completion receipt`, `pin.${pinKey}`));
    }
  }

  const observedLedgerSha = sha256Bytes(canonicalizeBoundaryRun(ledger));
  if (
    input['ledgerSha256'] !== observedLedgerSha
    || pin['ledgerSha256'] !== observedLedgerSha
    || receipt['ledgerSha256'] !== observedLedgerSha
  ) {
    issues.push(issue('predecessor-ledger-digest-mismatch', 'ledger digest does not match pin, receipt, and source bytes'));
  }
  const observedReceiptSha = sha256Bytes(canonicalizeBoundaryRun(receipt));
  if (input['receiptSha256'] !== observedReceiptSha || pin['completionReceiptSha256'] !== observedReceiptSha) {
    issues.push(issue('predecessor-receipt-digest-mismatch', 'completion receipt digest does not match the pin and source bytes'));
  }

  const inherited = input['inherited'];
  const expectedInherited = {
    reconciledBase: receipt['reconciledBase'],
    upstreamObservedOid: receipt['upstreamObservedOid'],
    corpusDigests: receipt['corpusDigests'],
    oracleDigest: receipt['oracleDigest'],
  };
  const ledgerInherited = {
    reconciledBase: ledger['reconciledBase'],
    upstreamObservedOid: ledger['upstreamObservedOid'],
    corpusDigests: ledger['corpusDigests'],
    oracleDigest: ledger['oracleDigest'],
  };
  if (
    canonicalizeBoundaryRun(inherited) !== canonicalizeBoundaryRun(expectedInherited)
    || canonicalizeBoundaryRun(ledgerInherited) !== canonicalizeBoundaryRun(expectedInherited)
  ) {
    issues.push(issue('predecessor-inherited-drift', 'inherited reconciliation, corpus, or oracle fields changed'));
  }

  const rows = requireRows(ledger['rows'], CHAIN_ROW_KEYS, issues, 'predecessor-ledger-nonlinear', 'ledger.rows');
  const runIds = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row['ordinal'] !== index + 1 || typeof row['runId'] !== 'string' || runIds.has(row['runId'])) {
      issues.push(issue('predecessor-ledger-nonlinear', 'ledger ordinals and run IDs must form one unique ordered chain'));
    }
    if (typeof row['runId'] === 'string') runIds.add(row['runId']);
    if (index === 0 ? row['previousLedgerSha256'] !== null : !isSha256(row['previousLedgerSha256'])) {
      issues.push(issue('predecessor-ledger-nonlinear', 'genesis alone has a null previous-ledger digest'));
    }
  }
  const terminalRow = rows.at(-1);
  if (
    terminalRow === undefined
    || terminalRow['taskId'] !== receipt['taskId']
    || terminalRow['profileId'] !== receipt['profileId']
    || terminalRow['runId'] !== receipt['runId']
    || terminalRow['entryHead'] !== receipt['entryHead']
    || terminalRow['terminalHead'] !== receipt['terminalHead']
    || terminalRow['manifestSha256'] !== receipt['manifestSha256']
    || terminalRow['overallVerdict'] !== receipt['overallVerdict']
  ) {
    issues.push(issue('predecessor-ledger-receipt-mismatch', 'terminal ledger row differs from the completion receipt'));
  }
  if (
    relation !== undefined
    && (currentRow['taskId'] !== relation.taskId || currentRow['profileId'] !== profileId)
  ) {
    issues.push(issue('predecessor-current-row-mismatch', 'current row is not authorized by the successor profile'));
  }
  if (currentRow['ordinal'] !== rows.length + 1 || currentRow['previousLedgerSha256'] !== observedLedgerSha) {
    issues.push(issue('predecessor-ledger-nonlinear', 'current row does not append the exact predecessor ledger'));
  }
  if (currentRow['entryHead'] !== receipt['terminalHead']) {
    issues.push(issue('predecessor-head-fork', 'successor entry head differs from predecessor terminal head'));
  }
  if (issues.length > 0) return { result: snapshotResult(issues), ledger: null };
  return {
    result: snapshotResult([]),
    ledger: {
      ...structuredClone(ledger),
      rows: [...structuredClone(rows), structuredClone(currentRow)],
    },
  };
}

const CHILD_IMPORT_PIN_KEYS = [
  'alias', 'kind', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead', 'manifestSha256',
] as const;

export function validateBoundaryChildImport(input: Record<string, unknown>): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const child = input['child'];
  const pin = input['pin'];
  if (!requireExactRecord(child, CHILD_KEYS, issues, 'child-shape-invalid', 'child')) {
    return snapshotResult(issues);
  }
  if (!requireExactRecord(pin, CHILD_IMPORT_PIN_KEYS, issues, 'child-pin-invalid', 'pin')) {
    return snapshotResult(issues);
  }
  for (const [childKey, pinKey] of [
    ['alias', 'alias'],
    ['kind', 'kind'],
    ['taskId', 'taskId'],
    ['profileId', 'profileId'],
    ['runId', 'runId'],
    ['entryHead', 'entryHead'],
    ['terminalHead', 'terminalHead'],
    ['sourceManifestSha256', 'manifestSha256'],
  ] as const) {
    if (child[childKey] !== pin[pinKey]) {
      issues.push(issue('child-identity-mismatch', `child ${childKey} differs from the profile pin`, `child.${childKey}`));
    }
  }
  if (
    child['sourceManifestSha256'] !== input['verifiedSourceManifestSha256']
    || !isSha256(input['verifiedSourceManifestSha256'])
  ) {
    issues.push(issue('child-identity-mismatch', 'child source manifest differs from the direct verifier digest'));
  }
  if (child['runId'] === input['parentRunId']) {
    issues.push(issue('child-cycle', 'a run cannot import itself'));
  }
  const parentDepth = input['parentDepth'];
  const maxDepth = input['maxDepth'];
  if (
    !Number.isSafeInteger(parentDepth)
    || !Number.isSafeInteger(maxDepth)
    || Number(parentDepth) < 0
    || Number(maxDepth) < 0
    || Number(parentDepth) + 1 > Number(maxDepth)
  ) {
    issues.push(issue('child-depth-exceeded', 'child import exceeds the profile-owned recursion depth'));
  }
  const existingAliases = input['existingAliases'];
  if (!Array.isArray(existingAliases) || existingAliases.includes(child['alias'])) {
    issues.push(issue('child-alias-collision', 'child alias is missing or already imported'));
  }
  const existingPaths = input['existingPaths'];
  if (!Array.isArray(existingPaths) || existingPaths.some((entry) => typeof entry !== 'string')) {
    issues.push(issue('child-path-collision', 'existing imported paths are malformed'));
  }

  const importedFiles = requireRows(
    child['importedFiles'],
    IMPORTED_FILE_KEYS,
    issues,
    'child-import-shape-invalid',
    'child.importedFiles',
  );
  const importedPaths = importedFiles.map((row) => row['path']);
  const sortedPaths = [...importedPaths].sort((left, right) => Buffer.from(String(left)).compare(Buffer.from(String(right))));
  if (
    new Set(importedPaths).size !== importedPaths.length
    || importedPaths.some((entry, index) => entry !== sortedPaths[index] || !isSafePath(entry))
  ) {
    issues.push(issue('child-path-collision', 'imported paths must be safe, sorted, and unique'));
  }
  if (
    Array.isArray(existingPaths)
    && importedPaths.some((entry) => existingPaths.includes(entry))
  ) {
    issues.push(issue('child-path-collision', 'child imported path collides with existing closure'));
  }
  if (child['treeDigestSha256'] !== sha256Bytes(canonicalizeBoundaryRun(importedFiles))) {
    issues.push(issue('child-tree-digest-mismatch', 'child tree digest differs from its imported-file rows'));
  }
  if (child['overallVerdict'] !== 'Pass') {
    issues.push(issue('child-nonpass', 'a required child must have Pass verdict'));
  }

  try {
    const importRoot = realpathSync(String(input['importRoot']));
    for (const row of importedFiles) {
      const current = capturePathRecord(importRoot, String(row['path']));
      if (current.sha256 !== row['sha256'] || current.bytes !== row['bytes']) {
        issues.push(issue('child-import-mutation', 'imported child file bytes changed', String(row['path'])));
      }
    }
    const manifestRow = importedFiles.find((row) => row['path'] === 'run_manifest.json');
    if (manifestRow === undefined || manifestRow['sha256'] !== child['sourceManifestSha256']) {
      issues.push(issue('child-identity-mismatch', 'imported manifest row differs from the pinned manifest digest'));
    }
  } catch (error) {
    issues.push(issue('child-import-mutation', `child import closure cannot be read: ${(error as Error).message}`));
  }
  return snapshotResult(issues);
}

const REVIEW_PROOF_ATTEMPT_KEYS = [
  'id', 'head', 'snapshotDigestSha256', 'rawExit', 'rawSignal', 'expectationMet', 'verdict',
] as const;
const FINDING_SEVERITIES = new Set(['blocker', 'critical', 'major', 'minor', 'note']);
const FINDING_DISPOSITIONS = new Set(['accepted', 'rejected', 'deferred']);
const FINDING_RESOLUTIONS = new Set(['open', 'fixed', 'not-applicable']);

function isOperationalReviewId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function isSortedUniqueStrings(value: unknown, predicate: (entry: string) => boolean): value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !predicate(entry))) return false;
  const sorted = [...value].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  return new Set(value).size === value.length
    && canonicalizeBoundaryRun(value) === canonicalizeBoundaryRun(sorted);
}

export function validateBoundaryReviewInput(input: unknown): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  if (!requireExactRecord(input, REVIEW_INPUT_KEYS, issues, 'review-input-shape-invalid', 'reviewInput')) {
    return snapshotResult(issues);
  }
  check(input['schemaVersion'] === 1, issues, 'review-input-schema-invalid', 'reviewInput.schemaVersion');
  check(isOperationalReviewId(input['reviewId']), issues, 'review-id-invalid', 'reviewInput.reviewId');
  check(isOperationalReviewId(input['dedupeKey']), issues, 'review-dedupe-invalid', 'reviewInput.dedupeKey');
  check(isOid(input['head']), issues, 'review-head-invalid', 'reviewInput.head');
  check(isSha256(input['snapshotDigestSha256']), issues, 'review-snapshot-invalid', 'reviewInput.snapshotDigestSha256');
  for (const prefix of ['report', 'meta', 'stderr'] as const) {
    check(isSafePath(input[`${prefix}Path`]), issues, 'review-path-invalid', `reviewInput.${prefix}Path`);
    check(isSha256(input[`${prefix}Sha256`]), issues, 'review-hash-invalid', `reviewInput.${prefix}Sha256`);
  }

  const findings = requireRows(
    input['findings'],
    FINDING_KEYS,
    issues,
    'finding-shape-invalid',
    'reviewInput.findings',
  );
  const contracts = requireRows(
    input['reproductionContracts'],
    REPRODUCTION_CONTRACT_KEYS,
    issues,
    'reproduction-contract-shape-invalid',
    'reviewInput.reproductionContracts',
  );
  const findingIds = findings.map((finding) => finding['findingId']);
  check(
    isSortedUniqueStrings(findingIds, (entry) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry)),
    issues,
    'finding-order-invalid',
    'reviewInput.findings',
  );

  const referenceCounts = new Map<string, number>();
  const countReferences = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry === 'string') referenceCounts.set(entry, (referenceCounts.get(entry) ?? 0) + 1);
    }
  };
  for (const [index, finding] of findings.entries()) {
    const base = `reviewInput.findings[${index}]`;
    check(
      typeof finding['findingId'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(finding['findingId']),
      issues,
      'finding-id-invalid',
      `${base}.findingId`,
    );
    check(FINDING_SEVERITIES.has(String(finding['severity'])), issues, 'finding-enum-invalid', `${base}.severity`);
    check(FINDING_DISPOSITIONS.has(String(finding['disposition'])), issues, 'finding-enum-invalid', `${base}.disposition`);
    check(FINDING_RESOLUTIONS.has(String(finding['resolution'])), issues, 'finding-enum-invalid', `${base}.resolution`);
    check(typeof finding['requiresFix'] === 'boolean', issues, 'finding-boolean-invalid', `${base}.requiresFix`);
    check(typeof finding['requiresReproduction'] === 'boolean', issues, 'finding-boolean-invalid', `${base}.requiresReproduction`);
    check(isSafePath(finding['evidencePath']), issues, 'finding-evidence-invalid', `${base}.evidencePath`);
    check(isSha256(finding['evidenceSha256']), issues, 'finding-evidence-invalid', `${base}.evidenceSha256`);
    check(
      finding['reason'] === null
        || (typeof finding['reason'] === 'string' && finding['reason'].trim() !== '' && Buffer.byteLength(finding['reason'], 'utf8') <= 4_096),
      issues,
      'finding-reason-invalid',
      `${base}.reason`,
    );
    check(
      isSortedUniqueStrings(finding['counterevidenceRefs'], (entry) => entry.length > 0 && Buffer.byteLength(entry, 'utf8') <= 1_024),
      issues,
      'finding-counterevidence-invalid',
      `${base}.counterevidenceRefs`,
    );
    for (const key of ['reproductionAttemptIds', 'counterReproductionAttemptIds', 'fixReproductionAttemptIds'] as const) {
      check(
        isSortedUniqueStrings(finding[key], isOperationalReviewId),
        issues,
        'finding-attempt-ids-invalid',
        `${base}.${key}`,
      );
      countReferences(finding[key]);
    }
    check(finding['fixedAtHead'] === null || isOid(finding['fixedAtHead']), issues, 'finding-fixed-head-invalid', `${base}.fixedAtHead`);
    check(finding['fixReviewId'] === null || isOperationalReviewId(finding['fixReviewId']), issues, 'finding-fix-review-invalid', `${base}.fixReviewId`);
    if (finding['requiresReproduction'] === true) {
      check(
        Array.isArray(finding['reproductionAttemptIds']) && finding['reproductionAttemptIds'].length > 0,
        issues,
        'finding-reproduction-contract-missing',
        `${base}.reproductionAttemptIds`,
      );
    }
    if (finding['disposition'] === 'rejected') {
      check(
        finding['resolution'] === 'not-applicable'
          && typeof finding['reason'] === 'string'
          && Array.isArray(finding['counterevidenceRefs'])
          && finding['counterevidenceRefs'].length > 0
          && Array.isArray(finding['counterReproductionAttemptIds'])
          && finding['counterReproductionAttemptIds'].length > 0
          && finding['fixedAtHead'] === null
          && Array.isArray(finding['fixReproductionAttemptIds'])
          && finding['fixReproductionAttemptIds'].length === 0
          && finding['fixReviewId'] === null,
        issues,
        'finding-fields-incompatible',
        base,
      );
    }
    if (finding['resolution'] === 'fixed') {
      check(
        finding['disposition'] === 'accepted'
          && isOid(finding['fixedAtHead'])
          && Array.isArray(finding['fixReproductionAttemptIds'])
          && finding['fixReproductionAttemptIds'].length > 0
          && isOperationalReviewId(finding['fixReviewId'])
          && finding['reason'] === null
          && Array.isArray(finding['counterevidenceRefs'])
          && finding['counterevidenceRefs'].length === 0
          && Array.isArray(finding['counterReproductionAttemptIds'])
          && finding['counterReproductionAttemptIds'].length === 0,
        issues,
        'finding-fields-incompatible',
        base,
      );
    }
  }

  const attemptIds = contracts.map((contract) => contract['attemptId']);
  check(
    isSortedUniqueStrings(attemptIds, isOperationalReviewId),
    issues,
    'reproduction-contract-order-invalid',
    'reviewInput.reproductionContracts',
  );
  for (const [index, contract] of contracts.entries()) {
    const base = `reviewInput.reproductionContracts[${index}]`;
    check(isOperationalReviewId(contract['attemptId']), issues, 'reproduction-contract-id-invalid', `${base}.attemptId`);
    check(
      Array.isArray(contract['argv'])
        && contract['argv'].length > 0
        && contract['argv'].length <= 128
        && contract['argv'].every((entry) => typeof entry === 'string' && entry.length > 0 && !/[\0\r\n]/.test(entry) && Buffer.byteLength(entry, 'utf8') <= 4_096),
      issues,
      'reproduction-contract-argv-invalid',
      `${base}.argv`,
    );
    check(typeof contract['expectedExit'] === 'string' && parseExpectedExit(contract['expectedExit']) !== null, issues, 'reproduction-contract-exit-invalid', `${base}.expectedExit`);
    check(isOperationalReviewId(contract['toolName']), issues, 'reproduction-contract-tool-invalid', `${base}.toolName`);
    check(contract['deadlineMs'] === 900_000, issues, 'reproduction-contract-deadline-invalid', `${base}.deadlineMs`);
    check(contract['killGraceMs'] === 30_000, issues, 'reproduction-contract-grace-invalid', `${base}.killGraceMs`);
  }
  const contractIds = new Set(attemptIds.filter((entry): entry is string => typeof entry === 'string'));
  for (const [attemptId, count] of referenceCounts) {
    check(count === 1 && contractIds.has(attemptId), issues, 'reproduction-contract-reference-invalid', `reviewInput.reproductionContracts.${attemptId}`);
  }
  for (const attemptId of contractIds) {
    check(referenceCounts.get(attemptId) === 1, issues, 'reproduction-contract-unreferenced', `reviewInput.reproductionContracts.${attemptId}`);
  }
  return snapshotResult(issues);
}

export function aggregateBoundaryReviewFindingVerdict(
  reviews: readonly BoundaryReviewRecord[],
): BoundaryVerdict {
  let verdict: BoundaryVerdict = 'Pass';
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (finding.disposition === 'deferred' && finding.requiresFix) {
        if (finding.severity === 'blocker' || finding.severity === 'critical') return 'Blocked';
        verdict = 'Inconclusive';
        continue;
      }
      if (finding.disposition !== 'accepted' || finding.resolution === 'fixed') continue;
      if (
        finding.requiresFix
        && (finding.severity === 'blocker' || finding.severity === 'critical')
      ) return 'Blocked';
      if (finding.severity === 'major' || finding.severity === 'minor') verdict = 'Fail';
    }
  }
  return verdict;
}

export function validateBoundaryReviewJoins(input: Record<string, unknown>): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const reviews = requireRows(input['reviews'], REVIEW_KEYS, issues, 'review-shape-invalid', 'reviews');
  const attempts = requireRows(
    input['attempts'],
    REVIEW_PROOF_ATTEMPT_KEYS,
    issues,
    'review-attempt-shape-invalid',
    'attempts',
  );
  const reviewIds = new Set<string>();
  const reviewAliases = new Set<string>();
  const reviewDedupeKeys = new Set<string>();
  const findingIds = new Set<string>();
  for (const review of reviews) {
    const reviewId = String(review['reviewId']);
    const alias = String(review['alias']);
    const dedupeKey = String(review['dedupeKey']);
    if (reviewIds.has(reviewId) || reviewAliases.has(alias) || reviewDedupeKeys.has(dedupeKey)) {
      issues.push(issue('review-duplicate', 'review ID, alias, and dedupe key must be globally unique', reviewId));
    }
    reviewIds.add(reviewId);
    reviewAliases.add(alias);
    reviewDedupeKeys.add(dedupeKey);
    const sourceShape = { schemaVersion: 1, ...review };
    delete (sourceShape as { alias?: unknown }).alias;
    issues.push(...validateBoundaryReviewInput(sourceShape).issues);
    const findings = requireRows(
      review['findings'],
      FINDING_KEYS,
      issues,
      'finding-shape-invalid',
      `reviews.${reviewId}.findings`,
    );
    requireRows(
      review['reproductionContracts'],
      REPRODUCTION_CONTRACT_KEYS,
      issues,
      'reproduction-contract-shape-invalid',
      `reviews.${reviewId}.reproductionContracts`,
    );
    for (const finding of findings) {
      const findingId = String(finding['findingId']);
      if (findingIds.has(findingId)) {
        issues.push(issue('finding-duplicate', 'finding IDs must be globally unique', findingId));
      }
      findingIds.add(findingId);
      if (
        !FINDING_SEVERITIES.has(String(finding['severity']))
        || !FINDING_DISPOSITIONS.has(String(finding['disposition']))
        || !FINDING_RESOLUTIONS.has(String(finding['resolution']))
      ) {
        issues.push(issue('finding-enum-invalid', 'finding severity, disposition, or resolution is outside the closed set', findingId));
      }
      const reproductionIds = Array.isArray(finding['reproductionAttemptIds'])
        ? finding['reproductionAttemptIds'] as unknown[]
        : [];
      const counterIds = Array.isArray(finding['counterReproductionAttemptIds'])
        ? finding['counterReproductionAttemptIds'] as unknown[]
        : [];
      const fixIds = Array.isArray(finding['fixReproductionAttemptIds'])
        ? finding['fixReproductionAttemptIds'] as unknown[]
        : [];
      const proofValid = (id: unknown, head: unknown, snapshotDigest: unknown): boolean => {
        const matches = attempts.filter((attempt) => attempt['id'] === id);
        return matches.length === 1
          && matches[0]!['head'] === head
          && matches[0]!['snapshotDigestSha256'] === snapshotDigest
          && matches[0]!['expectationMet'] === true
          && matches[0]!['verdict'] === 'Pass'
          && (matches[0]!['rawExit'] !== null) !== (matches[0]!['rawSignal'] !== null);
      };
      if (
        finding['requiresReproduction'] === true
        && (
          reproductionIds.length === 0
          || reproductionIds.some((id) => !proofValid(id, review['head'], review['snapshotDigestSha256']))
        )
      ) {
        issues.push(issue('finding-reproduction-missing', 'required finding reproduction is missing or not bound to the review head', findingId));
      }
      if (finding['disposition'] === 'rejected') {
        const refs = Array.isArray(finding['counterevidenceRefs']) ? finding['counterevidenceRefs'] : [];
        if (
          typeof finding['reason'] !== 'string'
          || finding['reason'].trim() === ''
          || refs.length === 0
          || counterIds.length === 0
          || counterIds.some((id) => !proofValid(id, review['head'], review['snapshotDigestSha256']))
        ) {
          issues.push(issue('finding-rejection-unsupported', 'rejected finding lacks exact counterevidence and reproduction', findingId));
        }
        if (
          finding['resolution'] !== 'not-applicable'
          || finding['fixedAtHead'] !== null
          || fixIds.length !== 0
          || finding['fixReviewId'] !== null
        ) {
          issues.push(issue('finding-fields-incompatible', 'rejected finding has incompatible fix fields', findingId));
        }
      }
      if (finding['resolution'] === 'fixed') {
        const fixReview = reviews.find((candidate) => candidate['reviewId'] === finding['fixReviewId']);
        if (
          finding['disposition'] !== 'accepted'
          || !isOid(finding['fixedAtHead'])
          || finding['fixedAtHead'] !== input['currentHead']
          || fixReview === undefined
          || fixReview['head'] !== finding['fixedAtHead']
          || fixIds.length === 0
          || fixIds.some((id) => !proofValid(id, finding['fixedAtHead'], fixReview?.['snapshotDigestSha256']))
        ) {
          issues.push(issue('finding-fix-head-mismatch', 'fixed finding lacks later exact-head review and reproduction proof', findingId));
        }
        if (
          finding['reason'] !== null
          || (Array.isArray(finding['counterevidenceRefs']) && finding['counterevidenceRefs'].length !== 0)
          || counterIds.length !== 0
        ) {
          issues.push(issue('finding-fields-incompatible', 'fixed finding has incompatible rejection fields', findingId));
        }
      }
    }
  }
  return snapshotResult(issues);
}

const UPSTREAM_ATTEMPT_OUTPUT_KEYS = [
  'remoteUrl', 'observedOid', 'mergeBase', 'ahead', 'behind', 'remotePaths', 'localPaths',
  'observationManifestSha256',
] as const;
const TRANSITION_CONTRACT_KEYS = [
  'kind', 'expectedBeforeHead', 'expectedSecondParent', 'allowedPaths',
] as const;
const TRANSITION_RECORD_KEYS = [
  'kind', 'rawExit', 'rawSignal', 'beforeHead', 'afterHead', 'parents', 'frozenIndexTreeOid',
  'postIndexTreeOid', 'commitTreeOid', 'changedPaths', 'conflictPaths', 'abortAttempted',
  'abortRestored', 'beforeSnapshotDigestSha256', 'afterSnapshotDigestSha256',
  'conflictResolutionReport',
] as const;

export function deriveBoundaryUpstreamAndTransition(input: Record<string, unknown>): {
  result: BoundaryValidationResult;
  upstream: Record<string, unknown> | null;
  transitionCount: number;
} {
  const issues: BoundaryValidationIssue[] = [];
  if (input['existingUpstream'] !== null) {
    issues.push(issue('upstream-already-set', 'upstream state is single-assignment'));
  }
  if (!isRecord(input['callerFields']) || Object.keys(input['callerFields']).length !== 0) {
    issues.push(issue('upstream-caller-substitution', 'upstream fields must derive only from accepted attempt outputs'));
  }
  const outputs = input['attemptOutputs'];
  const contract = input['contract'];
  const transition = input['transition'];
  if (!requireExactRecord(outputs, UPSTREAM_ATTEMPT_OUTPUT_KEYS, issues, 'upstream-output-shape', 'attemptOutputs')) {
    return { result: snapshotResult(issues), upstream: null, transitionCount: Number(input['transitionCount']) };
  }
  if (!requireExactRecord(contract, TRANSITION_CONTRACT_KEYS, issues, 'transition-contract-shape', 'contract')) {
    return { result: snapshotResult(issues), upstream: null, transitionCount: Number(input['transitionCount']) };
  }
  if (!requireExactRecord(transition, TRANSITION_RECORD_KEYS, issues, 'transition-record-shape', 'transition')) {
    return { result: snapshotResult(issues), upstream: null, transitionCount: Number(input['transitionCount']) };
  }
  if (transition['conflictResolutionReport'] !== null) {
    if (!isRecord(transition['conflictResolutionReport'])) {
      issues.push(issue('transition-record-shape', 'conflict resolution report must be one closed object or null'));
    } else {
      issues.push(...validateBoundaryStructuredRecord(
        'MergeConflictResolutionReport',
        transition['conflictResolutionReport'],
      ).issues);
    }
  }
  if (
    typeof outputs['remoteUrl'] !== 'string'
    || !/^git@[^:]+:[^\s]+$/.test(outputs['remoteUrl'])
    || !isOid(outputs['observedOid'])
    || !isOid(outputs['mergeBase'])
    || !Number.isSafeInteger(outputs['ahead'])
    || Number(outputs['ahead']) < 0
    || !Number.isSafeInteger(outputs['behind'])
    || Number(outputs['behind']) < 0
    || !isSha256(outputs['observationManifestSha256'])
  ) {
    issues.push(issue('upstream-output-invalid', 'upstream attempt outputs violate the closed grammar'));
  }
  for (const key of ['remotePaths', 'localPaths'] as const) {
    const values = outputs[key];
    if (
      !Array.isArray(values)
      || new Set(values).size !== values.length
      || values.some((entry) => !isSafePath(entry))
      || values.some((entry, index) => index > 0 && Buffer.from(String(values[index - 1])).compare(Buffer.from(String(entry))) >= 0)
    ) {
      issues.push(issue('upstream-paths-invalid', `${key} must be a sorted unique path set`, key));
    }
  }
  if (input['transitionCount'] !== 0) {
    issues.push(issue('transition-already-used', 'profile permits exactly one transition'));
  }
  if (transition['kind'] !== contract['kind'] || transition['beforeHead'] !== contract['expectedBeforeHead']) {
    issues.push(issue('transition-parent-mismatch', 'transition kind or before-head differs from its contract'));
  }
  const directSucceeded = transition['rawExit'] === 0 && transition['rawSignal'] === null;
  const directFailed = Number.isInteger(transition['rawExit'])
    && Number(transition['rawExit']) !== 0
    && transition['rawSignal'] === null;
  if (!directSucceeded && !directFailed) {
    issues.push(issue('transition-status-invalid', 'transition requires one direct exit status'));
  }
  if (directSucceeded) {
    if (
      !Array.isArray(transition['parents'])
      || transition['parents'].length !== 2
      || transition['parents'][0] !== contract['expectedBeforeHead']
      || transition['parents'][1] !== contract['expectedSecondParent']
    ) {
      issues.push(issue('transition-parent-mismatch', 'merge parents differ from the frozen transition contract'));
    }
    if (
      transition['commitTreeOid'] !== transition['postIndexTreeOid']
      || !isOid(transition['commitTreeOid'])
      || !isOid(transition['afterHead'])
    ) {
      issues.push(issue('transition-tree-mismatch', 'commit tree, post index tree, or advanced head is inconsistent'));
    }
    if (canonicalizeBoundaryRun(transition['changedPaths']) !== canonicalizeBoundaryRun(contract['allowedPaths'])) {
      issues.push(issue('transition-path-mismatch', 'transition changed paths differ from the profile allowlist'));
    }
    if (transition['abortAttempted'] !== false || transition['abortRestored'] !== null) {
      issues.push(issue('transition-abort-incomplete', 'successful transition cannot carry abort state'));
    }
  } else if (
    transition['abortAttempted'] !== true
    || transition['abortRestored'] !== true
    || transition['afterHead'] !== transition['beforeHead']
    || transition['afterSnapshotDigestSha256'] !== transition['beforeSnapshotDigestSha256']
  ) {
    issues.push(issue('transition-abort-incomplete', 'failed transition did not restore the exact pre-state'));
  }
  const upstream = directSucceeded ? {
    remoteUrl: outputs['remoteUrl'],
    observedOid: outputs['observedOid'],
    mergeBase: outputs['mergeBase'],
    ahead: outputs['ahead'],
    behind: outputs['behind'],
    remotePaths: outputs['remotePaths'],
    localPaths: outputs['localPaths'],
    observationManifestSha256: outputs['observationManifestSha256'],
    mergeCommit: transition['afterHead'],
    mergeParents: transition['parents'],
  } : null;
  return {
    result: snapshotResult(issues),
    upstream: issues.length === 0 ? upstream : null,
    transitionCount: issues.length === 0 && directSucceeded ? 1 : Number(input['transitionCount']),
  };
}

const FINAL_BUNDLE_FILE_KEYS = [
  'manifestLock', 'completionReceipt', 'completionReceiptLock', 'ledger', 'ledgerLock',
] as const;
const LIFECYCLE_STATE_PROFILE_KEYS = ['terminalLifecycle', 'requiredAttemptIds', 'requiredChildAliases'] as const;
const LIFECYCLE_STATE_KEYS = ['status', 'finalGate'] as const;
const LIFECYCLE_ATTEMPT_KEYS = ['id', 'expectationMet', 'verdict'] as const;
const LIFECYCLE_CHILD_KEYS = ['alias', 'overallVerdict'] as const;

export function verifyBoundaryLifecycleState(input: Record<string, unknown>): {
  result: BoundaryValidationResult;
  verificationScope: 'active' | 'finalized' | null;
} {
  const issues: BoundaryValidationIssue[] = [];
  const manifestState = input['manifestState'];
  const scope = manifestState === 'active'
    ? 'active'
    : manifestState === 'finalized' || manifestState === 'verified-pass-closeout-rejected'
      ? 'finalized'
      : null;
  if (scope === null) issues.push(issue('verification-state-invalid', 'manifest state is outside the closed state machine'));
  const profile = input['profile'];
  const lifecycle = input['lifecycle'];
  const presentFiles = input['presentFiles'];
  if (!requireExactRecord(profile, LIFECYCLE_STATE_PROFILE_KEYS, issues, 'lifecycle-profile-shape', 'profile')) {
    return { result: snapshotResult(issues), verificationScope: scope };
  }
  if (!requireExactRecord(lifecycle, LIFECYCLE_STATE_KEYS, issues, 'lifecycle-invalid', 'lifecycle')) {
    return { result: snapshotResult(issues), verificationScope: scope };
  }
  if (!requireExactRecord(presentFiles, FINAL_BUNDLE_FILE_KEYS, issues, 'verification-state-mixed', 'presentFiles')) {
    return { result: snapshotResult(issues), verificationScope: scope };
  }
  const lifecycleStatuses = new Set(['pending', 'active', 'completed', 'deferred', 'closed', 'blocked']);
  const finalGates = new Set(['not-run', 'pass', 'fail', 'inconclusive', 'blocked']);
  if (!lifecycleStatuses.has(String(lifecycle['status'])) || !finalGates.has(String(lifecycle['finalGate']))) {
    issues.push(issue('lifecycle-invalid', 'lifecycle status or final gate is outside the closed enum'));
  }
  if (lifecycle['status'] !== profile['terminalLifecycle'] || lifecycle['finalGate'] !== 'pass') {
    issues.push(issue('lifecycle-terminal-mismatch', 'lifecycle has not reached the profile terminal Pass state'));
  }
  const fileValues = FINAL_BUNDLE_FILE_KEYS.map((key) => presentFiles[key]);
  if (
    fileValues.some((value) => typeof value !== 'boolean')
    || (scope === 'active' && fileValues.some(Boolean))
    || (scope === 'finalized' && fileValues.some((value) => value !== true))
  ) {
    issues.push(issue('verification-state-mixed', 'active/finalized manifest and sibling files are mixed'));
  }
  if (
    !isOid(input['entryHead'])
    || !isOid(input['terminalHead'])
    || input['entryHead'] !== input['terminalHead']
  ) {
    issues.push(issue('lifecycle-head-mismatch', 'no-transition lifecycle must retain one exact head'));
  }
  if (
    !isSha256(input['currentSnapshotDigestSha256'])
    || input['currentSnapshotDigestSha256'] !== input['liveSnapshotDigestSha256']
  ) {
    issues.push(issue('verification-snapshot-drift', 'live snapshot differs from the manifest current snapshot'));
  }
  const attempts = requireRows(
    input['attempts'],
    LIFECYCLE_ATTEMPT_KEYS,
    issues,
    'lifecycle-attempt-shape',
    'attempts',
  );
  const children = requireRows(
    input['children'],
    LIFECYCLE_CHILD_KEYS,
    issues,
    'lifecycle-child-shape',
    'children',
  );
  const requiredAttemptIds = Array.isArray(profile['requiredAttemptIds']) ? profile['requiredAttemptIds'] : [];
  const requiredChildAliases = Array.isArray(profile['requiredChildAliases']) ? profile['requiredChildAliases'] : [];
  for (const requiredId of requiredAttemptIds) {
    const matches = attempts.filter((attempt) => attempt['id'] === requiredId);
    if (matches.length !== 1 || matches[0]!['expectationMet'] !== true || matches[0]!['verdict'] !== 'Pass') {
      issues.push(issue('lifecycle-required-incomplete', `required attempt is missing or non-pass: ${String(requiredId)}`));
    }
  }
  for (const requiredAlias of requiredChildAliases) {
    const matches = children.filter((child) => child['alias'] === requiredAlias);
    if (matches.length !== 1 || matches[0]!['overallVerdict'] !== 'Pass') {
      issues.push(issue('lifecycle-required-incomplete', `required child is missing or non-pass: ${String(requiredAlias)}`));
    }
  }
  return { result: snapshotResult(issues), verificationScope: scope };
}

const CLOSEOUT_BUNDLE_OBJECT_KEYS = [
  'runManifest', 'ledger', 'completionReceipt', 'closeoutCore', 'negativeReport', 'closeoutReceipt',
] as const;
const BUNDLE_RUN_MANIFEST_KEYS = ['schemaVersion', 'runId', 'manifestState'] as const;
const BUNDLE_LEDGER_KEYS = ['schemaVersion', 'runId', 'rows'] as const;
const BUNDLE_COMPLETION_KEYS = ['schemaVersion', 'runId', 'manifestSha256', 'ledgerSha256'] as const;
const BUNDLE_CORE_KEYS = [
  'schemaVersion', 'runId', 'runManifestSha256', 'completionReceiptSha256', 'ledgerSha256',
] as const;
const BUNDLE_REPORT_KEYS = ['schemaVersion', 'runId', 'closeoutCoreSha256', 'cases'] as const;
const BUNDLE_RECEIPT_KEYS = [
  'schemaVersion', 'kind', 'runId', 'runManifestSha256', 'completionReceiptSha256', 'ledgerSha256',
  'closeoutCoreSha256', 'negativeControlReportSha256', 'overallVerdict',
] as const;

function durableExclusiveWrite(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const descriptor = openSync(filePath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function publishBoundaryCloseoutBundle(input: Record<string, unknown>): {
  result: BoundaryValidationResult;
  bundlePath: string | null;
} {
  const issues: BoundaryValidationIssue[] = [];
  const objects = input['objects'];
  if (!requireExactRecord(objects, CLOSEOUT_BUNDLE_OBJECT_KEYS, issues, 'bundle-hash-mismatch', 'objects')) {
    return { result: snapshotResult(issues), bundlePath: null };
  }
  const shapes = [
    ['runManifest', BUNDLE_RUN_MANIFEST_KEYS],
    ['ledger', BUNDLE_LEDGER_KEYS],
    ['completionReceipt', BUNDLE_COMPLETION_KEYS],
    ['closeoutCore', BUNDLE_CORE_KEYS],
    ['negativeReport', BUNDLE_REPORT_KEYS],
    ['closeoutReceipt', BUNDLE_RECEIPT_KEYS],
  ] as const;
  for (const [name, keys] of shapes) {
    requireExactRecord(objects[name], keys, issues, 'bundle-hash-mismatch', `objects.${name}`);
  }
  if (issues.length > 0) return { result: snapshotResult(issues), bundlePath: null };
  const runManifest = objects['runManifest'] as Record<string, unknown>;
  const ledger = objects['ledger'] as Record<string, unknown>;
  const completion = objects['completionReceipt'] as Record<string, unknown>;
  const core = objects['closeoutCore'] as Record<string, unknown>;
  const report = objects['negativeReport'] as Record<string, unknown>;
  const receipt = objects['closeoutReceipt'] as Record<string, unknown>;
  const runManifestSha256 = sha256Bytes(canonicalizeBoundaryRun(runManifest));
  const ledgerSha256 = sha256Bytes(canonicalizeBoundaryRun(ledger));
  const completionReceiptSha256 = sha256Bytes(canonicalizeBoundaryRun(completion));
  const closeoutCoreSha256 = sha256Bytes(canonicalizeBoundaryRun(core));
  const negativeControlReportSha256 = sha256Bytes(canonicalizeBoundaryRun(report));
  const runId = input['runId'];
  if (
    !isSafePath(runId)
    || [runManifest, ledger, completion, core, report, receipt].some((value) => value['runId'] !== runId)
    || completion['manifestSha256'] !== runManifestSha256
    || completion['ledgerSha256'] !== ledgerSha256
    || core['runManifestSha256'] !== runManifestSha256
    || core['completionReceiptSha256'] !== completionReceiptSha256
    || core['ledgerSha256'] !== ledgerSha256
    || report['closeoutCoreSha256'] !== closeoutCoreSha256
    || receipt['runManifestSha256'] !== runManifestSha256
    || receipt['completionReceiptSha256'] !== completionReceiptSha256
    || receipt['ledgerSha256'] !== ledgerSha256
    || receipt['closeoutCoreSha256'] !== closeoutCoreSha256
    || receipt['negativeControlReportSha256'] !== negativeControlReportSha256
    || receipt['kind'] !== input['kind']
    || receipt['overallVerdict'] !== 'Pass'
  ) {
    issues.push(issue('bundle-hash-mismatch', 'closeout objects do not form one hash-joined identity'));
  }
  let acceptedParent: string;
  let rejectedParent: string;
  try {
    acceptedParent = realpathSync(String(input['acceptedParent']));
    rejectedParent = realpathSync(String(input['rejectedParent']));
  } catch (error) {
    return { result: snapshotResult([issue('bundle-path-invalid', (error as Error).message)]), bundlePath: null };
  }
  if (isPathOverlap(acceptedParent, rejectedParent)) {
    issues.push(issue('bundle-path-collision', 'accepted and rejected publication parents must be disjoint'));
  }
  const parent = input['kind'] === 'accepted' ? acceptedParent : rejectedParent;
  const destination = path.join(parent, String(runId));
  const staging = path.join(parent, `.${String(runId)}.publishing`);
  try {
    lstatSync(destination);
    issues.push(issue('bundle-root-reused', 'derived bundle path already exists', destination));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      issues.push(issue('bundle-path-invalid', (error as Error).message, destination));
    }
  }
  try {
    lstatSync(staging);
    issues.push(issue('bundle-partial-publication', 'staging path already exists', staging));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      issues.push(issue('bundle-path-invalid', (error as Error).message, staging));
    }
  }
  if (issues.length > 0) return { result: snapshotResult(issues), bundlePath: null };

  try {
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    const files: Array<[string, string]> = [
      ['run_manifest.json', canonicalizeBoundaryRun(runManifest)],
      ['run_manifest.sha256', `${runManifestSha256}  run_manifest.json\n`],
      ['completion_receipt.json', canonicalizeBoundaryRun(completion)],
      ['completion_receipt.sha256', `${completionReceiptSha256}  completion_receipt.json\n`],
      ['chain_ledger.json', canonicalizeBoundaryRun(ledger)],
      ['chain_ledger.sha256', `${ledgerSha256}  chain_ledger.json\n`],
      ['closeout_core.json', canonicalizeBoundaryRun(core)],
      ['negative_control_report.json', canonicalizeBoundaryRun(report)],
      ['closeout_receipt.json', canonicalizeBoundaryRun(receipt)],
      ['closeout_receipt.sha256', `${sha256Bytes(canonicalizeBoundaryRun(receipt))}  closeout_receipt.json\n`],
    ];
    for (const [basename, content] of files) durableExclusiveWrite(path.join(staging, basename), content);
    const directoryDescriptor = openSync(staging, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    renameSync(staging, destination);
    const parentDescriptor = openSync(parent, 'r');
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
    return { result: snapshotResult([]), bundlePath: destination };
  } catch (error) {
    return {
      result: snapshotResult([issue('bundle-partial-publication', `bundle publication failed before atomic acceptance: ${(error as Error).message}`)]),
      bundlePath: null,
    };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPromiseOrTimeout(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function processGroupAlive(pid: number): boolean {
  try {
    const table = execFileSync('ps', ['-axo', 'pid=,pgid='], {
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return table.split(/\r?\n/).some((line) => {
      const columns = line.trim().split(/\s+/);
      return columns.length >= 2 && Number(columns[1]) === pid;
    });
  } catch {
    return true;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForProcessGroupExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (processGroupAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(remaining, 10));
  }
  return true;
}

interface BoundaryWatchdogCoreOptions {
  deadlineMs: number;
  killGraceMs: number;
  expectedExit: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinFd?: number | 'ignore';
  stdoutFd?: number | 'ignore';
  stderrFd?: number | 'ignore';
}

export interface BoundaryWatchdogOutcome {
  result: BoundaryValidationResult;
  rawExit: number | null;
  rawSignal: string | null;
  timedOut: boolean;
  groupDead: boolean;
  startedAtUtc: string;
  endedAtUtc: string;
}

async function executeBoundaryWatchdog(
  argv: string[],
  options: BoundaryWatchdogCoreOptions,
): Promise<BoundaryWatchdogOutcome> {
  const startedAtUtc = new Date().toISOString();
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    cwd: options.cwd,
    env: options.env ?? cleanGitEnv(),
    stdio: [options.stdinFd ?? 'ignore', options.stdoutFd ?? 'ignore', options.stderrFd ?? 'ignore'],
  });
  const pid = child.pid;
  if (pid === undefined) {
    return {
      result: snapshotResult([issue('watchdog-spawn-failed', 'child process has no PID')]),
      rawExit: null,
      rawSignal: null,
      timedOut: false,
      groupDead: true,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
    };
  }
  let rawExit: number | null = null;
  let rawSignal: string | null = null;
  let spawnError: string | null = null;
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      rawExit = code;
      rawSignal = signal;
      resolve();
    });
    child.once('error', (error) => {
      spawnError = error.message;
      resolve();
    });
  });
  const completedBeforeDeadline = await waitForPromiseOrTimeout(closed, options.deadlineMs);
  const timedOut = !completedBeforeDeadline;
  if (timedOut) {
    signalProcessGroup(pid, 'SIGTERM');
    if (!await waitForProcessGroupExit(pid, options.killGraceMs)) {
      signalProcessGroup(pid, 'SIGKILL');
      await waitForProcessGroupExit(pid, 500);
    }
    await waitForPromiseOrTimeout(closed, 100);
  }
  const survivedNaturalExit = !timedOut && processGroupAlive(pid);
  if (survivedNaturalExit) {
    signalProcessGroup(pid, 'SIGTERM');
    if (!await waitForProcessGroupExit(pid, options.killGraceMs)) {
      signalProcessGroup(pid, 'SIGKILL');
      await waitForProcessGroupExit(pid, 500);
    }
  }
  const groupDead = !processGroupAlive(pid);
  const issues: BoundaryValidationIssue[] = [];
  if (spawnError !== null) issues.push(issue('watchdog-spawn-failed', spawnError));
  if (timedOut) issues.push(issue('watchdog-timeout', 'child exceeded the helper-owned monotonic deadline'));
  if (rawSignal !== null) issues.push(issue('watchdog-signal', `child terminated by ${rawSignal}`));
  const expected = parseExpectedExit(options.expectedExit);
  const expectationMet = rawExit !== null && expected !== null
    ? expected === 'nonzero' ? rawExit !== 0 : expected.has(rawExit)
    : false;
  if (!timedOut && rawSignal === null && !expectationMet) {
    issues.push(issue('watchdog-exit-mismatch', 'direct child exit did not satisfy the expected status'));
  }
  if (survivedNaturalExit || !groupDead) {
    issues.push(issue('watchdog-group-survivor', 'child process group survived leader completion or teardown'));
  }
  return {
    result: snapshotResult(issues), rawExit, rawSignal, timedOut, groupDead,
    startedAtUtc, endedAtUtc: new Date().toISOString(),
  };
}

export async function runBoundaryWatchdogForTest(
  argv: string[],
  options: { deadlineMs: number; killGraceMs: number; expectedExit: string },
): Promise<BoundaryWatchdogOutcome> {
  if (
    argv.length === 0
    || options.deadlineMs <= 0
    || options.deadlineMs > 250
    || options.killGraceMs <= 0
    || options.killGraceMs > 100
  ) {
    const now = new Date().toISOString();
    return {
      result: snapshotResult([issue('watchdog-test-contract-invalid', 'test-only watchdog bounds are 1..250 ms plus 1..100 ms grace')]),
      rawExit: null,
      rawSignal: null,
      timedOut: false,
      groupDead: true,
      startedAtUtc: now,
      endedAtUtc: now,
    };
  }
  return executeBoundaryWatchdog(argv, options);
}

export async function runBoundaryAttemptProcess(
  argv: string[],
  options: {
    deadlineMs: number;
    killGraceMs: number;
    expectedExit: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdinPath: string | null;
    stdoutPath: string;
    stderrPath: string;
  },
): Promise<BoundaryWatchdogOutcome> {
  if (
    argv.length === 0
    || options.deadlineMs <= 0
    || options.deadlineMs > 1_860_000
    || options.killGraceMs !== 30_000
  ) {
    const now = new Date().toISOString();
    return {
      result: snapshotResult([issue('watchdog-contract-mismatch', 'production watchdog bounds differ from the closed attempt contract')]),
      rawExit: null,
      rawSignal: null,
      timedOut: false,
      groupDead: true,
      startedAtUtc: now,
      endedAtUtc: now,
    };
  }
  let stdinFd: number | null = null;
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  try {
    if (options.stdinPath !== null) stdinFd = openSync(options.stdinPath, 'r');
    stdoutFd = openSync(options.stdoutPath, 'wx', 0o600);
    stderrFd = openSync(options.stderrPath, 'wx', 0o600);
    const outcome = await executeBoundaryWatchdog(argv, {
      deadlineMs: options.deadlineMs,
      killGraceMs: options.killGraceMs,
      expectedExit: options.expectedExit,
      cwd: options.cwd,
      env: options.env,
      stdinFd: stdinFd ?? 'ignore',
      stdoutFd,
      stderrFd,
    });
    fsyncSync(stdoutFd);
    fsyncSync(stderrFd);
    return outcome;
  } finally {
    if (stdinFd !== null) closeSync(stdinFd);
    if (stdoutFd !== null) closeSync(stdoutFd);
    if (stderrFd !== null) closeSync(stderrFd);
  }
}

export function validateBoundaryOuterWatchdogRecord(
  kind: 'closeout' | 'verify-closeout',
  recorded: Record<string, unknown>,
  observed: Record<string, unknown>,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const expectedDeadline = kind === 'closeout' ? 600_000 : 300_000;
  if (recorded['deadlineMs'] !== expectedDeadline || recorded['killGraceMs'] !== 30_000) {
    issues.push(issue('watchdog-contract-mismatch', `${kind} must use its exact production deadline and grace`));
  }
  if (recorded['rawExit'] !== observed['rawExit'] || recorded['rawSignal'] !== observed['rawSignal']) {
    issues.push(issue('watchdog-status-masked', 'recorded outer status differs from the direct observed status'));
  }
  if (recorded['groupDead'] !== true || observed['groupDead'] !== true) {
    issues.push(issue('watchdog-group-survivor', 'outer process group was not fully reaped'));
  }
  if (recorded['rawSignal'] !== null) issues.push(issue('watchdog-signal', 'outer helper terminated by signal'));
  if (recorded['rawExit'] === 124 || recorded['rawExit'] === 137) {
    issues.push(issue('watchdog-timeout', 'outer helper reached GNU timeout status'));
  }
  return snapshotResult(issues);
}

export function validateBoundaryImmutableClosure(input: Record<string, unknown>): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  let closureRoot: string;
  try {
    closureRoot = realpathSync(String(input['closureRoot']));
  } catch (error) {
    return snapshotResult([issue('immutable-root-invalid', (error as Error).message)]);
  }
  const closureFiles = requireRows(
    input['closureFiles'],
    IMPORTED_FILE_KEYS,
    issues,
    'immutable-file-shape',
    'closureFiles',
  );
  const paths = closureFiles.map((row) => row['path']);
  const sortedPaths = [...paths].sort((left, right) => Buffer.from(String(left)).compare(Buffer.from(String(right))));
  if (
    new Set(paths).size !== paths.length
    || paths.some((entry, index) => entry !== sortedPaths[index] || !isSafePath(entry))
  ) {
    issues.push(issue('immutable-file-shape', 'immutable closure paths must be safe, sorted, and unique'));
  }
  for (const row of closureFiles) {
    try {
      const current = capturePathRecord(closureRoot, String(row['path']));
      if (current.sha256 !== row['sha256'] || current.bytes !== row['bytes']) {
        issues.push(issue('immutable-file-drift', 'finalized closure file changed', String(row['path'])));
      }
    } catch (error) {
      issues.push(issue('immutable-file-drift', `finalized closure file is unavailable: ${(error as Error).message}`, String(row['path'])));
    }
  }
  const helper = input['helper'];
  if (!requireExactRecord(helper, IMPORTED_FILE_KEYS, issues, 'helper-hash-drift', 'helper')) {
    issues.push(issue('helper-hash-drift', 'helper identity row is malformed'));
  } else {
    try {
      const current = capturePathRecord(closureRoot, String(helper['path']));
      if (current.sha256 !== helper['sha256'] || current.bytes !== helper['bytes']) {
        issues.push(issue('helper-hash-drift', 'helper bytes differ from the finalized identity'));
      }
    } catch (error) {
      issues.push(issue('helper-hash-drift', (error as Error).message));
    }
  }
  const documents = requireRows(
    input['documents'],
    IMPORTED_FILE_KEYS,
    issues,
    'document-hash-drift',
    'documents',
  );
  for (const document of documents) {
    try {
      const current = capturePathRecord(closureRoot, String(document['path']));
      if (current.sha256 !== document['sha256'] || current.bytes !== document['bytes']) {
        issues.push(issue('document-hash-drift', 'document bytes differ from the finalized identity', String(document['path'])));
      }
    } catch (error) {
      issues.push(issue('document-hash-drift', (error as Error).message, String(document['path'])));
    }
  }
  const reservedRoots = input['reservedRoots'];
  if (!Array.isArray(reservedRoots)) {
    issues.push(issue('reserved-root-raced', 'reserved root roster is missing'));
  } else {
    for (const candidate of reservedRoots) {
      const reservation = candidate as BoundaryDerivedRootReservation;
      try {
        for (const ancestor of reservation.ancestors) {
          const stat = lstatSync(ancestor.path);
          if (
            stat.isSymbolicLink()
            || Number(stat.dev) !== ancestor.device
            || Number(stat.ino) !== ancestor.inode
          ) {
            issues.push(issue('reserved-root-raced', 'reserved root ancestor identity changed', ancestor.path));
          }
        }
        const parent = lstatSync(reservation.parentPath);
        if (
          Number(parent.dev) !== reservation.parentDevice
          || Number(parent.ino) !== reservation.parentInode
        ) {
          issues.push(issue('reserved-root-raced', 'reserved root parent identity changed', reservation.parentPath));
        }
      } catch (error) {
        issues.push(issue('reserved-root-raced', `reserved root ancestor is unavailable: ${(error as Error).message}`));
      }
    }
  }
  const snapshotResultValue = verifyBoundaryWorktreeSnapshot(
    String(input['repo']),
    input['snapshot'],
    input['declarations'] as BoundarySnapshotDeclarations,
  );
  if (!snapshotResultValue.ok) {
    issues.push(issue('closure-owner-drift', 'worktree or preserved-owner snapshot changed'));
  }
  if (
    input['currentRunId'] === input['retryRunId']
    || !isSafePath(input['retryRunId'])
    || !path.isAbsolute(String(input['retryDestination']))
  ) {
    issues.push(issue('retry-overwrite', 'retry must use a distinct canonical run ID and derived path'));
  }
  try {
    lstatSync(String(input['retryDestination']));
    issues.push(issue('retry-overwrite', 'retry destination already exists'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      issues.push(issue('retry-overwrite', (error as Error).message));
    }
  }
  return snapshotResult(issues);
}

export function validateBoundaryRun(value: unknown): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  if (!isRecord(value)) {
    issues.push(issue('invalid-root', 'boundary run manifest must be an object'));
  } else if (!hasExactKeys(value, ROOT_KEYS)) {
    issues.push(issue('invalid-root-keys', `boundary run manifest keys must be exactly: ${ROOT_KEYS.join(', ')}`));
  } else {
    requireExactObject(value, 'run', RUN_KEYS, issues);
    requireExactObject(value, 'entrySnapshot', SNAPSHOT_KEYS, issues);
    requireExactObject(value, 'currentSnapshot', SNAPSHOT_KEYS, issues);
    requireExactObject(value, 'entryTestRoster', ENTRY_TEST_ROSTER_KEYS, issues);
    requireExactObject(value, 'lifecycle', LIFECYCLE_KEYS, issues);
    requireExactObject(value, 'documentHashes', DOCUMENT_HASH_KEYS, issues);
    requireExactObject(value, 'upstream', UPSTREAM_KEYS, issues);

    validateSnapshotShape(value['entrySnapshot'], issues, 'entrySnapshot');
    validateSnapshotShape(value['currentSnapshot'], issues, 'currentSnapshot');

    const attemptRows = requireRows(value['attempts'], ATTEMPT_KEYS, issues, 'invalid-attempt-keys', 'attempts');
    for (const [index, attempt] of attemptRows.entries()) {
      validateSnapshotShape(attempt['preSnapshot'], issues, `attempts[${index}].preSnapshot`);
      validateSnapshotShape(attempt['postSnapshot'], issues, `attempts[${index}].postSnapshot`);
      requireExactRecord(attempt['stdout'], STREAM_KEYS, issues, 'invalid-stream-keys', `attempts[${index}].stdout`);
      requireExactRecord(attempt['stderr'], STREAM_KEYS, issues, 'invalid-stream-keys', `attempts[${index}].stderr`);
      if (attempt['structuredResult'] !== null) {
        requireExactRecord(
          attempt['structuredResult'],
          STREAM_KEYS,
          issues,
          'invalid-stream-keys',
          `attempts[${index}].structuredResult`,
        );
      }
      requireRows(
        attempt['outputAdmissions'],
        OUTPUT_ADMISSION_KEYS,
        issues,
        'invalid-output-admission-keys',
        `attempts[${index}].outputAdmissions`,
      );
    }

    requireRows(value['artifacts'], ARTIFACT_KEYS, issues, 'invalid-artifact-keys', 'artifacts');
    const childRows = requireRows(value['children'], CHILD_KEYS, issues, 'invalid-child-keys', 'children');
    for (const [index, child] of childRows.entries()) {
      validateImportedFiles(child['importedFiles'], issues, `children[${index}].importedFiles`);
    }

    if (value['predecessor'] !== null) {
      const predecessor = value['predecessor'];
      if (requireExactRecord(predecessor, PREDECESSOR_KEYS, issues, 'invalid-predecessor-keys', 'predecessor')) {
        requireExactRecord(
          predecessor['pin'],
          PREDECESSOR_PIN_KEYS,
          issues,
          'invalid-predecessor-pin-keys',
          'predecessor.pin',
        );
        validateImportedFiles(predecessor['importedFiles'], issues, 'predecessor.importedFiles');
      }
    }

    const runShape = value['run'];
    if (isRecord(runShape) && hasExactKeys(runShape, RUN_KEYS)) {
      requireRows(runShape['requiredChildPins'], CHILD_PIN_KEYS, issues, 'invalid-child-pin-keys', 'run.requiredChildPins');
      requireRows(runShape['observedTools'], TOOL_KEYS, issues, 'invalid-tool-keys', 'run.observedTools');
      requireRows(
        runShape['reservedDerivedRoots'],
        RESERVED_DERIVED_ROOT_KEYS,
        issues,
        'invalid-reserved-derived-root-keys',
        'run.reservedDerivedRoots',
      );
    }

    const roster = value['entryTestRoster'];
    if (isRecord(roster) && hasExactKeys(roster, ENTRY_TEST_ROSTER_KEYS)) {
      requireRows(roster['files'], TEST_ROSTER_FILE_KEYS, issues, 'invalid-test-roster-file-keys', 'entryTestRoster.files');
    }

    const reviewRows = requireRows(value['reviews'], REVIEW_KEYS, issues, 'invalid-review-keys', 'reviews');
    for (const [index, review] of reviewRows.entries()) {
      requireRows(review['findings'], FINDING_KEYS, issues, 'invalid-finding-keys', `reviews[${index}].findings`);
      requireRows(
        review['reproductionContracts'],
        REPRODUCTION_CONTRACT_KEYS,
        issues,
        'invalid-reproduction-contract-keys',
        `reviews[${index}].reproductionContracts`,
      );
    }

    const documentHashes = value['documentHashes'];
    if (isRecord(documentHashes) && hasExactKeys(documentHashes, DOCUMENT_HASH_KEYS)) {
      for (const key of DOCUMENT_HASH_KEYS) {
        requireExactRecord(
          documentHashes[key],
          DOCUMENT_HASH_ROW_KEYS,
          issues,
          'invalid-document-hash-keys',
          `documentHashes.${key}`,
        );
      }
    }

    check(value['schemaVersion'] === BOUNDARY_RUN_SCHEMA, issues, 'invalid-schema-version', 'schemaVersion');
    check(
      value['manifestState'] === 'active'
        || value['manifestState'] === 'finalized'
        || value['manifestState'] === 'verified-pass-closeout-rejected',
      issues,
      'invalid-manifest-state',
      'manifestState',
    );

    const run = value['run'];
    if (isRecord(run) && hasExactKeys(run, RUN_KEYS)) {
      check(isTimestamp(run['createdAtUtc']), issues, 'invalid-created-at', 'run.createdAtUtc');
      check(run['terminalHead'] === null || isOid(run['terminalHead']), issues, 'invalid-terminal-head', 'run.terminalHead');
      check(run['transitionCount'] === 0 || run['transitionCount'] === 1, issues, 'invalid-transition-count', 'run.transitionCount');
      const childAliases = run['requiredChildAliases'];
      const childPins = run['requiredChildPins'];
      check(Array.isArray(childAliases), issues, 'invalid-child-aliases', 'run.requiredChildAliases');
      check(Array.isArray(childPins), issues, 'invalid-child-pins', 'run.requiredChildPins');
      if (Array.isArray(childAliases) && Array.isArray(childPins)) {
        const pinAliases = childPins.map((entry) => isRecord(entry) ? entry['alias'] : null);
        check(
          canonicalizeBoundaryRun(childAliases) === canonicalizeBoundaryRun(pinAliases),
          issues,
          'child-pin-alias-mismatch',
          'run.requiredChildPins',
        );
        for (const [index, pin] of childPins.entries()) {
          check(
            isRecord(pin)
              && typeof pin['alias'] === 'string'
              && /^[a-z][a-z0-9-]{0,63}$/.test(pin['alias'])
              && typeof pin['runId'] === 'string'
              && /^[a-z][a-z0-9-]{0,63}$/.test(pin['runId'])
              && isOid(pin['head'])
              && isSha256(pin['manifestSha256']),
            issues,
            'invalid-child-pin',
            `run.requiredChildPins[${index}]`,
          );
        }
      }
      const roots = run['reservedDerivedRoots'];
      check(Array.isArray(roots), issues, 'invalid-derived-roots', 'run.reservedDerivedRoots');
      if (Array.isArray(roots)) {
        for (const [index, root] of roots.entries()) {
          check(
            isRecord(root) && Number.isSafeInteger(root['parentDevice']) && Number(root['parentDevice']) > 0,
            issues,
            'invalid-parent-device',
            `run.reservedDerivedRoots[${index}].parentDevice`,
          );
        }
      }
    }

    const snapshot = value['entrySnapshot'];
    if (isRecord(snapshot) && hasExactKeys(snapshot, SNAPSHOT_KEYS)) {
      check(isSha256(snapshot['digestSha256']), issues, 'invalid-snapshot-digest', 'entrySnapshot.digestSha256');
      const rows = snapshot['allowedUntracked'];
      check(Array.isArray(rows), issues, 'invalid-allowed-untracked', 'entrySnapshot.allowedUntracked');
      if (Array.isArray(rows)) {
        for (const [index, row] of rows.entries()) {
          check(
            isRecord(row) && isSafePath(row['path']),
            issues,
            'invalid-snapshot-path',
            `entrySnapshot.allowedUntracked[${index}].path`,
          );
        }
      }
    }

    const lifecycle = value['lifecycle'];
    if (isRecord(lifecycle) && hasExactKeys(lifecycle, LIFECYCLE_KEYS)) {
      check(lifecycle['branchDeletionAuthorized'] === false, issues, 'invalid-deletion-authority', 'lifecycle.branchDeletionAuthorized');
    }

    const upstream = value['upstream'];
    if (isRecord(upstream) && hasExactKeys(upstream, UPSTREAM_KEYS)) {
      check(
        upstream['observedOid'] === 'not-observed' || isOid(upstream['observedOid']),
        issues,
        'invalid-upstream-oid',
        'upstream.observedOid',
      );
    }
  }
  return {
    ok: issues.length === 0,
    exitCode: issues.length === 0 ? 0 : 1,
    verdict: issues.length === 0 ? 'Pass' : 'Inconclusive',
    issues,
  };
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([key, nested]) => [key, sortCanonical(nested)]),
  );
}

export function canonicalizeBoundaryRun(value: unknown): string {
  return `${JSON.stringify(sortCanonical(value))}\n`;
}

class BoundaryJsonSyntaxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function preflightBoundaryJson(text: string): void {
  let index = 0;
  const fail = (code: string, message: string): never => {
    throw new BoundaryJsonSyntaxError(code, message);
  };
  const skipWhitespace = (): void => {
    while (index < text.length && /[\t\n ]/.test(text[index]!)) index += 1;
  };
  const parseString = (): string => {
    if (text[index] !== '"') fail('invalid-json', `expected string at byte ${index}`);
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index]!;
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch (error) {
          fail('invalid-json', (error as Error).message);
        }
      } else if (char.charCodeAt(0) < 0x20) {
        fail('invalid-json', `unescaped control byte in string at byte ${index - 1}`);
      }
    }
    return fail('invalid-json', 'unterminated JSON string');
  };
  const parseNumber = (): void => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    const token = match?.[0];
    if (token === undefined) {
      throw new BoundaryJsonSyntaxError('invalid-json', `invalid number at byte ${index}`);
    }
    if (token === '-0') fail('invalid-json-number', 'negative zero is not canonical');
    index += token.length;
  };
  const parseLiteral = (literal: string): void => {
    if (!text.startsWith(literal, index)) fail('invalid-json', `invalid token at byte ${index}`);
    index += literal.length;
  };
  const parseValue = (): void => {
    skipWhitespace();
    const char = text[index];
    if (char === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail('duplicate-json-key', `duplicate JSON key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') fail('invalid-json', `expected colon at byte ${index}`);
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') fail('invalid-json', `expected comma at byte ${index}`);
        index += 1;
      }
      fail('invalid-json', 'unterminated JSON object');
    }
    if (char === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') fail('invalid-json', `expected comma at byte ${index}`);
        index += 1;
      }
      fail('invalid-json', 'unterminated JSON array');
    }
    if (char === '"') {
      parseString();
      return;
    }
    if (char === '-' || (char !== undefined && /\d/.test(char))) {
      parseNumber();
      return;
    }
    if (char === 't') return parseLiteral('true');
    if (char === 'f') return parseLiteral('false');
    if (char === 'n') return parseLiteral('null');
    fail('invalid-json', `invalid value at byte ${index}`);
  };

  parseValue();
  skipWhitespace();
  if (index !== text.length) fail('invalid-json', `trailing JSON bytes at byte ${index}`);
}

export function parseBoundaryJsonBytes(bytes: Uint8Array): {
  result: BoundaryValidationResult;
  value: unknown | null;
  text: string | null;
} {
  let text: string;
  let value: unknown;
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new BoundaryJsonSyntaxError('invalid-json-byte', 'UTF-8 BOM bytes are forbidden');
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.startsWith('\ufeff') || text.includes('\r')) {
      throw new BoundaryJsonSyntaxError('invalid-json-byte', 'BOM and CR bytes are forbidden');
    }
    preflightBoundaryJson(text);
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const code = error instanceof BoundaryJsonSyntaxError ? error.code : 'invalid-json';
    return {
      result: {
        ok: false,
        exitCode: 1,
        verdict: 'Inconclusive',
        issues: [issue(code, `boundary JSON is invalid: ${(error as Error).message}`)],
      },
      value: null,
      text: null,
    };
  }

  return { result: snapshotResult([]), value, text };
}

export function validateBoundaryRunJson(bytes: Uint8Array): BoundaryValidationResult {
  const parsed = parseBoundaryJsonBytes(bytes);
  if (!parsed.result.ok || parsed.text === null) return parsed.result;

  if (parsed.text !== canonicalizeBoundaryRun(parsed.value)) {
    return {
      ok: false,
      exitCode: 1,
      verdict: 'Inconclusive',
      issues: [issue('noncanonical-json', 'boundary run JSON bytes are not canonical')],
    };
  }
  return validateBoundaryRun(parsed.value);
}
