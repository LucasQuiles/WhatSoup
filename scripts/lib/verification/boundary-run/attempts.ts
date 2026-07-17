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

import { parseBoundaryJsonBytes } from './schema.ts';
import { capturePathRecord } from './worktree.ts';

export function parseBoundaryExpectedExit(value: string): Set<number> | 'nonzero' | null {
  if (value === 'nonzero') return 'nonzero';
  const tokens = value.split(',');
  if (tokens.some((token) => {
    if (token === '0') return false;
    if (token.length === 0 || token.length > 3) return true;
    const first = token.charCodeAt(0);
    if (first < 49 || first > 57) return true;
    return [...token].some((character) => {
      const code = character.charCodeAt(0);
      return code < 48 || code > 57;
    });
  })) return null;
  const statuses = tokens.map(Number);
  if (
    statuses.some((status) => status > 255)
    || new Set(statuses).size !== statuses.length
    || statuses.some((status, index) => index > 0 && status <= statuses[index - 1]!)
  ) return null;
  return new Set(statuses);
}

export function validateBoundaryAttemptStatus(
  recorded: BoundaryAttemptStatus,
  observed: Pick<BoundaryAttemptStatus, 'rawExit' | 'rawSignal'>,
  contract: BoundaryAttemptStatusContract,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const statusCount = Number(recorded.rawExit !== null) + Number(recorded.rawSignal !== null);
  const observedStatusCount = Number(observed.rawExit !== null) + Number(observed.rawSignal !== null);
  if (statusCount !== 1 || observedStatusCount !== 1) {
    issues.push(issue('attempt-status-missing', 'exactly one direct exit or signal status is required'));
  }
  if (recorded.rawExit !== observed.rawExit || recorded.rawSignal !== observed.rawSignal) {
    issues.push(issue('attempt-status-rewritten', 'recorded child status differs from the direct observed status'));
  }
  if (recorded.rawExit !== null && (!Number.isInteger(recorded.rawExit) || recorded.rawExit < 0 || recorded.rawExit > 255)) {
    issues.push(issue('attempt-exit-invalid', 'raw exit must be an integer in 0..255'));
  }
  if (recorded.rawSignal !== null && !/^SIG[A-Z0-9]+$/.test(recorded.rawSignal)) {
    issues.push(issue('attempt-signal-invalid', 'raw signal must be a POSIX signal name'));
  }
  const expected = parseBoundaryExpectedExit(recorded.expectedExit);
  if (expected === null) {
    issues.push(issue('attempt-expected-exit-invalid', 'expected exit declaration is not normalized'));
  }
  const expectationMet = recorded.rawExit !== null && expected !== null
    ? expected === 'nonzero' ? recorded.rawExit !== 0 : expected.has(recorded.rawExit)
    : false;
  if (recorded.rawSignal !== null && recorded.expectationMet) {
    issues.push(issue('attempt-signal-not-exit', 'a signal cannot satisfy a numeric or nonzero exit declaration'));
  }
  if (recorded.expectationMet !== expectationMet) {
    issues.push(issue('attempt-expectation-rewritten', 'expectationMet does not match the direct status predicate'));
  }
  if (recorded.expectedExit !== contract.expectedExit) {
    issues.push(issue('attempt-expected-exit-mismatch', 'expected exit differs from the frozen attempt contract'));
  }
  if (recorded.watchdogOwner !== contract.watchdogOwner) {
    issues.push(issue('attempt-watchdog-owner-mismatch', 'watchdog owner differs from the frozen attempt contract'));
  }
  if (recorded.innerTimeoutOwner !== contract.innerTimeoutOwner) {
    issues.push(issue('attempt-inner-timeout-owner-mismatch', 'inner timeout owner differs from the frozen attempt contract'));
  }
  if (recorded.deadlineMs !== contract.deadlineMs || recorded.killGraceMs !== contract.killGraceMs) {
    issues.push(issue('attempt-deadline-mismatch', 'deadline or kill grace differs from the frozen attempt contract'));
  }
  if (
    !Number.isSafeInteger(recorded.deadlineMs)
    || recorded.deadlineMs <= 0
    || !Number.isSafeInteger(recorded.killGraceMs)
    || recorded.killGraceMs <= 0
  ) {
    issues.push(issue('attempt-deadline-invalid', 'deadline and kill grace must be positive safe integers'));
  }
  return snapshotResult(issues);
}

const ARTIFACT_ROLES = new Set<BoundaryArtifactRole>([
  'input',
  'output',
  'receipt',
  'review',
  'lifecycle',
  'oracle',
  'scope',
  'measurement',
]);

export function admitBoundaryOutput(input: {
  runDir: string;
  attempt: BoundaryAttemptRecord;
  artifacts: BoundaryArtifactRecord[];
  path: string;
  role: string;
  producerAttemptId: string;
}): {
  result: BoundaryValidationResult;
  attempt: BoundaryAttemptRecord;
  artifacts: BoundaryArtifactRecord[];
} {
  const attempt = structuredClone(input.attempt);
  const artifacts = structuredClone(input.artifacts);
  const issues: BoundaryValidationIssue[] = [];
  const declarationCount = attempt.declaredOutputs.filter((entry) => entry === input.path).length;
  const admission = attempt.outputAdmissions.find((entry) => entry.path === input.path);
  if (!isSafePath(input.path) || declarationCount !== 1 || admission === undefined) {
    issues.push(issue('output-undeclared', 'artifact path was not uniquely declared by the attempt', input.path));
  } else if (admission.state === 'missing') {
    issues.push(issue('output-missing', 'a missing output cannot be admitted', input.path));
  } else if (admission.state === 'admitted') {
    issues.push(issue('output-duplicate-admission', 'an output can be admitted only once', input.path));
  }
  if (input.producerAttemptId !== attempt.id) {
    issues.push(issue('output-producer-mismatch', 'artifact producer does not own the declared output', input.path));
  }
  if (!ARTIFACT_ROLES.has(input.role as BoundaryArtifactRole)) {
    issues.push(issue('output-role-invalid', 'artifact role is outside the closed role set', input.path));
  }
  if (artifacts.some((artifact) => artifact.path === input.path)) {
    issues.push(issue('output-duplicate-admission', 'artifact path is already registered', input.path));
  }
  if (issues.length > 0 || admission === undefined) {
    return { result: snapshotResult(issues), attempt, artifacts };
  }

  try {
    const runDir = realpathSync(input.runDir);
    const record = capturePathRecord(runDir, input.path);
    admission.state = 'admitted';
    admission.role = input.role as BoundaryArtifactRole;
    admission.sha256 = record.sha256;
    admission.bytes = record.bytes;
    artifacts.push({
      path: input.path,
      role: input.role as BoundaryArtifactRole,
      producerAttemptId: input.producerAttemptId,
      sha256: record.sha256,
      bytes: record.bytes,
    });
    if (attempt.expectationMet && attempt.outputAdmissions.every((entry) => entry.state === 'admitted')) {
      attempt.verdict = 'Pass';
    }
    return { result: snapshotResult([]), attempt, artifacts };
  } catch (error) {
    issues.push(issue('output-file-invalid', `declared output is not a confined regular file: ${(error as Error).message}`, input.path));
    return { result: snapshotResult(issues), attempt, artifacts };
  }
}

export function validateBoundaryOutputClosure(
  runDirInput: string,
  attempt: BoundaryAttemptRecord,
  artifacts: BoundaryArtifactRecord[],
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  if (
    new Set(attempt.declaredOutputs).size !== attempt.declaredOutputs.length
    || new Set(attempt.outputAdmissions.map((entry) => entry.path)).size !== attempt.outputAdmissions.length
  ) {
    issues.push(issue('output-duplicate-admission', 'declared output or admission paths are duplicated'));
  }
  const declarationSet = new Set(attempt.declaredOutputs);
  const admissionSet = new Set(attempt.outputAdmissions.map((entry) => entry.path));
  if (
    declarationSet.size !== admissionSet.size
    || [...declarationSet].some((entry) => !admissionSet.has(entry))
  ) {
    issues.push(issue('output-undeclared', 'declared outputs and admission rows differ'));
  }
  if (new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length) {
    issues.push(issue('output-duplicate-admission', 'artifact paths are duplicated'));
  }

  let runDir: string;
  try {
    runDir = realpathSync(runDirInput);
  } catch (error) {
    return snapshotResult([issue('output-root-invalid', `output root cannot be resolved: ${(error as Error).message}`)]);
  }
  for (const admission of attempt.outputAdmissions) {
    if (admission.state === 'pending') {
      issues.push(issue('output-pending', 'pending output blocks closure', admission.path));
      continue;
    }
    if (admission.state === 'missing') {
      if (attempt.expectationMet) issues.push(issue('output-missing', 'expected-success output is missing', admission.path));
      continue;
    }
    const matches = artifacts.filter((artifact) => artifact.path === admission.path);
    const artifact = matches[0];
    if (
      matches.length !== 1
      || artifact === undefined
      || artifact.producerAttemptId !== attempt.id
      || artifact.role !== admission.role
      || artifact.sha256 !== admission.sha256
      || artifact.bytes !== admission.bytes
    ) {
      issues.push(issue('output-artifact-mismatch', 'admission does not match one producer-bound artifact', admission.path));
      continue;
    }
    try {
      const current = capturePathRecord(runDir, admission.path);
      if (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes) {
        issues.push(issue('output-content-drift', 'admitted output bytes changed', admission.path));
      }
    } catch (error) {
      issues.push(issue('output-content-drift', `admitted output is unavailable: ${(error as Error).message}`, admission.path));
    }
  }
  return snapshotResult(issues);
}

export interface BoundaryToolCapability {
  name: string;
  realPath: string;
  version: string;
  sha256: string;
}

export const BOUNDARY_VERSIONLESS_TOOLS = ['kill', 'test', 'tr', 'wc'] as const;

export function resolveBoundaryToolCapability(name: string): BoundaryToolCapability {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error(`unsupported tool name: ${name}`);
  const candidates = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  let executable: string | null = null;
  const executableNames = name === 'gnu-timeout' ? ['gtimeout', 'timeout'] : [name];
  for (const executableName of executableNames) {
    for (const directory of candidates) {
      const candidate = path.join(directory, executableName);
      try {
        accessSync(candidate, fsConstants.X_OK);
        executable = realpathSync(candidate);
        break;
      } catch {
        // Continue through the closed PATH search until one executable is found.
      }
    }
    if (executable !== null) break;
  }
  if (executable === null) throw new Error(`required tool is unavailable: ${name}`);
  const executableSha256 = sha256Bytes(readFileSync(executable));
  let version: string;
  try {
    version = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split(/\r?\n/, 1)[0]!.trim();
    if (version.length === 0) throw new Error(`tool version is empty: ${name}`);
  } catch (error) {
    if (!(BOUNDARY_VERSIONLESS_TOOLS as readonly string[]).includes(name)) throw error;
    version = `content-sha256:${executableSha256}`;
  }
  if (name === 'gnu-timeout' && !version.includes('GNU coreutils')) {
    throw new Error('resolved timeout executable is not GNU coreutils');
  }
  if (Buffer.byteLength(version, 'utf8') > 256) throw new Error(`tool version is over bound: ${name}`);
  return {
    name,
    realPath: executable,
    version,
    sha256: executableSha256,
  };
}

export function validateBoundaryProfileSelection(input: Record<string, unknown>): BoundaryValidationResult {
  const profileId = input['profileId'];
  const expected = typeof profileId === 'string'
    ? RUN_CONTRACT_PROFILES[profileId as keyof typeof RUN_CONTRACT_PROFILES]
    : undefined;
  if (expected === undefined || canonicalizeBoundaryRun(input) !== canonicalizeBoundaryRun(expected)) {
    return snapshotResult([issue('profile-contract-mismatch', 'task/profile and immutable required sets must equal one generated profile')]);
  }
  return snapshotResult([]);
}

export function validateBoundaryAttemptInvocation(
  id: string,
  input: Record<string, unknown>,
): BoundaryValidationResult {
  const contract = RUN_ATTEMPT_CONTRACTS[id as keyof typeof RUN_ATTEMPT_CONTRACTS];
  if (contract === undefined) {
    return snapshotResult([issue('attempt-contract-unknown', `attempt ID is not reserved: ${id}`)]);
  }
  const issues: BoundaryValidationIssue[] = [];
  for (const key of [
    'operation',
    'argv',
    'expectedExit',
    'watchdogOwner',
    'innerTimeoutOwner',
    'deadlineMs',
    'killGraceMs',
    'outputPaths',
    'headAnchor',
  ] as const) {
    if (canonicalizeBoundaryRun(input[key]) !== canonicalizeBoundaryRun(contract[key])) {
      issues.push(issue('attempt-contract-mismatch', `${id}.${key} differs from the generated attempt contract`, key));
    }
  }
  const environment = input['environment'];
  if (!isRecord(environment) || !hasExactKeys(environment, contract.environmentKeys)) {
    issues.push(issue('attempt-environment-mismatch', 'child environment keys differ from the closed allowlist', 'environment'));
  } else if (Object.values(environment).some((value) => typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4_096)) {
    issues.push(issue('attempt-environment-mismatch', 'child environment values must be bounded strings', 'environment'));
  }
  let capability: BoundaryToolCapability | null = null;
  if (contract.toolName === null) {
    if (input['capability'] !== null) {
      issues.push(issue('attempt-tool-capability-mismatch', 'internal checks must not accept a caller tool capability', 'capability'));
    }
  } else {
    try {
      capability = resolveBoundaryToolCapability(contract.toolName);
    } catch (error) {
      issues.push(issue('attempt-tool-unavailable', (error as Error).message, 'capability'));
    }
  }
  if (capability !== null && canonicalizeBoundaryRun(input['capability']) !== canonicalizeBoundaryRun(capability)) {
    issues.push(issue('attempt-tool-capability-mismatch', 'tool capability does not match the helper preflight', 'capability'));
  }
  return snapshotResult(issues);
}

export interface BoundaryStructuredTestRow {
  marker: string;
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  failureReason: string | null;
}

export interface BoundaryStructuredTestResult {
  testFile: string;
  registeredMarkerIds: string[];
  tests: BoundaryStructuredTestRow[];
  collectionErrors: string[];
  unhandledErrors: string[];
}

export function validateBoundaryStructuredTestResult(
  mode: 'red' | 'green',
  result: BoundaryStructuredTestResult,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const contract = RUN_TEST_CONTRACTS.bcf00;
  const markerIds = [...contract.markerIds];
  const selectedIds = mode === 'green'
    ? markerIds
    : markerIds.filter((id) => id.includes('-B') || id.includes('-U'));
  if (result.testFile !== contract.testFile) {
    issues.push(issue('test-file-mismatch', 'structured result names the wrong test file', 'testFile'));
  }
  if (canonicalizeBoundaryRun(result.registeredMarkerIds) !== canonicalizeBoundaryRun(markerIds)) {
    issues.push(issue('test-registration-mismatch', 'registered marker roster differs from the generated contract'));
  }
  if (result.tests.length === 0) issues.push(issue('test-zero-collected', 'structured result collected zero tests'));
  const collectedIds = result.tests.map((row) => row.marker);
  if (
    new Set(collectedIds).size !== collectedIds.length
    || canonicalizeBoundaryRun([...collectedIds].sort()) !== canonicalizeBoundaryRun([...selectedIds].sort())
  ) {
    issues.push(issue('test-marker-roster-mismatch', 'collected marker roster differs from the selected contract'));
  }
  if (result.collectionErrors.length > 0) {
    issues.push(issue('test-collection-error', 'structured result contains collection or import errors'));
  }
  if (result.unhandledErrors.length > 0) {
    issues.push(issue('test-unhandled-error', 'structured result contains unhandled errors'));
  }
  for (const row of result.tests) {
    if (row.status === 'skipped' || row.status === 'todo') {
      issues.push(issue('test-nonterminal-status', `registered test is ${row.status}: ${row.marker}`, row.marker));
      continue;
    }
    if (mode === 'green') {
      if (row.status !== 'passed' || row.failureReason !== null) {
        issues.push(issue('test-green-predicate-mismatch', `GREEN marker did not pass cleanly: ${row.marker}`, row.marker));
      }
      continue;
    }
    if (row.marker.includes('-B')) {
      if (row.status !== 'passed' || row.failureReason !== null) {
        issues.push(issue('test-red-safe-control-failed', `RED safe control did not pass: ${row.marker}`, row.marker));
      }
    } else if (row.status !== 'failed' || row.failureReason !== `unsafe:${row.marker}`) {
      issues.push(issue('test-red-sentinel-mismatch', `RED unsafe marker failed for the wrong reason: ${row.marker}`, row.marker));
    }
  }
  return snapshotResult(issues);
}

const VITEST_JSON_REPORT_KEYS = [
  'numFailedTestSuites', 'numFailedTests', 'numPassedTestSuites', 'numPassedTests',
  'numPendingTestSuites', 'numPendingTests', 'numTodoTests', 'numTotalTestSuites',
  'numTotalTests', 'snapshot', 'startTime', 'success', 'testResults',
] as const;

export function validateBoundaryVitestJsonReport(input: Record<string, unknown>): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const predicate = input['predicate'];
  if (typeof predicate !== 'string') {
    return snapshotResult([issue('test-result-predicate-unsupported', 'structured result predicate is not implemented')]);
  }
  if (predicate in RUN_EVAL_CONTRACTS) return validateBoundaryEvaluatorJsonReport(input);
  const predicateContract = RUN_VITEST_PREDICATES[predicate];
  if (predicateContract === undefined) {
    return snapshotResult([issue('test-result-predicate-unsupported', 'structured result predicate is not implemented')]);
  }
  const report = input['report'];
  if (!requireExactRecord(report, VITEST_JSON_REPORT_KEYS, issues, 'test-report-shape', 'report')) {
    return snapshotResult(issues);
  }
  const countKeys = [
    'numFailedTestSuites', 'numFailedTests', 'numPassedTestSuites', 'numPassedTests',
    'numPendingTestSuites', 'numPendingTests', 'numTodoTests', 'numTotalTestSuites',
    'numTotalTests', 'startTime',
  ] as const;
  if (countKeys.some((key) => !Number.isSafeInteger(report[key]) || Number(report[key]) < 0)) {
    issues.push(issue('test-report-count-invalid', 'Vitest report counts must be nonnegative safe integers'));
  }
  if (
    report['numPendingTestSuites'] !== 0
    || report['numTodoTests'] !== 0
    || (predicateContract.mode === 'green' && report['numPendingTests'] !== 0)
  ) {
    issues.push(issue('test-report-nonpass', 'Vitest report contains a skip, todo, or pending result'));
  }
  if (predicateContract.mode === 'green') {
    if (report['success'] !== true || report['numFailedTestSuites'] !== 0 || report['numFailedTests'] !== 0) {
      issues.push(issue('test-report-nonpass', 'GREEN Vitest report contains a failure'));
    }
  } else if (report['success'] !== false || report['numFailedTests'] === 0) {
    issues.push(issue('test-red-status-mismatch', 'RED Vitest report must fail through its declared unsafe assertions'));
  }
  const cwd = input['cwd'];
  const entryTestRoster = input['entryTestRoster'];
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !isRecord(entryTestRoster) || !Array.isArray(entryTestRoster['files'])) {
    issues.push(issue('test-entry-roster-invalid', 'entry roster or repository root is malformed'));
    return snapshotResult(issues);
  }
  const entryFiles = new Map<string, Record<string, unknown>>();
  for (const row of entryTestRoster['files']) {
    if (isRecord(row) && typeof row['path'] === 'string') entryFiles.set(row['path'], row);
  }
  for (const expectedFile of predicateContract.testFiles) {
    const entryFile = entryFiles.get(expectedFile);
    if (!isRecord(entryFile) || !['present', 'absent'].includes(String(entryFile['state'])) || !Array.isArray(entryFile['testNames'])) {
      issues.push(issue('test-entry-roster-invalid', `entry roster does not contain the required test file: ${expectedFile}`));
    }
  }
  if (issues.some((entry) => entry.code === 'test-entry-roster-invalid')) return snapshotResult(issues);
  const testResults = report['testResults'];
  if (!Array.isArray(testResults) || testResults.length !== predicateContract.testFiles.length || testResults.some((row) => !isRecord(row))) {
    issues.push(issue('test-file-mismatch', 'Vitest report must contain every and only required test file'));
    return snapshotResult(issues);
  }
  const requiredContracts = predicateContract.testContractIds.map((id) => RUN_TEST_CONTRACTS[id]);
  const registeredMarkers = requiredContracts.flatMap((contract) => [...contract.markerIds]);
  const selectedMarkers = predicateContract.mode === 'red'
    ? requiredContracts.flatMap((contract) => [...contract.unsafeMarkerIds, ...contract.safeMarkerIds])
    : registeredMarkers;
  const unsafeMarkers = new Set(requiredContracts.flatMap((contract) => [...contract.unsafeMarkerIds]));
  const safeMarkers = new Set(requiredContracts.flatMap((contract) => [...contract.safeMarkerIds]));
  const observedMarkers: string[] = [];
  let assertionCount = 0;
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let todoCount = 0;
  const observedFiles: string[] = [];
  for (const row of testResults) {
    const testFile = row as Record<string, unknown>;
    const observedName = testFile['name'];
    const observedPath = typeof observedName === 'string' && path.isAbsolute(observedName)
      ? path.relative(cwd, observedName)
      : observedName;
    if (typeof observedPath !== 'string') {
      issues.push(issue('test-file-mismatch', 'Vitest result has no canonical file path'));
      continue;
    }
    observedFiles.push(observedPath);
    const assertions = testFile['assertionResults'];
    if (!Array.isArray(assertions) || assertions.length === 0) {
      issues.push(issue('test-zero-collected', `Vitest report collected zero assertions for ${observedPath}`));
      continue;
    }
    const titles: string[] = [];
    for (const assertion of assertions) {
      if (
        !isRecord(assertion)
        || typeof assertion['title'] !== 'string'
        || typeof assertion['fullName'] !== 'string'
        || !Array.isArray(assertion['failureMessages'])
      ) {
        issues.push(issue('test-report-shape', 'Vitest assertion row is malformed'));
        continue;
      }
      assertionCount += 1;
      const fullName = assertion['fullName'];
      titles.push(fullName);
      const status = assertion['status'];
      if (!['passed', 'failed', 'skipped', 'todo'].includes(String(status))) {
        issues.push(issue('test-report-shape', 'Vitest assertion status is malformed'));
        continue;
      }
      if (status === 'passed') passedCount += 1;
      if (status === 'failed') failedCount += 1;
      if (status === 'skipped') skippedCount += 1;
      if (status === 'todo') todoCount += 1;
      const markerMatches = fullName.match(/\[BCF\d{2}-(?:B|U|S|N)\d{2}\]/g) ?? [];
      if (markerMatches.length > 1) {
        issues.push(issue('test-marker-roster-mismatch', 'one assertion contains multiple registered markers'));
        continue;
      }
      const observedMarker = markerMatches[0] ?? null;
      const failures = assertion['failureMessages'] as unknown[];
      if (predicateContract.mode === 'green') {
        if (observedMarker !== null) observedMarkers.push(observedMarker);
        if (status !== 'passed' || failures.length !== 0) {
          issues.push(issue('test-report-nonpass', `GREEN assertion is not a clean pass: ${assertion['title']}`));
        }
        continue;
      }
      if (observedMarker !== null && !registeredMarkers.includes(observedMarker)) {
        issues.push(issue('test-marker-roster-mismatch', 'RED report contains an unknown contract marker'));
        continue;
      }
      if (observedMarker === null || !selectedMarkers.includes(observedMarker)) {
        if (status !== 'skipped') {
          issues.push(issue('test-marker-roster-mismatch', 'RED selected an unregistered or unmarked assertion'));
        }
        continue;
      }
      observedMarkers.push(observedMarker);
      if (safeMarkers.has(observedMarker)) {
        if (status !== 'passed' || failures.length !== 0) {
          issues.push(issue('test-red-safe-control-failed', `RED safe control did not pass: ${observedMarker}`));
        }
      } else if (unsafeMarkers.has(observedMarker)) {
        const sentinel = `BCF_EXPECTATION_UNMET:${observedMarker.slice(1, 6)}-${observedMarker.slice(-3, -1)}`;
        const stripped = failures.map((value) => stripBoundaryAnsi(String(value))).join('\n');
        const sentinels = stripped.match(/BCF_EXPECTATION_UNMET:BCF\d{2}-\d{2}/g) ?? [];
        if (status !== 'failed' || sentinels.length !== 1 || sentinels[0] !== sentinel) {
          issues.push(issue('test-red-sentinel-mismatch', `RED unsafe marker failed for the wrong reason: ${observedMarker}`));
        }
      }
    }
    if (predicateContract.mode === 'green') {
      const entryFile = entryFiles.get(observedPath)!;
      const retained = new Set((entryFile['testNames'] as unknown[]).map(String));
      for (const title of retained) {
        if (!titles.includes(title)) issues.push(issue('test-entry-roster-mismatch', `entry test was removed or renamed: ${observedPath} :: ${title}`));
      }
      for (const title of titles) {
        const markerMatches = title.match(/\[BCF\d{2}-(?:B|U|S|N)\d{2}\]/g) ?? [];
        if (!retained.has(title) && (markerMatches.length !== 1 || !registeredMarkers.includes(markerMatches[0]!))) {
          issues.push(issue('test-entry-roster-mismatch', `unregistered test was added to the selected roster: ${observedPath} :: ${title}`));
        }
      }
    }
  }
  const sortBytes = (values: readonly string[]) => [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (canonicalizeBoundaryRun(sortBytes(observedFiles)) !== canonicalizeBoundaryRun(sortBytes(predicateContract.testFiles))) {
    issues.push(issue('test-file-mismatch', 'Vitest result file set differs from the predicate contract'));
  }
  if (canonicalizeBoundaryRun(sortBytes(observedMarkers)) !== canonicalizeBoundaryRun(sortBytes(selectedMarkers))) {
    issues.push(issue('test-marker-roster-mismatch', 'collected marker roster differs from the predicate contract'));
  }
  if (
    report['numTotalTests'] !== assertionCount
    || report['numPassedTests'] !== passedCount
    || report['numFailedTests'] !== failedCount
    || report['numPendingTests'] !== skippedCount
    || report['numTodoTests'] !== todoCount
    || passedCount + failedCount + skippedCount + todoCount !== assertionCount
  ) issues.push(issue('test-report-count-invalid', 'Vitest report totals differ from its assertion rows'));
  return snapshotResult(issues);
}

function stripBoundaryAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

const EVALUATOR_BASE_KEYS = [
  'engine', 'corpusLockedAt', 'primaryMetric', 'correct', 'total', 'accuracy', 'falseBlocks',
  'missedCritical', 'targetMet', 'byCohort', 'byEvidence', 'mismatches',
] as const;
const EVALUATOR_CANDIDATE_KEYS = [
  ...EVALUATOR_BASE_KEYS, 'feedbackCompleteness', 'receipts', 'detectorVerification',
] as const;

function validateBoundaryEvaluatorJsonReport(input: Record<string, unknown>): BoundaryValidationResult {
  const predicate = input['predicate'];
  const contract = typeof predicate === 'string'
    ? RUN_EVAL_CONTRACTS[predicate as keyof typeof RUN_EVAL_CONTRACTS]
    : undefined;
  if (contract === undefined) {
    return snapshotResult([issue('evaluator-predicate-unsupported', 'evaluator predicate is not implemented')]);
  }
  const issues: BoundaryValidationIssue[] = [];
  const report = input['report'];
  const cwd = input['cwd'];
  const expectedKeys = contract.engine === 'candidate' ? EVALUATOR_CANDIDATE_KEYS : EVALUATOR_BASE_KEYS;
  if (
    typeof cwd !== 'string'
    || !path.isAbsolute(cwd)
    || !requireExactRecord(report, expectedKeys, issues, 'evaluator-result-shape', 'report')
  ) return snapshotResult(issues.length > 0 ? issues : [issue('evaluator-input-invalid', 'evaluator cwd is invalid')]);
  let corpus: Record<string, unknown>;
  try {
    const parsed = parseBoundaryJsonBytes(readFileSync(path.join(cwd, contract.corpusPath)));
    if (!parsed.result.ok || parsed.value === null || !isRecord(parsed.value)) throw new Error('corpus is not canonical JSON');
    corpus = parsed.value;
  } catch (error) {
    return snapshotResult([issue('evaluator-corpus-invalid', (error as Error).message)]);
  }
  const cases = corpus['cases'];
  if (!Array.isArray(cases) || cases.length !== contract.total || cases.some((row) => !isRecord(row))) {
    return snapshotResult([issue('evaluator-corpus-invalid', 'corpus case roster is malformed')]);
  }
  const caseRows = cases as Array<Record<string, unknown>>;
  const caseIds = caseRows.map((row) => row['id']);
  if (
    caseIds.some((id) => typeof id !== 'string')
    || new Set(caseIds).size !== caseIds.length
    || caseRows.some((row) => !['pass', 'warn', 'block', 'inconclusive'].includes(String(row['expected'])))
  ) return snapshotResult([issue('evaluator-corpus-invalid', 'corpus IDs or expected labels are invalid')]);
  const predictions = new Map<string, string>();
  if (contract.engine === 'baseline') {
    for (const row of caseRows) predictions.set(String(row['id']), String(row['currentDecision']));
  } else {
    const receipts = report['receipts'];
    if (!Array.isArray(receipts) || receipts.length !== caseRows.length || receipts.some((row) => !isRecord(row))) {
      issues.push(issue('evaluator-case-roster-mismatch', 'candidate receipts do not cover every corpus case'));
    } else {
      for (const receipt of receipts as Array<Record<string, unknown>>) {
        const caseId = receipt['caseId'];
        const decision = receipt['decision'];
        if (
          typeof caseId !== 'string'
          || !['pass', 'warn', 'block', 'inconclusive'].includes(String(decision))
          || predictions.has(caseId)
        ) {
          issues.push(issue('evaluator-case-roster-mismatch', 'candidate receipt identity or decision is invalid'));
          continue;
        }
        predictions.set(caseId, String(decision));
      }
      if (canonicalizeBoundaryRun([...predictions.keys()].sort()) !== canonicalizeBoundaryRun(caseIds.map(String).sort())) {
        issues.push(issue('evaluator-case-roster-mismatch', 'candidate receipt case IDs differ from the corpus'));
      }
    }
    if (report['feedbackCompleteness'] !== 1) {
      issues.push(issue('evaluator-feedback-incomplete', 'candidate feedback completeness must equal one'));
    }
    const detector = report['detectorVerification'];
    if (
      !isRecord(detector)
      || !hasExactKeys(detector, ['requested', 'revisions', 'modulesChecked'])
      || detector['requested'] !== true
      || !Number.isSafeInteger(detector['revisions'])
      || Number(detector['revisions']) < 0
      || !Number.isSafeInteger(detector['modulesChecked'])
      || Number(detector['modulesChecked']) < 0
    ) issues.push(issue('evaluator-detector-verification-invalid', 'candidate detector verification is malformed'));
  }
  if (predictions.size !== caseRows.length) return snapshotResult(issues);
  const mismatchRows = caseRows.filter((row) => predictions.get(String(row['id'])) !== row['expected']).map((row) => ({
    id: row['id'], expected: row['expected'], predicted: predictions.get(String(row['id'])), sourceRefs: row['sourceRefs'],
  }));
  const correct = caseRows.length - mismatchRows.length;
  const falseBlocks = caseRows.filter((row) => predictions.get(String(row['id'])) === 'block' && row['expected'] === 'pass').length;
  const missedCritical = caseRows.filter((row) => row['expected'] === 'block' && predictions.get(String(row['id'])) !== 'block').length;
  const accuracy = correct / caseRows.length;
  const target = isRecord(corpus['target']) ? corpus['target'] : {};
  const targetMet = accuracy >= Number(target['minimumAccuracy']) && falseBlocks <= Number(target['maximumFalseBlocks']);
  const group = (field: 'cohort' | 'evidence') => {
    const grouped: Record<string, { correct: number; total: number; accuracy: number }> = {};
    for (const row of caseRows) {
      const key = String(row[field]);
      const value = (grouped[key] ??= { correct: 0, total: 0, accuracy: 0 });
      value.total += 1;
      if (predictions.get(String(row['id'])) === row['expected']) value.correct += 1;
    }
    for (const value of Object.values(grouped)) value.accuracy = value.correct / value.total;
    return grouped;
  };
  const expectedFields: Record<string, unknown> = {
    engine: contract.engine,
    corpusLockedAt: corpus['lockedAt'],
    primaryMetric: corpus['primaryMetric'],
    correct,
    total: caseRows.length,
    accuracy,
    falseBlocks,
    missedCritical,
    targetMet,
    byCohort: group('cohort'),
    byEvidence: group('evidence'),
    mismatches: mismatchRows,
  };
  for (const [key, expected] of Object.entries(expectedFields)) {
    if (canonicalizeBoundaryRun(report[key]) !== canonicalizeBoundaryRun(expected)) {
      issues.push(issue('evaluator-result-mismatch', `evaluator field differs from independently derived corpus evidence: ${key}`, key));
    }
  }
  if (
    correct !== contract.correct
    || falseBlocks !== contract.falseBlocks
    || missedCritical !== contract.missedCritical
  ) issues.push(issue('evaluator-score-mismatch', 'evaluator score differs from the frozen contract'));
  if (
    contract.mismatchIds !== null
    && canonicalizeBoundaryRun(mismatchRows.map((row) => row.id)) !== canonicalizeBoundaryRun([...contract.mismatchIds])
  ) issues.push(issue('evaluator-mismatch-identity', 'evaluator mismatch identity differs from the frozen contract'));
  return snapshotResult(issues);
}

export function validateBoundaryStdoutPredicate(
  predicate: string | null,
  stdout: string,
  allowedPaths: readonly string[],
): BoundaryValidationResult {
  if (predicate === null) return snapshotResult([]);
  const trimmed = stdout.trim();
  let valid = false;
  switch (predicate) {
    case 'oid':
      valid = /^[0-9a-f]{40}$/.test(trimmed);
      break;
    case 'merge-preview':
      valid = parseBoundaryMergePreviewStdout(stdout) !== null;
      break;
    case 'ssh-origin':
      valid = /^git@[^:\s]+:[^\s]+$/.test(trimmed);
      break;
    case 'ahead-behind':
      valid = /^\d+\s+\d+$/.test(trimmed) && trimmed.split(/\s+/).length === 2;
      break;
    case 'decimal-equals-29':
      valid = trimmed === '29';
      break;
    case 'exact-profile-allowlist': {
      const observed = trimmed === '' ? [] : stdout.replace(/\n$/, '').split('\n');
      valid = canonicalizeBoundaryRun(observed) === canonicalizeBoundaryRun(allowedPaths);
      break;
    }
    default:
      return snapshotResult([issue('attempt-stdout-predicate-unknown', `unknown stdout predicate: ${predicate}`)]);
  }
  return valid
    ? snapshotResult([])
    : snapshotResult([issue('attempt-stdout-predicate-mismatch', `stdout failed predicate: ${predicate}`)]);
}

export function parseBoundaryMergePreviewStdout(stdout: string): {
  treeOid: string;
  conflictPaths: string[];
} | null {
  const trimmed = stdout.trim();
  if (/^[0-9a-f]{40}$/.test(trimmed)) return { treeOid: trimmed, conflictPaths: [] };
  const lines = stdout.replace(/\n$/, '').split('\n');
  if (!/^[0-9a-f]{40}$/.test(lines[0] ?? '')) return null;
  const stages = new Map<string, Set<number>>();
  const conflictPaths = new Set<string>();
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const stage = /^([0-7]{6}) ([0-9a-f]{40}) ([123])\t(.+)$/.exec(line);
    if (stage !== null) {
      const relativePath = stage[4]!;
      if (!isSafePath(relativePath)) return null;
      const values = stages.get(relativePath) ?? new Set<number>();
      const stageNumber = Number(stage[3]);
      if (values.has(stageNumber)) return null;
      values.add(stageNumber);
      stages.set(relativePath, values);
      continue;
    }
    const autoMerge = /^Auto-merging (.+)$/.exec(line);
    if (autoMerge !== null) {
      if (!isSafePath(autoMerge[1]!)) return null;
      continue;
    }
    const conflict = /^CONFLICT \(content\): Merge conflict in (.+)$/.exec(line);
    if (conflict !== null) {
      if (!isSafePath(conflict[1]!)) return null;
      conflictPaths.add(conflict[1]!);
      continue;
    }
    return null;
  }
  if (stages.size === 0 || conflictPaths.size === 0) return null;
  for (const values of stages.values()) {
    if (values.size !== 3 || !values.has(1) || !values.has(2) || !values.has(3)) return null;
  }
  const orderedStages = [...stages.keys()].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const orderedConflicts = [...conflictPaths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  return canonicalizeBoundaryRun(orderedStages) === canonicalizeBoundaryRun(orderedConflicts)
    ? { treeOid: lines[0]!, conflictPaths: orderedConflicts }
    : null;
}
