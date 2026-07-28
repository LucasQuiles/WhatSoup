import {
  canonicalizeBoundaryRun,
  hasExactKeys,
  isOid,
  isRecord,
  sha256Bytes,
} from '../verification/boundary-run/shared.ts';
import {
  MAX_REF_UPDATES,
  evaluateOutgoingRefPolicy,
  isValidGitRefName,
  matchesSameProcessExactRefSetBinding,
  validateRefPolicyReceipt,
  type RefPolicyObservationV1,
  type RefPolicyReceiptV1,
  type RefUpdateV1,
} from './ref-policy.ts';
import {
  digestControlManifest,
  validateControlManifest,
  type ControlManifestV1,
} from './manifest.ts';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INPUT_OBSERVATION_KEYS = [
  'refPolicyObservationDigest',
  'refPolicyReceiptDigest',
  'update',
  'updateIndex',
] as const;
const UPDATE_KEYS = ['localOid', 'localRef', 'operation', 'remoteOid', 'remoteRef'] as const;

export interface PrePushExactRefSetInputObservationV1 {
  updateIndex: number;
  update: RefUpdateV1;
  refPolicyObservationDigest: string;
  refPolicyReceiptDigest: string;
}

export interface PrePushExactRefSetReportOnlyCanaryObservationV1 {
  authorization: 'report-only';
  outcome: 'block' | 'inconclusive';
  exitCode: 1 | 2;
  code: string;
  refPolicyReceiptDigest: string | null;
  updateCount: number;
  revalidatedLocalRefCount: number;
  limitationCodes: readonly string[];
}

export type ReadOnlyLocalRefResolver = (localRef: string) => string | null;

function digest(value: unknown): string {
  return `sha256:${sha256Bytes(canonicalizeBoundaryRun(value))}`;
}

export function refPolicyObservationDigest(observation: RefPolicyObservationV1): string {
  return digest(observation);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function result(
  outcome: PrePushExactRefSetReportOnlyCanaryObservationV1['outcome'],
  code: string,
  receiptDigest: string | null,
  updateCount: number,
  revalidatedLocalRefCount: number,
): PrePushExactRefSetReportOnlyCanaryObservationV1 {
  const limitationCodes = outcome === 'inconclusive' && code === 'ci.refs.transport-authority-unavailable'
    ? ['ci.refs.report-only', 'ci.refs.private-binding-unavailable']
    : ['ci.refs.report-only'];
  return deepFreeze({
    authorization: 'report-only' as const,
    outcome,
    exitCode: outcome === 'block' ? 1 as const : 2 as const,
    code,
    refPolicyReceiptDigest: receiptDigest,
    updateCount,
    revalidatedLocalRefCount,
    limitationCodes,
  }) as PrePushExactRefSetReportOnlyCanaryObservationV1;
}

function validUpdate(value: unknown): value is RefUpdateV1 {
  if (!isRecord(value) || !hasExactKeys(value, UPDATE_KEYS)) return false;
  if (!['create', 'update', 'delete'].includes(String(value.operation)) || !isValidGitRefName(String(value.remoteRef))) return false;
  if (value.operation === 'delete') {
    return value.localRef === null && value.localOid === null && isOid(value.remoteOid);
  }
  if (!isValidGitRefName(String(value.localRef)) || !isOid(value.localOid)) return false;
  return value.operation === 'create' ? value.remoteOid === null : isOid(value.remoteOid);
}

function sameUpdate(left: RefUpdateV1, right: RefUpdateV1): boolean {
  return left.operation === right.operation
    && left.localRef === right.localRef
    && left.localOid === right.localOid
    && left.remoteRef === right.remoteRef
    && left.remoteOid === right.remoteOid;
}

function snapshotUpdates(value: unknown): readonly RefUpdateV1[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REF_UPDATES) return null;
  const updates: RefUpdateV1[] = [];
  for (const update of value) {
    if (!validUpdate(update)) return null;
    updates.push({
      operation: update.operation,
      localRef: update.localRef,
      localOid: update.localOid,
      remoteRef: update.remoteRef,
      remoteOid: update.remoteOid,
    });
  }
  return deepFreeze(updates) as readonly RefUpdateV1[];
}

function receiptObservationMatchesUpdate(
  update: RefUpdateV1,
  observation: RefPolicyObservationV1,
): boolean {
  return update.operation === observation.operation
    && update.localOid === observation.localOid
    && update.remoteOid === observation.remoteOid;
}

function receiptBindsExactUpdates(
  manifest: ControlManifestV1,
  updates: readonly RefUpdateV1[],
  receipt: RefPolicyReceiptV1,
): boolean {
  try {
    if (manifest.outgoingRefPolicy === null
      || receipt.remote === null
      || receipt.manifestDigest === null
      || digestControlManifest(manifest) !== receipt.manifestDigest) return false;
    const regenerated = evaluateOutgoingRefPolicy(
      manifest.outgoingRefPolicy,
      receipt.remote,
      updates,
      receipt.observations.map(({ graphEvidence }) => graphEvidence),
      receipt.manifestDigest,
      new Date(receipt.createdAt),
    );
    return regenerated.evidenceDigest === receipt.evidenceDigest;
  } catch {
    return false;
  }
}

function exactSetMatches(
  updates: readonly RefUpdateV1[],
  observations: unknown,
  receiptObservations: readonly RefPolicyObservationV1[],
  receiptDigest: string,
): boolean {
  if (!Array.isArray(observations)
    || observations.length !== updates.length
    || receiptObservations.length !== updates.length) return false;
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    const observed = observations[index];
    const receiptObservation = receiptObservations[index];
    if (!validUpdate(update)
      || !isRecord(observed)
      || !hasExactKeys(observed, INPUT_OBSERVATION_KEYS)
      || observed.updateIndex !== index
      || !validUpdate(observed.update)
      || !sameUpdate(update, observed.update)
      || !receiptObservationMatchesUpdate(update, receiptObservation)
      || !DIGEST.test(String(observed.refPolicyObservationDigest))
      || observed.refPolicyObservationDigest !== refPolicyObservationDigest(receiptObservation)
      || !DIGEST.test(String(observed.refPolicyReceiptDigest))
      || observed.refPolicyReceiptDigest !== receiptDigest) return false;
  }
  return true;
}

export function evaluatePrePushExactRefSetReportOnlyCanary(
  untrustedUpdates: unknown,
  untrustedReceipt: unknown,
  observations: unknown,
  untrustedManifest: unknown,
  resolveLocalRef: ReadOnlyLocalRefResolver,
): PrePushExactRefSetReportOnlyCanaryObservationV1 {
  const suppliedUpdateCount = Array.isArray(untrustedUpdates) ? untrustedUpdates.length : 0;
  let updates: readonly RefUpdateV1[] | null = null;
  try {
    updates = snapshotUpdates(untrustedUpdates);
  } catch {
    updates = null;
  }
  let receipt: Readonly<RefPolicyReceiptV1>;
  let manifest: Readonly<ControlManifestV1>;
  try {
    const receiptSnapshot = structuredClone(untrustedReceipt);
    receipt = deepFreeze(validateRefPolicyReceipt(receiptSnapshot)) as Readonly<RefPolicyReceiptV1>;
    const manifestSnapshot = structuredClone(untrustedManifest);
    if (validateControlManifest(manifestSnapshot).length > 0) throw new Error('invalid manifest');
    manifest = deepFreeze(manifestSnapshot) as Readonly<ControlManifestV1>;
  } catch {
    return result('inconclusive', 'ci.refs.input-malformed', null, suppliedUpdateCount, 0);
  }
  const sameProcessExactRefSetBound = updates !== null
    && matchesSameProcessExactRefSetBinding(untrustedReceipt, updates, receipt.evidenceDigest);

  let exactSetValid = false;
  try {
    exactSetValid = updates !== null
      && sameProcessExactRefSetBound
      && exactSetMatches(updates, observations, receipt.observations, receipt.evidenceDigest)
      && receiptBindsExactUpdates(manifest as ControlManifestV1, updates, receipt as RefPolicyReceiptV1);
  } catch {
    exactSetValid = false;
  }
  if (updates === null || !exactSetValid) {
    return result('inconclusive', 'ci.refs.exact-set-mismatch', receipt.evidenceDigest, suppliedUpdateCount, 0);
  }

  let revalidatedLocalRefCount = 0;
  for (const update of updates) {
    if (update.operation === 'delete') continue;
    let observedOid: string | null;
    try {
      observedOid = resolveLocalRef(update.localRef!);
    } catch {
      return result('inconclusive', 'ci.refs.local-ref-moved', receipt.evidenceDigest, updates.length, revalidatedLocalRefCount);
    }
    if (!isOid(observedOid) || observedOid !== update.localOid) {
      return result('inconclusive', 'ci.refs.local-ref-moved', receipt.evidenceDigest, updates.length, revalidatedLocalRefCount);
    }
    revalidatedLocalRefCount += 1;
  }

  if (receipt.outcome === 'block') {
    return result('block', receipt.code, receipt.evidenceDigest, updates.length, revalidatedLocalRefCount);
  }
  if (receipt.outcome === 'inconclusive') {
    return result('inconclusive', receipt.code, receipt.evidenceDigest, updates.length, revalidatedLocalRefCount);
  }
  return result('inconclusive', 'ci.refs.transport-authority-unavailable', receipt.evidenceDigest, updates.length, revalidatedLocalRefCount);
}
