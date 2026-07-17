import { expect, it } from 'vitest';

import {
  BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
  EXPECTED_CHILD_CONTRACT_ROWS,
  EXPECTED_PREDECESSOR_ROWS,
  EXPECTED_PROFILE_PATHS,
  EXPECTED_PROFILE_ROWS,
  EXPECTED_WIRE_SCHEMAS,
  FIXTURE_EMAIL,
  OID,
  OID_C,
  OID_D,
  SHA,
  SHA_B,
  SHA_C,
  SNAPSHOT_DECLARATIONS,
  SSH_REMOTE,
  TIME,
  boundaryCli,
  boundaryRun,
  canonicalJson,
  canonicalSha,
  chmodSync,
  copyFileSync,
  createFinalizedSyntheticReconciliation,
  createHash,
  evaluateBaseline,
  evaluateCandidate,
  execFileSync,
  existsSync,
  expectedBcf00Markers,
  fileSha,
  fillSyntheticRequiredAttempts,
  finalizeSyntheticObservation,
  fixtureRoots,
  git,
  initializeSyntheticReconciliation,
  installImportedRun,
  loadCorpus,
  lstatSync,
  makeCliRepo,
  makeEvidenceRoot,
  makeOutputRun,
  makeSnapshotRepo,
  marker,
  mkdirSync,
  mkdtempSync,
  path,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  tmpdir,
  validAttempt,
  validBundleInput,
  validChild,
  validChildImportInput,
  validFinding,
  validImmutableClosureInput,
  validLifecycleStateInput,
  validManifest,
  validPredecessor,
  validPredecessorChainInput,
  validReview,
  validReviewJoinInput,
  validSnapshot,
  validStream,
  validTransitionInput,
  validateBoundaryRun,
  withValue,
  writeFileSync,
  writeSyntheticRunInitAnchor,
} from './support.ts';

export function registerTransitionCases(): void {
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
      mergePreviewStdout = execFileSync('git', ['merge-tree', '--write-tree', '--messages', beforeHead, pinnedParent], {
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

}
