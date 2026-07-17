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

import { verifyManifestEvidence } from './lifecycle.ts';

export async function recordGitTransition(
  invocation: BoundaryRunInvocation,
  cwd: string,
): Promise<BoundaryValidationResult> {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const attemptId = stringOption(invocation.options, 'attempt')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest, path: manifestPath } = loaded;
  if (
    manifest.attempts.some((entry) => entry.id === attemptId)
    || existsSync(path.join(runDir, 'attempts', attemptId))
  ) {
    return operationResult([{ code: 'attempt-duplicate', message: `attempt already exists: ${attemptId}` }], 2);
  }
  if (!manifest.run.requiredAttemptIds.includes(attemptId)) {
    return operationResult([{ code: 'attempt-not-required', message: `attempt is not owned by the profile: ${attemptId}` }], 2);
  }
  const contract = RUN_ATTEMPT_CONTRACTS[attemptId];
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  const kind = stringOption(invocation.options, 'kind') as 'commit' | 'merge';
  const expectedBefore = stringOption(invocation.options, 'expectBefore')!;
  const expectedSecondParent = stringOption(invocation.options, 'expectSecondParent') ?? null;
  const messageSubject = stringOption(invocation.options, 'messageSubject') ?? null;
  const expectedChildAliases = profile === undefined
    ? []
    : (profile.requiredChildren as readonly string[]).map((entry) => entry.split(':', 1)[0]!);
  if (
    contract === undefined
    || contract.operation !== 'git-transition'
    || profile === undefined
    || profile.taskId !== manifest.run.taskId
    || profile.transition !== kind
    || contract.transitionKind !== kind
    || contract.messageSubject !== messageSubject
    || expectedBefore !== manifest.run.entryHead
    || (kind === 'commit' && expectedSecondParent !== null)
    || canonicalizeBoundaryRun(manifest.run.requiredAttemptIds)
      !== canonicalizeBoundaryRun(profile?.requiredAttemptIds ?? [])
    || canonicalizeBoundaryRun(manifest.run.requiredChildAliases)
      !== canonicalizeBoundaryRun(expectedChildAliases)
  ) {
    return operationResult([{
      code: 'transition-contract-mismatch',
      message: 'Git transition invocation differs from its profile-owned contract',
    }], 2);
  }
  if (manifest.run.transitionCount !== 0 || manifest.run.terminalHead !== null) {
    return operationResult([{ code: 'transition-already-used', message: 'run already consumed its sole Git transition' }], 2);
  }
  const capability = resolveBoundaryToolCapability('git');
  const frozenCapability = manifest.run.observedTools.find((entry) => entry.name === 'git');
  if (frozenCapability === undefined || canonicalizeBoundaryRun(frozenCapability) !== canonicalizeBoundaryRun(capability)) {
    return operationResult([{ code: 'attempt-tool-capability-mismatch', message: 'Git identity changed since init' }]);
  }
  const beforeHead = gitText(cwd, ['rev-parse', 'HEAD']);
  if (beforeHead !== expectedBefore) {
    return operationResult([{ code: 'transition-parent-mismatch', message: 'Git head differs from the frozen transition parent' }]);
  }
  const before = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!before.ok || before.snapshot === null) return operationResult(before.issues);
  if (canonicalizeBoundaryRun(before.snapshot) !== canonicalizeBoundaryRun(manifest.currentSnapshot)) {
    return operationResult([{ code: 'transition-pre-snapshot-drift', message: 'worktree changed before Git transition' }]);
  }
  const allowedPaths = canonicalSet(manifest.run.allowedPaths);
  const stagedPaths = gitPathSet(cwd, ['diff', '--cached', '--name-only', '--']);
  const changedPathsBefore = gitPathSet(cwd, ['diff', '--name-only', 'HEAD', '--']);
  const unstagedPaths = gitPathSet(cwd, ['diff', '--name-only', '--']);
  const prePathsValid = kind === 'commit'
    ? canonicalizeBoundaryRun(stagedPaths) === canonicalizeBoundaryRun(allowedPaths)
      && canonicalizeBoundaryRun(changedPathsBefore) === canonicalizeBoundaryRun(allowedPaths)
      && unstagedPaths.length === 0
    : stagedPaths.length === 0 && changedPathsBefore.length === 0 && unstagedPaths.length === 0;
  if (!prePathsValid) {
    return operationResult([{
      code: 'transition-path-mismatch',
      message: kind === 'commit'
        ? 'staged and changed paths must equal the exact profile allowlist with no unstaged delta'
        : 'merge transition requires an unchanged pre-merge index and worktree',
    }], 2);
  }
  let observationUpstream: BoundaryRunManifest['upstream'] | null = null;
  let previewConflictPaths: string[] = [];
  if (kind === 'commit') {
    if (
      !Array.isArray(profile!.allowedPaths)
      || canonicalizeBoundaryRun(allowedPaths) !== canonicalizeBoundaryRun(profile!.allowedPaths)
    ) {
      return operationResult([{ code: 'transition-path-mismatch', message: 'commit allowlist differs from its profile' }], 2);
    }
  } else {
    const evidence = verifyManifestEvidence(manifest, runDir, cwd, false);
    if (evidence.length > 0) return operationResult(evidence);
    try {
      const predecessor = manifest.predecessor;
      if (predecessor === null) throw new Error('merge predecessor is unavailable');
      const sourceBytes = readConfinedRegularFile(path.join(runDir, 'predecessor'), 'run_manifest.json');
      const sourceValidation = validateBoundaryRunJson(sourceBytes);
      if (!sourceValidation.ok) throw new Error('merge observation manifest is invalid');
      const source = JSON.parse(sourceBytes.toString('utf8')) as BoundaryRunManifest;
      observationUpstream = source.upstream;
      const preview = acceptedAttemptStdout(source, path.join(runDir, 'predecessor'), 'merge-preview');
      const parsedPreview = parseBoundaryMergePreviewStdout(preview);
      if (parsedPreview === null) throw new Error('merge preview is malformed');
      previewConflictPaths = parsedPreview.conflictPaths;
      if (
        source.run.profileId !== 'bcf00-observation'
        || source.manifestState !== 'finalized'
        || source.overallVerdict !== 'Pass'
        || source.upstream.observedOid !== expectedSecondParent
        || canonicalizeBoundaryRun(source.upstream.remotePaths) !== canonicalizeBoundaryRun(allowedPaths)
        || predecessor.pin.manifestSha256 !== sha256(sourceBytes)
      ) {
        throw new Error('merge parent or allowlist differs from the pinned observation');
      }
    } catch (error) {
      return operationResult([{ code: 'transition-observation-mismatch', message: (error as Error).message }], 2);
    }
  }
  let frozenIndexTreeOid: string;
  try {
    frozenIndexTreeOid = gitText(cwd, ['write-tree']);
  } catch (error) {
    return operationResult([{ code: 'transition-index-freeze-failed', message: (error as Error).message }]);
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
  const stdoutPath = `attempts/${attemptId}/stdout.log`;
  const stderrPath = `attempts/${attemptId}/stderr.log`;
  const logicalArgv = kind === 'commit'
    ? ['git', 'commit', '-m', messageSubject!]
    : ['git', 'merge', '--no-edit', expectedSecondParent!];
  const directStdoutPath = kind === 'merge' ? path.join(attemptDir, '.merge-stdout.tmp') : path.join(runDir, stdoutPath);
  const directStderrPath = kind === 'merge' ? path.join(attemptDir, '.merge-stderr.tmp') : path.join(runDir, stderrPath);
  let outcome = await runBoundaryAttemptProcess([capability.realPath, ...logicalArgv.slice(1)], {
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
    expectedExit: contract.expectedExit,
    cwd,
    env: reconstructedChildEnvironment(cwd),
    stdinPath: null,
    stdoutPath: directStdoutPath,
    stderrPath: directStderrPath,
  });
  let directSucceeded = outcome.rawExit === 0 && outcome.rawSignal === null && outcome.result.ok;
  let conflictPaths: string[] = [];
  let conflictResolutionReport: Record<string, unknown> | null = null;
  const resolutionStdout: Buffer[] = [];
  const resolutionStderr: Buffer[] = [];
  let abortAttempted = false;
  let abortRestored: boolean | null = null;
  let abortIssues: BoundaryValidationIssue[] = [];
  if (kind === 'merge' && !directSucceeded) {
    conflictPaths = gitPathSet(cwd, ['diff', '--name-only', '--diff-filter=U', '--']);
    const generatedIndexPaths = ['docs/work-index.json', 'docs/work-index.md'];
    const resolutionEligible = manifest.run.profileId === 'bcf00-reconciliation'
      && expectedSecondParent === BOUNDARY_PINNED_GENERATED_INDEX_PARENT
      && canonicalizeBoundaryRun(conflictPaths) === canonicalizeBoundaryRun(generatedIndexPaths)
      && canonicalizeBoundaryRun(previewConflictPaths) === canonicalizeBoundaryRun(generatedIndexPaths);
    if (resolutionEligible) {
      const indexStages = gitText(cwd, ['ls-files', '-u', '--', ...generatedIndexPaths])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parsed = /^([0-7]{6}) ([0-9a-f]{40}) ([123])\t(.+)$/.exec(line);
          if (parsed === null) throw new Error(`invalid conflict stage: ${line}`);
          return { path: parsed[4]!, stage: Number(parsed[3]), mode: parsed[1]!, oid: parsed[2]! };
        })
        .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)) || left.stage - right.stage);
      const deadlineAt = Date.parse(outcome.startedAtUtc) + contract.deadlineMs;
      const runResolutionStep = async (
        label: string,
        argv: string[],
        expectedExit = '0',
      ): Promise<Awaited<ReturnType<typeof runBoundaryAttemptProcess>>> => {
        const stdoutTemp = path.join(attemptDir, `.${label}-stdout.tmp`);
        const stderrTemp = path.join(attemptDir, `.${label}-stderr.tmp`);
        const step = await runBoundaryAttemptProcess(argv, {
          deadlineMs: Math.max(1, deadlineAt - Date.now()),
          killGraceMs: contract.killGraceMs,
          expectedExit,
          cwd,
          env: reconstructedChildEnvironment(cwd),
          stdinPath: null,
          stdoutPath: stdoutTemp,
          stderrPath: stderrTemp,
        });
        resolutionStdout.push(Buffer.from(`\n${label}:\n`), readFileSync(stdoutTemp));
        resolutionStderr.push(Buffer.from(`\n${label}:\n`), readFileSync(stderrTemp));
        unlinkSync(stdoutTemp);
        unlinkSync(stderrTemp);
        return step;
      };
      const bashCapability = capabilityForManifest(manifest, 'bash');
      let generator = await runResolutionStep('generator', [
        bashCapability.realPath, 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen',
      ]);
      let resolvedPaths = gitPathSet(cwd, ['diff', '--name-only', '--']);
      let unmergedPaths = gitPathSet(cwd, ['diff', '--name-only', '--diff-filter=U', '--']);
      let conflictMarkerPaths = generatedIndexPaths.filter((relativePath) => {
        const text = readFileSync(path.join(cwd, relativePath), 'utf8');
        return text.split('\n').some((line) => /^(?:<{7}|={7}|>{7})/.test(line));
      });
      let addResult: Awaited<ReturnType<typeof runBoundaryAttemptProcess>> | null = null;
      let diffCheck: Awaited<ReturnType<typeof runBoundaryAttemptProcess>> | null = null;
      let workIndexGuard: Awaited<ReturnType<typeof runBoundaryAttemptProcess>> | null = null;
      let resolvedStateDigestSha256 = before.snapshot.digestSha256;
      if (
        generator.result.ok
        && canonicalizeBoundaryRun(resolvedPaths) === canonicalizeBoundaryRun(generatedIndexPaths)
        && conflictMarkerPaths.length === 0
      ) {
        addResult = await runResolutionStep('stage-generated-indexes', [
          capability.realPath, 'add', '--', ...generatedIndexPaths,
        ]);
        unmergedPaths = gitPathSet(cwd, ['diff', '--name-only', '--diff-filter=U', '--']);
        conflictMarkerPaths = generatedIndexPaths.filter((relativePath) => {
          const text = readFileSync(path.join(cwd, relativePath), 'utf8');
          return text.split('\n').some((line) => /^(?:<{7}|={7}|>{7})/.test(line));
        });
      }
      if (addResult?.result.ok && unmergedPaths.length === 0 && conflictMarkerPaths.length === 0) {
        diffCheck = await runResolutionStep('diff-check', [capability.realPath, 'diff', '--check']);
      }
      if (diffCheck?.result.ok) {
        workIndexGuard = await runResolutionStep('work-index-guard', [
          bashCapability.realPath, 'scripts/run-with-pinned-npm.sh', 'run', 'guard:work-index',
        ]);
      }
      const resolvedSnapshot = workIndexGuard?.result.ok
        ? captureBoundaryWorktreeSnapshot(cwd, {
            allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
            preservedOwnerPaths: manifest.run.preservedOwnerPaths,
          })
        : null;
      let resolutionReady = false;
      if (resolvedSnapshot?.ok && resolvedSnapshot.snapshot !== null) {
        resolvedStateDigestSha256 = resolvedSnapshot.snapshot.digestSha256;
        resolutionReady = true;
      }
      conflictResolutionReport = {
        schemaVersion: 1,
        policy: 'regenerate-generated-work-index',
        beforeHead,
        expectedSecondParent,
        conflictPaths,
        indexStages,
        generatorArgv: ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen'],
        generatorRawExit: generator.rawExit,
        generatorRawSignal: generator.rawSignal,
        resolvedPaths,
        unmergedPaths,
        conflictMarkerPaths,
        diffCheckRawExit: diffCheck?.rawExit ?? 1,
        diffCheckRawSignal: diffCheck?.rawSignal ?? null,
        workIndexGuardRawExit: workIndexGuard?.rawExit ?? 1,
        workIndexGuardRawSignal: workIndexGuard?.rawSignal ?? null,
        preStateDigestSha256: before.snapshot.digestSha256,
        resolvedStateDigestSha256,
        verdict: resolutionReady ? 'Pass' : 'Inconclusive',
      };
      if (resolutionReady) {
        const reportValidation = validateBoundaryStructuredRecord(
          'MergeConflictResolutionReport', conflictResolutionReport,
        );
        if (reportValidation.ok) {
          outcome = await runResolutionStep('commit-merge', [capability.realPath, 'commit', '--no-edit']);
          directSucceeded = outcome.rawExit === 0 && outcome.rawSignal === null && outcome.result.ok;
          if (!directSucceeded) conflictResolutionReport['verdict'] = 'Inconclusive';
        } else {
          abortIssues.push(...reportValidation.issues);
          directSucceeded = false;
        }
      }
    }
  }
  if (kind === 'merge' && !directSucceeded) {
    if (conflictPaths.length === 0) {
      conflictPaths = gitPathSet(cwd, ['diff', '--name-only', '--diff-filter=U', '--']);
    }
    abortAttempted = true;
    const abortStdoutPath = path.join(attemptDir, '.abort-stdout.tmp');
    const abortStderrPath = path.join(attemptDir, '.abort-stderr.tmp');
    const abort = await runBoundaryAttemptProcess([capability.realPath, 'merge', '--abort'], {
      deadlineMs: contract.deadlineMs,
      killGraceMs: contract.killGraceMs,
      expectedExit: '0',
      cwd,
      env: reconstructedChildEnvironment(cwd),
      stdinPath: null,
      stdoutPath: abortStdoutPath,
      stderrPath: abortStderrPath,
    });
    abortIssues.push(...abort.result.issues);
    const mergeStdout = readFileSync(directStdoutPath);
    const mergeStderr = readFileSync(directStderrPath);
    const abortStdout = readFileSync(abortStdoutPath);
    const abortStderr = readFileSync(abortStderrPath);
    durableExclusiveWrite(path.join(runDir, stdoutPath), Buffer.concat([
      Buffer.from('merge:\n'), mergeStdout, Buffer.from('\nabort:\n'), abortStdout,
      ...resolutionStdout,
    ]));
    durableExclusiveWrite(path.join(runDir, stderrPath), Buffer.concat([
      Buffer.from('merge:\n'), mergeStderr, Buffer.from('\nabort:\n'), abortStderr,
      ...resolutionStderr,
    ]));
    for (const temporary of [directStdoutPath, directStderrPath, abortStdoutPath, abortStderrPath]) unlinkSync(temporary);
  } else if (kind === 'merge') {
    durableExclusiveWrite(path.join(runDir, stdoutPath), Buffer.concat([
      readFileSync(directStdoutPath), ...resolutionStdout,
    ]));
    durableExclusiveWrite(path.join(runDir, stderrPath), Buffer.concat([
      readFileSync(directStderrPath), ...resolutionStderr,
    ]));
    unlinkSync(directStdoutPath);
    unlinkSync(directStderrPath);
  }
  const after = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  const afterHead = gitText(cwd, ['rev-parse', 'HEAD']);
  let parents: string[] = [];
  let postIndexTreeOid = frozenIndexTreeOid;
  let commitTreeOid = gitText(cwd, ['rev-parse', `${afterHead}^{tree}`]);
  let changedPaths: string[] = [];
  try {
    postIndexTreeOid = gitText(cwd, ['write-tree']);
    if (afterHead !== beforeHead) {
      const ancestry = gitText(cwd, ['rev-list', '--parents', '-n', '1', afterHead]).split(/\s+/);
      parents = ancestry.slice(1);
      changedPaths = gitPathSet(cwd, ['diff', '--name-only', beforeHead, afterHead, '--']);
    }
  } catch {
    // The postcondition issues below preserve the direct child result as non-pass.
  }
  const structuredResultPath = `attempts/${attemptId}/structured-result.json`;
  const transitionRecord = {
    kind,
    rawExit: outcome.rawExit,
    rawSignal: outcome.rawSignal,
    beforeHead,
    afterHead,
    parents,
    frozenIndexTreeOid,
    postIndexTreeOid,
    commitTreeOid,
    changedPaths,
    conflictPaths,
    abortAttempted,
    abortRestored: abortRestored as boolean | null,
    beforeSnapshotDigestSha256: before.snapshot.digestSha256,
    afterSnapshotDigestSha256: after.snapshot?.digestSha256 ?? before.snapshot.digestSha256,
    conflictResolutionReport,
  };
  durableExclusiveWrite(path.join(runDir, structuredResultPath), canonicalizeBoundaryRun(transitionRecord));

  const postconditionIssues: BoundaryValidationIssue[] = [];
  if (!after.ok || after.snapshot === null) postconditionIssues.push(...after.issues);
  if (directSucceeded) {
    const expectedParents = kind === 'commit' ? [beforeHead] : [beforeHead, expectedSecondParent!];
    if (afterHead === beforeHead || canonicalizeBoundaryRun(parents) !== canonicalizeBoundaryRun(expectedParents)) {
      postconditionIssues.push({ code: 'transition-parent-mismatch', message: 'transition parents differ from the frozen contract' });
    }
    if (
      commitTreeOid !== postIndexTreeOid
      || (kind === 'commit' && commitTreeOid !== frozenIndexTreeOid)
    ) {
      postconditionIssues.push({ code: 'transition-tree-mismatch', message: 'commit, post-index, or frozen index tree is inconsistent' });
    }
    if (
      canonicalizeBoundaryRun(changedPaths) !== canonicalizeBoundaryRun(allowedPaths)
      || gitPathSet(cwd, ['diff', '--name-only', 'HEAD', '--']).length !== 0
    ) {
      postconditionIssues.push({ code: 'transition-path-mismatch', message: 'transition paths or remaining worktree delta violate the profile' });
    }
    const resolvedConflict = conflictResolutionReport?.['verdict'] === 'Pass';
    if (
      abortAttempted
      || abortRestored !== null
      || (
        resolvedConflict
          ? canonicalizeBoundaryRun(conflictPaths) !== canonicalizeBoundaryRun(['docs/work-index.json', 'docs/work-index.md'])
          : conflictPaths.length !== 0
      )
    ) {
      postconditionIssues.push({ code: 'transition-abort-incomplete', message: 'successful transition carried conflict or abort state' });
    }
    if (
      after.snapshot !== null
      && canonicalizeBoundaryRun(after.snapshot.preservedOwner) !== canonicalizeBoundaryRun(before.snapshot.preservedOwner)
    ) {
      postconditionIssues.push({ code: 'transition-owner-drift', message: 'preserved owner paths changed during commit' });
    }
  } else {
    abortRestored = kind === 'merge'
      ? abortIssues.length === 0
        && afterHead === beforeHead
        && after.snapshot !== null
        && canonicalizeBoundaryRun(after.snapshot) === canonicalizeBoundaryRun(before.snapshot)
      : null;
    transitionRecord.abortRestored = abortRestored;
    durableAtomicRewrite(path.join(runDir, structuredResultPath), canonicalizeBoundaryRun(transitionRecord));
    if (
      afterHead !== beforeHead
      || after.snapshot === null
      || canonicalizeBoundaryRun(after.snapshot) !== canonicalizeBoundaryRun(before.snapshot)
      || (kind === 'merge' && abortRestored !== true)
    ) {
      postconditionIssues.push({ code: 'transition-failure-state-drift', message: 'failed transition did not restore the frozen pre-state' });
    }
  }
  const status = {
    expectedExit: contract.expectedExit,
    rawExit: outcome.rawExit,
    rawSignal: outcome.rawSignal,
    expectationMet: directSucceeded && postconditionIssues.length === 0,
    watchdogOwner: contract.watchdogOwner,
    innerTimeoutOwner: contract.innerTimeoutOwner,
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
  };
  const statusValidation = validateBoundaryAttemptStatus(
    status,
    { rawExit: outcome.rawExit, rawSignal: outcome.rawSignal },
    contract,
  );
  const verdict = status.expectationMet && statusValidation.ok ? 'Pass' as const : 'Inconclusive' as const;
  manifest.attempts.push({
    id: attemptId,
    operation: 'git-transition',
    headAnchor: contract.headAnchor,
    argv: logicalArgv,
    cwd,
    startedAtUtc: outcome.startedAtUtc,
    endedAtUtc: outcome.endedAtUtc,
    ...status,
    preSnapshot: before.snapshot,
    postSnapshot: after.snapshot ?? before.snapshot,
    stdout: streamRecord(runDir, stdoutPath),
    stderr: streamRecord(runDir, stderrPath),
    declaredOutputs: [],
    outputAdmissions: [],
    structuredResult: streamRecord(runDir, structuredResultPath),
    verdict,
  });
  manifest.currentSnapshot = structuredClone(after.snapshot ?? before.snapshot);
  if (verdict === 'Pass') {
    manifest.run.terminalHead = afterHead;
    manifest.run.transitionCount = 1;
    if (kind === 'merge' && observationUpstream !== null) {
      manifest.run.reconciledBase = afterHead;
      manifest.upstream = {
        ...structuredClone(observationUpstream),
        observationManifestSha256: manifest.predecessor!.pin.manifestSha256,
        mergeCommit: afterHead,
        mergeParents: [parents[0]!, parents[1]!],
      };
    }
  }
  const validation = validateBoundaryRun(manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(manifestPath, canonicalizeBoundaryRun(manifest));
  const issues = [...outcome.result.issues, ...abortIssues, ...statusValidation.issues, ...postconditionIssues];
  return operationResult(issues, issues.length === 0 ? 0 : 1, verdict);
}
