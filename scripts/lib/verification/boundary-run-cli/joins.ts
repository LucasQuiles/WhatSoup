import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
  BOUNDARY_RUN_SCHEMA,
  RUN_ATTEMPT_CONTRACTS,
  RUN_CHILD_CONTRACTS,
  RUN_CONTRACT_PROFILES,
  RUN_PREDECESSOR_CONTRACTS,
  RUN_SOURCE_REVIEW_CONTRACTS,
  RUN_TEST_CONTRACTS,
  RUN_VITEST_PREDICATES,
  RUN_WIRE_SCHEMAS,
  admitBoundaryOutput,
  aggregateBoundaryReviewFindingVerdict,
  boundaryTestFilesForProfile,
  canonicalizeBoundaryRun,
  captureBoundaryWorktreeSnapshot,
  createBoundaryRunInitAnchor,
  createBoundaryDerivedRoot,
  parseBoundaryExpectedExit,
  parseBoundaryChildPins,
  parseBoundaryJsonBytes,
  parseBoundaryMergePreviewStdout,
  reserveBoundaryDerivedRoot,
  resolveBoundaryToolCapability,
  runBoundaryAttemptProcess,
  validateBoundaryAttemptStatus,
  validateBoundaryChildImport,
  validateAndAppendBoundaryPredecessor,
  validateBoundaryOutputClosure,
  validateBoundaryReviewInput,
  validateBoundaryRun,
  validateBoundaryRunJson,
  validateBoundaryStdoutPredicate,
  validateBoundaryStructuredRecord,
  validateBoundaryVitestJsonReport,
  type BoundaryDocumentHashRecord,
  type BoundaryChildRecord,
  type BoundaryImportedFileRecord,
  type BoundaryOutputAdmission,
  type BoundaryPredecessorPin,
  type BoundaryPredecessorRecord,
  type BoundaryReviewInputRecord,
  type BoundaryReviewRecord,
  type BoundaryReservedDerivedRootRecord,
  type BoundaryRunManifest,
  type BoundaryValidationIssue,
  type BoundaryValidationResult,
} from '../boundary-run-manifest.ts';
import { cleanGitEnv } from '../../../../src/lib/git-env.ts';

import {
  isOperationalId,
  isSafeRelativePath,
  stringListOption,
  stringOption,
  type BoundaryRunInvocation,
} from './invocation.ts';
import {
  acceptedAttemptStdout,
  BoundaryRunLoadError,
  canonicalSet,
  capabilityForManifest,
  childContractFor,
  childRelationIssues,
  childClosurePaths,
  childClosureRows,
  discoverEntryTestRoster,
  documentHash,
  durableAtomicRewrite,
  durableExclusiveWrite,
  gitPathSet,
  gitText,
  isPlainRecord,
  importedManifestDepth,
  loadActiveManifest,
  operationResult,
  parseNameStatusPaths,
  readConfinedRegularFile,
  reconstructedChildEnvironment,
  resolveAttemptArgv,
  runLoadFailure,
  sha256,
  shaLockBytes,
  streamRecord,
  strictCanonicalObject,
  validateRecordedChild,
  validateReviewProofContracts,
  verifyRunInitAnchor,
} from './shared.ts';

import { verifyRun } from './lifecycle.ts';

export function recordReview(invocation: BoundaryRunInvocation): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const alias = stringOption(invocation.options, 'alias')!;
  const reviewPath = stringOption(invocation.options, 'reviewPath')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const sourceContract = RUN_SOURCE_REVIEW_CONTRACTS[
    loaded.manifest.run.profileId as keyof typeof RUN_SOURCE_REVIEW_CONTRACTS
  ];
  if (sourceContract === undefined) {
    return recordParentReview(loaded, runDir, alias, reviewPath);
  }
  if (alias !== sourceContract.alias) {
    return operationResult([{ code: 'review-alias-mismatch', message: 'review alias differs from the source profile contract' }], 2);
  }
  if (
    loaded.manifest.reviews.some((entry) => (
      entry.alias === alias
      || entry.dedupeKey === sourceContract.dedupeKey
    ))
  ) {
    return operationResult([{ code: 'review-duplicate', message: 'review alias or dedupe key is already recorded' }], 2);
  }
  let input: BoundaryReviewInputRecord;
  try {
    const bytes = readConfinedRegularFile(runDir, reviewPath);
    const parsed = strictCanonicalObject(bytes, 'review input');
    const validation = validateBoundaryReviewInput(parsed);
    if (!validation.ok) return validation;
    input = parsed as unknown as BoundaryReviewInputRecord;
  } catch (error) {
    return operationResult([{ code: 'review-input-invalid', message: (error as Error).message }]);
  }
  if (
    input.dedupeKey !== sourceContract.dedupeKey
    || input.head !== loaded.manifest.run.entryHead
    || input.snapshotDigestSha256 !== loaded.manifest.entrySnapshot.digestSha256
  ) {
    return operationResult([{ code: 'review-identity-mismatch', message: 'review input differs from the profile entry identity' }], 2);
  }
  if (loaded.manifest.reviews.some((entry) => entry.reviewId === input.reviewId)) {
    return operationResult([{ code: 'review-duplicate', message: 'review ID is already recorded' }], 2);
  }
  const closure = [
    { path: input.reportPath, digest: input.reportSha256 },
    { path: input.metaPath, digest: input.metaSha256 },
    { path: input.stderrPath, digest: input.stderrSha256 },
    ...input.findings.map((finding) => ({ path: finding.evidencePath, digest: finding.evidenceSha256 })),
  ];
  const closurePaths = closure.map((entry) => entry.path);
  if (new Set([reviewPath, ...closurePaths]).size !== closurePaths.length + 1) {
    return operationResult([{ code: 'review-path-collision', message: 'review input and evidence paths must be pairwise distinct' }], 2);
  }
  try {
    for (const entry of closure) {
      const bytes = readConfinedRegularFile(runDir, entry.path);
      if (sha256(bytes) !== entry.digest) {
        return operationResult([{ code: 'review-evidence-mismatch', message: `review evidence hash changed: ${entry.path}` }]);
      }
    }
  } catch (error) {
    return operationResult([{ code: 'review-evidence-invalid', message: (error as Error).message }]);
  }
  for (const contract of input.reproductionContracts) {
    const prior = loaded.manifest.reviews
      .flatMap((review) => review.reproductionContracts)
      .find((entry) => entry.attemptId === contract.attemptId);
    if (prior !== undefined) {
      return operationResult([{
        code: 'reproduction-contract-reused',
        message: 'one reproduction attempt ID cannot be reused across reviews',
      }], 2);
    }
  }
  const { schemaVersion: _schemaVersion, ...sourceRecord } = input;
  const record: BoundaryReviewRecord = { alias, ...structuredClone(sourceRecord) };
  loaded.manifest.reviews.push(record);
  loaded.manifest.reviews.sort((left, right) => Buffer.from(left.alias).compare(Buffer.from(right.alias)));
  const validation = validateBoundaryRun(loaded.manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(loaded.manifest));
  return operationResult([]);
}

function recordParentReview(
  loaded: { manifest: BoundaryRunManifest; path: string },
  runDir: string,
  alias: string,
  reviewPath: string,
): BoundaryValidationResult {
  const contract = childContractFor(loaded.manifest.run.profileId, alias);
  const expectedReviewPath = `children/${alias}/run_manifest.json`;
  if (contract === undefined || contract.kind !== 'review' || reviewPath !== expectedReviewPath) {
    return operationResult([{
      code: 'review-parent-contract-mismatch',
      message: 'parent review mode requires one profile-owned imported review manifest path',
    }], 2);
  }
  if (
    loaded.manifest.reviews.some((entry) => (
      entry.alias === alias
      || entry.dedupeKey === contract.dedupeKey
    ))
  ) {
    return operationResult([{ code: 'review-duplicate', message: 'review alias or dedupe key is already recorded' }], 2);
  }
  const child = loaded.manifest.children.find((entry) => entry.alias === alias);
  const lead = loaded.manifest.children.find((entry) => entry.alias === 'lead-reproduction');
  if (child === undefined || lead === undefined || child.kind !== 'review' || lead.kind !== 'reproduction') {
    return operationResult([{ code: 'review-parent-child-missing', message: 'review and lead reproduction children must already be imported' }]);
  }
  const childValidation = validateRecordedChild(loaded.manifest, runDir, child);
  const leadValidation = validateRecordedChild(loaded.manifest, runDir, lead);
  if (!childValidation.ok || !leadValidation.ok) {
    return operationResult([...childValidation.issues, ...leadValidation.issues]);
  }
  let sourceManifest: BoundaryRunManifest;
  let leadManifest: BoundaryRunManifest;
  try {
    sourceManifest = JSON.parse(readConfinedRegularFile(path.join(runDir, 'children', alias), 'run_manifest.json').toString('utf8')) as BoundaryRunManifest;
    leadManifest = JSON.parse(readConfinedRegularFile(path.join(runDir, 'children', 'lead-reproduction'), 'run_manifest.json').toString('utf8')) as BoundaryRunManifest;
  } catch (error) {
    return operationResult([{ code: 'review-parent-import-invalid', message: (error as Error).message }]);
  }
  if (sourceManifest.reviews.length !== 1) {
    return operationResult([{ code: 'review-source-cardinality-invalid', message: 'review child must contain exactly one source review' }]);
  }
  const source = sourceManifest.reviews[0]!;
  if (
    source.alias !== alias
    || source.dedupeKey !== contract.dedupeKey
    || source.head !== child.entryHead
    || source.head !== child.terminalHead
    || source.snapshotDigestSha256 !== child.snapshotDigestSha256
    || source.reviewId === ''
  ) {
    return operationResult([{ code: 'review-source-identity-mismatch', message: 'source review differs from its imported child contract' }]);
  }
  const sourceShape = { schemaVersion: 1, ...source } as Record<string, unknown>;
  delete sourceShape['alias'];
  const sourceValidation = validateBoundaryReviewInput(sourceShape);
  if (!sourceValidation.ok) return sourceValidation;
  const proofValidation = validateReviewProofContracts(source, leadManifest);
  if (!proofValidation.ok) return proofValidation;
  const prefix = `children/${alias}/`;
  const record: BoundaryReviewRecord = {
    ...structuredClone(source),
    reportPath: `${prefix}${source.reportPath}`,
    metaPath: `${prefix}${source.metaPath}`,
    stderrPath: `${prefix}${source.stderrPath}`,
    findings: source.findings.map((finding) => ({
      ...structuredClone(finding),
      evidencePath: `${prefix}${finding.evidencePath}`,
    })),
  };
  const recordShape = { schemaVersion: 1, ...record } as Record<string, unknown>;
  delete recordShape['alias'];
  const recordValidation = validateBoundaryReviewInput(recordShape);
  if (!recordValidation.ok) return recordValidation;
  loaded.manifest.reviews.push(record);
  loaded.manifest.reviews.sort((left, right) => Buffer.from(left.alias).compare(Buffer.from(right.alias)));
  const manifestValidation = validateBoundaryRun(loaded.manifest);
  if (!manifestValidation.ok) return manifestValidation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(loaded.manifest));
  return operationResult([]);
}

export function recordChildRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const alias = stringOption(invocation.options, 'alias')!;
  const kind = stringOption(invocation.options, 'kind')!;
  const childRunDir = stringOption(invocation.options, 'childRunDir')!;
  const expectTask = stringOption(invocation.options, 'expectTask')!;
  const expectHead = stringOption(invocation.options, 'expectHead')!;
  const expectRunId = stringOption(invocation.options, 'expectRunId')!;
  const expectManifestSha256 = stringOption(invocation.options, 'expectManifestSha256')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  const contract = childContractFor(manifest.run.profileId, alias);
  const dynamicPin = manifest.run.requiredChildPins.find((entry) => entry.alias === alias);
  if (
    contract === undefined
    || dynamicPin === undefined
    || kind !== contract.kind
    || expectTask !== contract.taskId
    || expectHead !== dynamicPin.head
    || expectRunId !== dynamicPin.runId
    || expectManifestSha256 !== dynamicPin.manifestSha256
  ) {
    return operationResult([{ code: 'child-declaration-mismatch', message: 'child declarations differ from the frozen profile pin' }], 2);
  }
  if (
    manifest.children.some((entry) => entry.alias === alias)
    || manifest.children.some((entry) => entry.runId === expectRunId || entry.sourceManifestSha256 === expectManifestSha256)
    || existsSync(path.join(runDir, 'children', alias))
  ) {
    return operationResult([{ code: 'child-alias-collision', message: 'child alias, run ID, or manifest digest was already imported' }], 2);
  }

  let sourceRoot: string;
  let sourceManifestBytes: Buffer;
  let childManifest: BoundaryRunManifest;
  let sourceRows: BoundaryImportedFileRecord[];
  let nestedDepth: number;
  try {
    sourceRoot = realpathSync(childRunDir);
    sourceManifestBytes = readConfinedRegularFile(sourceRoot, 'run_manifest.json');
    if (sha256(sourceManifestBytes) !== expectManifestSha256) {
      return operationResult([{ code: 'child-manifest-digest-mismatch', message: 'source manifest differs from the frozen digest' }], 2);
    }
    const sourceVerification = verifyRun({ command: 'verify', options: { runDir: sourceRoot } }, cwd);
    if (!sourceVerification.ok || sourceVerification.verdict !== 'Pass') {
      return operationResult([
        { code: 'child-source-verification-failed', message: 'source child did not pass read-only verification' },
        ...sourceVerification.issues,
      ]);
    }
    childManifest = JSON.parse(sourceManifestBytes.toString('utf8')) as BoundaryRunManifest;
    if (
      childManifest.manifestState !== 'finalized'
      || childManifest.overallVerdict !== 'Pass'
      || childManifest.run.taskId !== contract.taskId
      || childManifest.run.profileId !== contract.profileId
      || childManifest.run.runId !== dynamicPin.runId
      || childManifest.run.terminalHead === null
    ) {
      return operationResult([{ code: 'child-identity-mismatch', message: 'verified source identity differs from the profile contract' }], 2);
    }
    sourceRows = childClosureRows(sourceRoot, childManifest);
    nestedDepth = importedManifestDepth(childManifest, sourceRoot);
  } catch (error) {
    return operationResult([{ code: 'child-source-verification-failed', message: (error as Error).message }]);
  }

  const child: BoundaryChildRecord = {
    alias,
    kind: contract.kind,
    taskId: childManifest.run.taskId,
    profileId: childManifest.run.profileId,
    runId: childManifest.run.runId,
    entryHead: childManifest.run.entryHead,
    terminalHead: childManifest.run.terminalHead!,
    snapshotDigestSha256: childManifest.currentSnapshot.digestSha256,
    sourceManifestSha256: expectManifestSha256,
    importedFiles: sourceRows,
    treeDigestSha256: sha256(canonicalizeBoundaryRun(sourceRows)),
    overallVerdict: childManifest.overallVerdict,
    dedupeKey: contract.dedupeKey,
  };
  const preflight = validateBoundaryChildImport({
    parentRunId: manifest.run.runId,
    parentDepth: nestedDepth,
    maxDepth: contract.maxDepth,
    importRoot: sourceRoot,
    existingAliases: manifest.children.map((entry) => entry.alias),
    existingPaths: [],
    verifiedSourceManifestSha256: expectManifestSha256,
    pin: {
      alias,
      kind: contract.kind,
      taskId: contract.taskId,
      profileId: contract.profileId,
      runId: dynamicPin.runId,
      entryHead: child.entryHead,
      terminalHead: child.terminalHead,
      manifestSha256: dynamicPin.manifestSha256,
    },
    child,
  });
  const relationIssues = childRelationIssues(manifest, child, contract.headRelation, dynamicPin.head);
  const crossJoinIssues: BoundaryValidationIssue[] = [];
  if (manifest.run.profileId === 'bcf00-reconciliation') {
    const predecessorPin = manifest.predecessor?.pin;
    const completion = childManifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
    try {
      if (
        predecessorPin === undefined
        || completion === undefined
        || predecessorPin.taskId !== child.taskId
        || predecessorPin.profileId !== child.profileId
        || predecessorPin.runId !== child.runId
        || predecessorPin.terminalHead !== child.terminalHead
        || predecessorPin.manifestSha256 !== child.sourceManifestSha256
        || predecessorPin.completionReceiptSha256 !== sha256(readConfinedRegularFile(completion.path, 'completion_receipt.json'))
        || predecessorPin.ledgerSha256 !== sha256(readConfinedRegularFile(completion.path, 'chain_ledger.json'))
      ) {
        crossJoinIssues.push({ code: 'child-predecessor-pin-mismatch', message: 'observation child differs from the reconciliation predecessor pin' });
      }
    } catch (error) {
      crossJoinIssues.push({ code: 'child-predecessor-pin-mismatch', message: (error as Error).message });
    }
  }
  const preflightIssues = [...preflight.issues, ...relationIssues, ...crossJoinIssues];
  if (preflightIssues.length > 0) return operationResult(preflightIssues);

  const childrenRoot = path.join(runDir, 'children');
  const importRoot = path.join(childrenRoot, alias);
  try {
    if (!existsSync(childrenRoot)) mkdirSync(childrenRoot, { recursive: false, mode: 0o700 });
    const childrenStat = lstatSync(childrenRoot);
    if (childrenStat.isSymbolicLink() || !childrenStat.isDirectory()) throw new Error('children root is not a helper-owned directory');
    mkdirSync(importRoot, { recursive: false, mode: 0o700 });
    for (const row of sourceRows) {
      const destination = path.join(importRoot, row.path);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      durableExclusiveWrite(destination, readConfinedRegularFile(sourceRoot, row.path));
    }
    const copiedRows = childClosureRows(importRoot, childManifest);
    const copiedChild = {
      ...child,
      importedFiles: copiedRows,
      treeDigestSha256: sha256(canonicalizeBoundaryRun(copiedRows)),
    };
    const copiedValidation = validateBoundaryChildImport({
      parentRunId: manifest.run.runId,
      parentDepth: nestedDepth,
      maxDepth: contract.maxDepth,
      importRoot,
      existingAliases: manifest.children.map((entry) => entry.alias),
      existingPaths: [],
      verifiedSourceManifestSha256: expectManifestSha256,
      pin: {
        alias,
        kind: contract.kind,
        taskId: contract.taskId,
        profileId: contract.profileId,
        runId: dynamicPin.runId,
        entryHead: copiedChild.entryHead,
        terminalHead: copiedChild.terminalHead,
        manifestSha256: dynamicPin.manifestSha256,
      },
      child: copiedChild,
    });
    if (!copiedValidation.ok) return copiedValidation;
    const copiedManifestLock = readConfinedRegularFile(importRoot, 'run_manifest.sha256').toString('utf8');
    if (copiedManifestLock !== shaLockBytes(expectManifestSha256, 'run_manifest.json')) {
      return operationResult([{ code: 'child-manifest-lock-mismatch', message: 'copied manifest lock differs from the frozen digest' }]);
    }
    manifest.children = [...manifest.children, copiedChild]
      .sort((left, right) => Buffer.from(left.alias).compare(Buffer.from(right.alias)));
    const validation = validateBoundaryRun(manifest);
    if (!validation.ok) return validation;
    durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(manifest));
    return operationResult([], 0, 'Pass');
  } catch (error) {
    return operationResult([{ code: 'child-import-failed', message: (error as Error).message }]);
  }
}
