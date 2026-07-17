export const BOUNDARY_RUN_SCHEMA = 1 as const;

export type BoundaryVerdict = 'Pass' | 'Fail' | 'Inconclusive' | 'Blocked';

export interface BoundaryValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface BoundaryValidationResult {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  verdict: BoundaryVerdict;
  issues: BoundaryValidationIssue[];
}

export interface BoundaryPathRecord {
  path: string;
  type: 'regular';
  mode: string;
  bytes: number;
  sha256: string;
}

export interface BoundaryWorktreeSnapshot {
  head: string;
  indexTreeOid: string;
  trackedPatchSha256: string;
  unstagedPatchSha256: string;
  allowedUntracked: BoundaryPathRecord[];
  preservedOwner: BoundaryPathRecord[];
  digestSha256: string;
}

export interface BoundarySnapshotDeclarations {
  allowedUntrackedPaths: readonly string[];
  preservedOwnerPaths: readonly string[];
}

export interface BoundarySnapshotCaptureResult {
  ok: boolean;
  snapshot: BoundaryWorktreeSnapshot | null;
  issues: BoundaryValidationIssue[];
}

export type BoundaryDerivedRootKind = 'run' | 'completion' | 'closeout' | 'closeout-failure';

export interface BoundaryDerivedRootReservation {
  kind: BoundaryDerivedRootKind;
  path: string;
  parentPath: string;
  parentDevice: number;
  parentInode: number;
  ancestors: Array<{ path: string; device: number; inode: number }>;
}

export interface BoundaryDerivedRootResult {
  ok: boolean;
  reservation: BoundaryDerivedRootReservation | null;
  record?: {
    kind: BoundaryDerivedRootKind;
    path: string;
    parentDevice: number;
    parentInode: number;
    state: 'created';
  };
  issues: BoundaryValidationIssue[];
}

export interface BoundaryAttemptStatus {
  expectedExit: string;
  rawExit: number | null;
  rawSignal: string | null;
  expectationMet: boolean;
  watchdogOwner: 'helper-watchdog' | null;
  innerTimeoutOwner: 'gnu-timeout' | null;
  deadlineMs: number;
  killGraceMs: number;
}

export type BoundaryAttemptStatusContract = Pick<
  BoundaryAttemptStatus,
  'expectedExit' | 'watchdogOwner' | 'innerTimeoutOwner' | 'deadlineMs' | 'killGraceMs'
>;

export type BoundaryArtifactRole =
  | 'input'
  | 'output'
  | 'receipt'
  | 'review'
  | 'lifecycle'
  | 'oracle'
  | 'scope'
  | 'measurement';

export interface BoundaryStreamRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BoundaryOutputAdmission {
  path: string;
  state: 'missing' | 'pending' | 'admitted';
  role: BoundaryArtifactRole | null;
  sha256: string | null;
  bytes: number | null;
}

export interface BoundaryAttemptRecord {
  id: string;
  operation: 'command' | 'internal-check' | 'git-transition';
  headAnchor: 'entry' | 'terminal' | 'transition';
  argv: string[];
  cwd: string;
  startedAtUtc: string;
  endedAtUtc: string;
  expectedExit: string;
  rawExit: number | null;
  rawSignal: string | null;
  expectationMet: boolean;
  watchdogOwner: 'helper-watchdog' | null;
  innerTimeoutOwner: null | 'gnu-timeout';
  deadlineMs: number;
  killGraceMs: number;
  preSnapshot: BoundaryWorktreeSnapshot;
  postSnapshot: BoundaryWorktreeSnapshot;
  stdout: BoundaryStreamRecord;
  stderr: BoundaryStreamRecord;
  declaredOutputs: string[];
  outputAdmissions: BoundaryOutputAdmission[];
  structuredResult: BoundaryStreamRecord | null;
  verdict: BoundaryVerdict;
}

export interface BoundaryArtifactRecord {
  path: string;
  role: BoundaryArtifactRole;
  producerAttemptId: string;
  sha256: string;
  bytes: number;
}

export interface BoundaryChildRecord {
  alias: string;
  kind: 'observation' | 'docs' | 'review' | 'reproduction' | 'predecessor';
  taskId: string;
  profileId: string;
  runId: string;
  entryHead: string;
  terminalHead: string;
  snapshotDigestSha256: string;
  sourceManifestSha256: string;
  importedFiles: BoundaryImportedFileRecord[];
  treeDigestSha256: string;
  overallVerdict: BoundaryVerdict;
  dedupeKey: string;
}

export interface BoundaryImportedFileRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BoundaryPredecessorPin {
  taskId: string;
  profileId: string;
  runId: string;
  terminalHead: string;
  manifestSha256: string;
  completionReceiptSha256: string;
  ledgerSha256: string;
}

export interface BoundaryPredecessorRecord {
  pin: BoundaryPredecessorPin;
  sourceManifestSha256: string;
  importedFiles: BoundaryImportedFileRecord[];
  treeDigestSha256: string;
  overallVerdict: BoundaryVerdict;
}

export interface BoundaryFindingRecord {
  findingId: string;
  severity: 'blocker' | 'critical' | 'major' | 'minor' | 'note';
  requiresFix: boolean;
  requiresReproduction: boolean;
  evidencePath: string;
  evidenceSha256: string;
  disposition: 'accepted' | 'rejected' | 'deferred';
  resolution: 'open' | 'fixed' | 'not-applicable';
  reason: string | null;
  counterevidenceRefs: string[];
  reproductionAttemptIds: string[];
  counterReproductionAttemptIds: string[];
  fixedAtHead: string | null;
  fixReproductionAttemptIds: string[];
  fixReviewId: string | null;
}

export interface BoundaryReviewRecord {
  reviewId: string;
  alias: string;
  dedupeKey: string;
  head: string;
  snapshotDigestSha256: string;
  reportPath: string;
  reportSha256: string;
  metaPath: string;
  metaSha256: string;
  stderrPath: string;
  stderrSha256: string;
  findings: BoundaryFindingRecord[];
  reproductionContracts: BoundaryReproductionContractRecord[];
}

export interface BoundaryReviewInputRecord extends Omit<BoundaryReviewRecord, 'alias'> {
  schemaVersion: 1;
}

export interface BoundaryReproductionContractRecord {
  attemptId: string;
  argv: string[];
  expectedExit: string;
  toolName: string;
  deadlineMs: 900000;
  killGraceMs: 30000;
}

export interface BoundaryLifecycleRecord {
  status: 'pending' | 'active' | 'completed' | 'deferred' | 'closed' | 'blocked';
  completionCommit: string | null;
  finalGate: 'not-run' | 'pass' | 'fail' | 'inconclusive' | 'blocked';
  artifactSha256: string | null;
  successor: string | null;
  supersededBy: string | null;
  oracle: 'not-applicable' | 'current' | 'superseded-invalid-oracle';
  branchDeletionAuthorized: false;
}

export interface BoundaryUpstreamRecord {
  remoteUrl: string | 'not-observed';
  observedOid: string | 'not-observed';
  mergeBase: string | 'not-observed';
  ahead: number | 'not-observed';
  behind: number | 'not-observed';
  remotePaths: string[];
  localPaths: string[];
  observationManifestSha256: string | 'not-observed';
  mergeCommit: string | 'not-observed';
  mergeParents: [] | [string, string];
}

export interface BoundaryToolRecord {
  name: string;
  realPath: string;
  version: string;
  sha256: string;
}

export interface BoundaryReservedDerivedRootRecord {
  kind: BoundaryDerivedRootKind;
  path: string;
  parentDevice: number;
  parentInode: number;
  state: 'reserved' | 'created';
}

export interface BoundaryChildPinRecord {
  alias: string;
  head: string;
  runId: string;
  manifestSha256: string;
}

export interface BoundaryRunRecord {
  runId: string;
  taskId: string;
  profileId: string;
  phase: string;
  createdAtUtc: string;
  finalizedAtUtc: string | null;
  entryHead: string;
  terminalHead: string | null;
  reconciledBase: string | 'not-observed';
  helperCommit: string;
  helperSha256: string;
  allowedPaths: string[];
  allowedUntrackedPaths: string[];
  preservedOwnerPaths: string[];
  requiredAttemptIds: string[];
  requiredChildAliases: string[];
  requiredChildPins: BoundaryChildPinRecord[];
  transitionCount: 0 | 1;
  mayComplete: boolean;
  chainAppend: boolean;
  requestedTools: string[];
  observedTools: BoundaryToolRecord[];
  reservedDerivedRoots: BoundaryReservedDerivedRootRecord[];
}

export interface BoundaryEntryTestRoster {
  files: Array<{ path: string; state: 'present' | 'absent'; testNames: string[] }>;
  digestSha256: string;
}

export interface BoundaryDocumentHashRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BoundaryRunManifest {
  schemaVersion: typeof BOUNDARY_RUN_SCHEMA;
  manifestState: 'active' | 'finalized' | 'verified-pass-closeout-rejected';
  run: BoundaryRunRecord;
  entrySnapshot: BoundaryWorktreeSnapshot;
  currentSnapshot: BoundaryWorktreeSnapshot;
  attempts: BoundaryAttemptRecord[];
  artifacts: BoundaryArtifactRecord[];
  children: BoundaryChildRecord[];
  predecessor: BoundaryPredecessorRecord | null;
  entryTestRoster: BoundaryEntryTestRoster;
  reviews: BoundaryReviewRecord[];
  lifecycle: BoundaryLifecycleRecord;
  documentHashes: {
    spec: BoundaryDocumentHashRecord;
    plan: BoundaryDocumentHashRecord;
    notes: BoundaryDocumentHashRecord;
    helper: BoundaryDocumentHashRecord;
  };
  upstream: BoundaryUpstreamRecord;
  overallVerdict: BoundaryVerdict;
}

export interface BoundaryRunInitAnchor {
  schemaVersion: typeof BOUNDARY_RUN_SCHEMA;
  runId: string;
  taskId: string;
  profileId: string;
  phase: string;
  createdAtUtc: string;
  entryHead: string;
  entrySnapshotDigestSha256: string;
  helperCommit: string;
  helperSha256: string;
  allowedPaths: string[];
  allowedUntrackedPaths: string[];
  preservedOwnerPaths: string[];
  requiredAttemptIds: string[];
  requiredChildAliases: string[];
  requiredChildPins: BoundaryChildPinRecord[];
  predecessorPin: BoundaryPredecessorPin | null;
  predecessorTreeDigestSha256: string | null;
  mayComplete: boolean;
  chainAppend: boolean;
  requestedTools: string[];
  observedTools: BoundaryToolRecord[];
  reservedDerivedRoots: BoundaryReservedDerivedRootRecord[];
  entryTestRosterDigestSha256: string;
  documentHashesDigestSha256: string;
}

