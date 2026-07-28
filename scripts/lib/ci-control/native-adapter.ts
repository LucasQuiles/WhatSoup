import {
  parseBoundaryReceiptBytes,
  validateBoundaryReceipt,
  type ValidatedBoundaryReceipt,
} from '../semantic-quality/receipt.ts';
import type { BoundaryRunManifest } from '../verification/boundary-run/model.ts';
import { validateBoundaryRun } from '../verification/boundary-run/schema.ts';
import {
  canonicalizeBoundaryRun,
  hasExactKeys,
  isOid,
  isRecord,
  sha256Bytes,
} from '../verification/boundary-run/shared.ts';
import { assertBoundedEvidenceGraph } from './preconditions.ts';
import type { NativeEvidenceV1 } from './result.ts';
import {
  validateRepoHygieneExactRangeArtifact,
  type RepoHygieneExactRangeArtifactV1,
  type RepoHygieneExactRangeExpectedV1,
  type RepoHygieneExactRangeReceiptV1,
} from '../../repo-hygiene-guard.ts';
import {
  validatePublicationExactRangeArtifact,
  type PublicationExactRangeArtifactV1,
  type PublicationExactRangeExpectedV1,
  type PublicationExactRangeReceiptV1,
} from '../../publication-guard.ts';

export interface NativeBindingV1 {
  detectorId: 'semantic-quality' | 'boundary-run';
  schemaVersion: 1;
  evidenceDigest: string;
  policyDigest: string;
  candidateOid: string;
  baseOid: string | null;
  mergeBaseOid: string | null;
  producer: {
    appId: string;
    workflowRef: string;
    workflowSha: string;
    runId: string;
    attempt: number;
  };
  platform: { architecture: string; os: string };
}

export interface NativeAdapterResult {
  outcome: 'pass' | 'warn' | 'block' | 'inconclusive' | 'not-applicable';
  code: string;
  nativeCauseCodes: string[];
  nativeCauseCompleteness: 'complete' | 'unavailable';
  nativeStatusRefs: string[];
  limitationCodes: string[];
  evidenceDigest?: string;
  policyDigest?: string;
  producer?: NativeBindingV1['producer'];
  platform?: NativeBindingV1['platform'];
  nativeEvidence?: NativeEvidenceV1;
}

type NativeExactRangeReceiptV1 =
  | RepoHygieneExactRangeReceiptV1
  | PublicationExactRangeReceiptV1;

export interface NativeExactRangeReportOnlyObservationV1<
  TReceipt extends NativeExactRangeReceiptV1 = NativeExactRangeReceiptV1,
> {
  authorization: 'report-only';
  outcome: 'pass' | 'block' | 'inconclusive';
  code:
    | 'ci.check.passed'
    | 'ci.native.repository-hygiene.finding'
    | 'ci.native.privacy-publication.finding'
    | 'ci.native.receipt-unavailable';
  nativeCauseCodes: readonly string[];
  nativeCauseCompleteness: 'complete' | 'unavailable';
  nativeStatusRefs: readonly string[];
  limitationCodes: readonly string[];
  nativeReceipt: TReceipt | null;
  externalPayloadSha256: string | null;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const EMPTY_EXACT_RANGE_CODES = Object.freeze([] as string[]) as readonly string[];
const UNAVAILABLE_EXACT_RANGE_LIMITATIONS = Object.freeze([
  'ci.native.evidence-unavailable',
] as string[]) as readonly string[];

function unavailable(): NativeAdapterResult {
  return {
    outcome: 'inconclusive',
    code: 'ci.native.receipt-unavailable',
    nativeCauseCodes: [],
    nativeCauseCompleteness: 'unavailable',
    nativeStatusRefs: [],
    limitationCodes: ['ci.native.evidence-unavailable'],
  };
}

function unavailableExactRange<TReceipt extends NativeExactRangeReceiptV1>(
  nativeStatusRef: string,
): NativeExactRangeReportOnlyObservationV1<TReceipt> {
  return Object.freeze({
    authorization: 'report-only',
    outcome: 'inconclusive',
    code: 'ci.native.receipt-unavailable',
    nativeCauseCodes: EMPTY_EXACT_RANGE_CODES,
    nativeCauseCompleteness: 'unavailable',
    nativeStatusRefs: Object.freeze([nativeStatusRef]),
    limitationCodes: UNAVAILABLE_EXACT_RANGE_LIMITATIONS,
    nativeReceipt: null,
    externalPayloadSha256: null,
  });
}

function exactRangeObservation<TReceipt extends NativeExactRangeReceiptV1>(
  receipt: TReceipt,
  externalPayloadSha256: string,
  blockCode: 'ci.native.repository-hygiene.finding' | 'ci.native.privacy-publication.finding',
): NativeExactRangeReportOnlyObservationV1<TReceipt> {
  return Object.freeze({
    authorization: receipt.authorization,
    outcome: receipt.outcome,
    code: receipt.outcome === 'pass' ? 'ci.check.passed' : blockCode,
    nativeCauseCodes: receipt.nativeCauses,
    nativeCauseCompleteness: receipt.completeness,
    nativeStatusRefs: EMPTY_EXACT_RANGE_CODES,
    limitationCodes: EMPTY_EXACT_RANGE_CODES,
    nativeReceipt: receipt,
    externalPayloadSha256,
  });
}

export function adaptRepoHygieneExactRangeReportOnly(
  artifact: RepoHygieneExactRangeArtifactV1,
  expected: RepoHygieneExactRangeExpectedV1,
): NativeExactRangeReportOnlyObservationV1<RepoHygieneExactRangeReceiptV1> {
  try {
    const validation = validateRepoHygieneExactRangeArtifact(artifact, expected);
    if (!validation.ok) return unavailableExactRange(validation.error.code);
    return exactRangeObservation(
      validation.receipt,
      expected.expectedPayloadSha256,
      'ci.native.repository-hygiene.finding',
    );
  } catch {
    return unavailableExactRange('repo-hygiene.exact-range.receipt-invalid');
  }
}

export function adaptPublicationExactRangeReportOnly(
  artifact: PublicationExactRangeArtifactV1,
  expected: PublicationExactRangeExpectedV1,
): NativeExactRangeReportOnlyObservationV1<PublicationExactRangeReceiptV1> {
  try {
    const validation = validatePublicationExactRangeArtifact(artifact, expected);
    if (!validation.ok) return unavailableExactRange(validation.error.code);
    return exactRangeObservation(
      validation.receipt,
      expected.expectedPayloadSha256,
      'ci.native.privacy-publication.finding',
    );
  } catch {
    return unavailableExactRange('publication.exact-range.receipt-invalid');
  }
}

function bindingIsValid(binding: NativeBindingV1, detectorId: NativeBindingV1['detectorId']): boolean {
  return binding.detectorId === detectorId
    && binding.schemaVersion === 1
    && DIGEST.test(binding.evidenceDigest)
    && DIGEST.test(binding.policyDigest)
    && isOid(binding.candidateOid)
    && (binding.baseOid === null || isOid(binding.baseOid))
    && (binding.mergeBaseOid === null || isOid(binding.mergeBaseOid))
    && isRecord(binding.producer)
    && hasExactKeys(binding.producer, ['appId', 'attempt', 'runId', 'workflowRef', 'workflowSha'])
    && typeof binding.producer.appId === 'string'
    && typeof binding.producer.workflowRef === 'string'
    && typeof binding.producer.runId === 'string'
    && isOid(binding.producer.workflowSha)
    && Number.isSafeInteger(binding.producer.attempt)
    && binding.producer.attempt > 0
    && isRecord(binding.platform)
    && hasExactKeys(binding.platform, ['architecture', 'os'])
    && typeof binding.platform.architecture === 'string'
    && typeof binding.platform.os === 'string';
}

function evidenceDigest(value: unknown): string {
  return `sha256:${sha256Bytes(canonicalizeBoundaryRun(value))}`;
}

function nativeEvidence(binding: NativeBindingV1, nativeCauseCodes: string[]): NativeEvidenceV1 {
  return {
    detectorId: binding.detectorId,
    schemaVersion: binding.schemaVersion,
    evidenceDigest: binding.evidenceDigest,
    nativeCauseCodes,
    policyDigest: binding.policyDigest,
    producer: binding.producer,
    platform: binding.platform,
  };
}

function semanticReceipt(
  value: unknown,
  binding: NativeBindingV1,
): ValidatedBoundaryReceipt | null {
  const fromBytes = value instanceof Uint8Array;
  const receipt = fromBytes
    ? parseBoundaryReceiptBytes(value)
    : validateBoundaryReceipt(value);
  if (
    receipt.invocation !== 'semantic-quality'
    || receipt.base.headOid !== binding.candidateOid
    || receipt.base.baseOid !== binding.baseOid
    || receipt.base.mergeBaseOid !== binding.mergeBaseOid
  ) {
    return null;
  }
  const digest = fromBytes
    ? `sha256:${sha256Bytes(value)}`
    : evidenceDigest(receipt);
  return digest === binding.evidenceDigest ? receipt : null;
}

export function adaptSemanticQuality(value: unknown, binding?: NativeBindingV1): NativeAdapterResult {
  try {
    if (binding === undefined || !bindingIsValid(binding, 'semantic-quality')) return unavailable();
    const receipt = semanticReceipt(value, binding);
    if (receipt === null) return unavailable();
    const nativeCauseCodes = [...new Set(receipt.findings.map((finding) => finding.ruleId))].sort();
    return {
      outcome: receipt.decision,
      code: receipt.decision === 'block' ? 'ci.native.semantic-quality' : receipt.decision === 'inconclusive' ? 'ci.execution.attempt-inconclusive' : receipt.decision === 'warn' ? 'quality.semantic.finding.warning' : 'ci.check.passed',
      nativeCauseCodes,
      nativeCauseCompleteness: receipt.decision === 'pass' || nativeCauseCodes.length > 0 ? 'complete' : 'unavailable',
      nativeStatusRefs: [],
      limitationCodes: receipt.decision === 'pass' || nativeCauseCodes.length > 0 ? [] : ['ci.native.cause-code-unavailable'],
      evidenceDigest: binding.evidenceDigest,
      policyDigest: binding.policyDigest,
      producer: binding.producer,
      platform: binding.platform,
      nativeEvidence: nativeEvidence(binding, nativeCauseCodes),
    };
  } catch {
    return unavailable();
  }
}

function boundaryCandidateOid(manifest: BoundaryRunManifest): string | null {
  return manifest.manifestState === 'finalized' ? manifest.run.terminalHead : manifest.run.entryHead;
}

export function adaptBoundaryRun(value: unknown, binding?: NativeBindingV1): NativeAdapterResult {
  try {
    if (binding === undefined || !bindingIsValid(binding, 'boundary-run')) return unavailable();
    if (binding.baseOid !== null || binding.mergeBaseOid !== null) return unavailable();
    assertBoundedEvidenceGraph(value, { maxDepth: 32, maxItems: 4_096, maxNodes: 65_536, maxStringBytes: 64 * 1_024 });
    const validation = validateBoundaryRun(value);
    if (!validation.ok || !isRecord(value) || evidenceDigest(value) !== binding.evidenceDigest) return unavailable();
    const manifest = value as unknown as BoundaryRunManifest;
    if (boundaryCandidateOid(manifest) !== binding.candidateOid) return unavailable();
    if (manifest.manifestState !== 'finalized') return {
      outcome: 'inconclusive',
      code: 'ci.execution.attempt-inconclusive',
      nativeCauseCodes: [],
      nativeCauseCompleteness: 'unavailable',
      nativeStatusRefs: ['manifest.active'],
      limitationCodes: ['ci.native.cause-code-unavailable', 'ci.native.progress-only'],
      evidenceDigest: binding.evidenceDigest,
      policyDigest: binding.policyDigest,
      producer: binding.producer,
      platform: binding.platform,
      nativeEvidence: nativeEvidence(binding, []),
    };
    const outcome = manifest.overallVerdict === 'Pass' ? 'pass' : manifest.overallVerdict === 'Fail' || manifest.overallVerdict === 'Blocked' ? 'block' : 'inconclusive';
    const nativeStatusRefs = manifest.attempts
      .filter((attempt) => attempt.verdict !== 'Pass')
      .map((attempt) => `attempt.${attempt.id}.${attempt.verdict.toLowerCase()}`)
      .sort();
    if (outcome !== 'pass' && nativeStatusRefs.length === 0) nativeStatusRefs.push(`run.${manifest.overallVerdict.toLowerCase()}`);
    return {
      outcome,
      code: outcome === 'pass' ? 'ci.check.passed' : outcome === 'block' ? 'ci.native.boundary-run' : 'ci.execution.attempt-inconclusive',
      nativeCauseCodes: [],
      nativeCauseCompleteness: outcome === 'pass' ? 'complete' : 'unavailable',
      nativeStatusRefs,
      limitationCodes: outcome === 'pass' ? [] : ['ci.native.cause-code-unavailable'],
      evidenceDigest: binding.evidenceDigest,
      policyDigest: binding.policyDigest,
      producer: binding.producer,
      platform: binding.platform,
      nativeEvidence: nativeEvidence(binding, []),
    };
  } catch {
    return unavailable();
  }
}
