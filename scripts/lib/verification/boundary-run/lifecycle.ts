import { execFileSync, spawn } from 'node:child_process';
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

import { cleanGitEnv } from '../../../../src/lib/git-env.ts';
import {
  ARTIFACT_KEYS,
  ATTEMPT_KEYS,
  BOUNDARY_BUDGET_KEYS,
  BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
  BOUNDARY_SUPPORTED_RESULT_PREDICATES,
  CHAIN_LEDGER_KEYS,
  CHAIN_ROW_KEYS,
  CHILD_KEYS,
  CHILD_PIN_KEYS,
  COMPLETION_RECEIPT_KEYS,
  CONSUMER_INVENTORY_MATCH_KEYS,
  CORPUS_DIGEST_KEYS,
  DOCS_B_ENTRY_IDENTITY_KEYS,
  DOCS_LINEAGE_ANCHOR_KEYS,
  DOCS_LINEAGE_OPERATION_KEYS,
  DOCS_LINEAGE_PATH_CLASS_KEYS,
  DOCUMENT_HASH_KEYS,
  DOCUMENT_HASH_ROW_KEYS,
  ENTRY_TEST_ROSTER_KEYS,
  EXPECTED_BOUNDARY_BUDGETS,
  FEEDBACK_SCENARIO_KEYS,
  FINDING_KEYS,
  IMPORTED_FILE_KEYS,
  LIFECYCLE_KEYS,
  LOCAL_CONSUMER_KEYS,
  MERGE_CONFLICT_INDEX_STAGE_KEYS,
  OUTPUT_ADMISSION_KEYS,
  PREDECESSOR_KEYS,
  PREDECESSOR_PIN_KEYS,
  READINESS_ASSUMPTION_KEYS,
  READINESS_BLOCKER_KEYS,
  READINESS_EVIDENCE_KEYS,
  READINESS_RISK_KEYS,
  REPRODUCTION_CONTRACT_KEYS,
  RESERVED_DERIVED_ROOT_KEYS,
  REVIEW_INPUT_KEYS,
  REVIEW_KEYS,
  ROOT_KEYS,
  RUN_ATTEMPT_CONTRACTS,
  RUN_CHILD_CONTRACTS,
  RUN_CONTRACT_PROFILES,
  RUN_EVAL_CONTRACTS,
  RUN_PREDECESSOR_CONTRACTS,
  RUN_SOURCE_REVIEW_CONTRACTS,
  RUN_TEST_CONTRACTS,
  RUN_VITEST_PREDICATES,
  RUN_WIRE_SCHEMAS,
  RUN_KEYS,
  SNAPSHOT_KEYS,
  SNAPSHOT_PATH_KEYS,
  STREAM_KEYS,
  TEST_ROSTER_FILE_KEYS,
  TOOL_KEYS,
  UPSTREAM_KEYS,
} from './contracts.ts';
import {
  BOUNDARY_RUN_SCHEMA,
  type BoundaryArtifactRecord,
  type BoundaryArtifactRole,
  type BoundaryAttemptRecord,
  type BoundaryAttemptStatus,
  type BoundaryAttemptStatusContract,
  type BoundaryChildRecord,
  type BoundaryChildPinRecord,
  type BoundaryDerivedRootKind,
  type BoundaryDerivedRootReservation,
  type BoundaryDerivedRootResult,
  type BoundaryDocumentHashRecord,
  type BoundaryEntryTestRoster,
  type BoundaryFindingRecord,
  type BoundaryImportedFileRecord,
  type BoundaryLifecycleRecord,
  type BoundaryOutputAdmission,
  type BoundaryPathRecord,
  type BoundaryPredecessorPin,
  type BoundaryPredecessorRecord,
  type BoundaryReproductionContractRecord,
  type BoundaryReservedDerivedRootRecord,
  type BoundaryReviewInputRecord,
  type BoundaryReviewRecord,
  type BoundaryRunInitAnchor,
  type BoundaryRunManifest,
  type BoundaryRunRecord,
  type BoundarySnapshotCaptureResult,
  type BoundarySnapshotDeclarations,
  type BoundaryStreamRecord,
  type BoundaryToolRecord,
  type BoundaryUpstreamRecord,
  type BoundaryValidationIssue,
  type BoundaryValidationResult,
  type BoundaryVerdict,
  type BoundaryWorktreeSnapshot,
} from './model.ts';
import {
  canonicalizeBoundaryRun,
  check,
  durableExclusiveWrite,
  gitBytes,
  gitText,
  hasDirectStatus,
  hasExactKeys,
  isBoundedText,
  isOid,
  isOperationalId,
  isRecord,
  isSafePath,
  isSha256,
  isTimestamp,
  isVerdict,
  issue,
  requireExactObject,
  requireExactRecord,
  requireRows,
  isSortedUniqueStrings,
  sha256Bytes,
  snapshotResult,
} from './shared.ts';

import { validateBoundaryStructuredRecord } from './schema.ts';
import { isPathOverlap } from './worktree.ts';

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
