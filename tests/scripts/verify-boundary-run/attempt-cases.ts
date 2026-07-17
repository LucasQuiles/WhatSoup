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

export function registerAttemptCases(): void {
  it('records one exact direct command with immutable streams and snapshots', async () => {
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
    const recorded = await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'upstream-root',
      '--expect-exit', '0', '--', 'git', 'rev-parse', '--show-toplevel',
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      attempts: Array<Record<string, unknown>>;
      currentSnapshot: Record<string, unknown>;
    };
    expect(manifest.attempts).toHaveLength(1);
    expect(manifest.attempts[0]).toMatchObject({
      id: 'upstream-root', operation: 'command', rawExit: 0, rawSignal: null,
      expectationMet: true, verdict: 'Pass',
    });
    const stdout = manifest.attempts[0]!['stdout'] as { path: string; sha256: string; bytes: number };
    expect(readFileSync(path.join(fixture.runDir, stdout.path), 'utf8').trim()).toBe(fixture.repo);
    expect(stdout.sha256).toBe(createHash('sha256').update(readFileSync(path.join(fixture.runDir, stdout.path))).digest('hex'));
    const headRecorded = await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'upstream-head',
      '--expect-exit', '0', '--', 'git', 'rev-parse', 'HEAD',
    ], fixture.repo);
    expect(headRecorded, JSON.stringify(headRecorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const advancedManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { attempts: Array<Record<string, unknown>> };
    expect(advancedManifest.attempts).toHaveLength(2);
    const headAttempt = advancedManifest.attempts.find((entry) => entry['id'] === 'upstream-head');
    expect(readFileSync(path.join(fixture.runDir, (headAttempt!['stdout'] as { path: string }).path), 'utf8').trim())
      .toBe(git(fixture.repo, ['rev-parse', 'HEAD']));
    expect(boundaryRun.validateBoundaryRunJson(readFileSync(manifestPath))).toMatchObject({ ok: true, exitCode: 0 });
    expect(await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'upstream-root',
      '--expect-exit', '0', '--', 'git', 'rev-parse', '--show-toplevel',
    ], fixture.repo)).toMatchObject({ ok: false, exitCode: 2 });
  });

  it('admits profile-owned unstaged work before a command and rejects foreign drift before spawn', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const predecessor = await createFinalizedSyntheticReconciliation(fixture.repo, api.runBoundaryRunCli, 'parser-work');
    const predecessorPin = [
      'BCF-00', 'bcf00-reconciliation', predecessor.runId, predecessor.terminalHead,
      predecessor.manifestSha256, predecessor.completionReceiptSha256, predecessor.ledgerSha256,
    ].join(',');
    const runDir = path.join(fixture.repo, 'evidence/task01/parser-work-successor');
    const profile = boundaryRun.RUN_CONTRACT_PROFILES['bcf01-parser'];
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', runDir, '--task', 'BCF-01', '--profile', 'bcf01-parser',
      '--predecessor-run-dir', predecessor.runDir, '--predecessor-pin', predecessorPin,
      ...profile.allowedPaths.flatMap((relativePath) => ['--allow-path', relativePath]),
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });

    writeFileSync(path.join(fixture.repo, 'tests/scripts/semantic-quality-check.test.ts'), 'test red fixture\n');
    const recorded = await api.runBoundaryRunCli([
      'record-command', '--run-dir', runDir, '--attempt', 'parser-typecheck', '--expect-exit', '0', '--',
      'bash', 'scripts/run-with-pinned-npm.sh', 'run', 'typecheck:scripts',
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'run_manifest.json'), 'utf8')) as {
      entrySnapshot: { indexTreeOid: string; unstagedPatchSha256: string };
      attempts: Array<{ id: string; preSnapshot: { indexTreeOid: string; unstagedPatchSha256: string } }>;
    };
    const attempt = manifest.attempts.find((entry) => entry.id === 'parser-typecheck');
    expect(attempt?.preSnapshot.indexTreeOid).toBe(manifest.entrySnapshot.indexTreeOid);
    expect(attempt?.preSnapshot.unstagedPatchSha256).not.toBe(manifest.entrySnapshot.unstagedPatchSha256);

    const recordParserRed = () => api.runBoundaryRunCli!([
      'record-command', '--run-dir', runDir, '--attempt', 'parser-red', '--expect-exit', 'nonzero', '--',
      'bash', 'scripts/run-with-pinned-npm.sh', 'test', '--',
      'tests/scripts/semantic-quality-check.test.ts', '--pool=forks', '--fileParallelism=false',
    ], fixture.repo);

    writeFileSync(path.join(fixture.repo, '.gitignore'), 'evidence/\nforeign-drift/\n');
    expect(await recordParserRed()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'attempt-pre-snapshot-drift' })],
    });
    expect(existsSync(path.join(runDir, 'attempts/parser-red'))).toBe(false);

    writeFileSync(path.join(fixture.repo, '.gitignore'), 'evidence/\n');
    writeFileSync(path.join(fixture.repo, 'owner.tsv'), 'mutated owner\n');
    expect(await recordParserRed()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'attempt-pre-snapshot-drift' })],
    });
    writeFileSync(path.join(fixture.repo, 'owner.tsv'), 'owner\n');

    writeFileSync(path.join(fixture.repo, 'unexpected.txt'), 'unexpected\n');
    expect(await recordParserRed()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'snapshot-unexpected-untracked' })],
    });
    rmSync(path.join(fixture.repo, 'unexpected.txt'));

    git(fixture.repo, ['add', 'tests/scripts/semantic-quality-check.test.ts']);
    expect(await recordParserRed()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'attempt-pre-snapshot-drift' })],
    });
    expect(existsSync(path.join(runDir, 'attempts/parser-red'))).toBe(false);
  });


  it('[BCF00-U03] rejects unsafe or raced derived roots', () => {
    type Reservation = Record<string, unknown>;
    const api = boundaryRun as unknown as {
      reserveBoundaryDerivedRoot?: (input: {
        evidenceRoot: string;
        parentSegments: readonly string[];
        runId: string;
        kind: 'run';
        protectedPaths: readonly string[];
      }) => { ok: boolean; reservation: Reservation | null; issues: Array<{ code: string }> };
      createBoundaryDerivedRoot?: (reservation: Reservation) => { ok: boolean; issues: Array<{ code: string }> };
    };
    expect(typeof api.reserveBoundaryDerivedRoot).toBe('function');
    expect(typeof api.createBoundaryDerivedRoot).toBe('function');
    if (!api.reserveBoundaryDerivedRoot || !api.createBoundaryDerivedRoot) return;

    for (const parentSegments of [['/absolute'], ['..']] as const) {
      const result = api.reserveBoundaryDerivedRoot({
        evidenceRoot: makeEvidenceRoot(),
        parentSegments,
        runId: 'valid-run',
        kind: 'run',
        protectedPaths: [],
      });
      expect(result.ok).toBe(false);
      expect(result.issues.map((entry) => entry.code)).toContain('derived-root-path-invalid');
    }

    const overlapRoot = makeEvidenceRoot();
    const overlap = api.reserveBoundaryDerivedRoot({
      evidenceRoot: overlapRoot,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [path.join(overlapRoot, 'observation', 'valid-run', 'output.json')],
    });
    expect(overlap.ok).toBe(false);
    expect(overlap.issues.map((entry) => entry.code)).toContain('derived-root-overlap');

    const existingRoot = makeEvidenceRoot();
    mkdirSync(path.join(existingRoot, 'observation', 'valid-run'));
    const existing = api.reserveBoundaryDerivedRoot({
      evidenceRoot: existingRoot,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [],
    });
    expect(existing.ok).toBe(false);
    expect(existing.issues.map((entry) => entry.code)).toContain('derived-root-exists');

    const symlinkRootInput = mkdtempSync(path.join(tmpdir(), 'boundary-run-symlink-'));
    fixtureRoots.push(symlinkRootInput);
    const symlinkRoot = realpathSync(symlinkRootInput);
    mkdirSync(path.join(symlinkRoot, 'real-observation'));
    symlinkSync(path.join(symlinkRoot, 'real-observation'), path.join(symlinkRoot, 'observation'));
    const symlinked = api.reserveBoundaryDerivedRoot({
      evidenceRoot: symlinkRoot,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [],
    });
    expect(symlinked.ok).toBe(false);
    expect(symlinked.issues.map((entry) => entry.code)).toContain('derived-root-symlink');

    const racedRoot = makeEvidenceRoot();
    const raced = api.reserveBoundaryDerivedRoot({
      evidenceRoot: racedRoot,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [],
    });
    expect(raced.ok).toBe(true);
    renameSync(path.join(racedRoot, 'observation'), path.join(racedRoot, 'observation-old'));
    mkdirSync(path.join(racedRoot, 'observation'));
    const racedCreation = api.createBoundaryDerivedRoot(raced.reservation!);
    expect(racedCreation.ok).toBe(false);
    expect(racedCreation.issues.map((entry) => entry.code)).toContain('derived-root-parent-raced');
  });

  it('[BCF00-N03] exclusively creates one fresh confined derived sibling', () => {
    type Reservation = Record<string, unknown>;
    const api = boundaryRun as unknown as {
      reserveBoundaryDerivedRoot?: (input: {
        evidenceRoot: string;
        parentSegments: readonly string[];
        runId: string;
        kind: 'run';
        protectedPaths: readonly string[];
      }) => { ok: boolean; reservation: Reservation | null; issues: Array<{ code: string }> };
      createBoundaryDerivedRoot?: (reservation: Reservation) => { ok: boolean; record?: unknown; issues: Array<{ code: string }> };
    };
    expect(typeof api.reserveBoundaryDerivedRoot).toBe('function');
    expect(typeof api.createBoundaryDerivedRoot).toBe('function');
    if (!api.reserveBoundaryDerivedRoot || !api.createBoundaryDerivedRoot) return;

    const root = makeEvidenceRoot();
    const reserved = api.reserveBoundaryDerivedRoot({
      evidenceRoot: root,
      parentSegments: ['observation'],
      runId: 'valid-run',
      kind: 'run',
      protectedPaths: [],
    });
    expect(reserved.ok, reserved.issues.map((entry) => entry.code).join(', ')).toBe(true);
    const created = api.createBoundaryDerivedRoot(reserved.reservation!);
    expect(created.ok, created.issues.map((entry) => entry.code).join(', ')).toBe(true);
    expect(created.record).toMatchObject({
      kind: 'run',
      path: path.join(root, 'observation', 'valid-run'),
      state: 'created',
    });
    expect(api.createBoundaryDerivedRoot(reserved.reservation!).ok).toBe(false);
  });

  it('[BCF00-U04] rejects rewritten or contract-inconsistent child status', () => {
    type StatusInput = {
      expectedExit: string;
      rawExit: number | null;
      rawSignal: string | null;
      expectationMet: boolean;
      watchdogOwner: 'helper-watchdog' | null;
      innerTimeoutOwner: 'gnu-timeout' | null;
      deadlineMs: number;
      killGraceMs: number;
    };
    const api = boundaryRun as unknown as {
      validateBoundaryAttemptStatus?: (
        recorded: StatusInput,
        observed: { rawExit: number | null; rawSignal: string | null },
        contract: Pick<StatusInput, 'expectedExit' | 'watchdogOwner' | 'innerTimeoutOwner' | 'deadlineMs' | 'killGraceMs'>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryAttemptStatus).toBe('function');
    if (!api.validateBoundaryAttemptStatus) return;

    const contract = {
      expectedExit: '1,2',
      watchdogOwner: 'helper-watchdog' as const,
      innerTimeoutOwner: null,
      deadlineMs: 60_000,
      killGraceMs: 30_000,
    };
    const valid: StatusInput = {
      ...contract,
      rawExit: 1,
      rawSignal: null,
      expectationMet: true,
    };
    const cases: Array<{ code: string; record: StatusInput; observed?: { rawExit: number | null; rawSignal: string | null } }> = [
      { code: 'attempt-status-rewritten', record: { ...valid, rawExit: 0 } },
      {
        code: 'attempt-signal-not-exit',
        record: { ...valid, expectedExit: '137', rawExit: null, rawSignal: 'SIGKILL', expectationMet: true },
        observed: { rawExit: null, rawSignal: 'SIGKILL' },
      },
      { code: 'attempt-status-missing', record: { ...valid, rawExit: null, rawSignal: null, expectationMet: false }, observed: { rawExit: null, rawSignal: null } },
      { code: 'attempt-watchdog-owner-mismatch', record: { ...valid, watchdogOwner: null } },
      { code: 'attempt-inner-timeout-owner-mismatch', record: { ...valid, innerTimeoutOwner: 'gnu-timeout' } },
      { code: 'attempt-deadline-mismatch', record: { ...valid, deadlineMs: 59_999 } },
    ];
    for (const candidate of cases) {
      const result = api.validateBoundaryAttemptStatus(
        candidate.record,
        candidate.observed ?? { rawExit: 1, rawSignal: null },
        contract,
      );
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }
  });

  it('[BCF00-N04] accepts the direct expected status with exact timeout owners and deadline', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryAttemptStatus?: (
        recorded: Record<string, unknown>,
        observed: { rawExit: number | null; rawSignal: string | null },
        contract: Record<string, unknown>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryAttemptStatus).toBe('function');
    if (!api.validateBoundaryAttemptStatus) return;
    const contract = {
      expectedExit: '1,2',
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 60_000,
      killGraceMs: 30_000,
    };
    expect(api.validateBoundaryAttemptStatus(
      { ...contract, rawExit: 1, rawSignal: null, expectationMet: true },
      { rawExit: 1, rawSignal: null },
      contract,
    )).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  });

  it('[BCF00-U05] rejects unsafe or incomplete output admissions', () => {
    const api = boundaryRun as unknown as {
      admitBoundaryOutput?: (input: {
        runDir: string;
        attempt: ReturnType<typeof validAttempt>;
        artifacts: Array<Record<string, unknown>>;
        path: string;
        role: string;
        producerAttemptId: string;
      }) => {
        result: ReturnType<typeof validateBoundaryRun>;
        attempt: ReturnType<typeof validAttempt>;
        artifacts: Array<Record<string, unknown>>;
      };
      validateBoundaryOutputClosure?: (
        runDir: string,
        attempt: ReturnType<typeof validAttempt>,
        artifacts: Array<Record<string, unknown>>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.admitBoundaryOutput).toBe('function');
    expect(typeof api.validateBoundaryOutputClosure).toBe('function');
    if (!api.admitBoundaryOutput || !api.validateBoundaryOutputClosure) return;

    const pending = makeOutputRun();
    const pendingResult = api.validateBoundaryOutputClosure(pending.root, pending.attempt, []);
    expect(pendingResult.ok).toBe(false);
    expect(pendingResult.issues.map((entry) => entry.code)).toContain('output-pending');

    const admissionCases = [
      { code: 'output-undeclared', mutate: (attempt: ReturnType<typeof validAttempt>) => attempt, path: 'outputs/other.txt', role: 'output', producer: 'upstream-root' },
      {
        code: 'output-missing',
        mutate: (attempt: ReturnType<typeof validAttempt>) => {
          attempt.outputAdmissions[0]!.state = 'missing';
          return attempt;
        },
        path: 'outputs/root.txt',
        role: 'output',
        producer: 'upstream-root',
      },
      { code: 'output-producer-mismatch', mutate: (attempt: ReturnType<typeof validAttempt>) => attempt, path: 'outputs/root.txt', role: 'output', producer: 'other-attempt' },
      { code: 'output-role-invalid', mutate: (attempt: ReturnType<typeof validAttempt>) => attempt, path: 'outputs/root.txt', role: 'foreign', producer: 'upstream-root' },
    ];
    for (const candidate of admissionCases) {
      const fixture = makeOutputRun();
      const outcome = api.admitBoundaryOutput({
        runDir: fixture.root,
        attempt: candidate.mutate(fixture.attempt),
        artifacts: [],
        path: candidate.path,
        role: candidate.role,
        producerAttemptId: candidate.producer,
      });
      expect(outcome.result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(outcome.result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }

    const duplicateFixture = makeOutputRun();
    const admitted = api.admitBoundaryOutput({
      runDir: duplicateFixture.root,
      attempt: duplicateFixture.attempt,
      artifacts: [],
      path: 'outputs/root.txt',
      role: 'output',
      producerAttemptId: 'upstream-root',
    });
    const duplicate = api.admitBoundaryOutput({
      runDir: duplicateFixture.root,
      attempt: admitted.attempt,
      artifacts: admitted.artifacts,
      path: 'outputs/root.txt',
      role: 'output',
      producerAttemptId: 'upstream-root',
    });
    expect(duplicate.result.ok).toBe(false);
    expect(duplicate.result.issues.map((entry) => entry.code)).toContain('output-duplicate-admission');

    writeFileSync(path.join(duplicateFixture.root, 'outputs/root.txt'), 'mutated\n');
    const mutated = api.validateBoundaryOutputClosure(duplicateFixture.root, admitted.attempt, admitted.artifacts);
    expect(mutated.ok).toBe(false);
    expect(mutated.issues.map((entry) => entry.code)).toContain('output-content-drift');
  });

  it('[BCF00-N05] admits one declared pending file once and verifies its producer-bound hash', () => {
    const api = boundaryRun as unknown as {
      admitBoundaryOutput?: (input: {
        runDir: string;
        attempt: ReturnType<typeof validAttempt>;
        artifacts: Array<Record<string, unknown>>;
        path: string;
        role: string;
        producerAttemptId: string;
      }) => {
        result: ReturnType<typeof validateBoundaryRun>;
        attempt: ReturnType<typeof validAttempt>;
        artifacts: Array<Record<string, unknown>>;
      };
      validateBoundaryOutputClosure?: (
        runDir: string,
        attempt: ReturnType<typeof validAttempt>,
        artifacts: Array<Record<string, unknown>>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.admitBoundaryOutput).toBe('function');
    expect(typeof api.validateBoundaryOutputClosure).toBe('function');
    if (!api.admitBoundaryOutput || !api.validateBoundaryOutputClosure) return;

    const fixture = makeOutputRun();
    const admitted = api.admitBoundaryOutput({
      runDir: fixture.root,
      attempt: fixture.attempt,
      artifacts: [],
      path: 'outputs/root.txt',
      role: 'output',
      producerAttemptId: 'upstream-root',
    });
    expect(admitted.result).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(admitted.attempt.outputAdmissions).toEqual([
      { path: 'outputs/root.txt', state: 'admitted', role: 'output', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: 5 },
    ]);
    expect(admitted.attempt.verdict).toBe('Pass');
    expect(admitted.artifacts).toEqual([
      expect.objectContaining({ path: 'outputs/root.txt', producerAttemptId: 'upstream-root', role: 'output', bytes: 5 }),
    ]);
    expect(api.validateBoundaryOutputClosure(fixture.root, admitted.attempt, admitted.artifacts)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });


  it('[BCF00-U15] rejects timeout, signal, survivor, wrong wrapper, or masked direct status', async () => {
    const api = boundaryRun as unknown as {
      runBoundaryWatchdogForTest?: (
        argv: string[],
        options: { deadlineMs: number; killGraceMs: number; expectedExit: string },
      ) => Promise<{ result: ReturnType<typeof validateBoundaryRun>; groupDead: boolean }>;
      validateBoundaryOuterWatchdogRecord?: (
        kind: 'closeout' | 'verify-closeout',
        recorded: Record<string, unknown>,
        observed: Record<string, unknown>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    expect(typeof api.validateBoundaryOuterWatchdogRecord).toBe('function');
    if (!api.runBoundaryWatchdogForTest || !api.validateBoundaryOuterWatchdogRecord) return;

    const timeout = await api.runBoundaryWatchdogForTest([
      process.execPath,
      '-e',
      'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); setInterval(()=>{},1000)',
    ], { deadlineMs: 120, killGraceMs: 60, expectedExit: '0' });
    expect(timeout.result.ok).toBe(false);
    expect(timeout.result.issues.map((entry) => entry.code)).toContain('watchdog-timeout');
    expect(timeout.groupDead).toBe(true);

    const signaled = await api.runBoundaryWatchdogForTest([
      process.execPath,
      '-e',
      'process.kill(process.pid,"SIGTERM")',
    ], { deadlineMs: 250, killGraceMs: 100, expectedExit: '0' });
    expect(signaled.result.ok).toBe(false);
    expect(signaled.result.issues.map((entry) => entry.code)).toContain('watchdog-signal');

    const contract = {
      deadlineMs: 600_000,
      killGraceMs: 30_000,
      rawExit: 0,
      rawSignal: null,
      groupDead: true,
    };
    const wrongDeadline = api.validateBoundaryOuterWatchdogRecord('closeout', { ...contract, deadlineMs: 599_999 }, contract);
    expect(wrongDeadline.issues.map((entry) => entry.code)).toContain('watchdog-contract-mismatch');
    const masked = api.validateBoundaryOuterWatchdogRecord('closeout', contract, { ...contract, rawExit: 1 });
    expect(masked.issues.map((entry) => entry.code)).toContain('watchdog-status-masked');
    const survivor = api.validateBoundaryOuterWatchdogRecord('closeout', { ...contract, groupDead: false }, { ...contract, groupDead: false });
    expect(survivor.issues.map((entry) => entry.code)).toContain('watchdog-group-survivor');
  }, 10_000);

  it('[BCF00-N15] reaps one bounded process group and preserves its direct expected status', async () => {
    const api = boundaryRun as unknown as {
      runBoundaryWatchdogForTest?: (
        argv: string[],
        options: { deadlineMs: number; killGraceMs: number; expectedExit: string },
      ) => Promise<{ result: ReturnType<typeof validateBoundaryRun>; rawExit: number | null; rawSignal: string | null; groupDead: boolean }>;
    };
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const outcome = await api.runBoundaryWatchdogForTest([
      process.execPath,
      '-e',
      'process.exit(7)',
    ], { deadlineMs: 250, killGraceMs: 100, expectedExit: '7' });
    expect(outcome).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      rawExit: 7,
      rawSignal: null,
      groupDead: true,
    });
  }, 10_000);

}
