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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPromiseOrTimeout(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function processGroupAlive(pid: number): boolean {
  try {
    const table = execFileSync('ps', ['-axo', 'pid=,pgid='], {
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return table.split(/\r?\n/).some((line) => {
      const columns = line.trim().split(/\s+/);
      return columns.length >= 2 && Number(columns[1]) === pid;
    });
  } catch {
    return true;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForProcessGroupExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (processGroupAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(remaining, 10));
  }
  return true;
}

interface BoundaryWatchdogCoreOptions {
  deadlineMs: number;
  killGraceMs: number;
  expectedExit: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinFd?: number | 'ignore';
  stdoutFd?: number | 'ignore';
  stderrFd?: number | 'ignore';
}

export interface BoundaryWatchdogOutcome {
  result: BoundaryValidationResult;
  rawExit: number | null;
  rawSignal: string | null;
  timedOut: boolean;
  groupDead: boolean;
  startedAtUtc: string;
  endedAtUtc: string;
}

async function executeBoundaryWatchdog(
  argv: string[],
  options: BoundaryWatchdogCoreOptions,
): Promise<BoundaryWatchdogOutcome> {
  const startedAtUtc = new Date().toISOString();
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    cwd: options.cwd,
    env: options.env ?? cleanGitEnv(),
    stdio: [options.stdinFd ?? 'ignore', options.stdoutFd ?? 'ignore', options.stderrFd ?? 'ignore'],
  });
  const pid = child.pid;
  if (pid === undefined) {
    return {
      result: snapshotResult([issue('watchdog-spawn-failed', 'child process has no PID')]),
      rawExit: null,
      rawSignal: null,
      timedOut: false,
      groupDead: true,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
    };
  }
  let rawExit: number | null = null;
  let rawSignal: string | null = null;
  let spawnError: string | null = null;
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      rawExit = code;
      rawSignal = signal;
      resolve();
    });
    child.once('error', (error) => {
      spawnError = error.message;
      resolve();
    });
  });
  const completedBeforeDeadline = await waitForPromiseOrTimeout(closed, options.deadlineMs);
  const timedOut = !completedBeforeDeadline;
  if (timedOut) {
    signalProcessGroup(pid, 'SIGTERM');
    if (!await waitForProcessGroupExit(pid, options.killGraceMs)) {
      signalProcessGroup(pid, 'SIGKILL');
      await waitForProcessGroupExit(pid, 500);
    }
    await waitForPromiseOrTimeout(closed, 100);
  }
  const survivedNaturalExit = !timedOut && processGroupAlive(pid);
  if (survivedNaturalExit) {
    signalProcessGroup(pid, 'SIGTERM');
    if (!await waitForProcessGroupExit(pid, options.killGraceMs)) {
      signalProcessGroup(pid, 'SIGKILL');
      await waitForProcessGroupExit(pid, 500);
    }
  }
  const groupDead = !processGroupAlive(pid);
  const issues: BoundaryValidationIssue[] = [];
  if (spawnError !== null) issues.push(issue('watchdog-spawn-failed', spawnError));
  if (timedOut) issues.push(issue('watchdog-timeout', 'child exceeded the helper-owned monotonic deadline'));
  if (rawSignal !== null) issues.push(issue('watchdog-signal', `child terminated by ${rawSignal}`));
  const expected = parseBoundaryExpectedExit(options.expectedExit);
  const expectationMet = rawExit !== null && expected !== null
    ? expected === 'nonzero' ? rawExit !== 0 : expected.has(rawExit)
    : false;
  if (!timedOut && rawSignal === null && !expectationMet) {
    issues.push(issue('watchdog-exit-mismatch', 'direct child exit did not satisfy the expected status'));
  }
  if (survivedNaturalExit || !groupDead) {
    issues.push(issue('watchdog-group-survivor', 'child process group survived leader completion or teardown'));
  }
  return {
    result: snapshotResult(issues), rawExit, rawSignal, timedOut, groupDead,
    startedAtUtc, endedAtUtc: new Date().toISOString(),
  };
}

export async function runBoundaryWatchdogForTest(
  argv: string[],
  options: { deadlineMs: number; killGraceMs: number; expectedExit: string },
): Promise<BoundaryWatchdogOutcome> {
  if (
    argv.length === 0
    || options.deadlineMs <= 0
    || options.deadlineMs > 250
    || options.killGraceMs <= 0
    || options.killGraceMs > 100
  ) {
    const now = new Date().toISOString();
    return {
      result: snapshotResult([issue('watchdog-test-contract-invalid', 'test-only watchdog bounds are 1..250 ms plus 1..100 ms grace')]),
      rawExit: null,
      rawSignal: null,
      timedOut: false,
      groupDead: true,
      startedAtUtc: now,
      endedAtUtc: now,
    };
  }
  return executeBoundaryWatchdog(argv, options);
}

export async function runBoundaryAttemptProcess(
  argv: string[],
  options: {
    deadlineMs: number;
    killGraceMs: number;
    expectedExit: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdinPath: string | null;
    stdoutPath: string;
    stderrPath: string;
  },
): Promise<BoundaryWatchdogOutcome> {
  if (
    argv.length === 0
    || options.deadlineMs <= 0
    || options.deadlineMs > 1_860_000
    || options.killGraceMs !== 30_000
  ) {
    const now = new Date().toISOString();
    return {
      result: snapshotResult([issue('watchdog-contract-mismatch', 'production watchdog bounds differ from the closed attempt contract')]),
      rawExit: null,
      rawSignal: null,
      timedOut: false,
      groupDead: true,
      startedAtUtc: now,
      endedAtUtc: now,
    };
  }
  let stdinFd: number | null = null;
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  try {
    if (options.stdinPath !== null) stdinFd = openSync(options.stdinPath, 'r');
    stdoutFd = openSync(options.stdoutPath, 'wx', 0o600);
    stderrFd = openSync(options.stderrPath, 'wx', 0o600);
    const outcome = await executeBoundaryWatchdog(argv, {
      deadlineMs: options.deadlineMs,
      killGraceMs: options.killGraceMs,
      expectedExit: options.expectedExit,
      cwd: options.cwd,
      env: options.env,
      stdinFd: stdinFd ?? 'ignore',
      stdoutFd,
      stderrFd,
    });
    fsyncSync(stdoutFd);
    fsyncSync(stderrFd);
    return outcome;
  } finally {
    if (stdinFd !== null) closeSync(stdinFd);
    if (stdoutFd !== null) closeSync(stdoutFd);
    if (stderrFd !== null) closeSync(stderrFd);
  }
}

export function validateBoundaryOuterWatchdogRecord(
  kind: 'closeout' | 'verify-closeout',
  recorded: Record<string, unknown>,
  observed: Record<string, unknown>,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const expectedDeadline = kind === 'closeout' ? 600_000 : 300_000;
  if (recorded['deadlineMs'] !== expectedDeadline || recorded['killGraceMs'] !== 30_000) {
    issues.push(issue('watchdog-contract-mismatch', `${kind} must use its exact production deadline and grace`));
  }
  if (recorded['rawExit'] !== observed['rawExit'] || recorded['rawSignal'] !== observed['rawSignal']) {
    issues.push(issue('watchdog-status-masked', 'recorded outer status differs from the direct observed status'));
  }
  if (recorded['groupDead'] !== true || observed['groupDead'] !== true) {
    issues.push(issue('watchdog-group-survivor', 'outer process group was not fully reaped'));
  }
  if (recorded['rawSignal'] !== null) issues.push(issue('watchdog-signal', 'outer helper terminated by signal'));
  if (recorded['rawExit'] === 124 || recorded['rawExit'] === 137) {
    issues.push(issue('watchdog-timeout', 'outer helper reached GNU timeout status'));
  }
  return snapshotResult(issues);
}

