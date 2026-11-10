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
import {
  deliverThenThrow,
  FIXTURE_LEAK_NET_MS,
  groupKillError,
  readFixturePid,
  reapFixtureGroups,
  settleWithin,
  throwOnly,
  waitForPidGone,
  type GroupMembershipAnswer,
  type GroupSignalSeam,
} from '../../helpers/group-kill-seams.ts';

type WatchdogTeardownOutcome = {
  result: ReturnType<typeof validateBoundaryRun>;
  timedOut: boolean;
  groupDead: boolean;
};
type WatchdogSeamApi = {
  runBoundaryWatchdogForTest?: (
    argv: string[],
    options: {
      deadlineMs: number;
      killGraceMs: number;
      expectedExit: string;
      kill?: GroupSignalSeam;
      probeGroup?: (pgid: number) => GroupMembershipAnswer;
    },
  ) => Promise<WatchdogTeardownOutcome>;
};

const LONG_LIVED_CHILD = [process.execPath, '-e', 'setInterval(()=>{},1000)'];
const SEAM_BOUNDS = { deadlineMs: 120, killGraceMs: 60, expectedExit: '0' };
/** The widest test-only bounds, for real-process fixtures that need start-up time. */
const REAL_PROCESS_BOUNDS = { deadlineMs: 250, killGraceMs: 100, expectedExit: '0' };
const FIXTURE_LEAK_NET_S = FIXTURE_LEAK_NET_MS / 1_000;

/**
 * Teardown for a fixture member whose pid the fixture wrote: kills it unless it is already gone
 * (exited, or a zombie), then waits within waitForPidGone's own bound. It never waits on the run.
 */
async function endFixtureMember(pidFile: string): Promise<boolean> {
  const pid = readFixturePid(pidFile);
  if (pid === undefined) return true;
  if (!(await waitForPidGone(pid, 0))) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* it exited meanwhile */ }
  }
  return waitForPidGone(pid);
}

/** The teardown fields that do not depend on whether SIGTERM or SIGKILL ended the child. */
function teardownShape(outcome: WatchdogTeardownOutcome): Record<string, boolean> {
  const codes = outcome.result.issues.map((entry) => entry.code);
  return {
    ok: outcome.result.ok,
    timeout: codes.includes('watchdog-timeout'),
    survivor: codes.includes('watchdog-group-survivor'),
    timedOut: outcome.timedOut,
    groupDead: outcome.groupDead,
  };
}

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

  it('reads an EPERM group kill on a group with no live member as reaped, the same as ESRCH', async () => {
    const api = boundaryRun as unknown as WatchdogSeamApi;
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const epermTargets: number[] = [];
    const probed: number[] = [];
    const eperm = await api.runBoundaryWatchdogForTest([...LONG_LIVED_CHILD], {
      ...SEAM_BOUNDS,
      kill: deliverThenThrow('EPERM', epermTargets),
      probeGroup: (pgid) => { probed.push(pgid); return 'no-live-members'; },
    });
    const esrchProbed: number[] = [];
    const esrch = await api.runBoundaryWatchdogForTest([...LONG_LIVED_CHILD], {
      ...SEAM_BOUNDS,
      kill: deliverThenThrow('ESRCH', []),
      probeGroup: (pgid) => { esrchProbed.push(pgid); return 'live'; },
    });
    expect(probed.length).toBeGreaterThan(0);
    expect(probed.every((pgid) => pgid > 0 && epermTargets.includes(-pgid))).toBe(true);
    expect(esrchProbed).toEqual([]);
    expect(teardownShape(esrch)).toEqual({ ok: false, timeout: true, survivor: false, timedOut: true, groupDead: true });
    expect(teardownShape(eperm)).toEqual(teardownShape(esrch));
  }, 10_000);

  it('still raises an EPERM group kill while the group keeps a live member (default ps probe)', async () => {
    const api = boundaryRun as unknown as WatchdogSeamApi;
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const targets: number[] = [];
    // No signal reaches the group, so its member is still live when the real ps probe reads it.
    const run = api.runBoundaryWatchdogForTest([...LONG_LIVED_CHILD], {
      ...SEAM_BOUNDS,
      kill: (target) => { targets.push(target); throw groupKillError('EPERM'); },
    });
    try {
      await expect(run).rejects.toMatchObject({ code: 'EPERM' });
      // The rethrown error names the probe result, so a failed gate log tells live from unknown.
      await expect(run).rejects.toThrow(/; group membership probe: live$/);
    } finally {
      reapFixtureGroups(targets);
    }
  }, 10_000);

  it('fails closed when an EPERM group kill meets a group the membership probe cannot read', async () => {
    const api = boundaryRun as unknown as WatchdogSeamApi;
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const targets: number[] = [];
    const probed: number[] = [];
    const run = api.runBoundaryWatchdogForTest([...LONG_LIVED_CHILD], {
      ...SEAM_BOUNDS,
      kill: (target) => { targets.push(target); throw groupKillError('EPERM'); },
      probeGroup: (pgid) => { probed.push(pgid); return 'unknown'; },
    });
    try {
      await expect(run).rejects.toMatchObject({ code: 'EPERM' });
      expect(probed).toEqual(targets.map((target) => -target));
      await expect(run).rejects.toThrow(/; group membership probe: unknown$/);
    } finally {
      reapFixtureGroups(targets);
    }
  }, 10_000);

  it('names the probe result in the first line of the rethrown error stack, even when the stack was already formatted', async () => {
    const api = boundaryRun as unknown as WatchdogSeamApi;
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const targets: number[] = [];
    const stacksBeforeRethrow: string[] = [];
    const run = api.runBoundaryWatchdogForTest([...LONG_LIVED_CHILD], {
      ...SEAM_BOUNDS,
      kill: (target) => {
        targets.push(target);
        const error = groupKillError('EPERM');
        // Reading the stack formats it now, with the original message, as any earlier reader would.
        stacksBeforeRethrow.push(String(error.stack));
        throw error;
      },
      probeGroup: () => 'unknown',
    });
    try {
      const error = await run.then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(stacksBeforeRethrow).toHaveLength(1);
      expect(stacksBeforeRethrow[0]!.split('\n')[0]).toBe('Error: kill EPERM');
      // An uncaught rejection prints the stack, so its first line must carry the probe result too.
      const stackLines = String((error as Error).stack).split('\n');
      expect(stackLines[0]).toBe('Error: kill EPERM; group membership probe: unknown');
      expect(stackLines.slice(1)).toEqual(stacksBeforeRethrow[0]!.split('\n').slice(1)); // the frames are kept
    } finally {
      reapFixtureGroups(targets);
    }
  }, 10_000);

  it('raises a group-kill error other than EPERM without consulting the membership probe', async () => {
    const api = boundaryRun as unknown as WatchdogSeamApi;
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const targets: number[] = [];
    let probeCalls = 0;
    const run = api.runBoundaryWatchdogForTest([...LONG_LIVED_CHILD], {
      ...SEAM_BOUNDS,
      kill: (target) => { targets.push(target); throw groupKillError('EINVAL'); },
      probeGroup: () => { probeCalls += 1; return 'no-live-members'; },
    });
    try {
      await expect(run).rejects.toMatchObject({ code: 'EINVAL' });
      expect(probeCalls).toBe(0);
    } finally {
      reapFixtureGroups(targets);
    }
  }, 10_000);

  it('reads a group whose members are all zombies as gone after teardown, not as a survivor', async () => {
    const api = boundaryRun as unknown as WatchdogSeamApi;
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const targets: number[] = [];
    const probed: number[] = [];
    // Seam-modelled, as macOS answers for a zombie-only group: every kill(-pgid), the signal-0
    // liveness check included, returns EPERM, and the probe finds no live member. No signal is
    // delivered, so the leader pid stays present, as an unreaped zombie leader's would: a check of
    // the leader pid alone cannot tell the two apart.
    const run = api.runBoundaryWatchdogForTest([...LONG_LIVED_CHILD], {
      ...SEAM_BOUNDS,
      kill: throwOnly('EPERM', targets),
      probeGroup: (pgid) => { probed.push(pgid); return 'no-live-members'; },
    });
    try {
      const outcome = await settleWithin(run, 5_000, 'the watchdog did not settle within 5 s');
      expect(teardownShape(outcome)).toEqual({ ok: false, timeout: true, survivor: false, timedOut: true, groupDead: true });
      expect(probed.length).toBeGreaterThan(0);
      expect(probed.every((pgid) => pgid > 0 && targets.includes(-pgid))).toBe(true);
    } finally {
      // Nothing was delivered, so the leader is alive and its group id is still allocated.
      reapFixtureGroups(targets);
      await settleWithin(run, 2_000, 'the watchdog did not settle after teardown').catch(() => undefined);
    }
  }, 10_000);

  it('reports a live member the command left in its group as a survivor, and sweeps it (real ps probe)', async () => {
    const api = boundaryRun as unknown as WatchdogSeamApi;
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'boundary-watchdog-'));
    const pidFile = path.join(dir, 'member.pid');
    // The command exits 0 at once and leaves a background member in its own process group.
    const run = api.runBoundaryWatchdogForTest(
      ['/bin/sh', '-c', `sleep ${FIXTURE_LEAK_NET_S} & echo $! > "$1"`, 'sh', pidFile],
      REAL_PROCESS_BOUNDS,
    );
    try {
      const outcome = await settleWithin(run, 5_000, 'the watchdog did not settle within 5 s');
      // The natural-exit path. A timeout here means a loaded host, not this behaviour.
      expect(outcome.timedOut).toBe(false);
      expect(teardownShape(outcome)).toEqual({ ok: false, timeout: false, survivor: true, timedOut: false, groupDead: true });
      const memberPid = readFixturePid(pidFile);
      expect(memberPid).toBeDefined();
      // groupDead is true only because the sweep ended the member before the watchdog returned.
      expect(await waitForPidGone(memberPid!, 0)).toBe(true);
    } finally {
      const gone = await endFixtureMember(pidFile);
      await settleWithin(run, 2_000, 'the watchdog did not settle after teardown').catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      expect(gone).toBe(true);
    }
  }, 10_000);

  it('does not read a group as gone when the membership probe cannot read it after the watchdog kill', async () => {
    const api = boundaryRun as unknown as WatchdogSeamApi;
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const signals: Array<NodeJS.Signals | 0> = [];
    const probed: number[] = [];
    let delivered = false;
    // The watchdog's SIGTERM reaches the live group and ends it. From then on every kill(-pgid),
    // the signal-0 liveness check included, answers EPERM, and the probe cannot read the group.
    const run = api.runBoundaryWatchdogForTest([...LONG_LIVED_CHILD], {
      ...SEAM_BOUNDS,
      kill: (target, signal) => {
        signals.push(signal);
        if (!delivered && signal !== 0 && target < -1) {
          delivered = true;
          process.kill(target, signal);
          return;
        }
        throw groupKillError('EPERM');
      },
      probeGroup: (pgid) => { probed.push(pgid); return 'unknown'; },
    });
    // Unproven is not gone: the watchdog escalates to SIGKILL, and raises that kill's EPERM.
    await expect(settleWithin(run, 5_000, 'the watchdog did not settle within 5 s'))
      .rejects.toThrow(/^kill EPERM; group membership probe: unknown$/);
    expect(signals.filter((signal) => signal !== 0)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(probed.length).toBeGreaterThan(0);
  }, 10_000);

  it('sends SIGKILL to a member that ignores SIGTERM on the timeout path, and reports the group dead only once it is (real ps probe)', async () => {
    const api = boundaryRun as unknown as WatchdogSeamApi;
    expect(typeof api.runBoundaryWatchdogForTest).toBe('function');
    if (!api.runBoundaryWatchdogForTest) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'boundary-watchdog-'));
    const pidFile = path.join(dir, 'member.pid');
    const signals: Array<NodeJS.Signals | 0> = [];
    // The leader runs until the watchdog fires. Its background member ignores SIGTERM; an ignored
    // signal stays ignored across exec.
    const run = api.runBoundaryWatchdogForTest(
      ['/bin/sh', '-c', `(trap "" TERM; exec sleep ${FIXTURE_LEAK_NET_S}) & echo $! > "$1"; exec sleep ${FIXTURE_LEAK_NET_S}`, 'sh', pidFile],
      {
        ...REAL_PROCESS_BOUNDS,
        // Records each group signal and delivers it for real.
        kill: (target, signal) => { signals.push(signal); process.kill(target, signal); },
      },
    );
    try {
      const outcome = await settleWithin(run, 5_000, 'the watchdog did not settle within 5 s');
      expect(signals.filter((signal) => signal !== 0)).toEqual(['SIGTERM', 'SIGKILL']);
      expect(teardownShape(outcome)).toEqual({ ok: false, timeout: true, survivor: false, timedOut: true, groupDead: true });
      const memberPid = readFixturePid(pidFile);
      expect(memberPid).toBeDefined();
      // The group is reported dead, so the member must be gone (or a zombie) by then.
      expect(await waitForPidGone(memberPid!, 0)).toBe(true);
    } finally {
      const gone = await endFixtureMember(pidFile);
      await settleWithin(run, 2_000, 'the watchdog did not settle after teardown').catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      expect(gone).toBe(true);
    }
  }, 10_000);

}
