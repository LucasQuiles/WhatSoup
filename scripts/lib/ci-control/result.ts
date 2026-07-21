import { createHash } from 'node:crypto';

import { FileAttemptEvidenceStore, terminalAttemptDigest, validateTerminalAttempt, type SupervisorLeaseExpectationsV1, type TerminalAttemptV1 } from './attempt.ts';
import { assertBoundedEvidenceGraph, preconditionDigest, validatePreconditionReceipt, type PreconditionExpectationsV1, type PreconditionReceiptV1 } from './preconditions.ts';
import { isRegisteredLimitationCode, isRegisteredReason, reasonDefinition } from './reasons.ts';
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
  controlId: string;
  candidateOid: string;
  policyDigest: string;
  scannerPolicyReceipt: ScannerPolicyReceiptV1;
  preconditionReceipt: PreconditionReceiptV1;
  attempt: TerminalAttemptV1;
  attemptDigest: string;
  requiredChecks: RequiredCheckV1[];
  observedChecks: ObservedCheckV1[];
  [key: string]: unknown;
}

interface ProducerTupleV1 { appId: string; workflowSha: string }
interface PlatformTupleV1 { architecture: string; os: string }
export interface ScannerPolicyReceiptV1 {
  schemaVersion: 1;
  policyDigest: string;
  sourceOid: string;
  toolDigest: string;
  sources: Array<{ path: string; blobOid: string }>;
  producer: ProducerTupleV1;
}
interface ClassifierProofV1 {
  schemaVersion: 1;
  reason: 'ci.classification.not-applicable';
  candidateOid: string;
  mergeOid: string | null;
  policyDigest: string;
  classifierDigest: string;
  producer: ProducerTupleV1;
  createdAt: string;
  validUntil: string;
}
interface RequiredCheckV1 {
  id: string;
  expectedProducer: ProducerTupleV1;
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
  producer: ProducerTupleV1 | null;
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

const RESULT_KEYS = ['aggregateDecision', 'applicability', 'applicabilityReason', 'attempt', 'attemptDigest', 'baseOid', 'candidateOid', 'canonicalImplementationOwner', 'classifierDigest', 'classifierProof', 'code', 'confidence', 'controlId', 'createdAt', 'domain', 'eventName', 'exception', 'exitCode', 'findingId', 'fingerprint', 'guidance', 'impact', 'limitations', 'location', 'manifestDigest', 'mergeOid', 'observedChecks', 'operation', 'outcome', 'owner', 'patchScope', 'platform', 'policyDigest', 'preconditionReceipt', 'producer', 'reproduce', 'relatedFindings', 'requiredChecks', 'retryConditions', 'retryable', 'risk', 'scannerPolicyReceipt', 'schemaVersion', 'severity', 'stage', 'surface', 'tool', 'trustClass', 'validUntil', 'verify', 'why'] as const;
const PRODUCER_KEYS = ['appId', 'attempt', 'runId', 'workflowRef', 'workflowSha'] as const;
const PRODUCER_TUPLE_KEYS = ['appId', 'workflowSha'] as const;
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
const REQUIRED_CHECK_KEYS = ['candidateOid', 'expectedPlatform', 'expectedProducer', 'id', 'mergeOid', 'policyDigest'] as const;
const OBSERVED_CHECK_KEYS = ['applicability', 'applicabilityReason', 'candidateOid', 'causeCode', 'classifierProof', 'createdAt', 'evidenceDigest', 'expectedPlatform', 'expectedProducer', 'id', 'limitationCodes', 'mergeOid', 'nativeCauseCodes', 'nativeCauseCompleteness', 'nativeSchemaVersion', 'nativeStatusRefs', 'observedPlatform', 'outcome', 'policyDigest', 'producer', 'validUntil'] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FINGERPRINT = /^fp:v1:[0-9a-f]{64}$/;
const OUTCOMES = new Set<ControlOutcome>(['pass', 'warn', 'block', 'inconclusive', 'not-applicable']);
const AGGREGATES = new Set<AggregateDecision>(['pass', 'block', 'inconclusive']);

export interface ControlValidationOptions {
  now?: number;
  forbiddenValues?: readonly string[];
  expectedChecks?: readonly unknown[];
  expectedPreconditions?: PreconditionExpectationsV1;
  expectedScannerPolicyReceipt?: unknown;
}

export function controlResultEvidenceDigest(value: Record<string, unknown>): string {
  const canonicalSet = (items: unknown): unknown => Array.isArray(items)
    ? [...items].sort((left, right) => canonicalizeBoundaryRun(left).localeCompare(canonicalizeBoundaryRun(right)))
    : items;
  const projection = {
    outcome: value.outcome,
    aggregateDecision: value.aggregateDecision,
    exitCode: value.exitCode,
    code: value.code,
    controlId: value.controlId,
    applicability: value.applicability,
    applicabilityReason: value.applicabilityReason,
    candidateOid: value.candidateOid,
    baseOid: value.baseOid,
    mergeOid: value.mergeOid,
    manifestDigest: value.manifestDigest,
    policyDigest: value.policyDigest,
    classifierDigest: value.classifierDigest,
    classifierProof: value.classifierProof,
    requiredChecks: canonicalSet(value.requiredChecks),
    observedChecks: canonicalSet(value.observedChecks),
  };
  return `sha256:${sha256Bytes(canonicalizeBoundaryRun(projection))}`;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
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
  if (/(?:^|\s)\/(?:Users|home|private|var|tmp)\//.test(value) || /(?:password|token|secret|credential)=[^\s]+/i.test(value) || /:\/\/[^\s/@:]+:[^\s/@]+@/.test(value)) throw new Error('unsafe public diagnostic text');
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

function validateProducerTuple(value: unknown, label: string): ProducerTupleV1 {
  const producer = requireRecord(value, PRODUCER_TUPLE_KEYS, label);
  requireText(producer.appId, `${label}.appId`);
  if (!isOid(producer.workflowSha)) throw new Error(`${label}.workflowSha is invalid`);
  return producer as unknown as ProducerTupleV1;
}

function validatePlatformTuple(value: unknown, label: string): PlatformTupleV1 {
  const platform = requireRecord(value, PLATFORM_TUPLE_KEYS, label);
  requireText(platform.os, `${label}.os`);
  requireText(platform.architecture, `${label}.architecture`);
  return platform as unknown as PlatformTupleV1;
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
  const producer = validateProducerTuple(receipt.producer, 'scanner policy producer');
  return { ...receipt, sources, producer } as unknown as ScannerPolicyReceiptV1;
}

function validateClassifierProof(value: unknown, expected: {
  candidateOid: string;
  classifierDigest: string;
  mergeOid: string | null;
  policyDigest: string;
  producer?: ProducerTupleV1;
}, now: number): ClassifierProofV1 {
  const proof = requireRecord(value, CLASSIFIER_PROOF_KEYS, 'classifier proof');
  if (proof.schemaVersion !== 1 || proof.reason !== 'ci.classification.not-applicable' || proof.candidateOid !== expected.candidateOid || proof.mergeOid !== expected.mergeOid || proof.policyDigest !== expected.policyDigest || proof.classifierDigest !== expected.classifierDigest) throw new Error('classifier proof binding mismatch');
  const producer = validateProducerTuple(proof.producer, 'classifier proof producer');
  if (expected.producer !== undefined && canonicalizeBoundaryRun(producer) !== canonicalizeBoundaryRun(expected.producer)) throw new Error('classifier proof producer mismatch');
  if (!isTimestamp(proof.createdAt) || !isTimestamp(proof.validUntil)) throw new Error('classifier proof timestamps are invalid');
  const createdAt = Date.parse(proof.createdAt);
  const validUntil = Date.parse(proof.validUntil);
  if (createdAt > now + 5 * 60_000 || now - createdAt > MAX_FRESHNESS_MS || validUntil < createdAt || validUntil < now || validUntil - createdAt > MAX_FRESHNESS_MS) throw new Error('classifier proof freshness interval is invalid, stale, or future-dated');
  return { ...proof, producer } as unknown as ClassifierProofV1;
}

function tupleKey(value: RequiredCheckV1): string {
  return canonicalizeBoundaryRun([value.id, value.expectedProducer.appId, value.expectedProducer.workflowSha, value.expectedPlatform.os, value.expectedPlatform.architecture, value.candidateOid, value.mergeOid, value.policyDigest]);
}

function validateRequiredCheck(value: unknown): RequiredCheckV1 {
  const check = requireRecord(value, REQUIRED_CHECK_KEYS, 'required check');
  requireText(check.id, 'required check id');
  const expectedProducer = validateProducerTuple(check.expectedProducer, 'required check expected producer');
  const expectedPlatform = validatePlatformTuple(check.expectedPlatform, 'required check expected platform');
  if (!isOid(check.candidateOid) || !(check.mergeOid === null || isOid(check.mergeOid)) || !isDigest(check.policyDigest)) throw new Error('required check binding is invalid');
  return { ...check, expectedProducer, expectedPlatform } as unknown as RequiredCheckV1;
}

function validateObservedCheck(value: unknown, now: number, classifierDigest: string): ObservedCheckV1 {
  const check = requireRecord(value, OBSERVED_CHECK_KEYS, 'observed check');
  requireText(check.id, 'observed check id');
  const expectedProducer = validateProducerTuple(check.expectedProducer, 'observed expected producer');
  const expectedPlatform = validatePlatformTuple(check.expectedPlatform, 'observed expected platform');
  if (!isOid(check.candidateOid) || !(check.mergeOid === null || isOid(check.mergeOid)) || !isDigest(check.policyDigest) || !OUTCOMES.has(check.outcome as ControlOutcome) || !isRegisteredReason(check.causeCode)) throw new Error('observed check binding is invalid');
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
    const producer = validateProducerTuple(check.producer, 'observed producer');
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
    if (createdAt > now + 5 * 60_000 || now - createdAt > MAX_FRESHNESS_MS || validUntil < createdAt || validUntil < now || validUntil - createdAt > MAX_FRESHNESS_MS) throw new Error('observed check freshness interval is invalid, stale, or future-dated');
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

function validateDiagnostics(result: Record<string, unknown>, forbiddenValues: readonly string[]): void {
  requireText(result.findingId, 'findingId');
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
  const reproduce = requireRecord(result.reproduce, REPRODUCE_KEYS, 'reproduce');
  const reproduceCommand = requireText(reproduce.command, 'reproduce.command')!;
  const reproducePreconditions = requireStringList(reproduce.preconditions, 'reproduce.preconditions', { nonempty: true });
  const verify = requireRecord(result.verify, VERIFY_KEYS, 'verify');
  const verifyCommands = requireStringList(verify.commands, 'verify.commands', { nonempty: true });
  const verifyExpected = requireStringList(verify.expected, 'verify.expected', { nonempty: true });
  const exception = requireRecord(result.exception, EXCEPTION_KEYS, 'exception');
  if (typeof result.retryable !== 'boolean' || typeof exception.eligible !== 'boolean' || !(exception.approvalRole === null || isBoundedText(exception.approvalRole, 128)) || (exception.eligible && exception.approvalRole === null)) throw new Error('retry or exception diagnostic is incomplete');
  const publicText = [locationName, why, impact, owner, canonicalOwner, ...guidance, ...related, ...limitations, ...retryConditions, ...allowed, ...prohibited, reproduceCommand, ...reproducePreconditions, ...verifyCommands, ...verifyExpected];
  publicText.forEach((text) => assertPublicText(text, forbiddenValues));
  if (typeof result.fingerprint !== 'string' || !FINGERPRINT.test(result.fingerprint) || result.fingerprint !== buildFindingFingerprint(result as ControlResultV1)) throw new Error('finding fingerprint is invalid');
}

function validateAlwaysPresent(result: Record<string, unknown>): void {
  for (const key of ['code', 'controlId', 'owner', 'canonicalImplementationOwner', 'domain', 'stage', 'eventName', 'operation', 'trustClass', 'severity', 'confidence', 'surface']) requireText(result[key], key);
  if (!isRegisteredReason(result.code)) throw new Error('result code is unregistered');
  if (result.applicability !== 'required' && result.applicability !== 'not-applicable') throw new Error('result applicability is invalid');
  if (!isOid(result.candidateOid) || !(result.baseOid === null || isOid(result.baseOid)) || !(result.mergeOid === null || isOid(result.mergeOid))) throw new Error('result revision binding is invalid');
  for (const key of ['manifestDigest', 'policyDigest', 'classifierDigest']) if (!isDigest(result[key])) throw new Error(`${key} is invalid`);
  const producer = requireRecord(result.producer, PRODUCER_KEYS, 'producer');
  requireText(producer.appId, 'producer.appId'); requireText(producer.workflowRef, 'producer.workflowRef'); requireText(producer.runId, 'producer.runId');
  if (!isOid(producer.workflowSha) || !Number.isSafeInteger(producer.attempt) || Number(producer.attempt) < 1) throw new Error('producer identity is invalid');
  const tool = requireRecord(result.tool, TOOL_KEYS, 'tool');
  requireText(tool.name, 'tool.name'); requireText(tool.version, 'tool.version'); if (!isDigest(tool.digest)) throw new Error('tool digest is invalid');
  const scannerPolicyReceipt = validateScannerPolicyReceipt(result.scannerPolicyReceipt);
  if (scannerPolicyReceipt.toolDigest !== tool.digest) throw new Error('scanner policy and control tool binding mismatch');
  const platform = requireRecord(result.platform, PLATFORM_KEYS, 'platform');
  for (const key of ['runnerLabel', 'os', 'architecture', 'runtime']) requireText(platform[key], `platform.${key}`);
  if (!isDigest(platform.observedCapabilitiesDigest)) throw new Error('platform capability digest is invalid');
  const risk = requireRecord(result.risk, RISK_KEYS, 'risk');
  if (!['low', 'standard', 'elevated', 'system-wide'].includes(String(risk.tier))) throw new Error('risk tier is invalid');
  requireStringList(risk.reasons, 'risk.reasons');
}

export function validateControlResult(value: unknown, options: ControlValidationOptions = {}): ControlResultV1 {
  assertBoundedEvidenceGraph(value, { maxDepth: MAX_GRAPH_DEPTH, maxItems: MAX_LIST_ITEMS, maxNodes: MAX_GRAPH_NODES, maxStringBytes: MAX_STRING_UTF8_BYTES });
  const result = requireRecord(value, RESULT_KEYS, 'result');
  assertPublicGraph(result, options.forbiddenValues ?? []);
  const canonicalBytes = Buffer.byteLength(canonicalizeBoundaryRun(result), 'utf8');
  if (canonicalBytes > MAX_RESULT_BYTES) throw new Error('result exceeds byte budget');
  if (result.schemaVersion !== 1 || !OUTCOMES.has(result.outcome as ControlOutcome) || !(result.aggregateDecision === null || AGGREGATES.has(result.aggregateDecision as AggregateDecision))) throw new Error('result outcome or aggregate decision is invalid');
  const outcome = result.outcome as ControlOutcome;
  if (result.exitCode !== exitCodeForOutcome(outcome)) throw new Error('outcome and exit code mismatch');
  validateAlwaysPresent(result);
  const reason = reasonDefinition(result.code);
  if (reason === null || reason.defaultOutcome !== outcome) throw new Error('result code and outcome taxonomy mismatch');
  if (!isTimestamp(result.createdAt) || !isTimestamp(result.validUntil)) throw new Error('result timestamps are invalid');
  const now = options.now ?? Date.now();
  const createdAt = Date.parse(result.createdAt);
  const validUntil = Date.parse(result.validUntil);
  if (createdAt > now + 5 * 60_000 || validUntil < createdAt || validUntil < now || now - createdAt > MAX_FRESHNESS_MS || validUntil - createdAt > MAX_FRESHNESS_MS) throw new Error('result freshness interval is invalid, stale, or future-dated');

  if (options.expectedPreconditions === undefined) throw new Error('trusted precondition expectations are required');
  const preconditions = validatePreconditionReceipt(result.preconditionReceipt, { now, expected: options.expectedPreconditions });
  const attempt = validateTerminalAttempt(result.attempt, { now });
  if (!isDigest(result.attemptDigest) || result.attemptDigest !== terminalAttemptDigest(attempt as unknown as Record<string, unknown>)) throw new Error('attempt digest does not match exact terminal receipt bytes');
  const attemptBinding = attempt.evidenceBinding;
  const producerDigest = `sha256:${sha256Bytes(canonicalizeBoundaryRun(result.producer))}`;
  const platformDigest = `sha256:${sha256Bytes(canonicalizeBoundaryRun(result.platform))}`;
  const scannerPolicyReceipt = validateScannerPolicyReceipt(result.scannerPolicyReceipt);
  const scannerPolicyReceiptDigest = `sha256:${sha256Bytes(canonicalizeBoundaryRun(scannerPolicyReceipt))}`;
  if (attemptBinding.controlId !== result.controlId || attemptBinding.candidateOid !== result.candidateOid || attemptBinding.manifestDigest !== result.manifestDigest || attemptBinding.policyDigest !== result.policyDigest || attemptBinding.toolDigest !== (result.tool as Record<string, unknown>).digest || attemptBinding.platformDigest !== platformDigest || attemptBinding.preconditionDigest !== preconditionDigest(preconditions, { now, expected: options.expectedPreconditions }) || attemptBinding.producerDigest !== producerDigest || attemptBinding.scannerPolicyReceiptDigest !== scannerPolicyReceiptDigest || attemptBinding.resultEvidenceDigest !== controlResultEvidenceDigest(result)) throw new Error('attempt evidence binding does not match the result');
  if (Date.parse(preconditions.createdAt) > Date.parse(attempt.createdAt) || Date.parse(attempt.terminalAt) > createdAt) throw new Error('precondition, attempt, and result chronology is invalid');
  const workspace = preconditions.workspace;
  const revisionMismatch = workspace.candidateOid !== result.candidateOid || workspace.baseOid !== result.baseOid || workspace.mergeOid !== result.mergeOid;
  const platform = result.platform as Record<string, unknown>;
  const platformMismatch = preconditions.host.os !== platform.os || preconditions.host.architecture !== platform.architecture || `${preconditions.runtime.name}@${preconditions.runtime.version}` !== platform.runtime || preconditions.host.digest !== platform.observedCapabilitiesDigest;
  if ((revisionMismatch || platformMismatch) && !(preconditions.outcome === 'inconclusive' && outcome === 'inconclusive')) throw new Error('precondition revision or platform binding mismatch');
  if (preconditions.outcome !== 'pass' && (outcome !== 'inconclusive' || result.code !== 'ci.input.precondition-unproven')) throw new Error('unproven precondition must be the primary inconclusive cause code');
  if (attempt.lifecycle === 'terminal') {
    if (attempt.rawExit !== result.exitCode || attempt.rawSignal !== null || attempt.timedOut) throw new Error('terminal direct status does not match the declared outcome');
  } else if (preconditions.outcome === 'pass' && (outcome !== 'inconclusive' || result.code !== 'ci.execution.attempt-inconclusive')) {
    throw new Error('non-success terminal attempt must be the primary inconclusive cause code');
  }

  const computedAggregate = validateCheckSets(result, now, options.expectedChecks);
  if (computedAggregate !== null && (computedAggregate !== result.aggregateDecision || outcome !== computedAggregate || result.exitCode !== exitCodeForOutcome(computedAggregate))) throw new Error('aggregate decision does not match exact observed evidence');

  if (outcome === 'pass' || outcome === 'not-applicable') {
    if (result.findingId !== null || result.location !== null || result.why !== null || result.impact !== null || result.fingerprint !== null) throw new Error(`${outcome} result contains diagnostic fields`);
    for (const key of ['guidance', 'relatedFindings', 'limitations', 'retryConditions']) if (requireStringList(result[key], key).length !== 0) throw new Error(`${outcome} result contains diagnostic lists`);
    const patch = requireRecord(result.patchScope, PATCH_SCOPE_KEYS, 'patchScope');
    if (requireStringList(patch.allowed, 'patchScope.allowed').length !== 0 || requireStringList(patch.prohibited, 'patchScope.prohibited').length !== 0) throw new Error(`${outcome} result contains patch guidance`);
    requireRecord(result.reproduce, REPRODUCE_KEYS, 'reproduce');
    const verify = requireRecord(result.verify, VERIFY_KEYS, 'verify');
    if (requireStringList(verify.commands, 'verify.commands').length !== 0 || requireStringList(verify.expected, 'verify.expected').length !== 0) throw new Error(`${outcome} result contains verification guidance`);
    requireRecord(result.exception, EXCEPTION_KEYS, 'exception');
  } else {
    validateDiagnostics(result, options.forbiddenValues ?? []);
  }
  if (outcome === 'not-applicable') {
    if (result.applicability !== 'not-applicable' || result.applicabilityReason !== 'ci.classification.not-applicable') throw new Error('not-applicable result lacks closed classifier reason');
    const producer = result.producer as Record<string, unknown>;
    validateClassifierProof(result.classifierProof, {
      candidateOid: result.candidateOid as string,
      mergeOid: result.mergeOid as string | null,
      policyDigest: result.policyDigest as string,
      classifierDigest: result.classifierDigest as string,
      producer: { appId: producer.appId as string, workflowSha: producer.workflowSha as string },
    }, now);
  } else if (result.applicability !== 'required' || result.applicabilityReason !== null) {
    throw new Error('required result has invalid applicability');
  } else if (result.classifierProof !== null) {
    throw new Error('classifier proof is only valid for not-applicable results');
  }
  return result as unknown as ControlResultV1;
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
  };
  return `fp:v1:${sha256Bytes(canonicalizeBoundaryRun(tuple))}`;
}

function requirePublicProjectionOptions(options: ControlValidationOptions | undefined): ControlValidationOptions {
  if (options === undefined || !Array.isArray(options.forbiddenValues) || options.expectedScannerPolicyReceipt === undefined) throw new Error('public output requires a protected scanner policy receipt');
  validateScannerPolicyReceipt(options.expectedScannerPolicyReceipt);
  return options;
}

function requireExpectedScannerPolicy(result: ControlResultV1, options: ControlValidationOptions): void {
  const expected = validateScannerPolicyReceipt(options.expectedScannerPolicyReceipt);
  if (canonicalizeBoundaryRun(result.scannerPolicyReceipt) !== canonicalizeBoundaryRun(expected)) throw new Error('scanner policy receipt does not match protected evidence');
}

function scanPublicProjection(bytes: Uint8Array, options: ControlValidationOptions): void {
  const text = Buffer.from(bytes).toString('utf8');
  assertPublicText(text, options.forbiddenValues!);
  if (scanTextForPrivateLiterals('ci-control-public-output.txt', text).some((issue) => issue.severity === 'error')) throw new Error('public output scan did not prove safe exact bytes');
}

function buildPublicProjection(value: ControlResultV1, options?: ControlValidationOptions): { bytes: Uint8Array; result: ControlResultV1 } {
  const publicOptions = requirePublicProjectionOptions(options);
  const result = validateControlResult(value, publicOptions);
  requireExpectedScannerPolicy(result, publicOptions);
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
  requireExpectedScannerPolicy(result, publicOptions);
  const producer = result.producer as Record<string, unknown>;
  const tool = result.tool as Record<string, unknown>;
  const platform = result.platform as Record<string, unknown>;
  const lines = [
    `${result.outcome.toUpperCase()} — ${result.code}`,
    `Control: ${result.controlId}`,
    `Owner: ${String(result.owner)}`,
    `Canonical implementation owner: ${String(result.canonicalImplementationOwner)}`,
    `Domain: ${String(result.domain)}`,
    `Stage: ${String(result.stage)}`,
    `Operation: ${String(result.operation)}`,
    `Trust class: ${String(result.trustClass)}`,
    `Severity: ${String(result.severity)}`,
    `Confidence: ${String(result.confidence)}`,
    `Base revision: ${String(result.baseOid)}`,
    `Candidate revision: ${result.candidateOid}`,
    `Merge revision: ${String(result.mergeOid)}`,
    `Manifest: ${String(result.manifestDigest)}`,
    `Policy: ${result.policyDigest}`,
    `Classifier: ${String(result.classifierDigest)}`,
    `Producer: ${String(producer.appId)} ${String(producer.workflowSha)}`,
    `Tool: ${String(tool.name)} ${String(tool.version)} ${String(tool.digest)}`,
    `Platform: ${String(platform.os)} ${String(platform.architecture)} ${String(platform.runtime)}`,
  ];
  if (result.outcome !== 'pass' && result.outcome !== 'not-applicable') {
    const location = result.location as Record<string, unknown>;
    const patch = result.patchScope as Record<string, unknown>;
    const reproduce = result.reproduce as Record<string, unknown>;
    const verify = result.verify as Record<string, unknown>;
    const exception = result.exception as Record<string, unknown>;
    lines.push(`Location: ${String(location.kind)} ${String(location.name)}`, `Reason: ${String(result.why)}`, `Impact: ${String(result.impact)}`, 'Required change:');
    for (const [index, item] of (result.guidance as string[]).entries()) lines.push(`${index + 1}. ${item}`);
    lines.push('Allowed change:');
    for (const item of patch.allowed as string[]) lines.push(`- ${item}`);
    lines.push('Do not change:');
    for (const item of patch.prohibited as string[]) lines.push(`- ${item}`);
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
    lines.push('Limitations:');
    for (const item of result.limitations as string[]) lines.push(`- ${item}`);
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
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength > MAX_RESULT_BYTES) throw new Error('result exceeds byte budget');
  const parsed = parseBoundaryJsonBytes(bytes);
  if (!parsed.result.ok || parsed.value === null) {
    const issue = parsed.result.issues[0];
    throw new Error(issue === undefined ? 'result JSON is invalid' : `result JSON is invalid (${issue.code})`);
  }
  return validateControlResult(parsed.value, options);
}
