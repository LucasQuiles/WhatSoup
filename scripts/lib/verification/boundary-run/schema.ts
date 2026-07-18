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

import { capturePathRecord, verifyBoundaryWorktreeSnapshot } from './worktree.ts';

export function createBoundaryRunInitAnchor(manifest: BoundaryRunManifest): BoundaryRunInitAnchor {
  return {
    schemaVersion: BOUNDARY_RUN_SCHEMA,
    runId: manifest.run.runId,
    taskId: manifest.run.taskId,
    profileId: manifest.run.profileId,
    phase: manifest.run.phase,
    createdAtUtc: manifest.run.createdAtUtc,
    entryHead: manifest.run.entryHead,
    entrySnapshotDigestSha256: manifest.entrySnapshot.digestSha256,
    helperCommit: manifest.run.helperCommit,
    helperSha256: manifest.run.helperSha256,
    allowedPaths: structuredClone(manifest.run.allowedPaths),
    allowedUntrackedPaths: structuredClone(manifest.run.allowedUntrackedPaths),
    preservedOwnerPaths: structuredClone(manifest.run.preservedOwnerPaths),
    requiredAttemptIds: structuredClone(manifest.run.requiredAttemptIds),
    requiredChildAliases: structuredClone(manifest.run.requiredChildAliases),
    requiredChildPins: structuredClone(manifest.run.requiredChildPins),
    predecessorPin: manifest.predecessor === null ? null : structuredClone(manifest.predecessor.pin),
    predecessorTreeDigestSha256: manifest.predecessor?.treeDigestSha256 ?? null,
    mayComplete: manifest.run.mayComplete,
    chainAppend: manifest.run.chainAppend,
    requestedTools: structuredClone(manifest.run.requestedTools),
    observedTools: structuredClone(manifest.run.observedTools),
    reservedDerivedRoots: structuredClone(manifest.run.reservedDerivedRoots),
    entryTestRosterDigestSha256: manifest.entryTestRoster.digestSha256,
    documentHashesDigestSha256: sha256Bytes(canonicalizeBoundaryRun(manifest.documentHashes)),
  };
}

function validateSnapshotShape(value: unknown, issues: BoundaryValidationIssue[], path: string): void {
  if (!requireExactRecord(value, SNAPSHOT_KEYS, issues, 'invalid-snapshot-keys', path)) return;
  requireRows(value['allowedUntracked'], SNAPSHOT_PATH_KEYS, issues, 'invalid-snapshot-path-keys', `${path}.allowedUntracked`);
  requireRows(value['preservedOwner'], SNAPSHOT_PATH_KEYS, issues, 'invalid-snapshot-path-keys', `${path}.preservedOwner`);
}

function validateImportedFiles(value: unknown, issues: BoundaryValidationIssue[], path: string): void {
  requireRows(value, IMPORTED_FILE_KEYS, issues, 'invalid-imported-file-keys', path);
}


const GENERATED_INDEX_PATHS = ['docs/work-index.json', 'docs/work-index.md'] as const;
const GENERATED_INDEX_ARGV = ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen'] as const;

export function validateBoundaryStructuredRecord(
  schema: keyof typeof RUN_WIRE_SCHEMAS,
  value: Record<string, unknown>,
): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  const keys = RUN_WIRE_SCHEMAS[schema];
  if (keys === undefined || !hasExactKeys(value, keys)) {
    return snapshotResult([issue('structured-record-shape', `${schema} has a missing or foreign key`)]);
  }
  if (value['schemaVersion'] !== 1) {
    issues.push(issue('structured-record-version', `${schema} requires schemaVersion 1`, 'schemaVersion'));
  }

  if (schema === 'ReadinessRecord') {
    const evidence = requireRows(value['evidence'], READINESS_EVIDENCE_KEYS, issues, 'structured-record-shape', 'evidence');
    const assumptions = requireRows(value['assumptions'], READINESS_ASSUMPTION_KEYS, issues, 'structured-record-shape', 'assumptions');
    const risks = requireRows(value['risks'], READINESS_RISK_KEYS, issues, 'structured-record-shape', 'risks');
    const blockers = requireRows(value['blockers'], READINESS_BLOCKER_KEYS, issues, 'structured-record-shape', 'blockers');
    check(isOperationalId(value['runId']) && value['taskId'] === 'BCF-00' && value['profileId'] === 'bcf00-reconciliation', issues, 'readiness-identity-invalid', 'identity');
    check(isOid(value['head']) && isSha256(value['snapshotDigestSha256']) && isTimestamp(value['evaluatedAtUtc']), issues, 'readiness-identity-invalid', 'head');
    check(isBoundedText(value['decisionRationale']) && value['decisionAuthority'] === 'implementation-lead', issues, 'readiness-decision-invalid', 'decision');
    const evidenceIds = evidence.map((row) => row['evidenceId']);
    check(isSortedUniqueStrings(evidenceIds, isOperationalId), issues, 'readiness-evidence-invalid', 'evidence');
    for (const row of evidence) {
      check(
        isOperationalId(row['evidenceId']) && isOperationalId(row['producerAttemptId'])
          && isSafePath(row['artifactPath']) && isSha256(row['sha256']) && isVerdict(row['verdict']),
        issues, 'readiness-evidence-invalid', String(row['evidenceId']),
      );
    }
    const expectedAssumptions = ['A-08', 'A-09', 'A-10'];
    check(
      assumptions.length === 3 && assumptions.every((row, index) => row['assumptionId'] === expectedAssumptions[index]),
      issues, 'readiness-assumption-invalid', 'assumptions',
    );
    for (const row of assumptions) {
      check(
        (row['disposition'] === 'validated' || row['disposition'] === 'blocked')
          && isSortedUniqueStrings(row['evidenceRefs'], isOperationalId)
          && (row['evidenceRefs'] as string[]).every((entry) => evidenceIds.includes(entry)),
        issues, 'readiness-assumption-invalid', String(row['assumptionId']),
      );
    }
    const riskIds = risks.map((row) => row['riskId']);
    check(isSortedUniqueStrings(riskIds, isOperationalId), issues, 'readiness-risk-invalid', 'risks');
    for (const row of risks) {
      const evidenceRow = evidence.find((entry) => entry['artifactPath'] === row['artifactPath']);
      check(
        isOperationalId(row['riskId']) && isBoundedText(row['owner'], 512)
          && isBoundedText(row['checkpoint'], 1_024) && isSafePath(row['artifactPath'])
          && isSha256(row['artifactSha256']) && isBoundedText(row['stopCondition'], 1_024)
          && evidenceRow?.['sha256'] === row['artifactSha256'],
        issues, 'readiness-risk-invalid', String(row['riskId']),
      );
    }
    const blockerIds = blockers.map((row) => row['blockerId']);
    check(isSortedUniqueStrings(blockerIds, isOperationalId), issues, 'readiness-blocker-invalid', 'blockers');
    for (const row of blockers) {
      check(
        isOperationalId(row['blockerId']) && isBoundedText(row['reason'])
          && isSortedUniqueStrings(row['evidenceRefs'], isOperationalId)
          && (row['evidenceRefs'] as string[]).every((entry) => evidenceIds.includes(entry)),
        issues, 'readiness-blocker-invalid', String(row['blockerId']),
      );
    }
    const ready = value['readinessState'] === 'Ready with Constraints';
    if (ready) {
      check(assumptions.every((row) => row['disposition'] === 'validated') && blockers.length === 0 && risks.length > 0, issues, 'readiness-decision-invalid', 'readinessState');
      check(value['nextAllowedAction'] === 'BCF-01' && value['overallVerdict'] === 'Pass', issues, 'readiness-decision-invalid', 'overallVerdict');
    } else {
      check(value['readinessState'] === 'Not Ready' && value['nextAllowedAction'] === null && value['overallVerdict'] !== 'Pass' && isVerdict(value['overallVerdict']), issues, 'readiness-decision-invalid', 'readinessState');
      check(blockers.length > 0 || assumptions.some((row) => row['disposition'] === 'blocked'), issues, 'readiness-decision-invalid', 'blockers');
    }
  } else if (schema === 'ConsumerVersionDecision') {
    const matches = requireRows(value['inventoryMatches'], CONSUMER_INVENTORY_MATCH_KEYS, issues, 'structured-record-shape', 'inventoryMatches');
    const consumers = requireRows(value['localConsumers'], LOCAL_CONSUMER_KEYS, issues, 'structured-record-shape', 'localConsumers');
    check(
      value['packageVersion'] === '0.1.0' && value['currentProducerSchema'] === 1
        && value['proposedProducerSchema'] === 2 && value['supportStage'] === 'beta-shadow-only'
        && value['externalConsumers'] === 'unknown' && value['compatibilityReader'] === 'schema-1-read-render'
        && value['decision'] === 'pre-1.0-shadow-compatible' && value['releaseNoteRequired'] === false
        && canonicalizeBoundaryRun(value['limitations']) === canonicalizeBoundaryRun(['external-consumers-unknown'])
        && value['overallVerdict'] === 'Pass',
      issues, 'consumer-decision-invalid', 'decision',
    );
    const inventoryQuery = [
      'rg', '-n', 'buildBoundaryReceipt\\(|buildSemanticReceipt\\(|schemaVersion',
      'scripts', 'tests', 'docs', '--glob', '*.ts', '--glob', '*.md',
    ];
    check(isOid(value['head']) && isOid(value['rollbackCommit']) && isSha256(value['snapshotDigestSha256']) && value['inventoryQuerySha256'] === sha256Bytes(canonicalizeBoundaryRun(inventoryQuery)), issues, 'consumer-decision-invalid', 'identity');
    const refs = new Set<string>();
    for (const row of matches) {
      const ref = `${String(row['path'])}:${String(row['line'])}:${String(row['column'])}:${String(row['matchKind'])}:${String(row['matchedToken'])}`;
      check(isSafePath(row['path']) && Number.isSafeInteger(row['line']) && Number(row['line']) > 0 && Number.isSafeInteger(row['column']) && Number(row['column']) > 0 && ['producer-call', 'compatibility-read', 'schema-reference'].includes(String(row['matchKind'])) && isBoundedText(row['matchedToken'], 512) && isSha256(row['lineSha256']) && !refs.has(ref), issues, 'consumer-inventory-invalid', ref);
      refs.add(ref);
    }
    const claimedRefs: string[] = [];
    for (const row of consumers) {
      check(isOperationalId(row['consumerId']) && ['producer', 'reader', 'test', 'documentation'].includes(String(row['kind'])) && isSafePath(row['path']) && isBoundedText(row['symbol'], 512) && ['schema-1', 'schema-1-read-schema-2-write', 'schema-1-and-2'].includes(String(row['schemaSupport'])) && isSortedUniqueStrings(row['matchRefs'], (entry) => typeof entry === 'string' && refs.has(entry)), issues, 'consumer-inventory-invalid', String(row['consumerId']));
      claimedRefs.push(...(Array.isArray(row['matchRefs']) ? row['matchRefs'] as string[] : []));
    }
    check(claimedRefs.length === refs.size && new Set(claimedRefs).size === claimedRefs.length, issues, 'consumer-inventory-invalid', 'localConsumers.matchRefs');
  } else if (schema === 'FeedbackMeasurements') {
    if (!requireExactRecord(value['budgets'], BOUNDARY_BUDGET_KEYS, issues, 'structured-record-shape', 'budgets')) return snapshotResult(issues);
    const scenarios = requireRows(value['scenarios'], FEEDBACK_SCENARIO_KEYS, issues, 'structured-record-shape', 'scenarios');
    check(canonicalizeBoundaryRun(value['budgets']) === canonicalizeBoundaryRun(EXPECTED_BOUNDARY_BUDGETS), issues, 'feedback-budget-invalid', 'budgets');
    const expectedScenarios = ['ordinary', 'human-at-limit', 'human-one-over', 'json-at-limit', 'json-one-over', 'multibyte'];
    check(scenarios.length === expectedScenarios.length && scenarios.every((row, index) => row['ordinal'] === index + 1 && row['scenario'] === expectedScenarios[index]), issues, 'feedback-scenario-invalid', 'scenarios');
    for (const row of scenarios) {
      check(['aggregate', 'public-text', 'canonical-json', 'utf8-text'].includes(String(row['subject'])) && ['inputBytes', 'limitBytes', 'humanBytes', 'jsonBytes', 'detailedFindings', 'omittedFindings', 'renderedObservations', 'omittedObservations'].every((key) => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) && isSha256(row['evidenceDigestSha256']) && isSha256(row['descriptorDigestSha256']) && ['accepted', 'diagnostic-inconclusive'].includes(String(row['expectedDisposition'])) && row['observedDisposition'] === row['expectedDisposition'], issues, 'feedback-scenario-invalid', String(row['scenario']));
      check(Number(row['humanBytes']) <= EXPECTED_BOUNDARY_BUDGETS.maxHumanBytes && Number(row['jsonBytes']) <= EXPECTED_BOUNDARY_BUDGETS.maxJsonBytes && Number(row['detailedFindings']) <= EXPECTED_BOUNDARY_BUDGETS.maxHumanDetailedFindings, issues, 'feedback-budget-invalid', String(row['scenario']));
    }
    const scenarioByName = new Map(scenarios.map((row) => [row['scenario'], row]));
    const exactLimit = (name: string, limit: number, delta: 0 | 1, disposition: string): void => {
      const row = scenarioByName.get(name);
      check(row !== undefined && row['inputBytes'] === limit + delta && row['limitBytes'] === limit && row['expectedDisposition'] === disposition, issues, 'feedback-budget-invalid', name);
    };
    exactLimit('human-at-limit', EXPECTED_BOUNDARY_BUDGETS.maxHumanBytes, 0, 'accepted');
    exactLimit('human-one-over', EXPECTED_BOUNDARY_BUDGETS.maxHumanBytes, 1, 'diagnostic-inconclusive');
    exactLimit('json-at-limit', EXPECTED_BOUNDARY_BUDGETS.maxJsonBytes, 0, 'accepted');
    exactLimit('json-one-over', EXPECTED_BOUNDARY_BUDGETS.maxJsonBytes, 1, 'diagnostic-inconclusive');
    check(scenarioByName.get('ordinary')?.['expectedDisposition'] === 'accepted' && scenarioByName.get('multibyte')?.['subject'] === 'utf8-text', issues, 'feedback-scenario-invalid', 'semantic-order');
    check(value['producerAttemptId'] === 'feedback-green' && isOid(value['head']) && isSha256(value['snapshotDigestSha256']) && isSha256(value['tokenSha256']) && value['overallVerdict'] === 'Pass', issues, 'feedback-measurement-invalid', 'identity');
  } else if (schema === 'DocsLineageReport') {
    const operations = requireRows(value['operations'], DOCS_LINEAGE_OPERATION_KEYS, issues, 'structured-record-shape', 'operations');
    const pathClasses = requireRows(value['pathClasses'], DOCS_LINEAGE_PATH_CLASS_KEYS, issues, 'structured-record-shape', 'pathClasses');
    if (requireExactRecord(value['anchors'], DOCS_LINEAGE_ANCHOR_KEYS, issues, 'structured-record-shape', 'anchors')) {
      check(Object.values(value['anchors']).every(isOid), issues, 'docs-lineage-anchor-invalid', 'anchors');
    }
    if (requireExactRecord(value['bEntryIdentity'], DOCS_B_ENTRY_IDENTITY_KEYS, issues, 'structured-record-shape', 'bEntryIdentity')) {
      check(Object.values(value['bEntryIdentity']).every(isSha256), issues, 'docs-lineage-identity-invalid', 'bEntryIdentity');
    }
    const operationIds = ['diff-check', 'status-short', 'validator-endpoints', 'validator-name-status', 'validator-stat', 'merge-origin', 'upstream-name-status', 'upstream-stat', 'authored-name-status', 'authored-stat'];
    check(operations.length === 10 && operations.every((row, index) => row['ordinal'] === index + 1 && row['operationId'] === operationIds[index] && Array.isArray(row['argv']) && row['argv'].every((entry) => typeof entry === 'string') && hasDirectStatus(row['rawExit'], row['rawSignal'], 0) && isSha256(row['stdoutSha256']) && isSha256(row['stderrSha256']) && isSortedUniqueStrings(row['parsedOids'], isOid) && isSortedUniqueStrings(row['parsedPaths'], isSafePath) && row['expectationMet'] === true && row['verdict'] === 'Pass'), issues, 'docs-lineage-operation-invalid', 'operations');
    check(pathClasses.every((row) => isSafePath(row['path']) && typeof row['status'] === 'string' && /^(?:[ACDMRTUXB]|R\d{1,3}|C\d{1,3})$/.test(row['status']) && ['validator', 'upstream', 'authored', 'b-delta'].includes(String(row['source']))), issues, 'docs-lineage-path-invalid', 'pathClasses');
    check(isOid(value['head']) && isSha256(value['snapshotDigestSha256']) && value['overallVerdict'] === 'Pass', issues, 'docs-lineage-identity-invalid', 'identity');
  } else if (schema === 'MergeConflictResolutionReport') {
    const stages = requireRows(value['indexStages'], MERGE_CONFLICT_INDEX_STAGE_KEYS, issues, 'structured-record-shape', 'indexStages');
    const expectedPaths = [...GENERATED_INDEX_PATHS];
    check(
      value['policy'] === 'regenerate-generated-work-index'
        && isOid(value['beforeHead']) && value['expectedSecondParent'] === BOUNDARY_PINNED_GENERATED_INDEX_PARENT
        && canonicalizeBoundaryRun(value['conflictPaths']) === canonicalizeBoundaryRun(expectedPaths)
        && canonicalizeBoundaryRun(value['resolvedPaths']) === canonicalizeBoundaryRun(expectedPaths)
        && canonicalizeBoundaryRun(value['generatorArgv']) === canonicalizeBoundaryRun(GENERATED_INDEX_ARGV),
      issues, 'merge-conflict-policy-mismatch', 'policy',
    );
    check(
      stages.length === 6 && expectedPaths.every((conflictPath, pathIndex) => [1, 2, 3].every((stage, stageIndex) => {
        const row = stages[pathIndex * 3 + stageIndex];
        return row?.['path'] === conflictPath && row['stage'] === stage && typeof row['mode'] === 'string'
          && /^[0-7]{6}$/.test(row['mode']) && isOid(row['oid']);
      })),
      issues, 'merge-conflict-stage-invalid', 'indexStages',
    );
    check(hasDirectStatus(value['generatorRawExit'], value['generatorRawSignal'], 0) && hasDirectStatus(value['diffCheckRawExit'], value['diffCheckRawSignal'], 0) && hasDirectStatus(value['workIndexGuardRawExit'], value['workIndexGuardRawSignal'], 0), issues, 'merge-conflict-status-invalid', 'status');
    check(Array.isArray(value['unmergedPaths']) && value['unmergedPaths'].length === 0 && Array.isArray(value['conflictMarkerPaths']) && value['conflictMarkerPaths'].length === 0, issues, 'merge-conflict-unresolved', 'unmergedPaths');
    check(isSha256(value['preStateDigestSha256']) && isSha256(value['resolvedStateDigestSha256']) && value['verdict'] === 'Pass', issues, 'merge-conflict-policy-mismatch', 'verdict');
  }
  return snapshotResult(issues);
}

export function parseBoundaryChildPins(
  profileId: string,
  entryHead: string,
  values: readonly string[],
): { result: BoundaryValidationResult; pins: BoundaryChildPinRecord[] | null } {
  const issues: BoundaryValidationIssue[] = [];
  const profile = RUN_CONTRACT_PROFILES[profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (profile === undefined || !isOid(entryHead)) {
    issues.push(issue('child-pin-profile-invalid', 'child pins require one known profile and exact entry head'));
    return { result: snapshotResult(issues), pins: null };
  }
  const expectedAliases = (profile.requiredChildren as readonly string[])
    .map((entry) => entry.split(':', 1)[0]!)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const pins: BoundaryChildPinRecord[] = [];
  for (const [index, value] of values.entries()) {
    const fields = value.split(',');
    if (fields.length !== 4) {
      issues.push(issue('child-pin-invalid', 'child pin must contain exactly alias,head,run-id,manifest-sha256', `values[${index}]`));
      continue;
    }
    const [alias, head, runId, manifestSha256] = fields as [string, string, string, string];
    const contract = RUN_CHILD_CONTRACTS[`${profileId}/${alias}` as keyof typeof RUN_CHILD_CONTRACTS];
    if (
      contract === undefined
      || !/^[a-z][a-z0-9-]{0,63}$/.test(alias)
      || !/^[a-z][a-z0-9-]{0,63}$/.test(runId)
      || !isOid(head)
      || !isSha256(manifestSha256)
    ) {
      issues.push(issue('child-pin-invalid', 'child pin identity violates the profile-owned contract', `values[${index}]`));
      continue;
    }
    if (contract.headRelation !== 'both-docs-entry' && head !== entryHead) {
      issues.push(issue('child-pin-head-mismatch', 'child pin head differs from the parent entry relation', `values[${index}]`));
    }
    pins.push({ alias, head, runId, manifestSha256 });
  }
  pins.sort((left, right) => Buffer.from(left.alias).compare(Buffer.from(right.alias)));
  const aliases = pins.map((entry) => entry.alias);
  if (
    canonicalizeBoundaryRun(aliases) !== canonicalizeBoundaryRun(expectedAliases)
    || new Set(aliases).size !== aliases.length
  ) {
    issues.push(issue('child-pin-set-mismatch', 'child pin aliases differ from the exact profile-required set'));
  }
  const runIds = pins.map((entry) => entry.runId);
  const manifestDigests = pins.map((entry) => entry.manifestSha256);
  if (new Set(runIds).size !== runIds.length || new Set(manifestDigests).size !== manifestDigests.length) {
    issues.push(issue('child-pin-identity-collision', 'direct child run IDs and manifest digests must be unique'));
  }
  return { result: snapshotResult(issues), pins: issues.length === 0 ? pins : null };
}


export function validateBoundaryImmutableClosure(input: Record<string, unknown>): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  let closureRoot: string;
  try {
    closureRoot = realpathSync(String(input['closureRoot']));
  } catch (error) {
    return snapshotResult([issue('immutable-root-invalid', (error as Error).message)]);
  }
  const closureFiles = requireRows(
    input['closureFiles'],
    IMPORTED_FILE_KEYS,
    issues,
    'immutable-file-shape',
    'closureFiles',
  );
  const paths = closureFiles.map((row) => row['path']);
  const sortedPaths = [...paths].sort((left, right) => Buffer.from(String(left)).compare(Buffer.from(String(right))));
  if (
    new Set(paths).size !== paths.length
    || paths.some((entry, index) => entry !== sortedPaths[index] || !isSafePath(entry))
  ) {
    issues.push(issue('immutable-file-shape', 'immutable closure paths must be safe, sorted, and unique'));
  }
  for (const row of closureFiles) {
    try {
      const current = capturePathRecord(closureRoot, String(row['path']));
      if (current.sha256 !== row['sha256'] || current.bytes !== row['bytes']) {
        issues.push(issue('immutable-file-drift', 'finalized closure file changed', String(row['path'])));
      }
    } catch (error) {
      issues.push(issue('immutable-file-drift', `finalized closure file is unavailable: ${(error as Error).message}`, String(row['path'])));
    }
  }
  const helper = input['helper'];
  if (!requireExactRecord(helper, IMPORTED_FILE_KEYS, issues, 'helper-hash-drift', 'helper')) {
    issues.push(issue('helper-hash-drift', 'helper identity row is malformed'));
  } else {
    try {
      const current = capturePathRecord(closureRoot, String(helper['path']));
      if (current.sha256 !== helper['sha256'] || current.bytes !== helper['bytes']) {
        issues.push(issue('helper-hash-drift', 'helper bytes differ from the finalized identity'));
      }
    } catch (error) {
      issues.push(issue('helper-hash-drift', (error as Error).message));
    }
  }
  const documents = requireRows(
    input['documents'],
    IMPORTED_FILE_KEYS,
    issues,
    'document-hash-drift',
    'documents',
  );
  for (const document of documents) {
    try {
      const current = capturePathRecord(closureRoot, String(document['path']));
      if (current.sha256 !== document['sha256'] || current.bytes !== document['bytes']) {
        issues.push(issue('document-hash-drift', 'document bytes differ from the finalized identity', String(document['path'])));
      }
    } catch (error) {
      issues.push(issue('document-hash-drift', (error as Error).message, String(document['path'])));
    }
  }
  const reservedRoots = input['reservedRoots'];
  if (!Array.isArray(reservedRoots)) {
    issues.push(issue('reserved-root-raced', 'reserved root roster is missing'));
  } else {
    for (const candidate of reservedRoots) {
      const reservation = candidate as BoundaryDerivedRootReservation;
      try {
        for (const ancestor of reservation.ancestors) {
          const stat = lstatSync(ancestor.path);
          if (
            stat.isSymbolicLink()
            || Number(stat.dev) !== ancestor.device
            || Number(stat.ino) !== ancestor.inode
          ) {
            issues.push(issue('reserved-root-raced', 'reserved root ancestor identity changed', ancestor.path));
          }
        }
        const parent = lstatSync(reservation.parentPath);
        if (
          Number(parent.dev) !== reservation.parentDevice
          || Number(parent.ino) !== reservation.parentInode
        ) {
          issues.push(issue('reserved-root-raced', 'reserved root parent identity changed', reservation.parentPath));
        }
      } catch (error) {
        issues.push(issue('reserved-root-raced', `reserved root ancestor is unavailable: ${(error as Error).message}`));
      }
    }
  }
  const snapshotResultValue = verifyBoundaryWorktreeSnapshot(
    String(input['repo']),
    input['snapshot'],
    input['declarations'] as BoundarySnapshotDeclarations,
  );
  if (!snapshotResultValue.ok) {
    issues.push(issue('closure-owner-drift', 'worktree or preserved-owner snapshot changed'));
  }
  if (
    input['currentRunId'] === input['retryRunId']
    || !isSafePath(input['retryRunId'])
    || !path.isAbsolute(String(input['retryDestination']))
  ) {
    issues.push(issue('retry-overwrite', 'retry must use a distinct canonical run ID and derived path'));
  }
  try {
    lstatSync(String(input['retryDestination']));
    issues.push(issue('retry-overwrite', 'retry destination already exists'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      issues.push(issue('retry-overwrite', (error as Error).message));
    }
  }
  return snapshotResult(issues);
}

export function validateBoundaryRun(value: unknown): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  if (!isRecord(value)) {
    issues.push(issue('invalid-root', 'boundary run manifest must be an object'));
  } else if (!hasExactKeys(value, ROOT_KEYS)) {
    issues.push(issue('invalid-root-keys', `boundary run manifest keys must be exactly: ${ROOT_KEYS.join(', ')}`));
  } else {
    requireExactObject(value, 'run', RUN_KEYS, issues);
    requireExactObject(value, 'entrySnapshot', SNAPSHOT_KEYS, issues);
    requireExactObject(value, 'currentSnapshot', SNAPSHOT_KEYS, issues);
    requireExactObject(value, 'entryTestRoster', ENTRY_TEST_ROSTER_KEYS, issues);
    requireExactObject(value, 'lifecycle', LIFECYCLE_KEYS, issues);
    requireExactObject(value, 'documentHashes', DOCUMENT_HASH_KEYS, issues);
    requireExactObject(value, 'upstream', UPSTREAM_KEYS, issues);

    validateSnapshotShape(value['entrySnapshot'], issues, 'entrySnapshot');
    validateSnapshotShape(value['currentSnapshot'], issues, 'currentSnapshot');

    const attemptRows = requireRows(value['attempts'], ATTEMPT_KEYS, issues, 'invalid-attempt-keys', 'attempts');
    for (const [index, attempt] of attemptRows.entries()) {
      validateSnapshotShape(attempt['preSnapshot'], issues, `attempts[${index}].preSnapshot`);
      validateSnapshotShape(attempt['postSnapshot'], issues, `attempts[${index}].postSnapshot`);
      requireExactRecord(attempt['stdout'], STREAM_KEYS, issues, 'invalid-stream-keys', `attempts[${index}].stdout`);
      requireExactRecord(attempt['stderr'], STREAM_KEYS, issues, 'invalid-stream-keys', `attempts[${index}].stderr`);
      if (attempt['structuredResult'] !== null) {
        requireExactRecord(
          attempt['structuredResult'],
          STREAM_KEYS,
          issues,
          'invalid-stream-keys',
          `attempts[${index}].structuredResult`,
        );
      }
      requireRows(
        attempt['outputAdmissions'],
        OUTPUT_ADMISSION_KEYS,
        issues,
        'invalid-output-admission-keys',
        `attempts[${index}].outputAdmissions`,
      );
    }

    requireRows(value['artifacts'], ARTIFACT_KEYS, issues, 'invalid-artifact-keys', 'artifacts');
    const childRows = requireRows(value['children'], CHILD_KEYS, issues, 'invalid-child-keys', 'children');
    for (const [index, child] of childRows.entries()) {
      validateImportedFiles(child['importedFiles'], issues, `children[${index}].importedFiles`);
    }

    if (value['predecessor'] !== null) {
      const predecessor = value['predecessor'];
      if (requireExactRecord(predecessor, PREDECESSOR_KEYS, issues, 'invalid-predecessor-keys', 'predecessor')) {
        requireExactRecord(
          predecessor['pin'],
          PREDECESSOR_PIN_KEYS,
          issues,
          'invalid-predecessor-pin-keys',
          'predecessor.pin',
        );
        validateImportedFiles(predecessor['importedFiles'], issues, 'predecessor.importedFiles');
      }
    }

    const runShape = value['run'];
    if (isRecord(runShape) && hasExactKeys(runShape, RUN_KEYS)) {
      requireRows(runShape['requiredChildPins'], CHILD_PIN_KEYS, issues, 'invalid-child-pin-keys', 'run.requiredChildPins');
      requireRows(runShape['observedTools'], TOOL_KEYS, issues, 'invalid-tool-keys', 'run.observedTools');
      requireRows(
        runShape['reservedDerivedRoots'],
        RESERVED_DERIVED_ROOT_KEYS,
        issues,
        'invalid-reserved-derived-root-keys',
        'run.reservedDerivedRoots',
      );
    }

    const roster = value['entryTestRoster'];
    if (isRecord(roster) && hasExactKeys(roster, ENTRY_TEST_ROSTER_KEYS)) {
      requireRows(roster['files'], TEST_ROSTER_FILE_KEYS, issues, 'invalid-test-roster-file-keys', 'entryTestRoster.files');
    }

    const reviewRows = requireRows(value['reviews'], REVIEW_KEYS, issues, 'invalid-review-keys', 'reviews');
    for (const [index, review] of reviewRows.entries()) {
      requireRows(review['findings'], FINDING_KEYS, issues, 'invalid-finding-keys', `reviews[${index}].findings`);
      requireRows(
        review['reproductionContracts'],
        REPRODUCTION_CONTRACT_KEYS,
        issues,
        'invalid-reproduction-contract-keys',
        `reviews[${index}].reproductionContracts`,
      );
    }

    const documentHashes = value['documentHashes'];
    if (isRecord(documentHashes) && hasExactKeys(documentHashes, DOCUMENT_HASH_KEYS)) {
      for (const key of DOCUMENT_HASH_KEYS) {
        requireExactRecord(
          documentHashes[key],
          DOCUMENT_HASH_ROW_KEYS,
          issues,
          'invalid-document-hash-keys',
          `documentHashes.${key}`,
        );
      }
    }

    check(value['schemaVersion'] === BOUNDARY_RUN_SCHEMA, issues, 'invalid-schema-version', 'schemaVersion');
    check(
      value['manifestState'] === 'active'
        || value['manifestState'] === 'finalized'
        || value['manifestState'] === 'verified-pass-closeout-rejected',
      issues,
      'invalid-manifest-state',
      'manifestState',
    );

    const run = value['run'];
    if (isRecord(run) && hasExactKeys(run, RUN_KEYS)) {
      check(isTimestamp(run['createdAtUtc']), issues, 'invalid-created-at', 'run.createdAtUtc');
      check(run['terminalHead'] === null || isOid(run['terminalHead']), issues, 'invalid-terminal-head', 'run.terminalHead');
      check(run['transitionCount'] === 0 || run['transitionCount'] === 1, issues, 'invalid-transition-count', 'run.transitionCount');
      const childAliases = run['requiredChildAliases'];
      const childPins = run['requiredChildPins'];
      check(Array.isArray(childAliases), issues, 'invalid-child-aliases', 'run.requiredChildAliases');
      check(Array.isArray(childPins), issues, 'invalid-child-pins', 'run.requiredChildPins');
      if (Array.isArray(childAliases) && Array.isArray(childPins)) {
        const pinAliases = childPins.map((entry) => isRecord(entry) ? entry['alias'] : null);
        check(
          canonicalizeBoundaryRun(childAliases) === canonicalizeBoundaryRun(pinAliases),
          issues,
          'child-pin-alias-mismatch',
          'run.requiredChildPins',
        );
        for (const [index, pin] of childPins.entries()) {
          check(
            isRecord(pin)
              && typeof pin['alias'] === 'string'
              && /^[a-z][a-z0-9-]{0,63}$/.test(pin['alias'])
              && typeof pin['runId'] === 'string'
              && /^[a-z][a-z0-9-]{0,63}$/.test(pin['runId'])
              && isOid(pin['head'])
              && isSha256(pin['manifestSha256']),
            issues,
            'invalid-child-pin',
            `run.requiredChildPins[${index}]`,
          );
        }
      }
      const roots = run['reservedDerivedRoots'];
      check(Array.isArray(roots), issues, 'invalid-derived-roots', 'run.reservedDerivedRoots');
      if (Array.isArray(roots)) {
        for (const [index, root] of roots.entries()) {
          check(
            isRecord(root) && Number.isSafeInteger(root['parentDevice']) && Number(root['parentDevice']) > 0,
            issues,
            'invalid-parent-device',
            `run.reservedDerivedRoots[${index}].parentDevice`,
          );
        }
      }
    }

    const snapshot = value['entrySnapshot'];
    if (isRecord(snapshot) && hasExactKeys(snapshot, SNAPSHOT_KEYS)) {
      check(isSha256(snapshot['digestSha256']), issues, 'invalid-snapshot-digest', 'entrySnapshot.digestSha256');
      const rows = snapshot['allowedUntracked'];
      check(Array.isArray(rows), issues, 'invalid-allowed-untracked', 'entrySnapshot.allowedUntracked');
      if (Array.isArray(rows)) {
        for (const [index, row] of rows.entries()) {
          check(
            isRecord(row) && isSafePath(row['path']),
            issues,
            'invalid-snapshot-path',
            `entrySnapshot.allowedUntracked[${index}].path`,
          );
        }
      }
    }

    const lifecycle = value['lifecycle'];
    if (isRecord(lifecycle) && hasExactKeys(lifecycle, LIFECYCLE_KEYS)) {
      check(lifecycle['branchDeletionAuthorized'] === false, issues, 'invalid-deletion-authority', 'lifecycle.branchDeletionAuthorized');
    }

    const upstream = value['upstream'];
    if (isRecord(upstream) && hasExactKeys(upstream, UPSTREAM_KEYS)) {
      check(
        upstream['observedOid'] === 'not-observed' || isOid(upstream['observedOid']),
        issues,
        'invalid-upstream-oid',
        'upstream.observedOid',
      );
    }
  }
  return {
    ok: issues.length === 0,
    exitCode: issues.length === 0 ? 0 : 1,
    verdict: issues.length === 0 ? 'Pass' : 'Inconclusive',
    issues,
  };
}

class BoundaryJsonSyntaxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function preflightBoundaryJson(text: string): void {
  let index = 0;
  const fail = (code: string, message: string): never => {
    throw new BoundaryJsonSyntaxError(code, message);
  };
  const skipWhitespace = (): void => {
    while (index < text.length && /[\t\n ]/.test(text[index]!)) index += 1;
  };
  const parseString = (): string => {
    if (text[index] !== '"') fail('invalid-json', `expected string at byte ${index}`);
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index]!;
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch (error) {
          fail('invalid-json', (error as Error).message);
        }
      } else if (char.charCodeAt(0) < 0x20) {
        fail('invalid-json', `unescaped control byte in string at byte ${index - 1}`);
      }
    }
    return fail('invalid-json', 'unterminated JSON string');
  };
  const parseNumber = (): void => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    const token = match?.[0];
    if (token === undefined) {
      throw new BoundaryJsonSyntaxError('invalid-json', `invalid number at byte ${index}`);
    }
    if (token === '-0') fail('invalid-json-number', 'negative zero is not canonical');
    index += token.length;
  };
  const parseLiteral = (literal: string): void => {
    if (!text.startsWith(literal, index)) fail('invalid-json', `invalid token at byte ${index}`);
    index += literal.length;
  };
  const parseValue = (): void => {
    skipWhitespace();
    const char = text[index];
    if (char === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      while (index < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail('duplicate-json-key', `duplicate JSON key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ':') fail('invalid-json', `expected colon at byte ${index}`);
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return;
        }
        if (text[index] !== ',') fail('invalid-json', `expected comma at byte ${index}`);
        index += 1;
      }
      fail('invalid-json', 'unterminated JSON object');
    }
    if (char === '[') {
      index += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return;
        }
        if (text[index] !== ',') fail('invalid-json', `expected comma at byte ${index}`);
        index += 1;
      }
      fail('invalid-json', 'unterminated JSON array');
    }
    if (char === '"') {
      parseString();
      return;
    }
    if (char === '-' || (char !== undefined && /\d/.test(char))) {
      parseNumber();
      return;
    }
    if (char === 't') return parseLiteral('true');
    if (char === 'f') return parseLiteral('false');
    if (char === 'n') return parseLiteral('null');
    fail('invalid-json', `invalid value at byte ${index}`);
  };

  parseValue();
  skipWhitespace();
  if (index !== text.length) fail('invalid-json', `trailing JSON bytes at byte ${index}`);
}

export function parseBoundaryJsonBytes(bytes: Uint8Array): {
  result: BoundaryValidationResult;
  value: unknown | null;
  text: string | null;
} {
  let text: string;
  let value: unknown;
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new BoundaryJsonSyntaxError('invalid-json-byte', 'UTF-8 BOM bytes are forbidden');
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.startsWith('\ufeff') || text.includes('\r')) {
      throw new BoundaryJsonSyntaxError('invalid-json-byte', 'BOM and CR bytes are forbidden');
    }
    preflightBoundaryJson(text);
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const code = error instanceof BoundaryJsonSyntaxError ? error.code : 'invalid-json';
    return {
      result: {
        ok: false,
        exitCode: 1,
        verdict: 'Inconclusive',
        issues: [issue(code, `boundary JSON is invalid: ${(error as Error).message}`)],
      },
      value: null,
      text: null,
    };
  }

  return { result: snapshotResult([]), value, text };
}

export function validateBoundaryRunJson(bytes: Uint8Array): BoundaryValidationResult {
  const parsed = parseBoundaryJsonBytes(bytes);
  if (!parsed.result.ok || parsed.text === null) return parsed.result;

  if (parsed.text !== canonicalizeBoundaryRun(parsed.value)) {
    return {
      ok: false,
      exitCode: 1,
      verdict: 'Inconclusive',
      issues: [issue('noncanonical-json', 'boundary run JSON bytes are not canonical')],
    };
  }
  return validateBoundaryRun(parsed.value);
}
