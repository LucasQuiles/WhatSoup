import { createHash } from 'node:crypto';

import { FileAttemptEvidenceStore, terminalAttemptDigest, validateTerminalAttempt, type SupervisorLeaseExpectationsV1, type TerminalAttemptV1 } from './attempt.ts';
import { assertBoundedEvidenceGraph, preconditionDigest, validatePreconditionReceipt, type PreconditionExpectationsV1, type PreconditionReceiptV1 } from './preconditions.ts';
import { isEmittableReason, isRegisteredLimitationCode, isRegisteredReason, reasonDefinition, type RemediationClass, type RetryClass } from './reasons.ts';
import { scanTextForPrivateLiterals } from '../../publication-guard.ts';
import { parseBoundaryJsonBytes } from '../verification/boundary-run/schema.ts';
import {
  canonicalizeBoundaryRun,
  hasExactKeys,
  isBoundedText,
  isOid,
  isRecord,
  isSafePath,
  isTimestamp,
  sha256Bytes,
} from '../verification/boundary-run/shared.ts';

export const MAX_RESULT_BYTES = 32_768;
export const MAX_LIST_ITEMS = 64;
export const MAX_STRING_UTF8_BYTES = 2_048;
export const MAX_GRAPH_NODES = 2_048;
export const MAX_GRAPH_DEPTH = 16;
export const MAX_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
export type ControlOutcome = 'pass' | 'warn' | 'block' | 'inconclusive' | 'not-applicable';
export type AggregateDecision = 'pass' | 'block' | 'inconclusive';
export type ControlExitCode = 0 | 1 | 2;

export interface ControlResultV1 {
  schemaVersion: 1;
  outcome: ControlOutcome;
  aggregateDecision: AggregateDecision | null;
  exitCode: ControlExitCode;
  code: string;
  evidenceState: 'proven' | 'inconclusive' | 'proposed';
  controlId: string;
  candidateOid: string;
  policyDigest: string;
  scannerPolicyReceipt: ScannerPolicyReceiptV1;
  preconditionReceipt: PreconditionReceiptV1;
  attempt: TerminalAttemptV1;
  attemptDigest: string;
  requiredChecks: RequiredCheckV1[];
  observedChecks: ObservedCheckV1[];
  retryClass: RetryClass;
  remediationClass: RemediationClass;
  nativeEvidence: NativeEvidenceV1 | null;
  warningGovernance: WarningGovernanceV1 | null;
  warningTransition: WarningEscalationTransitionV1 | null;
  [key: string]: unknown;
}

export interface ProducerIdentityV1 {
  appId: string;
  workflowSha: string;
  workflowRef: string;
  runId: string;
  attempt: number;
}
interface PlatformTupleV1 { architecture: string; os: string }
export interface NativeEvidenceV1 {
  detectorId: string;
  schemaVersion: number;
  evidenceDigest: string;
  nativeCauseCodes: string[];
  policyDigest: string;
  producer: ProducerIdentityV1;
  platform: PlatformTupleV1;
}
export interface WarningGovernanceV1 {
  owner: string;
  remediationSlaHours: number;
  expiresAfterHours: number;
  escalationCondition: string;
  successorCode: string;
  firstObservedAt: string;
  remediationDueAt: string;
  expiresAt: string;
}
export interface WarningEscalationTransitionV1 {
  schemaVersion: 1;
  predecessorCode: string;
  successorCode: string;
  predecessorFindingId: string;
  predecessorAttemptId: string;
  predecessorAttemptDigest: string;
  predecessorResultDigest: string;
  candidateOid: string;
  policyDigest: string;
  nativeEvidenceDigest: string;
  nativeCauseCodes: string[];
  expiresAt: string;
  transitionedAt: string;
}
export interface HistoricalControlResultReadV1 {
  authorization: 'historical-only';
  lifecycle: 'deprecated' | 'superseded';
  evidenceDigest: string;
  result: Readonly<Record<string, unknown>>;
}
export interface ScannerPolicyReceiptV1 {
  schemaVersion: 1;
  policyDigest: string;
  sourceOid: string;
  toolDigest: string;
  sources: Array<{ path: string; blobOid: string }>;
  producer: ProducerIdentityV1;
}
interface ClassifierProofV1 {
  schemaVersion: 1;
  reason: 'ci.classification.not-applicable';
  candidateOid: string;
  mergeOid: string | null;
  policyDigest: string;
  classifierDigest: string;
  producer: ProducerIdentityV1;
  createdAt: string;
  validUntil: string;
}
interface RequiredCheckV1 {
  id: string;
  expectedProducer: ProducerIdentityV1;
  expectedPlatform: PlatformTupleV1;
  candidateOid: string;
  mergeOid: string | null;
  policyDigest: string;
}
interface ObservedCheckV1 extends RequiredCheckV1 {
  applicability: 'required' | 'not-applicable';
  applicabilityReason: string | null;
  outcome: ControlOutcome;
  causeCode: string;
  producer: ProducerIdentityV1 | null;
  observedPlatform: PlatformTupleV1 | null;
  classifierProof: ClassifierProofV1 | null;
  nativeCauseCodes: string[];
  nativeCauseCompleteness: 'complete' | 'unavailable' | 'not-applicable';
  nativeStatusRefs: string[];
  limitationCodes: string[];
  nativeSchemaVersion: number | null;
  evidenceDigest: string | null;
  createdAt: string | null;
  validUntil: string | null;
}

const RESULT_KEYS = ['aggregateDecision', 'allowedPatchScope', 'applicability', 'applicabilityReason', 'attempt', 'attemptDigest', 'baseOid', 'candidateOid', 'canonicalImplementationOwner', 'causedBy', 'claimedScope', 'classifierDigest', 'classifierProof', 'closureCriteria', 'code', 'confidence', 'controlId', 'createdAt', 'doNot', 'domain', 'eventName', 'evidenceState', 'exception', 'exitCode', 'findingId', 'fingerprint', 'guidance', 'impact', 'limitations', 'location', 'manifestDigest', 'mergeOid', 'nativeEvidence', 'nextBestAction', 'observedChecks', 'observedScope', 'operation', 'outcome', 'owner', 'patchScope', 'platform', 'policyDigest', 'preconditionReceipt', 'privateEvidenceRefs', 'producer', 'prohibitedChanges', 'publicEvidenceRefs', 'relatedFindingIds', 'relatedFindings', 'remediationClass', 'reproduce', 'requiredChecks', 'retryClass', 'retryConditions', 'retryable', 'risk', 'rootCauseId', 'scannerPolicyReceipt', 'schemaVersion', 'scopeLimitations', 'sensitiveFieldsOmitted', 'severity', 'stage', 'supersedes', 'surface', 'tool', 'trustClass', 'validUntil', 'verificationPlan', 'verify', 'warningGovernance', 'warningTransition', 'why'] as const;
const LEGACY_RESULT_KEYS = RESULT_KEYS.filter((key) => key !== 'nativeEvidence' && key !== 'warningGovernance' && key !== 'warningTransition');
const PRODUCER_KEYS = ['appId', 'attempt', 'runId', 'workflowRef', 'workflowSha'] as const;
const PLATFORM_TUPLE_KEYS = ['architecture', 'os'] as const;
const CLASSIFIER_PROOF_KEYS = ['candidateOid', 'classifierDigest', 'createdAt', 'mergeOid', 'policyDigest', 'producer', 'reason', 'schemaVersion', 'validUntil'] as const;
const TOOL_KEYS = ['digest', 'name', 'version'] as const;
const PLATFORM_KEYS = ['architecture', 'observedCapabilitiesDigest', 'os', 'runnerLabel', 'runtime'] as const;
const SCANNER_POLICY_KEYS = ['policyDigest', 'producer', 'schemaVersion', 'sourceOid', 'sources', 'toolDigest'] as const;
const SCANNER_SOURCE_KEYS = ['blobOid', 'path'] as const;
const RISK_KEYS = ['reasons', 'tier'] as const;
const LOCATION_KEYS = ['kind', 'name'] as const;
const PATCH_SCOPE_KEYS = ['allowed', 'prohibited'] as const;
const REPRODUCE_KEYS = ['command', 'preconditions'] as const;
const VERIFY_KEYS = ['commands', 'expected'] as const;
const EXCEPTION_KEYS = ['approvalRole', 'eligible'] as const;
const SCOPE_KEYS = ['digest', 'itemCount', 'kind'] as const;
const NATIVE_EVIDENCE_KEYS = ['detectorId', 'evidenceDigest', 'nativeCauseCodes', 'platform', 'policyDigest', 'producer', 'schemaVersion'] as const;
const WARNING_GOVERNANCE_KEYS = ['escalationCondition', 'expiresAfterHours', 'expiresAt', 'firstObservedAt', 'owner', 'remediationDueAt', 'remediationSlaHours', 'successorCode'] as const;
const WARNING_TRANSITION_KEYS = ['candidateOid', 'expiresAt', 'nativeCauseCodes', 'nativeEvidenceDigest', 'policyDigest', 'predecessorAttemptDigest', 'predecessorAttemptId', 'predecessorCode', 'predecessorFindingId', 'predecessorResultDigest', 'schemaVersion', 'successorCode', 'transitionedAt'] as const;
const REQUIRED_CHECK_KEYS = ['candidateOid', 'expectedPlatform', 'expectedProducer', 'id', 'mergeOid', 'policyDigest'] as const;
const OBSERVED_CHECK_KEYS = ['applicability', 'applicabilityReason', 'candidateOid', 'causeCode', 'classifierProof', 'createdAt', 'evidenceDigest', 'expectedPlatform', 'expectedProducer', 'id', 'limitationCodes', 'mergeOid', 'nativeCauseCodes', 'nativeCauseCompleteness', 'nativeSchemaVersion', 'nativeStatusRefs', 'observedPlatform', 'outcome', 'policyDigest', 'producer', 'validUntil'] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FINGERPRINT = /^fp:v1:[0-9a-f]{64}$/;
const OUTCOMES = new Set<ControlOutcome>(['pass', 'warn', 'block', 'inconclusive', 'not-applicable']);
const AGGREGATES = new Set<AggregateDecision>(['pass', 'block', 'inconclusive']);
const EVIDENCE_STATES = new Set(['proven', 'inconclusive', 'proposed']);
const RETRY_CLASSES = new Set<RetryClass>(['never', 'after-source-change', 'after-precondition-repair', 'after-transient-condition', 'after-lineage-reconciliation', 'after-evidence-regeneration', 'after-rebase-or-merge-refresh', 'after-approval', 'manual-recovery']);
const REMEDIATION_CLASSES = new Set<RemediationClass>(['source-patch', 'workflow-policy-change', 'environment-setup', 'exact-revision-rerun', 'lineage-reconciliation', 'artifact-quarantine', 'rollback', 'hosted-settings-change', 'owner-decision', 'exception-renewal', 'control-retirement']);
const PUBLIC_EVIDENCE_REFERENCE = /^public:[a-z0-9._:-]+$/;
const PRIVATE_EVIDENCE_REFERENCE = /^private:opaque:[a-z0-9]{16,64}$/;

export interface ExpectedResultBindingsV1 {
  candidateOid: string;
  baseOid: string | null;
  mergeOid: string | null;
  manifestDigest: string;
  policyDigest: string;
  classifierDigest: string;
  producer: ProducerIdentityV1;
  toolDigest: string;
}

export interface ExpectedScopeV1 {
  kind: string;
  digest: string;
  itemCount: number;
}

export interface ExpectedFindingNodeV1 {
  findingId: string;
  rootCauseId: string;
  causedBy: string[];
  candidateOid: string;
  policyDigest: string;
}

export interface ControlValidationOptions {
  now?: number;
  forbiddenValues?: readonly string[];
  expectedChecks?: readonly unknown[];
  expectedPreconditions?: PreconditionExpectationsV1;
  expectedScannerPolicyReceipt?: unknown;
  expectedBindings?: ExpectedResultBindingsV1;
  expectedScope?: ExpectedScopeV1;
  expectedFindingGraph?: readonly ExpectedFindingNodeV1[];
  expectedNativeEvidence?: NativeEvidenceV1 | null;
  expectedWarningGovernance?: WarningGovernanceV1 | null;
  expectedWarningTransition?: WarningEscalationTransitionV1 | null;
}

export function controlResultEvidenceDigest(value: Record<string, unknown>): string {
  const { attempt: _attempt, attemptDigest: _attemptDigest, ...bound } = value;
  const sortTuples = (items: unknown): unknown => Array.isArray(items)
    ? [...items].sort((left, right) => canonicalizeBoundaryRun(left).localeCompare(canonicalizeBoundaryRun(right)))
    : items;
  const projection = {
    ...bound,
    requiredChecks: sortTuples(bound.requiredChecks),
    observedChecks: sortTuples(bound.observedChecks),
  };
  return `sha256:${sha256Bytes(canonicalizeBoundaryRun(projection))}`;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function parseResultJsonBoundary(input: string | Uint8Array, label: string): { bytes: Buffer; value: unknown } {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error(`${label} exceeds byte budget`);
  const parsed = parseBoundaryJsonBytes(bytes);
  if (!parsed.result.ok || parsed.value === null) {
    const issue = parsed.result.issues[0];
    throw new Error(issue === undefined ? `${label} JSON is invalid` : `${label} JSON is invalid (${issue.code})`);
  }
  return { bytes, value: parsed.value };
}

function frozenCanonicalRecord(value: unknown): Readonly<Record<string, unknown>> {
  const clone = JSON.parse(canonicalizeBoundaryRun(value)) as Record<string, unknown>;
  const freeze = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) freeze(item);
      Object.freeze(current);
    } else if (isRecord(current)) {
      for (const item of Object.values(current)) freeze(item);
      Object.freeze(current);
    }
  };
  freeze(clone);
  return clone;
}

function requireRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error(`${label} keys are invalid`);
  return value;
}

function requireText(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (!isBoundedText(value, MAX_STRING_UTF8_BYTES)) throw new Error(`${label} must be bounded text`);
  return value;
}

function requireStringList(value: unknown, label: string, options: { nonempty?: boolean } = {}): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS || value.some((item) => !isBoundedText(item, MAX_STRING_UTF8_BYTES))) throw new Error(`${label} list is invalid or over budget`);
  if (options.nonempty && value.length === 0) throw new Error(`${label} list must be nonempty`);
  return value as string[];
}

function assertPublicText(value: string, forbiddenValues: readonly string[]): void {
  if (value.trim().toLowerCase() === 'ci failed') throw new Error('generic diagnostic text is forbidden');
  const absolutePath = /(?:^|[^A-Za-z0-9._~%+\/-])(?:file:\/\/\/|\/(?!\/)(?:[^\s"'`]|$)|[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\/])/iu;
  if (absolutePath.test(value) || /(?:password|token|secret|credential)=[^\s]+/i.test(value) || /:\/\/[^\s/@:]+:[^\s/@]+@/.test(value)) throw new Error('unsafe public diagnostic text contains an absolute path or protected value');
  for (const forbidden of forbiddenValues) {
    if (forbidden.length === 0) continue;
    const rawHash = createHash('sha256').update(forbidden).digest('hex');
    if (value.includes(forbidden) || value.includes(rawHash)) throw new Error('unsafe private value or fingerprint in public output');
  }
}

function assertPublicGraph(root: unknown, forbiddenValues: readonly string[]): void {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      assertPublicText(value, forbiddenValues);
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (isRecord(value)) {
      pending.push(...Object.values(value));
    }
  }
}

function validateProducerIdentity(value: unknown, label: string): ProducerIdentityV1 {
  const producer = requireRecord(value, PRODUCER_KEYS, label);
  requireText(producer.appId, `${label}.appId`);
  requireText(producer.workflowRef, `${label}.workflowRef`);
  requireText(producer.runId, `${label}.runId`);
  if (!isOid(producer.workflowSha) || !Number.isSafeInteger(producer.attempt) || Number(producer.attempt) < 1) throw new Error(`${label} execution identity is invalid`);
  return producer as unknown as ProducerIdentityV1;
}

function validatePlatformTuple(value: unknown, label: string): PlatformTupleV1 {
  const platform = requireRecord(value, PLATFORM_TUPLE_KEYS, label);
  requireText(platform.os, `${label}.os`);
  requireText(platform.architecture, `${label}.architecture`);
  return platform as unknown as PlatformTupleV1;
}

function validateTrustedBindings(result: Record<string, unknown>, expected: ExpectedResultBindingsV1 | undefined): void {
  if (expected === undefined) throw new Error('trusted expected result bindings are required');
  if (!isOid(expected.candidateOid) || !(expected.baseOid === null || isOid(expected.baseOid)) || !(expected.mergeOid === null || isOid(expected.mergeOid)) || !isDigest(expected.manifestDigest) || !isDigest(expected.policyDigest) || !isDigest(expected.classifierDigest) || !isDigest(expected.toolDigest)) throw new Error('trusted expected result bindings are malformed');
  const expectedProducer = validateProducerIdentity(expected.producer, 'trusted expected producer');
  const actualProducer = validateProducerIdentity(result.producer, 'result producer binding');
  const tool = result.tool as Record<string, unknown>;
  if (result.candidateOid !== expected.candidateOid || result.baseOid !== expected.baseOid || result.mergeOid !== expected.mergeOid || result.manifestDigest !== expected.manifestDigest || result.policyDigest !== expected.policyDigest || result.classifierDigest !== expected.classifierDigest || tool.digest !== expected.toolDigest || canonicalizeBoundaryRun(actualProducer) !== canonicalizeBoundaryRun(expectedProducer)) throw new Error('result does not match trusted expected bindings');
}

function validateTrustedScope(result: Record<string, unknown>, expected: ExpectedScopeV1 | undefined): void {
  if (expected === undefined || !isBoundedText(expected.kind, 128) || !isDigest(expected.digest) || !Number.isSafeInteger(expected.itemCount) || expected.itemCount < 0 || expected.itemCount > MAX_GRAPH_NODES) throw new Error('trusted expected scope is required and must be valid');
  if (canonicalizeBoundaryRun(result.claimedScope) !== canonicalizeBoundaryRun(expected)) throw new Error('claimed scope does not match trusted expected scope');
}

function validateFindingGraph(result: Record<string, unknown>, expectedGraph: readonly ExpectedFindingNodeV1[] | undefined): void {
  if (expectedGraph === undefined || expectedGraph.length === 0 || expectedGraph.length > MAX_LIST_ITEMS) throw new Error('trusted expected finding graph is required');
  const nodes = new Map<string, ExpectedFindingNodeV1>();
  for (const node of expectedGraph) {
    if (!isRecord(node) || !hasExactKeys(node, ['candidateOid', 'causedBy', 'findingId', 'policyDigest', 'rootCauseId']) || !isBoundedText(node.findingId, 256) || !isBoundedText(node.rootCauseId, 256) || !isOid(node.candidateOid) || !isDigest(node.policyDigest) || !Array.isArray(node.causedBy) || node.causedBy.length > MAX_LIST_ITEMS || node.causedBy.some((id) => !isBoundedText(id, 256)) || new Set(node.causedBy).size !== node.causedBy.length || nodes.has(node.findingId)) throw new Error('trusted finding graph is malformed or contains duplicate causes');
    nodes.set(node.findingId, node);
  }
  for (const node of nodes.values()) {
    if (!nodes.has(node.rootCauseId) || node.causedBy.some((id) => !nodes.has(id)) || node.candidateOid !== result.candidateOid || node.policyDigest !== result.policyDigest) throw new Error('trusted finding graph has an unavailable or mismatched causal node');
    if (node.rootCauseId === node.findingId) {
      if (node.causedBy.length !== 0) throw new Error('trusted causal root cannot depend on another finding');
    } else if (!node.causedBy.includes(node.rootCauseId)) {
      throw new Error('trusted dependent finding does not directly name its causal root');
    }
    for (const causeId of node.causedBy) {
      if (nodes.get(causeId)!.rootCauseId !== node.rootCauseId) throw new Error('trusted causal edge crosses root-cause groups');
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('trusted finding graph contains a causal cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const cause of nodes.get(id)!.causedBy) visit(cause);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
  const findingId = result.findingId as string;
  const expectedNode = nodes.get(findingId);
  if (expectedNode === undefined || expectedNode.rootCauseId !== result.rootCauseId || canonicalizeBoundaryRun([...expectedNode.causedBy].sort()) !== canonicalizeBoundaryRun([...(result.causedBy as string[])].sort())) throw new Error('result does not match the trusted finding graph');
}

function validateNativeEvidence(value: unknown, expected: NativeEvidenceV1 | null | undefined): NativeEvidenceV1 | null {
  if (value === null) {
    if (expected !== undefined && expected !== null) throw new Error('native evidence is missing despite protected expected adapter evidence');
    return null;
  }
  const evidence = requireRecord(value, NATIVE_EVIDENCE_KEYS, 'nativeEvidence');
  requireText(evidence.detectorId, 'nativeEvidence.detectorId');
  const causes = requireStringList(evidence.nativeCauseCodes, 'nativeEvidence.nativeCauseCodes');
  const producer = validateProducerIdentity(evidence.producer, 'nativeEvidence.producer');
  const platform = validatePlatformTuple(evidence.platform, 'nativeEvidence.platform');
  if (!Number.isSafeInteger(evidence.schemaVersion) || Number(evidence.schemaVersion) < 1 || !isDigest(evidence.evidenceDigest) || !isDigest(evidence.policyDigest) || new Set(causes).size !== causes.length) throw new Error('native evidence binding is invalid');
  if (expected === undefined || expected === null || canonicalizeBoundaryRun(evidence) !== canonicalizeBoundaryRun(expected)) throw new Error('native evidence does not match protected expected adapter evidence');
  return { ...evidence, producer, platform } as unknown as NativeEvidenceV1;
}

function validateWarningGovernance(
  value: unknown,
  expected: WarningGovernanceV1 | null | undefined,
  result: Record<string, unknown>,
  reason: NonNullable<ReturnType<typeof reasonDefinition>>,
): WarningGovernanceV1 | null {
  if (reason.defaultOutcome !== 'warn') {
    if (value !== null) throw new Error('non-warning result contains warning governance');
    return null;
  }
  if (reason.warningPolicy === null || expected === undefined || expected === null) throw new Error('warning result lacks protected governance expectations');
  const governance = requireRecord(value, WARNING_GOVERNANCE_KEYS, 'warningGovernance');
  for (const key of ['owner', 'escalationCondition', 'successorCode'] as const) requireText(governance[key], `warningGovernance.${key}`);
  for (const key of ['firstObservedAt', 'remediationDueAt', 'expiresAt'] as const) if (!isTimestamp(governance[key])) throw new Error(`warningGovernance.${key} is invalid`);
  if (!Number.isSafeInteger(governance.remediationSlaHours) || !Number.isSafeInteger(governance.expiresAfterHours)) throw new Error('warning governance durations are invalid');
  const firstObservedAt = Date.parse(governance.firstObservedAt as string);
  const remediationDueAt = Date.parse(governance.remediationDueAt as string);
  const expiresAt = Date.parse(governance.expiresAt as string);
  if (governance.owner !== reason.warningPolicy.owner || governance.owner !== reason.canonicalOwner || governance.remediationSlaHours !== reason.warningPolicy.remediationSlaHours || governance.expiresAfterHours !== reason.warningPolicy.expiresAfterHours || governance.escalationCondition !== reason.warningPolicy.escalationCondition || governance.successorCode !== reason.warningPolicy.successorCode || remediationDueAt !== firstObservedAt + reason.warningPolicy.remediationSlaHours * 60 * 60_000 || expiresAt !== firstObservedAt + reason.warningPolicy.expiresAfterHours * 60 * 60_000 || Date.parse(result.createdAt as string) < firstObservedAt || result.validUntil !== governance.expiresAt) throw new Error('warning governance does not match the canonical protected interval');
  if (canonicalizeBoundaryRun(governance) !== canonicalizeBoundaryRun(expected)) throw new Error('warning governance does not match protected expectations');
  return governance as unknown as WarningGovernanceV1;
}

function validateWarningTransition(
  value: unknown,
  expected: WarningEscalationTransitionV1 | null | undefined,
  result: Record<string, unknown>,
  nativeEvidence: NativeEvidenceV1 | null,
): WarningEscalationTransitionV1 | null {
  const isSuccessor = result.code === 'quality.semantic.warning.expired';
  if (!isSuccessor) {
    if (value !== null) throw new Error('non-successor result contains a warning transition');
    return null;
  }
  if (expected === undefined || expected === null || nativeEvidence === null) throw new Error('expired warning successor lacks protected transition evidence');
  const transition = requireRecord(value, WARNING_TRANSITION_KEYS, 'warningTransition');
  for (const key of ['predecessorCode', 'successorCode', 'predecessorFindingId', 'predecessorAttemptId'] as const) requireText(transition[key], `warningTransition.${key}`);
  const nativeCauseCodes = requireStringList(transition.nativeCauseCodes, 'warningTransition.nativeCauseCodes', { nonempty: true });
  if (transition.schemaVersion !== 1 || !isDigest(transition.predecessorAttemptDigest) || !isDigest(transition.predecessorResultDigest) || !isOid(transition.candidateOid) || !isDigest(transition.policyDigest) || !isDigest(transition.nativeEvidenceDigest) || !isTimestamp(transition.expiresAt) || !isTimestamp(transition.transitionedAt) || new Set(nativeCauseCodes).size !== nativeCauseCodes.length) throw new Error('warning transition is malformed');
  const successorAttempt = result.attempt as unknown as TerminalAttemptV1;
  if (canonicalizeBoundaryRun(transition) !== canonicalizeBoundaryRun(expected) || transition.successorCode !== result.code || transition.candidateOid !== result.candidateOid || transition.policyDigest !== result.policyDigest || transition.nativeEvidenceDigest !== nativeEvidence.evidenceDigest || canonicalizeBoundaryRun([...nativeCauseCodes].sort()) !== canonicalizeBoundaryRun([...nativeEvidence.nativeCauseCodes].sort()) || transition.transitionedAt !== result.createdAt || Date.parse(transition.expiresAt as string) > Date.parse(transition.transitionedAt as string) || Date.parse(successorAttempt.createdAt) < Date.parse(transition.expiresAt as string) || Date.parse(successorAttempt.terminalAt) > Date.parse(transition.transitionedAt as string) || transition.predecessorAttemptId === successorAttempt.id || !(result.supersedes as string[]).includes(transition.predecessorFindingId as string)) throw new Error('warning transition does not bind the protected predecessor and successor attempt chronology');
  return transition as unknown as WarningEscalationTransitionV1;
}

function resultHasIdentityBinding(result: Record<string, unknown>, binding: string): boolean {
  if (binding === 'toolDigest') return isDigest((result.tool as Record<string, unknown>).digest);
  if (binding === 'attemptDigest') return isDigest(result.attemptDigest);
  if (binding === 'nativeEvidenceDigest') return isDigest((result.nativeEvidence as Record<string, unknown> | null)?.evidenceDigest);
  if (binding === 'warningTransition') return isRecord(result.warningTransition);
  return result[binding] !== undefined && result[binding] !== null;
}

function validateScannerPolicyReceipt(value: unknown): ScannerPolicyReceiptV1 {
  const receipt = requireRecord(value, SCANNER_POLICY_KEYS, 'scanner policy receipt');
  if (receipt.schemaVersion !== 1 || !isDigest(receipt.policyDigest) || !isOid(receipt.sourceOid) || !isDigest(receipt.toolDigest)) throw new Error('scanner policy receipt binding is invalid');
  if (!Array.isArray(receipt.sources) || receipt.sources.length === 0 || receipt.sources.length > MAX_LIST_ITEMS) throw new Error('scanner policy source set is invalid');
  const sources = receipt.sources.map((value) => {
    const source = requireRecord(value, SCANNER_SOURCE_KEYS, 'scanner policy source');
    if (!isSafePath(source.path) || !isOid(source.blobOid)) throw new Error('scanner policy source binding is invalid');
    return source as unknown as { path: string; blobOid: string };
  });
  const paths = sources.map(({ path }) => path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! > path)) throw new Error('scanner policy sources must be sorted and unique');
  const producer = validateProducerIdentity(receipt.producer, 'scanner policy producer');
  return { ...receipt, sources, producer } as unknown as ScannerPolicyReceiptV1;
}

function validateProtectedScannerPolicyReceipt(value: unknown, expectedValue: unknown): ScannerPolicyReceiptV1 {
  if (expectedValue === undefined) throw new Error('trusted expected scanner policy receipt is required');
  const receipt = validateScannerPolicyReceipt(value);
  const expected = validateScannerPolicyReceipt(expectedValue);
  if (canonicalizeBoundaryRun(receipt) !== canonicalizeBoundaryRun(expected)) throw new Error('scanner policy receipt does not match protected expected evidence');
  return receipt;
}

function validateClassifierProof(value: unknown, expected: {
  candidateOid: string;
  classifierDigest: string;
  mergeOid: string | null;
  policyDigest: string;
  producer?: ProducerIdentityV1;
}, now: number): ClassifierProofV1 {
  const proof = requireRecord(value, CLASSIFIER_PROOF_KEYS, 'classifier proof');
  if (proof.schemaVersion !== 1 || proof.reason !== 'ci.classification.not-applicable' || proof.candidateOid !== expected.candidateOid || proof.mergeOid !== expected.mergeOid || proof.policyDigest !== expected.policyDigest || proof.classifierDigest !== expected.classifierDigest) throw new Error('classifier proof binding mismatch');
  const producer = validateProducerIdentity(proof.producer, 'classifier proof producer');
  if (expected.producer !== undefined && canonicalizeBoundaryRun(producer) !== canonicalizeBoundaryRun(expected.producer)) throw new Error('classifier proof producer mismatch');
  if (!isTimestamp(proof.createdAt) || !isTimestamp(proof.validUntil)) throw new Error('classifier proof timestamps are invalid');
  const createdAt = Date.parse(proof.createdAt);
  const validUntil = Date.parse(proof.validUntil);
  if (createdAt > now + 5 * 60_000 || now - createdAt > MAX_FRESHNESS_MS || validUntil < createdAt || validUntil <= now || validUntil - createdAt > MAX_FRESHNESS_MS) throw new Error('classifier proof freshness interval is invalid, stale, expired, or future-dated');
  return { ...proof, producer } as unknown as ClassifierProofV1;
}

function tupleKey(value: RequiredCheckV1): string {
  return canonicalizeBoundaryRun([value.id, value.expectedProducer, value.expectedPlatform, value.candidateOid, value.mergeOid, value.policyDigest]);
}

function validateRequiredCheck(value: unknown): RequiredCheckV1 {
  const check = requireRecord(value, REQUIRED_CHECK_KEYS, 'required check');
  requireText(check.id, 'required check id');
  const expectedProducer = validateProducerIdentity(check.expectedProducer, 'required check expected producer');
  const expectedPlatform = validatePlatformTuple(check.expectedPlatform, 'required check expected platform');
  if (!isOid(check.candidateOid) || !(check.mergeOid === null || isOid(check.mergeOid)) || !isDigest(check.policyDigest)) throw new Error('required check binding is invalid');
  return { ...check, expectedProducer, expectedPlatform } as unknown as RequiredCheckV1;
}

function validateObservedCheck(value: unknown, now: number, classifierDigest: string): ObservedCheckV1 {
  const check = requireRecord(value, OBSERVED_CHECK_KEYS, 'observed check');
  requireText(check.id, 'observed check id');
  const expectedProducer = validateProducerIdentity(check.expectedProducer, 'observed expected producer');
  const expectedPlatform = validatePlatformTuple(check.expectedPlatform, 'observed expected platform');
  if (!isOid(check.candidateOid) || !(check.mergeOid === null || isOid(check.mergeOid)) || !isDigest(check.policyDigest) || !OUTCOMES.has(check.outcome as ControlOutcome) || !isEmittableReason(check.causeCode)) throw new Error('observed check binding is invalid or uses a non-emittable code');
  const cause = reasonDefinition(check.causeCode);
  if (cause === null || cause.defaultOutcome !== check.outcome) throw new Error('observed cause code and outcome taxonomy mismatch');
  const nativeCauseCodes = requireStringList(check.nativeCauseCodes, 'observed native cause codes');
  const nativeStatusRefs = requireStringList(check.nativeStatusRefs, 'observed native status references');
  const limitationCodes = requireStringList(check.limitationCodes, 'observed limitation codes');
  for (const [label, values] of [['native cause codes', nativeCauseCodes], ['native status references', nativeStatusRefs], ['limitation codes', limitationCodes]] as const) {
    if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! > value)) throw new Error(`observed ${label} must be sorted and unique`);
  }
  if (limitationCodes.some((code) => !isRegisteredLimitationCode(code))) throw new Error('observed limitation code is unregistered');
  if (check.applicability !== 'required' && check.applicability !== 'not-applicable') throw new Error('observed check applicability is invalid');
  if (check.applicability === 'not-applicable') {
    if (check.outcome !== 'not-applicable' || check.causeCode !== 'ci.classification.not-applicable' || check.applicabilityReason !== 'ci.classification.not-applicable' || check.nativeCauseCompleteness !== 'not-applicable' || nativeCauseCodes.length !== 0 || nativeStatusRefs.length !== 0 || limitationCodes.length !== 0 || check.producer !== null || check.observedPlatform !== null || check.nativeSchemaVersion !== null || check.evidenceDigest !== null || check.createdAt !== null || check.validUntil !== null) throw new Error('not-applicable observation lacks closed classifier proof');
    validateClassifierProof(check.classifierProof, { candidateOid: check.candidateOid as string, mergeOid: check.mergeOid as string | null, policyDigest: check.policyDigest as string, classifierDigest, producer: expectedProducer }, now);
  } else {
    if (check.applicabilityReason !== null || check.outcome === 'not-applicable' || check.classifierProof !== null) throw new Error('required observation has invalid applicability');
    const producer = validateProducerIdentity(check.producer, 'observed producer');
    const observedPlatform = validatePlatformTuple(check.observedPlatform, 'observed platform');
    if (canonicalizeBoundaryRun(producer) !== canonicalizeBoundaryRun(expectedProducer)) throw new Error('observed producer tuple mismatch');
    if (canonicalizeBoundaryRun(observedPlatform) !== canonicalizeBoundaryRun(expectedPlatform)) throw new Error('observed platform tuple mismatch');
    if (!Number.isSafeInteger(check.nativeSchemaVersion) || Number(check.nativeSchemaVersion) < 1 || !isDigest(check.evidenceDigest) || !isTimestamp(check.createdAt) || !isTimestamp(check.validUntil)) throw new Error('observed check evidence is malformed');
    if (check.nativeCauseCompleteness !== 'complete' && check.nativeCauseCompleteness !== 'unavailable') throw new Error('observed native cause completeness is invalid');
    if (check.outcome === 'pass' && (check.nativeCauseCompleteness !== 'complete' || nativeCauseCodes.length !== 0 || nativeStatusRefs.length !== 0 || limitationCodes.length !== 0)) throw new Error('passing observation contains incomplete native cause evidence');
    if (check.outcome !== 'pass' && check.nativeCauseCompleteness === 'complete' && nativeCauseCodes.length === 0) throw new Error('observed native cause preservation is incomplete');
    if (check.outcome !== 'pass' && check.nativeCauseCompleteness === 'unavailable' && (nativeCauseCodes.length !== 0 || nativeStatusRefs.length === 0 || !limitationCodes.includes('ci.native.cause-code-unavailable'))) throw new Error('unavailable native cause evidence lacks structural status and limitation');
    const createdAt = Date.parse(check.createdAt);
    const validUntil = Date.parse(check.validUntil);
    if (createdAt > now + 5 * 60_000 || now - createdAt > MAX_FRESHNESS_MS || validUntil < createdAt || validUntil <= now || validUntil - createdAt > MAX_FRESHNESS_MS) throw new Error('observed check freshness interval is invalid, stale, expired, or future-dated');
    if (check.outcome === 'warn' && (cause.warningPolicy === null || validUntil - createdAt > cause.warningPolicy.expiresAfterHours * 60 * 60_000)) throw new Error('observed warning lacks governed expiry');
  }
  return { ...check, expectedProducer, expectedPlatform } as unknown as ObservedCheckV1;
}

function validateCheckSets(result: Record<string, unknown>, now: number, expectedChecks: readonly unknown[] | undefined): AggregateDecision | null {
  if (!Array.isArray(result.requiredChecks) || result.requiredChecks.length > MAX_LIST_ITEMS || !Array.isArray(result.observedChecks) || result.observedChecks.length > MAX_LIST_ITEMS) throw new Error('required and observed checks must be bounded lists');
  if (result.aggregateDecision === null) {
    if (result.requiredChecks.length !== 0 || result.observedChecks.length !== 0) throw new Error('individual results cannot carry aggregate check sets');
    return null;
  }
  const required = result.requiredChecks.map(validateRequiredCheck);
  const observed = result.observedChecks.map((value) => validateObservedCheck(value, now, result.classifierDigest as string));
  if (expectedChecks === undefined) throw new Error('trusted expected check set is required for aggregate validation');
  if (expectedChecks.length > MAX_LIST_ITEMS) throw new Error('trusted expected check set exceeds item budget');
  const expected = expectedChecks.map(validateRequiredCheck);
  if (required.some((check) => check.candidateOid !== result.candidateOid || check.mergeOid !== result.mergeOid || check.policyDigest !== result.policyDigest)) throw new Error('aggregate check set does not bind the envelope revision and policy');
  const requiredKeys = required.map(tupleKey);
  const expectedKeys = expected.map(tupleKey);
  const observedKeys = observed.map(tupleKey);
  if (new Set(expectedKeys).size !== expectedKeys.length || new Set(requiredKeys).size !== requiredKeys.length || new Set(observedKeys).size !== observedKeys.length) throw new Error('duplicate expected, required, or observed check tuple');
  if (expectedKeys.length !== requiredKeys.length || expectedKeys.some((key) => !requiredKeys.includes(key)) || requiredKeys.some((key) => !expectedKeys.includes(key))) throw new Error('required checks do not match the trusted expected set');
  if (requiredKeys.length !== observedKeys.length || requiredKeys.some((key) => !observedKeys.includes(key)) || observedKeys.some((key) => !requiredKeys.includes(key))) throw new Error('required and observed check sets are not exact');
  if (observed.some((check) => check.outcome === 'block')) return 'block';
  if (observed.some((check) => check.outcome === 'warn' || check.outcome === 'inconclusive')) return 'inconclusive';
  return 'pass';
}

function validateDiagnostics(result: Record<string, unknown>, options: ControlValidationOptions): void {
  const findingId = requireText(result.findingId, 'findingId')!;
  const rootCauseId = requireText(result.rootCauseId, 'rootCauseId')!;
  const causedBy = requireStringList(result.causedBy, 'causedBy');
  const relatedFindingIds = requireStringList(result.relatedFindingIds, 'relatedFindingIds');
  const supersedes = requireStringList(result.supersedes, 'supersedes');
  for (const [label, identifiers] of [['causedBy', causedBy], ['relatedFindingIds', relatedFindingIds], ['supersedes', supersedes]] as const) {
    if (new Set(identifiers).size !== identifiers.length) throw new Error(`${label} contains duplicate finding identities`);
  }
  if (causedBy.includes(findingId) || relatedFindingIds.includes(findingId) || supersedes.includes(findingId)) throw new Error('causal relationships cannot reference the finding itself');
  if (rootCauseId !== findingId && !causedBy.includes(rootCauseId)) throw new Error('dependent finding does not name its root cause in causedBy');
  validateFindingGraph(result, options.expectedFindingGraph);
  const location = requireRecord(result.location, LOCATION_KEYS, 'location');
  requireText(location.kind, 'location.kind');
  const locationName = requireText(location.name, 'location.name')!;
  const why = requireText(result.why, 'why')!;
  const impact = requireText(result.impact, 'impact')!;
  const owner = requireText(result.owner, 'owner')!;
  const canonicalOwner = requireText(result.canonicalImplementationOwner, 'canonicalImplementationOwner')!;
  const guidance = requireStringList(result.guidance, 'guidance', { nonempty: true });
  const related = requireStringList(result.relatedFindings, 'relatedFindings');
  const limitations = requireStringList(result.limitations, 'limitations');
  const retryConditions = requireStringList(result.retryConditions, 'retryConditions');
  const patch = requireRecord(result.patchScope, PATCH_SCOPE_KEYS, 'patchScope');
  const allowed = requireStringList(patch.allowed, 'patchScope.allowed', { nonempty: true });
  const prohibited = requireStringList(patch.prohibited, 'patchScope.prohibited', { nonempty: true });
  const allowedPatchScope = requireStringList(result.allowedPatchScope, 'allowedPatchScope', { nonempty: true });
  const prohibitedChanges = requireStringList(result.prohibitedChanges, 'prohibitedChanges', { nonempty: true });
  const doNot = requireStringList(result.doNot, 'doNot', { nonempty: true });
  if (canonicalizeBoundaryRun(allowedPatchScope) !== canonicalizeBoundaryRun(allowed) || canonicalizeBoundaryRun(prohibitedChanges) !== canonicalizeBoundaryRun(prohibited)) throw new Error('allowed or prohibited patch scope enrichment mismatch');
  const reproduce = requireRecord(result.reproduce, REPRODUCE_KEYS, 'reproduce');
  const reproduceCommand = requireText(reproduce.command, 'reproduce.command')!;
  const reproducePreconditions = requireStringList(reproduce.preconditions, 'reproduce.preconditions', { nonempty: true });
  const verify = requireRecord(result.verify, VERIFY_KEYS, 'verify');
  const verifyCommands = requireStringList(verify.commands, 'verify.commands', { nonempty: true });
  const verifyExpected = requireStringList(verify.expected, 'verify.expected', { nonempty: true });
  const verificationPlan = requireStringList(result.verificationPlan, 'verificationPlan', { nonempty: true });
  const closureCriteria = requireStringList(result.closureCriteria, 'closureCriteria', { nonempty: true });
  if (canonicalizeBoundaryRun(verificationPlan) !== canonicalizeBoundaryRun(verifyCommands) || canonicalizeBoundaryRun(closureCriteria) !== canonicalizeBoundaryRun(verifyExpected)) throw new Error('verification plan or closure criteria mismatch');
  const nextBestAction = requireText(result.nextBestAction, 'nextBestAction')!;
  const scopeLimitations = requireStringList(result.scopeLimitations, 'scopeLimitations');
  const omitted = requireStringList(result.sensitiveFieldsOmitted, 'sensitiveFieldsOmitted', { nonempty: true });
  const publicRefs = requireStringList(result.publicEvidenceRefs, 'publicEvidenceRefs');
  const privateRefs = requireStringList(result.privateEvidenceRefs, 'privateEvidenceRefs');
  if (publicRefs.some((value) => !PUBLIC_EVIDENCE_REFERENCE.test(value)) || privateRefs.some((value) => !PRIVATE_EVIDENCE_REFERENCE.test(value))) throw new Error('public evidence reference is invalid or private evidence reference is not opaque');
  const exception = requireRecord(result.exception, EXCEPTION_KEYS, 'exception');
  const retryable = result.retryClass !== 'never';
  if (result.retryable !== retryable || (retryable && retryConditions.length === 0) || (!retryable && retryConditions.length !== 0) || typeof exception.eligible !== 'boolean' || !(exception.approvalRole === null || isBoundedText(exception.approvalRole, 128)) || (exception.eligible && exception.approvalRole === null)) throw new Error('retry class, retry condition, or exception diagnostic is incomplete');
  const publicText = [locationName, why, impact, owner, canonicalOwner, rootCauseId, nextBestAction, ...guidance, ...related, ...limitations, ...retryConditions, ...allowed, ...prohibited, ...doNot, ...causedBy, ...relatedFindingIds, ...supersedes, ...scopeLimitations, ...omitted, ...publicRefs, reproduceCommand, ...reproducePreconditions, ...verifyCommands, ...verifyExpected];
  publicText.forEach((text) => assertPublicText(text, options.forbiddenValues ?? []));
  if (typeof result.fingerprint !== 'string' || !FINGERPRINT.test(result.fingerprint) || result.fingerprint !== buildFindingFingerprint(result as ControlResultV1)) throw new Error('finding fingerprint is invalid');
}

function validateAlwaysPresent(result: Record<string, unknown>, mode: 'current' | 'historical', expectedScannerPolicyReceipt: unknown): void {
  for (const key of ['code', 'controlId', 'owner', 'canonicalImplementationOwner', 'domain', 'stage', 'eventName', 'operation', 'trustClass', 'severity', 'confidence', 'surface']) requireText(result[key], key);
  if (!isRegisteredReason(result.code)) throw new Error('result code is unregistered');
  const definition = reasonDefinition(result.code);
  if (mode === 'current' && !isEmittableReason(result.code)) throw new Error('legacy, planned, deprecated, or superseded taxonomy metadata is not authoritative or emittable');
  if (mode === 'historical' && (definition === null || definition.lifecycle === 'active')) throw new Error('historical read requires a deprecated or superseded taxonomy code');
  if (!EVIDENCE_STATES.has(String(result.evidenceState)) || !RETRY_CLASSES.has(result.retryClass as RetryClass) || !REMEDIATION_CLASSES.has(result.remediationClass as RemediationClass)) throw new Error('evidence state, retry class, or remediation class is invalid');
  if (result.applicability !== 'required' && result.applicability !== 'not-applicable') throw new Error('result applicability is invalid');
  if (!isOid(result.candidateOid) || !(result.baseOid === null || isOid(result.baseOid)) || !(result.mergeOid === null || isOid(result.mergeOid))) throw new Error('result revision binding is invalid');
  for (const key of ['manifestDigest', 'policyDigest', 'classifierDigest']) if (!isDigest(result[key])) throw new Error(`${key} is invalid`);
  validateProducerIdentity(result.producer, 'producer');
  const tool = requireRecord(result.tool, TOOL_KEYS, 'tool');
  requireText(tool.name, 'tool.name'); requireText(tool.version, 'tool.version'); if (!isDigest(tool.digest)) throw new Error('tool digest is invalid');
  const scannerPolicyReceipt = validateProtectedScannerPolicyReceipt(result.scannerPolicyReceipt, expectedScannerPolicyReceipt);
  if (scannerPolicyReceipt.policyDigest !== result.policyDigest) throw new Error('scanner policy receipt does not bind the result policy');
  if (scannerPolicyReceipt.toolDigest !== tool.digest) throw new Error('scanner policy and control tool binding mismatch');
  const platform = requireRecord(result.platform, PLATFORM_KEYS, 'platform');
  for (const key of ['runnerLabel', 'os', 'architecture', 'runtime']) requireText(platform[key], `platform.${key}`);
  if (!isDigest(platform.observedCapabilitiesDigest)) throw new Error('platform capability digest is invalid');
  const risk = requireRecord(result.risk, RISK_KEYS, 'risk');
  if (!['low', 'standard', 'elevated', 'system-wide'].includes(String(risk.tier))) throw new Error('risk tier is invalid');
  requireStringList(risk.reasons, 'risk.reasons');
  const claimedScope = requireRecord(result.claimedScope, SCOPE_KEYS, 'claimedScope');
  const observedScope = requireRecord(result.observedScope, SCOPE_KEYS, 'observedScope');
  for (const [label, scope] of [['claimedScope', claimedScope], ['observedScope', observedScope]] as const) {
    requireText(scope.kind, `${label}.kind`);
    if (!isDigest(scope.digest) || !Number.isSafeInteger(scope.itemCount) || Number(scope.itemCount) < 0 || Number(scope.itemCount) > MAX_GRAPH_NODES) throw new Error(`${label} identity or count is invalid`);
  }
  const scopeLimitations = requireStringList(result.scopeLimitations, 'scopeLimitations');
  const scopeMatches = canonicalizeBoundaryRun(claimedScope) === canonicalizeBoundaryRun(observedScope);
  if (!scopeMatches && scopeLimitations.length === 0) throw new Error('observed scope differs without a scope limitation');
  if (!scopeMatches && result.outcome !== 'inconclusive') throw new Error('non-inconclusive result overclaims observed scope');
}

function validateControlResultInternal(value: unknown, options: ControlValidationOptions, mode: 'current' | 'historical'): ControlResultV1 {
  assertBoundedEvidenceGraph(value, { maxDepth: MAX_GRAPH_DEPTH, maxItems: MAX_LIST_ITEMS, maxObjectKeys: 96, maxNodes: MAX_GRAPH_NODES, maxStringBytes: MAX_STRING_UTF8_BYTES });
  const input = isRecord(value) ? value : null;
  const legacyShape = mode === 'historical' && input !== null && hasExactKeys(input, LEGACY_RESULT_KEYS);
  const historicalEvidenceDigest = mode === 'historical' && input !== null ? controlResultEvidenceDigest(input) : null;
  const normalized = legacyShape ? { ...input, nativeEvidence: null, warningGovernance: null, warningTransition: null } : value;
  const result = requireRecord(normalized, RESULT_KEYS, 'result');
  assertPublicGraph(result, options.forbiddenValues ?? []);
  const canonicalBytes = Buffer.byteLength(canonicalizeBoundaryRun(result), 'utf8');
  if (canonicalBytes > MAX_RESULT_BYTES) throw new Error('result exceeds byte budget');
  if (result.schemaVersion !== 1 || !OUTCOMES.has(result.outcome as ControlOutcome) || !(result.aggregateDecision === null || AGGREGATES.has(result.aggregateDecision as AggregateDecision))) throw new Error('result outcome or aggregate decision is invalid');
  const outcome = result.outcome as ControlOutcome;
  if ((outcome === 'inconclusive' && result.evidenceState !== 'inconclusive') || ((outcome === 'pass' || outcome === 'warn' || outcome === 'block' || outcome === 'not-applicable') && result.evidenceState !== 'proven')) throw new Error('outcome and evidence state mismatch');
  if (result.exitCode !== exitCodeForOutcome(outcome)) throw new Error('outcome and exit code mismatch');
  validateAlwaysPresent(result, mode, options.expectedScannerPolicyReceipt);
  validateTrustedBindings(result, options.expectedBindings);
  validateTrustedScope(result, options.expectedScope);
  const reason = reasonDefinition(result.code);
  if (reason === null || reason.defaultOutcome !== outcome) throw new Error('result code and outcome taxonomy mismatch');
  if (result.severity !== reason.defaultSeverity || result.confidence !== reason.confidenceRequired || result.retryClass !== reason.retryClass || result.remediationClass !== reason.remediationClass) throw new Error('result severity, confidence, retry class, or remediation class differs from the taxonomy registry');
  if (reason.metadataState === 'complete') {
    if (!reason.applicableStages.includes(result.stage as string) || reason.requiredIdentityBindings.some((binding) => !resultHasIdentityBinding(result, binding))) throw new Error('result stage or identity bindings differ from the complete taxonomy record');
    if (result.owner !== reason.canonicalOwner) throw new Error('result owner differs from the complete taxonomy record');
    if (outcome !== 'pass' && outcome !== 'not-applicable' && (result.why !== reason.messageTemplate.summary || canonicalizeBoundaryRun(result.guidance) !== canonicalizeBoundaryRun(reason.messageTemplate.guidance))) throw new Error('result message differs from the canonical taxonomy template');
  }
  if (!isTimestamp(result.createdAt) || !isTimestamp(result.validUntil)) throw new Error('result timestamps are invalid');
  const now = options.now ?? Date.now();
  const createdAt = Date.parse(result.createdAt);
  const validUntil = Date.parse(result.validUntil);
  if (validUntil < createdAt || (mode === 'current' && (createdAt > now + 5 * 60_000 || validUntil <= now || now - createdAt > MAX_FRESHNESS_MS || validUntil - createdAt > MAX_FRESHNESS_MS))) throw new Error('result freshness interval is invalid, stale, expired, or future-dated');
  if (outcome === 'warn' && (reason.warningPolicy === null || validUntil - createdAt > reason.warningPolicy.expiresAfterHours * 60 * 60_000)) throw new Error('warning result lacks governed expiry');

  const nativeEvidence = validateNativeEvidence(result.nativeEvidence, options.expectedNativeEvidence);
  if ((outcome === 'warn' || outcome === 'block') && (nativeEvidence === null || nativeEvidence.nativeCauseCodes.length === 0)) throw new Error('native warning or block lacks complete protected native cause evidence');
  if (mode === 'current') {
    validateWarningGovernance(result.warningGovernance, options.expectedWarningGovernance, result, reason);
    validateWarningTransition(result.warningTransition, options.expectedWarningTransition, result, nativeEvidence);
  } else if (result.warningGovernance !== null || result.warningTransition !== null) {
    throw new Error('historical compatibility result contains current warning governance');
  }

  if (options.expectedPreconditions === undefined) throw new Error('trusted precondition expectations are required');
  const evidenceNow = mode === 'historical' ? createdAt : now;
  const preconditions = validatePreconditionReceipt(result.preconditionReceipt, { now: evidenceNow, expected: options.expectedPreconditions });
  const attempt = validateTerminalAttempt(result.attempt, { now: evidenceNow });
  if (!isDigest(result.attemptDigest) || result.attemptDigest !== terminalAttemptDigest(attempt as unknown as Record<string, unknown>)) throw new Error('attempt digest does not match exact terminal receipt bytes');
  const attemptBinding = attempt.evidenceBinding;
  const producerDigest = `sha256:${sha256Bytes(canonicalizeBoundaryRun(result.producer))}`;
  const platformDigest = `sha256:${sha256Bytes(canonicalizeBoundaryRun(result.platform))}`;
  const scannerPolicyReceipt = validateScannerPolicyReceipt(result.scannerPolicyReceipt);
  const scannerPolicyReceiptDigest = `sha256:${sha256Bytes(canonicalizeBoundaryRun(scannerPolicyReceipt))}`;
  const expectedResultEvidenceDigest = historicalEvidenceDigest ?? controlResultEvidenceDigest(result);
  if (attemptBinding.controlId !== result.controlId || attemptBinding.candidateOid !== result.candidateOid || attemptBinding.manifestDigest !== result.manifestDigest || attemptBinding.policyDigest !== result.policyDigest || attemptBinding.toolDigest !== (result.tool as Record<string, unknown>).digest || attemptBinding.platformDigest !== platformDigest || attemptBinding.preconditionDigest !== preconditionDigest(preconditions, { now: evidenceNow, expected: options.expectedPreconditions }) || attemptBinding.producerDigest !== producerDigest || attemptBinding.scannerPolicyReceiptDigest !== scannerPolicyReceiptDigest || attemptBinding.resultEvidenceDigest !== expectedResultEvidenceDigest) throw new Error('attempt evidence binding does not match the result');
  if (Date.parse(preconditions.createdAt) > Date.parse(attempt.createdAt) || Date.parse(attempt.terminalAt) > createdAt) throw new Error('precondition, attempt, and result chronology is invalid');
  const workspace = preconditions.workspace;
  const revisionMismatch = workspace.candidateOid !== result.candidateOid || workspace.baseOid !== result.baseOid || workspace.mergeOid !== result.mergeOid;
  const platform = result.platform as Record<string, unknown>;
  const platformMismatch = preconditions.host.os !== platform.os || preconditions.host.architecture !== platform.architecture || `${preconditions.runtime.name}@${preconditions.runtime.version}` !== platform.runtime || preconditions.host.digest !== platform.observedCapabilitiesDigest;
  if ((revisionMismatch || platformMismatch) && !(preconditions.outcome === 'inconclusive' && outcome === 'inconclusive')) throw new Error('precondition revision or platform binding mismatch');
  if (preconditions.outcome !== 'pass' && (outcome !== 'inconclusive' || result.code !== 'ci.input.precondition-unproven')) throw new Error('unproven precondition must be the primary inconclusive cause code');
  if (preconditions.outcome === 'pass' && result.code === 'ci.input.precondition-unproven') throw new Error('proven precondition cannot use the precondition-unproven cause code');
  if (attempt.lifecycle === 'terminal') {
    if (attempt.rawExit !== result.exitCode || attempt.rawSignal !== null || attempt.timedOut) throw new Error('terminal direct status does not match the declared outcome');
  } else if (preconditions.outcome === 'pass' && (outcome !== 'inconclusive' || result.code !== 'ci.execution.attempt-inconclusive')) {
    throw new Error('non-success terminal attempt must be the primary inconclusive cause code');
  }

  const computedAggregate = validateCheckSets(result, evidenceNow, options.expectedChecks);
  if (computedAggregate !== null && (computedAggregate !== result.aggregateDecision || outcome !== computedAggregate || result.exitCode !== exitCodeForOutcome(computedAggregate))) throw new Error('aggregate decision does not match exact observed evidence');

  if (outcome === 'pass' || outcome === 'not-applicable') {
    if (result.findingId !== null || result.rootCauseId !== null || result.location !== null || result.why !== null || result.impact !== null || result.fingerprint !== null || result.nextBestAction !== null) throw new Error(`${outcome} result contains diagnostic fields`);
    for (const key of ['guidance', 'relatedFindings', 'relatedFindingIds', 'causedBy', 'supersedes', 'limitations', 'retryConditions', 'scopeLimitations', 'allowedPatchScope', 'prohibitedChanges', 'doNot', 'verificationPlan', 'closureCriteria', 'sensitiveFieldsOmitted', 'publicEvidenceRefs', 'privateEvidenceRefs']) if (requireStringList(result[key], key).length !== 0) throw new Error(`${outcome} result contains diagnostic lists`);
    const patch = requireRecord(result.patchScope, PATCH_SCOPE_KEYS, 'patchScope');
    if (requireStringList(patch.allowed, 'patchScope.allowed').length !== 0 || requireStringList(patch.prohibited, 'patchScope.prohibited').length !== 0) throw new Error(`${outcome} result contains patch guidance`);
    requireRecord(result.reproduce, REPRODUCE_KEYS, 'reproduce');
    const verify = requireRecord(result.verify, VERIFY_KEYS, 'verify');
    if (requireStringList(verify.commands, 'verify.commands').length !== 0 || requireStringList(verify.expected, 'verify.expected').length !== 0) throw new Error(`${outcome} result contains verification guidance`);
    requireRecord(result.exception, EXCEPTION_KEYS, 'exception');
  } else {
    validateDiagnostics(result, options);
  }
  if (outcome === 'not-applicable') {
    if (result.applicability !== 'not-applicable' || result.applicabilityReason !== 'ci.classification.not-applicable') throw new Error('not-applicable result lacks closed classifier reason');
    const producer = result.producer as Record<string, unknown>;
    validateClassifierProof(result.classifierProof, {
      candidateOid: result.candidateOid as string,
      mergeOid: result.mergeOid as string | null,
      policyDigest: result.policyDigest as string,
      classifierDigest: result.classifierDigest as string,
      producer: producer as unknown as ProducerIdentityV1,
    }, evidenceNow);
  } else if (result.applicability !== 'required' || result.applicabilityReason !== null) {
    throw new Error('required result has invalid applicability');
  } else if (result.classifierProof !== null) {
    throw new Error('classifier proof is only valid for not-applicable results');
  }
  return result as unknown as ControlResultV1;
}

export function validateControlResult(value: unknown, options: ControlValidationOptions = {}): ControlResultV1 {
  return validateControlResultInternal(value, options, 'current');
}

export function validateHistoricalControlResult(value: unknown, options: ControlValidationOptions = {}): HistoricalControlResultReadV1 {
  const result = validateControlResultInternal(value, options, 'historical');
  const lifecycle = reasonDefinition(result.code)?.lifecycle;
  if (lifecycle !== 'deprecated' && lifecycle !== 'superseded') throw new Error('historical receipt lifecycle is invalid');
  const clone = frozenCanonicalRecord(value);
  return {
    authorization: 'historical-only',
    lifecycle,
    evidenceDigest: `sha256:${sha256Bytes(canonicalizeBoundaryRun(clone))}`,
    result: clone,
  };
}

export function buildWarningEscalationTransition(
  predecessorValue: unknown,
  options: ControlValidationOptions & { protectedNow: number },
): WarningEscalationTransitionV1 {
  if (!Number.isFinite(options.protectedNow)) throw new Error('protected warning transition clock is invalid');
  const predecessorRecord = requireRecord(predecessorValue, RESULT_KEYS, 'warning predecessor');
  if (!isTimestamp(predecessorRecord.validUntil)) throw new Error('warning predecessor expiry is invalid');
  const expiresAt = Date.parse(predecessorRecord.validUntil);
  if (options.protectedNow < expiresAt) throw new Error('warning has not reached its protected expiry');
  const predecessor = validateControlResult(predecessorRecord, { ...options, now: expiresAt - 1, expectedWarningTransition: null });
  const definition = reasonDefinition(predecessor.code);
  const nativeEvidence = predecessor.nativeEvidence;
  if (definition?.defaultOutcome !== 'warn' || definition.warningPolicy === null || nativeEvidence === null || predecessor.findingId === null || !isEmittableReason(definition.warningPolicy.successorCode)) throw new Error('warning predecessor cannot produce an authoritative successor');
  const successor = reasonDefinition(definition.warningPolicy.successorCode)!;
  if (successor.defaultOutcome !== 'block' && successor.defaultOutcome !== 'inconclusive') throw new Error('warning successor outcome is not authoritative');
  return {
    schemaVersion: 1,
    predecessorCode: predecessor.code,
    successorCode: successor.code,
    predecessorFindingId: predecessor.findingId as string,
    predecessorAttemptId: predecessor.attempt.id,
    predecessorAttemptDigest: predecessor.attemptDigest,
    predecessorResultDigest: controlResultEvidenceDigest(predecessor),
    candidateOid: predecessor.candidateOid,
    policyDigest: predecessor.policyDigest,
    nativeEvidenceDigest: nativeEvidence.evidenceDigest,
    nativeCauseCodes: [...nativeEvidence.nativeCauseCodes].sort(),
    expiresAt: predecessor.validUntil as string,
    transitionedAt: new Date(options.protectedNow).toISOString(),
  };
}

export function buildFindingFingerprint(value: ControlResultV1): string {
  const result = value as unknown as Record<string, unknown>;
  const location = isRecord(result.location) ? result.location : null;
  const tuple = {
    schemaVersion: 1,
    code: result.code,
    controlId: result.controlId,
    domain: result.domain,
    stage: result.stage,
    surface: result.surface,
    candidateOid: result.candidateOid,
    policyDigest: result.policyDigest,
    location,
    claimedScope: result.claimedScope,
    observedScope: result.observedScope,
  };
  return `fp:v1:${sha256Bytes(canonicalizeBoundaryRun(tuple))}`;
}

function requirePublicProjectionOptions(options: ControlValidationOptions | undefined): ControlValidationOptions {
  if (options === undefined || !Array.isArray(options.forbiddenValues) || options.expectedScannerPolicyReceipt === undefined) throw new Error('public output requires a protected scanner policy receipt');
  validateScannerPolicyReceipt(options.expectedScannerPolicyReceipt);
  return options;
}

function scanPublicProjection(bytes: Uint8Array, options: ControlValidationOptions): void {
  const text = Buffer.from(bytes).toString('utf8');
  assertPublicText(text, options.forbiddenValues!);
  if (scanTextForPrivateLiterals('ci-control-public-output.txt', text).some((issue) => issue.severity === 'error')) throw new Error('public output scan did not prove safe exact bytes');
}

function buildPublicProjection(value: ControlResultV1, options?: ControlValidationOptions): { bytes: Uint8Array; result: ControlResultV1 } {
  const publicOptions = requirePublicProjectionOptions(options);
  const result = validateControlResult(value, publicOptions);
  const normalized = {
    ...result,
    requiredChecks: [...result.requiredChecks].sort((left, right) => tupleKey(left).localeCompare(tupleKey(right))),
    observedChecks: [...result.observedChecks].sort((left, right) => tupleKey(left).localeCompare(tupleKey(right))),
  };
  const bytes = Buffer.from(canonicalizeBoundaryRun(normalized), 'utf8');
  if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error('result exceeds byte budget');
  scanPublicProjection(bytes, publicOptions);
  return { bytes, result };
}

export function canonicalizeControlResult(value: ControlResultV1, options?: ControlValidationOptions): Uint8Array {
  return buildPublicProjection(value, options).bytes;
}

export function serializeControlResult(value: ControlResultV1, options?: ControlValidationOptions): string {
  return Buffer.from(canonicalizeControlResult(value, options)).toString('utf8');
}

export function hashControlResult(value: ControlResultV1, options?: ControlValidationOptions): string {
  return `sha256:${sha256Bytes(canonicalizeControlResult(value, options))}`;
}

export function renderControlResult(value: ControlResultV1, options?: ControlValidationOptions): string {
  const publicOptions = requirePublicProjectionOptions(options);
  const result = validateControlResult(value, publicOptions);
  const producer = result.producer as Record<string, unknown>;
  const tool = result.tool as Record<string, unknown>;
  const platform = result.platform as Record<string, unknown>;
  const claimedScope = result.claimedScope as Record<string, unknown>;
  const observedScope = result.observedScope as Record<string, unknown>;
  const scannerPolicy = result.scannerPolicyReceipt as unknown as Record<string, unknown>;
  const preconditions = result.preconditionReceipt as unknown as Record<string, unknown>;
  const attempt = result.attempt as unknown as Record<string, unknown>;
  const risk = result.risk as Record<string, unknown>;
  const nativeEvidence = result.nativeEvidence as unknown as Record<string, unknown> | null;
  const warningGovernance = result.warningGovernance as unknown as Record<string, unknown> | null;
  const warningTransition = result.warningTransition as unknown as Record<string, unknown> | null;
  const lines = [
    `${result.outcome.toUpperCase()} — ${result.code}`,
    `Control: ${result.controlId}`,
    `Owner: ${String(result.owner)}`,
    `Canonical implementation owner: ${String(result.canonicalImplementationOwner)}`,
    `Domain: ${String(result.domain)}`,
    `Stage: ${String(result.stage)}`,
    `Event: ${String(result.eventName)}`,
    `Operation: ${String(result.operation)}`,
    `Trust class: ${String(result.trustClass)}`,
    `Surface: ${String(result.surface)}`,
    `Applicability: ${String(result.applicability)}${result.applicabilityReason === null ? '' : ` ${String(result.applicabilityReason)}`}`,
    `Severity: ${String(result.severity)}`,
    `Confidence: ${String(result.confidence)}`,
    `Evidence state: ${String(result.evidenceState)}`,
    `Base revision: ${String(result.baseOid)}`,
    `Candidate revision: ${result.candidateOid}`,
    `Merge revision: ${String(result.mergeOid)}`,
    `Manifest: ${String(result.manifestDigest)}`,
    `Policy: ${result.policyDigest}`,
    `Classifier: ${String(result.classifierDigest)}`,
    `Producer: ${String(producer.appId)} ${String(producer.workflowSha)} ${String(producer.workflowRef)} run=${String(producer.runId)} attempt=${String(producer.attempt)}`,
    `Tool: ${String(tool.name)} ${String(tool.version)} ${String(tool.digest)}`,
    `Platform: ${String(platform.os)} ${String(platform.architecture)} ${String(platform.runtime)} label=${String(platform.runnerLabel)} capabilities=${String(platform.observedCapabilitiesDigest)}`,
    `Scanner policy: ${String(scannerPolicy.policyDigest)} source=${String(scannerPolicy.sourceOid)} tool=${String(scannerPolicy.toolDigest)}`,
    `Preconditions: ${String(preconditions.outcome)} created=${String(preconditions.createdAt)}`,
    `Terminal attempt: ${String(attempt.id)} ${String(attempt.lifecycle)} digest=${String(result.attemptDigest)}`,
    `Risk: ${String(risk.tier)} ${(risk.reasons as string[]).join(',')}`,
    `Claimed scope: ${String(claimedScope.kind)} ${String(claimedScope.digest)} ${String(claimedScope.itemCount)}`,
    `Observed scope: ${String(observedScope.kind)} ${String(observedScope.digest)} ${String(observedScope.itemCount)}`,
    `Freshness: ${String(result.createdAt)} to ${String(result.validUntil)}`,
  ];
  if (nativeEvidence !== null) {
    const nativeProducer = nativeEvidence.producer as Record<string, unknown>;
    const nativePlatform = nativeEvidence.platform as Record<string, unknown>;
    lines.push(`Native evidence: ${String(nativeEvidence.detectorId)} schema=${String(nativeEvidence.schemaVersion)} digest=${String(nativeEvidence.evidenceDigest)} policy=${String(nativeEvidence.policyDigest)} producer=${String(nativeProducer.appId)} ${String(nativeProducer.workflowSha)} ${String(nativeProducer.workflowRef)} run=${String(nativeProducer.runId)} attempt=${String(nativeProducer.attempt)} platform=${String(nativePlatform.os)}/${String(nativePlatform.architecture)} causes=${(nativeEvidence.nativeCauseCodes as string[]).join(',')}`);
  }
  if (warningGovernance !== null) lines.push(
    `Warning owner: ${String(warningGovernance.owner)}`,
    `Warning remediation SLA: ${String(warningGovernance.remediationSlaHours)} hours`,
    `Warning expiry: ${String(warningGovernance.expiresAfterHours)} hours; first=${String(warningGovernance.firstObservedAt)} due=${String(warningGovernance.remediationDueAt)} expires=${String(warningGovernance.expiresAt)}`,
    `Warning escalation: ${String(warningGovernance.escalationCondition)} successor=${String(warningGovernance.successorCode)}`,
  );
  if (warningTransition !== null) lines.push(`Warning transition: ${String(warningTransition.predecessorCode)} ${String(warningTransition.predecessorResultDigest)} -> ${String(warningTransition.successorCode)} at ${String(warningTransition.transitionedAt)}`);
  if (result.outcome !== 'pass' && result.outcome !== 'not-applicable') {
    const location = result.location as Record<string, unknown>;
    const patch = result.patchScope as Record<string, unknown>;
    const reproduce = result.reproduce as Record<string, unknown>;
    const verify = result.verify as Record<string, unknown>;
    const exception = result.exception as Record<string, unknown>;
    lines.push(`Root cause: ${String(result.rootCauseId)}`, `Location: ${String(location.kind)} ${String(location.name)}`, `Reason: ${String(result.why)}`, `Impact: ${String(result.impact)}`, 'Required change:');
    for (const [index, item] of (result.guidance as string[]).entries()) lines.push(`${index + 1}. ${item}`);
    lines.push('Allowed change:');
    for (const item of patch.allowed as string[]) lines.push(`- ${item}`);
    lines.push('Do not change:');
    for (const item of patch.prohibited as string[]) lines.push(`- ${item}`);
    lines.push('Do not:');
    for (const item of result.doNot as string[]) lines.push(`- ${item}`);
    lines.push(`Next best action: ${String(result.nextBestAction)}`, `Retry class: ${String(result.retryClass)}`, `Remediation class: ${String(result.remediationClass)}`);
    lines.push(`Reproduce: ${String(reproduce.command)}`, 'Reproduce preconditions:');
    for (const item of reproduce.preconditions as string[]) lines.push(`- ${item}`);
    lines.push('Verify:');
    for (const item of verify.commands as string[]) lines.push(`- ${item}`);
    lines.push('Expected verification:');
    for (const item of verify.expected as string[]) lines.push(`- ${item}`);
    lines.push(`Retryable: ${result.retryable ? 'Yes' : 'No'}`, 'Retry conditions:');
    for (const item of result.retryConditions as string[]) lines.push(`- ${item}`);
    lines.push(`Exception: ${exception.eligible ? `Eligible with ${String(exception.approvalRole)}` : 'Not eligible'}`, 'Related findings:');
    for (const item of result.relatedFindings as string[]) lines.push(`- ${item}`);
    lines.push('Caused by:');
    for (const item of result.causedBy as string[]) lines.push(`- ${item}`);
    lines.push('Related finding IDs:');
    for (const item of result.relatedFindingIds as string[]) lines.push(`- ${item}`);
    lines.push('Supersedes:');
    for (const item of result.supersedes as string[]) lines.push(`- ${item}`);
    lines.push('Limitations:');
    for (const item of result.limitations as string[]) lines.push(`- ${item}`);
    lines.push('Scope limitations:');
    for (const item of result.scopeLimitations as string[]) lines.push(`- ${item}`);
    lines.push('Closure criteria:');
    for (const item of result.closureCriteria as string[]) lines.push(`- ${item}`);
    lines.push('Sensitive fields omitted:');
    for (const item of result.sensitiveFieldsOmitted as string[]) lines.push(`- ${item}`);
    lines.push('Public evidence:');
    for (const item of result.publicEvidenceRefs as string[]) lines.push(`- ${item}`);
    lines.push(`Fingerprint: ${String(result.fingerprint)}`);
  }
  const rendered = `${lines.join('\n')}\n`;
  scanPublicProjection(Buffer.from(rendered, 'utf8'), publicOptions);
  return rendered;
}

export function exitCodeForOutcome(value: ControlOutcome | AggregateDecision): ControlExitCode {
  return value === 'block' ? 1 : value === 'inconclusive' ? 2 : 0;
}

export interface AuthoritativeAggregationOptions extends ControlValidationOptions {
  expectedChecks: readonly unknown[];
  expectedLease: SupervisorLeaseExpectationsV1;
  attemptStore: FileAttemptEvidenceStore;
}

export function aggregateOutcomes(values: readonly ControlResultV1[], options: AuthoritativeAggregationOptions): AggregateDecision {
  if (values.length !== 1 || options === undefined || !Array.isArray(options.expectedChecks) || !(options.attemptStore instanceof FileAttemptEvidenceStore)) return 'inconclusive';
  try {
    const result = buildPublicProjection(values[0], options).result;
    if (result.aggregateDecision === null) return 'inconclusive';
    options.attemptStore.readTerminalAttempt(result.attempt.id, result.attemptDigest, result.attempt, { now: options.now, expectedLease: options.expectedLease });
    if (!options.attemptStore.claim(result.attempt.id, result.attemptDigest)) return 'inconclusive';
    return result.aggregateDecision;
  } catch {
    return 'inconclusive';
  }
}

export function parseControlResultJson(input: string | Uint8Array, options: ControlValidationOptions = {}): ControlResultV1 {
  return validateControlResult(parseResultJsonBoundary(input, 'result').value, options);
}

export function parseHistoricalControlResultJson(input: string | Uint8Array, options: ControlValidationOptions = {}): HistoricalControlResultReadV1 {
  const { bytes, value } = parseResultJsonBoundary(input, 'historical result');
  return {
    ...validateHistoricalControlResult(value, options),
    evidenceDigest: `sha256:${sha256Bytes(bytes)}`,
  };
}
