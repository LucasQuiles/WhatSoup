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

import { verifyRun } from './lifecycle.ts';

interface PreparedBoundaryPredecessor {
  record: BoundaryPredecessorRecord;
  files: Array<{ path: string; bytes: Buffer }>;
  sourceManifest: BoundaryRunManifest;
  receipt: Record<string, unknown>;
  ledger: Record<string, unknown>;
}

function parsePredecessorPin(value: string | undefined): {
  result: BoundaryValidationResult;
  pin: BoundaryPredecessorPin | null;
} {
  const fields = value?.split(',') ?? [];
  if (fields.length !== 7) {
    return {
      result: operationResult([{ code: 'predecessor-pin-invalid', message: 'predecessor pin must contain exactly seven fields' }], 2),
      pin: null,
    };
  }
  const [taskId, profileId, runId, terminalHead, manifestSha256, completionReceiptSha256, ledgerSha256] = fields;
  if (
    taskId === undefined
    || profileId === undefined
    || runId === undefined
    || terminalHead === undefined
    || manifestSha256 === undefined
    || completionReceiptSha256 === undefined
    || ledgerSha256 === undefined
    || !isOperationalId(profileId)
    || !isOperationalId(runId)
    || !/^[0-9a-f]{40}$/.test(terminalHead)
    || ![manifestSha256, completionReceiptSha256, ledgerSha256].every((entry) => /^[0-9a-f]{64}$/.test(entry))
  ) {
    return {
      result: operationResult([{ code: 'predecessor-pin-invalid', message: 'predecessor pin violates the closed identity grammar' }], 2),
      pin: null,
    };
  }
  return {
    result: operationResult([]),
    pin: { taskId, profileId, runId, terminalHead, manifestSha256, completionReceiptSha256, ledgerSha256 },
  };
}

function prepareBoundaryPredecessor(
  profileId: string,
  entryHead: string,
  successorRunId: string,
  sourceRunDir: string,
  pinValue: string | undefined,
  cwd: string,
): { result: BoundaryValidationResult; prepared: PreparedBoundaryPredecessor | null } {
  const relation = RUN_PREDECESSOR_CONTRACTS[profileId as keyof typeof RUN_PREDECESSOR_CONTRACTS];
  const parsedPin = parsePredecessorPin(pinValue);
  if (!parsedPin.result.ok || parsedPin.pin === null) return { result: parsedPin.result, prepared: null };
  const pin = parsedPin.pin;
  if (
    relation === undefined
    || pin.taskId !== relation.predecessorTaskId
    || pin.profileId !== relation.predecessorProfileId
  ) {
    return {
      result: operationResult([{ code: 'predecessor-profile-mismatch', message: 'predecessor pin differs from the generated relation' }], 2),
      prepared: null,
    };
  }
  try {
    const sourceRoot = realpathSync(sourceRunDir);
    const manifestBytes = readConfinedRegularFile(sourceRoot, 'run_manifest.json');
    if (sha256(manifestBytes) !== pin.manifestSha256) {
      return {
        result: operationResult([{ code: 'predecessor-pin-mismatch', message: 'source manifest differs from the declared predecessor pin' }], 2),
        prepared: null,
      };
    }
    const sourceVerification = verifyRun({ command: 'verify', options: { runDir: sourceRoot } }, cwd);
    if (!sourceVerification.ok || sourceVerification.verdict !== 'Pass') {
      return {
        result: operationResult([
          { code: 'predecessor-source-verification-failed', message: 'predecessor source did not pass read-only verification' },
          ...sourceVerification.issues,
        ]),
        prepared: null,
      };
    }
    const sourceManifest = JSON.parse(manifestBytes.toString('utf8')) as BoundaryRunManifest;
    const completionRecord = sourceManifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
    const expectedCompletionRoot = path.join(path.dirname(path.dirname(sourceRoot)), 'completion', pin.runId);
    if (
      sourceManifest.manifestState !== 'finalized'
      || sourceManifest.overallVerdict !== 'Pass'
      || sourceManifest.run.taskId !== pin.taskId
      || sourceManifest.run.profileId !== pin.profileId
      || sourceManifest.run.runId !== pin.runId
      || sourceManifest.run.terminalHead !== pin.terminalHead
      || completionRecord === undefined
      || completionRecord.path !== expectedCompletionRoot
    ) {
      return {
        result: operationResult([{ code: 'predecessor-pin-mismatch', message: 'verified predecessor identity differs from the declared pin' }], 2),
        prepared: null,
      };
    }
    const completionRoot = realpathSync(expectedCompletionRoot);
    const receiptBytes = readConfinedRegularFile(completionRoot, 'completion_receipt.json');
    const receiptLockBytes = readConfinedRegularFile(completionRoot, 'completion_receipt.sha256');
    const ledgerBytes = readConfinedRegularFile(completionRoot, 'chain_ledger.json');
    const ledgerLockBytes = readConfinedRegularFile(completionRoot, 'chain_ledger.sha256');
    if (
      sha256(receiptBytes) !== pin.completionReceiptSha256
      || sha256(ledgerBytes) !== pin.ledgerSha256
      || receiptLockBytes.toString('utf8') !== shaLockBytes(pin.completionReceiptSha256, 'completion_receipt.json')
      || ledgerLockBytes.toString('utf8') !== shaLockBytes(pin.ledgerSha256, 'chain_ledger.json')
    ) {
      return {
        result: operationResult([{ code: 'predecessor-pin-mismatch', message: 'completion receipt or ledger differs from the declared pin' }], 2),
        prepared: null,
      };
    }
    const receipt = strictCanonicalObject(receiptBytes, 'completion receipt');
    const ledger = strictCanonicalObject(ledgerBytes, 'chain ledger');
    const inherited = {
      reconciledBase: receipt['reconciledBase'],
      upstreamObservedOid: receipt['upstreamObservedOid'],
      corpusDigests: receipt['corpusDigests'],
      oracleDigest: receipt['oracleDigest'],
    };
    const rows = Array.isArray(ledger['rows']) ? ledger['rows'] : [];
    if (pin.profileId === 'bcf00-observation') {
      if (
        profileId !== 'bcf00-reconciliation'
        || sourceManifest.run.chainAppend !== false
        || rows.length !== 0
        || receipt['ledgerSha256'] !== pin.ledgerSha256
        || receipt['manifestSha256'] !== pin.manifestSha256
        || receipt['overallVerdict'] !== 'Pass'
        || canonicalizeBoundaryRun(inherited) !== canonicalizeBoundaryRun({
          reconciledBase: ledger['reconciledBase'],
          upstreamObservedOid: ledger['upstreamObservedOid'],
          corpusDigests: ledger['corpusDigests'],
          oracleDigest: ledger['oracleDigest'],
        })
        || entryHead !== pin.terminalHead
      ) {
        return {
          result: operationResult([{ code: 'predecessor-observation-mismatch', message: 'observation predecessor is not the canonical empty-ledger Pass' }]),
          prepared: null,
        };
      }
    } else {
      const validation = validateAndAppendBoundaryPredecessor({
        profileId,
        pin,
        receipt,
        receiptSha256: pin.completionReceiptSha256,
        ledger,
        ledgerSha256: pin.ledgerSha256,
        inherited,
        currentRow: {
          ordinal: rows.length + 1,
          taskId: relation.taskId,
          profileId,
          runId: successorRunId,
          entryHead,
          terminalHead: entryHead,
          manifestSha256: '0'.repeat(64),
          previousLedgerSha256: pin.ledgerSha256,
          overallVerdict: 'Pass',
        },
      });
      if (!validation.result.ok) return { result: validation.result, prepared: null };
    }

    const files = childClosurePaths(sourceManifest).map((relativePath) => ({
      path: relativePath,
      bytes: readConfinedRegularFile(sourceRoot, relativePath),
    }));
    files.push(
      { path: 'completion/chain_ledger.json', bytes: ledgerBytes },
      { path: 'completion/chain_ledger.sha256', bytes: ledgerLockBytes },
      { path: 'completion/completion_receipt.json', bytes: receiptBytes },
      { path: 'completion/completion_receipt.sha256', bytes: receiptLockBytes },
    );
    files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
    if (new Set(files.map((entry) => entry.path)).size !== files.length) throw new Error('predecessor closure paths collide');
    const importedFiles = files.map((entry) => ({
      path: entry.path,
      sha256: sha256(entry.bytes),
      bytes: entry.bytes.byteLength,
    }));
    const record: BoundaryPredecessorRecord = {
      pin,
      sourceManifestSha256: pin.manifestSha256,
      importedFiles,
      treeDigestSha256: sha256(canonicalizeBoundaryRun(importedFiles)),
      overallVerdict: 'Pass',
    };
    return { result: operationResult([]), prepared: { record, files, sourceManifest, receipt, ledger } };
  } catch (error) {
    return {
      result: operationResult([{ code: 'predecessor-source-verification-failed', message: (error as Error).message }]),
      prepared: null,
    };
  }
}

export function initializeRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const options = invocation.options;
  const runDir = stringOption(options, 'runDir')!;
  const taskId = stringOption(options, 'task')!;
  const profileId = stringOption(options, 'profile')!;
  const profile = RUN_CONTRACT_PROFILES[profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (profile === undefined || profile.taskId !== taskId) {
    return operationResult([{ code: 'profile-contract-mismatch', message: 'task/profile pair is not authorized' }], 2);
  }
  const runId = path.basename(runDir);
  if (!isOperationalId(runId) || path.basename(path.dirname(runDir)) !== profile.phase) {
    return operationResult([{ code: 'derived-root-path-invalid', message: 'run directory must match the profile phase and run ID' }], 2);
  }
  let entryHead: string;
  try {
    entryHead = gitText(cwd, ['rev-parse', 'HEAD']);
  } catch (error) {
    return operationResult([{ code: 'init-head-unavailable', message: (error as Error).message }]);
  }
  const parsedChildPins = parseBoundaryChildPins(profileId, entryHead, stringListOption(options, 'childPin'));
  if (!parsedChildPins.result.ok || parsedChildPins.pins === null) {
    return operationResult(parsedChildPins.result.issues, 2);
  }
  const predecessorRunDir = stringOption(options, 'predecessorRunDir');
  const predecessorPinValue = stringOption(options, 'predecessorPin');
  let preparedPredecessor: PreparedBoundaryPredecessor | null = null;
  if (profile.predecessorProfileId === null) {
    if (predecessorRunDir !== undefined || predecessorPinValue !== undefined) {
      return operationResult([{ code: 'predecessor-forbidden', message: 'observation init does not accept predecessor options' }], 2);
    }
  } else {
    if (predecessorRunDir === undefined || predecessorPinValue === undefined) {
      return operationResult([{ code: 'predecessor-required', message: 'profile requires one pinned predecessor source' }], 2);
    }
    const prepared = prepareBoundaryPredecessor(
      profileId,
      entryHead,
      runId,
      predecessorRunDir,
      predecessorPinValue,
      cwd,
    );
    if (!prepared.result.ok || prepared.prepared === null) return prepared.result;
    preparedPredecessor = prepared.prepared;
  }
  const allowedPaths = canonicalSet(stringListOption(options, 'allowPath'));
  const expectedAllowedPaths = profile.allowedPaths === 'observation-preview'
    ? preparedPredecessor?.sourceManifest.upstream.remotePaths ?? []
    : profile.allowedPaths;
  if (!Array.isArray(expectedAllowedPaths) || canonicalizeBoundaryRun(allowedPaths) !== canonicalizeBoundaryRun(expectedAllowedPaths)) {
    return operationResult([{ code: 'profile-path-mismatch', message: 'allowed paths differ from the selected profile' }], 2);
  }
  if (preparedPredecessor !== null) {
    const linkedAliases = profileId === 'bcf00-reconciliation'
      ? ['upstream-observation']
      : profileId === 'bcf08b-docs'
        ? ['docs-precommit']
        : profileId === 'bcf08-final'
          ? ['docs']
          : [];
    for (const alias of linkedAliases) {
      const childPin = parsedChildPins.pins.find((entry) => entry.alias === alias);
      if (
        childPin === undefined
        || childPin.runId !== preparedPredecessor.record.pin.runId
        || childPin.head !== preparedPredecessor.record.pin.terminalHead
        || childPin.manifestSha256 !== preparedPredecessor.record.pin.manifestSha256
      ) {
        return operationResult([{ code: 'predecessor-child-pin-mismatch', message: 'required child pin differs from the predecessor pin' }], 2);
      }
    }
  }
  const allowedUntrackedPaths = canonicalSet(stringListOption(options, 'allowUntracked'));
  const preservedOwnerPaths = canonicalSet(stringListOption(options, 'preserveOwnerPath'));
  const evidenceRoot = path.dirname(path.dirname(runDir));
  const protectedPaths = [...allowedPaths, ...allowedUntrackedPaths, ...preservedOwnerPaths]
    .map((entry) => path.join(cwd, entry));
  const runReservation = reserveBoundaryDerivedRoot({
    evidenceRoot, parentSegments: [profile.phase], runId, kind: 'run', protectedPaths,
  });
  if (!runReservation.ok || runReservation.reservation === null) {
    return operationResult(runReservation.issues, runReservation.issues.some((entry) => entry.code === 'derived-root-exists') ? 2 : 1);
  }
  const completionReservation = reserveBoundaryDerivedRoot({
    evidenceRoot, parentSegments: ['completion'], runId, kind: 'completion', protectedPaths,
  });
  if (!completionReservation.ok || completionReservation.reservation === null) {
    return operationResult(completionReservation.issues);
  }
  const closeoutReservation = profileId === 'bcf08-final'
    ? reserveBoundaryDerivedRoot({
        evidenceRoot, parentSegments: ['closeout'], runId, kind: 'closeout', protectedPaths,
      })
    : null;
  if (closeoutReservation !== null && (!closeoutReservation.ok || closeoutReservation.reservation === null)) {
    return operationResult(closeoutReservation.issues);
  }
  const closeoutFailureReservation = profileId === 'bcf08-final'
    ? reserveBoundaryDerivedRoot({
        evidenceRoot, parentSegments: ['closeout-failures'], runId, kind: 'closeout-failure', protectedPaths,
      })
    : null;
  if (
    closeoutFailureReservation !== null
    && (!closeoutFailureReservation.ok || closeoutFailureReservation.reservation === null)
  ) return operationResult(closeoutFailureReservation.issues);
  const snapshot = captureBoundaryWorktreeSnapshot(cwd, { allowedUntrackedPaths, preservedOwnerPaths });
  if (!snapshot.ok || snapshot.snapshot === null) return operationResult(snapshot.issues);

  try {
    const helperPath = 'scripts/verify-boundary-run.ts';
    const requiredAttemptIds = [...profile.requiredAttemptIds];
    const requestedTools = canonicalSet([
      ...requiredAttemptIds
      .map((id) => RUN_ATTEMPT_CONTRACTS[id]?.toolName)
      .filter((name): name is string => name !== null && name !== undefined),
      ...(boundaryTestFilesForProfile(profileId).length > 0 ? ['gnu-timeout'] : []),
    ]);
    const observedTools = requestedTools.map(resolveBoundaryToolCapability)
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    const created = createBoundaryDerivedRoot(runReservation.reservation);
    if (!created.ok || created.record === undefined) return operationResult(created.issues);
    const now = new Date().toISOString();
    const inheritedReconciledBase = preparedPredecessor?.receipt['reconciledBase'] ?? 'not-observed';
    if (inheritedReconciledBase !== 'not-observed' && !/^[0-9a-f]{40}$/.test(String(inheritedReconciledBase))) {
      throw new Error('predecessor reconciled base is malformed');
    }
    const inheritedUpstream = preparedPredecessor !== null && profileId !== 'bcf00-reconciliation'
      ? structuredClone(preparedPredecessor.sourceManifest.upstream)
      : {
          remoteUrl: 'not-observed' as const,
          observedOid: 'not-observed' as const,
          mergeBase: 'not-observed' as const,
          ahead: 'not-observed' as const,
          behind: 'not-observed' as const,
          remotePaths: [],
          localPaths: [],
          observationManifestSha256: 'not-observed' as const,
          mergeCommit: 'not-observed' as const,
          mergeParents: [] as [],
        };
    const manifest: BoundaryRunManifest = {
      schemaVersion: BOUNDARY_RUN_SCHEMA,
      manifestState: 'active',
      run: {
        runId,
        taskId,
        profileId,
        phase: profile.phase,
        createdAtUtc: now,
        finalizedAtUtc: null,
        entryHead,
        terminalHead: null,
        reconciledBase: inheritedReconciledBase as string | 'not-observed',
        helperCommit: entryHead,
        helperSha256: sha256(readFileSync(path.join(cwd, helperPath))),
        allowedPaths,
        allowedUntrackedPaths,
        preservedOwnerPaths,
        requiredAttemptIds,
        requiredChildAliases: (profile.requiredChildren as readonly string[]).map((entry) => entry.split(':', 1)[0]!),
        requiredChildPins: parsedChildPins.pins,
        transitionCount: 0,
        mayComplete: profile.mayComplete,
        chainAppend: profile.chainAppend,
        requestedTools,
        observedTools,
        reservedDerivedRoots: ([
          {
            kind: 'completion', path: completionReservation.reservation.path,
            parentDevice: completionReservation.reservation.parentDevice,
            parentInode: completionReservation.reservation.parentInode, state: 'reserved',
          },
          {
            kind: 'run', path: created.record.path, parentDevice: created.record.parentDevice,
            parentInode: created.record.parentInode, state: 'created',
          },
          ...(closeoutReservation === null || closeoutReservation.reservation === null ? [] : [{
            kind: 'closeout' as const,
            path: closeoutReservation.reservation.path,
            parentDevice: closeoutReservation.reservation.parentDevice,
            parentInode: closeoutReservation.reservation.parentInode,
            state: 'reserved' as const,
          }]),
          ...(closeoutFailureReservation === null || closeoutFailureReservation.reservation === null ? [] : [{
            kind: 'closeout-failure' as const,
            path: closeoutFailureReservation.reservation.path,
            parentDevice: closeoutFailureReservation.reservation.parentDevice,
            parentInode: closeoutFailureReservation.reservation.parentInode,
            state: 'reserved' as const,
          }]),
        ] satisfies BoundaryReservedDerivedRootRecord[])
          .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
      },
      entrySnapshot: snapshot.snapshot,
      currentSnapshot: structuredClone(snapshot.snapshot),
      attempts: [],
      artifacts: [],
      children: [],
      predecessor: preparedPredecessor?.record ?? null,
      entryTestRoster: discoverEntryTestRoster(cwd, profileId, observedTools),
      reviews: [],
      lifecycle: {
        status: 'active', completionCommit: null, finalGate: 'not-run', artifactSha256: null,
        successor: null, supersededBy: null, oracle: 'not-applicable', branchDeletionAuthorized: false,
      },
      documentHashes: {
        spec: documentHash(cwd, 'docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md'),
        plan: documentHash(cwd, 'docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md'),
        notes: documentHash(cwd, 'docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md'),
        helper: documentHash(cwd, helperPath),
      },
      upstream: inheritedUpstream,
      overallVerdict: 'Inconclusive',
    };
    const validation = validateBoundaryRun(manifest);
    if (!validation.ok) throw new Error(validation.issues.map((entry) => entry.code).join(', '));
    mkdirSync(path.join(runDir, 'attempts'), { recursive: false, mode: 0o700 });
    if (preparedPredecessor !== null) {
      const predecessorRoot = path.join(runDir, 'predecessor');
      mkdirSync(predecessorRoot, { recursive: false, mode: 0o700 });
      for (const file of preparedPredecessor.files) {
        const destination = path.join(predecessorRoot, file.path);
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        durableExclusiveWrite(destination, file.bytes);
      }
    }
    durableExclusiveWrite(path.join(runDir, 'run_manifest.json'), canonicalizeBoundaryRun(manifest));
    const initAnchorBytes = canonicalizeBoundaryRun(createBoundaryRunInitAnchor(manifest));
    durableExclusiveWrite(path.join(runDir, 'run_init.json'), initAnchorBytes);
    durableExclusiveWrite(path.join(runDir, 'run_init.sha256'), shaLockBytes(sha256(initAnchorBytes), 'run_init.json'));
    return operationResult([]);
  } catch (error) {
    try {
      if (existsSync(runDir) && lstatSync(runDir).isDirectory() && !existsSync(path.join(runDir, 'run_manifest.json'))) {
        rmdirSync(runDir);
      }
    } catch {
      // Retain non-empty or identity-ambiguous state for inspection.
    }
    return operationResult([{ code: 'init-failed', message: (error as Error).message }]);
  }
}
