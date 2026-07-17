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

import { parseBoundaryExpectedExit } from './attempts.ts';
import { validateBoundaryStructuredRecord } from './schema.ts';
import { capturePathRecord } from './worktree.ts';

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
    check(typeof contract['expectedExit'] === 'string' && parseBoundaryExpectedExit(contract['expectedExit']) !== null, issues, 'reproduction-contract-exit-invalid', `${base}.expectedExit`);
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
