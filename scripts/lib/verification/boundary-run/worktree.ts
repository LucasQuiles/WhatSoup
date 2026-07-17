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

function validateDeclarationSet(
  values: readonly string[],
  name: string,
  issues: BoundaryValidationIssue[],
): void {
  const sorted = [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (new Set(values).size !== values.length || values.some((value) => !isSafePath(value))) {
    issues.push(issue('snapshot-invalid-declaration', `${name} must contain unique normalized repository paths`, name));
  }
  if (values.some((value, index) => value !== sorted[index])) {
    issues.push(issue('snapshot-invalid-declaration-order', `${name} must be sorted by UTF-8 bytes`, name));
  }
}

export function capturePathRecord(repo: string, repoPath: string): BoundaryPathRecord {
  const absolute = path.resolve(repo, repoPath);
  const relative = path.relative(repo, absolute).split(path.sep).join('/');
  if (relative !== repoPath || relative.startsWith('../')) throw new Error(`${repoPath} escapes the repository`);
  const stat = lstatSync(absolute);
  if (!stat.isFile()) throw new Error(`${repoPath} is not a regular file`);
  const bytes = readFileSync(absolute);
  return {
    path: repoPath,
    type: 'regular',
    mode: stat.mode.toString(8).padStart(6, '0').slice(-6),
    bytes: stat.size,
    sha256: sha256Bytes(bytes),
  };
}

export function captureBoundaryWorktreeSnapshot(
  repoPath: string,
  declarations: BoundarySnapshotDeclarations,
): BoundarySnapshotCaptureResult {
  const issues: BoundaryValidationIssue[] = [];
  validateDeclarationSet(declarations.allowedUntrackedPaths, 'allowedUntrackedPaths', issues);
  validateDeclarationSet(declarations.preservedOwnerPaths, 'preservedOwnerPaths', issues);
  const declared = new Set([...declarations.allowedUntrackedPaths, ...declarations.preservedOwnerPaths]);
  if (declared.size !== declarations.allowedUntrackedPaths.length + declarations.preservedOwnerPaths.length) {
    issues.push(issue('snapshot-overlapping-declaration', 'allowed-untracked and preserved-owner paths must be disjoint'));
  }
  if (issues.length > 0) return { ok: false, snapshot: null, issues };

  try {
    const repo = realpathSync(repoPath);
    const untracked = gitBytes(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    const unexpected = untracked.filter((entry) => !declared.has(entry));
    for (const entry of unexpected) {
      issues.push(issue('snapshot-unexpected-untracked', `unexpected untracked path: ${entry}`, entry));
    }
    if (issues.length > 0) return { ok: false, snapshot: null, issues };

    const untrackedSet = new Set(untracked);
    const allowedUntracked = declarations.allowedUntrackedPaths
      .filter((entry) => untrackedSet.has(entry))
      .map((entry) => capturePathRecord(repo, entry));
    const preservedOwner = declarations.preservedOwnerPaths.map((entry) => capturePathRecord(repo, entry));
    const withoutDigest = {
      head: gitText(repo, ['rev-parse', 'HEAD']),
      indexTreeOid: gitText(repo, ['write-tree']),
      trackedPatchSha256: sha256Bytes(gitBytes(repo, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff'])),
      unstagedPatchSha256: sha256Bytes(gitBytes(repo, ['diff', '--binary', '--full-index', '--no-ext-diff'])),
      allowedUntracked,
      preservedOwner,
    };
    const snapshot: BoundaryWorktreeSnapshot = {
      ...withoutDigest,
      digestSha256: sha256Bytes(canonicalizeBoundaryRun(withoutDigest)),
    };
    return { ok: true, snapshot, issues: [] };
  } catch (error) {
    issues.push(issue('snapshot-capture-failed', `failed to capture worktree snapshot: ${(error as Error).message}`));
    return { ok: false, snapshot: null, issues };
  }
}

export function verifyBoundaryWorktreeSnapshot(
  repoPath: string,
  expected: unknown,
  declarations: BoundarySnapshotDeclarations,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  if (!requireExactRecord(expected, SNAPSHOT_KEYS, issues, 'invalid-snapshot-keys', 'snapshot')) {
    return snapshotResult(issues);
  }
  const current = captureBoundaryWorktreeSnapshot(repoPath, declarations);
  if (!current.ok || current.snapshot === null) return snapshotResult(current.issues);

  if (expected['head'] !== current.snapshot.head) {
    issues.push(issue('snapshot-head-drift', 'worktree HEAD changed', 'head'));
  }
  if (
    expected['indexTreeOid'] !== current.snapshot.indexTreeOid
    || expected['trackedPatchSha256'] !== current.snapshot.trackedPatchSha256
  ) {
    issues.push(issue('snapshot-index-drift', 'worktree index changed', 'indexTreeOid'));
  }
  if (expected['unstagedPatchSha256'] !== current.snapshot.unstagedPatchSha256) {
    issues.push(issue('snapshot-unstaged-drift', 'unstaged worktree state changed', 'unstagedPatchSha256'));
  }
  if (canonicalizeBoundaryRun(expected['allowedUntracked']) !== canonicalizeBoundaryRun(current.snapshot.allowedUntracked)) {
    issues.push(issue('snapshot-allowed-untracked-drift', 'allowed-untracked state changed', 'allowedUntracked'));
  }
  if (canonicalizeBoundaryRun(expected['preservedOwner']) !== canonicalizeBoundaryRun(current.snapshot.preservedOwner)) {
    issues.push(issue('snapshot-owner-drift', 'preserved-owner state changed', 'preservedOwner'));
  }
  if (expected['digestSha256'] !== current.snapshot.digestSha256 && issues.length === 0) {
    issues.push(issue('snapshot-digest-drift', 'snapshot digest changed', 'digestSha256'));
  }
  return snapshotResult(issues);
}

function derivedRootFailure(code: string, message: string): BoundaryDerivedRootResult {
  return { ok: false, reservation: null, issues: [issue(code, message)] };
}

export function isPathOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

export function reserveBoundaryDerivedRoot(input: {
  evidenceRoot: string;
  parentSegments: readonly string[];
  runId: string;
  kind: BoundaryDerivedRootKind;
  protectedPaths: readonly string[];
}): BoundaryDerivedRootResult {
  if (
    !path.isAbsolute(input.evidenceRoot)
    || input.parentSegments.length === 0
    || input.parentSegments.some(
      (segment) => segment === '' || segment === '.' || segment === '..' || path.basename(segment) !== segment,
    )
    || !/^[a-z][a-z0-9-]{0,63}$/.test(input.runId)
  ) {
    return derivedRootFailure('derived-root-path-invalid', 'derived root components must be closed canonical segments');
  }

  try {
    const requestedRoot = path.resolve(input.evidenceRoot);
    const evidenceRoot = realpathSync(requestedRoot);
    if (evidenceRoot !== requestedRoot) {
      return derivedRootFailure('derived-root-symlink', 'evidence root must not resolve through a symlink');
    }
    const ancestors: BoundaryDerivedRootReservation['ancestors'] = [];
    let current = evidenceRoot;
    for (const segment of input.parentSegments) {
      current = path.join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        return derivedRootFailure('derived-root-symlink', `derived root ancestor is a symlink: ${current}`);
      }
      if (!stat.isDirectory()) {
        return derivedRootFailure('derived-root-path-invalid', `derived root ancestor is not a directory: ${current}`);
      }
      if (realpathSync(current) !== current) {
        return derivedRootFailure('derived-root-symlink', `derived root ancestor resolves elsewhere: ${current}`);
      }
      ancestors.push({ path: current, device: Number(stat.dev), inode: Number(stat.ino) });
    }
    const parent = ancestors.at(-1)!;
    const leaf = path.join(parent.path, input.runId);
    for (const protectedPath of input.protectedPaths) {
      if (!path.isAbsolute(protectedPath) || isPathOverlap(leaf, path.resolve(protectedPath))) {
        return derivedRootFailure('derived-root-overlap', `derived root overlaps protected path: ${protectedPath}`);
      }
    }
    try {
      lstatSync(leaf);
      return derivedRootFailure('derived-root-exists', `derived root leaf already exists: ${leaf}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const reservation: BoundaryDerivedRootReservation = {
      kind: input.kind,
      path: leaf,
      parentPath: parent.path,
      parentDevice: parent.device,
      parentInode: parent.inode,
      ancestors,
    };
    return { ok: true, reservation, issues: [] };
  } catch (error) {
    return derivedRootFailure(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'derived-root-path-invalid' : 'derived-root-reservation-failed',
      `failed to reserve derived root: ${(error as Error).message}`,
    );
  }
}

export function createBoundaryDerivedRoot(reservation: BoundaryDerivedRootReservation): BoundaryDerivedRootResult {
  try {
    for (const ancestor of reservation.ancestors) {
      const stat = lstatSync(ancestor.path);
      if (stat.isSymbolicLink()) {
        return derivedRootFailure('derived-root-symlink', `derived root ancestor became a symlink: ${ancestor.path}`);
      }
      if (Number(stat.dev) !== ancestor.device || Number(stat.ino) !== ancestor.inode) {
        return derivedRootFailure('derived-root-parent-raced', `derived root ancestor identity changed: ${ancestor.path}`);
      }
    }
    const parent = lstatSync(reservation.parentPath);
    if (Number(parent.dev) !== reservation.parentDevice || Number(parent.ino) !== reservation.parentInode) {
      return derivedRootFailure('derived-root-parent-raced', 'derived root parent identity changed before creation');
    }
    try {
      lstatSync(reservation.path);
      return derivedRootFailure('derived-root-exists', `derived root leaf already exists: ${reservation.path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(reservation.path, { recursive: false, mode: 0o700 });
    const created = lstatSync(reservation.path);
    const resolved = realpathSync(reservation.path);
    const parentAfter = lstatSync(reservation.parentPath);
    if (
      !created.isDirectory()
      || resolved !== reservation.path
      || path.dirname(resolved) !== reservation.parentPath
      || Number(parentAfter.dev) !== reservation.parentDevice
      || Number(parentAfter.ino) !== reservation.parentInode
    ) {
      if (created.isDirectory()) {
        try {
          rmdirSync(reservation.path);
        } catch {
          // A non-empty or replaced leaf is foreign state and is intentionally retained.
        }
      }
      return derivedRootFailure('derived-root-postcreate-mismatch', 'derived root identity changed during creation');
    }
    return {
      ok: true,
      reservation,
      record: {
        kind: reservation.kind,
        path: reservation.path,
        parentDevice: reservation.parentDevice,
        parentInode: reservation.parentInode,
        state: 'created',
      },
      issues: [],
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return derivedRootFailure('derived-root-exists', 'derived root leaf already exists');
    if (code === 'ENOENT') return derivedRootFailure('derived-root-parent-raced', 'derived root ancestor disappeared');
    return derivedRootFailure('derived-root-creation-failed', `failed to create derived root: ${(error as Error).message}`);
  }
}
