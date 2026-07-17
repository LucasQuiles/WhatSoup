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
  verifyRunInitAnchor,
} from './shared.ts';

import { buildFinalCompletionCandidate, verifyManifestEvidence } from './lifecycle.ts';

function exactObjectKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

export interface BoundaryCloseoutControlClosure {
  manifest: BoundaryRunManifest;
  closeoutCore: Record<string, unknown>;
  completionReceipt: Record<string, unknown> | null;
  ledger: Record<string, unknown> | null;
}

export function validateBoundaryCloseoutControlClosure(
  closure: BoundaryCloseoutControlClosure,
  base: BoundaryCloseoutControlClosure,
): BoundaryValidationResult {
  const artifactIdentity = (manifest: BoundaryRunManifest) => manifest.artifacts.map((entry) => ({
    path: entry.path, producerAttemptId: entry.producerAttemptId, role: entry.role,
  }));
  const artifactBytes = (manifest: BoundaryRunManifest) => manifest.artifacts.map((entry) => ({
    path: entry.path, sha256: entry.sha256, bytes: entry.bytes,
  }));
  if (canonicalizeBoundaryRun(artifactIdentity(closure.manifest)) !== canonicalizeBoundaryRun(artifactIdentity(base.manifest))) {
    return operationResult([{ code: 'foreign-artifact', message: 'artifact identity set differs from the accepted closure' }]);
  }
  if (canonicalizeBoundaryRun(artifactBytes(closure.manifest)) !== canonicalizeBoundaryRun(artifactBytes(base.manifest))) {
    return operationResult([{ code: 'artifact-byte-mutation', message: 'artifact byte identity differs from the accepted closure' }]);
  }
  if (closure.manifest.run.terminalHead !== base.manifest.run.terminalHead) {
    return operationResult([{ code: 'head-mismatch', message: 'terminal head differs from the accepted closure' }]);
  }
  if (closure.manifest.currentSnapshot.digestSha256 !== base.manifest.currentSnapshot.digestSha256) {
    return operationResult([{ code: 'diff-mismatch', message: 'worktree diff identity differs from the accepted closure' }]);
  }
  if (canonicalizeBoundaryRun(closure.manifest.children) !== canonicalizeBoundaryRun(base.manifest.children)) {
    return operationResult([{ code: 'missing-child-receipt', message: 'required child receipt closure differs from the accepted closure' }]);
  }
  if (canonicalizeBoundaryRun(closure.manifest) !== canonicalizeBoundaryRun(base.manifest)) {
    return operationResult([{ code: 'changed-manifest', message: 'manifest differs from the accepted closure' }]);
  }
  const internalStatus = closure.closeoutCore['internalStatus'];
  if (
    Array.isArray(internalStatus)
    && internalStatus.some((entry) => isPlainRecord(entry)
      && (entry['rawExit'] !== 0 || entry['rawSignal'] !== null || entry['expectationMet'] !== true || entry['verdict'] !== 'Pass'))
  ) return operationResult([{ code: 'forged-internal-status', message: 'closeout internal status is not a direct Pass' }]);
  if (canonicalizeBoundaryRun(closure.closeoutCore) !== canonicalizeBoundaryRun(base.closeoutCore)) {
    return operationResult([{ code: 'substituted-core', message: 'closeout core differs from the accepted closure' }]);
  }
  if (closure.completionReceipt === null) {
    return operationResult([{ code: 'missing-completion-receipt', message: 'completion receipt is missing' }]);
  }
  if (canonicalizeBoundaryRun(closure.completionReceipt) !== canonicalizeBoundaryRun(base.completionReceipt)) {
    return operationResult([{ code: 'changed-completion-receipt', message: 'completion receipt differs from the accepted closure' }]);
  }
  if (closure.ledger === null || canonicalizeBoundaryRun(closure.ledger) !== canonicalizeBoundaryRun(base.ledger)) {
    return operationResult([{ code: 'changed-chain-ledger', message: 'chain ledger differs from the accepted closure' }]);
  }
  const structural = validateBoundaryRun(closure.manifest);
  if (!structural.ok) return structural;
  return operationResult([], 0, 'Pass');
}

function ensureReservedParent(record: BoundaryReservedDerivedRootRecord): string {
  const parent = realpathSync(path.dirname(record.path));
  const stat = lstatSync(parent);
  if (
    stat.isSymbolicLink()
    || Number(stat.dev) !== record.parentDevice
    || Number(stat.ino) !== record.parentInode
    || path.join(parent, path.basename(record.path)) !== record.path
  ) throw new Error(`reserved ${record.kind} parent identity changed`);
  return parent;
}

function writeRejectedCloseout(
  manifest: BoundaryRunManifest,
  runDir: string,
  attemptId: string,
  failedStage: string,
  reasonCode: string,
): BoundaryValidationResult {
  try {
    const record = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'closeout-failure');
    if (record === undefined) throw new Error('closeout failure root reservation is unavailable');
    ensureReservedParent(record);
    if (!existsSync(record.path)) mkdirSync(record.path, { recursive: false, mode: 0o700 });
    const attemptDir = path.join(record.path, attemptId);
    if (!existsSync(attemptDir)) mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
    if (existsSync(path.join(attemptDir, 'closeout_receipt.json'))) throw new Error('closeout rejection attempt already has a receipt');
    const manifestBytes = readFileSync(path.join(runDir, 'run_manifest.json'));
    const receipt = {
      schemaVersion: 1,
      kind: 'rejected',
      runId: manifest.run.runId,
      taskId: manifest.run.taskId,
      profileId: manifest.run.profileId,
      terminalHead: manifest.run.terminalHead,
      snapshotDigestSha256: manifest.currentSnapshot.digestSha256,
      helperCommit: manifest.run.helperCommit,
      helperSha256: manifest.run.helperSha256,
      runManifestSha256: sha256(manifestBytes),
      runManifestLockSha256: existsSync(path.join(runDir, 'run_manifest.sha256'))
        ? sha256(readFileSync(path.join(runDir, 'run_manifest.sha256')))
        : null,
      finalizeRawExit: 1,
      finalizeRawSignal: null,
      verifyRawExit: null,
      verifyRawSignal: null,
      completionReceiptSha256: null,
      completionReceiptLockSha256: null,
      ledgerSha256: null,
      ledgerLockSha256: null,
      startedAtUtc: new Date().toISOString(),
      endedAtUtc: new Date().toISOString(),
      lifecycleStatus: manifest.lifecycle.status,
      requiredAttemptIds: manifest.run.requiredAttemptIds,
      requiredChildAliases: manifest.run.requiredChildAliases,
      closeoutCoreSha256: null,
      negativeControlReportSha256: null,
      failedStage,
      runVerdict: manifest.overallVerdict,
      rawExit: 1,
      rawSignal: null,
      reasonCode,
      manifestState: manifest.manifestState,
      overallVerdict: 'Inconclusive',
    };
    const bytes = canonicalizeBoundaryRun(receipt);
    durableExclusiveWrite(path.join(attemptDir, 'closeout_receipt.json'), bytes);
    durableExclusiveWrite(
      path.join(attemptDir, 'closeout_receipt.sha256'),
      shaLockBytes(sha256(bytes), 'closeout_receipt.json'),
    );
    return operationResult([{ code: reasonCode, message: `closeout rejected at ${failedStage}` }]);
  } catch (error) {
    return operationResult([{ code: 'closeout-rejection-write-failed', message: (error as Error).message }]);
  }
}

export function closeoutRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const attemptId = stringOption(invocation.options, 'attemptId')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  if (manifest.run.taskId !== 'BCF-08C' || manifest.run.profileId !== 'bcf08-final') {
    return operationResult([{ code: 'closeout-profile-forbidden', message: 'closeout accepts only BCF-08C/bcf08-final' }], 2);
  }
  const closeoutRecord = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'closeout');
  const failureRecord = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'closeout-failure');
  if (closeoutRecord === undefined || failureRecord === undefined) {
    return operationResult([{ code: 'closeout-reservation-missing', message: 'final run lacks its derived closeout roots' }]);
  }
  if (existsSync(closeoutRecord.path) || existsSync(path.join(failureRecord.path, attemptId))) {
    return operationResult([{ code: 'closeout-attempt-reused', message: 'closeout attempt or accepted destination already exists' }], 2);
  }
  const built = buildFinalCompletionCandidate(manifest, runDir, cwd);
  if (!built.result.ok || built.candidate === null) {
    const reason = built.result.issues[0]?.code ?? 'closeout-completion-failed';
    writeRejectedCloseout(manifest, runDir, attemptId, 'completion', reason);
    return built.result;
  }
  const candidate = built.candidate;
  const startedAtUtc = new Date().toISOString();
  const internalStatus = [
    { stage: 'finalize', rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' },
    { stage: 'verify', rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' },
  ];
  const closeoutCore = {
    schemaVersion: 1,
    runId: candidate.manifest.run.runId,
    taskId: candidate.manifest.run.taskId,
    profileId: candidate.manifest.run.profileId,
    terminalHead: candidate.manifest.run.terminalHead,
    snapshotDigestSha256: candidate.manifest.currentSnapshot.digestSha256,
    helperCommit: candidate.manifest.run.helperCommit,
    helperSha256: candidate.manifest.run.helperSha256,
    runManifestSha256: candidate.manifestSha256,
    runManifestLockSha256: sha256(candidate.manifestLock),
    finalizeRawExit: 0,
    finalizeRawSignal: null,
    verifyRawExit: 0,
    verifyRawSignal: null,
    completionReceiptSha256: candidate.completionReceiptSha256,
    completionReceiptLockSha256: sha256(candidate.completionReceiptLock),
    ledgerSha256: candidate.ledgerSha256,
    ledgerLockSha256: sha256(candidate.ledgerLock),
    startedAtUtc,
    endedAtUtc: new Date().toISOString(),
    lifecycleStatus: candidate.manifest.lifecycle.status,
    requiredAttemptIds: candidate.manifest.run.requiredAttemptIds,
    requiredChildAliases: candidate.manifest.run.requiredChildAliases,
    internalStatus,
    overallVerdict: 'Pass',
  };
  const closeoutCoreBytes = canonicalizeBoundaryRun(closeoutCore);
  const closeoutCoreSha256 = sha256(closeoutCoreBytes);
  try {
    ensureReservedParent(failureRecord);
    if (!existsSync(failureRecord.path)) mkdirSync(failureRecord.path, { recursive: false, mode: 0o700 });
    const controlRoot = path.join(failureRecord.path, attemptId);
    mkdirSync(controlRoot, { recursive: false, mode: 0o700 });
    const mutationIds = [
      'foreign-artifact', 'artifact-byte-mutation', 'head-mismatch', 'diff-mismatch',
      'missing-child-receipt', 'changed-manifest', 'substituted-core',
      'missing-completion-receipt', 'changed-completion-receipt', 'changed-chain-ledger',
      'forged-internal-status',
    ];
    const baseClosure: BoundaryCloseoutControlClosure = {
      manifest: candidate.manifest,
      closeoutCore,
      completionReceipt: candidate.completionReceipt,
      ledger: candidate.ledger,
    };
    const unchanged = validateBoundaryCloseoutControlClosure(structuredClone(baseClosure), baseClosure);
    if (!unchanged.ok) throw new Error(`unchanged closeout control failed: ${unchanged.issues[0]?.code ?? 'unknown'}`);
    const negativeCases = mutationIds.map((mutationId, index) => {
      const fixturePath = `controls/${String(index + 1).padStart(2, '0')}-${mutationId}.json`;
      const mutated = structuredClone(baseClosure);
      switch (mutationId) {
        case 'foreign-artifact': {
          const source = mutated.manifest.artifacts[0];
          if (source === undefined) throw new Error('negative matrix requires at least one admitted artifact');
          mutated.manifest.artifacts.push({ ...source, path: `foreign/${path.basename(source.path)}` });
          break;
        }
        case 'artifact-byte-mutation': {
          const source = mutated.manifest.artifacts[0];
          if (source === undefined) throw new Error('negative matrix requires at least one admitted artifact');
          source.sha256 = source.sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
          break;
        }
        case 'head-mismatch':
          mutated.manifest.run.terminalHead = '0'.repeat(40);
          break;
        case 'diff-mismatch':
          mutated.manifest.currentSnapshot.digestSha256 = '0'.repeat(64);
          break;
        case 'missing-child-receipt':
          mutated.manifest.children = mutated.manifest.children.slice(1);
          break;
        case 'changed-manifest':
          mutated.manifest.run.createdAtUtc = new Date(Date.parse(mutated.manifest.run.createdAtUtc) + 1).toISOString();
          break;
        case 'substituted-core':
          mutated.closeoutCore['helperSha256'] = '0'.repeat(64);
          break;
        case 'missing-completion-receipt':
          mutated.completionReceipt = null;
          break;
        case 'changed-completion-receipt':
          mutated.completionReceipt!['oracleDigest'] = '0'.repeat(64);
          break;
        case 'changed-chain-ledger':
          mutated.ledger!['oracleDigest'] = '0'.repeat(64);
          break;
        case 'forged-internal-status':
          (mutated.closeoutCore['internalStatus'] as Array<Record<string, unknown>>)[0]!['rawExit'] = 1;
          break;
      }
      const controlResult = validateBoundaryCloseoutControlClosure(mutated, baseClosure);
      if (controlResult.ok || controlResult.issues[0]?.code !== mutationId) {
        throw new Error(`negative control ${mutationId} produced ${controlResult.issues[0]?.code ?? 'Pass'}`);
      }
      const fixture = {
        schemaVersion: 1,
        mutationId,
        baseManifestSha256: candidate.manifestSha256,
        baseCoreSha256: closeoutCoreSha256,
        closure: mutated,
      };
      const bytes = canonicalizeBoundaryRun(fixture);
      const destination = path.join(controlRoot, fixturePath);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      durableExclusiveWrite(destination, bytes);
      return {
        ordinal: index + 1,
        mutationId,
        fixturePath,
        expectedReasonCode: controlResult.issues[0].code,
        rawExit: controlResult.exitCode,
        rawSignal: null,
        expectationMet: controlResult.exitCode !== 0,
        stdoutSha256: sha256(''),
        stderrSha256: sha256(`${controlResult.issues[0].code}\n`),
        treeDigestSha256: sha256(bytes),
        verdict: 'Pass',
      };
    });
    const negativeReport = {
      schemaVersion: 1,
      runId: candidate.manifest.run.runId,
      closeoutCoreSha256,
      cases: negativeCases,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      overallVerdict: 'Pass',
    };
    const negativeReportBytes = canonicalizeBoundaryRun(negativeReport);
    const negativeControlReportSha256 = sha256(negativeReportBytes);
    durableExclusiveWrite(path.join(controlRoot, 'closeout_core.json'), closeoutCoreBytes);
    durableExclusiveWrite(path.join(controlRoot, 'negative_control_report.json'), negativeReportBytes);
    const receipt = {
      schemaVersion: 1,
      kind: 'accepted',
      runId: candidate.manifest.run.runId,
      taskId: candidate.manifest.run.taskId,
      profileId: candidate.manifest.run.profileId,
      terminalHead: candidate.manifest.run.terminalHead,
      snapshotDigestSha256: candidate.manifest.currentSnapshot.digestSha256,
      helperCommit: candidate.manifest.run.helperCommit,
      helperSha256: candidate.manifest.run.helperSha256,
      runManifestSha256: candidate.manifestSha256,
      runManifestLockSha256: sha256(candidate.manifestLock),
      finalizeRawExit: 0,
      finalizeRawSignal: null,
      verifyRawExit: 0,
      verifyRawSignal: null,
      completionReceiptSha256: candidate.completionReceiptSha256,
      completionReceiptLockSha256: sha256(candidate.completionReceiptLock),
      ledgerSha256: candidate.ledgerSha256,
      ledgerLockSha256: sha256(candidate.ledgerLock),
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      lifecycleStatus: candidate.manifest.lifecycle.status,
      requiredAttemptIds: candidate.manifest.run.requiredAttemptIds,
      requiredChildAliases: candidate.manifest.run.requiredChildAliases,
      closeoutCoreSha256,
      negativeControlReportSha256,
      failedStage: null,
      runVerdict: candidate.manifest.overallVerdict,
      rawExit: 0,
      rawSignal: null,
      reasonCode: null,
      manifestState: candidate.manifest.manifestState,
      overallVerdict: 'Pass',
    };
    const receiptBytes = canonicalizeBoundaryRun(receipt);
    const receiptSha256 = sha256(receiptBytes);
    const acceptedParent = ensureReservedParent(closeoutRecord);
    const staging = path.join(acceptedParent, `.${candidate.manifest.run.runId}.${attemptId}.publishing`);
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    const completionDir = path.join(staging, 'completion');
    mkdirSync(completionDir, { recursive: false, mode: 0o700 });
    const rootFiles: Array<[string, string]> = [
      ['run_manifest.json', candidate.manifestBytes],
      ['run_manifest.sha256', candidate.manifestLock],
      ['closeout_core.json', closeoutCoreBytes],
      ['negative_control_report.json', negativeReportBytes],
      ['closeout_receipt.json', receiptBytes],
      ['closeout_receipt.sha256', shaLockBytes(receiptSha256, 'closeout_receipt.json')],
    ];
    const completionFiles: Array<[string, string]> = [
      ['chain_ledger.json', candidate.ledgerBytes],
      ['chain_ledger.sha256', candidate.ledgerLock],
      ['completion_receipt.json', candidate.completionReceiptBytes],
      ['completion_receipt.sha256', candidate.completionReceiptLock],
    ];
    for (const [basename, bytes] of rootFiles) durableExclusiveWrite(path.join(staging, basename), bytes);
    for (const [basename, bytes] of completionFiles) durableExclusiveWrite(path.join(completionDir, basename), bytes);
    for (const directory of [completionDir, staging]) {
      const descriptor = openSync(directory, 'r');
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
    durableAtomicRewrite(loaded.path, candidate.manifestBytes);
    durableExclusiveWrite(path.join(runDir, 'run_manifest.sha256'), candidate.manifestLock);
    renameSync(staging, closeoutRecord.path);
    const parentDescriptor = openSync(acceptedParent, 'r');
    try { fsyncSync(parentDescriptor); } finally { closeSync(parentDescriptor); }
    return operationResult([], 0, 'Pass');
  } catch (error) {
    writeRejectedCloseout(manifest, runDir, attemptId, 'negative-control', 'closeout-publication-failed');
    return operationResult([{ code: 'closeout-publication-failed', message: (error as Error).message }]);
  }
}

function verifyAcceptedCloseout(runDir: string, cwd: string): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  try {
    const originalBytes = readFileSync(path.join(runDir, 'run_manifest.json'));
    const originalValidation = validateBoundaryRunJson(originalBytes);
    if (!originalValidation.ok) return originalValidation;
    const original = JSON.parse(originalBytes.toString('utf8')) as BoundaryRunManifest;
    const record = original.run.reservedDerivedRoots.find((entry) => entry.kind === 'closeout');
    if (record === undefined) throw new Error('accepted closeout path is not reserved by the run');
    const root = realpathSync(record.path);
    const expectedRootFiles = [
      'closeout_core.json', 'closeout_receipt.json', 'closeout_receipt.sha256', 'completion',
      'negative_control_report.json', 'run_manifest.json', 'run_manifest.sha256',
    ].sort();
    if (canonicalizeBoundaryRun(readdirSync(root).sort()) !== canonicalizeBoundaryRun(expectedRootFiles)) {
      issues.push({ code: 'closeout-file-set-mismatch', message: 'accepted closeout file set is not closed' });
    }
    const manifestBytes = readConfinedRegularFile(root, 'run_manifest.json');
    const manifestLock = readConfinedRegularFile(root, 'run_manifest.sha256').toString('utf8');
    const coreBytes = readConfinedRegularFile(root, 'closeout_core.json');
    const reportBytes = readConfinedRegularFile(root, 'negative_control_report.json');
    const receiptBytes = readConfinedRegularFile(root, 'closeout_receipt.json');
    const receiptLock = readConfinedRegularFile(root, 'closeout_receipt.sha256').toString('utf8');
    const completionRoot = path.join(root, 'completion');
    const completionBytes = readConfinedRegularFile(completionRoot, 'completion_receipt.json');
    const completionLock = readConfinedRegularFile(completionRoot, 'completion_receipt.sha256').toString('utf8');
    const ledgerBytes = readConfinedRegularFile(completionRoot, 'chain_ledger.json');
    const ledgerLock = readConfinedRegularFile(completionRoot, 'chain_ledger.sha256').toString('utf8');
    const core = strictCanonicalObject(coreBytes, 'closeout core');
    const report = strictCanonicalObject(reportBytes, 'negative-control report');
    const receipt = strictCanonicalObject(receiptBytes, 'closeout receipt');
    const completion = strictCanonicalObject(completionBytes, 'completion receipt');
    if (!exactObjectKeys(core, RUN_WIRE_SCHEMAS.CloseoutCore)
      || !exactObjectKeys(report, RUN_WIRE_SCHEMAS.CloseoutNegativeReport)
      || !exactObjectKeys(receipt, RUN_WIRE_SCHEMAS.CloseoutReceipt)) {
      issues.push({ code: 'closeout-schema-mismatch', message: 'closeout core, report, or receipt has a foreign key' });
    }
    if (
      !manifestBytes.equals(originalBytes)
      || manifestLock !== shaLockBytes(sha256(manifestBytes), 'run_manifest.json')
      || receiptLock !== shaLockBytes(sha256(receiptBytes), 'closeout_receipt.json')
      || completionLock !== shaLockBytes(sha256(completionBytes), 'completion_receipt.json')
      || ledgerLock !== shaLockBytes(sha256(ledgerBytes), 'chain_ledger.json')
      || receipt['kind'] !== 'accepted'
      || receipt['overallVerdict'] !== 'Pass'
      || receipt['runVerdict'] !== 'Pass'
      || receipt['rawExit'] !== 0
      || receipt['rawSignal'] !== null
      || receipt['runManifestSha256'] !== sha256(manifestBytes)
      || receipt['closeoutCoreSha256'] !== sha256(coreBytes)
      || receipt['negativeControlReportSha256'] !== sha256(reportBytes)
      || receipt['completionReceiptSha256'] !== sha256(completionBytes)
      || receipt['ledgerSha256'] !== sha256(ledgerBytes)
      || report['closeoutCoreSha256'] !== sha256(coreBytes)
      || completion['manifestSha256'] !== sha256(manifestBytes)
      || completion['ledgerSha256'] !== sha256(ledgerBytes)
    ) issues.push({ code: 'closeout-hash-mismatch', message: 'accepted closeout lock or cross-record identity changed' });
    const cases = Array.isArray(report['cases']) ? report['cases'] as Array<Record<string, unknown>> : [];
    if (
      cases.length !== 11
      || cases.some((entry, index) => !exactObjectKeys(entry, RUN_WIRE_SCHEMAS.CloseoutNegativeCase)
        || entry['ordinal'] !== index + 1 || entry['expectationMet'] !== true || entry['verdict'] !== 'Pass')
    ) issues.push({ code: 'closeout-negative-control-mismatch', message: 'negative-control matrix is incomplete or non-pass' });
    issues.push(...verifyManifestEvidence(original, runDir, cwd, true));
  } catch (error) {
    issues.push({ code: 'verify-closeout-failed', message: (error as Error).message });
  }
  return operationResult(issues, issues.length === 0 ? 0 : 1, issues.length === 0 ? 'Pass' : 'Inconclusive');
}

export function verifyCloseout(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir');
  if (runDir !== undefined) return verifyAcceptedCloseout(runDir, cwd);
  const failureDir = stringOption(invocation.options, 'failureReceiptDir')!;
  try {
    const root = realpathSync(failureDir);
    const bytes = readConfinedRegularFile(root, 'closeout_receipt.json');
    const lock = readConfinedRegularFile(root, 'closeout_receipt.sha256').toString('utf8');
    const receipt = strictCanonicalObject(bytes, 'rejected closeout receipt');
    const issues: BoundaryValidationIssue[] = [];
    if (!exactObjectKeys(receipt, RUN_WIRE_SCHEMAS.CloseoutReceipt)
      || receipt['kind'] !== 'rejected'
      || receipt['overallVerdict'] === 'Pass'
      || lock !== shaLockBytes(sha256(bytes), 'closeout_receipt.json')) {
      issues.push({ code: 'rejected-closeout-invalid', message: 'rejected receipt schema, verdict, or lock is invalid' });
    }
    return operationResult(issues, issues.length === 0 ? 0 : 1, issues.length === 0 ? receipt['overallVerdict'] as BoundaryValidationResult['verdict'] : 'Inconclusive');
  } catch (error) {
    return operationResult([{ code: 'verify-closeout-failed', message: (error as Error).message }]);
  }
}
