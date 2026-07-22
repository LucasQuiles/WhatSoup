import { Buffer } from 'node:buffer';

import {
  classifyExactRevision,
  type ExactRevisionInput,
  type RiskClassificationV1,
} from './classifier.ts';
import { assertBoundedEvidenceGraph } from './preconditions.ts';
import { parseBoundaryJsonBytes } from '../verification/boundary-run/schema.ts';
import {
  canonicalizeBoundaryRun,
  hasExactKeys,
  sha256Bytes,
} from '../verification/boundary-run/shared.ts';

export const MAX_CLASSIFICATION_RECEIPT_BYTES = 256 * 1024;

export type RiskClassificationReceiptErrorCode =
  | 'ci.classification.receipt.byte-budget'
  | 'ci.classification.receipt.malformed'
  | 'ci.classification.receipt.noncanonical'
  | 'ci.classification.receipt.binding-mismatch'
  | 'ci.classification.receipt.trusted-input-invalid';

export class RiskClassificationReceiptError extends Error {
  readonly code: RiskClassificationReceiptErrorCode;
  readonly outcome = 'inconclusive' as const;
  readonly exitCode = 2 as const;

  constructor(code: RiskClassificationReceiptErrorCode) {
    super(code);
    this.name = 'RiskClassificationReceiptError';
    this.code = code;
  }
}

export interface AdmittedRiskClassificationV1 {
  readonly authorization: 'report-only';
  readonly classification: Readonly<RiskClassificationV1>;
  readonly receiptBytes: Uint8Array;
  readonly evidenceDigest: string;
}

const EXACT_INPUT_KEYS = ['baseOid', 'candidateOid', 'eventName', 'manifestDigest', 'mergeOid'] as const;
const EVENTS = new Set(['pull_request', 'merge_group', 'push', 'tag', 'local']);
const OID = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REFLECT_APPLY = Reflect.apply;
const UINT8_ARRAY_CONSTRUCTOR = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(UINT8_ARRAY_CONSTRUCTOR.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;
const TYPED_ARRAY_TO_STRING_TAG = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;
const UINT8_ARRAY_FROM = UINT8_ARRAY_CONSTRUCTOR.from;
const UINT8_ARRAY_SET = UINT8_ARRAY_CONSTRUCTOR.prototype.set;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const ADMISSION_KEYS = [
  'authorization',
  'classification',
  'receiptBytes',
  'evidenceDigest',
] as const;
interface SameProcessAdmissionBinding {
  classification: Readonly<RiskClassificationV1>;
  receiptBytes: Uint8Array;
  evidenceDigest: string;
  receiptBytesDigest: string;
}
const SAME_PROCESS_ADMISSIONS = new WeakMap<object, Readonly<SameProcessAdmissionBinding>>();

function fail(code: RiskClassificationReceiptErrorCode): never {
  throw new RiskClassificationReceiptError(code);
}

function snapshotReceiptBytes(receiptBytes: Uint8Array): Uint8Array {
  let byteLength: number;
  try {
    if (TYPED_ARRAY_BYTE_LENGTH === undefined
      || TYPED_ARRAY_TO_STRING_TAG === undefined
      || REFLECT_APPLY(TYPED_ARRAY_TO_STRING_TAG, receiptBytes, []) !== 'Uint8Array') {
      fail('ci.classification.receipt.malformed');
    }
    byteLength = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH, receiptBytes, []) as number;
  } catch (error) {
    if (error instanceof RiskClassificationReceiptError) throw error;
    fail('ci.classification.receipt.malformed');
  }
  if (byteLength > MAX_CLASSIFICATION_RECEIPT_BYTES) {
    fail('ci.classification.receipt.byte-budget');
  }
  const snapshot = new UINT8_ARRAY_CONSTRUCTOR(byteLength);
  try {
    REFLECT_APPLY(UINT8_ARRAY_SET, snapshot, [receiptBytes]);
  } catch {
    fail('ci.classification.receipt.malformed');
  }
  return snapshot;
}

function snapshotTrustedInput(input: ExactRevisionInput): ExactRevisionInput {
  try {
    assertBoundedEvidenceGraph(input, {
      maxDepth: 1,
      maxItems: EXACT_INPUT_KEYS.length,
      maxNodes: 1,
      maxStringBytes: 256,
    });
    if (!hasExactKeys(input as unknown as Record<string, unknown>, EXACT_INPUT_KEYS)) {
      fail('ci.classification.receipt.trusted-input-invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const snapshot = {
      eventName: descriptors.eventName?.value,
      baseOid: descriptors.baseOid?.value,
      candidateOid: descriptors.candidateOid?.value,
      mergeOid: descriptors.mergeOid?.value,
      manifestDigest: descriptors.manifestDigest?.value,
    } as ExactRevisionInput;
    if (!EVENTS.has(snapshot.eventName)
      || !(snapshot.baseOid === null || OID.test(snapshot.baseOid))
      || !OID.test(snapshot.candidateOid)
      || !(snapshot.mergeOid === null || OID.test(snapshot.mergeOid))
      || !DIGEST.test(snapshot.manifestDigest)) {
      fail('ci.classification.receipt.trusted-input-invalid');
    }
    const canonical = canonicalizeBoundaryRun(snapshot);
    const parsed = parseBoundaryJsonBytes(Buffer.from(canonical, 'utf8'));
    if (!parsed.result.ok || parsed.text !== canonical) {
      fail('ci.classification.receipt.trusted-input-invalid');
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof RiskClassificationReceiptError) throw error;
    fail('ci.classification.receipt.trusted-input-invalid');
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function detachedClassification(bytes: Uint8Array): Readonly<RiskClassificationV1> {
  const parsed = parseBoundaryJsonBytes(bytes);
  if (!parsed.result.ok || parsed.value === null || typeof parsed.value !== 'object') {
    fail('ci.classification.receipt.malformed');
  }
  return deepFreeze(parsed.value as RiskClassificationV1);
}

export function serializeRiskClassification(
  classification: RiskClassificationV1,
): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(canonicalizeBoundaryRun(classification), 'utf8');
  } catch {
    fail('ci.classification.receipt.malformed');
  }
  if (bytes.byteLength > MAX_CLASSIFICATION_RECEIPT_BYTES) {
    fail('ci.classification.receipt.byte-budget');
  }
  return REFLECT_APPLY(UINT8_ARRAY_FROM, UINT8_ARRAY_CONSTRUCTOR, [bytes]) as Uint8Array;
}

export function riskClassificationEvidenceDigest(
  input: ExactRevisionInput,
  classification: RiskClassificationV1,
): string {
  const trustedInput = snapshotTrustedInput(input);
  let projection: string;
  try {
    projection = canonicalizeBoundaryRun({ classification, trustedInput });
  } catch {
    fail('ci.classification.receipt.malformed');
  }
  return `sha256:${sha256Bytes(projection)}`;
}

function admittedResult(
  trustedInput: ExactRevisionInput,
  canonicalBytes: Uint8Array,
): AdmittedRiskClassificationV1 {
  const classification = detachedClassification(canonicalBytes);
  const receiptBytes = REFLECT_APPLY(
    UINT8_ARRAY_FROM,
    UINT8_ARRAY_CONSTRUCTOR,
    [canonicalBytes],
  ) as Uint8Array;
  const evidenceDigest = riskClassificationEvidenceDigest(
    trustedInput,
    classification as RiskClassificationV1,
  );
  const result = Object.freeze({
    authorization: 'report-only',
    classification,
    receiptBytes,
    evidenceDigest,
  } satisfies AdmittedRiskClassificationV1);
  REFLECT_APPLY(WEAK_MAP_SET, SAME_PROCESS_ADMISSIONS, [result, Object.freeze({
    classification,
    receiptBytes,
    evidenceDigest,
    receiptBytesDigest: sha256Bytes(receiptBytes),
  })]);
  return result;
}

export function matchesSameProcessRiskClassificationAdmission(
  value: unknown,
): value is AdmittedRiskClassificationV1 {
  if (value === null || typeof value !== 'object') return false;
  try {
    const binding = REFLECT_APPLY(
      WEAK_MAP_GET,
      SAME_PROCESS_ADMISSIONS,
      [value],
    ) as Readonly<SameProcessAdmissionBinding> | undefined;
    if (binding === undefined) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== ADMISSION_KEYS.length
      || keys.some((key) => typeof key !== 'string' || !ADMISSION_KEYS.includes(key as typeof ADMISSION_KEYS[number]))) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== ADMISSION_KEYS.length) return false;
    for (const key of ADMISSION_KEYS) {
      const descriptor = descriptors[key];
      if (descriptor === undefined
        || !('value' in descriptor)
        || descriptor.enumerable !== true
        || descriptor.configurable !== false
        || descriptor.writable !== false) return false;
    }
    return descriptors.authorization?.value === 'report-only'
      && descriptors.classification?.value === binding.classification
      && descriptors.receiptBytes?.value === binding.receiptBytes
      && descriptors.evidenceDigest?.value === binding.evidenceDigest
      && sha256Bytes(binding.receiptBytes) === binding.receiptBytesDigest;
  } catch {
    return false;
  }
}

export function createRiskClassificationReceipt(
  cwd: string,
  trustedInput: ExactRevisionInput,
): AdmittedRiskClassificationV1 {
  const snapshot = snapshotTrustedInput(trustedInput);
  const classification = classifyExactRevision(cwd, snapshot);
  const canonicalBytes = serializeRiskClassification(classification);
  return admittedResult(snapshot, canonicalBytes);
}

export function admitRiskClassificationReceipt(
  cwd: string,
  trustedInput: ExactRevisionInput,
  receiptBytes: Uint8Array,
): AdmittedRiskClassificationV1 {
  const snapshot = snapshotTrustedInput(trustedInput);
  const suppliedBytes = snapshotReceiptBytes(receiptBytes);
  const parsed = parseBoundaryJsonBytes(suppliedBytes);
  if (!parsed.result.ok || parsed.value === null || parsed.text === null) {
    fail('ci.classification.receipt.malformed');
  }
  let suppliedCanonical: Uint8Array;
  try {
    suppliedCanonical = Buffer.from(canonicalizeBoundaryRun(parsed.value), 'utf8');
  } catch {
    fail('ci.classification.receipt.malformed');
  }
  if (!Buffer.from(suppliedBytes).equals(Buffer.from(suppliedCanonical))) {
    fail('ci.classification.receipt.noncanonical');
  }
  const recomputed = classifyExactRevision(cwd, snapshot);
  const recomputedBytes = serializeRiskClassification(recomputed);
  if (!Buffer.from(suppliedBytes).equals(Buffer.from(recomputedBytes))) {
    fail('ci.classification.receipt.binding-mismatch');
  }
  return admittedResult(snapshot, recomputedBytes);
}
