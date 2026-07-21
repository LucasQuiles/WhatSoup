import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
} from '../../scripts/lib/ci-control/result.ts';
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
  adaptSemanticQuality,
} from '../../scripts/lib/ci-control/native-adapter.ts';
import { buildBoundaryReceipt } from '../../scripts/lib/semantic-quality/receipt.ts';
import { canonicalizeBoundaryRun } from '../../scripts/lib/verification/boundary-run/shared.ts';
import { OID as BOUNDARY_OID, validManifest } from './verify-boundary-run/support.ts';

const OID = '0123456789abcdef0123456789abcdef01234567';
const BASE_OID = '89abcdef89abcdef89abcdef89abcdef89abcdef';
const MERGE_OID = 'fedcba98fedcba98fedcba98fedcba98fedcba98';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = Date.now();
const PRECONDITION_AT = new Date(NOW - 10 * 60_000).toISOString();
const ATTEMPT_CREATED_AT = new Date(NOW - 9 * 60_000).toISOString();
const ATTEMPT_TERMINAL_AT = new Date(NOW - 8 * 60_000).toISOString();
const ATTEMPT_LEASE_AT = new Date(NOW - 8.75 * 60_000).toISOString();
const SUPERVISOR_TERMINAL_AT = new Date(NOW - 8.25 * 60_000).toISOString();
const RESULT_CREATED_AT = new Date(NOW - 7 * 60_000).toISOString();
const VALID_UNTIL = new Date(NOW + 60 * 60_000).toISOString();
const SCANNER_POLICY_RECEIPT = {
  schemaVersion: 1,
  policyDigest: DIGEST,
  sourceOid: BASE_OID,
  toolDigest: DIGEST,
  sources: [
    { path: 'scripts/lib/guard-core.ts', blobOid: BASE_OID },
    { path: 'scripts/publication-guard.ts', blobOid: OID },
  ],
  producer: { appId: 'protected-policy-app', workflowSha: BASE_OID },
};

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
  return { now: NOW, expectedPreconditions: expectedPreconditions(), expectedLease: leaseExpectations(), ...overrides } as ControlValidationOptions & { expectedLease: SupervisorLeaseExpectationsV1 };
}

function publicOutputOptions(forbiddenValues: readonly string[] = []) {
  return {
    ...validationOptions(),
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
  const producer = { appId: 'expected-app', workflowRef: 'owner/repo/.github/workflows/policy.yml@refs/heads/main', workflowSha: OID, runId: 'run-1', attempt: 1 };
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
      preconditionDigest: preconditionDigest(makePreconditions()),
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
    expectedProducer: { appId: 'expected-app', workflowSha: OID },
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
    expectedProducer: { appId: 'expected-app', workflowSha: OID },
    expectedPlatform: { os: 'linux', architecture: 'x64' },
    producer: { appId: 'expected-app', workflowSha: OID },
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
    producer: { appId: 'expected-app', workflowSha: OID },
    createdAt: RESULT_CREATED_AT,
    validUntil: VALID_UNTIL,
    ...overrides,
  };
}

function makeResult(overrides: Record<string, unknown> = {}) {
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
    severity: 'low',
    confidence: 'proven',
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
    producer: { appId: 'expected-app', workflowRef: 'owner/repo/.github/workflows/policy.yml@refs/heads/main', workflowSha: OID, runId: 'run-1', attempt: 1 },
    tool: { name: 'ci-control-plane', version: '1', digest: DIGEST },
    platform: { runnerLabel: 'ubuntu-24.04', os: 'linux', architecture: 'x64', runtime: 'node@24.15.0', observedCapabilitiesDigest: DIGEST },
    scannerPolicyReceipt: SCANNER_POLICY_RECEIPT,
    preconditionReceipt: makePreconditions(),
    attempt: makeAttempt(),
    attemptDigest: terminalAttemptDigest(makeAttempt() as never),
    risk: { tier: 'standard', reasons: ['source-change'] },
    requiredChecks: [],
    observedChecks: [],
    findingId: null,
    location: null,
    why: null,
    impact: null,
    guidance: [],
    patchScope: { allowed: [], prohibited: [] },
    reproduce: { command: 'npm run verify:pr', preconditions: [] },
    verify: { commands: [], expected: [] },
    retryable: false,
    retryConditions: [],
    exception: { eligible: false, approvalRole: null },
    relatedFindings: [],
    fingerprint: null,
    limitations: [],
    createdAt: RESULT_CREATED_AT,
    validUntil: VALID_UNTIL,
    ...overrides,
  };
  if (overrides.attempt === undefined) {
    result.attempt = makeAttempt({
      rawExit: result.exitCode,
      evidenceBinding: {
        controlId: result.controlId,
        candidateOid: result.candidateOid,
        manifestDigest: result.manifestDigest,
        policyDigest: result.policyDigest,
        toolDigest: (result.tool as { digest: string }).digest,
        platformDigest: digest(canonicalizeBoundaryRun(result.platform)),
        preconditionDigest: preconditionDigest(result.preconditionReceipt as never),
        producerDigest: digest(canonicalizeBoundaryRun(result.producer)),
        scannerPolicyReceiptDigest: digest(canonicalizeBoundaryRun(result.scannerPolicyReceipt)),
        resultEvidenceDigest: controlResultEvidenceDigest(result),
      },
    });
  }
  if (overrides.attemptDigest === undefined) result.attemptDigest = terminalAttemptDigest(result.attempt as never);
  return result;
}

function makeDiagnostic(outcome: 'warn' | 'block' | 'inconclusive', overrides: Record<string, unknown> = {}) {
  const result = makeResult({
    outcome,
    exitCode: exitCodeForOutcome(outcome),
    code: outcome === 'warn' ? 'ci.required-check.warning-only' : outcome === 'block' ? 'ci.native.semantic-quality' : 'ci.required-check.missing',
    severity: outcome === 'warn' ? 'medium' : 'high',
    findingId: 'finding-1',
    location: { kind: 'manifest-key', name: 'controls.semantic-quality' },
    why: 'The required evidence did not prove the declared boundary.',
    impact: 'The exact candidate cannot be authorized.',
    guidance: ['Repair the named precondition.', 'Replay the focused check.'],
    patchScope: { allowed: ['canonical adapter'], prohibited: ['continue-on-error', 'permission broadening'] },
    reproduce: { command: 'npm run verify:pr', preconditions: ['exact Git objects exist'] },
    verify: { commands: ['npm run test:focused', 'npm run test:affected'], expected: ['unsafe fixture fails', 'safe neighbor passes'] },
    retryable: outcome === 'inconclusive',
    retryConditions: outcome === 'inconclusive' ? ['named precondition is repaired'] : [],
    exception: { eligible: false, approvalRole: null },
    relatedFindings: ['dependent-fixture'],
    limitations: ['no protected producer is claimed'],
    ...overrides,
  });
  return { ...result, fingerprint: buildFindingFingerprint(result as never) };
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
    expect(validateControlResult(makeDiagnostic('inconclusive'), validationOptions()).outcome).toBe('inconclusive');
    expect(validateControlResult(makeResult({ outcome: 'not-applicable', code: 'ci.classification.not-applicable', applicability: 'not-applicable', applicabilityReason: 'ci.classification.not-applicable', classifierProof: classifierProof() }), validationOptions()).outcome).toBe('not-applicable');
  });

  it('rejects outcome/exit mismatches and incomplete or generic diagnostics', () => {
    expect(() => validateControlResult(makeResult({ outcome: 'block' }), validationOptions())).toThrow(/exit|outcome/i);
    expect(() => validateControlResult(makeDiagnostic('block', { why: 'CI failed' }), validationOptions())).toThrow(/generic|diagnostic/i);
    expect(() => validateControlResult(makeDiagnostic('block', { owner: '' }), validationOptions())).toThrow(/owner|diagnostic/i);
    expect(() => validateControlResult(makeDiagnostic('block', { guidance: [] }), validationOptions())).toThrow(/guidance|diagnostic/i);
  });

  it('requires trusted closed classifier proof for not-applicable and rejects skipped substitutes', () => {
    expect(() => validateControlResult(makeResult({ outcome: 'not-applicable', code: 'ci.classification.not-applicable', applicability: 'not-applicable', applicabilityReason: null }), validationOptions())).toThrow(/applicab/i);
    expect(() => validateControlResult(makeResult({ outcome: 'not-applicable', code: 'ci.classification.not-applicable', applicability: 'not-applicable', applicabilityReason: 'ci.classification.not-applicable', classifierProof: classifierProof({ candidateOid: BASE_OID }) }), validationOptions())).toThrow(/classifier|binding/i);
    const skipped = observedCheck({ applicability: 'not-applicable', applicabilityReason: null, outcome: 'pass', producer: null, observedPlatform: null, nativeSchemaVersion: null, evidenceDigest: null, createdAt: null, validUntil: null });
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck()], observedChecks: [skipped] }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/applicab|not-applicable|exact/i);
  });

  it('does not permit registered reason codes to change outcome semantics', () => {
    expect(() => validateControlResult(makeDiagnostic('block', { code: 'ci.check.passed' }), validationOptions())).toThrow(/taxonomy|code.*outcome/i);
    expect(() => validateControlResult(makeResult({ code: 'ci.required-check.missing' }), validationOptions())).toThrow(/taxonomy|code.*outcome/i);
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
  it('rejects duplicate JSON keys, invalid UTF-8, and oversized bytes before parsing', () => {
    expect(() => parseControlResultJson('{"schemaVersion":1,"schemaVersion":1}')).toThrow(/duplicate/i);
    expect(() => parseControlResultJson(Buffer.from([0xff]))).toThrow(/utf-8|json/i);
    expect(() => parseControlResultJson(Buffer.alloc(32_769, 0x20))).toThrow(/byte budget/i);
  });

  it('enforces string and list budgets at the limit and one over, including multibyte text', () => {
    const atLimit = makeDiagnostic('inconclusive', { why: 'é'.repeat(1_024) });
    expect(validateControlResult(atLimit, validationOptions()).why).toBe(atLimit.why);
    expect(() => validateControlResult(makeDiagnostic('inconclusive', { why: `${'é'.repeat(1_024)}x` }), validationOptions())).toThrow(/byte|string|budget/i);
    expect(() => validateControlResult(makeDiagnostic('inconclusive', { guidance: Array.from({ length: 65 }, () => 'repair') }), validationOptions())).toThrow(/list|budget|guidance/i);
  });

  it('uses one deterministic byte projection for serialization and hashing', () => {
    const result = validateControlResult(makeResult(), validationOptions());
    const outputOptions = publicOutputOptions();
    const bytes = canonicalizeControlResult(result, outputOptions);
    expect(serializeControlResult(result, outputOptions)).toBe(Buffer.from(bytes).toString('utf8'));
    expect(hashControlResult(result, outputOptions)).toBe(digest(Buffer.from(bytes).toString('utf8')));
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

  it('renders actionable feedback from the validated object and rejects unsafe public text', () => {
    const result = makeDiagnostic('inconclusive');
    const rendered = renderControlResult(result as never, publicOutputOptions());
    for (const text of [
      result.code, result.owner, result.canonicalImplementationOwner, result.domain,
      result.operation, result.trustClass, result.severity, result.confidence,
      result.candidateOid, result.baseOid, result.mergeOid, result.manifestDigest,
      result.policyDigest, result.why, result.impact, ...result.guidance,
      ...result.patchScope.allowed, ...result.patchScope.prohibited,
      result.reproduce.command, ...result.reproduce.preconditions,
      ...result.verify.commands, ...result.verify.expected,
      ...result.retryConditions, ...result.relatedFindings, ...result.limitations,
    ]) expect(rendered).toContain(text);
    expect(rendered).toContain('Exception: Not eligible');
    const privateMatch = 'local-secret-label';
    const absolutePath = ['', 'Users', 'person', 'private', 'file'].join('/');
    expect(() => validateControlResult(makeDiagnostic('block', { why: `Matched ${privateMatch}` }), validationOptions({ forbiddenValues: [privateMatch] }))).toThrow(/unsafe|private|public/i);
    expect(() => validateControlResult(makeDiagnostic('block', { why: absolutePath }), validationOptions())).toThrow(/absolute|unsafe|public/i);
    expect(() => validateControlResult(makeDiagnostic('block', { why: createHash('sha256').update(privateMatch).digest('hex') }), validationOptions({ forbiddenValues: [privateMatch] }))).toThrow(/unsafe|fingerprint|public/i);
    expect(() => renderControlResult(makeDiagnostic('block', { why: `Matched ${privateMatch}` }) as never, publicOutputOptions([privateMatch]))).toThrow(/unsafe|private|public|scan/i);
    expect(() => renderControlResult(makeDiagnostic('block', { why: `token=${privateMatch}` }) as never, publicOutputOptions())).toThrow(/unsafe|private|public|scan/i);
    const scannerOnlyMatch = ['ghp', 'A'.repeat(16)].join('_');
    const scannerOnlyResult = makeDiagnostic('block', { why: `Matched ${scannerOnlyMatch}` });
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
    expect(() => validateControlResult({ ...result, fingerprint: `fp:v1:${'0'.repeat(64)}` }, validationOptions())).toThrow(/fingerprint/i);
  });
});

describe('CP-F2 precondition and terminal evidence', () => {
  it('validates complete preconditions and makes setup failures inconclusive', () => {
    const receipt = makePreconditions();
    expect(validatePreconditionReceipt(receipt, { now: NOW, expected: expectedPreconditions() })).toEqual(receipt);
    expect(preconditionDigest(receipt as never)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => validatePreconditionReceipt(makePreconditions({ runtime: { name: 'node', version: 'unsupported', digest: DIGEST } }), { now: NOW, expected: expectedPreconditions() })).toThrow(/trusted|runtime|precondition/i);
    for (const mutation of [
      { runtime: { name: 'node', version: 'unsupported', digest: DIGEST }, outcome: 'inconclusive' },
      { installScopes: [], outcome: 'inconclusive' },
      { fixture: { created: false, digest: DIGEST }, outcome: 'inconclusive' },
    ]) {
      expect(() => validateControlResult(makeDiagnostic('block', { preconditionReceipt: makePreconditions(mutation) }), validationOptions())).toThrow(/precondition|inconclusive/i);
      expect(() => validateControlResult(makeDiagnostic('inconclusive', { preconditionReceipt: makePreconditions(mutation) }), validationOptions())).toThrow(/precondition|cause|code/i);
      expect(validateControlResult(makeDiagnostic('inconclusive', { code: 'ci.input.precondition-unproven', preconditionReceipt: makePreconditions(mutation) }), validationOptions()).outcome).toBe('inconclusive');
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
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck()], observedChecks: [observedCheck({ producer: { appId: 'other-app', workflowSha: OID } })] }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/producer|tuple|exact/i);
    expect(() => validateControlResult(makeResult({ createdAt: new Date(NOW + 10 * 60_000).toISOString(), validUntil: new Date(NOW + 20 * 60_000).toISOString() }), validationOptions())).toThrow(/future|stale/i);
    expect(() => validateControlResult(makeResult({ createdAt: new Date(NOW + 4 * 60_000).toISOString(), validUntil: new Date(NOW + 60_000).toISOString() }), validationOptions())).toThrow(/interval|timestamp|fresh/i);
    expect(() => validateControlResult(makeResult({ aggregateDecision: 'pass', requiredChecks: [requiredCheck()], observedChecks: [observedCheck({ createdAt: new Date(NOW + 4 * 60_000).toISOString(), validUntil: new Date(NOW + 60_000).toISOString() })] }), validationOptions({ expectedChecks: [requiredCheck()] }))).toThrow(/interval|timestamp|fresh/i);
    expect(() => validateControlResult(makeResult({ outcome: 'not-applicable', code: 'ci.classification.not-applicable', applicability: 'not-applicable', applicabilityReason: 'ci.classification.not-applicable', classifierProof: classifierProof({ createdAt: new Date(NOW + 4 * 60_000).toISOString(), validUntil: new Date(NOW + 60_000).toISOString() }) }), validationOptions())).toThrow(/interval|timestamp|fresh/i);
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
    expect(validateTerminalAttempt(makeAttempt()).lifecycle).toBe('terminal');
    expect(transitionAttempt('created', 'running')).toBe('running');
    expect(transitionAttempt('running', 'finalizing')).toBe('finalizing');
    expect(() => transitionAttempt('created', 'cancelled')).toThrow(/transition/i);
    expect(() => transitionAttempt('running', 'timed-out')).toThrow(/transition/i);
    expect(() => transitionAttempt('terminal', 'running')).toThrow(/transition/i);
    for (const lifecycle of ['cancelled', 'timed-out', 'corrupt']) expect(validateTerminalAttempt(makeAttempt({ lifecycle, rawExit: null, rawSignal: 'SIGTERM', timedOut: lifecycle === 'timed-out' })).lifecycle).toBe(lifecycle);
    expect(() => validateTerminalAttempt(makeAttempt({ lifecycle: 'running', terminalAt: null }))).toThrow(/terminal|lifecycle/i);
    expect(() => validateTerminalAttempt({ ...makeAttempt(), terminationProof: { ...(makeAttempt().terminationProof as object), status: 'running' } })).toThrow(/termination|process group/i);
    expect(() => validateTerminalAttempt({ ...makeAttempt(), terminationProof: { ...(makeAttempt().terminationProof as object), supervisorDigest: OTHER_DIGEST } })).toThrow(/supervisor|binding/i);
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
    const otherRequired = requiredCheck({ expectedProducer: { appId: 'other-app', workflowSha: OID }, expectedPlatform: { os: 'macos', architecture: 'arm64' } });
    const otherObserved = observedCheck({ expectedProducer: { appId: 'other-app', workflowSha: OID }, producer: { appId: 'other-app', workflowSha: OID }, expectedPlatform: { os: 'macos', architecture: 'arm64' }, observedPlatform: { os: 'macos', architecture: 'arm64' } });
    expect(aggregateOutcomes([makeResult({ aggregateDecision: 'pass', requiredChecks: [otherRequired], observedChecks: [otherObserved] }) as never], { ...validationOptions(), expectedChecks: required, attemptStore: await newEvidenceStore() })).toBe('inconclusive');
    expect(aggregateOutcomes([makeResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck({ outcome: 'block', causeCode: 'ci.check.passed' })] }) as never], { ...validationOptions(), expectedChecks: required, attemptStore: await newEvidenceStore() })).toBe('inconclusive');
    expect(aggregateOutcomes([makeResult({ aggregateDecision: 'pass', requiredChecks: required, observedChecks: [observedCheck({ mergeOid: BASE_OID })] }) as never], { ...validationOptions(), expectedChecks: required, attemptStore: await newEvidenceStore() })).toBe('inconclusive');
    for (const observedChecks of [
      [],
      [observedCheck(), observedCheck()],
      [observedCheck(), observedCheck({ id: 'substitute' })],
      [observedCheck({ outcome: 'warn', causeCode: 'ci.required-check.warning-only' })],
      [observedCheck({ validUntil: new Date(NOW - 1).toISOString() })],
    ]) {
      const aggregate = makeDiagnostic('inconclusive', { aggregateDecision: 'inconclusive', requiredChecks: required, observedChecks });
      expect(() => validateControlResult(aggregate as never, validationOptions({ expectedChecks: required }))).toThrow(/observed|exact|duplicate|stale|outcome|aggregate|cause/i);
      expect(aggregateOutcomes([aggregate as never], { ...validationOptions(), expectedChecks: required, attemptStore: await newEvidenceStore() })).toBe('inconclusive');
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
    expect(validateControlResult(aggregate as never, validationOptions({ expectedChecks: required })).outcome).toBe('inconclusive');
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
      producer: { appId: 'expected-app', workflowSha: OID },
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
    const boundaryOptions = {
      ...publicOutputOptions(),
      expectedPreconditions: expectedPreconditions(preconditions),
      expectedChecks: required,
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
    const binding = { detectorId: 'semantic-quality' as const, schemaVersion: 1 as const, evidenceDigest, policyDigest: DIGEST, candidateOid: OID, baseOid: BASE_OID, mergeBaseOid: BASE_OID, producer: { appId: 'expected-app', workflowSha: OID }, platform: { os: 'linux', architecture: 'x64' } };
    expect(adaptSemanticQuality(native, binding)).toMatchObject({ outcome: 'pass', nativeCauseCodes: [], nativeCauseCompleteness: 'complete', nativeStatusRefs: [], limitationCodes: [], evidenceDigest, policyDigest: DIGEST, producer: binding.producer, platform: binding.platform });
    expect(adaptSemanticQuality(native, { ...binding, evidenceDigest: OTHER_DIGEST })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    expect(adaptSemanticQuality(native, { ...binding, candidateOid: BASE_OID })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    expect(adaptSemanticQuality(native, { ...binding, baseOid: OID })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    expect(adaptSemanticQuality(native, { ...binding, mergeBaseOid: OID })).toMatchObject({ outcome: 'inconclusive', code: 'ci.native.receipt-unavailable' });
    const finding = (ruleId: string) => ({ ruleId, decision: 'block' as const, action: 'push' as const, summary: 'Synthetic complete native finding for adapter preservation.', why: 'The adapter must preserve every validated native cause without recomputing policy.', observed: [{ label: 'fixture', value: 'synthetic' }], matchedArtifacts: [], correction: ['Repair the canonical native owner.'], rerun: 'npm run verify:semantic', sourceRefs: ['fixture:ci-control-result'] });
    const blocked = buildBoundaryReceipt({ invocation: 'semantic-quality', action: 'push', enforcementMode: 'enforce', base: { headOid: OID, baseOid: BASE_OID, mergeBaseOid: BASE_OID, evidenceSource: 'git-object' }, findings: [finding('semantic.second'), finding('semantic.first')] });
    const blockedDigest = digest(canonicalizeBoundaryRun(blocked));
    expect(adaptSemanticQuality(blocked, { ...binding, evidenceDigest: blockedDigest })).toMatchObject({ outcome: 'block', nativeCauseCodes: ['semantic.first', 'semantic.second'] });
  });

  it('uses the canonical boundary-run validator and refuses active progress as terminal evidence', () => {
    const native = validManifest();
    const evidenceDigest = digest(canonicalizeBoundaryRun(native));
    const binding = { detectorId: 'boundary-run' as const, schemaVersion: 1 as const, evidenceDigest, policyDigest: DIGEST, candidateOid: BOUNDARY_OID, baseOid: null, mergeBaseOid: null, producer: { appId: 'expected-app', workflowSha: OID }, platform: { os: 'linux', architecture: 'x64' } };
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
});
