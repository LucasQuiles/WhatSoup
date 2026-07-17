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

import { aggregateRunVerdict, verifyRecordedReviews } from './lifecycle.ts';

export async function recordCommand(invocation: BoundaryRunInvocation, cwd: string): Promise<BoundaryValidationResult> {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const attemptId = stringOption(invocation.options, 'attempt')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest, path: manifestPath } = loaded;
  if (manifest.attempts.some((entry) => entry.id === attemptId)) {
    return operationResult([{ code: 'attempt-duplicate', message: `attempt already exists: ${attemptId}` }], 2);
  }
  const expectedExit = stringOption(invocation.options, 'expectExit') ?? '0';
  const timeoutOwner = stringOption(invocation.options, 'timeoutOwner') ?? null;
  const outputPaths = canonicalSet(stringListOption(invocation.options, 'outputPath'));
  const required = manifest.run.requiredAttemptIds.includes(attemptId);
  let contract = RUN_ATTEMPT_CONTRACTS[attemptId];
  if (required) {
    if (contract === undefined || contract.operation !== 'command') {
      return operationResult([{ code: 'attempt-operation-mismatch', message: 'attempt is not a command contract' }], 2);
    }
    if (
      canonicalizeBoundaryRun(invocation.commandArgv) !== canonicalizeBoundaryRun(contract.argv)
      || expectedExit !== contract.expectedExit
      || timeoutOwner !== contract.innerTimeoutOwner
      || canonicalizeBoundaryRun(outputPaths) !== canonicalizeBoundaryRun(contract.outputPaths)
    ) {
      return operationResult([{ code: 'attempt-contract-mismatch', message: 'command invocation differs from its reserved contract' }], 2);
    }
  } else {
    const commandArgv = invocation.commandArgv ?? [];
    const toolName = commandArgv[0];
    const normalizedExit = parseBoundaryExpectedExit(expectedExit) !== null;
    if (
      manifest.run.profileId !== 'bcf-reproduction'
      || toolName === undefined
      || !isOperationalId(toolName)
      || !normalizedExit
      || timeoutOwner !== null
      || outputPaths.length !== 0
      || manifest.run.observedTools.every((entry) => entry.name !== toolName)
    ) {
      return operationResult([{
        code: 'reproduction-attempt-contract-mismatch',
        message: 'generic attempts require the closed reproduction profile, frozen tool, bounds, and no outputs',
      }], 2);
    }
    contract = {
      operation: 'command',
      argv: commandArgv,
      environmentKeys: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'],
      toolName,
      expectedExit,
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 900_000,
      killGraceMs: 30_000,
      outputPaths: [],
      headAnchor: 'entry',
      stdinSource: null,
      stdoutPredicate: null,
      resultPredicate: null,
      structuredResultPath: null,
      internalCheck: null,
      transitionKind: null,
      messageSubject: null,
      allowlistSource: null,
    };
  }
  const capability = resolveBoundaryToolCapability(contract.toolName!);
  const frozenCapability = manifest.run.observedTools.find((entry) => entry.name === contract.toolName);
  if (frozenCapability === undefined || canonicalizeBoundaryRun(frozenCapability) !== canonicalizeBoundaryRun(capability)) {
    return operationResult([{ code: 'attempt-tool-capability-mismatch', message: 'tool identity changed since init' }]);
  }
  const expectedHead = contract.headAnchor === 'entry'
    ? manifest.run.entryHead
    : manifest.run.terminalHead;
  if (expectedHead === null || gitText(cwd, ['rev-parse', 'HEAD']) !== expectedHead) {
    return operationResult([{ code: 'attempt-head-anchor-mismatch', message: 'Git head differs from the attempt anchor' }]);
  }
  const before = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!before.ok || before.snapshot === null) return operationResult(before.issues);
  if (canonicalizeBoundaryRun(before.snapshot) !== canonicalizeBoundaryRun(manifest.currentSnapshot)) {
    return operationResult([{ code: 'attempt-pre-snapshot-drift', message: 'worktree changed before command execution' }]);
  }
  const attemptDir = path.join(runDir, 'attempts', attemptId);
  try {
    mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    return operationResult([{
      code: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'attempt-duplicate' : 'attempt-directory-failed',
      message: (error as Error).message,
    }], (error as NodeJS.ErrnoException).code === 'EEXIST' ? 2 : 1);
  }
  let resolvedArgv: string[];
  let stdinPath: string | null = null;
  let structuredResultPath: string | null = null;
  let measurementChannel: {
    path: string;
    tokenSha256: string;
    device: number;
    inode: number;
    mode: number;
  } | null = null;
  let childEnvironment = reconstructedChildEnvironment(cwd);
  try {
    resolvedArgv = resolveAttemptArgv(contract.argv, manifest, runDir);
    resolvedArgv[0] = capability.realPath;
    if (contract.stdinSource !== null) {
      const source = manifest.attempts.find((entry) => entry.id === contract.stdinSource);
      if (source === undefined || source.verdict !== 'Pass') throw new Error('stdin source attempt is unavailable');
      stdinPath = path.join(runDir, source.stdout.path);
    }
    if (contract.structuredResultPath !== null) {
      structuredResultPath = contract.structuredResultPath;
      const vitestPredicate = contract.resultPredicate === null
        ? undefined
        : RUN_VITEST_PREDICATES[contract.resultPredicate];
      if (vitestPredicate?.mode === 'red') {
        const selectedMarkers = vitestPredicate.testContractIds.flatMap((id) => [
          ...RUN_TEST_CONTRACTS[id].unsafeMarkerIds,
          ...RUN_TEST_CONTRACTS[id].safeMarkerIds,
        ]);
        const pattern = selectedMarkers.map((markerId) => markerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        resolvedArgv.push('--testNamePattern', pattern);
      }
      if (!structuredResultPath.endsWith('/stdout.log')) {
        resolvedArgv.push('--reporter=json', '--outputFile', path.join(runDir, structuredResultPath));
      }
    }
    if (attemptId === 'feedback-green') {
      const measurementPath = path.join(runDir, 'feedback-measurements.json');
      const token = randomUUID();
      durableExclusiveWrite(measurementPath, '');
      const stat = lstatSync(measurementPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('measurement channel is not a regular file');
      measurementChannel = {
        path: measurementPath,
        tokenSha256: sha256(token),
        device: Number(stat.dev),
        inode: Number(stat.ino),
        mode: stat.mode,
      };
      childEnvironment = {
        ...childEnvironment,
        BCF_MEASUREMENT_PATH: measurementPath,
        BCF_MEASUREMENT_TOKEN: token,
      };
    }
  } catch (error) {
    return operationResult([{ code: 'attempt-prerequisite-invalid', message: (error as Error).message }]);
  }
  const stdoutPath = `attempts/${attemptId}/stdout.log`;
  const stderrPath = `attempts/${attemptId}/stderr.log`;
  const outcome = await runBoundaryAttemptProcess(resolvedArgv, {
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
    expectedExit: contract.expectedExit,
    cwd,
    env: childEnvironment,
    stdinPath,
    stdoutPath: path.join(runDir, stdoutPath),
    stderrPath: path.join(runDir, stderrPath),
  });
  const after = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  const statusRecord = {
    expectedExit: contract.expectedExit,
    rawExit: outcome.rawExit,
    rawSignal: outcome.rawSignal,
    expectationMet: false,
    watchdogOwner: contract.watchdogOwner,
    innerTimeoutOwner: contract.innerTimeoutOwner,
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
  };
  const parsedStatus = validateBoundaryAttemptStatus(
    { ...statusRecord, expectationMet: outcome.result.ok },
    { rawExit: outcome.rawExit, rawSignal: outcome.rawSignal },
    contract,
  );
  const expectationMet = outcome.result.ok && parsedStatus.ok;
  const outputAdmissions: BoundaryOutputAdmission[] = contract.outputPaths.map((relativePath) => {
    const absolute = path.join(runDir, relativePath);
    try {
      const stat = lstatSync(absolute);
      return {
        path: relativePath,
        state: stat.isFile() && !stat.isSymbolicLink() ? 'pending' as const : 'missing' as const,
        role: null,
        sha256: null,
        bytes: null,
      };
    } catch {
      return { path: relativePath, state: 'missing' as const, role: null, sha256: null, bytes: null };
    }
  });
  let measurementValidation = operationResult([]);
  if (measurementChannel !== null) {
    try {
      const stat = lstatSync(measurementChannel.path);
      const bytes = readFileSync(measurementChannel.path);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || Number(stat.dev) !== measurementChannel.device
        || Number(stat.ino) !== measurementChannel.inode
        || stat.mode !== measurementChannel.mode
        || bytes.byteLength === 0
      ) throw new Error('measurement channel identity or contents changed outside the one-use contract');
      const descriptor = openSync(measurementChannel.path, 'r');
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const parsed = parseBoundaryJsonBytes(bytes);
      if (
        !parsed.result.ok
        || parsed.value === null
        || parsed.value === undefined
        || typeof parsed.value !== 'object'
        || Array.isArray(parsed.value)
      ) {
        measurementValidation = parsed.result;
      } else {
        const measurement = parsed.value as Record<string, unknown>;
        measurementValidation = validateBoundaryStructuredRecord('FeedbackMeasurements', measurement);
        if (
          measurementValidation.ok
          && (
            measurement['runId'] !== manifest.run.runId
            || measurement['taskId'] !== manifest.run.taskId
            || measurement['profileId'] !== manifest.run.profileId
            || measurement['producerAttemptId'] !== attemptId
            || measurement['head'] !== expectedHead
            || measurement['snapshotDigestSha256'] !== before.snapshot.digestSha256
            || measurement['tokenSha256'] !== measurementChannel.tokenSha256
          )
        ) {
          measurementValidation = operationResult([{
            code: 'feedback-measurement-identity-mismatch',
            message: 'measurement fields differ from the helper-owned one-use channel',
          }]);
        }
      }
      if (measurementValidation.ok) {
        const admission = outputAdmissions.find((entry) => entry.path === 'feedback-measurements.json');
        if (admission === undefined || admission.state !== 'pending') {
          measurementValidation = operationResult([{
            code: 'feedback-measurement-admission-mismatch',
            message: 'measurement output is not the sole pending profile declaration',
          }]);
        } else {
          admission.state = 'admitted';
          admission.role = 'measurement';
          admission.sha256 = sha256(bytes);
          admission.bytes = bytes.byteLength;
        }
      }
    } catch (error) {
      measurementValidation = operationResult([{ code: 'feedback-measurement-invalid', message: (error as Error).message }]);
    }
  }
  const snapshotStable = after.ok
    && after.snapshot !== null
    && canonicalizeBoundaryRun(after.snapshot) === canonicalizeBoundaryRun(before.snapshot);
  const stdoutPredicate = validateBoundaryStdoutPredicate(
    contract.stdoutPredicate,
    readFileSync(path.join(runDir, stdoutPath), 'utf8'),
    manifest.run.allowedPaths,
  );
  let structuredResult = null;
  let resultPredicate = operationResult([]);
  if (contract.resultPredicate !== null) {
    if (structuredResultPath === null || !existsSync(path.join(runDir, structuredResultPath))) {
      resultPredicate = operationResult([{
        code: 'attempt-structured-result-missing',
        message: 'required structured result was not written',
      }]);
    } else {
      structuredResult = streamRecord(runDir, structuredResultPath);
      const parsed = parseBoundaryJsonBytes(readFileSync(path.join(runDir, structuredResultPath)));
      resultPredicate = parsed.result.ok && parsed.value !== null
        ? validateBoundaryVitestJsonReport({
            predicate: contract.resultPredicate,
            cwd,
            entryTestRoster: manifest.entryTestRoster,
            report: parsed.value,
          })
        : parsed.result;
    }
  }
  const resultPredicateMet = resultPredicate.ok;
  const verdict = expectationMet
    && snapshotStable
    && stdoutPredicate.ok
    && resultPredicateMet
    && measurementValidation.ok
    && outputAdmissions.every((entry) => entry.state === 'admitted')
    ? 'Pass' as const
    : 'Inconclusive' as const;
  const attempt = {
    id: attemptId,
    operation: 'command' as const,
    headAnchor: contract.headAnchor,
    argv: [...contract.argv],
    cwd,
    startedAtUtc: outcome.startedAtUtc,
    endedAtUtc: outcome.endedAtUtc,
    expectedExit: contract.expectedExit,
    rawExit: outcome.rawExit,
    rawSignal: outcome.rawSignal,
    expectationMet,
    watchdogOwner: contract.watchdogOwner,
    innerTimeoutOwner: contract.innerTimeoutOwner,
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
    preSnapshot: before.snapshot,
    postSnapshot: after.snapshot ?? before.snapshot,
    stdout: streamRecord(runDir, stdoutPath),
    stderr: streamRecord(runDir, stderrPath),
    declaredOutputs: [...contract.outputPaths],
    outputAdmissions,
    structuredResult,
    verdict,
  };
  manifest.attempts.push(attempt);
  if (measurementChannel !== null && measurementValidation.ok) {
    const admission = outputAdmissions.find((entry) => entry.path === 'feedback-measurements.json')!;
    manifest.artifacts.push({
      path: admission.path,
      role: 'measurement',
      producerAttemptId: attemptId,
      sha256: admission.sha256!,
      bytes: admission.bytes!,
    });
  }
  manifest.currentSnapshot = structuredClone(attempt.postSnapshot);
  const validation = validateBoundaryRun(manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(manifestPath, canonicalizeBoundaryRun(manifest));
  const issues = [
    ...outcome.result.issues,
    ...parsedStatus.issues,
    ...after.issues,
    ...stdoutPredicate.issues,
    ...resultPredicate.issues,
    ...measurementValidation.issues,
    ...(!snapshotStable ? [{ code: 'attempt-post-snapshot-drift', message: 'worktree changed during command' }] : []),
  ];
  return operationResult(issues, issues.length === 0 ? 0 : 1, verdict);
}

export function recordArtifact(invocation: BoundaryRunInvocation): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const producerAttemptId = stringOption(invocation.options, 'producerAttempt')!;
  const artifactPath = stringOption(invocation.options, 'artifactPath')!;
  const role = stringOption(invocation.options, 'role')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const attemptIndex = loaded.manifest.attempts.findIndex((entry) => entry.id === producerAttemptId);
  if (attemptIndex < 0) {
    return operationResult([{ code: 'output-producer-missing', message: 'producer attempt is unavailable' }]);
  }
  const admitted = admitBoundaryOutput({
    runDir,
    attempt: loaded.manifest.attempts[attemptIndex]!,
    artifacts: loaded.manifest.artifacts,
    path: artifactPath,
    role,
    producerAttemptId,
  });
  if (!admitted.result.ok) return admitted.result;
  const closure = validateBoundaryOutputClosure(runDir, admitted.attempt, admitted.artifacts);
  if (!closure.ok) return closure;
  loaded.manifest.attempts[attemptIndex] = admitted.attempt;
  loaded.manifest.artifacts = admitted.artifacts
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const validation = validateBoundaryRun(loaded.manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(loaded.manifest));
  return operationResult([], 0, admitted.attempt.verdict);
}


export const BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS = [
  'docs-authoring-scope',
  'docs-lineage-scope',
  'output-budget-contract',
  'producer-inventory-contract',
  'read-only-scope',
  'readiness-contract',
  'review-contract',
  'staged-scope',
  'worktree-scope',
] as const;

function evaluateInternalCheck(
  check: string,
  manifest: BoundaryRunManifest,
  runDir: string,
  cwd: string,
  snapshot: NonNullable<ReturnType<typeof captureBoundaryWorktreeSnapshot>['snapshot']>,
): {
  result: BoundaryValidationResult;
  details: Record<string, unknown>;
  structuredRecord?: Record<string, unknown>;
  structuredPath?: string;
  artifactRole?: 'receipt' | 'measurement' | 'scope';
  reuseStructuredArtifact?: boolean;
} {
  const changedPaths = gitPathSet(cwd, ['diff', '--name-only', 'HEAD', '--']);
  const stagedPaths = gitPathSet(cwd, ['diff', '--cached', '--name-only', '--']);
  const unstagedPaths = gitPathSet(cwd, ['diff', '--name-only', '--']);
  const allowedPaths = manifest.run.allowedPaths;
  const foreignPaths = changedPaths.filter((entry) => !allowedPaths.includes(entry));
  const ownerStable = canonicalizeBoundaryRun(snapshot.preservedOwner)
    === canonicalizeBoundaryRun(manifest.entrySnapshot.preservedOwner);
  const issues: BoundaryValidationIssue[] = [];
  let structuredRecord: Record<string, unknown> | undefined;
  let structuredPath: string | undefined;
  let artifactRole: 'receipt' | 'measurement' | 'scope' | undefined;
  let reuseStructuredArtifact = false;
  if (foreignPaths.length > 0) {
    issues.push({ code: 'internal-scope-foreign-path', message: `tracked paths exceed profile scope: ${foreignPaths.join(', ')}` });
  }
  if (!ownerStable) issues.push({ code: 'internal-scope-owner-drift', message: 'preserved owner paths changed' });
  switch (check) {
    case 'worktree-scope':
      break;
    case 'readiness-contract': {
      const prerequisiteAttempts = manifest.run.requiredAttemptIds
        .filter((id) => id !== 'readiness-check')
        .map((id) => manifest.attempts.find((entry) => entry.id === id));
      const evidence = prerequisiteAttempts
        .filter((attempt): attempt is NonNullable<typeof attempt> => attempt !== undefined)
        .map((attempt) => {
          const stream = attempt.structuredResult ?? attempt.stdout;
          return {
            evidenceId: attempt.id,
            artifactPath: stream.path,
            producerAttemptId: attempt.id,
            sha256: stream.sha256,
            verdict: attempt.verdict,
          };
        })
        .sort((left, right) => Buffer.from(left.evidenceId).compare(Buffer.from(right.evidenceId)));
      const evidenceRefs = evidence.map((entry) => entry.evidenceId);
      const dueConditions = [
        manifest.run.profileId === 'bcf00-reconciliation',
        manifest.lifecycle.status === 'completed',
        manifest.lifecycle.finalGate === 'pass',
        manifest.lifecycle.oracle === 'current',
        prerequisiteAttempts.length === manifest.run.requiredAttemptIds.length - 1,
        prerequisiteAttempts.every((attempt) => attempt?.expectationMet === true && attempt.verdict === 'Pass'),
        manifest.run.requiredChildAliases.every((alias) => {
          const child = manifest.children.find((entry) => entry.alias === alias);
          return child?.overallVerdict === 'Pass';
        }),
        manifest.upstream.observedOid !== 'not-observed',
      ];
      const ready = dueConditions.every(Boolean);
      const blockers = ready ? [] : [{
        blockerId: 'reconciliation-evidence-incomplete',
        reason: 'One or more required reconciliation attempts, children, lifecycle fields, or upstream identities are non-pass.',
        evidenceRefs,
      }];
      const riskEvidence = evidence.find((entry) => entry.evidenceId === 'predecessor-branch-gate') ?? evidence[0];
      const risks = riskEvidence === undefined ? [] : [{
        riskId: 'later-checkpoints',
        owner: 'implementation-lead',
        checkpoint: 'before each dependent boundary task',
        artifactPath: riskEvidence.artifactPath,
        artifactSha256: riskEvidence.sha256,
        stopCondition: 'Stop when a constrained assumption, bound artifact, corpus, tool, or upstream identity changes.',
      }];
      structuredRecord = {
        schemaVersion: 1,
        runId: manifest.run.runId,
        taskId: manifest.run.taskId,
        profileId: manifest.run.profileId,
        head: manifest.run.terminalHead ?? snapshot.head,
        snapshotDigestSha256: snapshot.digestSha256,
        readinessState: ready ? 'Ready with Constraints' : 'Not Ready',
        evaluatedAtUtc: new Date().toISOString(),
        evidence,
        assumptions: ['A-08', 'A-09', 'A-10'].map((assumptionId) => ({
          assumptionId,
          disposition: ready ? 'validated' : 'blocked',
          evidenceRefs,
        })),
        risks,
        blockers,
        decisionRationale: ready
          ? 'All due reconciliation assumptions passed; later boundary checkpoints remain constrained.'
          : 'Required reconciliation evidence is missing, non-pass, or no longer identity-consistent.',
        decisionAuthority: 'implementation-lead',
        nextAllowedAction: ready ? 'BCF-01' : null,
        overallVerdict: ready ? 'Pass' : 'Inconclusive',
      };
      const structuredValidation = validateBoundaryStructuredRecord('ReadinessRecord', structuredRecord);
      issues.push(...structuredValidation.issues);
      if (!ready) issues.push({ code: 'readiness-not-ready', message: 'reconciliation is not ready for BCF-01' });
      structuredPath = 'readiness.json';
      artifactRole = 'receipt';
      break;
    }
    case 'producer-inventory-contract': {
      const queryArgv = [
        'rg', '-n', 'buildBoundaryReceipt\\(|buildSemanticReceipt\\(|schemaVersion',
        'scripts', 'tests', 'docs', '--glob', '*.ts', '--glob', '*.md',
      ];
      const rgCapability = manifest.run.observedTools.find((entry) => entry.name === 'rg');
      if (rgCapability === undefined) {
        issues.push({ code: 'consumer-inventory-tool-missing', message: 'the frozen rg capability is unavailable' });
        break;
      }
      try {
        const raw = execFileSync(rgCapability.realPath, queryArgv.slice(1), {
          cwd,
          encoding: 'utf8',
          env: reconstructedChildEnvironment(cwd),
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const inventoryMatches: Array<Record<string, unknown>> = [];
        const tokenPattern = /buildBoundaryReceipt\(|buildSemanticReceipt\(|schemaVersion/g;
        for (const outputLine of raw.split('\n')) {
          if (outputLine === '') continue;
          const parsed = /^([^:]+):(\d+):(.*)$/.exec(outputLine);
          if (parsed === null) throw new Error(`unparseable inventory row: ${outputLine.slice(0, 160)}`);
          const [, relativePath, lineText, sourceLine] = parsed;
          tokenPattern.lastIndex = 0;
          for (let match = tokenPattern.exec(sourceLine!); match !== null; match = tokenPattern.exec(sourceLine!)) {
            const matchedToken = match[0]!;
            inventoryMatches.push({
              path: relativePath,
              line: Number(lineText),
              column: match.index + 1,
              matchKind: matchedToken === 'schemaVersion'
                ? /schemaVersion\s*(?:===?|:)\s*1\b/.test(sourceLine!)
                  ? 'compatibility-read'
                  : 'schema-reference'
                : 'producer-call',
              matchedToken,
              lineSha256: sha256(`${sourceLine}\n`),
            });
          }
        }
        inventoryMatches.sort((left, right) => {
          for (const key of ['path', 'line', 'column', 'matchKind', 'matchedToken'] as const) {
            const leftValue = left[key];
            const rightValue = right[key];
            if (typeof leftValue === 'number' && typeof rightValue === 'number' && leftValue !== rightValue) return leftValue - rightValue;
            const compared = Buffer.from(String(leftValue)).compare(Buffer.from(String(rightValue)));
            if (compared !== 0) return compared;
          }
          return 0;
        });
        const localConsumers = inventoryMatches.map((row, index) => {
          const matchRef = `${String(row['path'])}:${String(row['line'])}:${String(row['column'])}:${String(row['matchKind'])}:${String(row['matchedToken'])}`;
          const relativePath = String(row['path']);
          const kind = row['matchKind'] === 'producer-call'
            ? 'producer'
            : relativePath.startsWith('tests/')
              ? 'test'
              : relativePath.startsWith('docs/')
                ? 'documentation'
                : 'reader';
          return {
            consumerId: `consumer-${String(index + 1).padStart(4, '0')}`,
            kind,
            path: relativePath,
            symbol: String(row['matchedToken']).replace(/\($/, ''),
            schemaSupport: 'schema-1',
            matchRefs: [matchRef],
          };
        });
        const packageJson = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { version?: unknown };
        structuredRecord = {
          schemaVersion: 1,
          runId: manifest.run.runId,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          head: manifest.run.entryHead,
          snapshotDigestSha256: snapshot.digestSha256,
          packageVersion: packageJson.version,
          currentProducerSchema: 1,
          proposedProducerSchema: 2,
          supportStage: 'beta-shadow-only',
          inventoryQuerySha256: sha256(canonicalizeBoundaryRun(queryArgv)),
          inventoryMatches,
          localConsumers,
          externalConsumers: 'unknown',
          compatibilityReader: 'schema-1-read-render',
          rollbackCommit: manifest.predecessor?.pin.terminalHead ?? '',
          decision: 'pre-1.0-shadow-compatible',
          releaseNoteRequired: false,
          limitations: ['external-consumers-unknown'],
          overallVerdict: 'Pass',
        };
        const structuredValidation = validateBoundaryStructuredRecord('ConsumerVersionDecision', structuredRecord);
        issues.push(...structuredValidation.issues);
        structuredPath = 'consumer-version-decision.json';
        artifactRole = 'receipt';
      } catch (error) {
        issues.push({ code: 'consumer-inventory-failed', message: (error as Error).message });
      }
      break;
    }
    case 'output-budget-contract': {
      const artifact = manifest.artifacts.find((entry) => entry.path === 'feedback-measurements.json');
      const producer = manifest.attempts.find((entry) => entry.id === 'feedback-green');
      if (
        artifact === undefined
        || artifact.producerAttemptId !== 'feedback-green'
        || artifact.role !== 'measurement'
        || producer?.verdict !== 'Pass'
      ) {
        issues.push({ code: 'feedback-measurement-missing', message: 'the accepted feedback-green measurement artifact is unavailable' });
        break;
      }
      try {
        const bytes = readConfinedRegularFile(runDir, artifact.path);
        if (sha256(bytes) !== artifact.sha256 || bytes.byteLength !== artifact.bytes) {
          throw new Error('measurement bytes differ from the producer-bound artifact');
        }
        const parsed = parseBoundaryJsonBytes(bytes);
        if (
          !parsed.result.ok
          || parsed.value === null
          || parsed.value === undefined
          || typeof parsed.value !== 'object'
          || Array.isArray(parsed.value)
        ) {
          issues.push(...parsed.result.issues);
          break;
        }
        const measurement = parsed.value as Record<string, unknown>;
        structuredRecord = measurement;
        const structuredValidation = validateBoundaryStructuredRecord('FeedbackMeasurements', measurement);
        issues.push(...structuredValidation.issues);
        if (
          measurement['runId'] !== manifest.run.runId
          || measurement['taskId'] !== manifest.run.taskId
          || measurement['profileId'] !== manifest.run.profileId
          || measurement['head'] !== manifest.run.entryHead
          || measurement['snapshotDigestSha256'] !== producer.postSnapshot.digestSha256
        ) {
          issues.push({ code: 'feedback-measurement-identity-mismatch', message: 'measurement identity differs from feedback-green' });
        }
        structuredPath = artifact.path;
        artifactRole = 'measurement';
        reuseStructuredArtifact = true;
      } catch (error) {
        issues.push({ code: 'feedback-measurement-invalid', message: (error as Error).message });
      }
      break;
    }
    case 'docs-lineage-scope': {
      try {
        if (manifest.run.profileId !== 'bcf08b-docs' || manifest.predecessor === null) {
          throw new Error('docs lineage requires the BCF-08B predecessor chain');
        }
        const predecessorCompletion = path.join(runDir, 'predecessor', 'completion');
        const ledger = strictCanonicalObject(
          readConfinedRegularFile(predecessorCompletion, 'chain_ledger.json'),
          'docs predecessor chain ledger',
        );
        const rows = Array.isArray(ledger['rows']) ? ledger['rows'] as Array<Record<string, unknown>> : [];
        const reconciliation = rows.find((row) => row['profileId'] === 'bcf00-reconciliation');
        if (reconciliation === undefined) throw new Error('reconciliation ledger row is unavailable');
        const validatorCommit = String(reconciliation['entryHead']);
        const upstreamMerge = String(reconciliation['terminalHead']);
        const reconciledBase = String(ledger['reconciledBase']);
        const upstreamObservedOid = String(ledger['upstreamObservedOid']);
        const validatorBase = gitText(cwd, ['rev-parse', `${validatorCommit}^`]);
        const mergeParents = gitText(cwd, ['rev-list', '--parents', '-n', '1', upstreamMerge]).split(/\s+/).slice(1);
        if (
          mergeParents.length !== 2
          || mergeParents[0] !== validatorCommit
          || mergeParents[1] !== upstreamObservedOid
          || reconciledBase !== upstreamMerge
        ) throw new Error('validator, reconciliation, or upstream parent identity is inconsistent');
        const operationSpecs: Array<{ id: string; args: string[] }> = [
          { id: 'diff-check', args: ['diff', '--check'] },
          { id: 'status-short', args: ['status', '--short'] },
          { id: 'validator-endpoints', args: ['rev-parse', validatorBase, validatorCommit] },
          { id: 'validator-name-status', args: ['diff', '--name-status', validatorBase, validatorCommit] },
          { id: 'validator-stat', args: ['diff', '--stat', validatorBase, validatorCommit] },
          { id: 'merge-origin', args: ['rev-parse', `${upstreamMerge}^1`, `${upstreamMerge}^2`, 'origin/main'] },
          { id: 'upstream-name-status', args: ['diff', '--name-status', `${upstreamMerge}^1`, upstreamMerge] },
          { id: 'upstream-stat', args: ['diff', '--stat', `${upstreamMerge}^1`, upstreamMerge] },
          { id: 'authored-name-status', args: ['diff', '--name-status', `${reconciledBase}...HEAD`] },
          { id: 'authored-stat', args: ['diff', '--stat', `${reconciledBase}...HEAD`] },
        ];
        const operations: Array<Record<string, unknown>> = [];
        const outputs = new Map<string, string>();
        for (const [index, spec] of operationSpecs.entries()) {
          let rawExit: number | null = 0;
          let rawSignal: string | null = null;
          let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          try {
            stdout = execFileSync(capabilityForManifest(manifest, 'git').realPath, spec.args, {
              cwd,
              env: reconstructedChildEnvironment(cwd),
              maxBuffer: 64 * 1024 * 1024,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch (error) {
            const failure = error as NodeJS.ErrnoException & {
              status?: number | null;
              signal?: string | null;
              stdout?: Buffer;
              stderr?: Buffer;
            };
            rawExit = typeof failure.status === 'number' ? failure.status : null;
            rawSignal = typeof failure.signal === 'string' ? failure.signal : rawExit === null ? 'SIGUNKNOWN' : null;
            stdout = Buffer.isBuffer(failure.stdout) ? failure.stdout : Buffer.alloc(0);
            stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr : Buffer.from(failure.message);
          }
          const stdoutText = stdout.toString('utf8').trim();
          outputs.set(spec.id, stdoutText);
          const parsedOids = (spec.id === 'validator-endpoints' || spec.id === 'merge-origin')
            ? canonicalSet(stdoutText === '' ? [] : stdoutText.split(/\s+/).filter((entry) => /^[0-9a-f]{40}$/.test(entry)))
            : [];
          const parsedPaths = spec.id.endsWith('name-status')
            ? canonicalSet(stdoutText === '' ? [] : stdoutText.split('\n').flatMap((line) => line.split('\t').slice(1)))
            : [];
          const expectationMet = rawExit === 0 && rawSignal === null;
          operations.push({
            ordinal: index + 1,
            operationId: spec.id,
            argv: ['git', ...spec.args],
            rawExit,
            rawSignal,
            stdoutSha256: sha256(stdout),
            stderrSha256: sha256(stderr),
            parsedOids,
            parsedPaths,
            expectationMet,
            verdict: expectationMet ? 'Pass' : 'Inconclusive',
          });
        }
        const parseNameStatus = (operationId: string, source: string): Array<Record<string, unknown>> => {
          const value = outputs.get(operationId) ?? '';
          return value === '' ? [] : value.split('\n').flatMap((line) => {
            const fields = line.split('\t');
            const status = fields[0]!;
            return fields.slice(1).map((relativePath) => ({ path: relativePath, status, source }));
          });
        };
        const pathClasses = [
          ...parseNameStatus('validator-name-status', 'validator'),
          ...parseNameStatus('upstream-name-status', 'upstream'),
          ...parseNameStatus('authored-name-status', 'authored'),
        ].sort((left, right) => {
          for (const key of ['path', 'source', 'status'] as const) {
            const compared = Buffer.from(String(left[key])).compare(Buffer.from(String(right[key])));
            if (compared !== 0) return compared;
          }
          return 0;
        });
        const validatorPaths = pathClasses
          .filter((row) => row['source'] === 'validator')
          .map((row) => row['path']);
        const expectedValidatorPaths = [
          'scripts/lib/verification/boundary-run-manifest.ts',
          'scripts/verify-boundary-run.ts',
          'tests/scripts/verify-boundary-run.test.ts',
        ];
        if (canonicalizeBoundaryRun(canonicalSet(validatorPaths as string[])) !== canonicalizeBoundaryRun(expectedValidatorPaths)) {
          throw new Error('validator interval differs from the exact three-file bootstrap');
        }
        const mergeOrigin = (outputs.get('merge-origin') ?? '').split(/\s+/);
        if (
          mergeOrigin.length !== 3
          || mergeOrigin[0] !== validatorCommit
          || mergeOrigin[1] !== upstreamObservedOid
          || mergeOrigin[2] !== upstreamObservedOid
        ) throw new Error('merge parents or origin/main moved during lineage derivation');
        const authoredAllowed = new Set(
          Object.values(RUN_CONTRACT_PROFILES)
            .flatMap((profile) => Array.isArray(profile.allowedPaths) ? profile.allowedPaths : []),
        );
        const foreignAuthored = pathClasses
          .filter((row) => row['source'] === 'authored' && !authoredAllowed.has(String(row['path'])));
        if (foreignAuthored.length > 0) throw new Error('authored interval contains a path outside the Required File Interface');
        const hashTrackedFile = (relativePath: string): string => sha256(readFileSync(path.join(cwd, relativePath)));
        const publicationAudit = manifest.entrySnapshot.preservedOwner.find((entry) => entry.path === 'docs/publication-audit.md');
        if (publicationAudit === undefined) throw new Error('publication audit is not preserved by the B docs run');
        structuredRecord = {
          schemaVersion: 1,
          runId: manifest.run.runId,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          head: snapshot.head,
          snapshotDigestSha256: snapshot.digestSha256,
          anchors: {
            validatorBase,
            validatorCommit,
            upstreamMerge,
            upstreamFirstParent: mergeParents[0],
            upstreamSecondParent: mergeParents[1],
            originMain: mergeOrigin[2],
            reconciledBase,
            docsEntryHead: manifest.run.entryHead,
            docsCurrentHead: snapshot.head,
          },
          operations,
          pathClasses,
          bEntryIdentity: {
            snapshotDigestSha256: manifest.entrySnapshot.digestSha256,
            publicSurfaceSha256: hashTrackedFile('docs/public-surface.md'),
            publicationAuditSha256: publicationAudit.sha256,
            handoffSha256: hashTrackedFile('docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md'),
            workIndexJsonSha256: hashTrackedFile('docs/work-index.json'),
            workIndexMarkdownSha256: hashTrackedFile('docs/work-index.md'),
          },
          overallVerdict: operations.every((row) => row['verdict'] === 'Pass') ? 'Pass' : 'Inconclusive',
        };
        const structuredValidation = validateBoundaryStructuredRecord('DocsLineageReport', structuredRecord);
        issues.push(...structuredValidation.issues);
        structuredPath = 'docs-lineage.json';
        artifactRole = 'scope';
      } catch (error) {
        issues.push({ code: 'docs-lineage-invalid', message: (error as Error).message });
      }
      break;
    }
    case 'read-only-scope':
      if (changedPaths.length > 0 || canonicalizeBoundaryRun(snapshot) !== canonicalizeBoundaryRun(manifest.entrySnapshot)) {
        issues.push({ code: 'internal-read-only-drift', message: 'read-only scope changed the worktree' });
      }
      break;
    case 'staged-scope':
      if (canonicalizeBoundaryRun(stagedPaths) !== canonicalizeBoundaryRun(allowedPaths) || unstagedPaths.length > 0) {
        issues.push({ code: 'internal-staged-scope-mismatch', message: 'staged paths are not the exact profile allowlist' });
      }
      break;
    case 'docs-authoring-scope':
      if (stagedPaths.length > 0 || manifest.children.length !== manifest.run.requiredChildAliases.length) {
        issues.push({ code: 'internal-docs-authoring-incomplete', message: 'docs authoring scope requires no staged paths and all child joins' });
      }
      break;
    case 'review-contract':
      issues.push(...verifyRecordedReviews(manifest, runDir, true));
      break;
    default:
      issues.push({ code: 'internal-check-not-implemented', message: `internal check is not implemented: ${check}` });
  }
  return {
    result: operationResult(issues),
    details: { check, changedPaths, stagedPaths, unstagedPaths, foreignPaths, ownerStable },
    ...(structuredRecord === undefined ? {} : { structuredRecord }),
    ...(structuredPath === undefined ? {} : { structuredPath }),
    ...(artifactRole === undefined ? {} : { artifactRole }),
    ...(reuseStructuredArtifact ? { reuseStructuredArtifact: true } : {}),
  };
}

export function recordInternalCheck(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const attemptId = stringOption(invocation.options, 'attempt')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  if (manifest.attempts.some((entry) => entry.id === attemptId) || existsSync(path.join(runDir, 'attempts', attemptId))) {
    return operationResult([{ code: 'attempt-duplicate', message: `attempt already exists: ${attemptId}` }], 2);
  }
  if (!manifest.run.requiredAttemptIds.includes(attemptId)) {
    return operationResult([{ code: 'attempt-not-required', message: `attempt is not owned by the profile: ${attemptId}` }], 2);
  }
  const contract = RUN_ATTEMPT_CONTRACTS[attemptId];
  if (contract === undefined || contract.operation !== 'internal-check' || contract.internalCheck === null) {
    return operationResult([{ code: 'attempt-operation-mismatch', message: 'attempt is not an internal-check contract' }], 2);
  }
  const expectedHead = contract.headAnchor === 'entry' ? manifest.run.entryHead : manifest.run.terminalHead;
  if (expectedHead === null || gitText(cwd, ['rev-parse', 'HEAD']) !== expectedHead) {
    return operationResult([{ code: 'attempt-head-anchor-mismatch', message: 'Git head differs from the internal-check anchor' }]);
  }
  const before = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!before.ok || before.snapshot === null) return operationResult(before.issues);
  const startedAtUtc = new Date().toISOString();
  const evaluated = evaluateInternalCheck(contract.internalCheck, manifest, runDir, cwd, before.snapshot);
  if (
    evaluated.structuredPath !== undefined
    && !evaluated.reuseStructuredArtifact
    && !contract.outputPaths.includes(evaluated.structuredPath)
  ) {
    return operationResult([{
      code: 'internal-check-output-contract-mismatch',
      message: 'helper-derived output path differs from the frozen internal-check contract',
    }], 2);
  }
  if (evaluated.result.ok && contract.outputPaths.length > 0 && evaluated.structuredPath === undefined) {
    return operationResult([{
      code: 'internal-check-required-output-missing',
      message: 'successful internal check did not derive its profile-owned output',
    }]);
  }
  const after = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!after.ok || after.snapshot === null) return operationResult(after.issues);
  const attemptDir = path.join(runDir, 'attempts', attemptId);
  const structuredPath = evaluated.structuredPath
    ?? contract.outputPaths[0]
    ?? `attempts/${attemptId}/structured-result.json`;
  try {
    mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
    durableExclusiveWrite(path.join(attemptDir, 'stdout.log'), '');
    durableExclusiveWrite(path.join(attemptDir, 'stderr.log'), '');
    if (!evaluated.reuseStructuredArtifact) {
      durableExclusiveWrite(path.join(runDir, structuredPath), canonicalizeBoundaryRun(
        evaluated.structuredRecord ?? {
          schemaVersion: 1,
          attemptId,
          ...evaluated.details,
          issues: evaluated.result.issues,
          verdict: evaluated.result.verdict,
        },
      ));
    }
  } catch (error) {
    return operationResult([{ code: 'attempt-directory-failed', message: (error as Error).message }]);
  }
  const rawExit = evaluated.result.ok ? 0 : 1;
  const status = {
    expectedExit: contract.expectedExit,
    rawExit,
    rawSignal: null,
    expectationMet: evaluated.result.ok,
    watchdogOwner: contract.watchdogOwner,
    innerTimeoutOwner: contract.innerTimeoutOwner,
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
  };
  const statusValidation = validateBoundaryAttemptStatus(status, { rawExit, rawSignal: null }, contract);
  const verdict = evaluated.result.ok && statusValidation.ok ? 'Pass' as const : 'Inconclusive' as const;
  const structuredStream = streamRecord(runDir, structuredPath);
  const ownsStructuredOutput = contract.outputPaths.includes(structuredPath) && !evaluated.reuseStructuredArtifact;
  const declaredOutputs = ownsStructuredOutput ? [...contract.outputPaths] : [];
  const outputAdmissions = !ownsStructuredOutput ? [] : [{
    path: structuredPath,
    state: 'admitted' as const,
    role: evaluated.artifactRole ?? 'receipt' as const,
    sha256: structuredStream.sha256,
    bytes: structuredStream.bytes,
  }];
  manifest.attempts.push({
    id: attemptId,
    operation: 'internal-check',
    headAnchor: contract.headAnchor,
    argv: [],
    cwd,
    startedAtUtc,
    endedAtUtc: new Date().toISOString(),
    ...status,
    preSnapshot: before.snapshot,
    postSnapshot: after.snapshot,
    stdout: streamRecord(runDir, `attempts/${attemptId}/stdout.log`),
    stderr: streamRecord(runDir, `attempts/${attemptId}/stderr.log`),
    declaredOutputs,
    outputAdmissions,
    structuredResult: structuredStream,
    verdict,
  });
  if (ownsStructuredOutput) {
    manifest.artifacts.push({
      path: structuredPath,
      role: evaluated.artifactRole ?? 'receipt',
      producerAttemptId: attemptId,
      sha256: structuredStream.sha256,
      bytes: structuredStream.bytes,
    });
  }
  manifest.currentSnapshot = structuredClone(after.snapshot);
  manifest.overallVerdict = aggregateRunVerdict(manifest);
  const validation = validateBoundaryRun(manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(manifest));
  const issues = [...evaluated.result.issues, ...statusValidation.issues];
  return operationResult(issues, issues.length === 0 ? 0 : 1, verdict);
}

