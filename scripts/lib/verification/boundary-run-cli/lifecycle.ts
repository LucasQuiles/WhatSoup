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
  childClosurePaths,
  childClosureRows,
  discoverEntryTestRoster,
  documentHash,
  durableAtomicRewrite,
  durableExclusiveWrite,
  gitPathSet,
  gitText,
  isPlainRecord,
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
  validateRecordedPredecessor,
  validateReviewProofContracts,
  verifyRunInitAnchor,
} from './shared.ts';

export function setUpstream(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  if (
    manifest.upstream.remoteUrl !== 'not-observed'
    || manifest.upstream.observedOid !== 'not-observed'
    || manifest.upstream.mergeBase !== 'not-observed'
  ) {
    return operationResult([{ code: 'upstream-already-set', message: 'upstream state is single-assignment' }], 2);
  }
  if (manifest.run.profileId !== 'bcf00-observation' && manifest.run.profileId !== 'bcf08-final') {
    return operationResult([{
      code: 'upstream-profile-unsupported',
      message: 'this profile requires predecessor or transition evidence before upstream derivation',
    }]);
  }
  const prefix = manifest.run.profileId === 'bcf08-final' ? 'final-upstream-' : 'upstream-';
  try {
    const remoteUrl = acceptedAttemptStdout(manifest, runDir, `${prefix}remote`).trim();
    const observedOid = acceptedAttemptStdout(manifest, runDir, `${prefix}origin-oid`).trim();
    const mergeBase = acceptedAttemptStdout(manifest, runDir, `${prefix}merge-base`).trim();
    const counts = acceptedAttemptStdout(manifest, runDir, `${prefix}ahead-behind`).trim().split(/\s+/);
    const remotePaths = parseNameStatusPaths(acceptedAttemptStdout(manifest, runDir, `${prefix}remote-diff`));
    const localPaths = parseNameStatusPaths(acceptedAttemptStdout(manifest, runDir, `${prefix}local-diff`));
    if (!/^git@[^:\s]+:[^\s]+$/.test(remoteUrl)) throw new Error('origin remote is not an SSH URL');
    if (!/^[0-9a-f]{40}$/.test(observedOid) || !/^[0-9a-f]{40}$/.test(mergeBase)) {
      throw new Error('upstream OID or merge base is malformed');
    }
    if (counts.length !== 2 || counts.some((value) => !/^\d+$/.test(value))) {
      throw new Error('ahead/behind result is malformed');
    }
    if (manifest.run.profileId === 'bcf00-observation') {
      const root = acceptedAttemptStdout(manifest, runDir, 'upstream-root').trim();
      const head = acceptedAttemptStdout(manifest, runDir, 'upstream-head').trim();
      acceptedAttemptStdout(manifest, runDir, 'upstream-status');
      acceptedAttemptStdout(manifest, runDir, 'upstream-fetch');
      acceptedAttemptStdout(manifest, runDir, 'merge-preview');
      if (root !== cwd || head !== manifest.run.entryHead) throw new Error('observation root or head differs from init');
    } else {
      acceptedAttemptStdout(manifest, runDir, 'final-upstream-refresh');
    }
    manifest.upstream = {
      remoteUrl,
      observedOid,
      mergeBase,
      behind: Number(counts[0]),
      ahead: Number(counts[1]),
      remotePaths,
      localPaths,
      observationManifestSha256: manifest.predecessor?.pin.manifestSha256 ?? 'not-observed',
      mergeCommit: 'not-observed',
      mergeParents: [],
    };
    const validation = validateBoundaryRun(manifest);
    if (!validation.ok) return validation;
    durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(manifest));
    return operationResult([]);
  } catch (error) {
    return operationResult([{ code: 'upstream-derivation-failed', message: (error as Error).message }]);
  }
}

export function aggregateRunVerdict(manifest: BoundaryRunManifest): BoundaryValidationResult['verdict'] {
  if (manifest.lifecycle.status === 'blocked' || manifest.lifecycle.finalGate === 'blocked') return 'Blocked';
  const requiredAttempts = manifest.run.requiredAttemptIds.map((id) => manifest.attempts.find((entry) => entry.id === id));
  const requiredChildren = manifest.run.requiredChildAliases.map((alias) => manifest.children.find((entry) => entry.alias === alias));
  if (
    manifest.lifecycle.finalGate === 'fail'
    || requiredAttempts.some((entry) => entry?.verdict === 'Fail')
    || requiredChildren.some((entry) => entry?.overallVerdict === 'Fail')
  ) return 'Fail';
  const reviewVerdict = aggregateReviewVerdict(manifest);
  if (reviewVerdict === 'Blocked') return 'Blocked';
  if (reviewVerdict === 'Fail') return 'Fail';
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (
    profile === undefined
    || manifest.lifecycle.status !== profile.terminalLifecycle
    || manifest.lifecycle.finalGate !== 'pass'
    || requiredAttempts.some((entry) => entry?.verdict !== 'Pass' || entry.expectationMet !== true)
    || requiredChildren.some((entry) => entry?.overallVerdict !== 'Pass')
    || reviewVerdict !== 'Pass'
  ) return 'Inconclusive';
  return 'Pass';
}

function aggregateReviewVerdict(manifest: BoundaryRunManifest): BoundaryValidationResult['verdict'] {
  const sourceContract = RUN_SOURCE_REVIEW_CONTRACTS[
    manifest.run.profileId as keyof typeof RUN_SOURCE_REVIEW_CONTRACTS
  ];
  if (sourceContract !== undefined) {
    return manifest.reviews.length === 1
      && manifest.reviews[0]!.alias === sourceContract.alias
      && manifest.reviews[0]!.dedupeKey === sourceContract.dedupeKey
      ? 'Pass'
      : 'Inconclusive';
  }
  if (manifest.run.profileId !== 'bcf08a-docs' && manifest.run.profileId !== 'bcf08-final') {
    return manifest.reviews.length === 0 ? 'Pass' : 'Inconclusive';
  }
  const requiredAliases = manifest.run.requiredChildAliases.filter((alias) => (
    childContractFor(manifest.run.profileId, alias)?.kind === 'review'
  ));
  const recordedAliases = manifest.reviews.map((review) => review.alias);
  if (canonicalizeBoundaryRun(canonicalSet(recordedAliases)) !== canonicalizeBoundaryRun(canonicalSet(requiredAliases))) return 'Inconclusive';
  return aggregateBoundaryReviewFindingVerdict(manifest.reviews);
}

function verifyRecordedStream(runDir: string, stream: { path: string; sha256: string; bytes: number }): BoundaryValidationIssue[] {
  try {
    const bytes = readFileSync(path.join(runDir, stream.path));
    return bytes.byteLength === stream.bytes && sha256(bytes) === stream.sha256
      ? []
      : [{ code: 'recorded-stream-drift', message: `recorded stream changed: ${stream.path}`, path: stream.path }];
  } catch (error) {
    return [{ code: 'recorded-stream-drift', message: (error as Error).message, path: stream.path }];
  }
}

export function verifyManifestEvidence(
  manifest: BoundaryRunManifest,
  runDir: string,
  cwd: string,
  requireComplete: boolean,
): BoundaryValidationIssue[] {
  const issues: BoundaryValidationIssue[] = [];
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (profile === undefined || profile.taskId !== manifest.run.taskId) {
    issues.push({ code: 'profile-contract-mismatch', message: 'manifest task/profile is not generated' });
  } else {
    if (canonicalizeBoundaryRun(manifest.run.requiredAttemptIds) !== canonicalizeBoundaryRun(profile.requiredAttemptIds)) {
      issues.push({ code: 'profile-contract-mismatch', message: 'required attempt set differs from the profile' });
    }
    const expectedAliases = (profile.requiredChildren as readonly string[]).map((entry) => entry.split(':', 1)[0]!);
    if (canonicalizeBoundaryRun(manifest.run.requiredChildAliases) !== canonicalizeBoundaryRun(expectedAliases)) {
      issues.push({ code: 'profile-contract-mismatch', message: 'required child set differs from the profile' });
    }
  }
  for (const row of Object.values(manifest.documentHashes)) {
    try {
      if (canonicalizeBoundaryRun(documentHash(cwd, row.path)) !== canonicalizeBoundaryRun(row)) {
        issues.push({ code: 'document-hash-drift', message: `document changed: ${row.path}`, path: row.path });
      }
    } catch (error) {
      issues.push({ code: 'document-hash-drift', message: (error as Error).message, path: row.path });
    }
  }
  for (const capability of manifest.run.observedTools) {
    try {
      if (canonicalizeBoundaryRun(resolveBoundaryToolCapability(capability.name)) !== canonicalizeBoundaryRun(capability)) {
        issues.push({ code: 'attempt-tool-capability-mismatch', message: `tool changed: ${capability.name}` });
      }
    } catch (error) {
      issues.push({ code: 'attempt-tool-capability-mismatch', message: (error as Error).message });
    }
  }
  const attemptIds = manifest.attempts.map((entry) => entry.id);
  if (new Set(attemptIds).size !== attemptIds.length) {
    issues.push({ code: 'attempt-duplicate', message: 'attempt IDs are not unique' });
  }
  if (requireComplete) {
    for (const id of manifest.run.requiredAttemptIds) {
      const matches = manifest.attempts.filter((entry) => entry.id === id);
      if (matches.length !== 1 || matches[0]!.verdict !== 'Pass' || !matches[0]!.expectationMet) {
        issues.push({ code: 'lifecycle-required-incomplete', message: `required attempt is missing or non-pass: ${id}` });
      }
    }
  }
  for (const attempt of manifest.attempts) {
    issues.push(...verifyRecordedStream(runDir, attempt.stdout), ...verifyRecordedStream(runDir, attempt.stderr));
    if (attempt.structuredResult !== null) issues.push(...verifyRecordedStream(runDir, attempt.structuredResult));
    issues.push(...validateBoundaryOutputClosure(runDir, attempt, manifest.artifacts).issues);
  }
  if (requireComplete) {
    for (const alias of manifest.run.requiredChildAliases) {
      const matches = manifest.children.filter((entry) => entry.alias === alias);
      if (matches.length !== 1 || matches[0]!.overallVerdict !== 'Pass') {
        issues.push({ code: 'lifecycle-required-incomplete', message: `required child is missing or non-pass: ${alias}` });
      }
    }
  }
  for (const child of manifest.children) {
    issues.push(...validateRecordedChild(manifest, runDir, child).issues);
  }
  issues.push(...verifyRecordedReviews(manifest, runDir, requireComplete));
  issues.push(...validateRecordedPredecessor(manifest, runDir).issues);
  const live = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  issues.push(...live.issues);
  if (live.snapshot !== null && canonicalizeBoundaryRun(live.snapshot) !== canonicalizeBoundaryRun(manifest.currentSnapshot)) {
    issues.push({ code: 'verification-snapshot-drift', message: 'live worktree differs from the current manifest snapshot' });
  }
  return issues;
}

export function verifyRecordedReviews(
  manifest: BoundaryRunManifest,
  runDir: string,
  requireComplete: boolean,
): BoundaryValidationIssue[] {
  const issues: BoundaryValidationIssue[] = [];
  for (const review of manifest.reviews) {
    const sourceShape = { schemaVersion: 1, ...review } as Record<string, unknown>;
    delete sourceShape['alias'];
    issues.push(...validateBoundaryReviewInput(sourceShape).issues);
    for (const [relativePath, digest] of [
      [review.reportPath, review.reportSha256],
      [review.metaPath, review.metaSha256],
      [review.stderrPath, review.stderrSha256],
      ...review.findings.map((finding) => [finding.evidencePath, finding.evidenceSha256]),
    ] as Array<[string, string]>) {
      try {
        if (sha256(readConfinedRegularFile(runDir, relativePath)) !== digest) {
          issues.push({ code: 'review-evidence-mismatch', message: `review evidence changed: ${relativePath}`, path: relativePath });
        }
      } catch (error) {
        issues.push({ code: 'review-evidence-invalid', message: (error as Error).message, path: relativePath });
      }
    }
  }
  const sourceContract = RUN_SOURCE_REVIEW_CONTRACTS[
    manifest.run.profileId as keyof typeof RUN_SOURCE_REVIEW_CONTRACTS
  ];
  if (sourceContract !== undefined) {
    if (
      manifest.reviews.length > 1
      || (requireComplete && manifest.reviews.length !== 1)
      || manifest.reviews.some((review) => review.alias !== sourceContract.alias || review.dedupeKey !== sourceContract.dedupeKey)
    ) {
      issues.push({ code: 'review-source-cardinality-invalid', message: 'source review profile requires its one exact role review' });
    }
    return issues;
  }
  const requiredAliases = manifest.run.requiredChildAliases.filter((alias) => (
    childContractFor(manifest.run.profileId, alias)?.kind === 'review'
  ));
  if (requiredAliases.length === 0) {
    if (manifest.reviews.length !== 0) issues.push({ code: 'review-profile-forbidden', message: 'profile does not accept review rows' });
    return issues;
  }
  const recordedAliases = manifest.reviews.map((review) => review.alias);
  if (
    recordedAliases.some((alias) => !requiredAliases.includes(alias))
    || (
      requireComplete
      && canonicalizeBoundaryRun(canonicalSet(recordedAliases)) !== canonicalizeBoundaryRun(canonicalSet(requiredAliases))
    )
  ) {
    issues.push({ code: 'review-parent-cardinality-invalid', message: 'parent review rows differ from the required role set' });
  }
  const lead = manifest.children.find((entry) => entry.alias === 'lead-reproduction');
  if (lead === undefined) {
    if (manifest.reviews.length > 0 || requireComplete) {
      issues.push({ code: 'review-parent-child-missing', message: 'lead reproduction child is unavailable' });
    }
    return issues;
  }
  let leadManifest: BoundaryRunManifest;
  try {
    leadManifest = JSON.parse(
      readConfinedRegularFile(path.join(runDir, 'children/lead-reproduction'), 'run_manifest.json').toString('utf8'),
    ) as BoundaryRunManifest;
  } catch (error) {
    issues.push({ code: 'review-parent-import-invalid', message: (error as Error).message });
    return issues;
  }
  for (const recorded of manifest.reviews) {
    try {
      const sourceManifest = JSON.parse(
        readConfinedRegularFile(path.join(runDir, 'children', recorded.alias), 'run_manifest.json').toString('utf8'),
      ) as BoundaryRunManifest;
      if (sourceManifest.reviews.length !== 1) {
        issues.push({ code: 'review-source-cardinality-invalid', message: `source review cardinality changed: ${recorded.alias}` });
        continue;
      }
      const source = sourceManifest.reviews[0]!;
      const prefix = `children/${recorded.alias}/`;
      const expected: BoundaryReviewRecord = {
        ...structuredClone(source),
        reportPath: `${prefix}${source.reportPath}`,
        metaPath: `${prefix}${source.metaPath}`,
        stderrPath: `${prefix}${source.stderrPath}`,
        findings: source.findings.map((finding) => ({
          ...structuredClone(finding),
          evidencePath: `${prefix}${finding.evidencePath}`,
        })),
      };
      if (canonicalizeBoundaryRun(expected) !== canonicalizeBoundaryRun(recorded)) {
        issues.push({ code: 'review-parent-binding-mismatch', message: `parent review row changed: ${recorded.alias}` });
      }
      issues.push(...validateReviewProofContracts(source, leadManifest).issues);
    } catch (error) {
      issues.push({ code: 'review-parent-import-invalid', message: (error as Error).message });
    }
  }
  return issues;
}

export function setLifecycle(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  const status = stringOption(invocation.options, 'status') as BoundaryRunManifest['lifecycle']['status'];
  const finalGate = stringOption(invocation.options, 'finalGate') as BoundaryRunManifest['lifecycle']['finalGate'];
  const oracle = stringOption(invocation.options, 'oracle') as BoundaryRunManifest['lifecycle']['oracle'];
  const artifactSha256 = stringOption(invocation.options, 'artifactSha256') ?? null;
  const successor = stringOption(invocation.options, 'successor') ?? null;
  const supersededBy = stringOption(invocation.options, 'supersededBy') ?? null;
  if (profile === undefined) return operationResult([{ code: 'profile-contract-mismatch', message: 'run profile is unknown' }]);
  if (manifest.lifecycle.status !== 'active' || manifest.lifecycle.finalGate !== 'not-run') {
    return operationResult([{ code: 'lifecycle-already-set', message: 'lifecycle is single-assignment' }], 2);
  }
  if (
    !['pending', 'active', 'completed', 'deferred', 'closed', 'blocked'].includes(status)
    || !['not-run', 'pass', 'fail', 'inconclusive', 'blocked'].includes(finalGate)
    || !['not-applicable', 'current', 'superseded-invalid-oracle'].includes(oracle)
    || (artifactSha256 !== null && !/^[0-9a-f]{64}$/.test(artifactSha256))
    || (successor !== null && !isSafeRelativePath(successor))
    || (supersededBy !== null && !isSafeRelativePath(supersededBy))
  ) {
    return operationResult([{ code: 'lifecycle-invalid', message: 'lifecycle values violate the closed contract' }], 2);
  }
  const live = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!live.ok || live.snapshot === null) return operationResult(live.issues);
  if (canonicalizeBoundaryRun(live.snapshot) !== canonicalizeBoundaryRun(manifest.currentSnapshot)) {
    return operationResult([{ code: 'verification-snapshot-drift', message: 'worktree changed before lifecycle transition' }]);
  }
  const terminalHead = gitText(cwd, ['rev-parse', 'HEAD']);
  if (profile.transition === null && terminalHead !== manifest.run.entryHead) {
    return operationResult([{ code: 'lifecycle-head-mismatch', message: 'no-transition profile advanced Git head' }]);
  }
  if (profile.transition !== null && manifest.run.transitionCount !== 1) {
    return operationResult([{ code: 'lifecycle-required-incomplete', message: 'required Git transition is missing' }]);
  }
  manifest.run.terminalHead = terminalHead;
  manifest.lifecycle = {
    status,
    completionCommit: status === 'completed' || status === 'closed' ? terminalHead : null,
    finalGate,
    artifactSha256,
    successor,
    supersededBy,
    oracle,
    branchDeletionAuthorized: false,
  };
  manifest.overallVerdict = aggregateRunVerdict(manifest);
  const readinessPending = manifest.run.profileId === 'bcf00-reconciliation'
    && status === 'completed'
    && finalGate === 'pass'
    && oracle === 'current'
    && !manifest.attempts.some((entry) => entry.id === 'readiness-check')
    && manifest.run.requiredAttemptIds
      .filter((id) => id !== 'readiness-check')
      .every((id) => {
        const attempt = manifest.attempts.find((entry) => entry.id === id);
        return attempt?.expectationMet === true && attempt.verdict === 'Pass';
      })
    && manifest.run.requiredChildAliases.every((alias) => {
      const child = manifest.children.find((entry) => entry.alias === alias);
      return child?.overallVerdict === 'Pass';
    });
  if (finalGate === 'pass' && manifest.overallVerdict !== 'Pass' && !readinessPending) {
    return operationResult([{
      code: 'lifecycle-required-incomplete',
      message: 'terminal Pass requires every profile-owned attempt and child to Pass',
    }]);
  }
  const validation = validateBoundaryRun(manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(manifest));
  return operationResult([], 0, manifest.overallVerdict);
}


interface BoundaryFinalCompletionCandidate {
  manifest: BoundaryRunManifest;
  manifestBytes: string;
  manifestSha256: string;
  manifestLock: string;
  ledger: Record<string, unknown>;
  ledgerBytes: string;
  ledgerSha256: string;
  ledgerLock: string;
  completionReceipt: Record<string, unknown>;
  completionReceiptBytes: string;
  completionReceiptSha256: string;
  completionReceiptLock: string;
}

export function buildFinalCompletionCandidate(
  sourceManifest: BoundaryRunManifest,
  runDir: string,
  cwd: string,
): { result: BoundaryValidationResult; candidate: BoundaryFinalCompletionCandidate | null } {
  const manifest = structuredClone(sourceManifest);
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (
    profile === undefined
    || manifest.run.taskId !== 'BCF-08C'
    || manifest.run.profileId !== 'bcf08-final'
    || manifest.overallVerdict !== 'Pass'
    || manifest.lifecycle.status !== profile.terminalLifecycle
    || manifest.lifecycle.finalGate !== 'pass'
    || manifest.run.terminalHead === null
    || manifest.predecessor === null
  ) {
    return {
      result: operationResult([{ code: 'closeout-run-nonpass', message: 'only one terminal BCF-08C Pass can close out' }]),
      candidate: null,
    };
  }
  const evidenceIssues = verifyManifestEvidence(manifest, runDir, cwd, true);
  if (evidenceIssues.length > 0) return { result: operationResult(evidenceIssues), candidate: null };
  try {
    const liveCorpusDigests = {
      cases: sha256(readFileSync(path.join(cwd, 'tests/fixtures/semantic-boundary-eval/cases.json'))),
      holdout: sha256(readFileSync(path.join(cwd, 'tests/fixtures/semantic-boundary-eval/holdout.json'))),
    };
    const liveOracleDigest = sha256(canonicalizeBoundaryRun(liveCorpusDigests));
    const predecessorRoot = path.join(runDir, 'predecessor', 'completion');
    const predecessorReceiptBytes = readConfinedRegularFile(predecessorRoot, 'completion_receipt.json');
    const predecessorLedgerBytes = readConfinedRegularFile(predecessorRoot, 'chain_ledger.json');
    const predecessorReceipt = strictCanonicalObject(predecessorReceiptBytes, 'predecessor completion receipt');
    const predecessorLedger = strictCanonicalObject(predecessorLedgerBytes, 'predecessor chain ledger');
    const predecessorReceiptSha256 = sha256(predecessorReceiptBytes);
    const predecessorLedgerSha256 = sha256(predecessorLedgerBytes);
    if (
      predecessorReceiptSha256 !== manifest.predecessor.pin.completionReceiptSha256
      || predecessorLedgerSha256 !== manifest.predecessor.pin.ledgerSha256
      || canonicalizeBoundaryRun(predecessorReceipt['corpusDigests']) !== canonicalizeBoundaryRun(liveCorpusDigests)
      || predecessorReceipt['oracleDigest'] !== liveOracleDigest
      || predecessorReceipt['reconciledBase'] !== manifest.run.reconciledBase
      || predecessorReceipt['upstreamObservedOid'] !== manifest.upstream.observedOid
    ) throw new Error('final predecessor, corpus, oracle, or upstream identity changed');
    manifest.manifestState = 'finalized';
    manifest.run.finalizedAtUtc = new Date().toISOString();
    const provisionalBytes = canonicalizeBoundaryRun(manifest);
    const provisionalSha256 = sha256(provisionalBytes);
    const predecessorRows = Array.isArray(predecessorLedger['rows']) ? predecessorLedger['rows'] : [];
    const currentRow = {
      ordinal: predecessorRows.length + 1,
      taskId: manifest.run.taskId,
      profileId: manifest.run.profileId,
      runId: manifest.run.runId,
      entryHead: manifest.run.entryHead,
      terminalHead: manifest.run.terminalHead,
      manifestSha256: provisionalSha256,
      previousLedgerSha256: predecessorLedgerSha256,
      overallVerdict: manifest.overallVerdict,
    };
    const appended = validateAndAppendBoundaryPredecessor({
      profileId: manifest.run.profileId,
      pin: manifest.predecessor.pin,
      receipt: predecessorReceipt,
      ledger: predecessorLedger,
      receiptSha256: predecessorReceiptSha256,
      ledgerSha256: predecessorLedgerSha256,
      inherited: {
        reconciledBase: manifest.run.reconciledBase,
        upstreamObservedOid: manifest.upstream.observedOid,
        corpusDigests: liveCorpusDigests,
        oracleDigest: liveOracleDigest,
      },
      currentRow,
    });
    if (!appended.result.ok || appended.ledger === null) return { result: appended.result, candidate: null };
    const manifestBytes = canonicalizeBoundaryRun(manifest);
    const manifestSha256 = sha256(manifestBytes);
    if (manifestSha256 !== provisionalSha256) throw new Error('final manifest identity changed during ledger construction');
    const manifestLock = shaLockBytes(manifestSha256, 'run_manifest.json');
    const ledger = appended.ledger;
    const ledgerBytes = canonicalizeBoundaryRun(ledger);
    const ledgerSha256 = sha256(ledgerBytes);
    const ledgerLock = shaLockBytes(ledgerSha256, 'chain_ledger.json');
    const completionReceipt = {
      schemaVersion: 1,
      taskId: manifest.run.taskId,
      profileId: manifest.run.profileId,
      runId: manifest.run.runId,
      entryHead: manifest.run.entryHead,
      terminalHead: manifest.run.terminalHead,
      manifestSha256,
      manifestLockSha256: sha256(manifestLock),
      ledgerSha256,
      predecessorReceiptSha256,
      predecessorLedgerSha256,
      reconciledBase: manifest.run.reconciledBase,
      upstreamObservedOid: manifest.upstream.observedOid,
      corpusDigests: liveCorpusDigests,
      oracleDigest: liveOracleDigest,
      lifecycleStatus: manifest.lifecycle.status,
      finalGate: manifest.lifecycle.finalGate,
      overallVerdict: manifest.overallVerdict,
    };
    const completionReceiptBytes = canonicalizeBoundaryRun(completionReceipt);
    const completionReceiptSha256 = sha256(completionReceiptBytes);
    return {
      result: operationResult([]),
      candidate: {
        manifest,
        manifestBytes,
        manifestSha256,
        manifestLock,
        ledger,
        ledgerBytes,
        ledgerSha256,
        ledgerLock,
        completionReceipt,
        completionReceiptBytes,
        completionReceiptSha256,
        completionReceiptLock: shaLockBytes(completionReceiptSha256, 'completion_receipt.json'),
      },
    };
  } catch (error) {
    return {
      result: operationResult([{ code: 'closeout-completion-failed', message: (error as Error).message }]),
      candidate: null,
    };
  }
}

export function finalizeRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (profile === undefined) return operationResult([{ code: 'profile-contract-mismatch', message: 'run profile is unknown' }]);
  if (manifest.run.profileId === 'bcf08-final') {
    return operationResult([{ code: 'finalize-profile-forbidden', message: 'BCF-08C may finalize only inside closeout' }], 2);
  }
  if (
    manifest.overallVerdict !== 'Pass'
    || manifest.lifecycle.status !== profile.terminalLifecycle
    || manifest.lifecycle.finalGate !== 'pass'
    || manifest.run.terminalHead === null
  ) {
    return operationResult([{ code: 'finalize-run-nonpass', message: 'only a profile-terminal Pass run may finalize' }]);
  }
  const evidenceIssues = verifyManifestEvidence(manifest, runDir, cwd, true);
  if (evidenceIssues.length > 0) return operationResult(evidenceIssues);
  if (manifest.upstream.observedOid === 'not-observed') {
    return operationResult([{ code: 'finalize-upstream-missing', message: 'observation upstream state is incomplete' }]);
  }
  try {
    const casesPath = path.join(cwd, 'tests/fixtures/semantic-boundary-eval/cases.json');
    const holdoutPath = path.join(cwd, 'tests/fixtures/semantic-boundary-eval/holdout.json');
    const liveCorpusDigests = {
      cases: sha256(readFileSync(casesPath)),
      holdout: sha256(readFileSync(holdoutPath)),
    };
    const liveOracleDigest = sha256(canonicalizeBoundaryRun(liveCorpusDigests));
    manifest.manifestState = 'finalized';
    manifest.run.finalizedAtUtc = new Date().toISOString();
    const manifestBytes = canonicalizeBoundaryRun(manifest);
    const manifestSha256 = sha256(manifestBytes);
    const manifestLock = shaLockBytes(manifestSha256, 'run_manifest.json');
    const isObservation = manifest.run.profileId === 'bcf00-observation';
    const isReconciliation = manifest.run.profileId === 'bcf00-reconciliation';
    let corpusDigests = liveCorpusDigests;
    let oracleDigest = liveOracleDigest;
    let predecessorReceiptSha256: string | null = null;
    let predecessorLedgerSha256: string | null = null;
    let ledger: Record<string, unknown>;
    if (isObservation) {
      ledger = {
        schemaVersion: 1,
        rows: [],
        reconciledBase: manifest.run.reconciledBase,
        upstreamObservedOid: manifest.upstream.observedOid,
        corpusDigests,
        oracleDigest,
      };
    } else if (isReconciliation) {
      if (
        manifest.run.reconciledBase === 'not-observed'
        || manifest.predecessor === null
        || manifest.predecessor.pin.profileId !== 'bcf00-observation'
        || manifest.children.length !== 1
        || manifest.children[0]?.alias !== 'upstream-observation'
        || manifest.children[0].runId !== manifest.predecessor.pin.runId
        || manifest.children[0].sourceManifestSha256 !== manifest.predecessor.pin.manifestSha256
      ) {
        return operationResult([{
          code: 'finalize-reconciliation-genesis-mismatch',
          message: 'BCF-00 genesis requires the exact observation predecessor and child identity',
        }]);
      }
      ledger = {
        schemaVersion: 1,
        rows: [{
          ordinal: 1,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          runId: manifest.run.runId,
          entryHead: manifest.run.entryHead,
          terminalHead: manifest.run.terminalHead,
          manifestSha256,
          previousLedgerSha256: null,
          overallVerdict: manifest.overallVerdict,
        }],
        reconciledBase: manifest.run.reconciledBase,
        upstreamObservedOid: manifest.upstream.observedOid,
        corpusDigests,
        oracleDigest,
      };
    } else {
      const predecessor = manifest.predecessor;
      if (predecessor === null) throw new Error('non-genesis completion requires a predecessor import');
      const predecessorRoot = path.join(runDir, 'predecessor', 'completion');
      const predecessorReceiptBytes = readConfinedRegularFile(predecessorRoot, 'completion_receipt.json');
      const predecessorLedgerBytes = readConfinedRegularFile(predecessorRoot, 'chain_ledger.json');
      const predecessorReceipt = strictCanonicalObject(predecessorReceiptBytes, 'predecessor completion receipt');
      const predecessorLedger = strictCanonicalObject(predecessorLedgerBytes, 'predecessor chain ledger');
      predecessorReceiptSha256 = sha256(predecessorReceiptBytes);
      predecessorLedgerSha256 = sha256(predecessorLedgerBytes);
      corpusDigests = predecessorReceipt['corpusDigests'] as typeof liveCorpusDigests;
      oracleDigest = String(predecessorReceipt['oracleDigest']);
      if (
        predecessorReceiptSha256 !== predecessor.pin.completionReceiptSha256
        || predecessorLedgerSha256 !== predecessor.pin.ledgerSha256
        || canonicalizeBoundaryRun(corpusDigests) !== canonicalizeBoundaryRun(liveCorpusDigests)
        || oracleDigest !== liveOracleDigest
        || predecessorReceipt['reconciledBase'] !== manifest.run.reconciledBase
        || predecessorReceipt['upstreamObservedOid'] !== manifest.upstream.observedOid
      ) {
        return operationResult([{
          code: 'finalize-inherited-drift',
          message: 'predecessor receipt, current corpus, or inherited reconciliation fields changed',
        }]);
      }
      if (manifest.run.chainAppend) {
        const predecessorRows = predecessorLedger['rows'];
        const ordinal = Array.isArray(predecessorRows) ? predecessorRows.length + 1 : 0;
        const currentRow = {
          ordinal,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          runId: manifest.run.runId,
          entryHead: manifest.run.entryHead,
          terminalHead: manifest.run.terminalHead,
          manifestSha256,
          previousLedgerSha256: predecessorLedgerSha256,
          overallVerdict: manifest.overallVerdict,
        };
        const appended = validateAndAppendBoundaryPredecessor({
          profileId: manifest.run.profileId,
          pin: predecessor.pin,
          receipt: predecessorReceipt,
          ledger: predecessorLedger,
          receiptSha256: predecessorReceiptSha256,
          ledgerSha256: predecessorLedgerSha256,
          inherited: {
            reconciledBase: manifest.run.reconciledBase,
            upstreamObservedOid: manifest.upstream.observedOid,
            corpusDigests,
            oracleDigest,
          },
          currentRow,
        });
        if (!appended.result.ok || appended.ledger === null) return appended.result;
        ledger = appended.ledger;
      } else {
        ledger = predecessorLedger;
      }
    }
    const ledgerBytes = canonicalizeBoundaryRun(ledger);
    const ledgerSha256 = sha256(ledgerBytes);
    const completionReceipt = {
      schemaVersion: 1,
      taskId: manifest.run.taskId,
      profileId: manifest.run.profileId,
      runId: manifest.run.runId,
      entryHead: manifest.run.entryHead,
      terminalHead: manifest.run.terminalHead,
      manifestSha256,
      manifestLockSha256: sha256(manifestLock),
      ledgerSha256,
      predecessorReceiptSha256,
      predecessorLedgerSha256,
      reconciledBase: manifest.run.reconciledBase,
      upstreamObservedOid: manifest.upstream.observedOid,
      corpusDigests,
      oracleDigest,
      lifecycleStatus: manifest.lifecycle.status,
      finalGate: manifest.lifecycle.finalGate,
      overallVerdict: manifest.overallVerdict,
    };
    const completionReceiptBytes = canonicalizeBoundaryRun(completionReceipt);
    const completionReceiptSha256 = sha256(completionReceiptBytes);
    const completionRecord = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
    if (completionRecord === undefined) throw new Error('completion root reservation is missing');
    const evidenceRoot = path.dirname(path.dirname(runDir));
    const completionReservation = reserveBoundaryDerivedRoot({
      evidenceRoot,
      parentSegments: ['completion'],
      runId: manifest.run.runId,
      kind: 'completion',
      protectedPaths: [
        ...manifest.run.allowedPaths,
        ...manifest.run.allowedUntrackedPaths,
        ...manifest.run.preservedOwnerPaths,
      ].map((entry) => path.join(cwd, entry)),
    });
    if (!completionReservation.ok || completionReservation.reservation === null) {
      return operationResult(completionReservation.issues);
    }
    if (
      completionReservation.reservation.path !== completionRecord.path
      || completionReservation.reservation.parentDevice !== completionRecord.parentDevice
      || completionReservation.reservation.parentInode !== completionRecord.parentInode
    ) throw new Error('completion root reservation identity changed');
    durableAtomicRewrite(loaded.path, manifestBytes);
    durableExclusiveWrite(path.join(runDir, 'run_manifest.sha256'), manifestLock);
    const created = createBoundaryDerivedRoot(completionReservation.reservation);
    if (!created.ok) return operationResult(created.issues);
    const completionDir = completionReservation.reservation.path;
    durableExclusiveWrite(path.join(completionDir, 'chain_ledger.json'), ledgerBytes);
    durableExclusiveWrite(path.join(completionDir, 'chain_ledger.sha256'), shaLockBytes(ledgerSha256, 'chain_ledger.json'));
    durableExclusiveWrite(path.join(completionDir, 'completion_receipt.json'), completionReceiptBytes);
    durableExclusiveWrite(
      path.join(completionDir, 'completion_receipt.sha256'),
      shaLockBytes(completionReceiptSha256, 'completion_receipt.json'),
    );
    return operationResult([], 0, 'Pass');
  } catch (error) {
    return operationResult([{ code: 'finalize-failed', message: (error as Error).message }]);
  }
}

export function verifyRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  try {
    const bytes = readFileSync(path.join(runDir, 'run_manifest.json'));
    const structural = validateBoundaryRunJson(bytes);
    if (!structural.ok) return structural;
    const manifest = JSON.parse(bytes.toString('utf8')) as BoundaryRunManifest;
    const issues = [
      ...verifyRunInitAnchor(manifest, runDir).issues,
      ...verifyManifestEvidence(manifest, runDir, cwd, manifest.manifestState !== 'active'),
    ];
    if (invocation.options['expectStagedAllowlist'] === true) {
      const staged = gitPathSet(cwd, ['diff', '--cached', '--name-only', '--']);
      if (canonicalizeBoundaryRun(staged) !== canonicalizeBoundaryRun(manifest.run.allowedPaths)) {
        issues.push({ code: 'verification-staged-allowlist-mismatch', message: 'staged paths differ from the profile allowlist' });
      }
    }
    if (manifest.manifestState === 'active') {
      if (existsSync(path.join(runDir, 'run_manifest.sha256'))) {
        issues.push({ code: 'active-final-file', message: 'active run contains a final manifest lock' });
      }
      const completion = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
      if (completion !== undefined && existsSync(completion.path)) {
        issues.push({ code: 'active-final-file', message: 'active run contains a completion bundle' });
      }
      return operationResult(issues, issues.length === 0 ? 0 : 1, 'Inconclusive');
    }
    const manifestDigest = sha256(bytes);
    const manifestLockPath = path.join(runDir, 'run_manifest.sha256');
    const manifestLock = readFileSync(manifestLockPath, 'utf8');
    if (manifestLock !== shaLockBytes(manifestDigest, 'run_manifest.json')) {
      issues.push({ code: 'manifest-lock-mismatch', message: 'run manifest lock differs from finalized bytes' });
    }
    const completion = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
    if (completion === undefined || !existsSync(completion.path)) {
      issues.push({ code: 'completion-missing', message: 'completion bundle is unavailable' });
    } else {
      const expectedFiles = [
        'chain_ledger.json', 'chain_ledger.sha256', 'completion_receipt.json', 'completion_receipt.sha256',
      ];
      if (canonicalizeBoundaryRun(readdirSync(completion.path).sort()) !== canonicalizeBoundaryRun(expectedFiles.sort())) {
        issues.push({ code: 'completion-file-set-mismatch', message: 'completion bundle file set is not closed' });
      }
      const ledgerBytes = readFileSync(path.join(completion.path, 'chain_ledger.json'));
      const receiptBytes = readFileSync(path.join(completion.path, 'completion_receipt.json'));
      const ledgerDigest = sha256(ledgerBytes);
      const receiptDigest = sha256(receiptBytes);
      if (readFileSync(path.join(completion.path, 'chain_ledger.sha256'), 'utf8') !== shaLockBytes(ledgerDigest, 'chain_ledger.json')) {
        issues.push({ code: 'ledger-lock-mismatch', message: 'chain ledger lock differs from ledger bytes' });
      }
      if (readFileSync(path.join(completion.path, 'completion_receipt.sha256'), 'utf8') !== shaLockBytes(receiptDigest, 'completion_receipt.json')) {
        issues.push({ code: 'completion-receipt-lock-mismatch', message: 'completion receipt lock differs from receipt bytes' });
      }
      const ledgerParsed = parseBoundaryJsonBytes(ledgerBytes);
      const receiptParsed = parseBoundaryJsonBytes(receiptBytes);
      issues.push(...ledgerParsed.result.issues, ...receiptParsed.result.issues);
      if (
        ledgerParsed.text !== null
        && ledgerParsed.text !== canonicalizeBoundaryRun(ledgerParsed.value)
      ) issues.push({ code: 'completion-noncanonical-json', message: 'chain ledger is not canonical JSON' });
      if (
        receiptParsed.text !== null
        && receiptParsed.text !== canonicalizeBoundaryRun(receiptParsed.value)
      ) issues.push({ code: 'completion-noncanonical-json', message: 'completion receipt is not canonical JSON' });
      const ledger = ledgerParsed.value as Record<string, unknown> | null;
      const receipt = receiptParsed.value as Record<string, unknown> | null;
      const exactKeys = (value: Record<string, unknown> | null, expected: readonly string[]): boolean => value !== null
        && canonicalizeBoundaryRun(Object.keys(value).sort()) === canonicalizeBoundaryRun([...expected].sort());
      if (!exactKeys(ledger, RUN_WIRE_SCHEMAS.ChainLedger) || !exactKeys(receipt, RUN_WIRE_SCHEMAS.CompletionReceipt)) {
        issues.push({ code: 'completion-schema-mismatch', message: 'completion object keys differ from schema 1' });
      } else if (
        receipt!['runId'] !== manifest.run.runId
        || receipt!['taskId'] !== manifest.run.taskId
        || receipt!['profileId'] !== manifest.run.profileId
        || receipt!['manifestSha256'] !== manifestDigest
        || receipt!['manifestLockSha256'] !== sha256(manifestLock)
        || receipt!['ledgerSha256'] !== ledgerDigest
        || receipt!['overallVerdict'] !== manifest.overallVerdict
        || receipt!['terminalHead'] !== manifest.run.terminalHead
      ) {
        issues.push({ code: 'completion-identity-mismatch', message: 'completion receipt differs from the finalized run' });
      }
      if (manifest.run.profileId === 'bcf00-observation' && (!Array.isArray(ledger?.['rows']) || ledger['rows'].length !== 0)) {
        issues.push({ code: 'completion-ledger-mismatch', message: 'observation completion requires the canonical empty ledger' });
      }
      if (
        ledger !== null
        && receipt !== null
        && (
          ledger['reconciledBase'] !== receipt['reconciledBase']
          || ledger['upstreamObservedOid'] !== receipt['upstreamObservedOid']
          || canonicalizeBoundaryRun(ledger['corpusDigests']) !== canonicalizeBoundaryRun(receipt['corpusDigests'])
          || ledger['oracleDigest'] !== receipt['oracleDigest']
          || receipt['reconciledBase'] !== manifest.run.reconciledBase
          || receipt['upstreamObservedOid'] !== manifest.upstream.observedOid
        )
      ) {
        issues.push({ code: 'completion-ledger-mismatch', message: 'completion receipt and ledger inherited fields differ' });
      }
      if (manifest.run.profileId === 'bcf00-reconciliation' && ledger !== null && receipt !== null) {
        const expectedRows = [{
          ordinal: 1,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          runId: manifest.run.runId,
          entryHead: manifest.run.entryHead,
          terminalHead: manifest.run.terminalHead,
          manifestSha256: manifestDigest,
          previousLedgerSha256: null,
          overallVerdict: manifest.overallVerdict,
        }];
        if (
          canonicalizeBoundaryRun(ledger['rows']) !== canonicalizeBoundaryRun(expectedRows)
          || receipt['predecessorReceiptSha256'] !== null
          || receipt['predecessorLedgerSha256'] !== null
        ) {
          issues.push({ code: 'completion-ledger-mismatch', message: 'reconciliation completion is not the sole BCF-00 genesis' });
        }
      }
      if (
        manifest.run.profileId !== 'bcf00-observation'
        && manifest.run.profileId !== 'bcf00-reconciliation'
        && ledger !== null
        && receipt !== null
      ) {
        const predecessor = manifest.predecessor;
        if (predecessor === null) {
          issues.push({ code: 'completion-ledger-mismatch', message: 'non-genesis completion lacks its predecessor' });
        } else {
          try {
            const predecessorRoot = path.join(runDir, 'predecessor', 'completion');
            const predecessorReceiptBytes = readConfinedRegularFile(predecessorRoot, 'completion_receipt.json');
            const predecessorLedgerBytes = readConfinedRegularFile(predecessorRoot, 'chain_ledger.json');
            const predecessorReceipt = strictCanonicalObject(predecessorReceiptBytes, 'predecessor completion receipt');
            const predecessorLedger = strictCanonicalObject(predecessorLedgerBytes, 'predecessor chain ledger');
            const predecessorReceiptDigest = sha256(predecessorReceiptBytes);
            const predecessorLedgerDigest = sha256(predecessorLedgerBytes);
            let chainValid = receipt['predecessorReceiptSha256'] === predecessorReceiptDigest
              && receipt['predecessorLedgerSha256'] === predecessorLedgerDigest
              && predecessorReceiptDigest === predecessor.pin.completionReceiptSha256
              && predecessorLedgerDigest === predecessor.pin.ledgerSha256;
            if (manifest.run.chainAppend) {
              const predecessorRows = predecessorLedger['rows'];
              const currentRow = {
                ordinal: Array.isArray(predecessorRows) ? predecessorRows.length + 1 : 0,
                taskId: manifest.run.taskId,
                profileId: manifest.run.profileId,
                runId: manifest.run.runId,
                entryHead: manifest.run.entryHead,
                terminalHead: manifest.run.terminalHead,
                manifestSha256: manifestDigest,
                previousLedgerSha256: predecessorLedgerDigest,
                overallVerdict: manifest.overallVerdict,
              };
              const appended = validateAndAppendBoundaryPredecessor({
                profileId: manifest.run.profileId,
                pin: predecessor.pin,
                receipt: predecessorReceipt,
                ledger: predecessorLedger,
                receiptSha256: predecessorReceiptDigest,
                ledgerSha256: predecessorLedgerDigest,
                inherited: {
                  reconciledBase: receipt['reconciledBase'],
                  upstreamObservedOid: receipt['upstreamObservedOid'],
                  corpusDigests: receipt['corpusDigests'],
                  oracleDigest: receipt['oracleDigest'],
                },
                currentRow,
              });
              chainValid = chainValid
                && appended.result.ok
                && appended.ledger !== null
                && canonicalizeBoundaryRun(appended.ledger) === canonicalizeBoundaryRun(ledger);
            } else {
              chainValid = chainValid
                && canonicalizeBoundaryRun(predecessorLedger) === canonicalizeBoundaryRun(ledger);
            }
            if (!chainValid) {
              issues.push({ code: 'completion-ledger-mismatch', message: 'completion ledger does not exactly extend or preserve its predecessor' });
            }
          } catch (error) {
            issues.push({ code: 'completion-ledger-mismatch', message: (error as Error).message });
          }
        }
      }
    }
    return operationResult(
      issues,
      issues.length === 0 ? 0 : 1,
      issues.length === 0 ? manifest.overallVerdict : 'Inconclusive',
    );
  } catch (error) {
    return operationResult([{ code: 'verify-failed', message: (error as Error).message }]);
  }
}
