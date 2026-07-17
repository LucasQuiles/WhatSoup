import { canonicalizeBoundaryRun } from './shared.ts';

export const OBSERVATION_ATTEMPT_IDS = [
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

export const DOC_PATHS = [
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

export const BOUNDARY_CHILD_ENVIRONMENT = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'] as const;

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

export const VALIDATOR_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/verify-boundary-run.test.ts', '--run',
] as const;
export const TYPECHECK_SCRIPTS = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'typecheck:scripts'] as const;
export const TYPECHECK_ALL = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'typecheck:all'] as const;
export const PARSER_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-quality-check.test.ts', '--pool=forks', '--fileParallelism=false',
] as const;
export const CATALOG_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-rule-guidance.test.ts', '--pool=forks', '--fileParallelism=false',
] as const;
export const CONTRACT_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-boundary-contract.test.ts', '--pool=forks', '--fileParallelism=false',
] as const;
export const RECEIPT_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-boundary-contract.test.ts', 'tests/scripts/semantic-quality-check.test.ts',
  '--pool=forks', '--fileParallelism=false',
] as const;
export const PROVIDER_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-history-provider.test.ts', '--pool=forks', '--fileParallelism=false',
] as const;
export const INTEGRATION_RED_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-quality-check.test.ts', 'tests/scripts/semantic-boundary-eval.test.ts',
  '--pool=forks', '--fileParallelism=false',
] as const;
export const INTEGRATION_FOCUSED_TEST = [
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
export const PREDECESSOR_FOCUSED_TEST = [
  'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
  'tests/scripts/semantic-fingerprint.test.ts',
  'tests/scripts/semantic-history-provider.test.ts',
  'tests/scripts/semantic-history.test.ts',
  'tests/scripts/semantic-provenance.test.ts',
  'tests/scripts/semantic-quality-check.test.ts',
  'tests/scripts/semantic-boundary-eval.test.ts',
  '--pool=forks', '--fileParallelism=false',
] as const;
export const BASELINE_EVAL = [
  'bash', 'scripts/run-with-pinned-node.sh', 'scripts/experiments/semantic-boundary-eval.ts',
  '--engine', 'baseline', '--corpus', 'tests/fixtures/semantic-boundary-eval/cases.json', '--format', 'json',
] as const;
export const CANDIDATE_EVAL = [
  'bash', 'scripts/run-with-pinned-node.sh', 'scripts/experiments/semantic-boundary-eval.ts',
  '--engine', 'candidate', '--corpus', 'tests/fixtures/semantic-boundary-eval/cases.json',
  '--verify-git', '--format', 'json',
] as const;
export const HOLDOUT_EVAL = [
  'bash', 'scripts/run-with-pinned-node.sh', 'scripts/experiments/semantic-boundary-eval.ts',
  '--engine', 'candidate', '--corpus', 'tests/fixtures/semantic-boundary-eval/holdout.json',
  '--verify-git', '--format', 'json',
] as const;
export const BRANCH_GATE = [
  'gnu-timeout', '--kill-after=30s', '30m',
  'loadgate', '--label', 'boundary-contract-branch', '--max-wait', '120', '--strict', '--',
  'bash', 'scripts/run-with-pinned-npm.sh', 'run', 'verify:push:branch',
] as const;
export const DOC_WORK_INDEX_REGEN = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen'] as const;
export const DOC_WORK_INDEX_GUARD = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'guard:work-index'] as const;
export const DOC_PUBLICATION = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'guard:publication:all'] as const;
export const DOC_DRIFT = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'guard:doc-drift'] as const;
export const DOC_TALLY = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'guard:doc-tally'] as const;

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
  ['merge-preview', commandContract(['git', 'merge-tree', '--write-tree', '--messages', 'HEAD', 'origin/main'], {
    expectedExit: '0,1', stdoutPredicate: 'merge-preview',
  })],

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
  ['catalog-inventory-sort', commandContract(['sort', '-u'], {
    stdinSource: 'catalog-inventory-strip',
    outputPaths: ['attempts/catalog-inventory-sort/stdout.log'],
  })],
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

export const BCF00_MARKER_IDS = [
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

export const PREDECESSOR_TEST_FILES = [
  'tests/scripts/semantic-fingerprint.test.ts',
  'tests/scripts/semantic-history-provider.test.ts',
  'tests/scripts/semantic-history.test.ts',
  'tests/scripts/semantic-provenance.test.ts',
  'tests/scripts/semantic-quality-check.test.ts',
  'tests/scripts/semantic-boundary-eval.test.ts',
] as const;

export const INTEGRATION_TEST_FILES = [
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


export const ROOT_KEYS = [
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

export const RUN_INIT_ANCHOR_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'phase', 'createdAtUtc', 'entryHead',
  'entrySnapshotDigestSha256', 'helperCommit', 'helperSha256', 'allowedPaths',
  'allowedUntrackedPaths', 'preservedOwnerPaths', 'requiredAttemptIds', 'requiredChildAliases',
  'requiredChildPins', 'predecessorPin', 'predecessorTreeDigestSha256', 'mayComplete', 'chainAppend', 'requestedTools', 'observedTools',
  'reservedDerivedRoots', 'entryTestRosterDigestSha256', 'documentHashesDigestSha256',
] as const;

export const RUN_KEYS = [
  'runId', 'taskId', 'profileId', 'phase', 'createdAtUtc', 'finalizedAtUtc', 'entryHead',
  'terminalHead', 'reconciledBase', 'helperCommit', 'helperSha256', 'allowedPaths',
  'allowedUntrackedPaths', 'preservedOwnerPaths', 'requiredAttemptIds', 'requiredChildAliases',
  'requiredChildPins', 'transitionCount', 'mayComplete', 'chainAppend', 'requestedTools', 'observedTools',
  'reservedDerivedRoots',
] as const;

export const SNAPSHOT_KEYS = [
  'head', 'indexTreeOid', 'trackedPatchSha256', 'unstagedPatchSha256', 'allowedUntracked',
  'preservedOwner', 'digestSha256',
] as const;

export const ENTRY_TEST_ROSTER_KEYS = ['files', 'digestSha256'] as const;
export const LIFECYCLE_KEYS = [
  'status', 'completionCommit', 'finalGate', 'artifactSha256', 'successor', 'supersededBy',
  'oracle', 'branchDeletionAuthorized',
] as const;
export const DOCUMENT_HASH_KEYS = ['spec', 'plan', 'notes', 'helper'] as const;
export const UPSTREAM_KEYS = [
  'remoteUrl', 'observedOid', 'mergeBase', 'ahead', 'behind', 'remotePaths', 'localPaths',
  'observationManifestSha256', 'mergeCommit', 'mergeParents',
] as const;
export const SNAPSHOT_PATH_KEYS = ['path', 'type', 'mode', 'bytes', 'sha256'] as const;
export const ATTEMPT_KEYS = [
  'id', 'operation', 'headAnchor', 'argv', 'cwd', 'startedAtUtc', 'endedAtUtc', 'expectedExit',
  'rawExit', 'rawSignal', 'expectationMet', 'watchdogOwner', 'innerTimeoutOwner', 'deadlineMs',
  'killGraceMs', 'preSnapshot', 'postSnapshot', 'stdout', 'stderr', 'declaredOutputs',
  'outputAdmissions', 'structuredResult', 'verdict',
] as const;
export const STREAM_KEYS = ['path', 'sha256', 'bytes'] as const;
export const OUTPUT_ADMISSION_KEYS = ['path', 'state', 'role', 'sha256', 'bytes'] as const;
export const ARTIFACT_KEYS = ['path', 'role', 'producerAttemptId', 'sha256', 'bytes'] as const;
export const CHILD_KEYS = [
  'alias', 'kind', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead',
  'snapshotDigestSha256', 'sourceManifestSha256', 'importedFiles', 'treeDigestSha256',
  'overallVerdict', 'dedupeKey',
] as const;
export const CHILD_PIN_KEYS = ['alias', 'head', 'runId', 'manifestSha256'] as const;
export const IMPORTED_FILE_KEYS = ['path', 'sha256', 'bytes'] as const;
export const PREDECESSOR_KEYS = ['pin', 'sourceManifestSha256', 'importedFiles', 'treeDigestSha256', 'overallVerdict'] as const;
export const PREDECESSOR_PIN_KEYS = [
  'taskId', 'profileId', 'runId', 'terminalHead', 'manifestSha256', 'completionReceiptSha256',
  'ledgerSha256',
] as const;
export const TEST_ROSTER_FILE_KEYS = ['path', 'state', 'testNames'] as const;
export const REVIEW_KEYS = [
  'reviewId', 'alias', 'dedupeKey', 'head', 'snapshotDigestSha256', 'reportPath', 'reportSha256',
  'metaPath', 'metaSha256', 'stderrPath', 'stderrSha256', 'findings', 'reproductionContracts',
] as const;
export const REVIEW_INPUT_KEYS = [
  'schemaVersion', 'reviewId', 'dedupeKey', 'head', 'snapshotDigestSha256', 'reportPath',
  'reportSha256', 'metaPath', 'metaSha256', 'stderrPath', 'stderrSha256', 'findings',
  'reproductionContracts',
] as const;
export const FINDING_KEYS = [
  'findingId', 'severity', 'requiresFix', 'requiresReproduction', 'evidencePath',
  'evidenceSha256', 'disposition', 'resolution', 'reason', 'counterevidenceRefs',
  'reproductionAttemptIds', 'counterReproductionAttemptIds', 'fixedAtHead',
  'fixReproductionAttemptIds', 'fixReviewId',
] as const;
export const REPRODUCTION_CONTRACT_KEYS = [
  'attemptId', 'argv', 'expectedExit', 'toolName', 'deadlineMs', 'killGraceMs',
] as const;
export const DOCUMENT_HASH_ROW_KEYS = ['path', 'sha256', 'bytes'] as const;
export const TOOL_KEYS = ['name', 'realPath', 'version', 'sha256'] as const;
export const RESERVED_DERIVED_ROOT_KEYS = ['kind', 'path', 'parentDevice', 'parentInode', 'state'] as const;
export const COMPLETION_RECEIPT_KEYS = [
  'schemaVersion', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead', 'manifestSha256',
  'manifestLockSha256', 'ledgerSha256', 'predecessorReceiptSha256', 'predecessorLedgerSha256',
  'reconciledBase', 'upstreamObservedOid', 'corpusDigests', 'oracleDigest', 'lifecycleStatus',
  'finalGate', 'overallVerdict',
] as const;
export const CHAIN_LEDGER_KEYS = [
  'schemaVersion', 'rows', 'reconciledBase', 'upstreamObservedOid', 'corpusDigests', 'oracleDigest',
] as const;
export const CHAIN_ROW_KEYS = [
  'ordinal', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead', 'manifestSha256',
  'previousLedgerSha256', 'overallVerdict',
] as const;
export const CORPUS_DIGEST_KEYS = ['cases', 'holdout'] as const;
export const CLOSEOUT_CORE_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'terminalHead', 'snapshotDigestSha256',
  'helperCommit', 'helperSha256', 'runManifestSha256', 'runManifestLockSha256',
  'finalizeRawExit', 'finalizeRawSignal', 'verifyRawExit', 'verifyRawSignal',
  'completionReceiptSha256', 'completionReceiptLockSha256', 'ledgerSha256', 'ledgerLockSha256',
  'startedAtUtc', 'endedAtUtc', 'lifecycleStatus', 'requiredAttemptIds', 'requiredChildAliases',
  'internalStatus', 'overallVerdict',
] as const;
export const CLOSEOUT_INTERNAL_STATUS_KEYS = [
  'stage', 'rawExit', 'rawSignal', 'expectationMet', 'verdict',
] as const;
export const CLOSEOUT_NEGATIVE_REPORT_KEYS = [
  'schemaVersion', 'runId', 'closeoutCoreSha256', 'cases', 'startedAtUtc', 'endedAtUtc',
  'overallVerdict',
] as const;
export const CLOSEOUT_NEGATIVE_CASE_KEYS = [
  'ordinal', 'mutationId', 'fixturePath', 'expectedReasonCode', 'rawExit', 'rawSignal',
  'expectationMet', 'stdoutSha256', 'stderrSha256', 'treeDigestSha256', 'verdict',
] as const;
export const CLOSEOUT_RECEIPT_KEYS = [
  'schemaVersion', 'kind', 'runId', 'taskId', 'profileId', 'terminalHead',
  'snapshotDigestSha256', 'helperCommit', 'helperSha256', 'runManifestSha256',
  'runManifestLockSha256', 'finalizeRawExit', 'finalizeRawSignal', 'verifyRawExit',
  'verifyRawSignal', 'completionReceiptSha256', 'completionReceiptLockSha256', 'ledgerSha256',
  'ledgerLockSha256', 'startedAtUtc', 'endedAtUtc', 'lifecycleStatus', 'requiredAttemptIds',
  'requiredChildAliases', 'closeoutCoreSha256', 'negativeControlReportSha256', 'failedStage',
  'runVerdict', 'rawExit', 'rawSignal', 'reasonCode', 'manifestState', 'overallVerdict',
] as const;
export const READINESS_RECORD_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'head', 'snapshotDigestSha256',
  'readinessState', 'evaluatedAtUtc', 'evidence', 'assumptions', 'risks', 'blockers',
  'decisionRationale', 'decisionAuthority', 'nextAllowedAction', 'overallVerdict',
] as const;
export const READINESS_EVIDENCE_KEYS = [
  'evidenceId', 'artifactPath', 'producerAttemptId', 'sha256', 'verdict',
] as const;
export const READINESS_ASSUMPTION_KEYS = ['assumptionId', 'disposition', 'evidenceRefs'] as const;
export const READINESS_RISK_KEYS = [
  'riskId', 'owner', 'checkpoint', 'artifactPath', 'artifactSha256', 'stopCondition',
] as const;
export const READINESS_BLOCKER_KEYS = ['blockerId', 'reason', 'evidenceRefs'] as const;
export const CONSUMER_VERSION_DECISION_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'head', 'snapshotDigestSha256',
  'packageVersion', 'currentProducerSchema', 'proposedProducerSchema', 'supportStage',
  'inventoryQuerySha256', 'inventoryMatches', 'localConsumers', 'externalConsumers',
  'compatibilityReader', 'rollbackCommit', 'decision', 'releaseNoteRequired', 'limitations',
  'overallVerdict',
] as const;
export const CONSUMER_INVENTORY_MATCH_KEYS = [
  'path', 'line', 'column', 'matchKind', 'matchedToken', 'lineSha256',
] as const;
export const LOCAL_CONSUMER_KEYS = [
  'consumerId', 'kind', 'path', 'symbol', 'schemaSupport', 'matchRefs',
] as const;
export const FEEDBACK_MEASUREMENTS_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'producerAttemptId', 'head',
  'snapshotDigestSha256', 'tokenSha256', 'budgets', 'scenarios', 'overallVerdict',
] as const;
export const BOUNDARY_BUDGET_KEYS = [
  'maxFindings', 'maxObservedPerFinding', 'maxArtifactsPerFinding',
  'maxLimitationsPerFinding', 'maxTopLevelLimitations', 'maxFingerprints',
  'maxCanonicalRecords', 'maxCorrectionsPerFinding', 'maxVerificationPerFinding',
  'maxSourcesPerFinding', 'maxPublicTextBytes', 'maxJsonBytes', 'maxHumanBytes',
  'maxHumanReservedSummaryBytes', 'maxHumanDetailedFindings',
] as const;
export const FEEDBACK_SCENARIO_KEYS = [
  'ordinal', 'scenario', 'subject', 'inputBytes', 'limitBytes', 'humanBytes', 'jsonBytes',
  'detailedFindings', 'omittedFindings', 'renderedObservations', 'omittedObservations',
  'evidenceDigestSha256', 'descriptorDigestSha256', 'expectedDisposition',
  'observedDisposition',
] as const;
export const EXPECTED_BOUNDARY_BUDGETS = {
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
export const DOCS_LINEAGE_REPORT_KEYS = [
  'schemaVersion', 'runId', 'taskId', 'profileId', 'head', 'snapshotDigestSha256',
  'anchors', 'operations', 'pathClasses', 'bEntryIdentity', 'overallVerdict',
] as const;
export const DOCS_LINEAGE_ANCHOR_KEYS = [
  'validatorBase', 'validatorCommit', 'upstreamMerge', 'upstreamFirstParent',
  'upstreamSecondParent', 'originMain', 'reconciledBase', 'docsEntryHead', 'docsCurrentHead',
] as const;
export const DOCS_LINEAGE_OPERATION_KEYS = [
  'ordinal', 'operationId', 'argv', 'rawExit', 'rawSignal', 'stdoutSha256', 'stderrSha256',
  'parsedOids', 'parsedPaths', 'expectationMet', 'verdict',
] as const;
export const DOCS_LINEAGE_PATH_CLASS_KEYS = ['path', 'status', 'source'] as const;
export const DOCS_B_ENTRY_IDENTITY_KEYS = [
  'snapshotDigestSha256', 'publicSurfaceSha256', 'publicationAuditSha256', 'handoffSha256',
  'workIndexJsonSha256', 'workIndexMarkdownSha256',
] as const;
export const MERGE_CONFLICT_RESOLUTION_REPORT_KEYS = [
  'schemaVersion', 'policy', 'beforeHead', 'expectedSecondParent', 'conflictPaths',
  'indexStages', 'generatorArgv', 'generatorRawExit', 'generatorRawSignal', 'resolvedPaths',
  'unmergedPaths', 'conflictMarkerPaths', 'diffCheckRawExit', 'diffCheckRawSignal',
  'workIndexGuardRawExit', 'workIndexGuardRawSignal', 'preStateDigestSha256',
  'resolvedStateDigestSha256', 'verdict',
] as const;
export const MERGE_CONFLICT_INDEX_STAGE_KEYS = ['path', 'stage', 'mode', 'oid'] as const;

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


export const BOUNDARY_PINNED_GENERATED_INDEX_PARENT = '5d16cd401e1250f417f7bde481a4cc8b0ad1df55';
export const GENERATED_INDEX_PATHS = ['docs/work-index.json', 'docs/work-index.md'] as const;
export const GENERATED_INDEX_ARGV = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen'] as const;
