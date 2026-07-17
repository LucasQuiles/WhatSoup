import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';

import * as boundaryRun from '../../../scripts/lib/verification/boundary-run-manifest.ts';
import {
  BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
  validateBoundaryRun,
} from '../../../scripts/lib/verification/boundary-run-manifest.ts';
import * as boundaryCli from '../../../scripts/verify-boundary-run.ts';
import { evaluateBaseline, evaluateCandidate, loadCorpus } from '../../../scripts/experiments/semantic-boundary-eval.ts';

export {
  BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
  boundaryCli,
  boundaryRun,
  chmodSync,
  copyFileSync,
  createHash,
  evaluateBaseline,
  evaluateCandidate,
  execFileSync,
  existsSync,
  loadCorpus,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  path,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  tmpdir,
  validateBoundaryRun,
  writeFileSync,
};


export const SHA = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);
export const SHA_C = 'c'.repeat(64);
export const OID = 'b'.repeat(40);
export const OID_C = 'c'.repeat(40);
export const OID_D = 'd'.repeat(40);
export const TIME = '2026-07-16T16:30:00.000Z';
export const FIXTURE_EMAIL = ['whatsoup-test', 'users.noreply.github.com'].join('@');
export const SSH_REMOTE = ['git', 'github.com:LucasQuiles/WhatSoup.git'].join('@');
export const fixtureRoots: string[] = [];
export const marker = (id: string): string => `[BCF00-${id}]`;
export const expectedBcf00Markers = [
  marker('B01'),
  ...Array.from({ length: 16 }, (_, index) => marker(`U${String(index + 1).padStart(2, '0')}`)),
  ...Array.from({ length: 16 }, (_, index) => marker(`N${String(index + 1).padStart(2, '0')}`)),
];

export const EXPECTED_PROFILE_ROWS = {
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

export const EXPECTED_PROFILE_PATHS = {
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

export const EXPECTED_PREDECESSOR_ROWS = {
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

export const EXPECTED_CHILD_CONTRACT_ROWS = {
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

export const EXPECTED_WIRE_SCHEMAS = {
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

export function validSnapshot(): boundaryRun.BoundaryWorktreeSnapshot {
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
export function git(repo: string, args: string[]): string {
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

export function makeSnapshotRepo(): string {
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

export function makeEvidenceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'boundary-run-evidence-'));
  fixtureRoots.push(root);
  mkdirSync(path.join(root, 'observation'));
  return realpathSync(root);
}

export function makeCliRepo(): { repo: string; runDir: string } {
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

export async function finalizeSyntheticObservation(
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

export async function initializeSyntheticReconciliation(
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

export function fillSyntheticRequiredAttempts(repo: string, runDir: string, skipIds: readonly string[] = []): void {
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

export async function createFinalizedSyntheticReconciliation(
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

export function makeOutputRun(): { root: string; attempt: ReturnType<typeof validAttempt> } {
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

export const SNAPSHOT_DECLARATIONS: boundaryRun.BoundarySnapshotDeclarations = {
  allowedUntrackedPaths: ['scratch/result.json'],
  preservedOwnerPaths: ['owner.tsv'],
} as const;

export function validDocument(path: string, bytes: number): boundaryRun.BoundaryDocumentHashRecord {
  return { path, sha256: SHA, bytes };
}

export function validStream(path: string): boundaryRun.BoundaryStreamRecord {
  return { path, sha256: SHA, bytes: 1 };
}

export function validAttempt(): boundaryRun.BoundaryAttemptRecord {
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

export function validChild(): boundaryRun.BoundaryChildRecord {
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

export function validFinding(): boundaryRun.BoundaryFindingRecord {
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

export function validReview(): boundaryRun.BoundaryReviewRecord {
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

export function validPredecessor(): boundaryRun.BoundaryPredecessorRecord {
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

export function validManifest(): boundaryRun.BoundaryRunManifest {
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

export function withValue(path: string[], value: unknown): Record<string, unknown> {
  const candidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
  let parent = candidate;
  for (const segment of path.slice(0, -1)) {
    parent = parent[segment] as Record<string, unknown>;
  }
  parent[path.at(-1)!] = value;
  return candidate;
}

export function canonicalJson(value: unknown): string {
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

export function canonicalSha(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function writeSyntheticRunInitAnchor(runDir: string, manifest: Record<string, unknown>): void {
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

export function fileSha(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function validChildImportInput() {
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

export function validReviewJoinInput() {
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

export function installImportedRun(
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

export function validTransitionInput() {
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

export function validLifecycleStateInput() {
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

export function validBundleInput() {
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

export function validImmutableClosureInput() {
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

export function validPredecessorChainInput() {
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
