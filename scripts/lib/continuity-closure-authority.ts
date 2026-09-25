// continuity-closure-authority.v1: the owner-approved instance policy that
// gates the `declined` disposition, plus the decision-source verifiers it can
// accept. A digest alone is never authority: every accepted decision must be a
// real inbound resolved from transport-backed database rows.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { ContinuityGapClosureError } from '../../src/core/continuity-gap-closure.ts';
import { isNonEmptyString } from '../../src/lib/type-guards.ts';
import { continuityDestinationFingerprint } from './continuity-manifest-audit.ts';

export const CLOSURE_AUTHORITY_CONTRACT = 'continuity-closure-authority.v1';
export const CLOSURE_DECISION_CONTRACT = 'continuity-closure-decision.v1';
const MAX_POLICY_BYTES = 64 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Verifiers this binary can run. `owner_session_export` is deliberately absent. */
export type DecisionVerifierId = 'original_sender_inbound' | 'owner_inbound';
const VERIFIERS: ReadonlySet<string> = new Set(['original_sender_inbound', 'owner_inbound']);
/** Named sources with no independent actor/session verifier: always Blocked. */
const UNVERIFIABLE_SOURCES: ReadonlySet<string> = new Set(['owner_session_export']);

export interface ClosureAuthorityPolicy {
  contract: typeof CLOSURE_AUTHORITY_CONTRACT;
  policyVersion: string;
  instanceId: string;
  ownerIdentityFingerprints: string[];
  acceptedDecisionSources: Array<{ verifierId: DecisionVerifierId; version: 1 }>;
  effectiveFrom: string;
  effectiveUntil: string | null;
  approvedBy: string;
  approvedAt: string;
}

export interface LoadedClosureAuthorityPolicy {
  policy: ClosureAuthorityPolicy;
  sha256: string;
}

const POLICY_KEYS = [
  'contract', 'policyVersion', 'instanceId', 'ownerIdentityFingerprints',
  'acceptedDecisionSources', 'effectiveFrom', 'effectiveUntil', 'approvedBy', 'approvedAt',
];

function blocked(condition: string, message: string): ContinuityGapClosureError {
  return new ContinuityGapClosureError('blocked', condition, message);
}

function conflict(condition: string, message: string): ContinuityGapClosureError {
  return new ContinuityGapClosureError('conflict', condition, message);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidPolicy(detail: string): ContinuityGapClosureError {
  return conflict('policy_invalid', `Closure authority policy is invalid: ${detail}`);
}

function instant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalidPolicy(`${label} must be a UTC ISO-8601 instant`);
  }
  return value;
}

function nonEmpty(value: unknown, label: string, maxBytes: number): string {
  if (!isNonEmptyString(value) || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalidPolicy(`${label} must be a bounded nonempty string`);
  }
  return value;
}

export function parseClosureAuthorityPolicy(value: unknown): ClosureAuthorityPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidPolicy('root must be an object');
  }
  const root = value as Record<string, unknown>;
  const keys = Object.keys(root);
  if (keys.length !== POLICY_KEYS.length || !POLICY_KEYS.every((key) => keys.includes(key))) {
    throw invalidPolicy('fields must be exactly the v1 policy fields');
  }
  if (root.contract !== CLOSURE_AUTHORITY_CONTRACT) throw invalidPolicy('unsupported contract');
  const owners = root.ownerIdentityFingerprints;
  if (!Array.isArray(owners) || owners.length < 1 || owners.length > 16
    || !owners.every((owner) => typeof owner === 'string' && HASH_PATTERN.test(owner))) {
    throw invalidPolicy('ownerIdentityFingerprints must list 1-16 SHA-256 digests');
  }
  const sources = root.acceptedDecisionSources;
  if (!Array.isArray(sources) || sources.length < 1) {
    throw invalidPolicy('acceptedDecisionSources must be nonempty');
  }
  const accepted = sources.map((source) => {
    const entry = source as Record<string, unknown>;
    if (typeof source !== 'object' || source === null
      || Object.keys(entry).sort().join(',') !== 'verifierId,version'
      || typeof entry.verifierId !== 'string'
      || entry.version !== 1) {
      throw invalidPolicy('acceptedDecisionSources entries must be {verifierId, version: 1}');
    }
    if (!VERIFIERS.has(entry.verifierId)) {
      throw invalidPolicy(`decision source ${entry.verifierId} has no verifier in this binary`);
    }
    return { verifierId: entry.verifierId as DecisionVerifierId, version: 1 as const };
  });
  const approvedBy = root.approvedBy;
  if (typeof approvedBy !== 'string' || !owners.includes(approvedBy)) {
    throw invalidPolicy('approvedBy must be one of the listed owner identities');
  }
  const effectiveFrom = instant(root.effectiveFrom, 'effectiveFrom');
  const effectiveUntil = root.effectiveUntil === null
    ? null
    : instant(root.effectiveUntil, 'effectiveUntil');
  if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) {
    throw invalidPolicy('effectiveUntil must follow effectiveFrom');
  }
  return {
    contract: CLOSURE_AUTHORITY_CONTRACT,
    policyVersion: nonEmpty(root.policyVersion, 'policyVersion', 128),
    instanceId: nonEmpty(root.instanceId, 'instanceId', 256),
    ownerIdentityFingerprints: owners as string[],
    acceptedDecisionSources: accepted,
    effectiveFrom,
    effectiveUntil,
    approvedBy,
    approvedAt: instant(root.approvedAt, 'approvedAt'),
  };
}

/**
 * Reads the protected instance policy: a regular, non-symlink file owned by
 * this user with no group/other permission bits. Its exact byte digest and
 * version are stored in every closure it authorizes.
 */
export function loadClosureAuthorityPolicy(
  policyPath: string,
  instanceId: string,
  decidedAtMs: number,
  nowMs: number,
): LoadedClosureAuthorityPolicy {
  let bytes: Buffer;
  try {
    const link = lstatSync(policyPath);
    if (!link.isFile()) throw new Error('not a regular file');
  } catch {
    throw blocked('policy_unavailable', 'Closure authority policy is missing or not a regular file');
  }
  const fd = openSync(policyPath, 'r');
  try {
    const stat = fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if ((stat.mode & 0o077) !== 0 || stat.uid !== uid) {
      throw blocked(
        'policy_unprotected',
        'Closure authority policy must be owned by this user with no group or other access',
      );
    }
    if (stat.size > MAX_POLICY_BYTES) throw invalidPolicy('file is too large');
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidPolicy('file is not valid JSON');
  }
  const policy = parseClosureAuthorityPolicy(parsed);
  if (policy.instanceId !== instanceId) {
    throw blocked('instance_mismatch', 'Closure authority policy belongs to another instance');
  }
  const from = Date.parse(policy.effectiveFrom);
  const until = policy.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(policy.effectiveUntil);
  const inWindow = (ms: number) => ms >= from && ms < until;
  if (!inWindow(nowMs) || !inWindow(decidedAtMs) || Date.parse(policy.approvedAt) > nowMs) {
    throw blocked(
      'policy_not_effective',
      'Closure authority policy is not effective for this decision time or now',
    );
  }
  return { policy, sha256: sha256(bytes) };
}

export interface DecisionReference {
  source: string;
  verifierVersion: number;
  inboundSeq: number;
  messageSha256: string;
  recordBytes: Buffer;
}

export interface DecisionGapContext {
  planId: string;
  receiptFingerprint: string;
  destinationFingerprint: string;
  originalSenderFingerprint: string;
  originalMessageId: string;
  originalSentAtSec: number;
}

export interface VerifiedDecision {
  verifierId: DecisionVerifierId;
  linkedInboundSeq: number;
  linkedMessageSha256: string;
}

interface DecisionMessageRow {
  message_id: string;
  inbound_conversation_key: string;
  inbound_chat_jid: string;
  sender_jid: string;
  content: string | null;
  content_text: string | null;
  is_from_me: number;
  timestamp: number;
}

/** Checks the decision source is one the policy accepts and this binary can verify. */
export function acceptedVerifier(
  source: string,
  version: number,
  policy: ClosureAuthorityPolicy | null,
): DecisionVerifierId {
  if (UNVERIFIABLE_SOURCES.has(source)) {
    throw blocked(
      'decision_source_unverified',
      `Decision source ${source} has no independent actor/session verifier`,
    );
  }
  if (!VERIFIERS.has(source) || version !== 1) {
    throw conflict('decision_source_invalid', 'Decision source is not a known verifier version');
  }
  if (policy === null) {
    throw blocked('policy_unavailable', 'A declined closure requires --policy');
  }
  if (!policy.acceptedDecisionSources.some((entry) => entry.verifierId === source)) {
    throw blocked('decision_source_not_accepted', 'The authority policy does not accept this source');
  }
  return source as DecisionVerifierId;
}

function parseDecisionRecord(bytes: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // by design: an unparseable record falls through to decision_bytes_changed below.
  }
  throw conflict('decision_bytes_changed', 'Decision record is not a v1 decision object');
}

/**
 * Resolves the decision from transport-backed rows and binds it to this
 * receipt: the inbound must exist, be later than the original, come from the
 * accepted actor, and its exact text must match the decision record.
 */
export function verifyDecision(
  raw: DatabaseSync,
  verifierId: DecisionVerifierId,
  policy: ClosureAuthorityPolicy,
  decision: DecisionReference,
  gap: DecisionGapContext,
): VerifiedDecision {
  const record = parseDecisionRecord(decision.recordBytes);
  if (
    record.contract !== CLOSURE_DECISION_CONTRACT
    || record.decision !== 'decline'
    || record.planId !== gap.planId
    || record.receiptFingerprint !== gap.receiptFingerprint
    || record.inboundMessageSha256 !== decision.messageSha256
  ) {
    throw conflict('decision_scope_mismatch', 'Decision record does not bind this receipt and inbound');
  }
  const row = raw.prepare(`
    SELECT inbound.message_id,
           inbound.conversation_key AS inbound_conversation_key,
           inbound.chat_jid AS inbound_chat_jid,
           messages.sender_jid, messages.content, messages.content_text,
           messages.is_from_me, messages.timestamp
    FROM inbound_events inbound
    JOIN messages ON messages.message_id = inbound.message_id
    WHERE inbound.seq = ?
  `).get(decision.inboundSeq) as DecisionMessageRow | undefined;
  if (!row) {
    throw blocked('decision_inbound_missing', 'Decision inbound is not present in the database');
  }
  if (sha256(row.message_id) !== decision.messageSha256) {
    throw conflict('decision_inbound_mismatch', 'Decision inbound message does not match its hash');
  }
  if (
    row.message_id === gap.originalMessageId
    || Number(row.is_from_me) !== 0
    || Number(row.timestamp) <= gap.originalSentAtSec
  ) {
    throw conflict('not_later_live_inbound', 'Decision must be a later real inbound, not the original');
  }
  if (sha256(row.content_text ?? row.content ?? '') !== record.contentSha256) {
    throw conflict('decision_bytes_changed', 'Decision text differs from the decision record');
  }
  const senderFingerprint = sha256(row.sender_jid);
  if (verifierId === 'original_sender_inbound') {
    const sameConversation = continuityDestinationFingerprint(
      row.inbound_conversation_key,
      sha256(row.inbound_chat_jid),
    ) === gap.destinationFingerprint;
    if (!sameConversation) {
      throw conflict('wrong_conversation', 'Original-sender decision is not in the gap conversation');
    }
    if (senderFingerprint !== gap.originalSenderFingerprint) {
      throw conflict('decision_actor_mismatch', 'Decision sender is not the original sender');
    }
  } else if (!policy.ownerIdentityFingerprints.includes(senderFingerprint)) {
    throw conflict('decision_actor_not_owner', 'Decision sender is not a named instance owner');
  }
  return {
    verifierId,
    linkedInboundSeq: decision.inboundSeq,
    linkedMessageSha256: decision.messageSha256,
  };
}
