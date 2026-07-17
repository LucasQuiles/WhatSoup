import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as boundaryRun from '../../scripts/lib/verification/boundary-run-manifest.ts';
import {
  BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
  validateBoundaryRun,
} from '../../scripts/lib/verification/boundary-run-manifest.ts';
import * as boundaryCli from '../../scripts/verify-boundary-run.ts';
import { evaluateBaseline, evaluateCandidate, loadCorpus } from '../../scripts/experiments/semantic-boundary-eval.ts';

const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const OID = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);
const OID_D = 'd'.repeat(40);
const TIME = '2026-07-16T16:30:00.000Z';
const FIXTURE_EMAIL = ['whatsoup-test', 'users.noreply.github.com'].join('@');
const SSH_REMOTE = ['git', 'github.com:LucasQuiles/WhatSoup.git'].join('@');
const fixtureRoots: string[] = [];
const marker = (id: string): string => `[BCF00-${id}]`;
const expectedBcf00Markers = [
  marker('B01'),
  ...Array.from({ length: 16 }, (_, index) => marker(`U${String(index + 1).padStart(2, '0')}`)),
  ...Array.from({ length: 16 }, (_, index) => marker(`N${String(index + 1).padStart(2, '0')}`)),
];

const EXPECTED_PROFILE_ROWS = {
  'bcf00-observation': ['BCF-00', 'observation', 'closed', false, false, null, null, '', 'validator-suite-postcommit,validator-typecheck-postcommit,upstream-root,upstream-head,upstream-status,upstream-remote,upstream-fetch,upstream-origin-oid,upstream-merge-base,upstream-ahead-behind,upstream-remote-diff,upstream-local-diff,merge-preview'],
  'bcf00-reconciliation': ['BCF-00', 'reconciliation', 'completed', true, true, 'merge', 'bcf00-observation', 'upstream-observation:observation', 'merge-transition,postmerge-validator-suite,postmerge-validator-typecheck,predecessor-focused,predecessor-typecheck-scripts,predecessor-typecheck-all,predecessor-baseline-eval,predecessor-candidate-eval,predecessor-holdout-eval,predecessor-branch-gate,readiness-check'],
  'bcf01-parser': ['BCF-01', 'task01', 'completed', true, true, 'commit', 'bcf00-reconciliation', '', 'parser-red,parser-green,parser-typecheck,parser-scope,parser-commit-transition'],
  'bcf02-catalog': ['BCF-02', 'task02', 'completed', true, true, 'commit', 'bcf01-parser', '', 'catalog-inventory-raw,catalog-inventory-strip,catalog-inventory-sort,catalog-inventory-count,catalog-red,catalog-green,catalog-typecheck,catalog-scope,catalog-commit-transition'],
  'bcf03-contract': ['BCF-03', 'task03', 'completed', true, true, 'commit', 'bcf02-catalog', '', 'contract-red,contract-green,contract-typecheck,contract-scope,contract-commit-transition'],
  'bcf04-receipt': ['BCF-04', 'task04', 'completed', true, true, 'commit', 'bcf03-contract', '', 'receipt-red,receipt-green,receipt-typecheck,receipt-producer-scan,receipt-staged-scope,receipt-commit-transition'],
  'bcf05-feedback': ['BCF-05', 'task05', 'completed', true, true, 'commit', 'bcf04-receipt', '', 'feedback-red,feedback-green,feedback-budget,feedback-typecheck,feedback-scope,feedback-commit-transition'],
  'bcf06-provider': ['BCF-06', 'task06', 'completed', true, true, 'commit', 'bcf05-feedback', '', 'provider-red,provider-green-one,provider-green-two,provider-typecheck,provider-scope,provider-commit-transition'],
  'bcf07-integration': ['BCF-07', 'task07', 'completed', true, true, 'commit', 'bcf06-provider', '', 'integration-red,integration-focused,integration-typecheck-scripts,integration-baseline-eval,integration-candidate-eval,integration-holdout-eval,integration-scope,integration-commit-transition'],
  'bcf-review-contract': ['BCF-REVIEW', 'review', 'completed', true, false, null, 'bcf07-integration', '', 'review-schema-check,review-scope-check'],
  'bcf-review-redaction': ['BCF-REVIEW', 'review', 'completed', true, false, null, 'bcf07-integration', '', 'review-schema-check,review-scope-check'],
  'bcf-review-integration': ['BCF-REVIEW', 'review', 'completed', true, false, null, 'bcf07-integration', '', 'review-schema-check,review-scope-check'],
  'bcf-reproduction': ['BCF-REPRODUCTION', 'reproduction', 'completed', true, false, null, 'bcf07-integration', '', 'reproduction-suite,reproduction-scope-check'],
  'bcf08a-docs': ['BCF-08A', 'docs-a', 'completed', true, true, null, 'bcf07-integration', 'review-contract:review,review-redaction:review,review-integration:review,lead-reproduction:reproduction', 'docs-work-index-regen,docs-work-index-guard,docs-publication,docs-drift,docs-tally,docs-authoring-scope'],
  'bcf08b-docs': ['BCF-08B', 'docs-b', 'completed', true, true, 'commit', 'bcf08a-docs', 'docs-precommit:docs', 'docs-focused,docs-typecheck-scripts,docs-typecheck-all,docs-test-integrity-preflight,docs-test-integrity-scan,docs-baseline-eval,docs-candidate-eval,docs-holdout-eval,docs-work-index-regen,docs-work-index-guard,docs-publication,docs-drift,docs-tally,docs-lineage-scope,docs-staged-scope,docs-commit-transition'],
  'bcf08-final': ['BCF-08C', 'final', 'completed', true, true, null, 'bcf08b-docs', 'docs:docs,review-contract:review,review-redaction:review,review-integration:review,lead-reproduction:reproduction', 'final-upstream-remote,final-upstream-refresh,final-upstream-origin-oid,final-upstream-merge-base,final-upstream-ahead-behind,final-upstream-remote-diff,final-upstream-local-diff,watchdog-canary,watchdog-parent-dead,watchdog-child-dead,watchdog-group-dead,final-branch-gate'],
} as const;

const EXPECTED_PROFILE_PATHS = {
  'bcf00-observation': [],
  'bcf00-reconciliation': 'observation-preview',
  'bcf01-parser': ['scripts/semantic-quality-check.ts', 'tests/scripts/semantic-quality-check.test.ts'],
  'bcf02-catalog': ['scripts/lib/semantic-quality/boundary-contract.ts', 'scripts/lib/semantic-quality/boundary-types.ts', 'scripts/lib/semantic-quality/rule-guidance.ts', 'tests/scripts/semantic-boundary-contract.test.ts', 'tests/scripts/semantic-rule-guidance.test.ts'],
  'bcf03-contract': ['scripts/lib/semantic-quality/boundary-contract.ts', 'scripts/lib/semantic-quality/boundary-types.ts', 'tests/scripts/semantic-boundary-contract.test.ts'],
  'bcf04-receipt': ['scripts/experiments/semantic-boundary-eval.ts', 'scripts/lib/semantic-quality/history.ts', 'scripts/lib/semantic-quality/policy.ts', 'scripts/lib/semantic-quality/provenance.ts', 'scripts/lib/semantic-quality/receipt.ts', 'scripts/semantic-quality-check.ts', 'tests/scripts/semantic-boundary-contract.test.ts', 'tests/scripts/semantic-boundary-eval.test.ts', 'tests/scripts/semantic-history.test.ts', 'tests/scripts/semantic-provenance.test.ts', 'tests/scripts/semantic-quality-check.test.ts', 'tests/scripts/semantic-quality-policy.test.ts'],
  'bcf05-feedback': ['scripts/lib/semantic-quality/receipt.ts', 'tests/scripts/semantic-boundary-contract.test.ts', 'tests/scripts/semantic-quality-check.test.ts'],
  'bcf06-provider': ['scripts/lib/semantic-quality/history-provider.ts', 'tests/scripts/semantic-history-provider.test.ts'],
  'bcf07-integration': ['scripts/experiments/semantic-boundary-eval.ts', 'scripts/semantic-quality-check.ts', 'tests/scripts/semantic-boundary-eval.test.ts', 'tests/scripts/semantic-quality-check.test.ts'],
  'bcf-review-contract': [],
  'bcf-review-redaction': [],
  'bcf-review-integration': [],
  'bcf-reproduction': [],
  'bcf08a-docs': ['docs/public-surface.md', 'docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md', 'docs/work-index.json', 'docs/work-index.md'],
  'bcf08b-docs': ['docs/public-surface.md', 'docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md', 'docs/work-index.json', 'docs/work-index.md'],
  'bcf08-final': [],
} as const;

const EXPECTED_PREDECESSOR_ROWS = {
  'bcf00-reconciliation': ['BCF-00', 'BCF-00', 'bcf00-observation'],
  'bcf01-parser': ['BCF-01', 'BCF-00', 'bcf00-reconciliation'],
  'bcf02-catalog': ['BCF-02', 'BCF-01', 'bcf01-parser'],
  'bcf03-contract': ['BCF-03', 'BCF-02', 'bcf02-catalog'],
  'bcf04-receipt': ['BCF-04', 'BCF-03', 'bcf03-contract'],
  'bcf05-feedback': ['BCF-05', 'BCF-04', 'bcf04-receipt'],
  'bcf06-provider': ['BCF-06', 'BCF-05', 'bcf05-feedback'],
  'bcf07-integration': ['BCF-07', 'BCF-06', 'bcf06-provider'],
  'bcf-review-contract': ['BCF-REVIEW', 'BCF-07', 'bcf07-integration'],
  'bcf-review-redaction': ['BCF-REVIEW', 'BCF-07', 'bcf07-integration'],
  'bcf-review-integration': ['BCF-REVIEW', 'BCF-07', 'bcf07-integration'],
  'bcf-reproduction': ['BCF-REPRODUCTION', 'BCF-07', 'bcf07-integration'],
  'bcf08a-docs': ['BCF-08A', 'BCF-07', 'bcf07-integration'],
  'bcf08b-docs': ['BCF-08B', 'BCF-08A', 'bcf08a-docs'],
  'bcf08-final': ['BCF-08C', 'BCF-08B', 'bcf08b-docs'],
} as const;

const EXPECTED_CHILD_CONTRACT_ROWS = {
  'bcf00-reconciliation/upstream-observation': ['observation', 'BCF-00', 'bcf00-observation', 'upstream-observation', 'both-parent-entry', 2],
  'bcf08a-docs/review-contract': ['review', 'BCF-REVIEW', 'bcf-review-contract', 'contract-cli-review', 'both-parent-entry', 2],
  'bcf08a-docs/review-redaction': ['review', 'BCF-REVIEW', 'bcf-review-redaction', 'redaction-async-review', 'both-parent-entry', 2],
  'bcf08a-docs/review-integration': ['review', 'BCF-REVIEW', 'bcf-review-integration', 'integration-blast-review', 'both-parent-entry', 2],
  'bcf08a-docs/lead-reproduction': ['reproduction', 'BCF-REPRODUCTION', 'bcf-reproduction', 'lead-reproduction', 'both-parent-entry', 2],
  'bcf08b-docs/docs-precommit': ['docs', 'BCF-08A', 'bcf08a-docs', 'docs-precommit', 'both-parent-entry', 3],
  'bcf08-final/docs': ['docs', 'BCF-08B', 'bcf08b-docs', 'docs', 'terminal-parent-entry', 3],
  'bcf08-final/review-contract': ['review', 'BCF-REVIEW', 'bcf-review-contract', 'contract-cli-review', 'both-docs-entry', 3],
  'bcf08-final/review-redaction': ['review', 'BCF-REVIEW', 'bcf-review-redaction', 'redaction-async-review', 'both-docs-entry', 3],
  'bcf08-final/review-integration': ['review', 'BCF-REVIEW', 'bcf-review-integration', 'integration-blast-review', 'both-docs-entry', 3],
  'bcf08-final/lead-reproduction': ['reproduction', 'BCF-REPRODUCTION', 'bcf-reproduction', 'lead-reproduction', 'both-docs-entry', 3],
} as const;

const EXPECTED_WIRE_SCHEMAS = {
  RunManifest: ['schemaVersion', 'manifestState', 'run', 'entrySnapshot', 'currentSnapshot', 'attempts', 'artifacts', 'children', 'predecessor', 'entryTestRoster', 'reviews', 'lifecycle', 'documentHashes', 'upstream', 'overallVerdict'],
  RunInitAnchor: ['schemaVersion', 'runId', 'taskId', 'profileId', 'phase', 'createdAtUtc', 'entryHead', 'entrySnapshotDigestSha256', 'helperCommit', 'helperSha256', 'allowedPaths', 'allowedUntrackedPaths', 'preservedOwnerPaths', 'requiredAttemptIds', 'requiredChildAliases', 'requiredChildPins', 'predecessorPin', 'predecessorTreeDigestSha256', 'mayComplete', 'chainAppend', 'requestedTools', 'observedTools', 'reservedDerivedRoots', 'entryTestRosterDigestSha256', 'documentHashesDigestSha256'],
  run: ['runId', 'taskId', 'profileId', 'phase', 'createdAtUtc', 'finalizedAtUtc', 'entryHead', 'terminalHead', 'reconciledBase', 'helperCommit', 'helperSha256', 'allowedPaths', 'allowedUntrackedPaths', 'preservedOwnerPaths', 'requiredAttemptIds', 'requiredChildAliases', 'requiredChildPins', 'transitionCount', 'mayComplete', 'chainAppend', 'requestedTools', 'observedTools', 'reservedDerivedRoots'],
  snapshot: ['head', 'indexTreeOid', 'trackedPatchSha256', 'unstagedPatchSha256', 'allowedUntracked', 'preservedOwner', 'digestSha256'],
  snapshotPath: ['path', 'type', 'mode', 'bytes', 'sha256'],
  attempt: ['id', 'operation', 'headAnchor', 'argv', 'cwd', 'startedAtUtc', 'endedAtUtc', 'expectedExit', 'rawExit', 'rawSignal', 'expectationMet', 'watchdogOwner', 'innerTimeoutOwner', 'deadlineMs', 'killGraceMs', 'preSnapshot', 'postSnapshot', 'stdout', 'stderr', 'declaredOutputs', 'outputAdmissions', 'structuredResult', 'verdict'],
  stream: ['path', 'sha256', 'bytes'],
  outputAdmission: ['path', 'state', 'role', 'sha256', 'bytes'],
  artifact: ['path', 'role', 'producerAttemptId', 'sha256', 'bytes'],
  child: ['alias', 'kind', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead', 'snapshotDigestSha256', 'sourceManifestSha256', 'importedFiles', 'treeDigestSha256', 'overallVerdict', 'dedupeKey'],
  childPin: ['alias', 'head', 'runId', 'manifestSha256'],
  importedFile: ['path', 'sha256', 'bytes'],
  predecessor: ['pin', 'sourceManifestSha256', 'importedFiles', 'treeDigestSha256', 'overallVerdict'],
  predecessorPin: ['taskId', 'profileId', 'runId', 'terminalHead', 'manifestSha256', 'completionReceiptSha256', 'ledgerSha256'],
  entryTestRoster: ['files', 'digestSha256'],
  testRosterFile: ['path', 'state', 'testNames'],
  reviewInput: ['schemaVersion', 'reviewId', 'dedupeKey', 'head', 'snapshotDigestSha256', 'reportPath', 'reportSha256', 'metaPath', 'metaSha256', 'stderrPath', 'stderrSha256', 'findings', 'reproductionContracts'],
  review: ['reviewId', 'alias', 'dedupeKey', 'head', 'snapshotDigestSha256', 'reportPath', 'reportSha256', 'metaPath', 'metaSha256', 'stderrPath', 'stderrSha256', 'findings', 'reproductionContracts'],
  finding: ['findingId', 'severity', 'requiresFix', 'requiresReproduction', 'evidencePath', 'evidenceSha256', 'disposition', 'resolution', 'reason', 'counterevidenceRefs', 'reproductionAttemptIds', 'counterReproductionAttemptIds', 'fixedAtHead', 'fixReproductionAttemptIds', 'fixReviewId'],
  reproductionContract: ['attemptId', 'argv', 'expectedExit', 'toolName', 'deadlineMs', 'killGraceMs'],
  lifecycle: ['status', 'completionCommit', 'finalGate', 'artifactSha256', 'successor', 'supersededBy', 'oracle', 'branchDeletionAuthorized'],
  documentHashes: ['spec', 'plan', 'notes', 'helper'],
  documentHash: ['path', 'sha256', 'bytes'],
  upstream: ['remoteUrl', 'observedOid', 'mergeBase', 'ahead', 'behind', 'remotePaths', 'localPaths', 'observationManifestSha256', 'mergeCommit', 'mergeParents'],
  tool: ['name', 'realPath', 'version', 'sha256'],
  reservedDerivedRoot: ['kind', 'path', 'parentDevice', 'parentInode', 'state'],
  CompletionReceipt: ['schemaVersion', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead', 'manifestSha256', 'manifestLockSha256', 'ledgerSha256', 'predecessorReceiptSha256', 'predecessorLedgerSha256', 'reconciledBase', 'upstreamObservedOid', 'corpusDigests', 'oracleDigest', 'lifecycleStatus', 'finalGate', 'overallVerdict'],
  ChainLedger: ['schemaVersion', 'rows', 'reconciledBase', 'upstreamObservedOid', 'corpusDigests', 'oracleDigest'],
  ChainRow: ['ordinal', 'taskId', 'profileId', 'runId', 'entryHead', 'terminalHead', 'manifestSha256', 'previousLedgerSha256', 'overallVerdict'],
  corpusDigests: ['cases', 'holdout'],
  ReadinessRecord: ['schemaVersion', 'runId', 'taskId', 'profileId', 'head', 'snapshotDigestSha256', 'readinessState', 'evaluatedAtUtc', 'evidence', 'assumptions', 'risks', 'blockers', 'decisionRationale', 'decisionAuthority', 'nextAllowedAction', 'overallVerdict'],
  readinessEvidence: ['evidenceId', 'artifactPath', 'producerAttemptId', 'sha256', 'verdict'],
  readinessAssumption: ['assumptionId', 'disposition', 'evidenceRefs'],
  readinessRisk: ['riskId', 'owner', 'checkpoint', 'artifactPath', 'artifactSha256', 'stopCondition'],
  readinessBlocker: ['blockerId', 'reason', 'evidenceRefs'],
  ConsumerVersionDecision: ['schemaVersion', 'runId', 'taskId', 'profileId', 'head', 'snapshotDigestSha256', 'packageVersion', 'currentProducerSchema', 'proposedProducerSchema', 'supportStage', 'inventoryQuerySha256', 'inventoryMatches', 'localConsumers', 'externalConsumers', 'compatibilityReader', 'rollbackCommit', 'decision', 'releaseNoteRequired', 'limitations', 'overallVerdict'],
  consumerInventoryMatch: ['path', 'line', 'column', 'matchKind', 'matchedToken', 'lineSha256'],
  localConsumer: ['consumerId', 'kind', 'path', 'symbol', 'schemaSupport', 'matchRefs'],
  FeedbackMeasurements: ['schemaVersion', 'runId', 'taskId', 'profileId', 'producerAttemptId', 'head', 'snapshotDigestSha256', 'tokenSha256', 'budgets', 'scenarios', 'overallVerdict'],
  boundaryBudgets: ['maxFindings', 'maxObservedPerFinding', 'maxArtifactsPerFinding', 'maxLimitationsPerFinding', 'maxTopLevelLimitations', 'maxFingerprints', 'maxCanonicalRecords', 'maxCorrectionsPerFinding', 'maxVerificationPerFinding', 'maxSourcesPerFinding', 'maxPublicTextBytes', 'maxJsonBytes', 'maxHumanBytes', 'maxHumanReservedSummaryBytes', 'maxHumanDetailedFindings'],
  feedbackScenario: ['ordinal', 'scenario', 'subject', 'inputBytes', 'limitBytes', 'humanBytes', 'jsonBytes', 'detailedFindings', 'omittedFindings', 'renderedObservations', 'omittedObservations', 'evidenceDigestSha256', 'descriptorDigestSha256', 'expectedDisposition', 'observedDisposition'],
  DocsLineageReport: ['schemaVersion', 'runId', 'taskId', 'profileId', 'head', 'snapshotDigestSha256', 'anchors', 'operations', 'pathClasses', 'bEntryIdentity', 'overallVerdict'],
  docsLineageAnchors: ['validatorBase', 'validatorCommit', 'upstreamMerge', 'upstreamFirstParent', 'upstreamSecondParent', 'originMain', 'reconciledBase', 'docsEntryHead', 'docsCurrentHead'],
  docsLineageOperation: ['ordinal', 'operationId', 'argv', 'rawExit', 'rawSignal', 'stdoutSha256', 'stderrSha256', 'parsedOids', 'parsedPaths', 'expectationMet', 'verdict'],
  docsLineagePathClass: ['path', 'status', 'source'],
  docsBEntryIdentity: ['snapshotDigestSha256', 'publicSurfaceSha256', 'publicationAuditSha256', 'handoffSha256', 'workIndexJsonSha256', 'workIndexMarkdownSha256'],
  MergeConflictResolutionReport: ['schemaVersion', 'policy', 'beforeHead', 'expectedSecondParent', 'conflictPaths', 'indexStages', 'generatorArgv', 'generatorRawExit', 'generatorRawSignal', 'resolvedPaths', 'unmergedPaths', 'conflictMarkerPaths', 'diffCheckRawExit', 'diffCheckRawSignal', 'workIndexGuardRawExit', 'workIndexGuardRawSignal', 'preStateDigestSha256', 'resolvedStateDigestSha256', 'verdict'],
  mergeConflictIndexStage: ['path', 'stage', 'mode', 'oid'],
  CloseoutCore: ['schemaVersion', 'runId', 'taskId', 'profileId', 'terminalHead', 'snapshotDigestSha256', 'helperCommit', 'helperSha256', 'runManifestSha256', 'runManifestLockSha256', 'finalizeRawExit', 'finalizeRawSignal', 'verifyRawExit', 'verifyRawSignal', 'completionReceiptSha256', 'completionReceiptLockSha256', 'ledgerSha256', 'ledgerLockSha256', 'startedAtUtc', 'endedAtUtc', 'lifecycleStatus', 'requiredAttemptIds', 'requiredChildAliases', 'internalStatus', 'overallVerdict'],
  CloseoutInternalStatus: ['stage', 'rawExit', 'rawSignal', 'expectationMet', 'verdict'],
  CloseoutNegativeReport: ['schemaVersion', 'runId', 'closeoutCoreSha256', 'cases', 'startedAtUtc', 'endedAtUtc', 'overallVerdict'],
  CloseoutNegativeCase: ['ordinal', 'mutationId', 'fixturePath', 'expectedReasonCode', 'rawExit', 'rawSignal', 'expectationMet', 'stdoutSha256', 'stderrSha256', 'treeDigestSha256', 'verdict'],
  CloseoutReceipt: ['schemaVersion', 'kind', 'runId', 'taskId', 'profileId', 'terminalHead', 'snapshotDigestSha256', 'helperCommit', 'helperSha256', 'runManifestSha256', 'runManifestLockSha256', 'finalizeRawExit', 'finalizeRawSignal', 'verifyRawExit', 'verifyRawSignal', 'completionReceiptSha256', 'completionReceiptLockSha256', 'ledgerSha256', 'ledgerLockSha256', 'startedAtUtc', 'endedAtUtc', 'lifecycleStatus', 'requiredAttemptIds', 'requiredChildAliases', 'closeoutCoreSha256', 'negativeControlReportSha256', 'failedStage', 'runVerdict', 'rawExit', 'rawSignal', 'reasonCode', 'manifestState', 'overallVerdict'],
} as const;

function validSnapshot(): boundaryRun.BoundaryWorktreeSnapshot {
  return {
    head: OID,
    indexTreeOid: OID,
    trackedPatchSha256: SHA,
    unstagedPatchSha256: SHA,
    allowedUntracked: [
      { path: 'scratch/result.json', type: 'regular', mode: '100600', bytes: 3, sha256: SHA },
    ],
    preservedOwner: [
      { path: 'experiment-results.tsv', type: 'regular', mode: '100644', bytes: 600, sha256: SHA },
    ],
    digestSha256: SHA,
  };
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: FIXTURE_EMAIL,
      GIT_AUTHOR_NAME: 'WhatSoup Test',
      GIT_COMMITTER_EMAIL: FIXTURE_EMAIL,
      GIT_COMMITTER_NAME: 'WhatSoup Test',
    },
  }).trim();
}

function makeSnapshotRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'boundary-run-snapshot-'));
  fixtureRoots.push(repo);
  git(repo, ['init']);
  git(repo, ['config', 'core.fileMode', 'true']);
  writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'fixture']);
  mkdirSync(path.join(repo, 'scratch'));
  writeFileSync(path.join(repo, 'scratch/result.json'), '{}\n');
  writeFileSync(path.join(repo, 'owner.tsv'), 'owner\n');
  return repo;
}

function makeEvidenceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'boundary-run-evidence-'));
  fixtureRoots.push(root);
  mkdirSync(path.join(root, 'observation'));
  return realpathSync(root);
}

function makeCliRepo(): { repo: string; runDir: string } {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'boundary-run-cli-')));
  fixtureRoots.push(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'WhatSoup Test']);
  git(repo, ['config', 'user.email', FIXTURE_EMAIL]);
  for (const directory of [
    'docs/superpowers/plans',
    'docs/superpowers/handoffs',
    'docs/superpowers/specs',
    'scripts',
    'tests/scripts',
    'tests/fixtures/semantic-boundary-eval',
  ]) {
    mkdirSync(path.join(repo, directory), { recursive: true });
  }
  writeFileSync(path.join(repo, '.gitignore'), 'evidence/\n');
  writeFileSync(path.join(repo, 'docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md'), '# plan\n');
  writeFileSync(path.join(repo, 'docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md'), '# notes\n');
  writeFileSync(path.join(repo, 'docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md'), '# spec\n');
  writeFileSync(path.join(repo, 'scripts/verify-boundary-run.ts'), 'export {};\n');
  writeFileSync(path.join(repo, 'scripts/semantic-quality-check.ts'), 'export const fixture = true;\n');
  writeFileSync(
    path.join(repo, 'scripts/run-with-pinned-npm.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\nroot="$(pwd -P)"\nfirst=1\nprintf "["\nfor value in "$@"; do\n  case "$value" in\n    tests/*.test.ts)\n      if [ -f "$value" ]; then\n        if [ "$first" -eq 0 ]; then printf ","; fi\n        first=0\n        printf "{\\"name\\":\\"fixture %s\\",\\"file\\":\\"%s/%s\\"}" "$value" "$root" "$value"\n      fi\n      ;;\n  esac\ndone\nprintf "]\\n"\n',
  );
  chmodSync(path.join(repo, 'scripts/run-with-pinned-npm.sh'), 0o755);
  writeFileSync(path.join(repo, 'tests/scripts/verify-boundary-run.test.ts'), 'test fixture\n');
  writeFileSync(path.join(repo, 'tests/scripts/semantic-quality-check.test.ts'), 'test fixture\n');
  writeFileSync(path.join(repo, 'tests/fixtures/semantic-boundary-eval/cases.json'), '{}\n');
  writeFileSync(path.join(repo, 'tests/fixtures/semantic-boundary-eval/holdout.json'), '{}\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  writeFileSync(path.join(repo, 'owner.tsv'), 'owner\n');
  mkdirSync(path.join(repo, 'evidence/observation'), { recursive: true });
  mkdirSync(path.join(repo, 'evidence/reconciliation'), { recursive: true });
  mkdirSync(path.join(repo, 'evidence/task01'), { recursive: true });
  mkdirSync(path.join(repo, 'evidence/completion'), { recursive: true });
  return { repo, runDir: path.join(repo, 'evidence/observation/cli-run') };
}

async function finalizeSyntheticObservation(
  repo: string,
  runDir: string,
  runCli: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>,
  options: {
    observedOid?: string;
    mergeBase?: string;
    remotePaths?: string[];
    localPaths?: string[];
    mergePreviewStdout?: string;
  } = {},
): Promise<{ manifestSha256: string; terminalHead: string; completionReceiptSha256: string; ledgerSha256: string }> {
  const initialized = await runCli([
    'init', '--run-dir', runDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
    '--preserve-owner-path', 'owner.tsv',
    ...(existsSync(path.join(repo, 'node_modules')) ? ['--allow-untracked', 'node_modules'] : []),
  ], repo);
  expect(initialized, JSON.stringify(initialized)).toMatchObject({ ok: true, exitCode: 0 });
  const manifestPath = path.join(runDir, 'run_manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const run = manifest['run'] as Record<string, unknown>;
  const snapshot = manifest['currentSnapshot'] as Record<string, unknown>;
  const attemptIds = run['requiredAttemptIds'] as string[];
  const attempts = attemptIds.map((id) => {
    const attemptDir = path.join(runDir, 'attempts', id);
    mkdirSync(attemptDir);
    const stdout = id === 'merge-preview' ? options.mergePreviewStdout ?? OID : '';
    writeFileSync(path.join(attemptDir, 'stdout.log'), stdout);
    writeFileSync(path.join(attemptDir, 'stderr.log'), '');
    return {
      id,
      operation: 'command',
      headAnchor: 'entry',
      argv: [],
      cwd: repo,
      startedAtUtc: TIME,
      endedAtUtc: TIME,
      expectedExit: boundaryRun.RUN_ATTEMPT_CONTRACTS[id]!.expectedExit,
      rawExit: 0,
      rawSignal: null,
      expectationMet: true,
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 120_000,
      killGraceMs: 30_000,
      preSnapshot: structuredClone(snapshot),
      postSnapshot: structuredClone(snapshot),
      stdout: { path: `attempts/${id}/stdout.log`, sha256: createHash('sha256').update(stdout).digest('hex'), bytes: Buffer.byteLength(stdout) },
      stderr: { path: `attempts/${id}/stderr.log`, sha256: createHash('sha256').update('').digest('hex'), bytes: 0 },
      declaredOutputs: [],
      outputAdmissions: [],
      structuredResult: null,
      verdict: 'Pass',
    };
  });
  manifest['attempts'] = attempts;
  manifest['upstream'] = {
    remoteUrl: SSH_REMOTE,
    observedOid: options.observedOid ?? run['entryHead'],
    mergeBase: options.mergeBase ?? run['entryHead'],
    ahead: 0,
    behind: 0,
    remotePaths: options.remotePaths ?? [],
    localPaths: options.localPaths ?? [],
    observationManifestSha256: 'not-observed',
    mergeCommit: 'not-observed',
    mergeParents: [],
  };
  writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(manifest));
  expect(await runCli([
    'set-lifecycle', '--run-dir', runDir, '--status', 'closed', '--final-gate', 'pass',
    '--oracle', 'not-applicable',
  ], repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  expect(await runCli(['finalize', '--run-dir', runDir], repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  expect(await runCli(['verify', '--run-dir', runDir], repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  const manifestBytes = readFileSync(manifestPath);
  const finalized = JSON.parse(manifestBytes.toString('utf8')) as { run: { terminalHead: string } };
  const completionDir = path.join(path.dirname(path.dirname(runDir)), 'completion', path.basename(runDir));
  return {
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    terminalHead: finalized.run.terminalHead,
    completionReceiptSha256: fileSha(path.join(completionDir, 'completion_receipt.json')),
    ledgerSha256: fileSha(path.join(completionDir, 'chain_ledger.json')),
  };
}

async function initializeSyntheticReconciliation(
  repo: string,
  runDir: string,
  observationRunDir: string,
  runCli: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>,
  options: {
    observedOid: string;
    mergeBase: string;
    remotePaths: string[];
    localPaths: string[];
    mergePreviewStdout?: string;
  },
): Promise<{ manifestSha256: string; terminalHead: string }> {
  const observation = await finalizeSyntheticObservation(repo, observationRunDir, runCli, options);
  const predecessorPin = [
    'BCF-00', 'bcf00-observation', path.basename(observationRunDir), observation.terminalHead,
    observation.manifestSha256, observation.completionReceiptSha256, observation.ledgerSha256,
  ].join(',');
  const childPin = [
    'upstream-observation', observation.terminalHead, path.basename(observationRunDir), observation.manifestSha256,
  ].join(',');
  const initialized = await runCli([
    'init', '--run-dir', runDir, '--task', 'BCF-00', '--profile', 'bcf00-reconciliation',
    '--predecessor-run-dir', observationRunDir, '--predecessor-pin', predecessorPin,
    '--child-pin', childPin, '--preserve-owner-path', 'owner.tsv',
    ...(existsSync(path.join(repo, 'node_modules')) ? ['--allow-untracked', 'node_modules'] : []),
    ...options.remotePaths.flatMap((relativePath) => ['--allow-path', relativePath]),
  ], repo);
  expect(initialized, JSON.stringify(initialized)).toMatchObject({ ok: true, exitCode: 0 });
  expect(await runCli([
    'record-child-run', '--run-dir', runDir, '--alias', 'upstream-observation',
    '--kind', 'observation', '--child-run-dir', observationRunDir, '--expect-task', 'BCF-00',
    '--expect-head', observation.terminalHead, '--expect-run-id', path.basename(observationRunDir),
    '--expect-manifest-sha256', observation.manifestSha256,
  ], repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  return observation;
}

function fillSyntheticRequiredAttempts(repo: string, runDir: string, skipIds: readonly string[] = []): void {
  const manifestPath = path.join(runDir, 'run_manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const run = manifest['run'] as Record<string, unknown>;
  const snapshot = manifest['currentSnapshot'] as Record<string, unknown>;
  const attempts = manifest['attempts'] as Array<Record<string, unknown>>;
  for (const id of run['requiredAttemptIds'] as string[]) {
    if (skipIds.includes(id) || attempts.some((entry) => entry['id'] === id)) continue;
    const contract = boundaryRun.RUN_ATTEMPT_CONTRACTS[id]!;
    const attemptDir = path.join(runDir, 'attempts', id);
    mkdirSync(attemptDir);
    writeFileSync(path.join(attemptDir, 'stdout.log'), '');
    writeFileSync(path.join(attemptDir, 'stderr.log'), '');
    attempts.push({
      id,
      operation: contract.operation,
      headAnchor: contract.headAnchor,
      argv: [...contract.argv],
      cwd: repo,
      startedAtUtc: TIME,
      endedAtUtc: TIME,
      expectedExit: contract.expectedExit,
      rawExit: 0,
      rawSignal: null,
      expectationMet: true,
      watchdogOwner: contract.watchdogOwner,
      innerTimeoutOwner: contract.innerTimeoutOwner,
      deadlineMs: contract.deadlineMs,
      killGraceMs: contract.killGraceMs,
      preSnapshot: structuredClone(snapshot),
      postSnapshot: structuredClone(snapshot),
      stdout: { path: `attempts/${id}/stdout.log`, sha256: createHash('sha256').update('').digest('hex'), bytes: 0 },
      stderr: { path: `attempts/${id}/stderr.log`, sha256: createHash('sha256').update('').digest('hex'), bytes: 0 },
      declaredOutputs: [],
      outputAdmissions: [],
      structuredResult: null,
      verdict: 'Pass',
    });
  }
  writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(manifest));
}

async function createFinalizedSyntheticReconciliation(
  repo: string,
  runCli: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>,
  suffix: string,
): Promise<{
  runDir: string;
  runId: string;
  terminalHead: string;
  manifestSha256: string;
  completionReceiptSha256: string;
  ledgerSha256: string;
  reconciledBase: string;
  upstreamOid: string;
}> {
  const localBranch = git(repo, ['branch', '--show-current']);
  const mergeBase = git(repo, ['rev-parse', 'HEAD']);
  const remotePath = `upstream-${suffix}.txt`;
  const localPath = `local-${suffix}.txt`;
  git(repo, ['switch', '-c', `upstream-${suffix}`]);
  writeFileSync(path.join(repo, remotePath), 'upstream\n');
  git(repo, ['add', remotePath]);
  git(repo, ['commit', '-m', `upstream ${suffix}`]);
  const upstreamOid = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['switch', localBranch]);
  writeFileSync(path.join(repo, localPath), 'local\n');
  git(repo, ['add', localPath]);
  git(repo, ['commit', '-m', `local ${suffix}`]);
  const beforeHead = git(repo, ['rev-parse', 'HEAD']);
  const runId = `${suffix}-reconciliation`;
  const runDir = path.join(repo, 'evidence/reconciliation', runId);
  const observationRunDir = path.join(repo, 'evidence/observation', `${suffix}-observation`);
  await initializeSyntheticReconciliation(repo, runDir, observationRunDir, runCli, {
    observedOid: upstreamOid,
    mergeBase,
    remotePaths: [remotePath],
    localPaths: [localPath],
  });
  expect(await runCli([
    'record-git-transition', '--run-dir', runDir, '--attempt', 'merge-transition',
    '--kind', 'merge', '--expect-before', beforeHead, '--expect-second-parent', upstreamOid,
  ], repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  fillSyntheticRequiredAttempts(repo, runDir);
  expect(await runCli([
    'set-lifecycle', '--run-dir', runDir, '--status', 'completed', '--final-gate', 'pass',
    '--oracle', 'current',
  ], repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  expect(await runCli(['finalize', '--run-dir', runDir], repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  const manifestBytes = readFileSync(path.join(runDir, 'run_manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    run: { terminalHead: string; reconciledBase: string };
  };
  const completionDir = path.join(repo, 'evidence/completion', runId);
  return {
    runDir,
    runId,
    terminalHead: manifest.run.terminalHead,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    completionReceiptSha256: fileSha(path.join(completionDir, 'completion_receipt.json')),
    ledgerSha256: fileSha(path.join(completionDir, 'chain_ledger.json')),
    reconciledBase: manifest.run.reconciledBase,
    upstreamOid,
  };
}

function makeOutputRun(): { root: string; attempt: ReturnType<typeof validAttempt> } {
  const input = mkdtempSync(path.join(tmpdir(), 'boundary-run-output-'));
  fixtureRoots.push(input);
  const root = realpathSync(input);
  mkdirSync(path.join(root, 'outputs'));
  writeFileSync(path.join(root, 'outputs/root.txt'), 'root\n');
  const attempt = validAttempt();
  attempt.outputAdmissions = [
    { path: 'outputs/root.txt', state: 'pending', role: null, sha256: null, bytes: null },
  ] as typeof attempt.outputAdmissions;
  attempt.verdict = 'Inconclusive';
  return { root, attempt };
}

const SNAPSHOT_DECLARATIONS: boundaryRun.BoundarySnapshotDeclarations = {
  allowedUntrackedPaths: ['scratch/result.json'],
  preservedOwnerPaths: ['owner.tsv'],
} as const;

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function validDocument(path: string, bytes: number): boundaryRun.BoundaryDocumentHashRecord {
  return { path, sha256: SHA, bytes };
}

function validStream(path: string): boundaryRun.BoundaryStreamRecord {
  return { path, sha256: SHA, bytes: 1 };
}

function validAttempt(): boundaryRun.BoundaryAttemptRecord {
  return {
    id: 'upstream-root',
    operation: 'command',
    headAnchor: 'entry',
    argv: ['git', 'rev-parse', '--show-toplevel'],
    cwd: '/tmp/whatsoup',
    startedAtUtc: TIME,
    endedAtUtc: TIME,
    expectedExit: '0',
    rawExit: 0,
    rawSignal: null,
    expectationMet: true,
    watchdogOwner: 'helper-watchdog',
    innerTimeoutOwner: null,
    deadlineMs: 60_000,
    killGraceMs: 30_000,
    preSnapshot: validSnapshot(),
    postSnapshot: validSnapshot(),
    stdout: validStream('attempts/upstream-root/stdout.log'),
    stderr: validStream('attempts/upstream-root/stderr.log'),
    declaredOutputs: ['outputs/root.txt'],
    outputAdmissions: [
      { path: 'outputs/root.txt', state: 'admitted', role: 'output', sha256: SHA, bytes: 1 },
    ],
    structuredResult: validStream('attempts/upstream-root/result.json'),
    verdict: 'Pass',
  };
}

function validChild(): boundaryRun.BoundaryChildRecord {
  return {
    alias: 'upstream-observation',
    kind: 'observation',
    taskId: 'BCF-00',
    profileId: 'bcf00-observation',
    runId: 'child-run',
    entryHead: OID,
    terminalHead: OID,
    snapshotDigestSha256: SHA,
    sourceManifestSha256: SHA,
    importedFiles: [{ path: 'run_manifest.json', sha256: SHA, bytes: 1 }],
    treeDigestSha256: SHA,
    overallVerdict: 'Pass',
    dedupeKey: 'observation-child-run',
  };
}

function validFinding(): boundaryRun.BoundaryFindingRecord {
  return {
    findingId: 'finding-1',
    severity: 'note',
    requiresFix: false,
    requiresReproduction: false,
    evidencePath: 'reviews/finding-1.json',
    evidenceSha256: SHA,
    disposition: 'accepted',
    resolution: 'not-applicable',
    reason: 'No action is required.',
    counterevidenceRefs: [],
    reproductionAttemptIds: [],
    counterReproductionAttemptIds: [],
    fixedAtHead: null,
    fixReproductionAttemptIds: [],
    fixReviewId: null,
  };
}

function validReview(): boundaryRun.BoundaryReviewRecord {
  return {
    reviewId: 'review-1',
    alias: 'review-contract',
    dedupeKey: 'review-contract-one',
    head: OID,
    snapshotDigestSha256: SHA,
    reportPath: 'reviews/review-1/report.json',
    reportSha256: SHA,
    metaPath: 'reviews/review-1/meta.json',
    metaSha256: SHA,
    stderrPath: 'reviews/review-1/stderr.log',
    stderrSha256: SHA,
    findings: [validFinding()],
    reproductionContracts: [],
  };
}

function validPredecessor(): boundaryRun.BoundaryPredecessorRecord {
  return {
    pin: {
      taskId: 'BCF-00',
      profileId: 'bcf00-observation',
      runId: 'predecessor-run',
      terminalHead: OID,
      manifestSha256: SHA,
      completionReceiptSha256: SHA,
      ledgerSha256: SHA,
    },
    sourceManifestSha256: SHA,
    importedFiles: [{ path: 'run_manifest.json', sha256: SHA, bytes: 1 }],
    treeDigestSha256: SHA,
    overallVerdict: 'Pass',
  };
}

function validManifest(): boundaryRun.BoundaryRunManifest {
  const snapshot = validSnapshot();
  return {
    schemaVersion: 1,
    manifestState: 'active',
    run: {
      runId: 'valid-run',
      taskId: 'BCF-00',
      profileId: 'bcf00-observation',
      phase: 'observation',
      createdAtUtc: TIME,
      finalizedAtUtc: null,
      entryHead: OID,
      terminalHead: null,
      reconciledBase: 'not-observed',
      helperCommit: OID,
      helperSha256: SHA,
      allowedPaths: [],
      allowedUntrackedPaths: ['scratch/result.json'],
      preservedOwnerPaths: ['experiment-results.tsv'],
      requiredAttemptIds: [
        'merge-preview',
        'upstream-ahead-behind',
        'upstream-fetch',
        'upstream-head',
        'upstream-local-diff',
        'upstream-merge-base',
        'upstream-origin-oid',
        'upstream-remote',
        'upstream-remote-diff',
        'upstream-root',
        'upstream-status',
        'validator-suite-postcommit',
        'validator-typecheck-postcommit',
      ],
      requiredChildAliases: [],
      requiredChildPins: [],
      transitionCount: 0,
      mayComplete: false,
      chainAppend: false,
      requestedTools: [],
      observedTools: [],
      reservedDerivedRoots: [
        { kind: 'closeout', path: '/tmp/bcf/closeout/valid-run', parentDevice: 1, parentInode: 2, state: 'reserved' },
        { kind: 'closeout-failure', path: '/tmp/bcf/closeout-failures/valid-run', parentDevice: 1, parentInode: 3, state: 'reserved' },
        { kind: 'completion', path: '/tmp/bcf/completion/valid-run', parentDevice: 1, parentInode: 4, state: 'reserved' },
        { kind: 'run', path: '/tmp/bcf/observation/valid-run', parentDevice: 1, parentInode: 5, state: 'created' },
      ],
    },
    entrySnapshot: snapshot,
    currentSnapshot: snapshot,
    attempts: [],
    artifacts: [],
    children: [],
    predecessor: null,
    entryTestRoster: {
      files: [
        {
          path: 'tests/scripts/verify-boundary-run.test.ts',
          state: 'present',
          testNames: [`[BCF00-${'B01'}] accepts the complete active manifest wire contract`],
        },
      ],
      digestSha256: SHA,
    },
    reviews: [],
    lifecycle: {
      status: 'active',
      completionCommit: null,
      finalGate: 'not-run',
      artifactSha256: null,
      successor: null,
      supersededBy: null,
      oracle: 'not-applicable',
      branchDeletionAuthorized: false,
    },
    documentHashes: {
      spec: validDocument('docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md', 1),
      plan: validDocument('docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md', 2),
      notes: validDocument('docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md', 3),
      helper: validDocument('scripts/verify-boundary-run.ts', 4),
    },
    upstream: {
      remoteUrl: 'not-observed',
      observedOid: 'not-observed',
      mergeBase: 'not-observed',
      ahead: 'not-observed',
      behind: 'not-observed',
      remotePaths: [],
      localPaths: [],
      observationManifestSha256: 'not-observed',
      mergeCommit: 'not-observed',
      mergeParents: [],
    },
    overallVerdict: 'Inconclusive',
  };
}

function withValue(path: string[], value: unknown): Record<string, unknown> {
  const candidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
  let parent = candidate;
  for (const segment of path.slice(0, -1)) {
    parent = parent[segment] as Record<string, unknown>;
  }
  parent[path.at(-1)!] = value;
  return candidate;
}

function canonicalJson(value: unknown): string {
  function sort(candidate: unknown): unknown {
    if (Array.isArray(candidate)) return candidate.map(sort);
    if (candidate === null || typeof candidate !== 'object') return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
        .map(([key, nested]) => [key, sort(nested)]),
    );
  }
  return `${JSON.stringify(sort(value))}\n`;
}

function canonicalSha(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function writeSyntheticRunInitAnchor(runDir: string, manifest: Record<string, unknown>): void {
  const run = manifest['run'] as Record<string, unknown>;
  const entrySnapshot = manifest['entrySnapshot'] as Record<string, unknown>;
  const entryTestRoster = manifest['entryTestRoster'] as Record<string, unknown>;
  const documentHashes = manifest['documentHashes'];
  const anchor = {
    schemaVersion: 1,
    runId: run['runId'],
    taskId: run['taskId'],
    profileId: run['profileId'],
    phase: run['phase'],
    createdAtUtc: run['createdAtUtc'],
    entryHead: run['entryHead'],
    entrySnapshotDigestSha256: entrySnapshot['digestSha256'],
    helperCommit: run['helperCommit'],
    helperSha256: run['helperSha256'],
    allowedPaths: run['allowedPaths'],
    allowedUntrackedPaths: run['allowedUntrackedPaths'],
    preservedOwnerPaths: run['preservedOwnerPaths'],
    requiredAttemptIds: run['requiredAttemptIds'],
    requiredChildAliases: run['requiredChildAliases'],
    requiredChildPins: run['requiredChildPins'],
    predecessorPin: (manifest['predecessor'] as Record<string, unknown> | null)?.['pin'] ?? null,
    predecessorTreeDigestSha256: (manifest['predecessor'] as Record<string, unknown> | null)?.['treeDigestSha256'] ?? null,
    mayComplete: run['mayComplete'],
    chainAppend: run['chainAppend'],
    requestedTools: run['requestedTools'],
    observedTools: run['observedTools'],
    reservedDerivedRoots: run['reservedDerivedRoots'],
    entryTestRosterDigestSha256: entryTestRoster['digestSha256'],
    documentHashesDigestSha256: canonicalSha(documentHashes),
  };
  const bytes = canonicalJson(anchor);
  writeFileSync(path.join(runDir, 'run_init.json'), bytes);
  writeFileSync(path.join(runDir, 'run_init.sha256'), `${createHash('sha256').update(bytes).digest('hex')}  run_init.json\n`);
}

function fileSha(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function validChildImportInput() {
  const input = mkdtempSync(path.join(tmpdir(), 'boundary-run-child-'));
  fixtureRoots.push(input);
  const importRoot = realpathSync(input);
  mkdirSync(path.join(importRoot, 'artifacts'));
  writeFileSync(path.join(importRoot, 'artifacts/output.json'), '{"ok":true}\n');
  writeFileSync(path.join(importRoot, 'run_manifest.json'), '{"manifest":"child"}\n');
  const importedFiles = [
    {
      path: 'artifacts/output.json',
      sha256: fileSha(path.join(importRoot, 'artifacts/output.json')),
      bytes: readFileSync(path.join(importRoot, 'artifacts/output.json')).byteLength,
    },
    {
      path: 'run_manifest.json',
      sha256: fileSha(path.join(importRoot, 'run_manifest.json')),
      bytes: readFileSync(path.join(importRoot, 'run_manifest.json')).byteLength,
    },
  ];
  const sourceManifestSha256 = importedFiles[1]!.sha256;
  const child = {
    alias: 'upstream-observation',
    kind: 'observation',
    taskId: 'BCF-00',
    profileId: 'bcf00-observation',
    runId: 'observation-run',
    entryHead: OID,
    terminalHead: OID,
    snapshotDigestSha256: SHA,
    sourceManifestSha256,
    importedFiles,
    treeDigestSha256: canonicalSha(importedFiles),
    overallVerdict: 'Pass',
    dedupeKey: 'observation-run-one',
  };
  return {
    parentRunId: 'reconciliation-run',
    parentDepth: 0,
    maxDepth: 2,
    importRoot,
    existingAliases: [] as string[],
    existingPaths: [] as string[],
    verifiedSourceManifestSha256: sourceManifestSha256,
    pin: {
      alias: 'upstream-observation',
      kind: 'observation',
      taskId: 'BCF-00',
      profileId: 'bcf00-observation',
      runId: 'observation-run',
      entryHead: OID,
      terminalHead: OID,
      manifestSha256: sourceManifestSha256,
    },
    child,
  };
}

function validReviewJoinInput() {
  const review = validReview();
  review.head = OID_C;
  review.findings = [
    {
      findingId: 'finding-1',
      severity: 'major',
      requiresFix: true,
      requiresReproduction: true,
      evidencePath: 'reviews/finding-1.json',
      evidenceSha256: SHA,
      disposition: 'rejected',
      resolution: 'not-applicable',
      reason: 'Direct counterevidence disproves the report.',
      counterevidenceRefs: ['artifacts/counterevidence.json'],
      reproductionAttemptIds: ['original-repro'],
      counterReproductionAttemptIds: ['counter-repro'],
      fixedAtHead: null,
      fixReproductionAttemptIds: [],
      fixReviewId: null,
    },
  ];
  review.reproductionContracts = [
    {
      attemptId: 'counter-repro',
      argv: ['test', 'counter'],
      expectedExit: '0',
      toolName: 'test',
      deadlineMs: 900_000,
      killGraceMs: 30_000,
    },
    {
      attemptId: 'original-repro',
      argv: ['test', 'unsafe'],
      expectedExit: 'nonzero',
      toolName: 'test',
      deadlineMs: 900_000,
      killGraceMs: 30_000,
    },
  ];
  return {
    currentHead: OID_C,
    reviews: [review],
    attempts: [
      { id: 'original-repro', head: OID_C, snapshotDigestSha256: SHA, rawExit: 1, rawSignal: null, expectationMet: true, verdict: 'Pass' },
      { id: 'counter-repro', head: OID_C, snapshotDigestSha256: SHA, rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' },
    ],
  };
}

function installImportedRun(
  root: string,
  manifest: ReturnType<typeof validManifest>,
  files: Readonly<Record<string, string>>,
): { manifestSha256: string; importedFiles: Array<{ path: string; sha256: string; bytes: number }> } {
  mkdirSync(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  const initBytes = boundaryRun.canonicalizeBoundaryRun(boundaryRun.createBoundaryRunInitAnchor(manifest));
  writeFileSync(path.join(root, 'run_init.json'), initBytes);
  writeFileSync(
    path.join(root, 'run_init.sha256'),
    `${createHash('sha256').update(initBytes).digest('hex')}  run_init.json\n`,
  );
  const manifestBytes = boundaryRun.canonicalizeBoundaryRun(manifest);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  writeFileSync(path.join(root, 'run_manifest.json'), manifestBytes);
  writeFileSync(path.join(root, 'run_manifest.sha256'), `${manifestSha256}  run_manifest.json\n`);
  const closurePaths = [
    'run_init.json',
    'run_init.sha256',
    'run_manifest.json',
    'run_manifest.sha256',
    ...manifest.attempts.flatMap((attempt) => [
      attempt.stdout.path,
      attempt.stderr.path,
      ...(attempt.structuredResult === null ? [] : [attempt.structuredResult.path]),
    ]),
    ...manifest.reviews.flatMap((review) => [
      review.reportPath,
      review.metaPath,
      review.stderrPath,
      ...review.findings.map((finding) => finding.evidencePath),
    ]),
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const importedFiles = closurePaths.map((relativePath) => {
    const bytes = readFileSync(path.join(root, relativePath));
    return { path: relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
  });
  return { manifestSha256, importedFiles };
}

function validTransitionInput() {
  return {
    existingUpstream: null as Record<string, unknown> | null,
    callerFields: {},
    attemptOutputs: {
      remoteUrl: SSH_REMOTE,
      observedOid: OID_C,
      mergeBase: OID,
      ahead: 1,
      behind: 0,
      remotePaths: ['upstream.txt'],
      localPaths: ['local.txt'],
      observationManifestSha256: SHA,
    },
    transitionCount: 0,
    contract: {
      kind: 'merge',
      expectedBeforeHead: OID,
      expectedSecondParent: OID_C,
      allowedPaths: ['upstream.txt'],
    },
    transition: {
      kind: 'merge',
      rawExit: 0,
      rawSignal: null,
      beforeHead: OID,
      afterHead: OID_D,
      parents: [OID, OID_C],
      frozenIndexTreeOid: OID,
      postIndexTreeOid: OID_D,
      commitTreeOid: OID_D,
      changedPaths: ['upstream.txt'],
      conflictPaths: [] as string[],
      abortAttempted: false,
      abortRestored: null as boolean | null,
      beforeSnapshotDigestSha256: SHA_B,
      afterSnapshotDigestSha256: SHA_C,
      conflictResolutionReport: null,
    },
  };
}

function validLifecycleStateInput() {
  return {
    manifestState: 'finalized',
    profile: {
      terminalLifecycle: 'closed',
      requiredAttemptIds: ['required-attempt'],
      requiredChildAliases: [],
    },
    lifecycle: {
      status: 'closed',
      finalGate: 'pass',
    },
    entryHead: OID,
    terminalHead: OID,
    currentSnapshotDigestSha256: SHA,
    liveSnapshotDigestSha256: SHA,
    attempts: [{ id: 'required-attempt', expectationMet: true, verdict: 'Pass' }],
    children: [],
    presentFiles: {
      manifestLock: true,
      completionReceipt: true,
      completionReceiptLock: true,
      ledger: true,
      ledgerLock: true,
    },
  };
}

function validBundleInput() {
  const input = mkdtempSync(path.join(tmpdir(), 'boundary-run-bundle-'));
  fixtureRoots.push(input);
  const evidenceRoot = realpathSync(input);
  const acceptedParent = path.join(evidenceRoot, 'closeout');
  const rejectedParent = path.join(evidenceRoot, 'closeout-failures');
  mkdirSync(acceptedParent);
  mkdirSync(rejectedParent);
  const runManifest = { schemaVersion: 1, runId: 'final-run', manifestState: 'finalized' };
  const ledger = { schemaVersion: 1, runId: 'final-run', rows: [{ ordinal: 1 }] };
  const runManifestSha256 = canonicalSha(runManifest);
  const ledgerSha256 = canonicalSha(ledger);
  const completionReceipt = { schemaVersion: 1, runId: 'final-run', manifestSha256: runManifestSha256, ledgerSha256 };
  const completionReceiptSha256 = canonicalSha(completionReceipt);
  const closeoutCore = {
    schemaVersion: 1,
    runId: 'final-run',
    runManifestSha256,
    completionReceiptSha256,
    ledgerSha256,
  };
  const closeoutCoreSha256 = canonicalSha(closeoutCore);
  const negativeReport = { schemaVersion: 1, runId: 'final-run', closeoutCoreSha256, cases: [] };
  const negativeControlReportSha256 = canonicalSha(negativeReport);
  const closeoutReceipt = {
    schemaVersion: 1,
    kind: 'accepted',
    runId: 'final-run',
    runManifestSha256,
    completionReceiptSha256,
    ledgerSha256,
    closeoutCoreSha256,
    negativeControlReportSha256,
    overallVerdict: 'Pass',
  };
  return {
    evidenceRoot,
    acceptedParent,
    rejectedParent,
    runId: 'final-run',
    kind: 'accepted',
    objects: { runManifest, ledger, completionReceipt, closeoutCore, negativeReport, closeoutReceipt },
  };
}

function validImmutableClosureInput() {
  const input = mkdtempSync(path.join(tmpdir(), 'boundary-run-immutable-'));
  fixtureRoots.push(input);
  const closureRoot = realpathSync(input);
  writeFileSync(path.join(closureRoot, 'run_manifest.json'), '{"finalized":true}\n');
  writeFileSync(path.join(closureRoot, 'helper.ts'), 'export const helper = true;\n');
  writeFileSync(path.join(closureRoot, 'plan.md'), '# Plan\n');
  const row = (filePath: string) => ({
    path: filePath,
    sha256: fileSha(path.join(closureRoot, filePath)),
    bytes: readFileSync(path.join(closureRoot, filePath)).byteLength,
  });
  const closureFiles = [row('helper.ts'), row('plan.md'), row('run_manifest.json')];
  const repo = makeSnapshotRepo();
  const captured = boundaryRun.captureBoundaryWorktreeSnapshot(repo, SNAPSHOT_DECLARATIONS);
  if (!captured.ok || captured.snapshot === null) throw new Error('fixture snapshot failed');
  const evidenceRoot = makeEvidenceRoot();
  mkdirSync(path.join(evidenceRoot, 'observation', 'current-run'));
  const reserved = boundaryRun.reserveBoundaryDerivedRoot({
    evidenceRoot,
    parentSegments: ['observation'],
    runId: 'next-run',
    kind: 'run',
    protectedPaths: [],
  });
  if (!reserved.ok || reserved.reservation === null) throw new Error('fixture reservation failed');
  return {
    closureRoot,
    closureFiles,
    helper: row('helper.ts'),
    documents: [row('plan.md')],
    repo,
    snapshot: captured.snapshot,
    declarations: SNAPSHOT_DECLARATIONS,
    reservedRoots: [reserved.reservation],
    currentRunId: 'current-run',
    retryRunId: 'next-run',
    retryDestination: reserved.reservation.path,
  };
}

function validPredecessorChainInput() {
  const ledger = {
    schemaVersion: 1,
    rows: [
      {
        ordinal: 1,
        taskId: 'BCF-00',
        profileId: 'bcf00-reconciliation',
        runId: 'reconciliation-run',
        entryHead: OID,
        terminalHead: OID_C,
        manifestSha256: SHA,
        previousLedgerSha256: null,
        overallVerdict: 'Pass',
      },
    ],
    reconciledBase: OID_C,
    upstreamObservedOid: OID_C,
    corpusDigests: { cases: SHA_B, holdout: SHA_C },
    oracleDigest: SHA_B,
  };
  const ledgerSha256 = canonicalSha(ledger);
  const receipt = {
    schemaVersion: 1,
    taskId: 'BCF-00',
    profileId: 'bcf00-reconciliation',
    runId: 'reconciliation-run',
    entryHead: OID,
    terminalHead: OID_C,
    manifestSha256: SHA,
    manifestLockSha256: SHA_B,
    ledgerSha256,
    predecessorReceiptSha256: null,
    predecessorLedgerSha256: null,
    reconciledBase: OID_C,
    upstreamObservedOid: OID_C,
    corpusDigests: { cases: SHA_B, holdout: SHA_C },
    oracleDigest: SHA_B,
    lifecycleStatus: 'completed',
    finalGate: 'pass',
    overallVerdict: 'Pass',
  };
  const completionReceiptSha256 = canonicalSha(receipt);
  return {
    profileId: 'bcf01-parser',
    pin: {
      taskId: 'BCF-00',
      profileId: 'bcf00-reconciliation',
      runId: 'reconciliation-run',
      terminalHead: OID_C,
      manifestSha256: SHA,
      completionReceiptSha256,
      ledgerSha256,
    },
    receipt,
    receiptSha256: completionReceiptSha256,
    ledger,
    ledgerSha256,
    inherited: {
      reconciledBase: OID_C,
      upstreamObservedOid: OID_C,
      corpusDigests: { cases: SHA_B, holdout: SHA_C },
      oracleDigest: SHA_B,
    },
    currentRow: {
      ordinal: 2,
      taskId: 'BCF-01',
      profileId: 'bcf01-parser',
      runId: 'parser-run',
      entryHead: OID_C,
      terminalHead: OID_D,
      manifestSha256: SHA_C,
      previousLedgerSha256: ledgerSha256,
      overallVerdict: 'Pass',
    },
  };
}

describe('boundary run validator', () => {
  it('[BCF00-S01] parses expected exits in linear bounded form', () => {
    const api = boundaryRun as unknown as {
      parseBoundaryExpectedExit?: (value: string) => Set<number> | 'nonzero' | null;
    };
    expect(typeof api.parseBoundaryExpectedExit).toBe('function');
    if (!api.parseBoundaryExpectedExit) return;

    expect(api.parseBoundaryExpectedExit('nonzero')).toBe('nonzero');
    expect(api.parseBoundaryExpectedExit('0')).toEqual(new Set([0]));
    expect(api.parseBoundaryExpectedExit('0,1,255')).toEqual(new Set([0, 1, 255]));

    for (const value of [
      '', '00', '01', '256', '1,1', '2,1', '0,', '1,,2',
      ' 1', '1 ', '+1', '1.0', '1\n2',
    ]) {
      expect(api.parseBoundaryExpectedExit(value), value).toBeNull();
    }

    const adversarial = `${Array.from({ length: 10_000 }, () => '0,1').join(',')},x`;
    expect(api.parseBoundaryExpectedExit(adversarial)).toBeNull();
  });

  it('[BCF00-B01] accepts the complete active manifest wire contract', () => {
    const result = validateBoundaryRun(validManifest());

    expect(result, result.issues.map((issue) => issue.message).join('\n')).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });

  it('[BCF00-U01] rejects blind or drifted worktree snapshots', () => {
    const api = boundaryRun as unknown as {
      captureBoundaryWorktreeSnapshot?: (
        repo: string,
        declarations: typeof SNAPSHOT_DECLARATIONS,
      ) => { ok: boolean; snapshot: unknown; issues: Array<{ code: string }> };
      verifyBoundaryWorktreeSnapshot?: (
        repo: string,
        snapshot: unknown,
        declarations: typeof SNAPSHOT_DECLARATIONS,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.captureBoundaryWorktreeSnapshot).toBe('function');
    expect(typeof api.verifyBoundaryWorktreeSnapshot).toBe('function');
    if (!api.captureBoundaryWorktreeSnapshot || !api.verifyBoundaryWorktreeSnapshot) return;

    const mutations: Array<{ code: string; apply: (repo: string) => void }> = [
      {
        code: 'snapshot-index-drift',
        apply: (repo) => {
          writeFileSync(path.join(repo, 'tracked.txt'), 'staged\n');
          git(repo, ['add', 'tracked.txt']);
        },
      },
      {
        code: 'snapshot-unstaged-drift',
        apply: (repo) => writeFileSync(path.join(repo, 'tracked.txt'), 'unstaged\n'),
      },
      {
        code: 'snapshot-unstaged-drift',
        apply: (repo) => chmodSync(path.join(repo, 'tracked.txt'), 0o755),
      },
      {
        code: 'snapshot-allowed-untracked-drift',
        apply: (repo) => writeFileSync(path.join(repo, 'scratch/result.json'), '{"changed":true}\n'),
      },
      {
        code: 'snapshot-unexpected-untracked',
        apply: (repo) => writeFileSync(path.join(repo, 'unexpected.txt'), 'unexpected\n'),
      },
      {
        code: 'snapshot-owner-drift',
        apply: (repo) => writeFileSync(path.join(repo, 'owner.tsv'), 'changed owner\n'),
      },
    ];

    for (const { code, apply } of mutations) {
      const repo = makeSnapshotRepo();
      const captured = api.captureBoundaryWorktreeSnapshot(repo, SNAPSHOT_DECLARATIONS);
      expect(captured.ok, captured.issues.map((entry) => entry.code).join(', ')).toBe(true);
      apply(repo);
      const result = api.verifyBoundaryWorktreeSnapshot(repo, captured.snapshot, SNAPSHOT_DECLARATIONS);
      expect(result, code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), code).toContain(code);
    }

    const blindRepo = makeSnapshotRepo();
    const blind = api.captureBoundaryWorktreeSnapshot(blindRepo, {
      allowedUntrackedPaths: ['scratch/result.json'],
      preservedOwnerPaths: [],
    });
    expect(blind.ok).toBe(false);
    expect(blind.issues.map((entry) => entry.code)).toContain('snapshot-unexpected-untracked');
  });

  it('[BCF00-N01] accepts a complete canonical worktree snapshot with an unchanged owner', () => {
    const api = boundaryRun as unknown as {
      captureBoundaryWorktreeSnapshot?: (
        repo: string,
        declarations: typeof SNAPSHOT_DECLARATIONS,
      ) => { ok: boolean; snapshot: unknown; issues: Array<{ code: string }> };
      verifyBoundaryWorktreeSnapshot?: (
        repo: string,
        snapshot: unknown,
        declarations: typeof SNAPSHOT_DECLARATIONS,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.captureBoundaryWorktreeSnapshot).toBe('function');
    expect(typeof api.verifyBoundaryWorktreeSnapshot).toBe('function');
    if (!api.captureBoundaryWorktreeSnapshot || !api.verifyBoundaryWorktreeSnapshot) return;

    const repo = makeSnapshotRepo();
    const captured = api.captureBoundaryWorktreeSnapshot(repo, SNAPSHOT_DECLARATIONS);
    expect(captured.ok, captured.issues.map((entry) => entry.code).join(', ')).toBe(true);
    expect(captured.snapshot).toMatchObject({
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
      indexTreeOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      allowedUntracked: [expect.objectContaining({ path: 'scratch/result.json', type: 'regular' })],
      preservedOwner: [expect.objectContaining({ path: 'owner.tsv', type: 'regular' })],
      digestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(api.verifyBoundaryWorktreeSnapshot(repo, captured.snapshot, SNAPSHOT_DECLARATIONS)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });

  it('[BCF00-U13] rejects non-closed manifest wire shapes', () => {
    const extra = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    extra['unexpected'] = true;
    const missing = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    delete missing['upstream'];
    const nestedCandidates = ['run', 'entrySnapshot', 'currentSnapshot', 'entryTestRoster', 'lifecycle', 'documentHashes', 'upstream']
      .map((key) => {
        const candidate = structuredClone(validManifest()) as unknown as Record<string, Record<string, unknown>>;
        candidate[key]['unexpected'] = true;
        return candidate;
      });
    const invalidValues = [
      withValue(['schemaVersion'], 2),
      withValue(['manifestState'], 'complete'),
      withValue(['run', 'createdAtUtc'], '2026-07-16T16:30:00Z'),
      withValue(['run', 'terminalHead'], ''),
      withValue(['run', 'transitionCount'], 2),
      withValue(['run', 'reservedDerivedRoots', '0', 'parentDevice'], 1.5),
      withValue(['entrySnapshot', 'digestSha256'], SHA.toUpperCase()),
      withValue(['entrySnapshot', 'allowedUntracked', '0', 'path'], `scratch/${'x'.repeat(1_025)}`),
      withValue(['lifecycle', 'branchDeletionAuthorized'], true),
      withValue(['upstream', 'observedOid'], null),
    ];

    const rowCandidates: Array<{ candidate: Record<string, unknown>; code: string }> = [];
    const withUnexpected = (value: Record<string, unknown>): Record<string, unknown> => ({
      ...value,
      unexpected: true,
    });
    for (const [path, row, code] of [
      [['run', 'observedTools'], { name: 'git', realPath: '/usr/bin/git', version: '2.50.1', sha256: SHA }, 'invalid-tool-keys'],
      [['run', 'reservedDerivedRoots'], { kind: 'run', path: '/tmp/bcf/run/valid-run', parentDevice: 1, parentInode: 2, state: 'created' }, 'invalid-reserved-derived-root-keys'],
      [['entrySnapshot', 'allowedUntracked'], validSnapshot().allowedUntracked[0], 'invalid-snapshot-path-keys'],
      [['attempts'], validAttempt(), 'invalid-attempt-keys'],
      [['artifacts'], { path: 'outputs/root.txt', role: 'output', producerAttemptId: 'upstream-root', sha256: SHA, bytes: 1 }, 'invalid-artifact-keys'],
      [['children'], validChild(), 'invalid-child-keys'],
      [['entryTestRoster', 'files'], { path: 'tests/example.test.ts', state: 'present', testNames: ['example'] }, 'invalid-test-roster-file-keys'],
      [['reviews'], validReview(), 'invalid-review-keys'],
    ] as const) {
      const candidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
      let parent = candidate;
      for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
      parent[path.at(-1)!] = [withUnexpected(structuredClone(row) as unknown as Record<string, unknown>)];
      rowCandidates.push({ candidate, code });
    }
    for (const [path, value, code] of [
      [['predecessor'], validPredecessor(), 'invalid-predecessor-keys'],
      [['documentHashes', 'spec'], validDocument('docs/spec.md', 1), 'invalid-document-hash-keys'],
    ] as const) {
      const candidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
      let parent = candidate;
      for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
      parent[path.at(-1)!] = withUnexpected(structuredClone(value) as unknown as Record<string, unknown>);
      rowCandidates.push({ candidate, code });
    }
    const attemptNestedCandidates = [
      ['preSnapshot', validSnapshot(), 'invalid-snapshot-keys'],
      ['stdout', validStream('attempts/upstream-root/stdout.log'), 'invalid-stream-keys'],
      ['outputAdmissions', validAttempt().outputAdmissions[0], 'invalid-output-admission-keys'],
    ] as const;
    for (const [field, row, code] of attemptNestedCandidates) {
      const candidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
      const attempt = validAttempt() as unknown as Record<string, unknown>;
      attempt[field] = field === 'outputAdmissions'
        ? [withUnexpected(structuredClone(row) as unknown as Record<string, unknown>)]
        : withUnexpected(structuredClone(row) as unknown as Record<string, unknown>);
      candidate['attempts'] = [attempt];
      rowCandidates.push({ candidate, code });
    }
    const childCandidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    const child = validChild();
    child.importedFiles = [withUnexpected(child.importedFiles[0]! as unknown as Record<string, unknown>) as unknown as typeof child.importedFiles[number]];
    childCandidate['children'] = [child];
    rowCandidates.push({ candidate: childCandidate, code: 'invalid-imported-file-keys' });
    const predecessorCandidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    const predecessor = validPredecessor();
    predecessor.pin = withUnexpected(predecessor.pin as unknown as Record<string, unknown>) as unknown as typeof predecessor.pin;
    predecessorCandidate['predecessor'] = predecessor;
    rowCandidates.push({ candidate: predecessorCandidate, code: 'invalid-predecessor-pin-keys' });
    const reviewCandidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    const review = validReview();
    review.findings = [withUnexpected(review.findings[0]! as unknown as Record<string, unknown>) as unknown as typeof review.findings[number]];
    reviewCandidate['reviews'] = [review];
    rowCandidates.push({ candidate: reviewCandidate, code: 'invalid-finding-keys' });

    for (const candidate of [extra, missing, ...nestedCandidates, ...invalidValues]) {
      expect(validateBoundaryRun(candidate)).toMatchObject({
        ok: false,
        exitCode: 1,
        verdict: 'Inconclusive',
      });
    }
    for (const { candidate, code } of rowCandidates) {
      const result = validateBoundaryRun(candidate);
      expect(result, `nested row ${code}`).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), `nested row ${code}`).toContain(code);
    }

    const canonical = canonicalJson(validManifest());
    const canonicalWithCrLf = canonical.replaceAll('\n', '\r\n');
    const rawCases = [
      {
        bytes: Buffer.from(canonical.replace('"artifacts":[]', '"artifacts":[],"artifacts":[]')),
        code: 'duplicate-json-key',
      },
      {
        bytes: Buffer.from(canonical.replace('"runId":"valid-run"', '"runId":"valid-run","runId":"other"')),
        code: 'duplicate-json-key',
      },
      { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]), code: 'invalid-json-byte' },
      { bytes: Buffer.from(canonicalWithCrLf), code: 'invalid-json-byte' },
      { bytes: Uint8Array.from([0xff, ...Buffer.from(canonical)]), code: 'invalid-json' },
      { bytes: Buffer.from(canonical.replace('"parentDevice":1', '"parentDevice":-0')), code: 'invalid-json-number' },
      { bytes: Buffer.from(` ${canonical}`), code: 'noncanonical-json' },
      { bytes: Buffer.from(`${canonical}x`), code: 'invalid-json' },
    ];
    const api = boundaryRun as unknown as {
      validateBoundaryRunJson: (bytes: Uint8Array) => ReturnType<typeof validateBoundaryRun>;
    };
    for (const { bytes, code } of rawCases) {
      const result = api.validateBoundaryRunJson(bytes);
      expect(result, `raw case ${code}`).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code)).toContain(code);
    }
  });

  it('[BCF00-N13] accepts and reproduces canonical manifest bytes', () => {
    const api = boundaryRun as unknown as {
      canonicalizeBoundaryRun?: (value: unknown) => string;
      validateBoundaryRunJson?: (bytes: Uint8Array) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.canonicalizeBoundaryRun).toBe('function');
    expect(typeof api.validateBoundaryRunJson).toBe('function');
    expect((boundaryRun as unknown as { RUN_WIRE_SCHEMAS?: unknown }).RUN_WIRE_SCHEMAS).toEqual(EXPECTED_WIRE_SCHEMAS);
    if (!api.canonicalizeBoundaryRun || !api.validateBoundaryRunJson) return;

    const expected = canonicalJson(validManifest());
    expect(api.canonicalizeBoundaryRun(validManifest())).toBe(expected);
    expect(api.validateBoundaryRunJson(Buffer.from(expected))).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });

  it('validates helper-derived completion records and the pinned conflict exception as closed wire objects', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryStructuredRecord?: (
        schema: 'ReadinessRecord' | 'ConsumerVersionDecision' | 'FeedbackMeasurements' | 'DocsLineageReport' | 'MergeConflictResolutionReport',
        value: Record<string, unknown>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryStructuredRecord).toBe('function');
    if (!api.validateBoundaryStructuredRecord) return;
    const readiness = {
      schemaVersion: 1,
      runId: 'reconciliation-run',
      taskId: 'BCF-00',
      profileId: 'bcf00-reconciliation',
      head: OID,
      snapshotDigestSha256: SHA,
      readinessState: 'Ready with Constraints',
      evaluatedAtUtc: TIME,
      evidence: [{
        evidenceId: 'predecessor-branch-gate',
        artifactPath: 'attempts/predecessor-branch-gate/stdout.log',
        producerAttemptId: 'predecessor-branch-gate',
        sha256: SHA,
        verdict: 'Pass',
      }],
      assumptions: [
        { assumptionId: 'A-08', disposition: 'validated', evidenceRefs: ['predecessor-branch-gate'] },
        { assumptionId: 'A-09', disposition: 'validated', evidenceRefs: ['predecessor-branch-gate'] },
        { assumptionId: 'A-10', disposition: 'validated', evidenceRefs: ['predecessor-branch-gate'] },
      ],
      risks: [{
        riskId: 'later-checkpoints', owner: 'implementation-lead', checkpoint: 'before-dependent-task',
        artifactPath: 'attempts/predecessor-branch-gate/stdout.log', artifactSha256: SHA,
        stopCondition: 'stop when the bound evidence changes',
      }],
      blockers: [],
      decisionRationale: 'All due assumptions passed; later checkpoints remain constrained.',
      decisionAuthority: 'implementation-lead',
      nextAllowedAction: 'BCF-01',
      overallVerdict: 'Pass',
    };
    expect(api.validateBoundaryStructuredRecord('ReadinessRecord', readiness)).toMatchObject({
      ok: true, exitCode: 0, verdict: 'Pass',
    });
    expect(api.validateBoundaryStructuredRecord('ReadinessRecord', { ...readiness, callerSelected: true }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'structured-record-shape' })]));

    const conflictReport = {
      schemaVersion: 1,
      policy: 'regenerate-generated-work-index',
      beforeHead: OID,
      expectedSecondParent: BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
      conflictPaths: ['docs/work-index.json', 'docs/work-index.md'],
      indexStages: [
        { path: 'docs/work-index.json', stage: 1, mode: '100644', oid: OID },
        { path: 'docs/work-index.json', stage: 2, mode: '100644', oid: OID_C },
        { path: 'docs/work-index.json', stage: 3, mode: '100644', oid: OID_D },
        { path: 'docs/work-index.md', stage: 1, mode: '100644', oid: OID },
        { path: 'docs/work-index.md', stage: 2, mode: '100644', oid: OID_C },
        { path: 'docs/work-index.md', stage: 3, mode: '100644', oid: OID_D },
      ],
      generatorArgv: ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen'],
      generatorRawExit: 0,
      generatorRawSignal: null,
      resolvedPaths: ['docs/work-index.json', 'docs/work-index.md'],
      unmergedPaths: [],
      conflictMarkerPaths: [],
      diffCheckRawExit: 0,
      diffCheckRawSignal: null,
      workIndexGuardRawExit: 0,
      workIndexGuardRawSignal: null,
      preStateDigestSha256: SHA,
      resolvedStateDigestSha256: SHA_B,
      verdict: 'Pass',
    };
    expect(api.validateBoundaryStructuredRecord('MergeConflictResolutionReport', conflictReport)).toMatchObject({
      ok: true, exitCode: 0, verdict: 'Pass',
    });
    expect(api.validateBoundaryStructuredRecord('MergeConflictResolutionReport', {
      ...conflictReport,
      expectedSecondParent: OID_D,
    }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'merge-conflict-policy-mismatch' })]));

    const inventoryQuery = [
      'rg', '-n', 'buildBoundaryReceipt\\(|buildSemanticReceipt\\(|schemaVersion',
      'scripts', 'tests', 'docs', '--glob', '*.ts', '--glob', '*.md',
    ];
    const matchRef = 'scripts/receipt.ts:1:1:producer-call:buildBoundaryReceipt(';
    const consumerDecision = {
      schemaVersion: 1,
      runId: 'receipt-run', taskId: 'BCF-04', profileId: 'bcf04-receipt', head: OID,
      snapshotDigestSha256: SHA, packageVersion: '0.1.0', currentProducerSchema: 1,
      proposedProducerSchema: 2, supportStage: 'beta-shadow-only',
      inventoryQuerySha256: canonicalSha(inventoryQuery),
      inventoryMatches: [{
        path: 'scripts/receipt.ts', line: 1, column: 1, matchKind: 'producer-call',
        matchedToken: 'buildBoundaryReceipt(', lineSha256: SHA,
      }],
      localConsumers: [{
        consumerId: 'consumer-0001', kind: 'producer', path: 'scripts/receipt.ts',
        symbol: 'buildBoundaryReceipt', schemaSupport: 'schema-1', matchRefs: [matchRef],
      }],
      externalConsumers: 'unknown', compatibilityReader: 'schema-1-read-render', rollbackCommit: OID_C,
      decision: 'pre-1.0-shadow-compatible', releaseNoteRequired: false,
      limitations: ['external-consumers-unknown'], overallVerdict: 'Pass',
    };
    expect(api.validateBoundaryStructuredRecord('ConsumerVersionDecision', consumerDecision)).toMatchObject({
      ok: true, verdict: 'Pass',
    });

    const budgets = {
      maxFindings: 128, maxObservedPerFinding: 64, maxArtifactsPerFinding: 16,
      maxLimitationsPerFinding: 8, maxTopLevelLimitations: 16, maxFingerprints: 64,
      maxCanonicalRecords: 2_048, maxCorrectionsPerFinding: 4, maxVerificationPerFinding: 8,
      maxSourcesPerFinding: 16, maxPublicTextBytes: 512, maxJsonBytes: 1024 * 1024,
      maxHumanBytes: 64 * 1024, maxHumanReservedSummaryBytes: 16 * 1024,
      maxHumanDetailedFindings: 12,
    };
    const scenario = (
      ordinal: number,
      name: string,
      subject: string,
      inputBytes: number,
      limitBytes: number,
      disposition: string,
    ) => ({
      ordinal, scenario: name, subject, inputBytes, limitBytes,
      humanBytes: Math.min(inputBytes, budgets.maxHumanBytes),
      jsonBytes: Math.min(inputBytes, budgets.maxJsonBytes), detailedFindings: 1,
      omittedFindings: 0, renderedObservations: 1, omittedObservations: 0,
      evidenceDigestSha256: SHA, descriptorDigestSha256: SHA_B,
      expectedDisposition: disposition, observedDisposition: disposition,
    });
    const measurements = {
      schemaVersion: 1, runId: 'feedback-run', taskId: 'BCF-05', profileId: 'bcf05-feedback',
      producerAttemptId: 'feedback-green', head: OID, snapshotDigestSha256: SHA,
      tokenSha256: SHA_B, budgets,
      scenarios: [
        scenario(1, 'ordinary', 'aggregate', 1, budgets.maxHumanBytes, 'accepted'),
        scenario(2, 'human-at-limit', 'public-text', budgets.maxHumanBytes, budgets.maxHumanBytes, 'accepted'),
        scenario(3, 'human-one-over', 'public-text', budgets.maxHumanBytes + 1, budgets.maxHumanBytes, 'diagnostic-inconclusive'),
        scenario(4, 'json-at-limit', 'canonical-json', budgets.maxJsonBytes, budgets.maxJsonBytes, 'accepted'),
        scenario(5, 'json-one-over', 'canonical-json', budgets.maxJsonBytes + 1, budgets.maxJsonBytes, 'diagnostic-inconclusive'),
        scenario(6, 'multibyte', 'utf8-text', 2, budgets.maxPublicTextBytes, 'accepted'),
      ],
      overallVerdict: 'Pass',
    };
    expect(api.validateBoundaryStructuredRecord('FeedbackMeasurements', measurements)).toMatchObject({
      ok: true, verdict: 'Pass',
    });
    const oneByteWrong = structuredClone(measurements);
    oneByteWrong.scenarios[2]!.inputBytes -= 1;
    expect(api.validateBoundaryStructuredRecord('FeedbackMeasurements', oneByteWrong).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'feedback-budget-invalid' })]));
  });

  it('[BCF00-U02] rejects non-closed commands and operational IDs before mutation', () => {
    const api = boundaryCli as unknown as {
      parseBoundaryRunInvocation?: (argv: readonly string[]) => unknown;
    };
    expect(typeof api.parseBoundaryRunInvocation).toBe('function');
    if (!api.parseBoundaryRunInvocation) return;

    const invalidInvocations = [
      ['unknown-command'],
      ['init', '--run-dir', '/tmp/run', '--task', 'BCF-00'],
      ['init', '--run-dir', '/tmp/run', '--task', 'BCF-00', '--profile', 'bcf00-observation', '--task', 'BCF-01'],
      ['record-command', '--run-dir', '/tmp/run', '--attempt', 'upstream-root'],
      ['record-command', '--run-dir', '/tmp/run', '--attempt', 'upstream-root', '--unknown-helper-option', 'value', '--', 'git', 'status'],
      ['record-git-transition', '--run-dir', '/tmp/run', '--attempt', 'merge-transition', '--kind', 'merge', '--expect-before', OID],
      ['verify-closeout', '--run-dir', '/tmp/run', '--failure-receipt-dir', '/tmp/failure'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'valid-id', '--unknown', 'value'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--run-dir', '/tmp/other', '--attempt', 'valid-id'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'bad/id'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'bad\nid'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'Bad'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', `a${'b'.repeat(64)}`],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'duplicate', '--attempt', 'duplicate'],
    ];

    for (const argv of invalidInvocations) {
      expect(() => api.parseBoundaryRunInvocation!(argv), argv.join(' ')).toThrow(/semantic\.invocation-invalid/);
    }
  });

  it('[BCF00-N02] accepts one exact command with canonical unique IDs', () => {
    const api = boundaryCli as unknown as {
      parseBoundaryRunInvocation?: (argv: readonly string[]) => unknown;
    };
    expect(typeof api.parseBoundaryRunInvocation).toBe('function');
    if (!api.parseBoundaryRunInvocation) return;

    expect(api.parseBoundaryRunInvocation([
      'record-internal-check',
      '--run-dir',
      '/tmp/bcf/observation/valid-run',
      '--attempt',
      'readiness-check',
    ])).toEqual({
      command: 'record-internal-check',
      options: {
        attempt: 'readiness-check',
        runDir: '/tmp/bcf/observation/valid-run',
      },
    });
    expect(api.parseBoundaryRunInvocation([
      'init', '--run-dir', '/tmp/bcf/observation/valid-run', '--task', 'BCF-00',
      '--profile', 'bcf00-observation', '--preserve-owner-path', 'owner.tsv',
      '--allow-untracked', 'scratch/result.json', '--allow-untracked', 'scratch/second.json',
    ])).toEqual({
      command: 'init',
      options: {
        allowUntracked: ['scratch/result.json', 'scratch/second.json'],
        preserveOwnerPath: ['owner.tsv'],
        profile: 'bcf00-observation',
        runDir: '/tmp/bcf/observation/valid-run',
        task: 'BCF-00',
      },
    });
    expect(api.parseBoundaryRunInvocation([
      'record-command', '--run-dir', '/tmp/bcf/observation/valid-run', '--attempt', 'upstream-root',
      '--expect-exit', '0', '--', 'git', 'rev-parse', '--show-toplevel',
    ])).toEqual({
      command: 'record-command',
      commandArgv: ['git', 'rev-parse', '--show-toplevel'],
      options: {
        attempt: 'upstream-root',
        expectExit: '0',
        runDir: '/tmp/bcf/observation/valid-run',
      },
    });
  });

  it('initializes one canonical active observation manifest and verifies it read-only', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const argv = [
      'init', '--run-dir', fixture.runDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ];
    const initialized = await api.runBoundaryRunCli(argv, fixture.repo);
    expect(initialized, JSON.stringify(initialized)).toMatchObject({ ok: true, exitCode: 0 });
    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const bytes = readFileSync(manifestPath);
    expect(boundaryRun.validateBoundaryRunJson(bytes)).toMatchObject({ ok: true, exitCode: 0 });
    const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      manifestState: 'active',
      run: {
        runId: 'cli-run',
        taskId: 'BCF-00',
        profileId: 'bcf00-observation',
        requiredAttemptIds: [...EXPECTED_PROFILE_ROWS['bcf00-observation'][8].split(',')],
        requiredChildAliases: [],
        requiredChildPins: [],
      },
      lifecycle: { status: 'active', finalGate: 'not-run' },
      overallVerdict: 'Inconclusive',
    });
    const verify = await api.runBoundaryRunCli(['verify', '--run-dir', fixture.runDir], fixture.repo);
    expect(verify).toMatchObject({ ok: true, exitCode: 0, verdict: 'Inconclusive' });
    expect(await api.runBoundaryRunCli(argv, fixture.repo)).toMatchObject({ ok: false, exitCode: 2 });
    const extraPinRunDir = path.join(path.dirname(fixture.runDir), 'extra-pin-run');
    const extraPin = await api.runBoundaryRunCli([
      'init', '--run-dir', extraPinRunDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--child-pin', `upstream-observation,${OID},observation-run,${SHA}`,
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo);
    expect(extraPin).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(existsSync(extraPinRunDir)).toBe(false);
  });

  it('routes closeout operations to fail-closed profile and receipt verification contracts', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', fixture.runDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });
    const forbidden = await api.runBoundaryRunCli([
      'closeout', '--run-dir', fixture.runDir, '--attempt-id', 'closeout-one',
    ], fixture.repo);
    expect(forbidden).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(forbidden.issues.map((entry) => entry.code)).toContain('closeout-profile-forbidden');
    const missing = await api.runBoundaryRunCli([
      'verify-closeout', '--run-dir', fixture.runDir,
    ], fixture.repo);
    expect(missing).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(missing.issues.map((entry) => entry.code)).toContain('verify-closeout-failed');
  });

  it('initializes a non-observation run only from one verified pinned predecessor closure', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const predecessorRunDir = path.join(fixture.repo, 'evidence/observation/predecessor-run');
    const predecessor = await finalizeSyntheticObservation(fixture.repo, predecessorRunDir, api.runBoundaryRunCli);
    const pin = [
      'BCF-00', 'bcf00-observation', 'predecessor-run', predecessor.terminalHead,
      predecessor.manifestSha256, predecessor.completionReceiptSha256, predecessor.ledgerSha256,
    ].join(',');
    const childPin = `upstream-observation,${predecessor.terminalHead},predecessor-run,${predecessor.manifestSha256}`;

    const badRunDir = path.join(fixture.repo, 'evidence/reconciliation/bad-parent');
    const badPin = pin.replace(predecessor.manifestSha256, SHA);
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', badRunDir, '--task', 'BCF-00', '--profile', 'bcf00-reconciliation',
      '--predecessor-run-dir', predecessorRunDir, '--predecessor-pin', badPin,
      '--child-pin', childPin, '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(existsSync(badRunDir)).toBe(false);

    const parentRunDir = path.join(fixture.repo, 'evidence/reconciliation/parent-run');
    const initialized = await api.runBoundaryRunCli([
      'init', '--run-dir', parentRunDir, '--task', 'BCF-00', '--profile', 'bcf00-reconciliation',
      '--predecessor-run-dir', predecessorRunDir, '--predecessor-pin', pin,
      '--child-pin', childPin, '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo);
    expect(initialized, JSON.stringify(initialized)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const manifest = JSON.parse(readFileSync(path.join(parentRunDir, 'run_manifest.json'), 'utf8')) as {
      predecessor: { pin: { runId: string }; importedFiles: Array<{ path: string }>; treeDigestSha256: string };
    };
    expect(manifest.predecessor.pin.runId).toBe('predecessor-run');
    expect(manifest.predecessor.importedFiles.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'run_init.json', 'run_init.sha256', 'run_manifest.json', 'run_manifest.sha256',
      'completion/chain_ledger.json', 'completion/chain_ledger.sha256',
      'completion/completion_receipt.json', 'completion/completion_receipt.sha256',
    ]));
    expect(manifest.predecessor.treeDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await api.runBoundaryRunCli(['verify', '--run-dir', parentRunDir], fixture.repo)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Inconclusive',
    });
    writeFileSync(path.join(parentRunDir, 'predecessor/completion/chain_ledger.json'), '{"mutated":true}\n');
    const mutated = await api.runBoundaryRunCli(['verify', '--run-dir', parentRunDir], fixture.repo);
    expect(mutated).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(mutated.issues.map((entry) => entry.code)).toContain('predecessor-import-mutation');
  });

  it('imports one finalized child only through its frozen profile pin and detects copied-byte drift', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const childRunDir = path.join(fixture.repo, 'evidence/observation/child-run');
    const childIdentity = await finalizeSyntheticObservation(fixture.repo, childRunDir, api.runBoundaryRunCli);

    const parentRunDir = path.join(fixture.repo, 'evidence/observation/parent-run');
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', parentRunDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });
    const parentManifestPath = path.join(parentRunDir, 'run_manifest.json');
    const parent = JSON.parse(readFileSync(parentManifestPath, 'utf8')) as Record<string, unknown>;
    const parentRun = parent['run'] as Record<string, unknown>;
    parentRun['profileId'] = 'bcf00-reconciliation';
    parentRun['phase'] = 'reconciliation';
    parentRun['requiredAttemptIds'] = [...boundaryRun.RUN_CONTRACT_PROFILES['bcf00-reconciliation'].requiredAttemptIds];
    parentRun['requiredChildAliases'] = ['upstream-observation'];
    parentRun['requiredChildPins'] = [{
      alias: 'upstream-observation',
      head: childIdentity.terminalHead,
      runId: 'child-run',
      manifestSha256: childIdentity.manifestSha256,
    }];
    parentRun['mayComplete'] = true;
    parentRun['chainAppend'] = true;
    const predecessorFiles = [{
      path: 'run_manifest.json',
      sha256: childIdentity.manifestSha256,
      bytes: readFileSync(path.join(childRunDir, 'run_manifest.json')).byteLength,
    }];
    parent['predecessor'] = {
      pin: {
        taskId: 'BCF-00',
        profileId: 'bcf00-observation',
        runId: 'child-run',
        terminalHead: childIdentity.terminalHead,
        manifestSha256: childIdentity.manifestSha256,
        completionReceiptSha256: childIdentity.completionReceiptSha256,
        ledgerSha256: childIdentity.ledgerSha256,
      },
      sourceManifestSha256: childIdentity.manifestSha256,
      importedFiles: predecessorFiles,
      treeDigestSha256: canonicalSha(predecessorFiles),
      overallVerdict: 'Pass',
    };
    writeFileSync(parentManifestPath, boundaryRun.canonicalizeBoundaryRun(parent));
    writeSyntheticRunInitAnchor(parentRunDir, parent);
    expect(boundaryRun.validateBoundaryRunJson(readFileSync(parentManifestPath))).toMatchObject({ ok: true, exitCode: 0 });

    const originalParentBytes = readFileSync(parentManifestPath);
    const alternateRunDir = path.join(fixture.repo, 'evidence/observation/alternate-run');
    const alternate = await finalizeSyntheticObservation(fixture.repo, alternateRunDir, api.runBoundaryRunCli);
    const substituted = structuredClone(parent) as Record<string, unknown>;
    const substitutedRun = substituted['run'] as Record<string, unknown>;
    substitutedRun['requiredChildPins'] = [{
      alias: 'upstream-observation',
      head: alternate.terminalHead,
      runId: 'alternate-run',
      manifestSha256: alternate.manifestSha256,
    }];
    const substitutedPredecessor = substituted['predecessor'] as Record<string, unknown>;
    const substitutedPredecessorFiles = [{
      path: 'run_manifest.json',
      sha256: alternate.manifestSha256,
      bytes: readFileSync(path.join(alternateRunDir, 'run_manifest.json')).byteLength,
    }];
    substitutedPredecessor['pin'] = {
      taskId: 'BCF-00',
      profileId: 'bcf00-observation',
      runId: 'alternate-run',
      terminalHead: alternate.terminalHead,
      manifestSha256: alternate.manifestSha256,
      completionReceiptSha256: alternate.completionReceiptSha256,
      ledgerSha256: alternate.ledgerSha256,
    };
    substitutedPredecessor['sourceManifestSha256'] = alternate.manifestSha256;
    substitutedPredecessor['importedFiles'] = substitutedPredecessorFiles;
    substitutedPredecessor['treeDigestSha256'] = canonicalSha(substitutedPredecessorFiles);
    writeFileSync(parentManifestPath, boundaryRun.canonicalizeBoundaryRun(substituted));
    const consistentSubstitution = await api.runBoundaryRunCli([
      'record-child-run', '--run-dir', parentRunDir, '--alias', 'upstream-observation',
      '--kind', 'observation', '--child-run-dir', alternateRunDir, '--expect-task', 'BCF-00',
      '--expect-head', alternate.terminalHead, '--expect-run-id', 'alternate-run',
      '--expect-manifest-sha256', alternate.manifestSha256,
    ], fixture.repo);
    expect(consistentSubstitution).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(consistentSubstitution.issues.map((entry) => entry.code)).toContain('init-anchor-mismatch');
    expect(existsSync(path.join(parentRunDir, 'children/upstream-observation'))).toBe(false);
    writeFileSync(parentManifestPath, originalParentBytes);

    const wrongDigest = await api.runBoundaryRunCli([
      'record-child-run', '--run-dir', parentRunDir, '--alias', 'upstream-observation',
      '--kind', 'observation', '--child-run-dir', childRunDir, '--expect-task', 'BCF-00',
      '--expect-head', childIdentity.terminalHead, '--expect-run-id', 'child-run',
      '--expect-manifest-sha256', SHA,
    ], fixture.repo);
    expect(wrongDigest).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(existsSync(path.join(parentRunDir, 'children/upstream-observation'))).toBe(false);

    const imported = await api.runBoundaryRunCli([
      'record-child-run', '--run-dir', parentRunDir, '--alias', 'upstream-observation',
      '--kind', 'observation', '--child-run-dir', childRunDir, '--expect-task', 'BCF-00',
      '--expect-head', childIdentity.terminalHead, '--expect-run-id', 'child-run',
      '--expect-manifest-sha256', childIdentity.manifestSha256,
    ], fixture.repo);
    expect(imported, JSON.stringify(imported)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const advanced = JSON.parse(readFileSync(parentManifestPath, 'utf8')) as {
      children: Array<{ alias: string; importedFiles: Array<{ path: string }> }>;
    };
    expect(advanced.children).toHaveLength(1);
    expect(advanced.children[0]).toMatchObject({ alias: 'upstream-observation' });
    expect(advanced.children[0]!.importedFiles.map((entry) => entry.path)).toContain('run_manifest.sha256');
    expect(await api.runBoundaryRunCli([
      'record-child-run', '--run-dir', parentRunDir, '--alias', 'upstream-observation',
      '--kind', 'observation', '--child-run-dir', childRunDir, '--expect-task', 'BCF-00',
      '--expect-head', childIdentity.terminalHead, '--expect-run-id', 'child-run',
      '--expect-manifest-sha256', childIdentity.manifestSha256,
    ], fixture.repo)).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });

    writeFileSync(path.join(parentRunDir, 'children/upstream-observation/run_manifest.json'), '{"mutated":true}\n');
    const drifted = await api.runBoundaryRunCli(['verify', '--run-dir', parentRunDir], fixture.repo);
    expect(drifted).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(drifted.issues.map((entry) => entry.code)).toContain('child-import-mutation');
  });

  it('records one canonical source review under the profile-owned alias and evidence closure', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', fixture.runDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });

    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReturnType<typeof validManifest>;
    const profile = boundaryRun.RUN_CONTRACT_PROFILES['bcf-review-contract'];
    manifest.run.taskId = profile.taskId;
    manifest.run.profileId = profile.profileId;
    manifest.run.phase = profile.phase;
    manifest.run.requiredAttemptIds = [...profile.requiredAttemptIds];
    manifest.run.requiredChildAliases = [];
    manifest.run.requiredChildPins = [];
    manifest.run.mayComplete = profile.mayComplete;
    manifest.run.chainAppend = profile.chainAppend;
    manifest.run.requestedTools = [];
    manifest.run.observedTools = [];
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(manifest));
    const initBytes = boundaryRun.canonicalizeBoundaryRun(boundaryRun.createBoundaryRunInitAnchor(manifest));
    writeFileSync(path.join(fixture.runDir, 'run_init.json'), initBytes);
    writeFileSync(
      path.join(fixture.runDir, 'run_init.sha256'),
      `${createHash('sha256').update(initBytes).digest('hex')}  run_init.json\n`,
    );

    const reviewRoot = path.join(fixture.runDir, 'reviews/review-one');
    mkdirSync(reviewRoot, { recursive: true });
    const evidence = [
      ['report.json', '{"summary":"bounded"}\n'],
      ['meta.json', '{"head":"review"}\n'],
      ['stderr.log', ''],
      ['finding-note.json', '{"safe":true}\n'],
    ] as const;
    for (const [name, content] of evidence) writeFileSync(path.join(reviewRoot, name), content);
    const reviewInput = {
      schemaVersion: 1,
      reviewId: 'review-one',
      dedupeKey: 'contract-cli-review',
      head: manifest.run.entryHead,
      snapshotDigestSha256: manifest.entrySnapshot.digestSha256,
      reportPath: 'reviews/review-one/report.json',
      reportSha256: fileSha(path.join(reviewRoot, 'report.json')),
      metaPath: 'reviews/review-one/meta.json',
      metaSha256: fileSha(path.join(reviewRoot, 'meta.json')),
      stderrPath: 'reviews/review-one/stderr.log',
      stderrSha256: fileSha(path.join(reviewRoot, 'stderr.log')),
      findings: [{
        ...validFinding(),
        evidencePath: 'reviews/review-one/finding-note.json',
        evidenceSha256: fileSha(path.join(reviewRoot, 'finding-note.json')),
      }],
      reproductionContracts: [],
    };
    const reviewPath = 'reviews/review-one/input.json';
    writeFileSync(path.join(fixture.runDir, reviewPath), boundaryRun.canonicalizeBoundaryRun(reviewInput));

    const wrongAlias = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-redaction', '--review-path', reviewPath,
    ], fixture.repo);
    expect(wrongAlias).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect((JSON.parse(readFileSync(manifestPath, 'utf8')) as { reviews: unknown[] }).reviews).toEqual([]);

    const recorded = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-contract', '--review-path', reviewPath,
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as { reviews: Array<Record<string, unknown>> };
    const { schemaVersion: _schemaVersion, ...reviewRecord } = reviewInput;
    expect(after.reviews).toEqual([{ alias: 'review-contract', ...reviewRecord }]);
    expect(await api.runBoundaryRunCli([
      'record-internal-check', '--run-dir', fixture.runDir, '--attempt', 'review-schema-check',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(await api.runBoundaryRunCli([
      'record-internal-check', '--run-dir', fixture.runDir, '--attempt', 'review-scope-check',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  });

  it('records one bounded generic reproduction command only in the reproduction profile', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', fixture.runDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });
    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReturnType<typeof validManifest>;
    const profile = boundaryRun.RUN_CONTRACT_PROFILES['bcf-reproduction'];
    const bashTool = manifest.run.observedTools.find((entry) => entry.name === 'bash');
    expect(bashTool).toBeDefined();
    manifest.run.taskId = profile.taskId;
    manifest.run.profileId = profile.profileId;
    manifest.run.phase = profile.phase;
    manifest.run.requiredAttemptIds = [...profile.requiredAttemptIds];
    manifest.run.requiredChildAliases = [];
    manifest.run.requiredChildPins = [];
    manifest.run.mayComplete = profile.mayComplete;
    manifest.run.chainAppend = profile.chainAppend;
    manifest.run.requestedTools = ['bash'];
    manifest.run.observedTools = [bashTool!];
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(manifest));
    const initBytes = boundaryRun.canonicalizeBoundaryRun(boundaryRun.createBoundaryRunInitAnchor(manifest));
    writeFileSync(path.join(fixture.runDir, 'run_init.json'), initBytes);
    writeFileSync(
      path.join(fixture.runDir, 'run_init.sha256'),
      `${createHash('sha256').update(initBytes).digest('hex')}  run_init.json\n`,
    );

    const wrongOutput = await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'finding-repro',
      '--expect-exit', 'nonzero', '--output-path', 'outputs/forbidden.json', '--',
      'bash', '-c', 'exit 7',
    ], fixture.repo);
    expect(wrongOutput).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(existsSync(path.join(fixture.runDir, 'attempts/finding-repro'))).toBe(false);

    const recorded = await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'finding-repro',
      '--expect-exit', 'nonzero', '--', 'bash', '-c', 'exit 7',
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as { attempts: Array<Record<string, unknown>> };
    expect(after.attempts).toContainEqual(expect.objectContaining({
      id: 'finding-repro', operation: 'command', argv: ['bash', '-c', 'exit 7'],
      expectedExit: 'nonzero', rawExit: 7, rawSignal: null, expectationMet: true,
      watchdogOwner: 'helper-watchdog', innerTimeoutOwner: null,
      deadlineMs: 900_000, killGraceMs: 30_000, declaredOutputs: [], verdict: 'Pass',
    }));
  });

  it('binds one imported source review to its exact lead reproduction proof in parent mode', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', fixture.runDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });
    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    const parent = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReturnType<typeof validManifest>;
    const emptySha = createHash('sha256').update('').digest('hex');
    const contentSha = (content: string): string => createHash('sha256').update(content).digest('hex');

    const report = '{"summary":"unsafe case reproduced"}\n';
    const meta = '{"review":"contract"}\n';
    const evidence = '{"finding":"major"}\n';
    const review: boundaryRun.BoundaryReviewRecord = {
      reviewId: 'review-parent-one',
      alias: 'review-contract',
      dedupeKey: 'contract-cli-review',
      head: parent.run.entryHead,
      snapshotDigestSha256: parent.entrySnapshot.digestSha256,
      reportPath: 'reviews/review-parent-one/report.json',
      reportSha256: contentSha(report),
      metaPath: 'reviews/review-parent-one/meta.json',
      metaSha256: contentSha(meta),
      stderrPath: 'reviews/review-parent-one/stderr.log',
      stderrSha256: emptySha,
      findings: [{
        findingId: 'finding-parent-one',
        severity: 'major',
        requiresFix: true,
        requiresReproduction: true,
        evidencePath: 'reviews/review-parent-one/finding.json',
        evidenceSha256: contentSha(evidence),
        disposition: 'accepted',
        resolution: 'open',
        reason: null,
        counterevidenceRefs: [],
        reproductionAttemptIds: ['finding-repro'],
        counterReproductionAttemptIds: [],
        fixedAtHead: null,
        fixReproductionAttemptIds: [],
        fixReviewId: null,
      }],
      reproductionContracts: [{
        attemptId: 'finding-repro',
        argv: ['bash', '-c', 'exit 7'],
        expectedExit: 'nonzero',
        toolName: 'bash',
        deadlineMs: 900_000,
        killGraceMs: 30_000,
      }],
    };
    const reviewChild = structuredClone(parent);
    const reviewProfile = boundaryRun.RUN_CONTRACT_PROFILES['bcf-review-contract'];
    Object.assign(reviewChild.run, {
      runId: 'review-child', taskId: reviewProfile.taskId, profileId: reviewProfile.profileId,
      phase: reviewProfile.phase, finalizedAtUtc: TIME, terminalHead: parent.run.entryHead,
      allowedPaths: [], requiredAttemptIds: [...reviewProfile.requiredAttemptIds],
      requiredChildAliases: [], requiredChildPins: [], transitionCount: 0,
      mayComplete: reviewProfile.mayComplete, chainAppend: reviewProfile.chainAppend,
      requestedTools: [], observedTools: [],
    });
    reviewChild.manifestState = 'finalized';
    reviewChild.attempts = [];
    reviewChild.artifacts = [];
    reviewChild.children = [];
    reviewChild.predecessor = null;
    reviewChild.reviews = [review];
    reviewChild.lifecycle = {
      status: 'completed', completionCommit: parent.run.entryHead, finalGate: 'pass', artifactSha256: null,
      successor: null, supersededBy: null, oracle: 'current', branchDeletionAuthorized: false,
    };
    reviewChild.overallVerdict = 'Pass';
    const reviewRoot = path.join(fixture.runDir, 'children/review-contract');
    const reviewInstalled = installImportedRun(reviewRoot, reviewChild, {
      [review.reportPath]: report,
      [review.metaPath]: meta,
      [review.stderrPath]: '',
      [review.findings[0]!.evidencePath]: evidence,
    });

    const reproductionChild = structuredClone(parent);
    const reproductionProfile = boundaryRun.RUN_CONTRACT_PROFILES['bcf-reproduction'];
    const bashTool = reproductionChild.run.observedTools.find((entry) => entry.name === 'bash');
    expect(bashTool).toBeDefined();
    Object.assign(reproductionChild.run, {
      runId: 'reproduction-child', taskId: reproductionProfile.taskId, profileId: reproductionProfile.profileId,
      phase: reproductionProfile.phase, finalizedAtUtc: TIME, terminalHead: parent.run.entryHead,
      allowedPaths: [], requiredAttemptIds: [...reproductionProfile.requiredAttemptIds],
      requiredChildAliases: [], requiredChildPins: [], transitionCount: 0,
      mayComplete: reproductionProfile.mayComplete, chainAppend: reproductionProfile.chainAppend,
      requestedTools: ['bash'], observedTools: [bashTool!],
    });
    reproductionChild.manifestState = 'finalized';
    reproductionChild.artifacts = [];
    reproductionChild.children = [];
    reproductionChild.predecessor = null;
    reproductionChild.reviews = [];
    reproductionChild.attempts = [{
      ...validAttempt(),
      id: 'finding-repro',
      operation: 'command',
      headAnchor: 'entry',
      argv: ['bash', '-c', 'true'],
      cwd: fixture.repo,
      expectedExit: 'nonzero',
      rawExit: 7,
      rawSignal: null,
      expectationMet: true,
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 900_000,
      killGraceMs: 30_000,
      preSnapshot: structuredClone(parent.entrySnapshot),
      postSnapshot: structuredClone(parent.entrySnapshot),
      stdout: { path: 'attempts/finding-repro/stdout.log', sha256: emptySha, bytes: 0 },
      stderr: { path: 'attempts/finding-repro/stderr.log', sha256: emptySha, bytes: 0 },
      declaredOutputs: [],
      outputAdmissions: [],
      structuredResult: null,
      verdict: 'Pass',
    }];
    reproductionChild.lifecycle = {
      status: 'completed', completionCommit: parent.run.entryHead, finalGate: 'pass', artifactSha256: null,
      successor: null, supersededBy: null, oracle: 'current', branchDeletionAuthorized: false,
    };
    reproductionChild.overallVerdict = 'Pass';
    const reproductionRoot = path.join(fixture.runDir, 'children/lead-reproduction');
    let reproductionInstalled = installImportedRun(reproductionRoot, reproductionChild, {
      'attempts/finding-repro/stdout.log': '',
      'attempts/finding-repro/stderr.log': '',
    });

    const parentProfile = boundaryRun.RUN_CONTRACT_PROFILES['bcf08a-docs'];
    Object.assign(parent.run, {
      taskId: parentProfile.taskId, profileId: parentProfile.profileId, phase: parentProfile.phase,
      allowedPaths: [...parentProfile.allowedPaths], requiredAttemptIds: [...parentProfile.requiredAttemptIds],
      requiredChildAliases: parentProfile.requiredChildren.map((entry) => entry.split(':', 1)[0]!),
      transitionCount: 0, mayComplete: parentProfile.mayComplete, chainAppend: parentProfile.chainAppend,
    });
    const reviewChildRow = {
      alias: 'review-contract', kind: 'review' as const, taskId: 'BCF-REVIEW', profileId: 'bcf-review-contract',
      runId: 'review-child', entryHead: parent.run.entryHead, terminalHead: parent.run.entryHead,
      snapshotDigestSha256: parent.entrySnapshot.digestSha256,
      sourceManifestSha256: reviewInstalled.manifestSha256,
      importedFiles: reviewInstalled.importedFiles,
      treeDigestSha256: canonicalSha(reviewInstalled.importedFiles),
      overallVerdict: 'Pass' as const, dedupeKey: 'contract-cli-review',
    };
    const reproductionChildRow = {
      alias: 'lead-reproduction', kind: 'reproduction' as const, taskId: 'BCF-REPRODUCTION', profileId: 'bcf-reproduction',
      runId: 'reproduction-child', entryHead: parent.run.entryHead, terminalHead: parent.run.entryHead,
      snapshotDigestSha256: parent.entrySnapshot.digestSha256,
      sourceManifestSha256: reproductionInstalled.manifestSha256,
      importedFiles: reproductionInstalled.importedFiles,
      treeDigestSha256: canonicalSha(reproductionInstalled.importedFiles),
      overallVerdict: 'Pass' as const, dedupeKey: 'lead-reproduction',
    };
    parent.children = [reviewChildRow, reproductionChildRow];
    const pinFor = (alias: string): { alias: string; head: string; runId: string; manifestSha256: string } => {
      if (alias === 'review-contract') return {
        alias, head: parent.run.entryHead, runId: 'review-child', manifestSha256: reviewInstalled.manifestSha256,
      };
      if (alias === 'lead-reproduction') return {
        alias, head: parent.run.entryHead, runId: 'reproduction-child', manifestSha256: reproductionInstalled.manifestSha256,
      };
      return { alias, head: parent.run.entryHead, runId: `${alias}-child`, manifestSha256: SHA };
    };
    parent.run.requiredChildPins = parent.run.requiredChildAliases.map(pinFor);
    parent.reviews = [];
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(parent));
    const parentInitBytes = boundaryRun.canonicalizeBoundaryRun(boundaryRun.createBoundaryRunInitAnchor(parent));
    writeFileSync(path.join(fixture.runDir, 'run_init.json'), parentInitBytes);
    writeFileSync(
      path.join(fixture.runDir, 'run_init.sha256'),
      `${createHash('sha256').update(parentInitBytes).digest('hex')}  run_init.json\n`,
    );

    const wrongPath = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-contract',
      '--review-path', 'children/review-contract/run_init.json',
    ], fixture.repo);
    expect(wrongPath).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    const substitutedProof = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-contract',
      '--review-path', 'children/review-contract/run_manifest.json',
    ], fixture.repo);
    expect(substitutedProof).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(substitutedProof.issues.map((entry) => entry.code)).toContain('review-proof-contract-mismatch');

    reproductionChild.attempts[0]!.argv = ['bash', '-c', 'exit 7'];
    reproductionInstalled = installImportedRun(reproductionRoot, reproductionChild, {
      'attempts/finding-repro/stdout.log': '',
      'attempts/finding-repro/stderr.log': '',
    });
    reproductionChildRow.sourceManifestSha256 = reproductionInstalled.manifestSha256;
    reproductionChildRow.importedFiles = reproductionInstalled.importedFiles;
    reproductionChildRow.treeDigestSha256 = canonicalSha(reproductionInstalled.importedFiles);
    parent.run.requiredChildPins = parent.run.requiredChildAliases.map(pinFor);
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(parent));
    const correctedParentInitBytes = boundaryRun.canonicalizeBoundaryRun(boundaryRun.createBoundaryRunInitAnchor(parent));
    writeFileSync(path.join(fixture.runDir, 'run_init.json'), correctedParentInitBytes);
    writeFileSync(
      path.join(fixture.runDir, 'run_init.sha256'),
      `${createHash('sha256').update(correctedParentInitBytes).digest('hex')}  run_init.json\n`,
    );
    const recorded = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-contract',
      '--review-path', 'children/review-contract/run_manifest.json',
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as { reviews: Array<Record<string, unknown>> };
    expect(after.reviews).toHaveLength(1);
    expect(after.reviews[0]).toMatchObject({
      reviewId: review.reviewId,
      alias: 'review-contract',
      dedupeKey: 'contract-cli-review',
      reportPath: `children/review-contract/${review.reportPath}`,
      findings: [{ evidencePath: `children/review-contract/${review.findings[0]!.evidencePath}` }],
      reproductionContracts: review.reproductionContracts,
    });
  });

  it('records one exact direct command with immutable streams and snapshots', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', fixture.runDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });
    const recorded = await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'upstream-root',
      '--expect-exit', '0', '--', 'git', 'rev-parse', '--show-toplevel',
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      attempts: Array<Record<string, unknown>>;
      currentSnapshot: Record<string, unknown>;
    };
    expect(manifest.attempts).toHaveLength(1);
    expect(manifest.attempts[0]).toMatchObject({
      id: 'upstream-root', operation: 'command', rawExit: 0, rawSignal: null,
      expectationMet: true, verdict: 'Pass',
    });
    const stdout = manifest.attempts[0]!['stdout'] as { path: string; sha256: string; bytes: number };
    expect(readFileSync(path.join(fixture.runDir, stdout.path), 'utf8').trim()).toBe(fixture.repo);
    expect(stdout.sha256).toBe(createHash('sha256').update(readFileSync(path.join(fixture.runDir, stdout.path))).digest('hex'));
    const headRecorded = await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'upstream-head',
      '--expect-exit', '0', '--', 'git', 'rev-parse', 'HEAD',
    ], fixture.repo);
    expect(headRecorded, JSON.stringify(headRecorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const advancedManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { attempts: Array<Record<string, unknown>> };
    expect(advancedManifest.attempts).toHaveLength(2);
    const headAttempt = advancedManifest.attempts.find((entry) => entry['id'] === 'upstream-head');
    expect(readFileSync(path.join(fixture.runDir, (headAttempt!['stdout'] as { path: string }).path), 'utf8').trim())
      .toBe(git(fixture.repo, ['rev-parse', 'HEAD']));
    expect(boundaryRun.validateBoundaryRunJson(readFileSync(manifestPath))).toMatchObject({ ok: true, exitCode: 0 });
    expect(await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'upstream-root',
      '--expect-exit', '0', '--', 'git', 'rev-parse', '--show-toplevel',
    ], fixture.repo)).toMatchObject({ ok: false, exitCode: 2 });
  });

  it('records one exact commit transition and rejects subject substitution or reuse', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', fixture.runDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });

    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const run = manifest['run'] as Record<string, unknown>;
    const profile = boundaryRun.RUN_CONTRACT_PROFILES['bcf01-parser'];
    run['taskId'] = profile.taskId;
    run['profileId'] = profile.profileId;
    run['phase'] = profile.phase;
    run['allowedPaths'] = [...profile.allowedPaths];
    run['requiredAttemptIds'] = [...profile.requiredAttemptIds];
    run['mayComplete'] = profile.mayComplete;
    run['chainAppend'] = profile.chainAppend;
    writeFileSync(path.join(fixture.repo, 'scripts/semantic-quality-check.ts'), 'export const fixture = false;\n');
    writeFileSync(path.join(fixture.repo, 'tests/scripts/semantic-quality-check.test.ts'), 'test changed fixture\n');
    git(fixture.repo, ['add', ...profile.allowedPaths]);
    const stagedSnapshot = boundaryRun.captureBoundaryWorktreeSnapshot(fixture.repo, {
      allowedUntrackedPaths: [],
      preservedOwnerPaths: ['owner.tsv'],
    });
    expect(stagedSnapshot).toMatchObject({ ok: true });
    expect(stagedSnapshot.snapshot).not.toBeNull();
    manifest['currentSnapshot'] = structuredClone(stagedSnapshot.snapshot);
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(manifest));
    writeSyntheticRunInitAnchor(fixture.runDir, manifest);

    const beforeHead = git(fixture.repo, ['rev-parse', 'HEAD']);
    const wrongSubject = await api.runBoundaryRunCli([
      'record-git-transition', '--run-dir', fixture.runDir, '--attempt', 'parser-commit-transition',
      '--kind', 'commit', '--expect-before', beforeHead, '--message-subject', 'fix(quality): substitute subject',
    ], fixture.repo);
    expect(wrongSubject).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(existsSync(path.join(fixture.runDir, 'attempts/parser-commit-transition'))).toBe(false);

    const recorded = await api.runBoundaryRunCli([
      'record-git-transition', '--run-dir', fixture.runDir, '--attempt', 'parser-commit-transition',
      '--kind', 'commit', '--expect-before', beforeHead,
      '--message-subject', 'fix(quality): fail closed on invalid semantic options',
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const afterHead = git(fixture.repo, ['rev-parse', 'HEAD']);
    expect(afterHead).not.toBe(beforeHead);
    expect(git(fixture.repo, ['show', '-s', '--format=%s', 'HEAD']))
      .toBe('fix(quality): fail closed on invalid semantic options');
    const advanced = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      run: { terminalHead: string; transitionCount: number };
      attempts: Array<Record<string, unknown>>;
    };
    expect(advanced.run).toMatchObject({ terminalHead: afterHead, transitionCount: 1 });
    expect(advanced.attempts).toHaveLength(1);
    expect(advanced.attempts[0]).toMatchObject({
      id: 'parser-commit-transition', operation: 'git-transition', rawExit: 0,
      rawSignal: null, expectationMet: true, verdict: 'Pass',
    });
    const structured = advanced.attempts[0]!['structuredResult'] as { path: string };
    expect(JSON.parse(readFileSync(path.join(fixture.runDir, structured.path), 'utf8'))).toMatchObject({
      kind: 'commit', beforeHead, afterHead, parents: [beforeHead],
      changedPaths: [...profile.allowedPaths],
    });
    expect(git(fixture.repo, ['diff', '--name-only', 'HEAD', '--', ...profile.allowedPaths])).toBe('');

    const reused = await api.runBoundaryRunCli([
      'record-git-transition', '--run-dir', fixture.runDir, '--attempt', 'parser-commit-transition',
      '--kind', 'commit', '--expect-before', beforeHead,
      '--message-subject', 'fix(quality): fail closed on invalid semantic options',
    ], fixture.repo);
    expect(reused).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(afterHead);
  });

  it('records one exact merge transition from its pinned observation evidence', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const localBranch = git(fixture.repo, ['branch', '--show-current']);
    const mergeBase = git(fixture.repo, ['rev-parse', 'HEAD']);
    git(fixture.repo, ['switch', '-c', 'upstream-success']);
    writeFileSync(path.join(fixture.repo, 'upstream.txt'), 'upstream\n');
    git(fixture.repo, ['add', 'upstream.txt']);
    git(fixture.repo, ['commit', '-m', 'upstream fixture']);
    const upstreamOid = git(fixture.repo, ['rev-parse', 'HEAD']);
    git(fixture.repo, ['switch', localBranch]);
    writeFileSync(path.join(fixture.repo, 'local.txt'), 'local\n');
    git(fixture.repo, ['add', 'local.txt']);
    git(fixture.repo, ['commit', '-m', 'local fixture']);
    const beforeHead = git(fixture.repo, ['rev-parse', 'HEAD']);

    const runDir = path.join(fixture.repo, 'evidence/reconciliation/merge-success');
    const observationRunDir = path.join(fixture.repo, 'evidence/observation/merge-success-observation');
    await initializeSyntheticReconciliation(fixture.repo, runDir, observationRunDir, api.runBoundaryRunCli, {
      observedOid: upstreamOid,
      mergeBase,
      remotePaths: ['upstream.txt'],
      localPaths: ['local.txt'],
    });
    const recorded = await api.runBoundaryRunCli([
      'record-git-transition', '--run-dir', runDir, '--attempt', 'merge-transition',
      '--kind', 'merge', '--expect-before', beforeHead, '--expect-second-parent', upstreamOid,
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const afterHead = git(fixture.repo, ['rev-parse', 'HEAD']);
    const parents = git(fixture.repo, ['rev-list', '--parents', '-n', '1', afterHead]).split(/\s+/).slice(1);
    expect(parents).toEqual([beforeHead, upstreamOid]);
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'run_manifest.json'), 'utf8')) as {
      run: { terminalHead: string; transitionCount: number; reconciledBase: string };
      upstream: { observedOid: string; mergeCommit: string; mergeParents: string[] };
      attempts: Array<Record<string, unknown>>;
    };
    expect(manifest.run).toMatchObject({ terminalHead: afterHead, transitionCount: 1, reconciledBase: afterHead });
    expect(manifest.upstream).toMatchObject({ observedOid: upstreamOid, mergeCommit: afterHead, mergeParents: parents });
    expect(manifest.attempts[0]).toMatchObject({
      id: 'merge-transition', operation: 'git-transition', expectationMet: true, verdict: 'Pass',
    });
    const structured = manifest.attempts[0]!['structuredResult'] as { path: string };
    expect(JSON.parse(readFileSync(path.join(runDir, structured.path), 'utf8'))).toMatchObject({
      kind: 'merge', beforeHead, afterHead, parents, changedPaths: ['upstream.txt'],
      conflictPaths: [], abortAttempted: false, abortRestored: null,
    });
  });

  it('captures a merge conflict, aborts it, and proves exact pre-state restoration', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const localBranch = git(fixture.repo, ['branch', '--show-current']);
    writeFileSync(path.join(fixture.repo, 'conflict.txt'), 'base\n');
    git(fixture.repo, ['add', 'conflict.txt']);
    git(fixture.repo, ['commit', '-m', 'conflict base']);
    const mergeBase = git(fixture.repo, ['rev-parse', 'HEAD']);
    git(fixture.repo, ['switch', '-c', 'upstream-conflict']);
    writeFileSync(path.join(fixture.repo, 'conflict.txt'), 'upstream\n');
    git(fixture.repo, ['add', 'conflict.txt']);
    git(fixture.repo, ['commit', '-m', 'upstream conflict']);
    const upstreamOid = git(fixture.repo, ['rev-parse', 'HEAD']);
    git(fixture.repo, ['switch', localBranch]);
    writeFileSync(path.join(fixture.repo, 'conflict.txt'), 'local\n');
    git(fixture.repo, ['add', 'conflict.txt']);
    git(fixture.repo, ['commit', '-m', 'local conflict']);
    const beforeHead = git(fixture.repo, ['rev-parse', 'HEAD']);

    const runDir = path.join(fixture.repo, 'evidence/reconciliation/merge-conflict');
    const observationRunDir = path.join(fixture.repo, 'evidence/observation/merge-conflict-observation');
    await initializeSyntheticReconciliation(fixture.repo, runDir, observationRunDir, api.runBoundaryRunCli, {
      observedOid: upstreamOid,
      mergeBase,
      remotePaths: ['conflict.txt'],
      localPaths: ['conflict.txt'],
    });
    const recorded = await api.runBoundaryRunCli([
      'record-git-transition', '--run-dir', runDir, '--attempt', 'merge-transition',
      '--kind', 'merge', '--expect-before', beforeHead, '--expect-second-parent', upstreamOid,
    ], fixture.repo);
    expect(recorded).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(existsSync(path.join(fixture.repo, '.git/MERGE_HEAD'))).toBe(false);
    expect(git(fixture.repo, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'run_manifest.json'), 'utf8')) as {
      run: { terminalHead: string | null; transitionCount: number };
      attempts: Array<Record<string, unknown>>;
    };
    expect(manifest.run).toMatchObject({ terminalHead: null, transitionCount: 0 });
    expect(manifest.attempts[0]).toMatchObject({
      id: 'merge-transition', rawExit: 1, rawSignal: null, expectationMet: false, verdict: 'Inconclusive',
    });
    const structured = manifest.attempts[0]!['structuredResult'] as { path: string };
    expect(JSON.parse(readFileSync(path.join(runDir, structured.path), 'utf8'))).toMatchObject({
      kind: 'merge', beforeHead, afterHead: beforeHead, parents: [], changedPaths: [],
      conflictPaths: ['conflict.txt'], abortAttempted: true, abortRestored: true,
    });
    expect(await api.runBoundaryRunCli(['verify', '--run-dir', runDir], fixture.repo)).toMatchObject({
      ok: true, exitCode: 0, verdict: 'Inconclusive',
    });
  });

  it('resolves only the pinned generated-index conflict with the profile-owned generator and guard', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const clone = realpathSync(mkdtempSync(path.join(tmpdir(), 'boundary-run-pinned-merge-')));
    fixtureRoots.push(clone);
    execFileSync('git', ['clone', '--shared', process.cwd(), clone], { stdio: 'ignore' });
    git(clone, ['config', 'user.name', 'WhatSoup Test']);
    git(clone, ['config', 'user.email', FIXTURE_EMAIL]);
    const pinnedMerge = git(clone, ['rev-list', '--first-parent', '--merges', 'HEAD'])
      .split('\n')
      .filter(Boolean)
      .find((commit) => {
        const parents = git(clone, ['show', '-s', '--format=%P', commit]).split(' ');
        return parents.length === 2 && parents[1] === BOUNDARY_PINNED_GENERATED_INDEX_PARENT;
      });
    if (pinnedMerge !== undefined) {
      const [historicalFirstParent] = git(clone, ['show', '-s', '--format=%P', pinnedMerge]).split(' ');
      git(clone, ['switch', '-c', 'pinned-conflict-base', historicalFirstParent!]);
    }
    const validatorPaths = [
      'scripts/lib/verification/boundary-run-manifest.ts',
      'scripts/verify-boundary-run.ts',
      'tests/scripts/verify-boundary-run.test.ts',
    ];
    if (!existsSync(path.join(clone, validatorPaths[0]!))) {
      for (const relativePath of validatorPaths) {
        mkdirSync(path.dirname(path.join(clone, relativePath)), { recursive: true });
        copyFileSync(path.join(process.cwd(), relativePath), path.join(clone, relativePath));
      }
      git(clone, ['add', ...validatorPaths]);
      git(clone, ['commit', '-m', 'feat(quality): add boundary run validator']);
    }
    const npmWrapper = path.join(clone, 'scripts/run-with-pinned-npm.sh');
    const npmWrapperReal = path.join(clone, 'scripts/run-with-pinned-npm-real.sh');
    copyFileSync(npmWrapper, npmWrapperReal);
    chmodSync(npmWrapperReal, 0o755);
    writeFileSync(
      npmWrapper,
      '#!/usr/bin/env bash\nset -euo pipefail\nif [ "${1:-}" = "exec" ]; then\n  root="$(pwd -P)"\n  first=1\n  printf "["\n  for value in "$@"; do\n    case "$value" in\n      tests/*.test.ts)\n        if [ -f "$value" ]; then\n          if [ "$first" -eq 0 ]; then printf ","; fi\n          first=0\n          printf "{\\"name\\":\\"fixture %s\\",\\"file\\":\\"%s/%s\\"}" "$value" "$root" "$value"\n        fi\n        ;;\n    esac\n  done\n  printf "]\\n"\n  exit 0\nfi\nexec "$(dirname "$0")/run-with-pinned-npm-real.sh" "$@"\n',
    );
    chmodSync(npmWrapper, 0o755);
    git(clone, ['add', 'scripts/run-with-pinned-npm.sh', 'scripts/run-with-pinned-npm-real.sh']);
    git(clone, ['commit', '-m', 'test: install bounded roster fixture']);
    const pinnedBin = path.join(process.env['HOME']!, '.nvm/versions/node/v24.15.0/bin');
    mkdirSync(pinnedBin, { recursive: true });
    for (const executable of ['node', 'npm']) {
      const destination = path.join(pinnedBin, executable);
      if (!existsSync(destination)) symlinkSync(path.join(path.dirname(process.execPath), executable), destination);
    }
    const pinnedParent = BOUNDARY_PINNED_GENERATED_INDEX_PARENT;
    git(clone, ['cat-file', '-e', `${pinnedParent}^{commit}`]);
    const beforeHead = git(clone, ['rev-parse', 'HEAD']);
    const mergeBase = git(clone, ['merge-base', beforeHead, pinnedParent]);
    const remotePaths = git(clone, ['diff', '--name-only', mergeBase, pinnedParent]).split('\n').filter(Boolean);
    const localPaths = git(clone, ['diff', '--name-only', mergeBase, beforeHead]).split('\n').filter(Boolean);
    let mergePreviewStdout = '';
    try {
      mergePreviewStdout = execFileSync('git', ['merge-tree', '--write-tree', beforeHead, pinnedParent], {
        cwd: clone,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      mergePreviewStdout = String((error as { stdout?: string | Buffer }).stdout ?? '');
    }
    expect(mergePreviewStdout).toContain('CONFLICT (content): Merge conflict in docs/work-index.json');
    expect(mergePreviewStdout).toContain('CONFLICT (content): Merge conflict in docs/work-index.md');
    writeFileSync(path.join(clone, 'owner.tsv'), 'owner\n');
    for (const phase of ['observation', 'reconciliation', 'completion']) {
      mkdirSync(path.join(clone, 'artifacts/verification/boundary-contract-feedback', phase), { recursive: true });
    }
    const runDir = path.join(clone, 'artifacts/verification/boundary-contract-feedback/reconciliation/pinned-merge');
    const observationRunDir = path.join(clone, 'artifacts/verification/boundary-contract-feedback/observation/pinned-observation');
    await initializeSyntheticReconciliation(clone, runDir, observationRunDir, api.runBoundaryRunCli, {
      observedOid: pinnedParent,
      mergeBase,
      remotePaths,
      localPaths,
      mergePreviewStdout,
    });
    const recorded = await api.runBoundaryRunCli([
      'record-git-transition', '--run-dir', runDir, '--attempt', 'merge-transition',
      '--kind', 'merge', '--expect-before', beforeHead, '--expect-second-parent', pinnedParent,
    ], clone);
    const transitionStdout = readFileSync(path.join(runDir, 'attempts/merge-transition/stdout.log'), 'utf8');
    const transitionStderr = readFileSync(path.join(runDir, 'attempts/merge-transition/stderr.log'), 'utf8');
    expect(recorded, JSON.stringify({ recorded, transitionStdout, transitionStderr })).toMatchObject({
      ok: true, exitCode: 0, verdict: 'Pass',
    });
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'run_manifest.json'), 'utf8')) as {
      attempts: Array<{ structuredResult: { path: string } }>;
    };
    const transition = JSON.parse(readFileSync(path.join(runDir, manifest.attempts[0]!.structuredResult.path), 'utf8')) as {
      parents: string[];
      conflictResolutionReport: Record<string, unknown>;
    };
    expect(transition.parents).toEqual([beforeHead, pinnedParent]);
    expect(transition.conflictResolutionReport).toMatchObject({
      policy: 'regenerate-generated-work-index',
      expectedSecondParent: pinnedParent,
      conflictPaths: ['docs/work-index.json', 'docs/work-index.md'],
      resolvedPaths: ['docs/work-index.json', 'docs/work-index.md'],
      unmergedPaths: [],
      conflictMarkerPaths: [],
      generatorRawExit: 0,
      diffCheckRawExit: 0,
      workIndexGuardRawExit: 0,
      verdict: 'Pass',
    });
  }, 120_000);

  it('derives readiness only after the terminal declaration and then promotes reconciliation to Pass', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const localBranch = git(fixture.repo, ['branch', '--show-current']);
    const mergeBase = git(fixture.repo, ['rev-parse', 'HEAD']);
    git(fixture.repo, ['switch', '-c', 'upstream-readiness']);
    writeFileSync(path.join(fixture.repo, 'upstream-readiness.txt'), 'upstream\n');
    git(fixture.repo, ['add', 'upstream-readiness.txt']);
    git(fixture.repo, ['commit', '-m', 'upstream readiness']);
    const upstreamOid = git(fixture.repo, ['rev-parse', 'HEAD']);
    git(fixture.repo, ['switch', localBranch]);
    writeFileSync(path.join(fixture.repo, 'local-readiness.txt'), 'local\n');
    git(fixture.repo, ['add', 'local-readiness.txt']);
    git(fixture.repo, ['commit', '-m', 'local readiness']);
    const beforeHead = git(fixture.repo, ['rev-parse', 'HEAD']);
    const runDir = path.join(fixture.repo, 'evidence/reconciliation/readiness-run');
    const observationRunDir = path.join(fixture.repo, 'evidence/observation/readiness-observation');
    await initializeSyntheticReconciliation(fixture.repo, runDir, observationRunDir, api.runBoundaryRunCli, {
      observedOid: upstreamOid,
      mergeBase,
      remotePaths: ['upstream-readiness.txt'],
      localPaths: ['local-readiness.txt'],
    });
    expect(await api.runBoundaryRunCli([
      'record-git-transition', '--run-dir', runDir, '--attempt', 'merge-transition',
      '--kind', 'merge', '--expect-before', beforeHead, '--expect-second-parent', upstreamOid,
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    fillSyntheticRequiredAttempts(fixture.repo, runDir, ['readiness-check']);
    expect(await api.runBoundaryRunCli([
      'set-lifecycle', '--run-dir', runDir, '--status', 'completed', '--final-gate', 'pass',
      '--oracle', 'current',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Inconclusive' });
    const readiness = await api.runBoundaryRunCli([
      'record-internal-check', '--run-dir', runDir, '--attempt', 'readiness-check',
    ], fixture.repo);
    expect(readiness, JSON.stringify(readiness)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'run_manifest.json'), 'utf8')) as {
      attempts: Array<{ id: string; structuredResult: { path: string } | null; verdict: string }>;
      artifacts: Array<{ path: string; producerAttemptId: string; role: string }>;
      overallVerdict: string;
    };
    const attempt = manifest.attempts.find((entry) => entry.id === 'readiness-check');
    expect(attempt).toMatchObject({ verdict: 'Pass', structuredResult: { path: 'readiness.json' } });
    expect(manifest.artifacts).toContainEqual(expect.objectContaining({
      path: 'readiness.json', producerAttemptId: 'readiness-check', role: 'receipt',
    }));
    expect(manifest.overallVerdict).toBe('Pass');
    expect(boundaryRun.validateBoundaryStructuredRecord(
      'ReadinessRecord',
      JSON.parse(readFileSync(path.join(runDir, 'readiness.json'), 'utf8')) as Record<string, unknown>,
    )).toMatchObject({ ok: true, verdict: 'Pass' });
  });

  it('finalizes reconciliation as the sole BCF-00 chain genesis and verifies its locked bundle', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const localBranch = git(fixture.repo, ['branch', '--show-current']);
    const mergeBase = git(fixture.repo, ['rev-parse', 'HEAD']);
    git(fixture.repo, ['switch', '-c', 'upstream-finalize']);
    writeFileSync(path.join(fixture.repo, 'upstream.txt'), 'upstream\n');
    git(fixture.repo, ['add', 'upstream.txt']);
    git(fixture.repo, ['commit', '-m', 'upstream fixture']);
    const upstreamOid = git(fixture.repo, ['rev-parse', 'HEAD']);
    git(fixture.repo, ['switch', localBranch]);
    writeFileSync(path.join(fixture.repo, 'local.txt'), 'local\n');
    git(fixture.repo, ['add', 'local.txt']);
    git(fixture.repo, ['commit', '-m', 'local fixture']);
    const beforeHead = git(fixture.repo, ['rev-parse', 'HEAD']);
    const runDir = path.join(fixture.repo, 'evidence/reconciliation/finalize-reconciliation');
    const observationRunDir = path.join(fixture.repo, 'evidence/observation/finalize-observation');
    await initializeSyntheticReconciliation(fixture.repo, runDir, observationRunDir, api.runBoundaryRunCli, {
      observedOid: upstreamOid,
      mergeBase,
      remotePaths: ['upstream.txt'],
      localPaths: ['local.txt'],
    });
    expect(await api.runBoundaryRunCli([
      'record-git-transition', '--run-dir', runDir, '--attempt', 'merge-transition',
      '--kind', 'merge', '--expect-before', beforeHead, '--expect-second-parent', upstreamOid,
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    fillSyntheticRequiredAttempts(fixture.repo, runDir);
    expect(await api.runBoundaryRunCli([
      'set-lifecycle', '--run-dir', runDir, '--status', 'completed', '--final-gate', 'pass',
      '--oracle', 'current',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const finalized = await api.runBoundaryRunCli(['finalize', '--run-dir', runDir], fixture.repo);
    expect(finalized, JSON.stringify(finalized)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(await api.runBoundaryRunCli(['verify', '--run-dir', runDir], fixture.repo)).toMatchObject({
      ok: true, exitCode: 0, verdict: 'Pass',
    });
    const manifestBytes = readFileSync(path.join(runDir, 'run_manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { run: { terminalHead: string; reconciledBase: string } };
    const completionDir = path.join(fixture.repo, 'evidence/completion/finalize-reconciliation');
    const ledger = JSON.parse(readFileSync(path.join(completionDir, 'chain_ledger.json'), 'utf8')) as {
      rows: Array<Record<string, unknown>>;
      reconciledBase: string;
      upstreamObservedOid: string;
    };
    const receipt = JSON.parse(readFileSync(path.join(completionDir, 'completion_receipt.json'), 'utf8')) as Record<string, unknown>;
    expect(ledger).toMatchObject({
      reconciledBase: manifest.run.reconciledBase,
      upstreamObservedOid: upstreamOid,
      rows: [{
        ordinal: 1,
        taskId: 'BCF-00',
        profileId: 'bcf00-reconciliation',
        runId: 'finalize-reconciliation',
        entryHead: beforeHead,
        terminalHead: manifest.run.terminalHead,
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        previousLedgerSha256: null,
        overallVerdict: 'Pass',
      }],
    });
    expect(receipt).toMatchObject({
      predecessorReceiptSha256: null,
      predecessorLedgerSha256: null,
      reconciledBase: manifest.run.reconciledBase,
      upstreamObservedOid: upstreamOid,
    });
  });

  it('appends one exact successor row to a verified predecessor ledger', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const predecessor = await createFinalizedSyntheticReconciliation(fixture.repo, api.runBoundaryRunCli, 'parser-chain');
    const predecessorPin = [
      'BCF-00', 'bcf00-reconciliation', predecessor.runId, predecessor.terminalHead,
      predecessor.manifestSha256, predecessor.completionReceiptSha256, predecessor.ledgerSha256,
    ].join(',');
    const runDir = path.join(fixture.repo, 'evidence/task01/parser-successor');
    const profile = boundaryRun.RUN_CONTRACT_PROFILES['bcf01-parser'];
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', runDir, '--task', 'BCF-01', '--profile', 'bcf01-parser',
      '--predecessor-run-dir', predecessor.runDir, '--predecessor-pin', predecessorPin,
      ...profile.allowedPaths.flatMap((relativePath) => ['--allow-path', relativePath]),
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });
    const initialized = JSON.parse(readFileSync(path.join(runDir, 'run_manifest.json'), 'utf8')) as {
      run: { reconciledBase: string };
      upstream: { observedOid: string };
    };
    expect(initialized.run.reconciledBase).toBe(predecessor.reconciledBase);
    expect(initialized.upstream.observedOid).toBe(predecessor.upstreamOid);

    writeFileSync(path.join(fixture.repo, 'scripts/semantic-quality-check.ts'), 'export const fixture = false;\n');
    writeFileSync(path.join(fixture.repo, 'tests/scripts/semantic-quality-check.test.ts'), 'test changed fixture\n');
    git(fixture.repo, ['add', ...profile.allowedPaths]);
    const stagedSnapshot = boundaryRun.captureBoundaryWorktreeSnapshot(fixture.repo, {
      allowedUntrackedPaths: [],
      preservedOwnerPaths: ['owner.tsv'],
    });
    expect(stagedSnapshot).toMatchObject({ ok: true });
    const manifestPath = path.join(runDir, 'run_manifest.json');
    const active = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    active['currentSnapshot'] = structuredClone(stagedSnapshot.snapshot);
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(active));
    fillSyntheticRequiredAttempts(fixture.repo, runDir, ['parser-commit-transition']);
    expect(await api.runBoundaryRunCli([
      'record-git-transition', '--run-dir', runDir, '--attempt', 'parser-commit-transition',
      '--kind', 'commit', '--expect-before', predecessor.terminalHead,
      '--message-subject', 'fix(quality): fail closed on invalid semantic options',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(await api.runBoundaryRunCli([
      'set-lifecycle', '--run-dir', runDir, '--status', 'completed', '--final-gate', 'pass',
      '--oracle', 'current',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const finalized = await api.runBoundaryRunCli(['finalize', '--run-dir', runDir], fixture.repo);
    expect(finalized, JSON.stringify(finalized)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(await api.runBoundaryRunCli(['verify', '--run-dir', runDir], fixture.repo)).toMatchObject({
      ok: true, exitCode: 0, verdict: 'Pass',
    });
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { run: { terminalHead: string } };
    const completionDir = path.join(fixture.repo, 'evidence/completion/parser-successor');
    const ledger = JSON.parse(readFileSync(path.join(completionDir, 'chain_ledger.json'), 'utf8')) as {
      rows: Array<Record<string, unknown>>;
    };
    const receipt = JSON.parse(readFileSync(path.join(completionDir, 'completion_receipt.json'), 'utf8')) as Record<string, unknown>;
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[1]).toEqual({
      ordinal: 2,
      taskId: 'BCF-01',
      profileId: 'bcf01-parser',
      runId: 'parser-successor',
      entryHead: predecessor.terminalHead,
      terminalHead: manifest.run.terminalHead,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      previousLedgerSha256: predecessor.ledgerSha256,
      overallVerdict: 'Pass',
    });
    expect(receipt).toMatchObject({
      predecessorReceiptSha256: predecessor.completionReceiptSha256,
      predecessorLedgerSha256: predecessor.ledgerSha256,
      reconciledBase: predecessor.reconciledBase,
      upstreamObservedOid: predecessor.upstreamOid,
    });
    ledger.rows[1]!['previousLedgerSha256'] = SHA;
    const substitutedLedgerBytes = boundaryRun.canonicalizeBoundaryRun(ledger);
    const substitutedLedgerSha256 = createHash('sha256').update(substitutedLedgerBytes).digest('hex');
    writeFileSync(path.join(completionDir, 'chain_ledger.json'), substitutedLedgerBytes);
    writeFileSync(path.join(completionDir, 'chain_ledger.sha256'), `${substitutedLedgerSha256}  chain_ledger.json\n`);
    receipt['ledgerSha256'] = substitutedLedgerSha256;
    const substitutedReceiptBytes = boundaryRun.canonicalizeBoundaryRun(receipt);
    const substitutedReceiptSha256 = createHash('sha256').update(substitutedReceiptBytes).digest('hex');
    writeFileSync(path.join(completionDir, 'completion_receipt.json'), substitutedReceiptBytes);
    writeFileSync(
      path.join(completionDir, 'completion_receipt.sha256'),
      `${substitutedReceiptSha256}  completion_receipt.json\n`,
    );
    const substituted = await api.runBoundaryRunCli(['verify', '--run-dir', runDir], fixture.repo);
    expect(substituted).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(substituted.issues.map((entry) => entry.code)).toContain('completion-ledger-mismatch');
  });

  it('[BCF00-U03] rejects unsafe or raced derived roots', () => {
    type Reservation = Record<string, unknown>;
    const api = boundaryRun as unknown as {
      reserveBoundaryDerivedRoot?: (input: {
        evidenceRoot: string;
        parentSegments: readonly string[];
        runId: string;
        kind: 'run';
        protectedPaths: readonly string[];
      }) => { ok: boolean; reservation: Reservation | null; issues: Array<{ code: string }> };
      createBoundaryDerivedRoot?: (reservation: Reservation) => { ok: boolean; issues: Array<{ code: string }> };
    };
    expect(typeof api.reserveBoundaryDerivedRoot).toBe('function');
    expect(typeof api.createBoundaryDerivedRoot).toBe('function');
    if (!api.reserveBoundaryDerivedRoot || !api.createBoundaryDerivedRoot) return;

    for (const parentSegments of [['/absolute'], ['..']] as const) {
      const result = api.reserveBoundaryDerivedRoot({
        evidenceRoot: makeEvidenceRoot(),
        parentSegments,
        runId: 'valid-run',
        kind: 'run',
        protectedPaths: [],
      });
      expect(result.ok).toBe(false);
      expect(result.issues.map((entry) => entry.code)).toContain('derived-root-path-invalid');
    }

    const overlapRoot = makeEvidenceRoot();
    const overlap = api.reserveBoundaryDerivedRoot({
      evidenceRoot: overlapRoot,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [path.join(overlapRoot, 'observation', 'valid-run', 'output.json')],
    });
    expect(overlap.ok).toBe(false);
    expect(overlap.issues.map((entry) => entry.code)).toContain('derived-root-overlap');

    const existingRoot = makeEvidenceRoot();
    mkdirSync(path.join(existingRoot, 'observation', 'valid-run'));
    const existing = api.reserveBoundaryDerivedRoot({
      evidenceRoot: existingRoot,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [],
    });
    expect(existing.ok).toBe(false);
    expect(existing.issues.map((entry) => entry.code)).toContain('derived-root-exists');

    const symlinkRootInput = mkdtempSync(path.join(tmpdir(), 'boundary-run-symlink-'));
    fixtureRoots.push(symlinkRootInput);
    const symlinkRoot = realpathSync(symlinkRootInput);
    mkdirSync(path.join(symlinkRoot, 'real-observation'));
    symlinkSync(path.join(symlinkRoot, 'real-observation'), path.join(symlinkRoot, 'observation'));
    const symlinked = api.reserveBoundaryDerivedRoot({
      evidenceRoot: symlinkRoot,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [],
    });
    expect(symlinked.ok).toBe(false);
    expect(symlinked.issues.map((entry) => entry.code)).toContain('derived-root-symlink');

    const racedRoot = makeEvidenceRoot();
    const raced = api.reserveBoundaryDerivedRoot({
      evidenceRoot: racedRoot,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [],
    });
    expect(raced.ok).toBe(true);
    renameSync(path.join(racedRoot, 'observation'), path.join(racedRoot, 'observation-old'));
    mkdirSync(path.join(racedRoot, 'observation'));
    const racedCreation = api.createBoundaryDerivedRoot(raced.reservation!);
    expect(racedCreation.ok).toBe(false);
    expect(racedCreation.issues.map((entry) => entry.code)).toContain('derived-root-parent-raced');
  });

  it('[BCF00-N03] exclusively creates one fresh confined derived sibling', () => {
    type Reservation = Record<string, unknown>;
    const api = boundaryRun as unknown as {
      reserveBoundaryDerivedRoot?: (input: {
        evidenceRoot: string;
        parentSegments: readonly string[];
        runId: string;
        kind: 'run';
        protectedPaths: readonly string[];
      }) => { ok: boolean; reservation: Reservation | null; issues: Array<{ code: string }> };
      createBoundaryDerivedRoot?: (reservation: Reservation) => { ok: boolean; record?: unknown; issues: Array<{ code: string }> };
    };
    expect(typeof api.reserveBoundaryDerivedRoot).toBe('function');
    expect(typeof api.createBoundaryDerivedRoot).toBe('function');
    if (!api.reserveBoundaryDerivedRoot || !api.createBoundaryDerivedRoot) return;

    const root = makeEvidenceRoot();
    const reserved = api.reserveBoundaryDerivedRoot({
      evidenceRoot: root,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [],
    });
    expect(reserved.ok, reserved.issues.map((entry) => entry.code).join(', ')).toBe(true);
    const created = api.createBoundaryDerivedRoot(reserved.reservation!);
    expect(created.ok, created.issues.map((entry) => entry.code).join(', ')).toBe(true);
    expect(created.record).toMatchObject({
      kind: 'run',
      path: path.join(root, 'observation', 'valid-run'),
      state: 'created',
    });
    expect(api.createBoundaryDerivedRoot(reserved.reservation!).ok).toBe(false);
  });

  it('[BCF00-U04] rejects rewritten or contract-inconsistent child status', () => {
    type StatusInput = {
      expectedExit: string;
      rawExit: number | null;
      rawSignal: string | null;
      expectationMet: boolean;
      watchdogOwner: 'helper-watchdog' | null;
      innerTimeoutOwner: 'gnu-timeout' | null;
      deadlineMs: number;
      killGraceMs: number;
    };
    const api = boundaryRun as unknown as {
      validateBoundaryAttemptStatus?: (
        recorded: StatusInput,
        observed: { rawExit: number | null; rawSignal: string | null },
        contract: Pick<StatusInput, 'expectedExit' | 'watchdogOwner' | 'innerTimeoutOwner' | 'deadlineMs' | 'killGraceMs'>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryAttemptStatus).toBe('function');
    if (!api.validateBoundaryAttemptStatus) return;

    const contract = {
      expectedExit: '1,2',
      watchdogOwner: 'helper-watchdog' as const,
      innerTimeoutOwner: null,
      deadlineMs: 60_000,
      killGraceMs: 30_000,
    };
    const valid: StatusInput = {
      ...contract,
      rawExit: 1,
      rawSignal: null,
      expectationMet: true,
    };
    const cases: Array<{ code: string; record: StatusInput; observed?: { rawExit: number | null; rawSignal: string | null } }> = [
      { code: 'attempt-status-rewritten', record: { ...valid, rawExit: 0 } },
      {
        code: 'attempt-signal-not-exit',
        record: { ...valid, expectedExit: '137', rawExit: null, rawSignal: 'SIGKILL', expectationMet: true },
        observed: { rawExit: null, rawSignal: 'SIGKILL' },
      },
      { code: 'attempt-status-missing', record: { ...valid, rawExit: null, rawSignal: null, expectationMet: false }, observed: { rawExit: null, rawSignal: null } },
      { code: 'attempt-watchdog-owner-mismatch', record: { ...valid, watchdogOwner: null } },
      { code: 'attempt-inner-timeout-owner-mismatch', record: { ...valid, innerTimeoutOwner: 'gnu-timeout' } },
      { code: 'attempt-deadline-mismatch', record: { ...valid, deadlineMs: 59_999 } },
    ];
    for (const candidate of cases) {
      const result = api.validateBoundaryAttemptStatus(
        candidate.record,
        candidate.observed ?? { rawExit: 1, rawSignal: null },
        contract,
      );
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }
  });

  it('[BCF00-N04] accepts the direct expected status with exact timeout owners and deadline', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryAttemptStatus?: (
        recorded: Record<string, unknown>,
        observed: { rawExit: number | null; rawSignal: string | null },
        contract: Record<string, unknown>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryAttemptStatus).toBe('function');
    if (!api.validateBoundaryAttemptStatus) return;
    const contract = {
      expectedExit: '1,2',
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 60_000,
      killGraceMs: 30_000,
    };
    expect(api.validateBoundaryAttemptStatus(
      { ...contract, rawExit: 1, rawSignal: null, expectationMet: true },
      { rawExit: 1, rawSignal: null },
      contract,
    )).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  });

  it('[BCF00-U05] rejects unsafe or incomplete output admissions', () => {
    const api = boundaryRun as unknown as {
      admitBoundaryOutput?: (input: {
        runDir: string;
        attempt: ReturnType<typeof validAttempt>;
        artifacts: Array<Record<string, unknown>>;
        path: string;
        role: string;
        producerAttemptId: string;
      }) => {
        result: ReturnType<typeof validateBoundaryRun>;
        attempt: ReturnType<typeof validAttempt>;
        artifacts: Array<Record<string, unknown>>;
      };
      validateBoundaryOutputClosure?: (
        runDir: string,
        attempt: ReturnType<typeof validAttempt>,
        artifacts: Array<Record<string, unknown>>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.admitBoundaryOutput).toBe('function');
    expect(typeof api.validateBoundaryOutputClosure).toBe('function');
    if (!api.admitBoundaryOutput || !api.validateBoundaryOutputClosure) return;

    const pending = makeOutputRun();
    const pendingResult = api.validateBoundaryOutputClosure(pending.root, pending.attempt, []);
    expect(pendingResult.ok).toBe(false);
    expect(pendingResult.issues.map((entry) => entry.code)).toContain('output-pending');

    const admissionCases = [
      { code: 'output-undeclared', mutate: (attempt: ReturnType<typeof validAttempt>) => attempt, path: 'outputs/other.txt', role: 'output', producer: 'upstream-root' },
      {
        code: 'output-missing',
        mutate: (attempt: ReturnType<typeof validAttempt>) => {
          attempt.outputAdmissions[0]!.state = 'missing';
          return attempt;
        },
        path: 'outputs/root.txt',
        role: 'output',
        producer: 'upstream-root',
      },
      { code: 'output-producer-mismatch', mutate: (attempt: ReturnType<typeof validAttempt>) => attempt, path: 'outputs/root.txt', role: 'output', producer: 'other-attempt' },
      { code: 'output-role-invalid', mutate: (attempt: ReturnType<typeof validAttempt>) => attempt, path: 'outputs/root.txt', role: 'foreign', producer: 'upstream-root' },
    ];
    for (const candidate of admissionCases) {
      const fixture = makeOutputRun();
      const outcome = api.admitBoundaryOutput({
        runDir: fixture.root,
        attempt: candidate.mutate(fixture.attempt),
        artifacts: [],
        path: candidate.path,
        role: candidate.role,
        producerAttemptId: candidate.producer,
      });
      expect(outcome.result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(outcome.result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }

    const duplicateFixture = makeOutputRun();
    const admitted = api.admitBoundaryOutput({
      runDir: duplicateFixture.root,
      attempt: duplicateFixture.attempt,
      artifacts: [],
      path: 'outputs/root.txt',
      role: 'output',
      producerAttemptId: 'upstream-root',
    });
    const duplicate = api.admitBoundaryOutput({
      runDir: duplicateFixture.root,
      attempt: admitted.attempt,
      artifacts: admitted.artifacts,
      path: 'outputs/root.txt',
      role: 'output',
      producerAttemptId: 'upstream-root',
    });
    expect(duplicate.result.ok).toBe(false);
    expect(duplicate.result.issues.map((entry) => entry.code)).toContain('output-duplicate-admission');

    writeFileSync(path.join(duplicateFixture.root, 'outputs/root.txt'), 'mutated\n');
    const mutated = api.validateBoundaryOutputClosure(duplicateFixture.root, admitted.attempt, admitted.artifacts);
    expect(mutated.ok).toBe(false);
    expect(mutated.issues.map((entry) => entry.code)).toContain('output-content-drift');
  });

  it('[BCF00-N05] admits one declared pending file once and verifies its producer-bound hash', () => {
    const api = boundaryRun as unknown as {
      admitBoundaryOutput?: (input: {
        runDir: string;
        attempt: ReturnType<typeof validAttempt>;
        artifacts: Array<Record<string, unknown>>;
        path: string;
        role: string;
        producerAttemptId: string;
      }) => {
        result: ReturnType<typeof validateBoundaryRun>;
        attempt: ReturnType<typeof validAttempt>;
        artifacts: Array<Record<string, unknown>>;
      };
      validateBoundaryOutputClosure?: (
        runDir: string,
        attempt: ReturnType<typeof validAttempt>,
        artifacts: Array<Record<string, unknown>>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.admitBoundaryOutput).toBe('function');
    expect(typeof api.validateBoundaryOutputClosure).toBe('function');
    if (!api.admitBoundaryOutput || !api.validateBoundaryOutputClosure) return;

    const fixture = makeOutputRun();
    const admitted = api.admitBoundaryOutput({
      runDir: fixture.root,
      attempt: fixture.attempt,
      artifacts: [],
      path: 'outputs/root.txt',
      role: 'output',
      producerAttemptId: 'upstream-root',
    });
    expect(admitted.result).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(admitted.attempt.outputAdmissions).toEqual([
      { path: 'outputs/root.txt', state: 'admitted', role: 'output', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: 5 },
    ]);
    expect(admitted.attempt.verdict).toBe('Pass');
    expect(admitted.artifacts).toEqual([
      expect.objectContaining({ path: 'outputs/root.txt', producerAttemptId: 'upstream-root', role: 'output', bytes: 5 }),
    ]);
    expect(api.validateBoundaryOutputClosure(fixture.root, admitted.attempt, admitted.artifacts)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });

  it('[BCF00-U06] rejects profile-set and reserved-attempt contract substitutions', () => {
    const api = boundaryRun as unknown as {
      RUN_CONTRACT_PROFILES?: Record<string, Record<string, unknown>>;
      RUN_ATTEMPT_CONTRACTS?: Record<string, Record<string, unknown>>;
      RUN_CHILD_CONTRACTS?: Record<string, Record<string, unknown>>;
      resolveBoundaryToolCapability?: (name: string) => Record<string, unknown>;
      validateBoundaryProfileSelection?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      validateBoundaryAttemptInvocation?: (id: string, input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      parseBoundaryChildPins?: (profileId: string, entryHead: string, values: readonly string[]) => {
        result: ReturnType<typeof validateBoundaryRun>;
        pins: unknown[] | null;
      };
    };
    expect(api.RUN_CONTRACT_PROFILES).toBeDefined();
    expect(api.RUN_ATTEMPT_CONTRACTS).toBeDefined();
    expect(api.RUN_CHILD_CONTRACTS).toBeDefined();
    expect(typeof api.resolveBoundaryToolCapability).toBe('function');
    expect(typeof api.validateBoundaryProfileSelection).toBe('function');
    expect(typeof api.validateBoundaryAttemptInvocation).toBe('function');
    expect(typeof api.parseBoundaryChildPins).toBe('function');
    if (!api.RUN_CONTRACT_PROFILES || !api.RUN_ATTEMPT_CONTRACTS || !api.RUN_CHILD_CONTRACTS || !api.resolveBoundaryToolCapability || !api.validateBoundaryProfileSelection || !api.validateBoundaryAttemptInvocation || !api.parseBoundaryChildPins) return;

    expect(Object.keys(api.RUN_CONTRACT_PROFILES)).toEqual(Object.keys(EXPECTED_PROFILE_ROWS));
    for (const [profileId, expected] of Object.entries(EXPECTED_PROFILE_ROWS)) {
      const row = api.RUN_CONTRACT_PROFILES[profileId]!;
      expect([
        row['taskId'],
        row['phase'],
        row['terminalLifecycle'],
        row['mayComplete'],
        row['chainAppend'],
        row['transition'],
        row['predecessorProfileId'],
        (row['requiredChildren'] as string[]).join(','),
        (row['requiredAttemptIds'] as string[]).join(','),
      ], profileId).toEqual(expected);
      expect(row['allowedPaths'], `${profileId} paths`).toEqual(EXPECTED_PROFILE_PATHS[profileId as keyof typeof EXPECTED_PROFILE_PATHS]);
      expect(row['profileId'], `${profileId} identity`).toBe(profileId);
    }
    const requiredAttemptIds = [...new Set(Object.values(api.RUN_CONTRACT_PROFILES)
      .flatMap((row) => row['requiredAttemptIds'] as string[]))].sort();
    expect(Object.keys(api.RUN_ATTEMPT_CONTRACTS).sort()).toEqual(requiredAttemptIds);
    expect(Object.keys(api.RUN_CHILD_CONTRACTS)).toEqual(Object.keys(EXPECTED_CHILD_CONTRACT_ROWS));
    for (const [id, expected] of Object.entries(EXPECTED_CHILD_CONTRACT_ROWS)) {
      const row = api.RUN_CHILD_CONTRACTS[id]!;
      expect([
        row['kind'], row['taskId'], row['profileId'], row['dedupeKey'], row['headRelation'], row['maxDepth'],
      ], id).toEqual(expected);
    }

    const profile = structuredClone(api.RUN_CONTRACT_PROFILES['bcf00-observation']!);
    for (const candidate of [
      { ...profile, taskId: 'BCF-01' },
      { ...profile, profileId: 'bcf00-reconciliation' },
      { ...profile, requiredAttemptIds: (profile['requiredAttemptIds'] as string[]).slice(1) },
      { ...profile, requiredAttemptIds: [...profile['requiredAttemptIds'] as string[], 'extra-attempt'] },
    ]) {
      expect(api.validateBoundaryProfileSelection(candidate)).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    }

    const capability = api.resolveBoundaryToolCapability('git');
    const invocation = {
      operation: 'command',
      argv: ['git', 'rev-parse', '--show-toplevel'],
      environment: { HOME: '/tmp/home', LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin', TMPDIR: '/tmp', TZ: 'UTC' },
      capability,
      expectedExit: '0',
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 120_000,
      killGraceMs: 30_000,
      outputPaths: [],
      headAnchor: 'entry',
    };
    const attempts = [
      { ...invocation, argv: ['git', 'status'] },
      { ...invocation, environment: { ...invocation.environment, SKIP_TESTS: '1' } },
      { ...invocation, capability: { ...capability, sha256: '0'.repeat(64) } },
      { ...invocation, operation: 'internal-check' },
    ];
    for (const candidate of attempts) {
      expect(api.validateBoundaryAttemptInvocation('upstream-root', candidate)).toMatchObject({
        ok: false,
        exitCode: 1,
        verdict: 'Inconclusive',
      });
    }
    for (const values of [
      [],
      [`upstream-observation,${OID},observation-run,${SHA}`, `other,${OID},other-run,${SHA_B}`],
      [`upstream-observation,${OID_C},observation-run,${SHA}`],
      [`upstream-observation,${OID},BAD_RUN,${SHA}`],
      [`upstream-observation,${OID},observation-run,${SHA.toUpperCase()}`],
    ]) {
      expect(api.parseBoundaryChildPins('bcf00-reconciliation', OID, values).result).toMatchObject({
        ok: false,
        exitCode: 1,
        verdict: 'Inconclusive',
      });
    }
    expect(api.parseBoundaryChildPins('bcf00-observation', OID, [
      `upstream-observation,${OID},observation-run,${SHA}`,
    ]).result).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
  });

  it('[BCF00-N06] accepts the exact generated profile and reserved attempt contract', () => {
    const api = boundaryRun as unknown as {
      RUN_CONTRACT_PROFILES?: Record<string, Record<string, unknown>>;
      resolveBoundaryToolCapability?: (name: string) => Record<string, unknown>;
      validateBoundaryProfileSelection?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      validateBoundaryAttemptInvocation?: (id: string, input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      parseBoundaryChildPins?: (profileId: string, entryHead: string, values: readonly string[]) => {
        result: ReturnType<typeof validateBoundaryRun>;
        pins: unknown[] | null;
      };
    };
    expect(api.RUN_CONTRACT_PROFILES).toBeDefined();
    expect(typeof api.resolveBoundaryToolCapability).toBe('function');
    expect(typeof api.validateBoundaryProfileSelection).toBe('function');
    expect(typeof api.validateBoundaryAttemptInvocation).toBe('function');
    expect(typeof api.parseBoundaryChildPins).toBe('function');
    if (!api.RUN_CONTRACT_PROFILES || !api.resolveBoundaryToolCapability || !api.validateBoundaryProfileSelection || !api.validateBoundaryAttemptInvocation || !api.parseBoundaryChildPins) return;

    const profile = structuredClone(api.RUN_CONTRACT_PROFILES['bcf00-observation']!);
    expect(api.validateBoundaryProfileSelection(profile)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(api.validateBoundaryAttemptInvocation('upstream-root', {
      operation: 'command',
      argv: ['git', 'rev-parse', '--show-toplevel'],
      environment: { HOME: '/tmp/home', LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin', TMPDIR: '/tmp', TZ: 'UTC' },
      capability: api.resolveBoundaryToolCapability('git'),
      expectedExit: '0',
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 120_000,
      killGraceMs: 30_000,
      outputPaths: [],
      headAnchor: 'entry',
    })).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(api.parseBoundaryChildPins('bcf00-reconciliation', OID, [
      `upstream-observation,${OID},observation-run,${SHA}`,
    ])).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      pins: [{ alias: 'upstream-observation', head: OID, runId: 'observation-run', manifestSha256: SHA }],
    });
    expect(api.parseBoundaryChildPins('bcf00-observation', OID, [])).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      pins: [],
    });
  });

  it('covers every profile-owned internal-check name with one implemented helper contract', () => {
    const implemented = (boundaryCli as unknown as { BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS?: readonly string[] })
      .BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS;
    expect(implemented).toBeDefined();
    const required = [...new Set(Object.values(boundaryRun.RUN_ATTEMPT_CONTRACTS)
      .filter((contract) => contract.operation === 'internal-check')
      .map((contract) => contract.internalCheck!))].sort();
    expect(implemented).toEqual(required);
  });

  it('covers every profile-owned structured-result predicate with a closed executable contract', () => {
    const required = [...new Set(Object.values(boundaryRun.RUN_ATTEMPT_CONTRACTS)
      .map((contract) => contract.resultPredicate)
      .filter((predicate): predicate is string => predicate !== null))].sort();
    expect(boundaryRun.BOUNDARY_SUPPORTED_RESULT_PREDICATES).toEqual(required);
    expect(boundaryRun.RUN_TEST_CONTRACTS.bcf01.markerIds).toEqual([
      '[BCF01-U01]', '[BCF01-U02]', '[BCF01-U03]', '[BCF01-U04]', '[BCF01-U05]', '[BCF01-U06]',
      '[BCF01-S01]',
      '[BCF01-N01]', '[BCF01-N02]', '[BCF01-N03]', '[BCF01-N04]', '[BCF01-N05]', '[BCF01-N06]',
    ]);
    expect(boundaryRun.RUN_TEST_CONTRACTS.bcf06.markerIds).toEqual([
      '[BCF06-U01]', '[BCF06-S01]', '[BCF06-S02]', '[BCF06-S03]',
    ]);
    expect(boundaryRun.RUN_TEST_CONTRACTS.bcf07.markerIds).toEqual([
      '[BCF07-U01]', '[BCF07-U02]', '[BCF07-U03]', '[BCF07-U04]',
      '[BCF07-S01]', '[BCF07-S02]',
      '[BCF07-N01]', '[BCF07-N02]', '[BCF07-N03]', '[BCF07-N04]',
    ]);
    expect(boundaryRun.RUN_ATTEMPT_CONTRACTS['merge-preview']?.expectedExit).toBe('0,1');
  });

  it('accepts only the exact RED unsafe sentinels paired with passing safe controls', () => {
    const contract = boundaryRun.RUN_TEST_CONTRACTS.bcf01;
    const rows = [...contract.unsafeMarkerIds, ...contract.safeMarkerIds].map((markerId) => {
      const unsafe = markerId.includes('-U');
      return {
        ancestorTitles: ['parser contract'],
        fullName: `parser contract ${markerId}`,
        title: `${markerId} exact contract case`,
        status: unsafe ? 'failed' : 'passed',
        failureMessages: unsafe
          ? [`Error: BCF_EXPECTATION_UNMET:BCF01-${markerId.slice(-3, -1)}\n at contract.test.ts:1:1`]
          : [],
      };
    });
    const report = {
      numFailedTestSuites: 1,
      numFailedTests: contract.unsafeMarkerIds.length,
      numPassedTestSuites: 0,
      numPassedTests: contract.safeMarkerIds.length,
      numPendingTestSuites: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numTotalTests: rows.length,
      snapshot: {},
      startTime: 1,
      success: false,
      testResults: [{
        name: '/repo/tests/scripts/semantic-quality-check.test.ts',
        status: 'failed',
        assertionResults: rows,
      }],
    };
    const input = {
      predicate: 'bcf01-red', cwd: '/repo',
      entryTestRoster: {
        files: [{ path: contract.testFiles[0], state: 'present', testNames: [] }], digestSha256: SHA,
      },
      report,
    };
    expect(boundaryRun.validateBoundaryVitestJsonReport(input)).toMatchObject({ ok: true, verdict: 'Pass' });
    const wrong = structuredClone(input);
    wrong.report.testResults[0]!.assertionResults[0]!.failureMessages = ['Error: unrelated failure'];
    expect(boundaryRun.validateBoundaryVitestJsonReport(wrong).issues.map((entry) => entry.code))
      .toContain('test-red-sentinel-mismatch');
  });

  it('derives the baseline evaluator oracle from every locked corpus case', () => {
    const corpus = loadCorpus(path.join(process.cwd(), 'tests/fixtures/semantic-boundary-eval/cases.json'));
    const report = evaluateBaseline(corpus) as unknown as Record<string, unknown>;
    const input = { predicate: 'baseline-13-of-40', cwd: process.cwd(), entryTestRoster: { files: [] }, report };
    expect(boundaryRun.validateBoundaryVitestJsonReport(input)).toMatchObject({ ok: true, verdict: 'Pass' });
    const changed = structuredClone(input);
    (changed.report['mismatches'] as Array<Record<string, unknown>>)[0]!['predicted'] = 'block';
    expect(boundaryRun.validateBoundaryVitestJsonReport(changed).issues.map((entry) => entry.code))
      .toContain('evaluator-result-mismatch');
  });

  it('binds every candidate receipt to the exact holdout oracle and frozen score', () => {
    const corpus = loadCorpus(path.join(process.cwd(), 'tests/fixtures/semantic-boundary-eval/holdout.json'));
    const report = evaluateCandidate(corpus, { verifyGit: true, cwd: process.cwd() }) as unknown as Record<string, unknown>;
    const input = { predicate: 'holdout-18-of-18', cwd: process.cwd(), entryTestRoster: { files: [] }, report };
    expect(boundaryRun.validateBoundaryVitestJsonReport(input)).toMatchObject({ ok: true, verdict: 'Pass' });
    const changed = structuredClone(input);
    (changed.report['receipts'] as Array<Record<string, unknown>>)[0]!['caseId'] = 'substituted-case';
    expect(boundaryRun.validateBoundaryVitestJsonReport(changed).issues.map((entry) => entry.code))
      .toContain('evaluator-case-roster-mismatch');
  });

  it('runs closeout negative controls through the same closure verifier as the unchanged neighbor', () => {
    const base: boundaryCli.BoundaryCloseoutControlClosure = {
      manifest: validManifest(),
      closeoutCore: {
        internalStatus: [
          { stage: 'finalize', rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' },
          { stage: 'verify', rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' },
        ],
      },
      completionReceipt: { oracleDigest: SHA },
      ledger: { oracleDigest: SHA },
    };
    expect(boundaryCli.validateBoundaryCloseoutControlClosure(structuredClone(base), base))
      .toMatchObject({ ok: true, verdict: 'Pass' });
    const controls: Array<[string, (value: boundaryCli.BoundaryCloseoutControlClosure) => void]> = [
      ['head-mismatch', (value) => { value.manifest.run.terminalHead = OID_C; }],
      ['diff-mismatch', (value) => { value.manifest.currentSnapshot.digestSha256 = SHA_B; }],
      ['changed-manifest', (value) => { value.manifest.run.createdAtUtc = '2026-07-16T16:30:00.001Z'; }],
      ['substituted-core', (value) => { value.closeoutCore['helperSha256'] = SHA_B; }],
      ['missing-completion-receipt', (value) => { value.completionReceipt = null; }],
      ['changed-completion-receipt', (value) => { value.completionReceipt!['oracleDigest'] = SHA_B; }],
      ['changed-chain-ledger', (value) => { value.ledger!['oracleDigest'] = SHA_B; }],
      ['forged-internal-status', (value) => {
        (value.closeoutCore['internalStatus'] as Array<Record<string, unknown>>)[0]!['rawExit'] = 1;
      }],
    ];
    for (const [reason, mutate] of controls) {
      const candidate = structuredClone(base);
      mutate(candidate);
      const result = boundaryCli.validateBoundaryCloseoutControlClosure(candidate, base);
      expect(result.ok, reason).toBe(false);
      expect(result.issues[0]?.code, reason).toBe(reason);
    }
  });

  it('[BCF00-U07] rejects incomplete, weakened, or misclassified structured test results', () => {
    type TestRow = { marker: string; status: 'passed' | 'failed' | 'skipped' | 'todo'; failureReason: string | null };
    type TestResult = {
      testFile: string;
      registeredMarkerIds: string[];
      tests: TestRow[];
      collectionErrors: string[];
      unhandledErrors: string[];
    };
    const api = boundaryRun as unknown as {
      RUN_TEST_CONTRACTS?: { bcf00: { markerIds: string[]; testFile: string } };
      validateBoundaryStructuredTestResult?: (mode: 'red' | 'green', result: TestResult) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(api.RUN_TEST_CONTRACTS?.bcf00.markerIds).toEqual(expectedBcf00Markers);
    expect(typeof api.validateBoundaryStructuredTestResult).toBe('function');
    if (!api.RUN_TEST_CONTRACTS || !api.validateBoundaryStructuredTestResult) return;

    const green = (): TestResult => ({
      testFile: api.RUN_TEST_CONTRACTS!.bcf00.testFile,
      registeredMarkerIds: [...expectedBcf00Markers],
      tests: expectedBcf00Markers.map((id) => ({ marker: id, status: 'passed', failureReason: null })),
      collectionErrors: [],
      unhandledErrors: [],
    });
    const cases: Array<{ code: string; result: TestResult }> = [];
    const missing = green();
    missing.tests.pop();
    cases.push({ code: 'test-marker-roster-mismatch', result: missing });
    const zero = green();
    zero.tests = [];
    cases.push({ code: 'test-zero-collected', result: zero });
    const skipped = green();
    skipped.tests[0]!.status = 'skipped';
    cases.push({ code: 'test-nonterminal-status', result: skipped });
    const todo = green();
    todo.tests[0]!.status = 'todo';
    cases.push({ code: 'test-nonterminal-status', result: todo });
    const renamed = green();
    renamed.tests[0]!.marker = marker('RENAMED');
    cases.push({ code: 'test-marker-roster-mismatch', result: renamed });
    const collection = green();
    collection.collectionErrors = ['import failed'];
    cases.push({ code: 'test-collection-error', result: collection });
    const unhandled = green();
    unhandled.unhandledErrors = ['unhandled rejection'];
    cases.push({ code: 'test-unhandled-error', result: unhandled });
    const weakened = green();
    weakened.registeredMarkerIds.pop();
    cases.push({ code: 'test-registration-mismatch', result: weakened });
    for (const candidate of cases) {
      const result = api.validateBoundaryStructuredTestResult('green', candidate.result);
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }

    const redSelection = expectedBcf00Markers.filter((id) => id.includes('-B') || id.includes('-U'));
    const wrongSentinel: TestResult = {
      testFile: api.RUN_TEST_CONTRACTS.bcf00.testFile,
      registeredMarkerIds: [...expectedBcf00Markers],
      tests: redSelection.map((id) => ({
        marker: id,
        status: id.includes('-B') ? 'passed' : 'failed',
        failureReason: id === marker('U07') ? 'unrelated assertion' : `unsafe:${id}`,
      })),
      collectionErrors: [],
      unhandledErrors: [],
    };
    const wrong = api.validateBoundaryStructuredTestResult('red', wrongSentinel);
    expect(wrong.ok).toBe(false);
    expect(wrong.issues.map((entry) => entry.code)).toContain('test-red-sentinel-mismatch');
  });

  it('[BCF00-N07] accepts the exact nonzero registered marker roster and result predicate', () => {
    const api = boundaryRun as unknown as {
      RUN_TEST_CONTRACTS?: { bcf00: { markerIds: string[]; testFile: string } };
      validateBoundaryStructuredTestResult?: (mode: 'green', result: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(api.RUN_TEST_CONTRACTS?.bcf00.markerIds).toEqual(expectedBcf00Markers);
    expect(typeof api.validateBoundaryStructuredTestResult).toBe('function');
    if (!api.RUN_TEST_CONTRACTS || !api.validateBoundaryStructuredTestResult) return;
    expect(api.validateBoundaryStructuredTestResult('green', {
      testFile: api.RUN_TEST_CONTRACTS.bcf00.testFile,
      registeredMarkerIds: [...expectedBcf00Markers],
      tests: expectedBcf00Markers.map((id) => ({ marker: id, status: 'passed', failureReason: null })),
      collectionErrors: [],
      unhandledErrors: [],
    })).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  });

  it('binds a Vitest JSON report to the exact entry roster and BCF-00 marker registry', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryVitestJsonReport?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryVitestJsonReport).toBe('function');
    if (!api.validateBoundaryVitestJsonReport) return;
    const sourceOrderedMarkers = [
      marker('B01'),
      ...Array.from({ length: 16 }, (_, index) => [
        marker(`U${String(index + 1).padStart(2, '0')}`),
        marker(`N${String(index + 1).padStart(2, '0')}`),
      ]).flat(),
    ];
    const testNames = [...sourceOrderedMarkers, 'retains one pre-existing unmarked test'];
    const assertions = testNames.map((title) => ({
      ancestorTitles: ['boundary run validator'],
      fullName: `boundary run validator ${title}`,
      status: 'passed',
      title,
      failureMessages: [],
    }));
    const report = {
      numFailedTestSuites: 0,
      numFailedTests: 0,
      numPassedTestSuites: 1,
      numPassedTests: assertions.length,
      numPendingTestSuites: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numTotalTests: assertions.length,
      snapshot: {},
      startTime: 1,
      success: true,
      testResults: [{
        name: '/repo/tests/scripts/verify-boundary-run.test.ts',
        status: 'passed',
        assertionResults: assertions,
      }],
    };
    const input = {
      predicate: 'bcf00-green',
      cwd: '/repo',
      entryTestRoster: {
        files: [{
          path: 'tests/scripts/verify-boundary-run.test.ts',
          state: 'present',
          testNames: assertions.map((entry) => entry.fullName).sort(),
        }],
        digestSha256: SHA,
      },
      report,
    };
    expect(api.validateBoundaryVitestJsonReport(input)).toMatchObject({ ok: true, verdict: 'Pass' });
    const missing = structuredClone(input);
    missing.report.testResults[0]!.assertionResults.pop();
    missing.report.numPassedTests -= 1;
    missing.report.numTotalTests -= 1;
    expect(api.validateBoundaryVitestJsonReport(missing).issues.map((entry) => entry.code))
      .toContain('test-entry-roster-mismatch');
  });

  it('enforces each closed command stdout predicate without caller-selected parsing', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryStdoutPredicate?: (
        predicate: string | null,
        stdout: string,
        allowedPaths: readonly string[],
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryStdoutPredicate).toBe('function');
    if (!api.validateBoundaryStdoutPredicate) return;
    const valid: Array<[string | null, string, readonly string[]]> = [
      [null, 'anything\n', []],
      ['oid', `${OID}\n`, []],
      ['ssh-origin', `${SSH_REMOTE}\n`, []],
      ['ahead-behind', '3\t7\n', []],
      ['decimal-equals-29', '29\n', []],
      ['merge-preview', `${OID}\n`, []],
      ['exact-profile-allowlist', 'a.txt\nb.txt\n', ['a.txt', 'b.txt']],
    ];
    for (const [predicate, stdout, allowedPaths] of valid) {
      expect(api.validateBoundaryStdoutPredicate(predicate, stdout, allowedPaths), String(predicate))
        .toMatchObject({ ok: true, verdict: 'Pass' });
    }
    const conflictPreview = [
      OID,
      `100644 ${'1'.repeat(40)} 1\tdocs/work-index.json`,
      `100644 ${'2'.repeat(40)} 2\tdocs/work-index.json`,
      `100644 ${'3'.repeat(40)} 3\tdocs/work-index.json`,
      `100644 ${'4'.repeat(40)} 1\tdocs/work-index.md`,
      `100644 ${'5'.repeat(40)} 2\tdocs/work-index.md`,
      `100644 ${'6'.repeat(40)} 3\tdocs/work-index.md`,
      '',
      'Auto-merging docs/public-surface.md',
      'Auto-merging docs/work-index.json',
      'CONFLICT (content): Merge conflict in docs/work-index.json',
      'Auto-merging docs/work-index.md',
      'CONFLICT (content): Merge conflict in docs/work-index.md',
      '',
    ].join('\n');
    expect(api.validateBoundaryStdoutPredicate('merge-preview', conflictPreview, []))
      .toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    for (const invalid of [
      conflictPreview.replace(`100644 ${'3'.repeat(40)} 3\tdocs/work-index.json\n`, ''),
      conflictPreview.replace(
        'CONFLICT (content): Merge conflict in docs/work-index.md',
        'CONFLICT (content): Merge conflict in docs/foreign.md',
      ),
      `${conflictPreview}unparsed diagnostic\n`,
    ]) {
      expect(api.validateBoundaryStdoutPredicate('merge-preview', invalid, []).issues.map((entry) => entry.code))
        .toContain('attempt-stdout-predicate-mismatch');
    }
    for (const [predicate, stdout, allowedPaths] of [
      ['oid', `${OID}\nextra\n`, []],
      ['ssh-origin', 'https://github.com/LucasQuiles/WhatSoup.git\n', []],
      ['ahead-behind', '3 7 extra\n', []],
      ['decimal-equals-29', '28\n', []],
      ['merge-preview', 'conflict\n', []],
      ['exact-profile-allowlist', 'a.txt\nc.txt\n', ['a.txt', 'b.txt']],
      ['unknown', 'anything\n', []],
    ] as const) {
      expect(api.validateBoundaryStdoutPredicate(predicate, stdout, allowedPaths), predicate)
        .toMatchObject({ ok: false, verdict: 'Inconclusive' });
    }
  });

  it('[BCF00-U08] rejects missing, spliced, drifting, or non-linear predecessor chains', () => {
    const api = boundaryRun as unknown as {
      validateAndAppendBoundaryPredecessor?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        ledger: unknown;
      };
    };
    expect(typeof api.validateAndAppendBoundaryPredecessor).toBe('function');
    if (!api.validateAndAppendBoundaryPredecessor) return;

    const cases: Array<{ code: string; input: Record<string, unknown> }> = [];
    const missing = validPredecessorChainInput() as unknown as Record<string, unknown>;
    missing['pin'] = null;
    cases.push({ code: 'predecessor-missing', input: missing });
    const foreign = validPredecessorChainInput();
    foreign.pin.profileId = 'bcf00-observation';
    cases.push({ code: 'predecessor-profile-mismatch', input: foreign as unknown as Record<string, unknown> });
    const spliced = validPredecessorChainInput();
    spliced.pin.manifestSha256 = SHA_C;
    cases.push({ code: 'predecessor-pin-mismatch', input: spliced as unknown as Record<string, unknown> });
    const digestMismatch = validPredecessorChainInput();
    digestMismatch.ledgerSha256 = SHA_C;
    cases.push({ code: 'predecessor-ledger-digest-mismatch', input: digestMismatch as unknown as Record<string, unknown> });
    const oracleDrift = validPredecessorChainInput();
    oracleDrift.inherited.oracleDigest = SHA_C;
    cases.push({ code: 'predecessor-inherited-drift', input: oracleDrift as unknown as Record<string, unknown> });
    const duplicate = validPredecessorChainInput();
    duplicate.ledger.rows.push(structuredClone(duplicate.ledger.rows[0]!));
    cases.push({ code: 'predecessor-ledger-nonlinear', input: duplicate as unknown as Record<string, unknown> });
    const reordered = validPredecessorChainInput();
    reordered.ledger.rows = [
      { ...structuredClone(reordered.ledger.rows[0]!), ordinal: 2, runId: 'other-run' },
      structuredClone(reordered.ledger.rows[0]!),
    ];
    cases.push({ code: 'predecessor-ledger-nonlinear', input: reordered as unknown as Record<string, unknown> });
    const forked = validPredecessorChainInput();
    forked.currentRow.entryHead = OID_D;
    cases.push({ code: 'predecessor-head-fork', input: forked as unknown as Record<string, unknown> });

    for (const candidate of cases) {
      const result = api.validateAndAppendBoundaryPredecessor(candidate.input).result;
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }
  });

  it('[BCF00-N08] accepts one immutable predecessor pin and authorized ledger append', () => {
    const api = boundaryRun as unknown as {
      RUN_PREDECESSOR_CONTRACTS?: Record<string, Record<string, unknown>>;
      validateAndAppendBoundaryPredecessor?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        ledger: Record<string, unknown> | null;
      };
    };
    expect(Object.keys(api.RUN_PREDECESSOR_CONTRACTS ?? {})).toEqual(Object.keys(EXPECTED_PREDECESSOR_ROWS));
    for (const [profileId, expected] of Object.entries(EXPECTED_PREDECESSOR_ROWS)) {
      const row = api.RUN_PREDECESSOR_CONTRACTS?.[profileId];
      expect(row, profileId).toEqual({
        taskId: expected[0],
        predecessorTaskId: expected[1],
        predecessorProfileId: expected[2],
      });
    }
    expect(typeof api.validateAndAppendBoundaryPredecessor).toBe('function');
    if (!api.validateAndAppendBoundaryPredecessor) return;
    const input = validPredecessorChainInput();
    const outcome = api.validateAndAppendBoundaryPredecessor(input as unknown as Record<string, unknown>);
    expect(outcome.result).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(outcome.ledger).toMatchObject({
      rows: [
        expect.objectContaining({ ordinal: 1, previousLedgerSha256: null, runId: 'reconciliation-run' }),
        expect.objectContaining({ ordinal: 2, previousLedgerSha256: input.ledgerSha256, runId: 'parser-run' }),
      ],
      oracleDigest: SHA_B,
    });
  });

  it('[BCF00-U09] rejects misidentified, cyclic, colliding, or mutated child imports', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryChildImport?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryChildImport).toBe('function');
    if (!api.validateBoundaryChildImport) return;

    const identityMutations = [
      ['alias', 'other-alias'],
      ['kind', 'review'],
      ['taskId', 'BCF-01'],
      ['profileId', 'bcf00-reconciliation'],
      ['entryHead', OID_C],
      ['terminalHead', OID_C],
      ['runId', 'other-run'],
      ['sourceManifestSha256', SHA_C],
    ] as const;
    for (const [field, value] of identityMutations) {
      const input = validChildImportInput();
      (input.child as unknown as Record<string, unknown>)[field] = value;
      const result = api.validateBoundaryChildImport(input as unknown as Record<string, unknown>);
      expect(result, field).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), field).toContain('child-identity-mismatch');
    }

    const cycle = validChildImportInput();
    cycle.child.runId = cycle.parentRunId;
    cycle.pin.runId = cycle.parentRunId;
    const cycleResult = api.validateBoundaryChildImport(cycle as unknown as Record<string, unknown>);
    expect(cycleResult.issues.map((entry) => entry.code)).toContain('child-cycle');

    const depth = validChildImportInput();
    depth.parentDepth = 2;
    const depthResult = api.validateBoundaryChildImport(depth as unknown as Record<string, unknown>);
    expect(depthResult.issues.map((entry) => entry.code)).toContain('child-depth-exceeded');

    const collision = validChildImportInput();
    collision.existingPaths = ['run_manifest.json'];
    const collisionResult = api.validateBoundaryChildImport(collision as unknown as Record<string, unknown>);
    expect(collisionResult.issues.map((entry) => entry.code)).toContain('child-path-collision');

    const mutated = validChildImportInput();
    writeFileSync(path.join(mutated.importRoot, 'artifacts/output.json'), '{"ok":false}\n');
    const mutationResult = api.validateBoundaryChildImport(mutated as unknown as Record<string, unknown>);
    expect(mutationResult.issues.map((entry) => entry.code)).toContain('child-import-mutation');
  });

  it('[BCF00-N09] accepts one profile-pinned recursively verified child import', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryChildImport?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryChildImport).toBe('function');
    if (!api.validateBoundaryChildImport) return;
    expect(api.validateBoundaryChildImport(validChildImportInput() as unknown as Record<string, unknown>)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });

  it('[BCF00-U10] rejects duplicate or disposition-invalid review findings', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryReviewJoins?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      aggregateBoundaryReviewFindingVerdict?: (reviews: ReturnType<typeof validReview>[]) => string;
    };
    expect(typeof api.validateBoundaryReviewJoins).toBe('function');
    expect(typeof api.aggregateBoundaryReviewFindingVerdict).toBe('function');
    if (!api.validateBoundaryReviewJoins || !api.aggregateBoundaryReviewFindingVerdict) return;

    const cases: Array<{ code: string; input: ReturnType<typeof validReviewJoinInput> }> = [];
    const duplicateReview = validReviewJoinInput();
    duplicateReview.reviews.push(structuredClone(duplicateReview.reviews[0]!));
    cases.push({ code: 'review-duplicate', input: duplicateReview });
    const duplicateFinding = validReviewJoinInput();
    duplicateFinding.reviews[0]!.findings.push(structuredClone(duplicateFinding.reviews[0]!.findings[0]!));
    cases.push({ code: 'finding-duplicate', input: duplicateFinding });
    for (const [field, value] of [
      ['severity', 'urgent'],
      ['disposition', 'ignored'],
      ['resolution', 'resolved'],
    ] as const) {
      const invalid = validReviewJoinInput();
      (invalid.reviews[0]!.findings[0] as unknown as Record<string, unknown>)[field] = value;
      cases.push({ code: 'finding-enum-invalid', input: invalid });
    }
    const missingReproduction = validReviewJoinInput();
    missingReproduction.reviews[0]!.findings[0]!.reproductionAttemptIds = [];
    cases.push({ code: 'finding-reproduction-missing', input: missingReproduction });
    const unsupportedRejection = validReviewJoinInput();
    unsupportedRejection.reviews[0]!.findings[0]!.counterevidenceRefs = [];
    unsupportedRejection.reviews[0]!.findings[0]!.counterReproductionAttemptIds = [];
    cases.push({ code: 'finding-rejection-unsupported', input: unsupportedRejection });
    const wrongHeadFix = validReviewJoinInput();
    const finding = wrongHeadFix.reviews[0]!.findings[0]!;
    finding.disposition = 'accepted';
    finding.resolution = 'fixed';
    finding.reason = null as unknown as string;
    finding.counterevidenceRefs = [];
    finding.counterReproductionAttemptIds = [];
    finding.fixedAtHead = OID_D;
    finding.fixReproductionAttemptIds = ['fix-repro'];
    finding.fixReviewId = 'review-2';
    wrongHeadFix.reviews.push({ ...structuredClone(wrongHeadFix.reviews[0]!), reviewId: 'review-2', dedupeKey: 'review-two', head: OID_D, findings: [] });
    wrongHeadFix.attempts.push({ id: 'fix-repro', head: OID_C, snapshotDigestSha256: SHA, rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' });
    wrongHeadFix.currentHead = OID_D;
    cases.push({ code: 'finding-fix-head-mismatch', input: wrongHeadFix });

    for (const candidate of cases) {
      const result = api.validateBoundaryReviewJoins(candidate.input as unknown as Record<string, unknown>);
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }
    const critical = validReview();
    Object.assign(critical.findings[0]!, {
      severity: 'critical', requiresFix: true, requiresReproduction: true,
      disposition: 'accepted', resolution: 'open', reason: null,
    });
    expect(api.aggregateBoundaryReviewFindingVerdict([critical])).toBe('Blocked');
    const major = structuredClone(critical);
    major.findings[0]!.severity = 'major';
    expect(api.aggregateBoundaryReviewFindingVerdict([major])).toBe('Fail');
    const deferred = structuredClone(major);
    deferred.findings[0]!.disposition = 'deferred';
    expect(api.aggregateBoundaryReviewFindingVerdict([deferred])).toBe('Inconclusive');
  });

  it('[BCF00-N10] accepts one unique finding with disposition-valid exact-head proof', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryReviewJoins?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      aggregateBoundaryReviewFindingVerdict?: (reviews: ReturnType<typeof validReview>[]) => string;
    };
    expect(typeof api.validateBoundaryReviewJoins).toBe('function');
    expect(typeof api.aggregateBoundaryReviewFindingVerdict).toBe('function');
    if (!api.validateBoundaryReviewJoins || !api.aggregateBoundaryReviewFindingVerdict) return;
    expect(api.validateBoundaryReviewJoins(validReviewJoinInput() as unknown as Record<string, unknown>)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
    expect(api.aggregateBoundaryReviewFindingVerdict(validReviewJoinInput().reviews)).toBe('Pass');
  });

  it('[BCF00-U11] rejects substituted upstream state and inexact or repeated transitions', () => {
    const api = boundaryRun as unknown as {
      deriveBoundaryUpstreamAndTransition?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        upstream: unknown;
        transitionCount: number;
      };
    };
    expect(typeof api.deriveBoundaryUpstreamAndTransition).toBe('function');
    if (!api.deriveBoundaryUpstreamAndTransition) return;

    const cases: Array<{ code: string; input: ReturnType<typeof validTransitionInput> }> = [];
    const substituted = validTransitionInput();
    substituted.callerFields = { observedOid: OID_D };
    cases.push({ code: 'upstream-caller-substitution', input: substituted });
    const repeated = validTransitionInput();
    repeated.existingUpstream = structuredClone(repeated.attemptOutputs);
    cases.push({ code: 'upstream-already-set', input: repeated });
    const wrongParent = validTransitionInput();
    wrongParent.transition.parents = [OID, OID_D];
    cases.push({ code: 'transition-parent-mismatch', input: wrongParent });
    const wrongTree = validTransitionInput();
    wrongTree.transition.commitTreeOid = OID_C;
    cases.push({ code: 'transition-tree-mismatch', input: wrongTree });
    const wrongIndex = validTransitionInput();
    wrongIndex.transition.postIndexTreeOid = OID_C;
    cases.push({ code: 'transition-tree-mismatch', input: wrongIndex });
    const wrongPaths = validTransitionInput();
    wrongPaths.transition.changedPaths = ['foreign.txt'];
    cases.push({ code: 'transition-path-mismatch', input: wrongPaths });
    const incompleteAbort = validTransitionInput();
    incompleteAbort.transition.rawExit = 1;
    incompleteAbort.transition.afterHead = OID_D;
    incompleteAbort.transition.parents = [];
    incompleteAbort.transition.conflictPaths = ['upstream.txt'];
    incompleteAbort.transition.abortAttempted = true;
    incompleteAbort.transition.abortRestored = false;
    cases.push({ code: 'transition-abort-incomplete', input: incompleteAbort });
    const second = validTransitionInput();
    second.transitionCount = 1;
    cases.push({ code: 'transition-already-used', input: second });

    for (const candidate of cases) {
      const result = api.deriveBoundaryUpstreamAndTransition(candidate.input as unknown as Record<string, unknown>).result;
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }
  });

  it('[BCF00-N11] accepts profile-derived upstream fields and one sole exact transition', () => {
    const api = boundaryRun as unknown as {
      deriveBoundaryUpstreamAndTransition?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        upstream: unknown;
        transitionCount: number;
      };
    };
    expect(typeof api.deriveBoundaryUpstreamAndTransition).toBe('function');
    if (!api.deriveBoundaryUpstreamAndTransition) return;
    const input = validTransitionInput();
    const outcome = api.deriveBoundaryUpstreamAndTransition(input as unknown as Record<string, unknown>);
    expect(outcome.result).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(outcome.transitionCount).toBe(1);
    expect(outcome.upstream).toEqual({
      remoteUrl: input.attemptOutputs.remoteUrl,
      observedOid: OID_C,
      mergeBase: OID,
      ahead: 1,
      behind: 0,
      remotePaths: ['upstream.txt'],
      localPaths: ['local.txt'],
      observationManifestSha256: SHA,
      mergeCommit: OID_D,
      mergeParents: [OID, OID_C],
    });
  });

  it('[BCF00-U12] rejects incoherent lifecycle, verification state, snapshot, or aggregation', () => {
    const api = boundaryRun as unknown as {
      verifyBoundaryLifecycleState?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        verificationScope: string | null;
      };
    };
    expect(typeof api.verifyBoundaryLifecycleState).toBe('function');
    if (!api.verifyBoundaryLifecycleState) return;
    const cases: Array<{ code: string; input: ReturnType<typeof validLifecycleStateInput> }> = [];
    const invalidLifecycle = validLifecycleStateInput();
    invalidLifecycle.lifecycle.status = 'finished';
    cases.push({ code: 'lifecycle-invalid', input: invalidLifecycle });
    const wrongTerminal = validLifecycleStateInput();
    wrongTerminal.lifecycle.status = 'active';
    cases.push({ code: 'lifecycle-terminal-mismatch', input: wrongTerminal });
    const activeMix = validLifecycleStateInput();
    activeMix.manifestState = 'active';
    activeMix.presentFiles.manifestLock = true;
    cases.push({ code: 'verification-state-mixed', input: activeMix });
    const finalizedMissing = validLifecycleStateInput();
    finalizedMissing.presentFiles.ledgerLock = false;
    cases.push({ code: 'verification-state-mixed', input: finalizedMissing });
    const snapshotDrift = validLifecycleStateInput();
    snapshotDrift.liveSnapshotDigestSha256 = SHA_C;
    cases.push({ code: 'verification-snapshot-drift', input: snapshotDrift });
    const missingRequired = validLifecycleStateInput();
    missingRequired.attempts = [];
    cases.push({ code: 'lifecycle-required-incomplete', input: missingRequired });
    for (const candidate of cases) {
      const result = api.verifyBoundaryLifecycleState(candidate.input as unknown as Record<string, unknown>).result;
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }
  });

  it('[BCF00-N12] accepts coherent terminal lifecycle with auto-detected finalized verification', () => {
    const api = boundaryRun as unknown as {
      verifyBoundaryLifecycleState?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        verificationScope: string | null;
      };
    };
    expect(typeof api.verifyBoundaryLifecycleState).toBe('function');
    if (!api.verifyBoundaryLifecycleState) return;
    expect(api.verifyBoundaryLifecycleState(validLifecycleStateInput() as unknown as Record<string, unknown>)).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      verificationScope: 'finalized',
    });
  });

  it('[BCF00-U14] rejects substituted, colliding, reused, or partially published bundles', () => {
    const api = boundaryRun as unknown as {
      publishBoundaryCloseoutBundle?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        bundlePath: string | null;
      };
    };
    expect(typeof api.publishBoundaryCloseoutBundle).toBe('function');
    if (!api.publishBoundaryCloseoutBundle) return;
    for (const objectName of ['runManifest', 'completionReceipt', 'ledger', 'closeoutCore', 'negativeReport', 'closeoutReceipt'] as const) {
      const input = validBundleInput();
      const target = input.objects[objectName] as Record<string, unknown>;
      target['substituted'] = true;
      const result = api.publishBoundaryCloseoutBundle(input as unknown as Record<string, unknown>).result;
      expect(result, objectName).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), objectName).toContain('bundle-hash-mismatch');
    }
    const collision = validBundleInput();
    collision.rejectedParent = collision.acceptedParent;
    const collisionResult = api.publishBoundaryCloseoutBundle(collision as unknown as Record<string, unknown>).result;
    expect(collisionResult.issues.map((entry) => entry.code)).toContain('bundle-path-collision');

    const reused = validBundleInput();
    mkdirSync(path.join(reused.acceptedParent, reused.runId));
    const reusedResult = api.publishBoundaryCloseoutBundle(reused as unknown as Record<string, unknown>).result;
    expect(reusedResult.issues.map((entry) => entry.code)).toContain('bundle-root-reused');

    const partial = validBundleInput();
    mkdirSync(path.join(partial.acceptedParent, `.${partial.runId}.publishing`));
    const partialResult = api.publishBoundaryCloseoutBundle(partial as unknown as Record<string, unknown>).result;
    expect(partialResult.issues.map((entry) => entry.code)).toContain('bundle-partial-publication');
  });

  it('[BCF00-N14] exclusively publishes one hash-joined bundle at its derived path', () => {
    const api = boundaryRun as unknown as {
      publishBoundaryCloseoutBundle?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        bundlePath: string | null;
      };
    };
    expect(typeof api.publishBoundaryCloseoutBundle).toBe('function');
    if (!api.publishBoundaryCloseoutBundle) return;
    const input = validBundleInput();
    const outcome = api.publishBoundaryCloseoutBundle(input as unknown as Record<string, unknown>);
    const expected = path.join(input.acceptedParent, input.runId);
    expect(outcome).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      bundlePath: expected,
    });
    for (const basename of [
      'run_manifest.json',
      'run_manifest.sha256',
      'completion_receipt.json',
      'completion_receipt.sha256',
      'chain_ledger.json',
      'chain_ledger.sha256',
      'closeout_core.json',
      'negative_control_report.json',
      'closeout_receipt.json',
      'closeout_receipt.sha256',
    ]) expect(existsSync(path.join(expected, basename)), basename).toBe(true);
    expect(readFileSync(path.join(expected, 'closeout_receipt.sha256'), 'utf8')).toMatch(
      /^[0-9a-f]{64}  closeout_receipt\.json\n$/,
    );
  });

  it('[BCF00-U15] rejects timeout, signal, survivor, wrong wrapper, or masked direct status', async () => {
    const api = boundaryRun as unknown as {
      runBoundaryWatchdogForTest?: (
        argv: string[],
        options: { deadlineMs: number; killGraceMs: number; expectedExit: string },
      ) => Promise<{ result: ReturnType<typeof validateBoundaryRun>; groupDead: boolean }>;
      validateBoundaryOuterWatchdogRecord?: (
        kind: 'closeout' | 'verify-closeout',
        recorded: Record<string, unknown>,
        observed: Record<string, unknown>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    expect(typeof api.validateBoundaryOuterWatchdogRecord).toBe('function');
    if (!api.runBoundaryWatchdogForTest || !api.validateBoundaryOuterWatchdogRecord) return;

    const timeout = await api.runBoundaryWatchdogForTest([
      process.execPath,
      '-e',
      'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); setInterval(()=>{},1000)',
    ], { deadlineMs: 120, killGraceMs: 60, expectedExit: '0' });
    expect(timeout.result.ok).toBe(false);
    expect(timeout.result.issues.map((entry) => entry.code)).toContain('watchdog-timeout');
    expect(timeout.groupDead).toBe(true);

    const signaled = await api.runBoundaryWatchdogForTest([
      process.execPath,
      '-e',
      'process.kill(process.pid,"SIGTERM")',
    ], { deadlineMs: 250, killGraceMs: 100, expectedExit: '0' });
    expect(signaled.result.ok).toBe(false);
    expect(signaled.result.issues.map((entry) => entry.code)).toContain('watchdog-signal');

    const contract = {
      deadlineMs: 600_000,
      killGraceMs: 30_000,
      rawExit: 0,
      rawSignal: null,
      groupDead: true,
    };
    const wrongDeadline = api.validateBoundaryOuterWatchdogRecord('closeout', { ...contract, deadlineMs: 599_999 }, contract);
    expect(wrongDeadline.issues.map((entry) => entry.code)).toContain('watchdog-contract-mismatch');
    const masked = api.validateBoundaryOuterWatchdogRecord('closeout', contract, { ...contract, rawExit: 1 });
    expect(masked.issues.map((entry) => entry.code)).toContain('watchdog-status-masked');
    const survivor = api.validateBoundaryOuterWatchdogRecord('closeout', { ...contract, groupDead: false }, { ...contract, groupDead: false });
    expect(survivor.issues.map((entry) => entry.code)).toContain('watchdog-group-survivor');
  }, 10_000);

  it('[BCF00-N15] reaps one bounded process group and preserves its direct expected status', async () => {
    const api = boundaryRun as unknown as {
      runBoundaryWatchdogForTest?: (
        argv: string[],
        options: { deadlineMs: number; killGraceMs: number; expectedExit: string },
      ) => Promise<{ result: ReturnType<typeof validateBoundaryRun>; rawExit: number | null; rawSignal: string | null; groupDead: boolean }>;
    };
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const outcome = await api.runBoundaryWatchdogForTest([
      process.execPath,
      '-e',
      'process.exit(7)',
    ], { deadlineMs: 250, killGraceMs: 100, expectedExit: '7' });
    expect(outcome).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      rawExit: 7,
      rawSignal: null,
      groupDead: true,
    });
  }, 10_000);

  it('[BCF00-U16] rejects immutable-byte, identity, ancestor, owner, or retry overwrite drift', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryImmutableClosure?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryImmutableClosure).toBe('function');
    if (!api.validateBoundaryImmutableClosure) return;

    const finalized = validImmutableClosureInput();
    writeFileSync(path.join(finalized.closureRoot, 'run_manifest.json'), '{"finalized":false}\n');
    expect(api.validateBoundaryImmutableClosure(finalized as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('immutable-file-drift');

    const helper = validImmutableClosureInput();
    writeFileSync(path.join(helper.closureRoot, 'helper.ts'), 'export const helper = false;\n');
    expect(api.validateBoundaryImmutableClosure(helper as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('helper-hash-drift');

    const document = validImmutableClosureInput();
    writeFileSync(path.join(document.closureRoot, 'plan.md'), '# Changed\n');
    expect(api.validateBoundaryImmutableClosure(document as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('document-hash-drift');

    const raced = validImmutableClosureInput();
    const parent = raced.reservedRoots[0]!.parentPath;
    renameSync(parent, `${parent}-old`);
    mkdirSync(parent);
    expect(api.validateBoundaryImmutableClosure(raced as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('reserved-root-raced');

    const owner = validImmutableClosureInput();
    writeFileSync(path.join(owner.repo, 'owner.tsv'), 'changed owner\n');
    expect(api.validateBoundaryImmutableClosure(owner as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('closure-owner-drift');

    const overwrite = validImmutableClosureInput();
    mkdirSync(overwrite.retryDestination);
    expect(api.validateBoundaryImmutableClosure(overwrite as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('retry-overwrite');
  });

  it('[BCF00-N16] accepts stable immutable closure and a fresh new-run retry target', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryImmutableClosure?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryImmutableClosure).toBe('function');
    if (!api.validateBoundaryImmutableClosure) return;
    const input = validImmutableClosureInput();
    expect(lstatSync(input.reservedRoots[0]!.parentPath).ino).toBe(Number(input.reservedRoots[0]!.parentInode));
    expect(api.validateBoundaryImmutableClosure(input as unknown as Record<string, unknown>)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
    expect(existsSync(input.retryDestination)).toBe(false);
  });
});
