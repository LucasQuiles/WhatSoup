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
  authorization: 'report-only';
  classification: Readonly<RiskClassificationV1>;
  receiptBytes: Uint8Array;
  evidenceDigest: string;
}

const EXACT_INPUT_KEYS = ['baseOid', 'candidateOid', 'eventName', 'manifestDigest', 'mergeOid'] as const;
const EVENTS = new Set(['pull_request', 'merge_group', 'push', 'tag', 'local']);
const OID = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;
const TYPED_ARRAY_TO_STRING_TAG = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;

function fail(code: RiskClassificationReceiptErrorCode): never {
  throw new RiskClassificationReceiptError(code);
}

function snapshotReceiptBytes(receiptBytes: Uint8Array): Uint8Array {
  let byteLength: number;
  try {
    if (TYPED_ARRAY_BYTE_LENGTH === undefined
      || TYPED_ARRAY_TO_STRING_TAG === undefined
      || Reflect.apply(TYPED_ARRAY_TO_STRING_TAG, receiptBytes, []) !== 'Uint8Array') {
      fail('ci.classification.receipt.malformed');
    }
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, receiptBytes, []) as number;
  } catch (error) {
    if (error instanceof RiskClassificationReceiptError) throw error;
    fail('ci.classification.receipt.malformed');
  }
  if (byteLength > MAX_CLASSIFICATION_RECEIPT_BYTES) {
    fail('ci.classification.receipt.byte-budget');
  }
  const snapshot = new Uint8Array(byteLength);
  try {
    Reflect.apply(Uint8Array.prototype.set, snapshot, [receiptBytes]);
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
  return Uint8Array.from(bytes);
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
  return {
    authorization: 'report-only',
    classification,
    receiptBytes: Uint8Array.from(canonicalBytes),
    evidenceDigest: riskClassificationEvidenceDigest(trustedInput, classification as RiskClassificationV1),
  };
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
