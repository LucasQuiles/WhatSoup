import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateOutcomes,
  buildFindingFingerprint,
  canonicalizeControlResult,
  controlResultEvidenceDigest,
  exitCodeForOutcome,
  hashControlResult,
  parseControlResultJson,
  renderControlResult,
  serializeControlResult,
  validateControlResult,
  type ControlOutcome,
  type ControlValidationOptions,
  type WarningEscalationTransitionV1,
} from '../../scripts/lib/ci-control/result.ts';
import * as resultApi from '../../scripts/lib/ci-control/result.ts';
import {
  FileAttemptEvidenceStore,
  supervisorCloseDigest,
  supervisorProcessLeaseDigest,
  supervisorTerminalDigest,
  terminalAttemptDigest,
  transitionAttempt,
  validateTerminalAttempt,
  writeTerminalAttempt,
  type SupervisorCloseV1,
  type SupervisorLeaseExpectationsV1,
  type SupervisorProcessLeaseV1,
  type SupervisorTerminalV1,
  type TerminalAttemptV1,
} from '../../scripts/lib/ci-control/attempt.ts';
import {
  preconditionDigest,
  validatePreconditionReceipt,
  type PreconditionExpectationsV1,
  type PreconditionReceiptV1,
} from '../../scripts/lib/ci-control/preconditions.ts';
import {
  adaptBoundaryRun,
  adaptPublicationExactRangeReportOnly,
  adaptRepoHygieneExactRangeReportOnly,
  adaptSemanticQuality,
  type NativeExactRangeReportOnlyObservationV1,
} from '../../scripts/lib/ci-control/native-adapter.ts';
import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  createRepoHygieneExactRangeArtifact,
  currentRepoHygienePolicyDigest,
  currentRepoHygieneToolDigest,
  validateRepoHygieneExactRangeArtifact,
  type RepoHygieneExactRangeArtifactV1,
  type RepoHygieneExactRangeExpectedV1,
} from '../../scripts/repo-hygiene-guard.ts';
import {
  createPublicationExactRangeArtifact,
  currentPublicationPolicyDigest,
  currentPublicationToolDigest,
  validatePublicationExactRangeArtifact,
  type PublicationExactRangeArtifactV1,
  type PublicationExactRangeExpectedV1,
} from '../../scripts/publication-guard.ts';
import { buildBoundaryReceipt } from '../../scripts/lib/semantic-quality/receipt.ts';
import { canonicalizeBoundaryRun } from '../../scripts/lib/verification/boundary-run/shared.ts';
import { OID as BOUNDARY_OID, validManifest } from './verify-boundary-run/support.ts';

const OID = '0123456789abcdef0123456789abcdef01234567';
const BASE_OID = '89abcdef89abcdef89abcdef89abcdef89abcdef';
const MERGE_OID = 'fedcba98fedcba98fedcba98fedcba98fedcba98';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = Date.parse('2026-07-21T08:00:00.000Z');
const PRECONDITION_AT = new Date(NOW - 10 * 60_000).toISOString();
const ATTEMPT_CREATED_AT = new Date(NOW - 9 * 60_000).toISOString();
const ATTEMPT_TERMINAL_AT = new Date(NOW - 8 * 60_000).toISOString();
const ATTEMPT_LEASE_AT = new Date(NOW - 8.75 * 60_000).toISOString();
const SUPERVISOR_TERMINAL_AT = new Date(NOW - 8.25 * 60_000).toISOString();
const RESULT_CREATED_AT = new Date(NOW - 7 * 60_000).toISOString();
const VALID_UNTIL = new Date(NOW + 60 * 60_000).toISOString();
const WARNING_GOVERNANCE = {
  owner: 'semantic-quality-decision-owner',
  remediationSlaHours: 8,
  expiresAfterHours: 12,
  escalationCondition: 'The native semantic warning remains unresolved when its protected validity interval expires.',
  successorCode: 'quality.semantic.warning.expired',
  firstObservedAt: RESULT_CREATED_AT,
  remediationDueAt: new Date(Date.parse(RESULT_CREATED_AT) + 8 * 60 * 60_000).toISOString(),
  expiresAt: new Date(Date.parse(RESULT_CREATED_AT) + 12 * 60 * 60_000).toISOString(),
};
const PRODUCER = {
  appId: 'expected-app',
  workflowRef: 'owner/repo/.github/workflows/policy.yml@refs/heads/main',
  workflowSha: OID,
  runId: 'run-1',
  attempt: 1,
};
const SEMANTIC_NATIVE_EVIDENCE = {
  detectorId: 'semantic-quality', schemaVersion: 1, evidenceDigest: DIGEST,
  nativeCauseCodes: ['semantic.synthetic-finding'],
  policyDigest: DIGEST,
  producer: PRODUCER,
  platform: { os: 'linux', architecture: 'x64' },
};
const PROTECTED_POLICY_PRODUCER = {
  appId: 'protected-policy-app',
  workflowRef: 'owner/protected/.github/workflows/policy.yml@refs/heads/main',
  workflowSha: BASE_OID,
  runId: 'protected-run-1',
  attempt: 1,
};
const SCANNER_POLICY_RECEIPT = {
  schemaVersion: 1,
  policyDigest: DIGEST,
  sourceOid: BASE_OID,
  toolDigest: DIGEST,
  sources: [
    { path: 'scripts/lib/guard-core.ts', blobOid: BASE_OID },
    { path: 'scripts/publication-guard.ts', blobOid: OID },
  ],
  producer: PROTECTED_POLICY_PRODUCER,
};

const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function gitFixture(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function exactRangeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-native-exact-range-'));
  temporaryRoots.push(root);
  gitFixture(root, ['init', '-b', 'main']);
  gitFixture(root, ['config', 'user.name', 'Native Adapter Fixture']);
  gitFixture(root, ['config', 'user.email', 'native-adapter@users.noreply.github.com']);
  gitFixture(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(root, 'note.txt'), 'safe baseline\n');
  gitFixture(root, ['add', 'note.txt']);
  gitFixture(root, ['commit', '-m', 'test: exact range base']);
  const baseOid = gitFixture(root, ['rev-parse', 'HEAD']);

  const privateLiteral = ['ghp', 'RealLookingToken1234567890'].join('_');
  writeFileSync(path.join(root, 'note.txt'), `${privateLiteral}\n`);
  gitFixture(root, ['commit', '-am', 'test: unsafe outgoing object']);
  const unsafeOid = gitFixture(root, ['rev-parse', 'HEAD']);

  gitFixture(root, ['checkout', '-b', 'safe-ambient', baseOid]);
  writeFileSync(path.join(root, 'note.txt'), 'safe outgoing content\n');
  gitFixture(root, ['commit', '-am', 'test: safe ambient head']);
  const safeOid = gitFixture(root, ['rev-parse', 'HEAD']);

  const repoBlock = createRepoHygieneExactRangeArtifact(root, { baseOid, remoteOid: null, localOid: unsafeOid });
  const publicationBlock = createPublicationExactRangeArtifact(root, { baseOid, remoteOid: null, localOid: unsafeOid });
  const repoPass = createRepoHygieneExactRangeArtifact(root, { baseOid, remoteOid: null, localOid: safeOid });
  const publicationPass = createPublicationExactRangeArtifact(root, { baseOid, remoteOid: null, localOid: safeOid });
  expect(repoBlock.ok).toBe(true);
  expect(publicationBlock.ok).toBe(true);
  expect(repoPass.ok).toBe(true);
  expect(publicationPass.ok).toBe(true);
  if (!repoBlock.ok || !publicationBlock.ok || !repoPass.ok || !publicationPass.ok) throw new Error('native exact-range fixture failed');

  const repoExpected = (artifact: RepoHygieneExactRangeArtifactV1, localOid: string): RepoHygieneExactRangeExpectedV1 => ({
    baseOid,
    remoteOid: null,
    localOid,
    currentToolDigest: currentRepoHygieneToolDigest(),
    currentPolicyDigest: currentRepoHygienePolicyDigest(),
    expectedPayloadByteLength: artifact.binding.payloadByteLength,
    expectedPayloadSha256: artifact.binding.payloadSha256,
  });
  const publicationExpected = (artifact: PublicationExactRangeArtifactV1, localOid: string): PublicationExactRangeExpectedV1 => ({
    baseOid,
    remoteOid: null,
    localOid,
    currentToolDigest: currentPublicationToolDigest(),
    currentPolicyDigest: currentPublicationPolicyDigest(),
    expectedPayloadByteLength: artifact.binding.payloadByteLength,
    expectedPayloadSha256: artifact.binding.payloadSha256,
  });
  return {
    baseOid,
    unsafeOid,
    safeOid,
    repoBlock: repoBlock.artifact,
    publicationBlock: publicationBlock.artifact,
    repoPass: repoPass.artifact,
    publicationPass: publicationPass.artifact,
    repoExpected,
    publicationExpected,
  };
}

function reboundRepoArtifact(
  artifact: RepoHygieneExactRangeArtifactV1,
  mutate: (payload: Record<string, unknown>) => void,
): RepoHygieneExactRangeArtifactV1 {
  const payload = JSON.parse(Buffer.from(artifact.payloadBytes).toString('utf8')) as Record<string, unknown>;
  mutate(payload);
  const payloadBytes = Uint8Array.from(Buffer.from(canonicalizeBoundaryRun(payload), 'utf8'));
  return {
    payloadBytes,
    binding: {
      schemaVersion: 1,
      detectorId: 'repo-hygiene-guard',
      payloadByteLength: payloadBytes.byteLength,
      payloadSha256: `sha256:${createHash('sha256').update(payloadBytes).digest('hex')}`,
    },
  };
}

function processStart(startTicks: string) {
  return { source: 'linux-proc-stat' as const, bootId: 'synthetic-boot', startTicks };
}

function supervisorLease(attemptId = 'attempt-1'): SupervisorProcessLeaseV1 {
  return {
    schemaVersion: 1,
    attemptId,
    leaseId: 'lease-1',
    issuedAt: ATTEMPT_LEASE_AT,
    validUntil: VALID_UNTIL,
    challengeDigest: DIGEST,
    supervisorToolDigest: DIGEST,
    identityProbeDigest: DIGEST,
    closeObserverDigest: DIGEST,
    supervisor: { pid: 200, ppid: 100, pgid: 100, sid: 100, start: processStart('2000') },
    anchor: { pid: 300, ppid: 200, pgid: 300, sid: 300, start: processStart('3000') },
    target: { pid: 301, ppid: 300, pgid: 300, sid: 300, start: processStart('3001') },
    commandDigest: DIGEST,
    cwdDigest: DIGEST,
    environmentDigest: DIGEST,
  };
}

function leaseExpectations(attemptId = 'attempt-1'): SupervisorLeaseExpectationsV1 {
  return {
    attemptId,
    callerPid: 100,
    supervisorPid: 200,
    challengeDigest: DIGEST,
    supervisorToolDigest: DIGEST,
    identityProbeDigest: DIGEST,
    closeObserverDigest: DIGEST,
    commandDigest: DIGEST,
    cwdDigest: DIGEST,
    environmentDigest: DIGEST,
  };
}

function supervisorTerminal(lease: SupervisorProcessLeaseV1, lifecycle: TerminalAttemptV1['lifecycle'], expectedExitCode: number): SupervisorTerminalV1 {
  return {
    schemaVersion: 1,
    attemptId: lease.attemptId,
    leaseDigest: supervisorProcessLeaseDigest(lease),
    terminalAt: SUPERVISOR_TERMINAL_AT,
    targetStatus: {
      rawExit: lifecycle === 'terminal' ? expectedExitCode : null,
      rawSignal: lifecycle === 'terminal' ? null : 'SIGTERM',
      timedOut: lifecycle === 'timed-out',
    },
    anchorStatus: { rawExit: 0, rawSignal: null },
    finalGroup: {
      status: 'empty',
      observedAt: SUPERVISOR_TERMINAL_AT,
      leaseDigest: supervisorProcessLeaseDigest(lease),
      identityProbeDigest: lease.identityProbeDigest,
      lastMatchedSnapshot: { supervisor: lease.supervisor, anchor: lease.anchor, target: lease.target },
      members: [],
    },
  };
}

function supervisorClose(lease: SupervisorProcessLeaseV1): SupervisorCloseV1 {
  return {
    schemaVersion: 1,
    attemptId: lease.attemptId,
    leaseDigest: supervisorProcessLeaseDigest(lease),
    supervisorPid: lease.supervisor.pid,
    rawExit: 0,
    rawSignal: null,
    observerDigest: lease.closeObserverDigest,
    closedAt: ATTEMPT_TERMINAL_AT,
  };
}

function makePreconditions(overrides: Record<string, unknown> = {}): PreconditionReceiptV1 {
  return {
    schemaVersion: 1,
    outcome: 'pass',
    runtime: { name: 'node', version: '24.15.0', digest: DIGEST },
    packageManager: { name: 'npm', version: '11.6.2', digest: DIGEST },
    wrapperDigest: DIGEST,
    installScopes: ['root'],
    workspace: {
      worktree: 'clean', index: 'clean', headOid: OID, baseOid: BASE_OID,
      candidateOid: OID, mergeOid: MERGE_OID, digest: DIGEST,
    },
    host: { os: 'linux', architecture: 'x64', capabilities: ['case-sensitive'], digest: DIGEST },
    hook: { installed: true, path: '.husky/pre-push', digest: DIGEST },
    fixture: { created: true, digest: DIGEST },
    serviceSubstitutes: ['fake-keyring'],
    testSelectionDigest: DIGEST,
    createdAt: PRECONDITION_AT,
    ...overrides,
  } as PreconditionReceiptV1;
}

function expectedPreconditions(receipt = makePreconditions()): PreconditionExpectationsV1 {
  const { outcome: _outcome, createdAt: _createdAt, ...expected } = receipt;
  return expected;
}

function validationOptions(overrides: Record<string, unknown> = {}): ControlValidationOptions & { expectedLease: SupervisorLeaseExpectationsV1 } {
  return {
    now: NOW,
    expectedPreconditions: expectedPreconditions(),
    expectedLease: leaseExpectations(),
    expectedBindings: {
      candidateOid: OID, baseOid: BASE_OID, mergeOid: MERGE_OID,
      manifestDigest: DIGEST, policyDigest: DIGEST, classifierDigest: DIGEST,
      producer: PRODUCER, toolDigest: DIGEST,
    },
    expectedScope: { kind: 'control-surface', digest: DIGEST, itemCount: 1 },
    expectedFindingGraph: [{ findingId: 'finding-1', rootCauseId: 'finding-1', causedBy: [], candidateOid: OID, policyDigest: DIGEST }],
    expectedWarningGovernance: WARNING_GOVERNANCE,
    expectedWarningTransition: null,
    expectedNativeEvidence: SEMANTIC_NATIVE_EVIDENCE,
    expectedScannerPolicyReceipt: SCANNER_POLICY_RECEIPT,
    ...overrides,
  } as ControlValidationOptions & { expectedLease: SupervisorLeaseExpectationsV1 };
}

function noNativeValidationOptions(overrides: Record<string, unknown> = {}): ControlValidationOptions & { expectedLease: SupervisorLeaseExpectationsV1 } {
  return validationOptions({ expectedNativeEvidence: null, ...overrides });
}

function publicOutputOptions(forbiddenValues: readonly string[] = []) {
  return {
    ...validationOptions(),
    forbiddenValues,
    expectedScannerPolicyReceipt: SCANNER_POLICY_RECEIPT,
  };
}

function noNativePublicOutputOptions(forbiddenValues: readonly string[] = []) {
  return {
    ...noNativeValidationOptions(),
    forbiddenValues,
    expectedScannerPolicyReceipt: SCANNER_POLICY_RECEIPT,
  };
}

async function makeAdmittedResult(
  overrides: Record<string, unknown> = {},
  lifecycle: 'terminal' | 'cancelled' | 'timed-out' | 'corrupt' = 'terminal',
  terminalExitOverride?: number,
) {
  const { attempt: _callerAttempt, attemptDigest: _callerAttemptDigest, ...seedOverrides } = overrides;
  const seed = makeResult(seedOverrides);
  const root = await mkdtemp(path.join(tmpdir(), 'ci-control-attempt-store-'));
  temporaryRoots.push(root);
  const store = new FileAttemptEvidenceStore(root);
  store.beginAttempt('attempt-1', ATTEMPT_CREATED_AT);
  const lease = supervisorLease();
  const expectedLease = leaseExpectations();
  const leaseDigest = store.writeSupervisorLease(lease, expectedLease, { now: NOW });
  const terminal = supervisorTerminal(lease, lifecycle, terminalExitOverride ?? Number(seed.exitCode));
  const supervisorTerminalReceiptDigest = store.writeSupervisorTerminal(terminal, leaseDigest, { now: NOW, expectedLease });
  const close = supervisorClose(lease);
  const finalized = store.writeSupervisorClose(close, leaseDigest, supervisorTerminalReceiptDigest, lifecycle, { now: NOW, expectedLease });
  const attempt = makeAttempt({
    lifecycle,
    terminalAt: close.closedAt,
    rawExit: terminal.targetStatus.rawExit,
    rawSignal: terminal.targetStatus.rawSignal,
    timedOut: terminal.targetStatus.timedOut,
    terminationProof: {
      schemaVersion: 1,
      leaseDigest,
      supervisorTerminalDigest: supervisorTerminalReceiptDigest,
      supervisorCloseDigest: finalized.supervisorCloseDigest,
      supervisorDigest: lease.supervisorToolDigest,
      observedAt: close.closedAt,
      status: 'reaped',
    },
    evidenceBinding: (seed.attempt as { evidenceBinding: object }).evidenceBinding,
    historySequence: 4,
    historyEntryDigest: finalized.historyEntryDigest,
  });
  const attemptDigest = writeTerminalAttempt(store.terminalPath(attempt.id), attempt, {
    store,
    leaseDigest,
    supervisorTerminalDigest: supervisorTerminalReceiptDigest,
    supervisorCloseDigest: finalized.supervisorCloseDigest,
    expectedLease,
    now: NOW,
  });
  return { root, store, expectedLease, result: makeResult({ ...overrides, attempt, attemptDigest, createdAt: RESULT_CREATED_AT }) };
}

async function newEvidenceStore(): Promise<FileAttemptEvidenceStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'ci-control-attempt-store-'));
  temporaryRoots.push(root);
  return new FileAttemptEvidenceStore(root);
}

function makeAttempt(overrides: Record<string, unknown> = {}): TerminalAttemptV1 {
  const producer = PRODUCER;
  return {
    schemaVersion: 1,
    id: 'attempt-1',
    lifecycle: 'terminal',
    createdAt: ATTEMPT_CREATED_AT,
    terminalAt: ATTEMPT_TERMINAL_AT,
    rawExit: 0,
    rawSignal: null,
    timedOut: false,
    terminationProof: {
      schemaVersion: 1,
      leaseDigest: DIGEST,
      supervisorTerminalDigest: DIGEST,
      supervisorCloseDigest: DIGEST,
      supervisorDigest: DIGEST,
      observedAt: ATTEMPT_TERMINAL_AT,
      status: 'reaped',
    },
    evidenceBinding: {
      controlId: 'semantic-quality',
      candidateOid: OID,
      manifestDigest: DIGEST,
      policyDigest: DIGEST,
      toolDigest: DIGEST,
      platformDigest: digest(canonicalizeBoundaryRun({ runnerLabel: 'ubuntu-24.04', os: 'linux', architecture: 'x64', runtime: 'node@24.15.0', observedCapabilitiesDigest: DIGEST })),
      preconditionDigest: preconditionDigest(makePreconditions(), {
        now: NOW,
        expected: expectedPreconditions(),
      }),
      producerDigest: digest(canonicalizeBoundaryRun(producer)),
      scannerPolicyReceiptDigest: digest(canonicalizeBoundaryRun(SCANNER_POLICY_RECEIPT)),
      resultEvidenceDigest: DIGEST,
    },
    historySequence: 4,
    historyEntryDigest: DIGEST,
    ...overrides,
  } as TerminalAttemptV1;
}

function requiredCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 'semantic-quality',
    expectedProducer: PRODUCER,
    expectedPlatform: { os: 'linux', architecture: 'x64' },
    candidateOid: OID,
    mergeOid: MERGE_OID,
    policyDigest: DIGEST,
    ...overrides,
  };
}

function observedCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 'semantic-quality',
    applicability: 'required',
    applicabilityReason: null,
    outcome: 'pass',
    causeCode: 'ci.check.passed',
    expectedProducer: PRODUCER,
    expectedPlatform: { os: 'linux', architecture: 'x64' },
    producer: PRODUCER,
    observedPlatform: { os: 'linux', architecture: 'x64' },
    classifierProof: null,
    nativeCauseCodes: [],
    nativeCauseCompleteness: 'complete',
    nativeStatusRefs: [],
    limitationCodes: [],
    candidateOid: OID,
    mergeOid: MERGE_OID,
    policyDigest: DIGEST,
    nativeSchemaVersion: 1,
    evidenceDigest: DIGEST,
    createdAt: RESULT_CREATED_AT,
    validUntil: VALID_UNTIL,
    ...overrides,
  };
}

function classifierProof(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    reason: 'ci.classification.not-applicable',
    candidateOid: OID,
    mergeOid: MERGE_OID,
    policyDigest: DIGEST,
    classifierDigest: DIGEST,
    producer: PRODUCER,
    createdAt: RESULT_CREATED_AT,
    validUntil: VALID_UNTIL,
    ...overrides,
  };
}

function makeResult(overrides: Record<string, unknown> = {}) {
  const {
    __attemptId = 'attempt-1',
    __attemptCreatedAt = ATTEMPT_CREATED_AT,
    __attemptTerminalAt = ATTEMPT_TERMINAL_AT,
    ...resultOverrides
  } = overrides;
  const result = {
    schemaVersion: 1,
    outcome: 'pass',
    aggregateDecision: null,
    exitCode: 0,
    code: 'ci.check.passed',
    controlId: 'semantic-quality',
    owner: 'ci-policy-owner',
    canonicalImplementationOwner: 'scripts/lib/ci-control/result.ts',
    domain: 'semantic-quality',
    stage: 'pull-request',
    eventName: 'pull_request',
    operation: 'validate-native-result',
    trustClass: 'reviewed-source',
    severity: 'info',
    confidence: 'proven',
    evidenceState: 'proven',
    surface: 'semantic-quality',
    applicability: 'required',
    applicabilityReason: null,
    candidateOid: OID,
    baseOid: BASE_OID,
    mergeOid: MERGE_OID,
    manifestDigest: DIGEST,
    policyDigest: DIGEST,
    classifierDigest: DIGEST,
    classifierProof: null,
    producer: PRODUCER,
    tool: { name: 'ci-control-plane', version: '1', digest: DIGEST },
    platform: { runnerLabel: 'ubuntu-24.04', os: 'linux', architecture: 'x64', runtime: 'node@24.15.0', observedCapabilitiesDigest: DIGEST },
    scannerPolicyReceipt: SCANNER_POLICY_RECEIPT,
    nativeEvidence: SEMANTIC_NATIVE_EVIDENCE,
    warningGovernance: null,
    warningTransition: null,
    preconditionReceipt: makePreconditions(),
    attempt: makeAttempt(),
    attemptDigest: terminalAttemptDigest(makeAttempt() as never),
    risk: { tier: 'standard', reasons: ['source-change'] },
    requiredChecks: [],
    observedChecks: [],
    findingId: null,
    rootCauseId: null,
    causedBy: [],
    relatedFindingIds: [],
    supersedes: [],
    location: null,
    why: null,
    impact: null,
    guidance: [],
    patchScope: { allowed: [], prohibited: [] },
    allowedPatchScope: [],
    prohibitedChanges: [],
    doNot: [],
    reproduce: { command: 'npm run verify:pr', preconditions: [] },
    verify: { commands: [], expected: [] },
    retryable: false,
    retryConditions: [],
    retryClass: 'never',
    remediationClass: 'source-patch',
    nextBestAction: null,
    exception: { eligible: false, approvalRole: null },
    relatedFindings: [],
    claimedScope: { kind: 'control-surface', digest: DIGEST, itemCount: 1 },
    observedScope: { kind: 'control-surface', digest: DIGEST, itemCount: 1 },
    scopeLimitations: [],
    verificationPlan: [],
    closureCriteria: [],
    sensitiveFieldsOmitted: [],
    publicEvidenceRefs: [],
    privateEvidenceRefs: [],
    fingerprint: null as string | null,
    limitations: [],
    createdAt: RESULT_CREATED_AT,
    validUntil: VALID_UNTIL,
    ...resultOverrides,
  };
  if (resultOverrides.fingerprint === undefined && result.findingId !== null) result.fingerprint = buildFindingFingerprint(result as never);
  if (resultOverrides.attempt === undefined) {
    result.attempt = makeAttempt({
      id: String(__attemptId),
      createdAt: String(__attemptCreatedAt),
      terminalAt: String(__attemptTerminalAt),
      terminationProof: {
        ...makeAttempt().terminationProof,
        observedAt: String(__attemptTerminalAt),
      },
      rawExit: result.exitCode,
      evidenceBinding: {
        controlId: result.controlId,
        candidateOid: result.candidateOid,
        manifestDigest: result.manifestDigest,
        policyDigest: result.policyDigest,
        toolDigest: (result.tool as { digest: string }).digest,
        platformDigest: digest(canonicalizeBoundaryRun(result.platform)),
        preconditionDigest: preconditionDigest(result.preconditionReceipt as never, {
          now: NOW,
          expected: expectedPreconditions(result.preconditionReceipt as PreconditionReceiptV1),
        }),
        producerDigest: digest(canonicalizeBoundaryRun(result.producer)),
        scannerPolicyReceiptDigest: digest(canonicalizeBoundaryRun(result.scannerPolicyReceipt)),
        resultEvidenceDigest: controlResultEvidenceDigest(result),
      },
    });
  }
  if (resultOverrides.attemptDigest === undefined) result.attemptDigest = terminalAttemptDigest(result.attempt as never);
  return result;
}

function makeDiagnostic(outcome: 'warn' | 'block' | 'inconclusive', overrides: Record<string, unknown> = {}) {
  const result = makeResult({
    outcome,
    exitCode: exitCodeForOutcome(outcome),
    code: outcome === 'warn' ? 'quality.semantic.finding.warning' : outcome === 'block' ? 'ci.native.semantic-quality' : 'ci.required-check.missing',
    owner: outcome === 'warn' || outcome === 'block' ? 'semantic-quality-decision-owner' : 'ci-policy-owner',
    severity: outcome === 'block' ? 'high' : 'medium',
    confidence: outcome === 'inconclusive' ? 'inconclusive' : 'proven',
    evidenceState: outcome === 'inconclusive' ? 'inconclusive' : 'proven',
    findingId: 'finding-1',
    rootCauseId: 'finding-1',
    location: { kind: 'manifest-key', name: 'controls.semantic-quality' },
    why: outcome === 'warn'
      ? 'The native semantic-quality owner reported an actionable advisory finding.'
      : outcome === 'block'
        ? 'The native semantic-quality owner proved a blocking finding.'
        : 'The required evidence did not prove the declared boundary.',
    impact: 'The exact candidate cannot be authorized.',
    guidance: outcome === 'warn'
      ? ['Repair the native semantic finding before its governed expiry; do not treat the warning as passing mandatory evidence.']
      : outcome === 'block'
        ? ['Repair the canonical native semantic finding without changing its rule, severity, or exception owner.']
        : ['Repair the named precondition.', 'Replay the focused check.'],
    nativeEvidence: outcome === 'warn' || outcome === 'block' ? SEMANTIC_NATIVE_EVIDENCE : null,
    warningGovernance: outcome === 'warn' ? WARNING_GOVERNANCE : null,
    validUntil: outcome === 'warn' ? WARNING_GOVERNANCE.expiresAt : VALID_UNTIL,
    patchScope: { allowed: ['canonical adapter'], prohibited: ['continue-on-error', 'permission broadening'] },
    allowedPatchScope: ['canonical adapter'],
    prohibitedChanges: ['continue-on-error', 'permission broadening'],
    doNot: ['Do not weaken the required control.'],
    reproduce: { command: 'npm run verify:pr', preconditions: ['exact Git objects exist'] },
    verify: { commands: ['npm run test:focused', 'npm run test:affected'], expected: ['unsafe fixture fails', 'safe neighbor passes'] },
    retryable: true,
    retryConditions: outcome === 'inconclusive' ? ['named precondition is repaired'] : ['the canonical source owner has changed'],
    retryClass: outcome === 'inconclusive' ? 'after-evidence-regeneration' : 'after-source-change',
    remediationClass: outcome === 'inconclusive' ? 'exact-revision-rerun' : 'source-patch',
    nextBestAction: outcome === 'inconclusive' ? 'Repair the named precondition.' : 'Patch the canonical owner.',
    exception: { eligible: false, approvalRole: null },
    relatedFindings: ['dependent-fixture'],
    relatedFindingIds: ['dependent-fixture'],
    scopeLimitations: ['No protected remote execution is claimed.'],
    verificationPlan: ['npm run test:focused', 'npm run test:affected'],
    closureCriteria: ['unsafe fixture fails', 'safe neighbor passes'],
    sensitiveFieldsOmitted: ['matched-values'],
    publicEvidenceRefs: ['public:summary'],
    privateEvidenceRefs: ['private:opaque:0123456789abcdef'],
    limitations: ['no protected producer is claimed'],
    ...overrides,
  });
  return result;
}

describe('CP-F2 strict outcome and diagnostic contract', () => {
  it('accepts all five leaf outcomes with exact exit mappings and three aggregate decisions', () => {
    const nonBlockingOutcomes: ControlOutcome[] = ['pass', 'warn', 'not-applicable'];
    expect(nonBlockingOutcomes.map(exitCodeForOutcome)).toEqual([0, 0, 0]);
    expect(exitCodeForOutcome('block')).toBe(1);
    expect(exitCodeForOutcome('inconclusive')).toBe(2);
    expect(validateControlResult(makeResult(), validationOptions()).outcome).toBe('pass');
    expect(validateControlResult(makeDiagnostic('warn'), validationOptions()).outcome).toBe('warn');
    expect(validateControlResult(makeDiagnostic('block'), validationOptions()).outcome).toBe('block');
    expect(validateControlResult(makeDiagnostic('inconclusive'), noNativeValidationOptions()).outcome).toBe('inconclusive');
    expect(validateControlResult(makeResult({ outcome: 'not-applicable', code: 'ci.classification.not-applicable', owner: 'ci-classifier-decision-owner', applicability: 'not-applicable', applicabilityReason: 'ci.classification.not-applicable', classifierProof: classifierProof() }), validationOptions()).outcome).toBe('not-applicable');
  });

  it('rejects outcome/exit mismatches and incomplete or generic diagnostics', () => {
    expect(() => validateControlResult(makeResult({ outcome: 'block' }), validationOptions())).toThrow(/exit|outcome/i);
    expect(() => validateControlResult(makeDiagnostic('block', { why: 'CI failed' }), validationOptions())).toThrow(/generic|diagnostic/i);
    expect(() => validateControlResult(makeDiagnostic('block', { owner: '' }), validationOptions())).toThrow(/owner|diagnostic/i);
    expect(() => validateControlResult(makeDiagnostic('block', { guidance: [] }), validationOptions())).toThrow(/guidance|diagnostic|taxonomy|message/i);
  });

  it('requires trusted closed classifier proof for not-applicable and rejects skipped substitutes', () => {
    expect(() => validateControlResult(makeResult({ outcome: 'not-applicable', code: 'ci.classification.not-applicable', owner: 'ci-classifier-decision-owner', applicability: 'not-applicable', applicabilityReason: null }), validationOptions())).toThrow(/applicab/i);
    expect(() => validateControlResult(makeResult({ outcome: 'not-applicable', code: 'ci.classification.not-applicable', owner: 'ci-classifier-decision-owner', applicability: 'not-applicable', applicabilityReason: 'ci.classification.not-applicable', classifierProof: classifierProof({ candidateOid: BASE_OID }) }), validationOptions())).toThrow(/classifier|binding/i);
    const skipped = observedCheck({ applicability: 'not-applicable', applicabilityReason: null, outcome: 'pass', producer: null, observedPlatform: null, nativeSchemaVersion: null, evidenceDigest: null, createdAt: null, validUntil: null });
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck()], observedChecks: [skipped] }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/applicab|not-applicable|exact/i);
  });

  it('does not permit registered reason codes to change outcome semantics', () => {
    expect(() => validateControlResult(makeDiagnostic('block', { code: 'ci.check.passed' }), validationOptions())).toThrow(/taxonomy|code.*outcome/i);
    expect(() => validateControlResult(makeResult({ code: 'ci.required-check.missing' }), validationOptions())).toThrow(/taxonomy|code.*outcome/i);
    expect(() => validateControlResult(makeDiagnostic('block', { severity: 'low' }), validationOptions())).toThrow(/severity|taxonomy/i);
    expect(() => validateControlResult(makeDiagnostic('inconclusive', { retryClass: 'after-transient-condition' }), validationOptions())).toThrow(/retry.*class|taxonomy/i);
    expect(() => validateControlResult(makeDiagnostic('warn', { owner: 'substitute-owner' }), validationOptions())).toThrow(/owner|taxonomy/i);
    expect(() => validateControlResult(makeDiagnostic('warn', { why: 'A parallel warning explanation.' }), validationOptions())).toThrow(/message|taxonomy/i);
    expect(() => validateControlResult(makeDiagnostic('warn', { stage: 'deployment' }), validationOptions())).toThrow(/stage|taxonomy/i);
    expect(() => validateControlResult(makeDiagnostic('warn', { validUntil: new Date(NOW + 13 * 60 * 60_000).toISOString() }), validationOptions())).toThrow(/warning|expiry/i);
    expect(() => validateControlResult(makeDiagnostic('inconclusive', {
      code: 'ci.hooks.path-foreign',
      retryClass: 'after-precondition-repair',
      remediationClass: 'environment-setup',
    }), validationOptions())).toThrow(/legacy|metadata|authoritative|emittable/i);
  });

  it('binds the complete producer execution identity to trusted expectations', () => {
    for (const producer of [
      { appId: 'expected-app', workflowRef: 'owner/repo/.github/workflows/other.yml@refs/heads/main', workflowSha: OID, runId: 'run-1', attempt: 1 },
      { appId: 'expected-app', workflowRef: 'owner/repo/.github/workflows/policy.yml@refs/heads/main', workflowSha: OID, runId: 'run-2', attempt: 1 },
      { appId: 'expected-app', workflowRef: 'owner/repo/.github/workflows/policy.yml@refs/heads/main', workflowSha: OID, runId: 'run-1', attempt: 2 },
    ]) expect(() => validateControlResult(makeDiagnostic('block', { producer }), validationOptions())).toThrow(/trusted.*producer|expected.*binding/i);
  });

  it('rejects malformed trusted causal roots even when the current node matches', () => {
    const dependent = { findingId: 'dependent', rootCauseId: 'finding-1', causedBy: ['finding-1'], candidateOid: OID, policyDigest: DIGEST };
    for (const expectedFindingGraph of [
      [{ findingId: 'finding-1', rootCauseId: 'finding-1', causedBy: ['dependent'], candidateOid: OID, policyDigest: DIGEST }, dependent],
      [{ findingId: 'finding-1', rootCauseId: 'finding-1', causedBy: [], candidateOid: OID, policyDigest: DIGEST }, { ...dependent, causedBy: [] }],
      [{ findingId: 'finding-1', rootCauseId: 'finding-1', causedBy: [], candidateOid: OID, policyDigest: DIGEST }, { ...dependent, causedBy: ['finding-1', 'finding-1'] }],
    ]) expect(() => validateControlResult(makeDiagnostic('block'), validationOptions({ expectedFindingGraph }))).toThrow(/causal|root|duplicate|graph/i);
  });

  it('keeps deprecated receipts readable only through a non-authorizing historical path', () => {
    const historicalRead = (resultApi as unknown as Record<string, unknown>).validateHistoricalControlResult;
    const historicalParse = (resultApi as unknown as Record<string, unknown>).parseHistoricalControlResultJson;
    expect(historicalRead).toEqual(expect.any(Function));
    expect(historicalParse).toEqual(expect.any(Function));
    if (typeof historicalRead !== 'function') return;
    const historical = makeDiagnostic('inconclusive', { code: 'ci.execution.stale-receipt' });
    expect(() => validateControlResult(historical, validationOptions())).toThrow(/deprecated|historical|emittable/i);
    const historicalObjectRead = historicalRead(historical, noNativeValidationOptions()) as { evidenceDigest: string; result: Record<string, unknown> };
    expect(historicalObjectRead).toMatchObject({ authorization: 'historical-only', lifecycle: 'deprecated' });
    expect(Object.isFrozen(historicalObjectRead.result)).toBe(true);
    expect(Object.isFrozen(historicalObjectRead.result.attempt)).toBe(true);
    expect(() => Object.assign(historicalObjectRead.result, { code: 'ci.check.passed' })).toThrow();
    const { nativeEvidence: _nativeEvidence, warningGovernance: _warningGovernance, warningTransition: _warningTransition, ...legacySeed } = historical;
    const legacyAttempt = {
      ...legacySeed.attempt,
      evidenceBinding: { ...legacySeed.attempt.evidenceBinding, resultEvidenceDigest: controlResultEvidenceDigest(legacySeed) },
    };
    const legacy = { ...legacySeed, attempt: legacyAttempt, attemptDigest: terminalAttemptDigest(legacyAttempt as never) };
    expect(historicalRead(legacy, noNativeValidationOptions())).toMatchObject({ authorization: 'historical-only', lifecycle: 'deprecated', result: legacy });
    if (typeof historicalParse !== 'function') return;
    const compact = JSON.stringify(historical);
    const padded = `${JSON.stringify(historical, null, 2)}\n`;
    const compactRead = historicalParse(compact, noNativeValidationOptions()) as { evidenceDigest: string; result: Record<string, unknown> };
    const paddedRead = historicalParse(padded, noNativeValidationOptions()) as { evidenceDigest: string; result: Record<string, unknown> };
    expect(compactRead.result).toEqual(paddedRead.result);
    expect(compactRead.evidenceDigest).not.toBe(paddedRead.evidenceDigest);
    expect(() => historicalParse('{"schemaVersion":1,"schemaVersion":1}', noNativeValidationOptions())).toThrow(/duplicate|json/i);
    expect(() => historicalParse(Buffer.from([0xff]), noNativeValidationOptions())).toThrow(/utf-8|json/i);
  });

  it('requires a protected-clock warning transition API and rejects the warning at expiry', () => {
    const buildTransition = (resultApi as unknown as Record<string, unknown>).buildWarningEscalationTransition;
    expect(buildTransition).toEqual(expect.any(Function));
    const transitionExpiry = NOW - 2 * 60_000;
    const transitionGovernance = {
      ...WARNING_GOVERNANCE,
      firstObservedAt: new Date(transitionExpiry - 12 * 60 * 60_000).toISOString(),
      remediationDueAt: new Date(transitionExpiry - 4 * 60 * 60_000).toISOString(),
      expiresAt: new Date(transitionExpiry).toISOString(),
    };
    const warning = makeDiagnostic('warn', {
      warningGovernance: transitionGovernance,
      createdAt: new Date(NOW - 4 * 60_000).toISOString(),
      validUntil: transitionGovernance.expiresAt,
    });
    const expiresAt = Date.parse(String(warning.validUntil));
    const protectedNow = NOW;
    const transitionOptions = validationOptions({ expectedWarningGovernance: transitionGovernance });
    expect(() => validateControlResult(warning, { ...transitionOptions, now: expiresAt })).toThrow(/expired|stale|warning|fresh/i);
    if (typeof buildTransition !== 'function') return;
    const transition = buildTransition(warning, { ...transitionOptions, protectedNow }) as WarningEscalationTransitionV1;
    expect(transition).toMatchObject({
      predecessorCode: 'quality.semantic.finding.warning',
      successorCode: 'quality.semantic.warning.expired',
      predecessorFindingId: 'finding-1',
      predecessorAttemptId: 'attempt-1',
      predecessorAttemptDigest: warning.attemptDigest,
      nativeCauseCodes: SEMANTIC_NATIVE_EVIDENCE.nativeCauseCodes,
      expiresAt: warning.validUntil,
    });
    const successor = makeDiagnostic('block', {
      __attemptId: 'attempt-2',
      __attemptCreatedAt: new Date(expiresAt + 30_000).toISOString(),
      __attemptTerminalAt: new Date(expiresAt + 60_000).toISOString(),
      code: 'quality.semantic.warning.expired',
      findingId: 'finding-expired',
      rootCauseId: 'finding-expired',
      why: 'The governed semantic-quality warning expired without a verified remediation receipt.',
      guidance: ['Repair the original native semantic finding and emit a new exact-revision receipt; do not reset or suppress the original warning interval.'],
      nativeEvidence: SEMANTIC_NATIVE_EVIDENCE,
      warningTransition: transition,
      supersedes: ['finding-1'],
      createdAt: transition.transitionedAt,
      validUntil: new Date(protectedNow + 60 * 60_000).toISOString(),
    });
    const successorOptions = validationOptions({
      now: protectedNow,
      expectedWarningGovernance: transitionGovernance,
      expectedWarningTransition: transition,
      expectedFindingGraph: [{ findingId: 'finding-expired', rootCauseId: 'finding-expired', causedBy: [], candidateOid: OID, policyDigest: DIGEST }],
    });
    expect(validateControlResult(successor, successorOptions).code).toBe('quality.semantic.warning.expired');
    const earlyAttempt = makeAttempt({
      id: 'attempt-before-expiry',
      rawExit: 1,
      evidenceBinding: successor.attempt.evidenceBinding,
    });
    expect(() => validateControlResult({
      ...successor,
      attempt: earlyAttempt,
      attemptDigest: terminalAttemptDigest(earlyAttempt as never),
    }, successorOptions)).toThrow(/attempt|expiry|chronology|transition/i);
    expect(() => validateControlResult({ ...successor, warningTransition: { ...transition, policyDigest: OTHER_DIGEST } }, { ...successorOptions, expectedWarningTransition: { ...transition, policyDigest: OTHER_DIGEST } })).toThrow(/policy|transition|binding/i);
    expect(() => validateControlResult({ ...successor, nativeEvidence: { ...SEMANTIC_NATIVE_EVIDENCE, nativeCauseCodes: ['semantic.other'] } }, successorOptions)).toThrow(/native|transition|attempt.*binding/i);
    expect(() => validateControlResult({ ...successor, warningTransition: { ...transition, transitionedAt: new Date(protectedNow + 1).toISOString() } }, successorOptions)).toThrow(/transition|attempt.*binding/i);
    expect(() => validateControlResult({ ...successor, warningTransition: { ...transition, predecessorAttemptDigest: OTHER_DIGEST } }, { ...successorOptions, expectedWarningTransition: { ...transition, predecessorAttemptDigest: OTHER_DIGEST } })).toThrow(/attempt|transition|binding/i);
  });

  it('requires native evidence to match independently protected adapter evidence', () => {
    expect(() => validateControlResult(makeDiagnostic('block'), validationOptions({
      expectedNativeEvidence: { ...SEMANTIC_NATIVE_EVIDENCE, evidenceDigest: OTHER_DIGEST },
    }))).toThrow(/native.*expected|protected.*native|native.*binding/i);
    expect(() => validateControlResult(makeResult({ nativeEvidence: null }), validationOptions())).toThrow(/native.*expected|protected.*native|native.*binding/i);
    for (const producer of [
      { ...PRODUCER, appId: 'substitute-app' },
      { ...PRODUCER, workflowRef: 'owner/repo/.github/workflows/other.yml@refs/heads/main' },
      { ...PRODUCER, workflowSha: BASE_OID },
      { ...PRODUCER, runId: 'run-substitute' },
      { ...PRODUCER, attempt: 2 },
    ]) expect(() => validateControlResult(makeDiagnostic('block'), validationOptions({
      expectedNativeEvidence: { ...SEMANTIC_NATIVE_EVIDENCE, producer },
    }))).toThrow(/native.*expected|protected.*native|native.*binding/i);
  });

  it('enforces protected scanner-policy identity during core result validation', () => {
    for (const producer of [
      { ...PROTECTED_POLICY_PRODUCER, workflowRef: 'owner/protected/.github/workflows/other.yml@refs/heads/main' },
      { ...PROTECTED_POLICY_PRODUCER, runId: 'protected-run-substitute' },
      { ...PROTECTED_POLICY_PRODUCER, attempt: 2 },
    ]) {
      const substitutedReceipt = { ...SCANNER_POLICY_RECEIPT, producer };
      expect(() => validateControlResult(makeResult({ scannerPolicyReceipt: substitutedReceipt }), validationOptions())).toThrow(/scanner.*protected|scanner.*expected|scanner.*receipt/i);
    }
  });

  it('requires closed retry/remediation classes and exact claimed/observed scope', () => {
    expect(() => validateControlResult(makeDiagnostic('inconclusive', { retryClass: 'yes-please' }), validationOptions())).toThrow(/retry.*class/i);
    expect(() => validateControlResult(makeDiagnostic('inconclusive', { remediationClass: 'just-rerun' }), validationOptions())).toThrow(/remediation.*class/i);
    expect(() => validateControlResult(makeDiagnostic('block', { observedScope: { kind: 'control-surface', digest: OTHER_DIGEST, itemCount: 1 }, scopeLimitations: [] }), validationOptions())).toThrow(/scope|observed/i);
    expect(() => validateControlResult(makeDiagnostic('inconclusive', { observedScope: { kind: 'control-surface', digest: OTHER_DIGEST, itemCount: 0 }, scopeLimitations: [] }), noNativeValidationOptions())).toThrow(/scope.*limitation|limitation.*scope/i);
    expect(validateControlResult(makeDiagnostic('inconclusive', { observedScope: { kind: 'control-surface', digest: OTHER_DIGEST, itemCount: 0 } }), noNativeValidationOptions()).outcome).toBe('inconclusive');
    expect(() => validateControlResult(makeDiagnostic('block', {
      claimedScope: { kind: 'control-surface', digest: OTHER_DIGEST, itemCount: 1 },
      observedScope: { kind: 'control-surface', digest: OTHER_DIGEST, itemCount: 1 },
    }), validationOptions())).toThrow(/trusted.*scope|scope.*expected/i);
  });

  it('requires causal, patch, verification, closure, and disclosure enrichment parity', () => {
    expect(() => validateControlResult(makeDiagnostic('block', { rootCauseId: null }), validationOptions())).toThrow(/root.*cause|causal/i);
    expect(() => validateControlResult(makeDiagnostic('block', { allowedPatchScope: ['different owner'] }), validationOptions())).toThrow(/patch.*scope|allowed/i);
    expect(() => validateControlResult(makeDiagnostic('block', { verificationPlan: ['different command'] }), validationOptions())).toThrow(/verification.*plan|verify/i);
    expect(() => validateControlResult(makeDiagnostic('block', { closureCriteria: [] }), validationOptions())).toThrow(/closure/i);
    expect(() => validateControlResult(makeDiagnostic('block', { doNot: [] }), validationOptions())).toThrow(/prohibited|doNot|workaround/i);
    expect(() => validateControlResult(makeDiagnostic('block', { publicEvidenceRefs: ['private:absolute/path'] }), validationOptions())).toThrow(/evidence.*ref|public/i);
    expect(() => validateControlResult(makeDiagnostic('block', { causedBy: ['finding-1'] }), validationOptions())).toThrow(/causal|self|finding/i);
    expect(() => validateControlResult(makeDiagnostic('block', { retryable: false }), validationOptions())).toThrow(/retry/i);
    expect(() => validateControlResult(makeDiagnostic('block', {
      findingId: 'finding-2', rootCauseId: 'finding-1', causedBy: ['finding-1'],
    }), validationOptions())).toThrow(/finding.*graph|causal.*graph/i);
    const dependent = validateControlResult(makeDiagnostic('block', {
      findingId: 'finding-2', rootCauseId: 'finding-1', causedBy: ['finding-1'],
    }), validationOptions({ expectedFindingGraph: [
      { findingId: 'finding-1', rootCauseId: 'finding-1', causedBy: [], candidateOid: OID, policyDigest: DIGEST },
      { findingId: 'finding-2', rootCauseId: 'finding-1', causedBy: ['finding-1'], candidateOid: OID, policyDigest: DIGEST },
    ] }));
    expect(dependent.rootCauseId).toBe('finding-1');
    expect(() => validateControlResult(makeDiagnostic('block', { privateEvidenceRefs: ['private:diagnostic-1'] }), validationOptions())).toThrow(/private.*evidence|opaque/i);
  });

  it('requires independently trusted envelope identities', () => {
    const rewritten = makeResult({
      manifestDigest: OTHER_DIGEST, policyDigest: OTHER_DIGEST, classifierDigest: OTHER_DIGEST,
      producer: { appId: 'substitute-app', workflowRef: 'owner/repo/.github/workflows/policy.yml@refs/heads/main', workflowSha: BASE_OID, runId: 'run-2', attempt: 1 },
    });
    expect(() => validateControlResult(rewritten, validationOptions())).toThrow(/trusted.*binding|expected.*binding|producer|manifest|policy|tool/i);
  });

  it('enforces exact nested keys and rejects accessors before reading values', () => {
    expect(() => validateControlResult(makeResult({ producer: { ...(makeResult().producer as object), surprise: true } }), validationOptions())).toThrow(/producer|keys/i);
    expect(() => validateControlResult({ ...makeResult(), evidenceDigest: DIGEST }, validationOptions())).toThrow(/result.*keys|keys.*result/i);
    const hostile = makeResult();
    Object.defineProperty(hostile, 'owner', { enumerable: true, get() { throw new Error('secret getter executed'); } });
    expect(() => validateControlResult(hostile, validationOptions())).toThrow(/accessor|plain|data/i);
  });
});

describe('CP-F2 parsing, bounds, canonical bytes, and safe feedback', () => {
  it('keeps canonical native receipt byte validation in the branch gate', () => {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['verify:push:branch']).toContain('verify:semantic:shadow');
    expect(packageJson.scripts['verify:semantic:shadow']).toContain('tests/scripts/semantic-quality-receipt-validation.test.ts');
  });

  it('rejects duplicate JSON keys, invalid UTF-8, and oversized bytes before parsing', () => {
    expect(() => parseControlResultJson('{"schemaVersion":1,"schemaVersion":1}')).toThrow(/duplicate/i);
    expect(() => parseControlResultJson(Buffer.from([0xff]))).toThrow(/utf-8|json/i);
    expect(() => parseControlResultJson(Buffer.alloc(32_769, 0x20))).toThrow(/byte budget/i);
  });

  it('enforces string and list budgets at the limit and one over, including multibyte text', () => {
    const atLimit = makeDiagnostic('inconclusive', { impact: 'é'.repeat(1_024) });
    expect(validateControlResult(atLimit, noNativeValidationOptions()).impact).toBe(atLimit.impact);
    expect(() => validateControlResult(makeDiagnostic('inconclusive', { impact: `${'é'.repeat(1_024)}x` }), noNativeValidationOptions())).toThrow(/byte|string|budget/i);
    expect(() => validateControlResult(makeDiagnostic('inconclusive', { guidance: Array.from({ length: 65 }, () => 'repair') }), noNativeValidationOptions())).toThrow(/list|budget|guidance/i);
  });

  it('uses one deterministic byte projection for serialization and hashing', () => {
    const result = validateControlResult(makeResult(), validationOptions());
    const outputOptions = publicOutputOptions();
    const bytes = canonicalizeControlResult(result, outputOptions);
    expect(serializeControlResult(result, outputOptions)).toBe(Buffer.from(bytes).toString('utf8'));
    expect(hashControlResult(result, outputOptions)).toBe(digest(Buffer.from(bytes).toString('utf8')));
    expect(hashControlResult(result, outputOptions)).toBe('sha256:a4da386f848d59895cb2198ca8300febe3810cac9ac948ca70a69bbba97bdd41');
    expect(Buffer.from(bytes).toString('utf8').endsWith('\n')).toBe(true);
    expect(() => serializeControlResult(result)).toThrow(/redaction|public output/i);
    const firstRequired = requiredCheck({ id: 'first' });
    const secondRequired = requiredCheck({ id: 'second' });
    const firstObserved = observedCheck({ id: 'first' });
    const secondObserved = observedCheck({ id: 'second' });
    const left = validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [secondRequired, firstRequired], observedChecks: [firstObserved, secondObserved] }), validationOptions({ expectedChecks: [firstRequired, secondRequired] }));
    const right = validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [firstRequired, secondRequired], observedChecks: [secondObserved, firstObserved] }), validationOptions({ expectedChecks: [secondRequired, firstRequired] }));
    const aggregateOutputOptions = { ...outputOptions, expectedChecks: [firstRequired, secondRequired] };
    expect(serializeControlResult(left, aggregateOutputOptions)).toBe(serializeControlResult(right, aggregateOutputOptions));
  });

  it('binds mutable diagnostics into the terminal result evidence digest', () => {
    const result = makeDiagnostic('block');
    for (const mutation of [
      { impact: 'A different safe but unreviewed impact.' },
      { limitations: ['A different bounded limitation.'] },
      { retryConditions: ['a different source correction is complete'] },
      { relatedFindingIds: ['different-dependent-fixture'] },
      { publicEvidenceRefs: ['public:different-summary'] },
      { nativeEvidence: { ...SEMANTIC_NATIVE_EVIDENCE, evidenceDigest: OTHER_DIGEST } },
    ]) expect(() => validateControlResult({ ...result, ...mutation }, validationOptions())).toThrow(/attempt.*binding|evidence.*binding|native.*expected/i);
  });

  it('renders actionable feedback from the validated object and rejects unsafe public text', () => {
    const result = makeDiagnostic('inconclusive');
    const rendered = renderControlResult(result as never, noNativePublicOutputOptions());
    for (const text of [
      result.code, result.owner, result.canonicalImplementationOwner, result.domain,
      result.stage, result.eventName, result.operation, result.trustClass, result.surface,
      result.applicability, result.severity, result.confidence,
      result.candidateOid, result.baseOid, result.mergeOid, result.manifestDigest,
      result.policyDigest, result.classifierDigest, result.producer.appId,
      result.producer.workflowSha, result.producer.workflowRef, result.producer.runId,
      String(result.producer.attempt), result.tool.digest, result.platform.runnerLabel,
      result.platform.observedCapabilitiesDigest, result.scannerPolicyReceipt.sourceOid,
      result.preconditionReceipt.outcome, result.preconditionReceipt.createdAt,
      result.attempt.id, result.attempt.lifecycle, result.attemptDigest,
      result.risk.tier, ...result.risk.reasons, result.createdAt, result.validUntil,
      result.why, result.impact, ...result.guidance,
      result.evidenceState, result.rootCauseId, result.claimedScope.kind,
      result.claimedScope.digest, String(result.claimedScope.itemCount),
      result.observedScope.kind, result.observedScope.digest,
      String(result.observedScope.itemCount), result.retryClass,
      result.remediationClass, result.nextBestAction,
      ...result.patchScope.allowed, ...result.patchScope.prohibited,
      result.reproduce.command, ...result.reproduce.preconditions,
      ...result.verify.commands, ...result.verify.expected,
      ...result.retryConditions, ...result.relatedFindings, ...result.relatedFindingIds,
      ...result.supersedes, ...result.scopeLimitations, ...result.closureCriteria,
      ...result.sensitiveFieldsOmitted, ...result.publicEvidenceRefs, ...result.limitations,
    ]) expect(rendered).toContain(text);
    expect(rendered).not.toContain(result.privateEvidenceRefs[0]);
    expect(rendered).toContain('Exception: Not eligible');
    const privateMatch = 'local-secret-label';
    const absolutePath = ['', 'Users', 'person', 'private', 'file'].join('/');
    expect(() => validateControlResult(makeDiagnostic('block', { why: `Matched ${privateMatch}` }), validationOptions({ forbiddenValues: [privateMatch] }))).toThrow(/unsafe|private|public/i);
    expect(() => validateControlResult(makeDiagnostic('block', { why: absolutePath }), validationOptions())).toThrow(/absolute|unsafe|public/i);
    for (const unsafePath of ['C:\\Users\\person\\file', '\\\\server\\share\\private', '/Volumes/External/private/file', '/opt/local/private/file', '/Library/Application Support/private', '/etc/hosts', '/usr/local/bin/tool', '/srv/private/file', '/mnt/private/file', 'path=/etc/hosts', 'source=file:///etc/hosts', '{"path":"/etc/hosts"}', 'path{/etc/hosts}', 'path;/etc/hosts', '</etc/hosts>']) {
      expect(() => validateControlResult(makeDiagnostic('block', { impact: unsafePath }), validationOptions())).toThrow(/absolute|unsafe|public/i);
    }
    expect(() => validateControlResult(makeDiagnostic('block', { impact: 'See https://example.invalid/docs/path for safe public guidance.' }), validationOptions())).not.toThrow();
    expect(() => validateControlResult(makeDiagnostic('block', { why: createHash('sha256').update(privateMatch).digest('hex') }), validationOptions({ forbiddenValues: [privateMatch] }))).toThrow(/unsafe|fingerprint|public/i);
    expect(() => renderControlResult(makeDiagnostic('block', { why: `Matched ${privateMatch}` }) as never, publicOutputOptions([privateMatch]))).toThrow(/unsafe|private|public|scan/i);
    expect(() => renderControlResult(makeDiagnostic('block', { why: `token=${privateMatch}` }) as never, publicOutputOptions())).toThrow(/unsafe|private|public|scan/i);
    const scannerOnlyMatch = ['ghp', 'A'.repeat(16)].join('_');
    const scannerOnlyResult = makeDiagnostic('block', { impact: `Matched ${scannerOnlyMatch}` });
    expect(() => validateControlResult(scannerOnlyResult, validationOptions())).not.toThrow();
    expect(() => serializeControlResult(scannerOnlyResult as never, publicOutputOptions())).toThrow(/public output scan did not prove safe exact bytes/i);
    const driftedReceipt = {
      ...SCANNER_POLICY_RECEIPT,
      sources: SCANNER_POLICY_RECEIPT.sources.map((source, index) => index === 0 ? { ...source, blobOid: OID } : source),
    };
    expect(() => renderControlResult(result as never, { ...publicOutputOptions(), expectedScannerPolicyReceipt: driftedReceipt })).toThrow(/scanner|public output|policy/i);
  });

  it('requires the stable fingerprint derived from safe causal fields', () => {
    const result = makeDiagnostic('block');
    expect(result.fingerprint).toMatch(/^fp:v1:[0-9a-f]{64}$/);
    const baseline = buildFindingFingerprint(result as never);
    expect(baseline).toBe('fp:v1:e77112451fd0a2c7ad862986cc29c9720a708638bc7951230fca73ba11aaedc9');
    expect(buildFindingFingerprint({ ...result, impact: 'A different non-identity impact.' } as never)).toBe(baseline);
    for (const mutation of [
      { code: 'quality.semantic.warning.expired' },
      { candidateOid: BASE_OID },
      { policyDigest: OTHER_DIGEST },
      { location: { kind: 'manifest-key', name: 'controls.other' } },
      { claimedScope: { kind: 'control-surface', digest: OTHER_DIGEST, itemCount: 1 } },
    ]) expect(buildFindingFingerprint({ ...result, ...mutation } as never)).not.toBe(baseline);
    expect(() => validateControlResult({ ...result, fingerprint: `fp:v1:${'0'.repeat(64)}` }, validationOptions())).toThrow(/fingerprint|evidence.*binding/i);
  });

  it('renders the complete governed warning policy from the validated result', () => {
    const warning = makeDiagnostic('warn');
    const rendered = renderControlResult(warning as never, publicOutputOptions());
    for (const value of ['semantic-quality-decision-owner', '8', '12', 'quality.semantic.warning.expired', 'unresolved', 'expires']) {
      expect(rendered.toLowerCase()).toContain(value.toLowerCase());
    }
  });
});

describe('CP-F2 precondition and terminal evidence', () => {
  it('validates complete preconditions and makes setup failures inconclusive', () => {
    const receipt = makePreconditions();
    expect(validatePreconditionReceipt(receipt, { now: NOW, expected: expectedPreconditions() })).toEqual(receipt);
    expect(preconditionDigest(receipt as never, { now: NOW, expected: expectedPreconditions(receipt) })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => validatePreconditionReceipt(makePreconditions({ runtime: { name: 'node', version: 'unsupported', digest: DIGEST } }), { now: NOW, expected: expectedPreconditions() })).toThrow(/trusted|runtime|precondition/i);
    for (const mutation of [
      { runtime: { name: 'node', version: 'unsupported', digest: DIGEST }, outcome: 'inconclusive' },
      { installScopes: [], outcome: 'inconclusive' },
      { fixture: { created: false, digest: DIGEST }, outcome: 'inconclusive' },
    ]) {
      expect(() => validateControlResult(makeDiagnostic('block', { preconditionReceipt: makePreconditions(mutation) }), validationOptions())).toThrow(/precondition|inconclusive/i);
      expect(() => validateControlResult(makeDiagnostic('inconclusive', { preconditionReceipt: makePreconditions(mutation) }), noNativeValidationOptions())).toThrow(/precondition|cause|code/i);
      expect(validateControlResult(makeDiagnostic('inconclusive', { code: 'ci.input.precondition-unproven', retryClass: 'after-precondition-repair', remediationClass: 'environment-setup', preconditionReceipt: makePreconditions(mutation) }), noNativeValidationOptions()).outcome).toBe('inconclusive');
    }
    const historicalNow = Date.parse('2020-01-01T00:10:00.000Z');
    const historicalReceipt = makePreconditions({ createdAt: '2020-01-01T00:00:00.000Z' });
    expect(preconditionDigest(historicalReceipt as never, { now: historicalNow })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects stale, wrong-revision, wrong-policy, and wrong-producer evidence', () => {
    expect(() => validateControlResult(makeResult({ validUntil: new Date(NOW - 1).toISOString() }), validationOptions())).toThrow(/stale|fresh/i);
    expect(() => validateControlResult(makeResult({ preconditionReceipt: makePreconditions({ workspace: { ...(makePreconditions().workspace as object), candidateOid: BASE_OID } }) }), validationOptions())).toThrow(/candidate|binding|precondition|trusted/i);
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck()], observedChecks: [observedCheck({ policyDigest: OTHER_DIGEST })] }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/policy|tuple|exact/i);
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck()], observedChecks: [observedCheck({ mergeOid: BASE_OID })] }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/merge|tuple|exact/i);
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck()], observedChecks: [observedCheck({ producer: { ...PRODUCER, appId: 'other-app' } })] }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/producer|identity|exact/i);
    for (const producer of [
      { ...PRODUCER, workflowRef: 'owner/repo/.github/workflows/other.yml@refs/heads/main' },
      { ...PRODUCER, runId: 'run-substitute' },
      { ...PRODUCER, attempt: 2 },
    ]) expect(() => validateControlResult(makeResult({
      aggregateDecision: 'pass',
      requiredChecks: [requiredCheck()],
      observedChecks: [observedCheck({ producer })],
    }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/producer|identity|exact/i);
    expect(() => validateControlResult(makeResult({ createdAt: new Date(NOW + 10 * 60_000).toISOString(), validUntil: new Date(NOW + 20 * 60_000).toISOString() }), validationOptions())).toThrow(/future|stale/i);
    expect(() => validateControlResult(makeResult({ createdAt: new Date(NOW + 4 * 60_000).toISOString(), validUntil: new Date(NOW + 60_000).toISOString() }), validationOptions())).toThrow(/interval|timestamp|fresh/i);
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck()], observedChecks: [observedCheck({ createdAt: new Date(NOW + 4 * 60_000).toISOString(), validUntil: new Date(NOW + 60_000).toISOString() })] }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/interval|timestamp|fresh/i);
    expect(() => validateControlResult(makeResult({ outcome: 'not-applicable', code: 'ci.classification.not-applicable', owner: 'ci-classifier-decision-owner', applicability: 'not-applicable', applicabilityReason: 'ci.classification.not-applicable', classifierProof: classifierProof({ createdAt: new Date(NOW + 4 * 60_000).toISOString(), validUntil: new Date(NOW + 60_000).toISOString() }) }), validationOptions())).toThrow(/interval|timestamp|fresh/i);
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck({ candidateOid: BASE_OID })], observedChecks: [observedCheck({ candidateOid: BASE_OID })] }), validationOptions({ expectedChecks: [requiredCheck({ candidateOid: BASE_OID })] }))).toThrow(/envelope|revision|policy|trusted/i);
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck()], observedChecks: [observedCheck({ observedPlatform: { os: 'macos', architecture: 'arm64' } })] }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/platform|tuple/i);
    expect(() => validateControlResult(makeResult({ preconditionReceipt: makePreconditions({ createdAt: new Date(NOW + 10 * 60_000).toISOString() }) }), validationOptions())).toThrow(/precondition.*future|future.*precondition/i);
    const futureResult = makeResult();
    const futureAttempt = {
      ...futureResult.attempt,
      createdAt: new Date(NOW + 10 * 60_000).toISOString(),
      terminalAt: new Date(NOW + 11 * 60_000).toISOString(),
      terminationProof: { ...futureResult.attempt.terminationProof, observedAt: new Date(NOW + 11 * 60_000).toISOString() },
    };
    expect(() => validateControlResult({ ...futureResult, attempt: futureAttempt, attemptDigest: terminalAttemptDigest(futureAttempt as never) }, validationOptions())).toThrow(/attempt.*future|future.*attempt/i);
    const lateAt = new Date(NOW - 6 * 60_000).toISOString();
    const lateResult = makeResult();
    const lateAttempt = { ...lateResult.attempt, terminalAt: lateAt, terminationProof: { ...lateResult.attempt.terminationProof, observedAt: lateAt } };
    expect(() => validateControlResult({ ...lateResult, attempt: lateAttempt, attemptDigest: terminalAttemptDigest(lateAttempt as never) }, validationOptions())).toThrow(/chronology/i);
  });

  it('rejects cycles and accessors in every direct evidence validator', () => {
    const cyclic = makePreconditions() as unknown as Record<string, unknown>;
    cyclic.loop = cyclic;
    expect(() => validatePreconditionReceipt(cyclic)).toThrow(/cycle|keys/i);
    const attempt = makeAttempt();
    Object.defineProperty(attempt, 'id', { enumerable: true, get() { throw new Error('getter ran'); } });
    expect(() => validateTerminalAttempt(attempt)).toThrow(/accessor|data propert/i);
    const digestCycle: Record<string, unknown> = {};
    digestCycle.self = digestCycle;
    expect(() => terminalAttemptDigest(digestCycle)).toThrow(/cycle/i);
  });

  it('accepts only terminal monotonic attempts after the process group ends', () => {
    expect(validateTerminalAttempt(makeAttempt(), { now: NOW }).lifecycle).toBe('terminal');
    expect(transitionAttempt('created', 'running')).toBe('running');
    expect(transitionAttempt('running', 'finalizing')).toBe('finalizing');
    expect(() => transitionAttempt('created', 'cancelled')).toThrow(/transition/i);
    expect(() => transitionAttempt('running', 'timed-out')).toThrow(/transition/i);
    expect(() => transitionAttempt('terminal', 'running')).toThrow(/transition/i);
    for (const lifecycle of ['cancelled', 'timed-out', 'corrupt']) expect(validateTerminalAttempt(makeAttempt({ lifecycle, rawExit: null, rawSignal: 'SIGTERM', timedOut: lifecycle === 'timed-out' }), { now: NOW }).lifecycle).toBe(lifecycle);
    expect(() => validateTerminalAttempt(makeAttempt({ lifecycle: 'running', terminalAt: null }), { now: NOW })).toThrow(/terminal|lifecycle/i);
    expect(() => validateTerminalAttempt({ ...makeAttempt(), terminationProof: { ...(makeAttempt().terminationProof as object), status: 'running' } }, { now: NOW })).toThrow(/termination|process group/i);
    expect(() => validateTerminalAttempt({ ...makeAttempt(), terminationProof: { ...(makeAttempt().terminationProof as object), supervisorDigest: OTHER_DIGEST } }, { now: NOW })).toThrow(/supervisor|binding/i);
    expect(() => validateControlResult(makeResult({ attemptDigest: OTHER_DIGEST }), validationOptions())).toThrow(/attempt.*digest|digest.*attempt/i);
    const validAttempt = makeResult().attempt;
    const wrongBinding = makeAttempt({ ...validAttempt, evidenceBinding: { ...validAttempt.evidenceBinding, candidateOid: BASE_OID } });
    expect(() => validateControlResult(makeResult({ attempt: wrongBinding, attemptDigest: terminalAttemptDigest(wrongBinding as never) }), validationOptions())).toThrow(/attempt.*binding|binding.*attempt/i);
    for (const [field, value] of [
      ['controlId', 'other-control'],
      ['manifestDigest', OTHER_DIGEST],
      ['policyDigest', OTHER_DIGEST],
      ['platformDigest', OTHER_DIGEST],
      ['preconditionDigest', OTHER_DIGEST],
      ['producerDigest', OTHER_DIGEST],
      ['scannerPolicyReceiptDigest', OTHER_DIGEST],
      ['resultEvidenceDigest', OTHER_DIGEST],
    ] as const) {
      const attempt = makeAttempt({ ...validAttempt, evidenceBinding: { ...validAttempt.evidenceBinding, [field]: value } });
      expect(() => validateControlResult(makeResult({ attempt, attemptDigest: terminalAttemptDigest(attempt as never) }), validationOptions()), field).toThrow(/attempt.*binding|binding.*attempt|supervisor/i);
    }
    const coherentOtherToolAttempt = makeAttempt({
      ...validAttempt,
      terminationProof: { ...validAttempt.terminationProof, supervisorDigest: OTHER_DIGEST },
      evidenceBinding: { ...validAttempt.evidenceBinding, toolDigest: OTHER_DIGEST },
    });
    expect(() => validateControlResult(makeResult({
      attempt: coherentOtherToolAttempt,
      attemptDigest: terminalAttemptDigest(coherentOtherToolAttempt as never),
    }), validationOptions()), 'toolDigest').toThrow(/attempt.*binding|binding.*attempt/i);
    const platformBound = makeResult();
    expect(() => validateControlResult({
      ...platformBound,
      platform: { ...(platformBound.platform as object), runnerLabel: 'altered-runner' },
    }, validationOptions())).toThrow(/attempt.*binding|platform.*binding|binding.*platform/i);
    expect(() => validateControlResult(makeResult({
      platform: { ...(makeResult().platform as object), observedCapabilitiesDigest: OTHER_DIGEST },
    }), validationOptions())).toThrow(/platform|capabilit|precondition/i);
  });

  it('persists every non-success terminal variant and admits it only as authoritative inconclusive evidence', async () => {
    const required = [requiredCheck()];
    for (const lifecycle of ['cancelled', 'timed-out', 'corrupt'] as const) {
      const observed = observedCheck({
        outcome: 'inconclusive',
        causeCode: 'ci.execution.attempt-inconclusive',
        nativeCauseCodes: [`execution.${lifecycle}`],
      });
      const diagnostic = makeDiagnostic('inconclusive', { code: 'ci.execution.attempt-inconclusive' });
      const admitted = await makeAdmittedResult({ ...diagnostic, aggregateDecision: 'inconclusive', requiredChecks: required, observedChecks: [observed] }, lifecycle);
      expect(admitted.store.readTerminalAttempt(admitted.result.attempt.id, admitted.result.attemptDigest, admitted.result.attempt, { now: NOW, expectedLease: admitted.expectedLease }).lifecycle).toBe(lifecycle);
      expect(aggregateOutcomes([admitted.result as never], { ...publicOutputOptions(), expectedChecks: required, attemptStore: admitted.store })).toBe('inconclusive');
    }
  });
});

describe('CP-F2 exact-set aggregation and thin native adapters', () => {
  it('requires exact required/observed tuples, trusted preconditions, and durable replay state', async () => {
    const required = [requiredCheck()];
    const fabricated = makeResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck()] });
    expect(aggregateOutcomes([fabricated as never], { ...validationOptions(), expectedChecks: required, attemptStore: await newEvidenceStore() })).toBe('inconclusive');
    const admitted = await makeAdmittedResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck()] });
    expect(aggregateOutcomes([admitted.result as never], { ...publicOutputOptions(), expectedChecks: required, attemptStore: admitted.store })).toBe('pass');
    const nonzeroPass = await makeAdmittedResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck()] }, 'terminal', 7);
    expect(() => validateControlResult(nonzeroPass.result as never, { ...publicOutputOptions(), expectedChecks: required })).toThrow(/direct status|outcome/i);
    expect(aggregateOutcomes([nonzeroPass.result as never], { ...publicOutputOptions(), expectedChecks: required, attemptStore: nonzeroPass.store })).toBe('inconclusive');
    const swappedEvidence = { ...admitted.result, observedChecks: [observedCheck({ id: 'substitute' })] };
    expect(() => validateControlResult(swappedEvidence as never, { ...publicOutputOptions(), expectedChecks: required })).toThrow(/attempt.*binding|evidence binding/i);
    const wrongScanner = await makeAdmittedResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck()] });
    expect(aggregateOutcomes([wrongScanner.result as never], { ...publicOutputOptions(), expectedScannerPolicyReceipt: { ...SCANNER_POLICY_RECEIPT, sourceOid: OID }, expectedChecks: required, attemptStore: wrongScanner.store })).toBe('inconclusive');
    expect(aggregateOutcomes([makeResult() as never], validationOptions() as never)).toBe('inconclusive');
    expect(aggregateOutcomes([makeResult() as never], { ...validationOptions(), expectedChecks: [requiredCheck(), requiredCheck({ id: 'second' })], attemptStore: await newEvidenceStore() })).toBe('inconclusive');
    expect(aggregateOutcomes([makeResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck()] }) as never], { ...validationOptions(), expectedChecks: required } as never)).toBe('inconclusive');
    expect(aggregateOutcomes([admitted.result as never], { ...validationOptions(), expectedChecks: required, attemptStore: new FileAttemptEvidenceStore(admitted.root) })).toBe('inconclusive');
    const tampered = await makeAdmittedResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck()] });
    writeFileSync(tampered.store.terminalPath(tampered.result.attempt.id), `${readFileSync(tampered.store.terminalPath(tampered.result.attempt.id), 'utf8')} `, 'utf8');
    expect(aggregateOutcomes([tampered.result as never], { ...validationOptions(), expectedChecks: required, attemptStore: tampered.store })).toBe('inconclusive');
    const historyTampered = await makeAdmittedResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck()] });
    const historyPath = path.join(historyTampered.root, 'attempt-1.history.0004.json');
    const alteredHistory = JSON.parse(readFileSync(historyPath, 'utf8')) as Record<string, unknown>;
    alteredHistory.lifecycle = 'corrupt';
    writeFileSync(historyPath, canonicalizeBoundaryRun(alteredHistory), 'utf8');
    expect(aggregateOutcomes([historyTampered.result as never], { ...publicOutputOptions(), expectedChecks: required, attemptStore: historyTampered.store })).toBe('inconclusive');
    const notApplicable = observedCheck({
      applicability: 'not-applicable', applicabilityReason: 'ci.classification.not-applicable',
      outcome: 'not-applicable', causeCode: 'ci.classification.not-applicable',
      nativeCauseCompleteness: 'not-applicable',
      producer: null, observedPlatform: null, classifierProof: classifierProof(),
      nativeSchemaVersion: null, evidenceDigest: null, createdAt: null, validUntil: null,
    });
    const admittedNotApplicable = await makeAdmittedResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [notApplicable] });
    expect(aggregateOutcomes([admittedNotApplicable.result as never], { ...publicOutputOptions(), expectedChecks: required, attemptStore: admittedNotApplicable.store })).toBe('pass');
    const otherProducer = { ...PRODUCER, appId: 'other-app' };
    const otherRequired = requiredCheck({ expectedProducer: otherProducer, expectedPlatform: { os: 'macos', architecture: 'arm64' } });
    const otherObserved = observedCheck({ expectedProducer: otherProducer, producer: otherProducer, expectedPlatform: { os: 'macos', architecture: 'arm64' }, observedPlatform: { os: 'macos', architecture: 'arm64' } });
    expect(aggregateOutcomes([makeResult({ aggregateDecision: 'pass', requiredChecks: [otherRequired], observedChecks: [otherObserved] }) as never], { ...validationOptions(), expectedChecks: required, attemptStore: await newEvidenceStore() })).toBe('inconclusive');
    expect(aggregateOutcomes([makeResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck({ outcome: 'block', causeCode: 'ci.check.passed' })] }) as never], { ...validationOptions(), expectedChecks: required, attemptStore: await newEvidenceStore() })).toBe('inconclusive');
    expect(aggregateOutcomes([makeResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck({ mergeOid: BASE_OID })] }) as never], { ...validationOptions(), expectedChecks: required, attemptStore: await newEvidenceStore() })).toBe('inconclusive');
    for (const observedChecks of [
      [],
      [observedCheck(), observedCheck()],
      [observedCheck(), observedCheck({ id: 'substitute' })],
      [observedCheck({ outcome: 'warn', causeCode: 'quality.semantic.finding.warning' })],
      [observedCheck({ validUntil: new Date(NOW - 1).toISOString() })],
    ]) {
      const aggregate = makeDiagnostic('inconclusive', { aggregateDecision: 'inconclusive', requiredChecks: required, observedChecks });
      expect(() => validateControlResult(aggregate as never, noNativeValidationOptions({ expectedChecks: required }))).toThrow(/observed|exact|duplicate|stale|outcome|aggregate|cause/i);
      expect(aggregateOutcomes([aggregate as never], { ...noNativeValidationOptions(), expectedChecks: required, attemptStore: await newEvidenceStore() })).toBe('inconclusive');
    }
  });

  it('preserves deterministic block precedence inside the one authoritative aggregate', async () => {
    const required = [requiredCheck(), requiredCheck({ id: 'second' })];
    const observed = [
      observedCheck({ outcome: 'block', causeCode: 'ci.native.semantic-quality', nativeCauseCodes: ['semantic.blocked-rule'] }),
      observedCheck({ id: 'second', outcome: 'inconclusive', causeCode: 'ci.execution.attempt-inconclusive', nativeCauseCodes: ['execution.timeout'] }),
    ];
    const admitted = await makeAdmittedResult({ ...makeDiagnostic('block'), aggregateDecision: 'block', requiredChecks: required, observedChecks: observed });
    expect(aggregateOutcomes([admitted.result as never], { ...publicOutputOptions(), expectedChecks: required, attemptStore: admitted.store })).toBe('block');
  });

  it('represents unavailable native causes with structural status and stable limitation codes', () => {
    const required = [requiredCheck()];
    const observed = {
      ...observedCheck({ outcome: 'inconclusive', causeCode: 'ci.execution.attempt-inconclusive', nativeCauseCodes: [] }),
      nativeCauseCompleteness: 'unavailable',
      nativeStatusRefs: ['manifest.active'],
      limitationCodes: ['ci.native.cause-code-unavailable', 'ci.native.progress-only'],
    };
    const aggregate = makeDiagnostic('inconclusive', { code: 'ci.execution.attempt-inconclusive', aggregateDecision: 'inconclusive', requiredChecks: required, observedChecks: [observed] });
    expect(validateControlResult(aggregate as never, noNativeValidationOptions({ expectedChecks: required })).outcome).toBe('inconclusive');
  });

  it('admits truthful active boundary-run evidence as durable aggregate inconclusive', async () => {
    const native = validManifest();
    const nativeEvidenceDigest = digest(canonicalizeBoundaryRun(native));
    const binding = {
      detectorId: 'boundary-run' as const,
      schemaVersion: 1 as const,
      evidenceDigest: nativeEvidenceDigest,
      policyDigest: DIGEST,
      candidateOid: BOUNDARY_OID,
      baseOid: null,
      mergeBaseOid: null,
      producer: PRODUCER,
      platform: { os: 'linux', architecture: 'x64' },
    };
    const projection = adaptBoundaryRun(native, binding);
    const preconditions = makePreconditions({
      workspace: { ...(makePreconditions().workspace as object), headOid: BOUNDARY_OID, candidateOid: BOUNDARY_OID, baseOid: null, mergeOid: null },
    });
    const required = [requiredCheck({ id: 'boundary-run', candidateOid: BOUNDARY_OID, mergeOid: null })];
    const observed = observedCheck({
      id: 'boundary-run',
      candidateOid: BOUNDARY_OID,
      mergeOid: null,
      outcome: projection.outcome,
      causeCode: projection.code,
      nativeCauseCodes: projection.nativeCauseCodes,
      nativeCauseCompleteness: projection.nativeCauseCompleteness,
      nativeStatusRefs: projection.nativeStatusRefs,
      limitationCodes: projection.limitationCodes,
      evidenceDigest: projection.evidenceDigest,
    });
    const diagnostic = makeDiagnostic('inconclusive', {
      code: 'ci.execution.attempt-inconclusive',
      controlId: 'boundary-run',
      candidateOid: BOUNDARY_OID,
      baseOid: null,
      mergeOid: null,
      preconditionReceipt: preconditions,
    });
    const admitted = await makeAdmittedResult({ ...diagnostic, aggregateDecision: 'inconclusive', requiredChecks: required, observedChecks: [observed] });
    const boundaryOptions: ControlValidationOptions & {
      expectedChecks: readonly unknown[];
      expectedLease: SupervisorLeaseExpectationsV1;
    } = {
      ...noNativePublicOutputOptions(),
      expectedPreconditions: expectedPreconditions(preconditions),
      expectedChecks: required,
      expectedBindings: {
        candidateOid: BOUNDARY_OID,
        baseOid: null,
        mergeOid: null,
        manifestDigest: DIGEST,
        policyDigest: DIGEST,
        classifierDigest: DIGEST,
        producer: PRODUCER,
        toolDigest: DIGEST,
      },
      expectedFindingGraph: [{ findingId: 'finding-1', rootCauseId: 'finding-1', causedBy: [], candidateOid: BOUNDARY_OID, policyDigest: DIGEST }],
    };
    expect(validateControlResult(admitted.result as never, boundaryOptions).aggregateDecision).toBe('inconclusive');
    expect(admitted.result.attempt.evidenceBinding).toEqual({
      controlId: 'boundary-run',
      candidateOid: BOUNDARY_OID,
      manifestDigest: admitted.result.manifestDigest,
      policyDigest: admitted.result.policyDigest,
      toolDigest: admitted.result.tool.digest,
      platformDigest: digest(canonicalizeBoundaryRun(admitted.result.platform)),
      preconditionDigest: preconditionDigest(preconditions, { now: NOW, expected: expectedPreconditions(preconditions) }),
      producerDigest: digest(canonicalizeBoundaryRun(admitted.result.producer)),
      scannerPolicyReceiptDigest: digest(canonicalizeBoundaryRun(admitted.result.scannerPolicyReceipt)),
      resultEvidenceDigest: controlResultEvidenceDigest(admitted.result),
    });
    expect(aggregateOutcomes([admitted.result as never], {
      ...boundaryOptions,
      attemptStore: admitted.store,
    })).toBe('inconclusive');
  });

  it('adapts a real semantic receipt only with independent exact bindings', () => {
    const native = buildBoundaryReceipt({
      invocation: 'semantic-quality', action: 'push', enforcementMode: 'enforce',
      base: { headOid: OID, baseOid: BASE_OID, mergeBaseOid: BASE_OID, evidenceSource: 'git-object' },
      findings: [],
    });
    const evidenceDigest = digest(canonicalizeBoundaryRun(native));
    const binding = { detectorId: 'semantic-quality' as const, schemaVersion: 1 as const, evidenceDigest, policyDigest: DIGEST, candidateOid: OID, baseOid: BASE_OID, mergeBaseOid: BASE_OID, producer: PRODUCER, platform: { os: 'linux', architecture: 'x64' } };
    expect(adaptSemanticQuality(native, binding)).toMatchObject({ outcome: 'pass', nativeCauseCodes: [], nativeCauseCompleteness: 'complete', nativeStatusRefs: [], limitationCodes: [], evidenceDigest, policyDigest: DIGEST, producer: binding.producer, platform: binding.platform });
    expect(adaptSemanticQuality(native, { ...binding, evidenceDigest: OTHER_DIGEST })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    expect(adaptSemanticQuality(native, { ...binding, candidateOid: BASE_OID })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    expect(adaptSemanticQuality(native, { ...binding, baseOid: OID })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    expect(adaptSemanticQuality(native, { ...binding, mergeBaseOid: OID })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    const finding = (ruleId: string, decision: 'block' | 'warn' = 'block') => ({ ruleId, decision, action: 'push' as const, summary: 'Synthetic complete native finding for adapter preservation.', why: 'The adapter must preserve every validated native cause without recomputing policy.', observed: [{ label: 'fixture', value: 'synthetic' }], matchedArtifacts: [], correction: ['Repair the canonical native owner.'], rerun: 'npm run verify:semantic', sourceRefs: ['fixture:ci-control-result'] });
    const blocked = buildBoundaryReceipt({ invocation: 'semantic-quality', action: 'push', enforcementMode: 'enforce', base: { headOid: OID, baseOid: BASE_OID, mergeBaseOid: BASE_OID, evidenceSource: 'git-object' }, findings: [finding('semantic.second'), finding('semantic.first')] });
    const blockedDigest = digest(canonicalizeBoundaryRun(blocked));
    expect(adaptSemanticQuality(blocked, { ...binding, evidenceDigest: blockedDigest })).toMatchObject({ outcome: 'block', nativeCauseCodes: ['semantic.first', 'semantic.second'] });
    const warned = buildBoundaryReceipt({ invocation: 'semantic-quality', action: 'push', enforcementMode: 'enforce', base: { headOid: OID, baseOid: BASE_OID, mergeBaseOid: BASE_OID, evidenceSource: 'git-object' }, findings: [finding('semantic.warning', 'warn')] });
    const warnedDigest = digest(canonicalizeBoundaryRun(warned));
    expect(adaptSemanticQuality(warned, { ...binding, evidenceDigest: warnedDigest })).toMatchObject({ outcome: 'warn', code: 'quality.semantic.finding.warning', nativeCauseCodes: ['semantic.warning'] });
    const safe = buildBoundaryReceipt({ invocation: 'semantic-quality', action: 'push', enforcementMode: 'enforce', base: { headOid: OID, baseOid: BASE_OID, mergeBaseOid: BASE_OID, evidenceSource: 'git-object' }, findings: [] });
    const safeDigest = digest(canonicalizeBoundaryRun(safe));
    expect(adaptSemanticQuality(safe, { ...binding, evidenceDigest: safeDigest })).toMatchObject({ outcome: 'pass', code: 'ci.check.passed', nativeCauseCodes: [] });
    expect(adaptSemanticQuality(warned, { ...binding, evidenceDigest: DIGEST })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
  });

  it('uses the canonical boundary-run validator and refuses active progress as terminal evidence', () => {
    const native = validManifest();
    const evidenceDigest = digest(canonicalizeBoundaryRun(native));
    const binding = { detectorId: 'boundary-run' as const, schemaVersion: 1 as const, evidenceDigest, policyDigest: DIGEST, candidateOid: BOUNDARY_OID, baseOid: null, mergeBaseOid: null, producer: PRODUCER, platform: { os: 'linux', architecture: 'x64' } };
    expect(adaptBoundaryRun(native, binding)).toMatchObject({
      outcome: 'inconclusive',
      code: 'ci.execution.attempt-inconclusive',
      nativeCauseCodes: [],
      nativeCauseCompleteness: 'unavailable',
      nativeStatusRefs: ['manifest.active'],
    });
    expect(adaptBoundaryRun(native, { ...binding, baseOid: BASE_OID })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    expect(adaptBoundaryRun(native, { ...binding, mergeBaseOid: BASE_OID })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    expect(adaptBoundaryRun({ ...native, extra: true }, binding)).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(adaptBoundaryRun(cyclic, binding)).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
  });

  it('thin-adapts real owner receipts without fabricating authority fields', async () => {
    const fixture = await exactRangeFixture();
    const repoBlockExpected = fixture.repoExpected(fixture.repoBlock, fixture.unsafeOid);
    const publicationBlockExpected = fixture.publicationExpected(fixture.publicationBlock, fixture.unsafeOid);

    const repoBlock = adaptRepoHygieneExactRangeReportOnly(fixture.repoBlock, repoBlockExpected);
    const publicationBlock = adaptPublicationExactRangeReportOnly(
      fixture.publicationBlock,
      publicationBlockExpected,
    );
    const repoPass = adaptRepoHygieneExactRangeReportOnly(
      fixture.repoPass,
      fixture.repoExpected(fixture.repoPass, fixture.safeOid),
    );
    const publicationPass = adaptPublicationExactRangeReportOnly(
      fixture.publicationPass,
      fixture.publicationExpected(fixture.publicationPass, fixture.safeOid),
    );

    expect(repoBlock).toMatchObject({
      authorization: 'report-only',
      outcome: 'block',
      code: 'ci.native.repository-hygiene.finding',
      nativeCauseCompleteness: 'complete',
      externalPayloadSha256: fixture.repoBlock.binding.payloadSha256,
    });
    expect(publicationBlock).toMatchObject({
      authorization: 'report-only',
      outcome: 'block',
      code: 'ci.native.privacy-publication.finding',
      nativeCauseCompleteness: 'complete',
      externalPayloadSha256: fixture.publicationBlock.binding.payloadSha256,
    });
    expect(repoBlock.externalPayloadSha256).toBe(repoBlockExpected.expectedPayloadSha256);
    expect(publicationBlock.externalPayloadSha256).toBe(publicationBlockExpected.expectedPayloadSha256);
    expect(repoPass).toMatchObject({ outcome: 'pass', code: 'ci.check.passed', nativeCauseCompleteness: 'complete' });
    expect(publicationPass).toMatchObject({ outcome: 'pass', code: 'ci.check.passed', nativeCauseCompleteness: 'complete' });
    for (const observation of [repoBlock, publicationBlock, repoPass, publicationPass]) {
      expect(Object.keys(observation).sort()).toEqual([
        'authorization', 'code', 'externalPayloadSha256', 'limitationCodes',
        'nativeCauseCodes', 'nativeCauseCompleteness', 'nativeReceipt', 'nativeStatusRefs', 'outcome',
      ].sort());
      expect(Object.isFrozen(observation)).toBe(true);
      expect(Object.isFrozen(observation.nativeCauseCodes)).toBe(true);
      expect(Object.isFrozen(observation.nativeStatusRefs)).toBe(true);
      expect(Object.isFrozen(observation.limitationCodes)).toBe(true);
      expect(Object.isFrozen(observation.nativeReceipt)).toBe(true);
      expect(Object.isFrozen(observation.nativeReceipt?.limitations)).toBe(true);
      expect(observation.nativeReceipt?.authorization).toBe('report-only');
      expect(observation.nativeCauseCodes).toBe(observation.nativeReceipt?.nativeCauses);
      expect(observation.nativeReceipt?.limitations.length).toBeGreaterThan(0);
      expect(observation.limitationCodes).toEqual([]);
      expect(observation.nativeStatusRefs).toEqual([]);
      expect(() => Object.assign(observation, { outcome: 'inconclusive' })).toThrow();
      expect(() => Object.assign(observation.nativeStatusRefs, { 0: 'mutated' })).toThrow();
      expect(() => Object.assign(observation.limitationCodes, { 0: 'mutated' })).toThrow();
      expect(observation).not.toHaveProperty('producer');
      expect(observation).not.toHaveProperty('platform');
      expect(observation).not.toHaveProperty('nativeEvidence');
      expect(observation).not.toHaveProperty('aggregateDecision');
      expect(observation).not.toHaveProperty('attempt');
      expect(observation).not.toHaveProperty('preconditionReceipt');
    }
    expect(repoBlock.nativeCauseCodes).toEqual(['github-token']);
    expect(publicationBlock.nativeCauseCodes).toEqual(['github-token']);
    expect(repoPass.nativeCauseCodes).toEqual([]);
    expect(publicationPass.nativeCauseCodes).toEqual([]);
  });

  it('fails closed with the native validator status for invalid exact-range evidence', async () => {
    const fixture = await exactRangeFixture();
    const repoExpected = fixture.repoExpected(fixture.repoBlock, fixture.unsafeOid);
    const publicationExpected = fixture.publicationExpected(fixture.publicationBlock, fixture.unsafeOid);
    const wrongOid = 'f'.repeat(40);

    const cases: Array<{ observation: NativeExactRangeReportOnlyObservationV1; status: string }> = [
      {
        observation: adaptRepoHygieneExactRangeReportOnly(
          { ...fixture.repoBlock, payloadBytes: Uint8Array.of(0xff) },
          repoExpected,
        ),
        status: 'repo-hygiene.exact-range.receipt-invalid',
      },
      {
        observation: adaptRepoHygieneExactRangeReportOnly(fixture.repoBlock, { ...repoExpected, expectedPayloadSha256: OTHER_DIGEST }),
        status: 'repo-hygiene.exact-range.receipt-binding-mismatch',
      },
      {
        observation: adaptRepoHygieneExactRangeReportOnly(fixture.repoBlock, { ...repoExpected, localOid: wrongOid }),
        status: 'repo-hygiene.exact-range.identity-mismatch',
      },
      {
        observation: adaptRepoHygieneExactRangeReportOnly(fixture.repoBlock, { ...repoExpected, currentToolDigest: OTHER_DIGEST }),
        status: 'repo-hygiene.exact-range.tool-mismatch',
      },
      {
        observation: adaptRepoHygieneExactRangeReportOnly(fixture.repoBlock, { ...repoExpected, currentPolicyDigest: OTHER_DIGEST }),
        status: 'repo-hygiene.exact-range.policy-mismatch',
      },
      {
        observation: adaptPublicationExactRangeReportOnly(
          { ...fixture.publicationBlock, binding: { ...fixture.publicationBlock.binding, detectorId: 'wrong-detector' as never } },
          publicationExpected,
        ),
        status: 'publication.exact-range.receipt-invalid',
      },
      {
        observation: adaptPublicationExactRangeReportOnly(
          fixture.publicationBlock,
          { ...publicationExpected, expectedPayloadSha256: OTHER_DIGEST },
        ),
        status: 'publication.exact-range.receipt-binding-mismatch',
      },
      {
        observation: adaptPublicationExactRangeReportOnly(fixture.publicationBlock, { ...publicationExpected, localOid: wrongOid }),
        status: 'publication.exact-range.identity-mismatch',
      },
      {
        observation: adaptPublicationExactRangeReportOnly(
          fixture.publicationBlock,
          { ...publicationExpected, currentPolicyDigest: OTHER_DIGEST },
        ),
        status: 'publication.exact-range.receipt-invalid',
      },
    ];
    for (const { observation, status } of cases) {
      expect(observation).toEqual({
        authorization: 'report-only',
        outcome: 'inconclusive',
        code: 'ci.native.receipt-unavailable',
        nativeCauseCodes: [],
        nativeCauseCompleteness: 'unavailable',
        nativeStatusRefs: [status],
        limitationCodes: ['ci.native.evidence-unavailable'],
        nativeReceipt: null,
        externalPayloadSha256: null,
      });
      expect(Object.isFrozen(observation)).toBe(true);
      expect(Object.isFrozen(observation.nativeCauseCodes)).toBe(true);
      expect(Object.isFrozen(observation.nativeStatusRefs)).toBe(true);
      expect(Object.isFrozen(observation.limitationCodes)).toBe(true);
      expect(() => Object.assign(observation, { outcome: 'pass' })).toThrow();
      expect(() => Object.assign(observation.nativeStatusRefs, { 0: 'mutated' })).toThrow();
    }

    const repoReceipt = JSON.parse(Buffer.from(fixture.repoBlock.payloadBytes).toString('utf8')) as { validUntil: string };
    const publicationReceipt = JSON.parse(
      Buffer.from(fixture.publicationBlock.payloadBytes).toString('utf8'),
    ) as { validUntil: string };
    vi.useFakeTimers();
    vi.setSystemTime(Math.max(Date.parse(repoReceipt.validUntil), Date.parse(publicationReceipt.validUntil)) + 1);
    expect(adaptRepoHygieneExactRangeReportOnly(fixture.repoBlock, repoExpected).nativeStatusRefs)
      .toEqual(['repo-hygiene.exact-range.receipt-stale']);
    expect(adaptPublicationExactRangeReportOnly(fixture.publicationBlock, publicationExpected).nativeStatusRefs)
      .toEqual(['publication.exact-range.receipt-stale']);
  });

  it('rejects colluding repo-hygiene receipt and expected digests independently', async () => {
    const fixture = await exactRangeFixture();
    const rebound = reboundRepoArtifact(fixture.repoBlock, (payload) => {
      payload.toolDigest = OTHER_DIGEST;
      payload.policyDigest = OTHER_DIGEST;
    });
    const colludingExpected: RepoHygieneExactRangeExpectedV1 = {
      ...fixture.repoExpected(rebound, fixture.unsafeOid),
      currentToolDigest: OTHER_DIGEST,
      currentPolicyDigest: OTHER_DIGEST,
    };
    expect(validateRepoHygieneExactRangeArtifact(rebound, colludingExpected).ok).toBe(true);
    expect(adaptRepoHygieneExactRangeReportOnly(rebound, colludingExpected)).toEqual({
      authorization: 'report-only',
      outcome: 'inconclusive',
      code: 'ci.native.receipt-unavailable',
      nativeCauseCodes: [],
      nativeCauseCompleteness: 'unavailable',
      nativeStatusRefs: ['repo-hygiene.exact-range.tool-mismatch'],
      limitationCodes: ['ci.native.evidence-unavailable'],
      nativeReceipt: null,
      externalPayloadSha256: null,
    });
  });
});
