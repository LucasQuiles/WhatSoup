import { Buffer } from 'node:buffer';

import {
  canonicalizeBoundaryRun,
  hasExactKeys,
  isOid,
  isRecord,
  isTimestamp,
  sha256Bytes,
} from '../verification/boundary-run/shared.ts';
import { parseBoundaryJsonBytes } from '../verification/boundary-run/schema.ts';
import { isLegacyCompatibleReason, reasonDefinition } from './reasons.ts';

export const MAX_PRE_PUSH_INPUT_BYTES = 32_768;
export const MAX_REF_UPDATES = 128;
export const MAX_REF_POLICY_RECEIPT_BYTES = 128 * 1024;
export const ZERO_OID = '0000000000000000000000000000000000000000';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]{0,253}$/;
const RECEIPT_KEYS = [
  'code',
  'controlId',
  'createdAt',
  'evidenceDigest',
  'exitCode',
  'inputBindingDigest',
  'manifestDigest',
  'observations',
  'outcome',
  'remote',
  'schemaVersion',
] as const;
const OBSERVATION_KEYS = [
  'code',
  'graphEvidence',
  'graphEvidenceDigest',
  'localOid',
  'operation',
  'outcome',
  'refClass',
  'remoteOid',
  'updateBindingDigest',
  'updateIndex',
] as const;
const REMOTE_KEYS = ['name', 'repositoryId'] as const;
const GRAPH_KEYS = ['localObjectType', 'localRefOid', 'objectFormat', 'peeledCommitOid', 'relation', 'remoteObjectAvailable', 'toolDigest', 'trustedBaseAncestor'] as const;
export type RefOperationV1 = 'create' | 'update' | 'delete';
export type RefPolicyOutcome = 'pass' | 'block' | 'inconclusive';

export interface ApprovedRemoteV1 {
  name: string;
  repositoryId: string;
}

export interface OutgoingRefPolicyV1 {
  schemaVersion: 1;
  controlId: 'ci.outgoing-ref-policy';
  remotes: ApprovedRemoteV1[];
  branchNamespace: 'refs/heads/';
  releaseBranches: string[];
  releaseTagPrefixes: string[];
  allowedDeleteRefs: string[];
  branchObjectType: 'commit';
  releaseTagObjectType: 'annotated-tag';
  nonFastForward: 'block';
  unknownRef: 'inconclusive';
}

export interface RefUpdateV1 {
  operation: RefOperationV1;
  localRef: string | null;
  localOid: string | null;
  remoteRef: string;
  remoteOid: string | null;
}

export interface RemoteIdentityV1 {
  name: string;
  repositoryId: string;
}

export interface RefGraphFactV1 {
  objectFormat: 'sha1';
  toolDigest: string;
  localObjectType: 'commit' | 'annotated-tag' | 'other' | 'unavailable';
  relation: 'new' | 'fast-forward' | 'non-fast-forward' | 'unavailable';
  peeledCommitOid: string | null;
  trustedBaseAncestor: boolean | null;
  localRefOid: string | null;
  remoteObjectAvailable: boolean;
}

export interface RefPolicyObservationV1 {
  updateIndex: number;
  updateBindingDigest: string;
  graphEvidenceDigest: string;
  graphEvidence: RefGraphFactV1;
  localOid: string | null;
  operation: RefOperationV1;
  refClass: 'branch' | 'release-branch' | 'release-tag' | 'unknown';
  remoteOid: string | null;
  outcome: RefPolicyOutcome;
  code: string;
}

export interface RefPolicyReceiptV1 {
  schemaVersion: 1;
  controlId: 'ci.outgoing-ref-policy';
  outcome: RefPolicyOutcome;
  exitCode: 0 | 1 | 2;
  code: string;
  remote: RemoteIdentityV1 | null;
  manifestDigest: string | null;
  inputBindingDigest: string | null;
  observations: RefPolicyObservationV1[];
  createdAt: string;
  evidenceDigest: string;
}

export class RefPolicyError extends Error {
  readonly code: string;
  readonly exitCode = 2 as const;

  constructor(code: string) {
    super(code);
    this.name = 'RefPolicyError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RefPolicyError(code);
}

export function isValidGitRefName(value: string): boolean {
  if (!REF.test(value) || value.includes('//') || value.includes('..') || value.includes('@{')) return false;
  if (value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
  if (/[~^:?*\[\\\s\u007f-\uffff]/u.test(value)) return false;
  return value.split('/').every((component) => component.length > 0
    && !component.startsWith('.')
    && !component.endsWith('.'));
}

function parseRow(line: string): RefUpdateV1 {
  const fields = line.split(' ');
  if (fields.length !== 4 || fields.some((field) => field.length === 0)) fail('ci.refs.input-malformed');
  const [localRef, localOid, remoteRef, remoteOid] = fields as [string, string, string, string];
  if ((!isOid(localOid) && localOid !== ZERO_OID) || (!isOid(remoteOid) && remoteOid !== ZERO_OID)) {
    fail('ci.refs.input-malformed');
  }
  if (!isValidGitRefName(remoteRef)) fail('ci.refs.input-malformed');

  if (localRef === '(delete)') {
    if (localOid !== ZERO_OID || remoteOid === ZERO_OID) fail('ci.refs.input-malformed');
    return { operation: 'delete', localRef: null, localOid: null, remoteRef, remoteOid };
  }
  if (!isValidGitRefName(localRef)) {
    if (/[\u0000-\u0020\u007f-\uffff]/u.test(localRef)) fail('ci.refs.input-malformed');
    fail('ci.refs.local-source-unbound');
  }
  if (localOid === ZERO_OID) fail('ci.refs.input-malformed');
  if (remoteOid === ZERO_OID) {
    return { operation: 'create', localRef, localOid, remoteRef, remoteOid: null };
  }
  return { operation: 'update', localRef, localOid, remoteRef, remoteOid };
}

export function parsePrePushInput(bytes: Uint8Array): RefUpdateV1[] {
  if (bytes.byteLength > MAX_PRE_PUSH_INPUT_BYTES) fail('ci.refs.input-budget');
  let input: string;
  try {
    input = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('ci.refs.input-malformed');
  }
  if (input.length === 0 || !input.endsWith('\n') || input.includes('\r')) fail('ci.refs.input-malformed');
  const lines = input.slice(0, -1).split('\n');
  if (lines.length > MAX_REF_UPDATES) fail('ci.refs.input-budget');
  if (lines.some((line) => line.length === 0)) fail('ci.refs.input-malformed');
  const updates = lines.map(parseRow);
  const destinations = new Set<string>();
  for (const update of updates) {
    if (destinations.has(update.remoteRef)) fail('ci.refs.input-duplicate');
    destinations.add(update.remoteRef);
  }
  return updates;
}

function safeIdentityPart(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export function normalizeRemoteIdentity(name: string, location: string): RemoteIdentityV1 {
  if (!safeIdentityPart(name) || location.length === 0 || Buffer.byteLength(location, 'utf8') > 1_024) {
    fail('ci.refs.remote-identity-unavailable');
  }
  let host: string;
  let repositoryPath: string;
  const scp = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+?)(?:\.git)?$/.exec(location);
  if (scp !== null) {
    [, host, repositoryPath] = scp;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(location);
    } catch {
      fail('ci.refs.remote-identity-unavailable');
    }
    if (!['ssh:', 'https:'].includes(parsed.protocol)
      || parsed.password !== ''
      || (parsed.username !== '' && parsed.username !== 'git')
      || parsed.port !== ''
      || parsed.search !== ''
      || parsed.hash !== '') {
      fail('ci.refs.remote-identity-unavailable');
    }
    host = parsed.hostname;
    repositoryPath = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
  }
  if (!safeIdentityPart(host) || repositoryPath.split('/').length !== 2 || !repositoryPath.split('/').every(safeIdentityPart)) {
    fail('ci.refs.remote-identity-unavailable');
  }
  return { name, repositoryId: `${host}/${repositoryPath}` };
}

function digest(value: unknown): string {
  return `sha256:${sha256Bytes(canonicalizeBoundaryRun(value))}`;
}

function publicUpdateBinding(update: RefUpdateV1, refClass: RefPolicyObservationV1['refClass']): string {
  return digest({
    localOid: update.localOid,
    operation: update.operation,
    refClass,
    remoteOid: update.remoteOid,
  });
}

function classifyRef(policy: OutgoingRefPolicyV1, remoteRef: string): RefPolicyObservationV1['refClass'] {
  if (policy.releaseBranches.includes(remoteRef)) return 'release-branch';
  if (policy.releaseTagPrefixes.some((prefix) => remoteRef.startsWith(prefix))) return 'release-tag';
  if (remoteRef.startsWith(policy.branchNamespace)) return 'branch';
  return 'unknown';
}

function observation(
  policy: OutgoingRefPolicyV1,
  update: RefUpdateV1,
  fact: RefGraphFactV1 | undefined,
  updateIndex: number,
): RefPolicyObservationV1 {
  const refClass = classifyRef(policy, update.remoteRef);
  const base = {
    updateIndex,
    updateBindingDigest: publicUpdateBinding(update, refClass),
    graphEvidenceDigest: digest(fact ?? null),
    graphEvidence: fact ?? null,
    localOid: update.localOid,
    operation: update.operation,
    refClass,
    remoteOid: update.remoteOid,
  };
  if (fact === undefined) fail('ci.refs.input-malformed');
  const result = (outcome: RefPolicyOutcome, code: string): RefPolicyObservationV1 => ({ ...base, graphEvidence: fact, outcome, code });

  if (refClass === 'unknown') return result('inconclusive', 'ci.refs.policy-unknown');
  if (update.operation === 'delete') {
    if (refClass === 'release-branch' || refClass === 'release-tag') {
      return result('block', 'ci.refs.delete-prohibited');
    }
    if (policy.allowedDeleteRefs.includes(update.remoteRef)) {
      if (fact?.remoteObjectAvailable !== true) return result('inconclusive', 'ci.refs.graph-unavailable');
      return result('inconclusive', 'ci.refs.private-binding-unavailable');
    }
    return result('block', 'ci.refs.delete-prohibited');
  }
  if (fact === undefined || fact.localRefOid !== update.localOid || fact.localObjectType === 'unavailable') {
    return result('inconclusive', 'ci.refs.graph-unavailable');
  }

  if (refClass === 'release-tag') {
    if (update.operation !== 'create') return result('block', 'ci.refs.force-update-prohibited');
    if (fact.localObjectType !== policy.releaseTagObjectType || !isOid(fact.peeledCommitOid)) {
      return result('block', 'ci.refs.object-type-prohibited');
    }
    if (fact.relation === 'unavailable' || fact.trustedBaseAncestor !== true) return result('inconclusive', 'ci.refs.graph-unavailable');
    return result('pass', 'ci.refs.pass');
  }

  if (fact.localObjectType !== policy.branchObjectType) return result('block', 'ci.refs.object-type-prohibited');
  if (update.operation === 'create') {
    if (fact.relation !== 'new' || fact.trustedBaseAncestor !== true) {
      return result('inconclusive', 'ci.refs.graph-unavailable');
    }
    return result('pass', 'ci.refs.pass');
  }
  if (fact.remoteObjectAvailable !== true || fact.relation === 'unavailable') {
    return result('inconclusive', 'ci.refs.graph-unavailable');
  }
  if (fact.relation === 'non-fast-forward') return result('block', 'ci.refs.force-update-prohibited');
  return result('pass', 'ci.refs.pass');
}

function receiptDigest(value: Omit<RefPolicyReceiptV1, 'evidenceDigest'>): string {
  return digest(value);
}

export function evaluateOutgoingRefPolicy(
  policy: OutgoingRefPolicyV1,
  remote: RemoteIdentityV1,
  updates: readonly RefUpdateV1[],
  graphFacts: readonly RefGraphFactV1[],
  manifestDigest: string,
  now = new Date(),
): RefPolicyReceiptV1 {
  if (!DIGEST.test(manifestDigest) || updates.length === 0 || updates.length > MAX_REF_UPDATES || graphFacts.length !== updates.length) {
    fail('ci.refs.input-malformed');
  }
  const approvedRemote = policy.remotes.some((entry) => entry.name === remote.name && entry.repositoryId === remote.repositoryId);
  const observations = approvedRemote
    ? updates.map((update, index) => observation(policy, update, graphFacts[index], index))
    : updates.map((update, index) => ({
      updateIndex: index,
      updateBindingDigest: publicUpdateBinding(update, classifyRef(policy, update.remoteRef)),
      graphEvidenceDigest: digest(graphFacts[index] ?? null),
      graphEvidence: graphFacts[index]!,
      localOid: update.localOid,
      operation: update.operation,
      refClass: classifyRef(policy, update.remoteRef),
      remoteOid: update.remoteOid,
      outcome: 'block' as const,
      code: 'ci.refs.remote-policy-prohibited',
    }));
  const firstBlock = observations.find(({ outcome }) => outcome === 'block');
  const firstInconclusive = observations.find(({ outcome }) => outcome === 'inconclusive');
  const outcome: RefPolicyOutcome = firstBlock !== undefined ? 'block' : firstInconclusive !== undefined ? 'inconclusive' : 'pass';
  const code = firstBlock?.code ?? firstInconclusive?.code ?? 'ci.refs.pass';
  const withoutDigest = {
    schemaVersion: 1 as const,
    controlId: 'ci.outgoing-ref-policy' as const,
    outcome,
    exitCode: outcome === 'pass' ? 0 as const : outcome === 'block' ? 1 as const : 2 as const,
    code,
    remote,
    manifestDigest,
    inputBindingDigest: digest(observations.map(({ updateIndex, updateBindingDigest }) => ({ updateIndex, updateBindingDigest }))),
    observations,
    createdAt: now.toISOString(),
  };
  return { ...withoutDigest, evidenceDigest: receiptDigest(withoutDigest) };
}

function observationSemanticsValid(entry: RefPolicyObservationV1): boolean {
  if (entry.updateBindingDigest !== digest({
    localOid: entry.localOid,
    operation: entry.operation,
    refClass: entry.refClass,
    remoteOid: entry.remoteOid,
  })) return false;

  const graph = entry.graphEvidence;
  const localMoved = entry.operation !== 'delete' && graph.localRefOid !== entry.localOid;
  if (entry.code === 'ci.refs.pass') {
    if (entry.operation === 'delete') return false;
    if (localMoved) return false;
    if (entry.refClass === 'release-tag') {
      return entry.operation === 'create'
        && graph.localObjectType === 'annotated-tag'
        && isOid(graph.peeledCommitOid)
        && graph.relation === 'new'
        && graph.trustedBaseAncestor === true;
    }
    if (!['branch', 'release-branch'].includes(entry.refClass) || graph.localObjectType !== 'commit') return false;
    if (entry.operation === 'create') return graph.relation === 'new' && graph.trustedBaseAncestor === true;
    return graph.remoteObjectAvailable && graph.relation === 'fast-forward';
  }

  if (entry.code === 'ci.refs.remote-policy-prohibited') return entry.outcome === 'block';
  if (entry.code === 'ci.refs.policy-unknown') return entry.outcome === 'inconclusive' && entry.refClass === 'unknown';
  if (entry.code === 'ci.refs.private-binding-unavailable') {
    return entry.outcome === 'inconclusive'
      && entry.operation === 'delete'
      && entry.refClass === 'branch'
      && graph.remoteObjectAvailable;
  }
  if (entry.code === 'ci.refs.delete-prohibited') return entry.outcome === 'block' && entry.operation === 'delete';
  if (entry.code === 'ci.refs.force-update-prohibited') {
    return entry.outcome === 'block'
      && ((entry.refClass === 'release-tag' && entry.operation !== 'create')
        || (entry.operation === 'update' && graph.relation === 'non-fast-forward'));
  }
  if (entry.code === 'ci.refs.object-type-prohibited') {
    if (entry.outcome !== 'block' || entry.operation === 'delete') return false;
    if (entry.refClass === 'release-tag') return graph.localObjectType !== 'annotated-tag' || !isOid(graph.peeledCommitOid);
    return ['branch', 'release-branch'].includes(entry.refClass) && graph.localObjectType !== 'commit';
  }
  if (entry.code !== 'ci.refs.graph-unavailable' || entry.outcome !== 'inconclusive' || entry.refClass === 'unknown') return false;
  if (entry.operation === 'delete') return !graph.remoteObjectAvailable;
  if (localMoved || graph.localObjectType === 'unavailable') return true;
  if (entry.refClass === 'release-tag') {
    if (graph.localObjectType !== 'annotated-tag' || !isOid(graph.peeledCommitOid)) return false;
    return graph.relation === 'unavailable' || graph.trustedBaseAncestor !== true;
  }
  if (!['branch', 'release-branch'].includes(entry.refClass) || graph.localObjectType !== 'commit') return false;
  if (entry.operation === 'create') return graph.relation !== 'new' || graph.trustedBaseAncestor !== true;
  return !graph.remoteObjectAvailable || graph.relation === 'unavailable';
}

export function validateRefPolicyReceipt(value: unknown): RefPolicyReceiptV1 {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) fail('ci.refs.input-malformed');
  if (value.schemaVersion !== 1 || value.controlId !== 'ci.outgoing-ref-policy') fail('ci.refs.input-malformed');
  const topReason = reasonDefinition(value.code);
  if (!['pass', 'block', 'inconclusive'].includes(String(value.outcome)) || typeof value.code !== 'string' || !value.code.startsWith('ci.refs.') || !isLegacyCompatibleReason(value.code) || topReason === null || topReason.defaultOutcome !== value.outcome) fail('ci.refs.input-malformed');
  const expectedExit = value.outcome === 'pass' ? 0 : value.outcome === 'block' ? 1 : 2;
  if (value.exitCode !== expectedExit || !DIGEST.test(String(value.evidenceDigest)) || !isTimestamp(value.createdAt)) {
    fail('ci.refs.input-malformed');
  }
  const terminalFailure = value.observations instanceof Array && value.observations.length === 0;
  if (terminalFailure) {
    if (value.outcome !== 'inconclusive' || value.remote !== null || value.manifestDigest !== null || value.inputBindingDigest !== null) fail('ci.refs.input-malformed');
  } else {
    if (!DIGEST.test(String(value.manifestDigest)) || !DIGEST.test(String(value.inputBindingDigest))) fail('ci.refs.input-malformed');
    if (!isRecord(value.remote) || !hasExactKeys(value.remote, REMOTE_KEYS) || !safeIdentityPart(String(value.remote.name))) fail('ci.refs.input-malformed');
    if (typeof value.remote.repositoryId !== 'string' || !/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.remote.repositoryId) || Buffer.byteLength(value.remote.repositoryId) > 384) fail('ci.refs.input-malformed');
  }
  if (!Array.isArray(value.observations) || value.observations.length > MAX_REF_UPDATES) fail('ci.refs.input-malformed');
  for (const [index, entry] of value.observations.entries()) {
    if (!isRecord(entry) || !hasExactKeys(entry, OBSERVATION_KEYS) || entry.updateIndex !== index || !DIGEST.test(String(entry.updateBindingDigest)) || !DIGEST.test(String(entry.graphEvidenceDigest))) fail('ci.refs.input-malformed');
    if (!['create', 'update', 'delete'].includes(String(entry.operation)) || !['branch', 'release-branch', 'release-tag', 'unknown'].includes(String(entry.refClass))) fail('ci.refs.input-malformed');
    const entryReason = reasonDefinition(entry.code);
    if (!['pass', 'block', 'inconclusive'].includes(String(entry.outcome)) || typeof entry.code !== 'string' || !entry.code.startsWith('ci.refs.') || !isLegacyCompatibleReason(entry.code) || entryReason === null || entryReason.defaultOutcome !== entry.outcome) fail('ci.refs.input-malformed');
    if ((entry.localOid !== null && !isOid(entry.localOid)) || (entry.remoteOid !== null && !isOid(entry.remoteOid))) fail('ci.refs.input-malformed');
    if ((entry.operation === 'delete' && (entry.localOid !== null || entry.remoteOid === null))
      || (entry.operation === 'create' && (entry.localOid === null || entry.remoteOid !== null))
      || (entry.operation === 'update' && (entry.localOid === null || entry.remoteOid === null))) fail('ci.refs.input-malformed');
    if (!isRecord(entry.graphEvidence) || !hasExactKeys(entry.graphEvidence, GRAPH_KEYS)) fail('ci.refs.input-malformed');
    const graph = entry.graphEvidence;
    if (graph.objectFormat !== 'sha1' || !DIGEST.test(String(graph.toolDigest))
      || !['commit', 'annotated-tag', 'other', 'unavailable'].includes(String(graph.localObjectType))
      || !['new', 'fast-forward', 'non-fast-forward', 'unavailable'].includes(String(graph.relation))
      || (graph.peeledCommitOid !== null && !isOid(graph.peeledCommitOid))
      || (graph.localRefOid !== null && !isOid(graph.localRefOid))
      || ![true, false, null].includes(graph.trustedBaseAncestor as boolean | null)
      || typeof graph.remoteObjectAvailable !== 'boolean'
      || entry.graphEvidenceDigest !== digest(graph)) fail('ci.refs.input-malformed');
    const observation = entry as unknown as RefPolicyObservationV1;
    if (!observationSemanticsValid(observation)) fail('ci.refs.input-malformed');
  }
  if (!terminalFailure) {
    const observations = value.observations as unknown as RefPolicyObservationV1[];
    const expectedInputBinding = digest(observations.map(({ updateIndex, updateBindingDigest }) => ({ updateIndex, updateBindingDigest })));
    if (value.inputBindingDigest !== expectedInputBinding) fail('ci.refs.input-malformed');
    const block = observations.find(({ outcome }) => outcome === 'block');
    const inconclusive = observations.find(({ outcome }) => outcome === 'inconclusive');
    const derivedOutcome = block !== undefined ? 'block' : inconclusive !== undefined ? 'inconclusive' : 'pass';
    const derivedCode = block?.code ?? inconclusive?.code ?? 'ci.refs.pass';
    if (value.outcome !== derivedOutcome || value.code !== derivedCode) fail('ci.refs.input-malformed');
  }
  const { evidenceDigest, ...withoutDigest } = value;
  if (evidenceDigest !== receiptDigest(withoutDigest as Omit<RefPolicyReceiptV1, 'evidenceDigest'>)) fail('ci.refs.input-malformed');
  return value as unknown as RefPolicyReceiptV1;
}

export function buildInconclusiveRefPolicyReceipt(code: string, now = new Date()): RefPolicyReceiptV1 {
  const reason = reasonDefinition(code);
  if (!code.startsWith('ci.refs.') || !isLegacyCompatibleReason(code) || reason?.defaultOutcome !== 'inconclusive') fail('ci.refs.input-malformed');
  const withoutDigest = {
    schemaVersion: 1 as const,
    controlId: 'ci.outgoing-ref-policy' as const,
    outcome: 'inconclusive' as const,
    exitCode: 2 as const,
    code,
    remote: null,
    manifestDigest: null,
    inputBindingDigest: null,
    observations: [],
    createdAt: now.toISOString(),
  };
  return { ...withoutDigest, evidenceDigest: receiptDigest(withoutDigest) };
}

export function parseRefPolicyReceiptBytes(bytes: Uint8Array): RefPolicyReceiptV1 {
  if (bytes.byteLength > MAX_REF_POLICY_RECEIPT_BYTES) fail('ci.refs.input-budget');
  const parsed = parseBoundaryJsonBytes(bytes);
  if (!parsed.result.ok || parsed.value === null) fail('ci.refs.input-malformed');
  return validateRefPolicyReceipt(parsed.value);
}

export function serializeRefPolicyReceipt(value: unknown): Uint8Array {
  const bytes = Buffer.from(canonicalizeBoundaryRun(validateRefPolicyReceipt(value)), 'utf8');
  if (bytes.byteLength > MAX_REF_POLICY_RECEIPT_BYTES) fail('ci.refs.input-budget');
  return bytes;
}
