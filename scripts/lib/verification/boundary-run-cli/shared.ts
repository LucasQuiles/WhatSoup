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
  type BoundaryWorktreeSnapshot,
} from '../boundary-run-manifest.ts';
import { cleanGitEnv } from '../../../../src/lib/git-env.ts';

import { isSafeRelativePath } from './invocation.ts';

export function operationResult(
  issues: BoundaryValidationIssue[],
  exitCode: 0 | 1 | 2 = issues.length === 0 ? 0 : 1,
  verdict: BoundaryValidationResult['verdict'] = issues.length === 0 ? 'Pass' : 'Inconclusive',
): BoundaryValidationResult {
  return { ok: issues.length === 0, exitCode, verdict, issues };
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function documentHash(cwd: string, relativePath: string): BoundaryDocumentHashRecord {
  const bytes = readFileSync(path.join(cwd, relativePath));
  return { path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength };
}

export function canonicalSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export function discoverEntryTestRoster(
  cwd: string,
  profileId: string,
  observedTools: BoundaryRunManifest['run']['observedTools'],
): BoundaryRunManifest['entryTestRoster'] {
  const testPaths = boundaryTestFilesForProfile(profileId);
  const files = testPaths.map((testPath) => {
    const absolute = path.join(cwd, testPath);
    return { path: testPath, state: existsSync(absolute) ? 'present' as const : 'absent' as const, testNames: [] as string[] };
  });
  const present = files.filter((entry) => entry.state === 'present');
  if (present.length > 0) {
    const bash = observedTools.find((entry) => entry.name === 'bash');
    const timeout = observedTools.find((entry) => entry.name === 'gnu-timeout');
    if (bash === undefined || timeout === undefined) throw new Error('test roster collection lacks frozen bash/gnu-timeout capabilities');
    const stdout = execFileSync(timeout.realPath, [
      '--kill-after=30s', '15m', bash.realPath, 'scripts/run-with-pinned-npm.sh',
      'exec', '--', 'vitest', 'list', ...present.map((entry) => entry.path), '--json',
      '--pool=forks', '--fileParallelism=false',
    ], {
      cwd,
      encoding: 'utf8',
      env: reconstructedChildEnvironment(cwd),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => !isPlainRecord(entry)
      || typeof entry['name'] !== 'string' || typeof entry['file'] !== 'string')) {
      throw new Error('Vitest list returned a malformed roster');
    }
    for (const row of parsed as Array<Record<string, unknown>>) {
      const relativeFile = path.relative(cwd, String(row['file']));
      const target = files.find((entry) => entry.path === relativeFile);
      if (target === undefined || target.state !== 'present') throw new Error(`Vitest listed a foreign test file: ${relativeFile}`);
      target.testNames.push(String(row['name']).replace(/ > /g, ' '));
    }
    for (const entry of present) {
      entry.testNames = canonicalSet(entry.testNames);
      if (entry.testNames.length === 0) throw new Error(`Vitest listed zero tests for ${entry.path}`);
    }
  }
  return { files, digestSha256: sha256(canonicalizeBoundaryRun(files)) };
}

export function durableExclusiveWrite(filePath: string, bytes: Uint8Array | string): void {
  const descriptor = openSync(filePath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(path.dirname(filePath), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function durableAtomicRewrite(filePath: string, bytes: string): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  durableExclusiveWrite(temporary, bytes);
  renameSync(temporary, filePath);
  const parent = openSync(path.dirname(filePath), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function verifyRunInitAnchor(manifest: BoundaryRunManifest, runDir: string): BoundaryValidationResult {
  try {
    const anchorPath = path.join(runDir, 'run_init.json');
    const lockPath = path.join(runDir, 'run_init.sha256');
    const anchorBytes = readFileSync(anchorPath);
    const parsed = parseBoundaryJsonBytes(anchorBytes);
    if (!parsed.result.ok || parsed.text === null) {
      return operationResult([
        { code: 'init-anchor-mismatch', message: 'init anchor is not strict canonical JSON' },
        ...parsed.result.issues,
      ]);
    }
    const expectedBytes = canonicalizeBoundaryRun(createBoundaryRunInitAnchor(manifest));
    const expectedLock = shaLockBytes(sha256(anchorBytes), 'run_init.json');
    if (
      parsed.text !== canonicalizeBoundaryRun(parsed.value)
      || anchorBytes.toString('utf8') !== expectedBytes
      || readFileSync(lockPath, 'utf8') !== expectedLock
    ) {
      return operationResult([{ code: 'init-anchor-mismatch', message: 'manifest init projection differs from its immutable anchor' }]);
    }
    return operationResult([]);
  } catch (error) {
    return operationResult([{ code: 'init-anchor-mismatch', message: (error as Error).message }]);
  }
}

export class BoundaryRunLoadError extends Error {
  readonly issues: BoundaryValidationIssue[];

  constructor(issues: BoundaryValidationIssue[]) {
    super(issues.map((entry) => entry.code).join(', '));
    this.issues = issues;
  }
}

export function runLoadFailure(error: unknown): BoundaryValidationResult {
  return error instanceof BoundaryRunLoadError
    ? operationResult(error.issues)
    : operationResult([{ code: 'run-load-failed', message: (error as Error).message }]);
}


export function loadActiveManifest(runDir: string): { manifest: BoundaryRunManifest; path: string } {
  const manifestPath = path.join(runDir, 'run_manifest.json');
  const bytes = readFileSync(manifestPath);
  const validation = validateBoundaryRunJson(bytes);
  if (!validation.ok) throw new Error(validation.issues.map((entry) => entry.code).join(', '));
  const manifest = JSON.parse(bytes.toString('utf8')) as BoundaryRunManifest;
  if (manifest.manifestState !== 'active') throw new Error('run manifest is immutable');
  const anchor = verifyRunInitAnchor(manifest, runDir);
  if (!anchor.ok) throw new BoundaryRunLoadError(anchor.issues);
  return { manifest, path: manifestPath };
}

export function reconstructedChildEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? cwd,
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
}

export function capabilityForManifest(manifest: BoundaryRunManifest, name: string): BoundaryRunManifest['run']['observedTools'][number] {
  const frozen = manifest.run.observedTools.find((entry) => entry.name === name);
  const live = resolveBoundaryToolCapability(name);
  if (frozen === undefined || canonicalizeBoundaryRun(frozen) !== canonicalizeBoundaryRun(live)) {
    throw new Error(`${name} capability changed since run initialization`);
  }
  return frozen;
}

export function streamRecord(runDir: string, relativePath: string): { path: string; sha256: string; bytes: number } {
  const bytes = readFileSync(path.join(runDir, relativePath));
  return { path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength };
}

export function resolveAttemptArgv(
  template: readonly string[],
  manifest: BoundaryRunManifest,
  runDir: string,
): string[] {
  const prerequisiteStdout = (id: string): string => {
    const attempt = manifest.attempts.find((entry) => entry.id === id);
    if (attempt === undefined || !attempt.expectationMet || attempt.verdict !== 'Pass') {
      throw new Error(`required prerequisite attempt is unavailable: ${id}`);
    }
    return readFileSync(path.join(runDir, attempt.stdout.path), 'utf8').trim();
  };
  const observedMergeBase = (): string => {
    const id = manifest.run.profileId === 'bcf08-final' ? 'final-upstream-merge-base' : 'upstream-merge-base';
    const value = prerequisiteStdout(id);
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${id} stdout is not one exact Git OID`);
    return value;
  };
  const canaryIdentity = (name: 'parent' | 'child' | 'pgid'): string => {
    const artifact = manifest.artifacts.find((entry) => entry.path === 'watchdog-canary/pids.txt');
    if (artifact === undefined || artifact.producerAttemptId !== 'watchdog-canary') {
      throw new Error('watchdog canary PID artifact is unavailable');
    }
    const content = readFileSync(path.join(runDir, artifact.path), 'utf8');
    const match = new RegExp(`^${name}=([1-9]\\d*)$`, 'm').exec(content);
    if (match === null) throw new Error(`watchdog canary ${name} is malformed`);
    return match[1]!;
  };
  return template.map((argument) => {
    if (argument.includes('<run-dir>')) return argument.replaceAll('<run-dir>', runDir);
    if (argument.includes('<observed-merge-base>')) {
      return argument.replaceAll('<observed-merge-base>', observedMergeBase());
    }
    if (argument === '<test-integrity-real-path>') return resolveBoundaryToolCapability('test-integrity').realPath;
    if (argument === '<watchdog-parent-pid>') return canaryIdentity('parent');
    if (argument === '<watchdog-child-pid>') return canaryIdentity('child');
    if (argument === '-<watchdog-group-pgid>') return `-${canaryIdentity('pgid')}`;
    return argument;
  });
}


export function readConfinedRegularFile(root: string, relativePath: string): Buffer {
  if (!isSafeRelativePath(relativePath)) throw new Error(`unsafe child closure path: ${relativePath}`);
  const absolute = path.resolve(root, relativePath);
  if (path.relative(root, absolute).split(path.sep).includes('..')) {
    throw new Error(`child closure path escapes its root: ${relativePath}`);
  }
  let cursor = root;
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`child closure path contains a symlink: ${relativePath}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`child closure ancestor is not a directory: ${relativePath}`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`child closure leaf is not a regular file: ${relativePath}`);
    }
  }
  return readFileSync(absolute);
}

export function childClosurePaths(manifest: BoundaryRunManifest): string[] {
  const paths = ['run_init.json', 'run_init.sha256', 'run_manifest.json', 'run_manifest.sha256'];
  const attemptsById = new Map(manifest.attempts.map((attempt) => [attempt.id, attempt]));
  for (const attempt of manifest.attempts) {
    paths.push(attempt.stdout.path, attempt.stderr.path);
    if (attempt.structuredResult !== null) {
      const isExactStdoutAlias = attempt.structuredResult.path === attempt.stdout.path
        && attempt.structuredResult.sha256 === attempt.stdout.sha256
        && attempt.structuredResult.bytes === attempt.stdout.bytes;
      if (!isExactStdoutAlias) paths.push(attempt.structuredResult.path);
    }
  }
  for (const artifact of manifest.artifacts) {
    const structuredResult = attemptsById.get(artifact.producerAttemptId)?.structuredResult;
    const isExactStructuredResultAlias = structuredResult !== null
      && structuredResult !== undefined
      && artifact.path === structuredResult.path
      && artifact.sha256 === structuredResult.sha256
      && artifact.bytes === structuredResult.bytes;
    if (!isExactStructuredResultAlias) paths.push(artifact.path);
  }
  for (const review of manifest.reviews) {
    paths.push(review.reportPath, review.metaPath, review.stderrPath);
    for (const finding of review.findings) paths.push(finding.evidencePath);
  }
  for (const child of manifest.children) {
    for (const row of child.importedFiles) paths.push(`children/${child.alias}/${row.path}`);
  }
  if (manifest.predecessor !== null) {
    for (const row of manifest.predecessor.importedFiles) paths.push(`predecessor/${row.path}`);
  }
  const canonical = canonicalSet(paths);
  if (canonical.length !== paths.length) throw new Error('child closure contains duplicate logical paths');
  return canonical;
}

export function childClosureRows(root: string, manifest: BoundaryRunManifest): BoundaryImportedFileRecord[] {
  return childClosurePaths(manifest).map((relativePath) => {
    const bytes = readConfinedRegularFile(root, relativePath);
    return { path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength };
  });
}


export function shaLockBytes(digest: string, basename: string): string {
  return `${digest}  ${basename}\n`;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function strictCanonicalObject(bytes: Buffer, label: string): Record<string, unknown> {
  const parsed = parseBoundaryJsonBytes(bytes);
  if (
    !parsed.result.ok
    || parsed.text === null
    || parsed.value === null
    || typeof parsed.value !== 'object'
    || Array.isArray(parsed.value)
    || parsed.text !== canonicalizeBoundaryRun(parsed.value)
  ) {
    throw new Error(`${label} is not strict canonical JSON`);
  }
  return parsed.value as Record<string, unknown>;
}
export function gitPathSet(cwd: string, args: readonly string[]): string[] {
  const stdout = gitText(cwd, args);
  return canonicalSet(stdout === '' ? [] : stdout.split('\n').filter((entry) => entry !== ''));
}

function snapshotPathRecordsMatch(
  left: BoundaryWorktreeSnapshot,
  right: BoundaryWorktreeSnapshot,
): boolean {
  return canonicalizeBoundaryRun(left.allowedUntracked) === canonicalizeBoundaryRun(right.allowedUntracked)
    && canonicalizeBoundaryRun(left.preservedOwner) === canonicalizeBoundaryRun(right.preservedOwner);
}

export function admitsProfileOwnedCommandWork(
  cwd: string,
  previous: BoundaryWorktreeSnapshot,
  current: BoundaryWorktreeSnapshot,
  allowedPaths: readonly string[],
): boolean {
  if (canonicalizeBoundaryRun(previous) === canonicalizeBoundaryRun(current)) return true;
  if (
    previous.head !== current.head
    || previous.indexTreeOid !== current.indexTreeOid
    || previous.trackedPatchSha256 !== current.trackedPatchSha256
    || !snapshotPathRecordsMatch(previous, current)
  ) return false;
  const allowed = new Set(allowedPaths);
  return gitPathSet(cwd, ['diff', '--name-only', 'HEAD', '--'])
    .every((relativePath) => allowed.has(relativePath));
}

export function admitsByteEquivalentCommitStaging(
  previous: BoundaryWorktreeSnapshot,
  current: BoundaryWorktreeSnapshot,
  expectedHeadTreeOid: string,
): boolean {
  const emptyPatchSha256 = sha256('');
  return previous.head === current.head
    && previous.indexTreeOid === expectedHeadTreeOid
    && previous.trackedPatchSha256 === emptyPatchSha256
    && current.unstagedPatchSha256 === emptyPatchSha256
    && previous.unstagedPatchSha256 === current.trackedPatchSha256
    && snapshotPathRecordsMatch(previous, current);
}

export function acceptedAttemptStdout(manifest: BoundaryRunManifest, runDir: string, attemptId: string): string {
  const attempt = manifest.attempts.find((entry) => entry.id === attemptId);
  if (attempt === undefined || attempt.verdict !== 'Pass' || !attempt.expectationMet) {
    throw new Error(`required attempt is unavailable or non-pass: ${attemptId}`);
  }
  const bytes = readFileSync(path.join(runDir, attempt.stdout.path));
  if (bytes.byteLength !== attempt.stdout.bytes || sha256(bytes) !== attempt.stdout.sha256) {
    throw new Error(`required attempt stdout changed: ${attemptId}`);
  }
  return bytes.toString('utf8');
}

export function parseNameStatusPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.trim() === '' ? [] : stdout.replace(/\n$/, '').split('\n')) {
    const columns = line.split('\t');
    if (columns.length < 2 || !/^(?:[ACDMRTUXB]|R\d{1,3}|C\d{1,3})$/.test(columns[0]!)) {
      throw new Error(`malformed Git name-status row: ${line}`);
    }
    for (const candidate of columns.slice(1)) {
      if (!isSafeRelativePath(candidate)) throw new Error(`unsafe Git name-status path: ${candidate}`);
      paths.push(candidate);
    }
  }
  return canonicalSet(paths);
}
export function validateReviewProofContracts(
  source: BoundaryReviewRecord,
  leadManifest: BoundaryRunManifest,
): BoundaryValidationResult {
  const declaredIds = source.reproductionContracts.map((entry) => entry.attemptId);
  const genericIds = leadManifest.attempts
    .filter((attempt) => !leadManifest.run.requiredAttemptIds.includes(attempt.id))
    .map((attempt) => attempt.id)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (canonicalizeBoundaryRun(genericIds) !== canonicalizeBoundaryRun(declaredIds)) {
    return operationResult([{ code: 'review-proof-set-mismatch', message: 'lead reproduction proof set differs from the review contracts' }]);
  }
  const expectedExitMatches = (expected: string, rawExit: number | null, rawSignal: string | null): boolean => {
    if (rawSignal !== null || rawExit === null) return false;
    if (expected === 'nonzero') return rawExit !== 0;
    return expected.split(',').map(Number).includes(rawExit);
  };
  for (const proofContract of source.reproductionContracts) {
    const matches = leadManifest.attempts.filter((attempt) => attempt.id === proofContract.attemptId);
    const proof = matches[0];
    const tool = leadManifest.run.observedTools.find((entry) => entry.name === proofContract.toolName);
    if (
      matches.length !== 1
      || proof === undefined
      || tool === undefined
      || proof.argv[0] !== proofContract.toolName
      || canonicalizeBoundaryRun(proof.argv) !== canonicalizeBoundaryRun(proofContract.argv)
      || proof.expectedExit !== proofContract.expectedExit
      || proof.deadlineMs !== proofContract.deadlineMs
      || proof.killGraceMs !== proofContract.killGraceMs
      || proof.watchdogOwner !== 'helper-watchdog'
      || proof.innerTimeoutOwner !== null
      || proof.headAnchor !== 'entry'
      || proof.preSnapshot.head !== source.head
      || proof.postSnapshot.head !== source.head
      || proof.preSnapshot.digestSha256 !== source.snapshotDigestSha256
      || proof.postSnapshot.digestSha256 !== source.snapshotDigestSha256
      || proof.declaredOutputs.length !== 0
      || proof.outputAdmissions.length !== 0
      || !expectedExitMatches(proof.expectedExit, proof.rawExit, proof.rawSignal)
      || proof.expectationMet !== true
      || proof.verdict !== 'Pass'
    ) {
      return operationResult([{
        code: 'review-proof-contract-mismatch',
        message: `lead reproduction proof differs from its immutable contract: ${proofContract.attemptId}`,
      }]);
    }
  }
  return operationResult([]);
}


export function importedManifestDepth(
  manifest: BoundaryRunManifest,
  importRoot: string,
  ancestors: ReadonlySet<string> = new Set(),
): number {
  if (ancestors.has(manifest.run.runId)) throw new Error(`child cycle repeats run ID ${manifest.run.runId}`);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(manifest.run.runId);
  let depth = 0;
  for (const child of manifest.children) {
    const childRoot = path.join(importRoot, 'children', child.alias);
    const bytes = readConfinedRegularFile(childRoot, 'run_manifest.json');
    if (sha256(bytes) !== child.sourceManifestSha256) {
      throw new Error(`nested child manifest digest changed: ${child.alias}`);
    }
    const validation = validateBoundaryRunJson(bytes);
    if (!validation.ok) throw new Error(`nested child manifest is invalid: ${child.alias}`);
    const nested = JSON.parse(bytes.toString('utf8')) as BoundaryRunManifest;
    depth = Math.max(depth, 1 + importedManifestDepth(nested, childRoot, nextAncestors));
  }
  return depth;
}

export function childContractFor(
  parentProfileId: string,
  alias: string,
): (typeof RUN_CHILD_CONTRACTS)[keyof typeof RUN_CHILD_CONTRACTS] | undefined {
  return RUN_CHILD_CONTRACTS[`${parentProfileId}/${alias}` as keyof typeof RUN_CHILD_CONTRACTS];
}

export function childRelationIssues(
  parent: BoundaryRunManifest,
  child: BoundaryChildRecord,
  headRelation: (typeof RUN_CHILD_CONTRACTS)[keyof typeof RUN_CHILD_CONTRACTS]['headRelation'],
  pinnedHead: string,
): BoundaryValidationIssue[] {
  let expectedHead = parent.run.entryHead;
  if (headRelation === 'both-docs-entry') {
    const docs = parent.children.find((entry) => entry.alias === 'docs');
    if (docs === undefined) {
      return [{ code: 'child-head-relation-missing', message: 'final review imports require the pinned docs child first' }];
    }
    expectedHead = docs.entryHead;
  }
  const both = headRelation === 'both-parent-entry' || headRelation === 'both-docs-entry';
  if (
    pinnedHead !== expectedHead
    || child.terminalHead !== expectedHead
    || (both && child.entryHead !== expectedHead)
  ) {
    return [{ code: 'child-head-relation-mismatch', message: 'child heads differ from the profile-owned relation' }];
  }
  return [];
}

export function validateRecordedChild(
  parent: BoundaryRunManifest,
  parentRunDir: string,
  child: BoundaryChildRecord,
): BoundaryValidationResult {
  const contract = childContractFor(parent.run.profileId, child.alias);
  const dynamicPin = parent.run.requiredChildPins.find((entry) => entry.alias === child.alias);
  if (contract === undefined || dynamicPin === undefined) {
    return operationResult([{ code: 'child-contract-missing', message: 'child is not owned by the parent profile' }]);
  }
  const importRoot = path.join(parentRunDir, 'children', child.alias);
  let nestedDepth = 0;
  let copiedManifest: BoundaryRunManifest;
  const closureIssues: BoundaryValidationIssue[] = [];
  try {
    const manifestBytes = readConfinedRegularFile(importRoot, 'run_manifest.json');
    if (sha256(manifestBytes) !== dynamicPin.manifestSha256) {
      return operationResult([{ code: 'child-import-mutation', message: 'copied child manifest differs from its frozen pin' }]);
    }
    const parsed = validateBoundaryRunJson(manifestBytes);
    if (!parsed.ok) return parsed;
    copiedManifest = JSON.parse(manifestBytes.toString('utf8')) as BoundaryRunManifest;
    nestedDepth = importedManifestDepth(copiedManifest, importRoot);
    const expectedPaths = childClosurePaths(copiedManifest);
    const recordedPaths = child.importedFiles.map((entry) => entry.path);
    if (canonicalizeBoundaryRun(expectedPaths) !== canonicalizeBoundaryRun(recordedPaths)) {
      closureIssues.push({ code: 'child-closure-set-mismatch', message: 'copied child closure differs from its manifest declarations' });
    }
    if (
      copiedManifest.manifestState !== 'finalized'
      || copiedManifest.run.taskId !== child.taskId
      || copiedManifest.run.profileId !== child.profileId
      || copiedManifest.run.runId !== child.runId
      || copiedManifest.run.entryHead !== child.entryHead
      || copiedManifest.run.terminalHead !== child.terminalHead
      || copiedManifest.currentSnapshot.digestSha256 !== child.snapshotDigestSha256
      || copiedManifest.overallVerdict !== child.overallVerdict
    ) {
      closureIssues.push({ code: 'child-identity-mismatch', message: 'copied manifest identity differs from the parent child row' });
    }
    if (
      readConfinedRegularFile(importRoot, 'run_manifest.sha256').toString('utf8')
      !== shaLockBytes(dynamicPin.manifestSha256, 'run_manifest.json')
    ) {
      closureIssues.push({ code: 'child-manifest-lock-mismatch', message: 'copied child manifest lock differs from the frozen pin' });
    }
  } catch (error) {
    return operationResult([{ code: 'child-import-mutation', message: (error as Error).message }]);
  }
  const identity = validateBoundaryChildImport({
    parentRunId: parent.run.runId,
    parentDepth: nestedDepth,
    maxDepth: contract.maxDepth,
    importRoot,
    existingAliases: [],
    existingPaths: [],
    verifiedSourceManifestSha256: dynamicPin.manifestSha256,
    pin: {
      alias: dynamicPin.alias,
      kind: contract.kind,
      taskId: contract.taskId,
      profileId: contract.profileId,
      runId: dynamicPin.runId,
      entryHead: child.entryHead,
      terminalHead: child.terminalHead,
      manifestSha256: dynamicPin.manifestSha256,
    },
    child,
  });
  const relationIssues = childRelationIssues(parent, child, contract.headRelation, dynamicPin.head);
  return operationResult([...identity.issues, ...relationIssues, ...closureIssues]);
}

export function validateRecordedPredecessor(
  manifest: BoundaryRunManifest,
  runDir: string,
): BoundaryValidationResult {
  const relation = RUN_PREDECESSOR_CONTRACTS[manifest.run.profileId as keyof typeof RUN_PREDECESSOR_CONTRACTS];
  if (relation === undefined) {
    return manifest.predecessor === null
      ? operationResult([])
      : operationResult([{ code: 'predecessor-forbidden', message: 'profile unexpectedly contains a predecessor import' }]);
  }
  const predecessor = manifest.predecessor;
  if (predecessor === null) {
    return operationResult([{ code: 'predecessor-missing', message: 'profile predecessor import is missing' }]);
  }
  const issues: BoundaryValidationIssue[] = [];
  const importRoot = path.join(runDir, 'predecessor');
  if (
    predecessor.pin.taskId !== relation.predecessorTaskId
    || predecessor.pin.profileId !== relation.predecessorProfileId
    || predecessor.sourceManifestSha256 !== predecessor.pin.manifestSha256
    || predecessor.overallVerdict !== 'Pass'
  ) {
    issues.push({ code: 'predecessor-pin-mismatch', message: 'predecessor record differs from the generated relation' });
  }
  try {
    const observedRows = predecessor.importedFiles.map((row) => {
      const bytes = readConfinedRegularFile(importRoot, row.path);
      if (bytes.byteLength !== row.bytes || sha256(bytes) !== row.sha256) {
        issues.push({ code: 'predecessor-import-mutation', message: `predecessor file changed: ${row.path}`, path: row.path });
      }
      return { path: row.path, sha256: sha256(bytes), bytes: bytes.byteLength };
    });
    if (sha256(canonicalizeBoundaryRun(observedRows)) !== predecessor.treeDigestSha256) {
      issues.push({ code: 'predecessor-import-mutation', message: 'predecessor tree digest changed' });
    }
    const sourceManifestBytes = readConfinedRegularFile(importRoot, 'run_manifest.json');
    const sourceValidation = validateBoundaryRunJson(sourceManifestBytes);
    if (!sourceValidation.ok) issues.push(...sourceValidation.issues);
    const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8')) as BoundaryRunManifest;
    const expectedPaths = canonicalSet([
      ...childClosurePaths(sourceManifest),
      'completion/chain_ledger.json',
      'completion/chain_ledger.sha256',
      'completion/completion_receipt.json',
      'completion/completion_receipt.sha256',
    ]);
    if (
      canonicalizeBoundaryRun(expectedPaths)
      !== canonicalizeBoundaryRun(predecessor.importedFiles.map((row) => row.path))
    ) {
      issues.push({ code: 'predecessor-import-mutation', message: 'predecessor imported path set differs from the source manifest closure' });
    }
    if (
      sha256(sourceManifestBytes) !== predecessor.pin.manifestSha256
      || sourceManifest.manifestState !== 'finalized'
      || sourceManifest.overallVerdict !== 'Pass'
      || sourceManifest.run.taskId !== predecessor.pin.taskId
      || sourceManifest.run.profileId !== predecessor.pin.profileId
      || sourceManifest.run.runId !== predecessor.pin.runId
      || sourceManifest.run.terminalHead !== predecessor.pin.terminalHead
      || readConfinedRegularFile(importRoot, 'run_manifest.sha256').toString('utf8')
        !== shaLockBytes(predecessor.pin.manifestSha256, 'run_manifest.json')
    ) {
      issues.push({ code: 'predecessor-pin-mismatch', message: 'copied predecessor manifest identity or lock changed' });
    }
    issues.push(...verifyRunInitAnchor(sourceManifest, importRoot).issues);

    const receiptBytes = readConfinedRegularFile(importRoot, 'completion/completion_receipt.json');
    const ledgerBytes = readConfinedRegularFile(importRoot, 'completion/chain_ledger.json');
    if (
      sha256(receiptBytes) !== predecessor.pin.completionReceiptSha256
      || sha256(ledgerBytes) !== predecessor.pin.ledgerSha256
      || readConfinedRegularFile(importRoot, 'completion/completion_receipt.sha256').toString('utf8')
        !== shaLockBytes(predecessor.pin.completionReceiptSha256, 'completion_receipt.json')
      || readConfinedRegularFile(importRoot, 'completion/chain_ledger.sha256').toString('utf8')
        !== shaLockBytes(predecessor.pin.ledgerSha256, 'chain_ledger.json')
    ) {
      issues.push({ code: 'predecessor-import-mutation', message: 'copied completion receipt or ledger lock changed' });
    }
    const receipt = strictCanonicalObject(receiptBytes, 'copied completion receipt');
    const ledger = strictCanonicalObject(ledgerBytes, 'copied chain ledger');
    const rows = Array.isArray(ledger['rows']) ? ledger['rows'] : [];
    const inherited = {
      reconciledBase: receipt['reconciledBase'],
      upstreamObservedOid: receipt['upstreamObservedOid'],
      corpusDigests: receipt['corpusDigests'],
      oracleDigest: receipt['oracleDigest'],
    };
    if (predecessor.pin.profileId === 'bcf00-observation') {
      if (
        manifest.run.profileId !== 'bcf00-reconciliation'
        || rows.length !== 0
        || sourceManifest.run.chainAppend !== false
        || receipt['manifestSha256'] !== predecessor.pin.manifestSha256
        || receipt['ledgerSha256'] !== predecessor.pin.ledgerSha256
        || manifest.run.entryHead !== predecessor.pin.terminalHead
        || canonicalizeBoundaryRun(inherited) !== canonicalizeBoundaryRun({
          reconciledBase: ledger['reconciledBase'],
          upstreamObservedOid: ledger['upstreamObservedOid'],
          corpusDigests: ledger['corpusDigests'],
          oracleDigest: ledger['oracleDigest'],
        })
      ) {
        issues.push({ code: 'predecessor-observation-mismatch', message: 'copied observation predecessor is not the canonical empty-ledger Pass' });
      }
    } else {
      const chain = validateAndAppendBoundaryPredecessor({
        profileId: manifest.run.profileId,
        pin: predecessor.pin,
        receipt,
        receiptSha256: predecessor.pin.completionReceiptSha256,
        ledger,
        ledgerSha256: predecessor.pin.ledgerSha256,
        inherited,
        currentRow: {
          ordinal: rows.length + 1,
          taskId: relation.taskId,
          profileId: manifest.run.profileId,
          runId: manifest.run.runId,
          entryHead: manifest.run.entryHead,
          terminalHead: manifest.run.entryHead,
          manifestSha256: '0'.repeat(64),
          previousLedgerSha256: predecessor.pin.ledgerSha256,
          overallVerdict: 'Pass',
        },
      });
      issues.push(...chain.result.issues);
    }
  } catch (error) {
    issues.push({ code: 'predecessor-import-mutation', message: (error as Error).message });
  }
  return operationResult(issues);
}
