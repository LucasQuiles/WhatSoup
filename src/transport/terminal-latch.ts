// src/transport/terminal-latch.ts
//
// T1 of the q-canary re-pair enablement lane: the durable terminal latch.
//
// A terminal credential revocation (server-side 401 device_removed) currently
// leaves NO durable trace that restore paths consult: the only in-process
// protection dies with the process, and `restoreLatestIfNeeded()` will happily
// repopulate a quarantined auth directory from the backup store. This module is
// the durable record and the restore DECISION. It deliberately contains no
// producer or consumer wiring — enforcement seams import it later, and nothing
// may write a latch automatically until the verdict lane lands its capture
// boundary.
//
// Design rules, each of which a test enforces:
// - Append-only journal; state transitions never delete or rewrite bytes.
// - Expected-revision CAS: a writer that read revision N may only append N+1.
// - Fail closed: corrupt or ambiguous journal state refuses restore and
//   refuses further appends, preserving the bytes as evidence.
// - Exact candidate binding: restore authority comes from the SPECIFIC backup
//   candidate's manifest + generation receipt, never from a newer global
//   receipt. An unbound legacy backup is refused while a latch is active.
// - Owner release and generation supersession are separate recorded facts;
//   neither is a deletion or a hand-edited tombstone.
//
// A held `.lock` file with no living writer wedges appends closed (never
// open). That is intentional; clearing it is a deliberate operator act.

import { openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendPrivateJsonLineSync,
  readPrivateFileSync,
  fsyncDirectory,
} from '../lib/private-fs.ts';
import { isRecord } from '../lib/type-guards.ts';
import {
  parseAccountScopeId,
  type AccountScopeIdV1,
  type AuthGenerationReceiptV2,
  type BackupCandidateManifestV2,
} from './auth-custody-contracts.ts';

const JOURNAL_FILENAME = 'terminal-latch.journal.ndjson';
const MAX_JOURNAL_BYTES = 256 * 1024;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_TOKEN_LENGTH = 128;

export const TERMINAL_LATCH_REASONS = [
  'serverside_logout_irreversible',
  'device_removed_conflict',
  'owner_declared_terminal',
] as const;
export type TerminalLatchReason = (typeof TERMINAL_LATCH_REASONS)[number];

export interface TerminalLatchV1 {
  v: 1;
  scopeId: AccountScopeIdV1;
  /** Null when the dead generation was never receipted (every pre-S3 bond). */
  latchedGenerationId: string | null;
  /** Digest of the revoked credential tree — the evidence-bound denylist entry. */
  latchedCredentialTreeDigest: string;
  reason: TerminalLatchReason;
  /** Digest of the terminal-event evidence packet backing this latch. */
  evidenceDigest: string;
  latchedAt: string;
}

export const LATCH_TRANSITION_KINDS = [
  'latch_created',
  'generation_superseded',
  'owner_released',
] as const;
export type LatchTransitionKind = (typeof LATCH_TRANSITION_KINDS)[number];

export interface LatchTransitionV1 {
  v: 1;
  scopeId: AccountScopeIdV1;
  kind: LatchTransitionKind;
  revision: number;
  expectedPriorRevision: number;
  at: string;
  /**
   * Single-use token naming the operator/saga action that produced this
   * transition. The journal refuses a replayed operation id, so an apply
   * command retried with the same id cannot double-append.
   */
  operationId: string;
  ownerAuthorizationId: string | null;
  latch: TerminalLatchV1 | null;
  supersededByGenerationId: string | null;
}

export type LatchJournalState =
  | { status: 'missing'; revision: 0 }
  | { status: 'active'; revision: number; latch: TerminalLatchV1 }
  | { status: 'superseded'; revision: number; latch: TerminalLatchV1; supersededByGenerationId: string }
  | { status: 'released'; revision: number; latch: TerminalLatchV1; ownerAuthorizationId: string }
  | { status: 'corrupt' };

export type LatchAppendResult =
  | { ok: true; state: LatchJournalState }
  | {
      ok: false;
      refusal:
        | 'invalid_payload'
        | 'journal_lock_held'
        | 'journal_corrupt'
        | 'revision_conflict'
        | 'operation_replayed'
        | 'invalid_transition';
    };

export function terminalLatchJournalPath(stateRoot: string): string {
  return join(stateRoot, JOURNAL_FILENAME);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  if (present.length !== keys.length) return false;
  return keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
}

function boundedToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) return null;
  return value;
}

function isoInstantMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function hex64(value: unknown): string | null {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) return null;
  return value;
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

const LATCH_KEYS = [
  'v', 'scopeId', 'latchedGenerationId', 'latchedCredentialTreeDigest',
  'reason', 'evidenceDigest', 'latchedAt',
] as const;

export function parseTerminalLatch(value: unknown): TerminalLatchV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, LATCH_KEYS)) return null;
  if (value.v !== 1) return null;
  const scopeId = parseAccountScopeId(value.scopeId);
  const latchedCredentialTreeDigest = hex64(value.latchedCredentialTreeDigest);
  const evidenceDigest = hex64(value.evidenceDigest);
  const latchedAtMs = isoInstantMs(value.latchedAt);
  const reason = TERMINAL_LATCH_REASONS.find(r => r === value.reason) ?? null;
  if (
    scopeId === null || latchedCredentialTreeDigest === null || evidenceDigest === null ||
    latchedAtMs === null || reason === null
  ) {
    return null;
  }
  let latchedGenerationId: string | null = null;
  if (value.latchedGenerationId !== null) {
    latchedGenerationId = boundedToken(value.latchedGenerationId);
    if (latchedGenerationId === null) return null;
  }
  return {
    v: 1,
    scopeId,
    latchedGenerationId,
    latchedCredentialTreeDigest,
    reason,
    evidenceDigest,
    latchedAt: value.latchedAt as string,
  };
}

const TRANSITION_KEYS = [
  'v', 'scopeId', 'kind', 'revision', 'expectedPriorRevision', 'at',
  'operationId', 'ownerAuthorizationId', 'latch', 'supersededByGenerationId',
] as const;

export function parseLatchTransition(value: unknown): LatchTransitionV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, TRANSITION_KEYS)) return null;
  if (value.v !== 1) return null;
  const scopeId = parseAccountScopeId(value.scopeId);
  const kind = LATCH_TRANSITION_KINDS.find(k => k === value.kind) ?? null;
  const revision = nonNegativeInt(value.revision);
  const expectedPriorRevision = nonNegativeInt(value.expectedPriorRevision);
  const atMs = isoInstantMs(value.at);
  const operationId = boundedToken(value.operationId);
  if (
    scopeId === null || kind === null || revision === null || expectedPriorRevision === null ||
    atMs === null || operationId === null
  ) {
    return null;
  }
  if (revision !== expectedPriorRevision + 1) return null;

  let latch: TerminalLatchV1 | null = null;
  if (value.latch !== null) {
    latch = parseTerminalLatch(value.latch);
    if (latch === null) return null;
  }
  let ownerAuthorizationId: string | null = null;
  if (value.ownerAuthorizationId !== null) {
    ownerAuthorizationId = boundedToken(value.ownerAuthorizationId);
    if (ownerAuthorizationId === null) return null;
  }
  let supersededByGenerationId: string | null = null;
  if (value.supersededByGenerationId !== null) {
    supersededByGenerationId = boundedToken(value.supersededByGenerationId);
    if (supersededByGenerationId === null) return null;
  }

  // Kind invariants: each transition carries exactly the payload its kind
  // requires — nothing optional, nothing extra.
  if (kind === 'latch_created') {
    if (latch === null || ownerAuthorizationId !== null || supersededByGenerationId !== null) return null;
    if (latch.scopeId !== scopeId) return null;
  } else if (kind === 'owner_released') {
    if (latch !== null || ownerAuthorizationId === null || supersededByGenerationId !== null) return null;
  } else {
    if (latch !== null || ownerAuthorizationId !== null || supersededByGenerationId === null) return null;
  }

  return {
    v: 1,
    scopeId,
    kind,
    revision,
    expectedPriorRevision,
    at: value.at as string,
    operationId,
    ownerAuthorizationId,
    latch,
    supersededByGenerationId,
  };
}

/**
 * Fold the journal into its current state. Any malformed line, revision
 * discontinuity, illegal transition sequence, or scope drift is `corrupt` —
 * and corrupt refuses everything downstream while preserving the bytes.
 */
export function readTerminalLatchJournal(stateRoot: string): LatchJournalState {
  // An absent journal FILE is 'missing' regardless of parent-directory state:
  // instances that never latched must keep their legacy behavior even on
  // unhardened state roots. Only a PRESENT journal that cannot be read or
  // parsed is 'corrupt' (fail closed).
  if (!existsSync(terminalLatchJournalPath(stateRoot))) {
    return { status: 'missing', revision: 0 };
  }
  let raw: string | null;
  try {
    raw = readPrivateFileSync(terminalLatchJournalPath(stateRoot), {
      maxBytes: MAX_JOURNAL_BYTES,
      label: 'terminal-latch journal',
    });
  } catch {
    return { status: 'corrupt' };
  }
  if (raw === null) return { status: 'missing', revision: 0 };
  if (raw.length === 0 || !raw.endsWith('\n')) return { status: 'corrupt' };

  const lines = raw.slice(0, -1).split('\n');
  let state: LatchJournalState = { status: 'missing', revision: 0 };
  let scope: AccountScopeIdV1 | null = null;

  for (let i = 0; i < lines.length; i++) {
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(lines[i]);
    } catch {
      return { status: 'corrupt' };
    }
    const transition = parseLatchTransition(parsedLine);
    if (transition === null) return { status: 'corrupt' };
    if (transition.revision !== i + 1) return { status: 'corrupt' };
    if (scope === null) {
      scope = transition.scopeId;
    } else if (transition.scopeId !== scope) {
      return { status: 'corrupt' };
    }
    const next = applyTransition(state, transition);
    if (next === null) return { status: 'corrupt' };
    state = next;
  }
  return state;
}

function applyTransition(state: LatchJournalState, transition: LatchTransitionV1): LatchJournalState | null {
  if (state.status === 'corrupt') return null;
  if (transition.kind === 'latch_created') {
    if (state.status === 'active') return null;
    return { status: 'active', revision: transition.revision, latch: transition.latch as TerminalLatchV1 };
  }
  if (state.status !== 'active') return null;
  if (transition.scopeId !== state.latch.scopeId) return null;
  if (transition.kind === 'owner_released') {
    return {
      status: 'released',
      revision: transition.revision,
      latch: state.latch,
      ownerAuthorizationId: transition.ownerAuthorizationId as string,
    };
  }
  return {
    status: 'superseded',
    revision: transition.revision,
    latch: state.latch,
    supersededByGenerationId: transition.supersededByGenerationId as string,
  };
}

/**
 * Append one transition under expected-revision CAS. The `.lock` sibling is
 * held for the read-verify-append window; a held lock refuses (fail closed).
 */
export function appendLatchTransition(stateRoot: string, transitionValue: unknown): LatchAppendResult {
  const transition = parseLatchTransition(transitionValue);
  if (transition === null) return { ok: false, refusal: 'invalid_payload' };

  const journalPath = terminalLatchJournalPath(stateRoot);
  const lockPath = `${journalPath}.lock`;
  let lockFd: number | null = null;
  try {
    try {
      lockFd = openSync(lockPath, 'wx', 0o600);
    } catch {
      return { ok: false, refusal: 'journal_lock_held' };
    }

    const state = readTerminalLatchJournal(stateRoot);
    if (state.status === 'corrupt') return { ok: false, refusal: 'journal_corrupt' };
    if (state.revision !== transition.expectedPriorRevision) {
      return { ok: false, refusal: 'revision_conflict' };
    }
    const usedOperationIds = collectOperationIds(stateRoot);
    if (usedOperationIds === null) return { ok: false, refusal: 'journal_corrupt' };
    if (usedOperationIds.has(transition.operationId)) {
      return { ok: false, refusal: 'operation_replayed' };
    }
    if (applyTransition(state, transition) === null) {
      return { ok: false, refusal: 'invalid_transition' };
    }

    const firstCreate = !existsSync(journalPath);
    appendPrivateJsonLineSync(journalPath, transition);
    if (firstCreate) fsyncDirectory(stateRoot);
    return { ok: true, state: readTerminalLatchJournal(stateRoot) };
  } finally {
    if (lockFd !== null) {
      closeSync(lockFd);
      try {
        unlinkSync(lockPath);
      } catch {
        // intentional: the lock file vanishing underneath us changes nothing
        // about the append that already happened; best-effort cleanup keeps
        // this failure surface out of the caller's result.
      }
    }
  }
}

/** All operation ids ever appended; null when the journal is unreadable/corrupt. */
function collectOperationIds(stateRoot: string): Set<string> | null {
  if (!existsSync(terminalLatchJournalPath(stateRoot))) return new Set();
  let raw: string | null;
  try {
    raw = readPrivateFileSync(terminalLatchJournalPath(stateRoot), {
      maxBytes: MAX_JOURNAL_BYTES,
      label: 'terminal-latch journal',
    });
  } catch {
    return null;
  }
  if (raw === null) return new Set();
  if (!raw.endsWith('\n')) return null;
  const ids = new Set<string>();
  for (const line of raw.slice(0, -1).split('\n')) {
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      return null;
    }
    const transition = parseLatchTransition(parsedLine);
    if (transition === null) return null;
    ids.add(transition.operationId);
  }
  return ids;
}

export interface RestoreCandidateEvidence {
  manifest: BackupCandidateManifestV2 | 'missing' | 'corrupt';
  generationReceipt: AuthGenerationReceiptV2 | 'missing' | 'corrupt';
  /** Digest computed from the candidate's ACTUAL bytes, or null when uncomputable. */
  observedTreeDigest: string | null;
}

export type RestoreDecision =
  | { allow: true; basis: 'no_latch_recorded' | 'latch_not_active' | 'candidate_bound_newer_generation' }
  | {
      allow: false;
      refusal:
        | 'latch_state_corrupt'
        | 'candidate_manifest_corrupt'
        | 'generation_receipt_corrupt'
        | 'latch_active_unbound_candidate'
        | 'latch_active_matches_latched_digest'
        | 'latch_active_digest_mismatch'
        | 'latch_active_candidate_not_newer';
    };

/**
 * The restore decision. Total over every input combination; corrupt or
 * ambiguous evidence never allows. Authority is the CANDIDATE's own binding —
 * a newer global receipt cannot authorize an older backup, because the
 * manifest's sourceGenerationId must equal the offered receipt's generationId
 * and both digests must match the observed bytes.
 */
export function decideRestoreFromCandidate(
  latchState: LatchJournalState,
  candidate: RestoreCandidateEvidence,
): RestoreDecision {
  if (latchState.status === 'corrupt') return { allow: false, refusal: 'latch_state_corrupt' };
  // Corrupt candidate evidence refuses regardless of latch state: a backup
  // whose own records are damaged is ambiguous, and ambiguity never restores.
  // Legacy manifest-less backups are 'missing', not 'corrupt', so the
  // no-latch compatibility path below is unaffected.
  if (candidate.manifest === 'corrupt') return { allow: false, refusal: 'candidate_manifest_corrupt' };
  if (candidate.generationReceipt === 'corrupt') {
    return { allow: false, refusal: 'generation_receipt_corrupt' };
  }
  if (latchState.status === 'missing') return { allow: true, basis: 'no_latch_recorded' };
  if (latchState.status === 'released' || latchState.status === 'superseded') {
    return { allow: true, basis: 'latch_not_active' };
  }

  // Latch ACTIVE from here down.
  if (candidate.manifest === 'missing' || candidate.generationReceipt === 'missing') {
    return { allow: false, refusal: 'latch_active_unbound_candidate' };
  }
  const manifest = candidate.manifest;
  const receipt = candidate.generationReceipt;
  if (manifest.sourceGenerationId !== receipt.generationId) {
    return { allow: false, refusal: 'latch_active_unbound_candidate' };
  }

  const latch = latchState.latch;
  // Evidence-hash denylist: the exact revoked tree is refused whichever record
  // claims otherwise — manifest digest AND observed bytes are both checked.
  if (
    manifest.credentialTreeDigest === latch.latchedCredentialTreeDigest ||
    candidate.observedTreeDigest === latch.latchedCredentialTreeDigest
  ) {
    return { allow: false, refusal: 'latch_active_matches_latched_digest' };
  }
  if (candidate.observedTreeDigest === null || candidate.observedTreeDigest !== manifest.credentialTreeDigest) {
    return { allow: false, refusal: 'latch_active_digest_mismatch' };
  }

  if (latch.latchedGenerationId !== null && receipt.generationId === latch.latchedGenerationId) {
    return { allow: false, refusal: 'latch_active_candidate_not_newer' };
  }
  const receiptCreatedMs = Date.parse(receipt.createdAt);
  const latchedMs = Date.parse(latch.latchedAt);
  if (!Number.isFinite(receiptCreatedMs) || !Number.isFinite(latchedMs) || receiptCreatedMs <= latchedMs) {
    return { allow: false, refusal: 'latch_active_candidate_not_newer' };
  }

  return { allow: true, basis: 'candidate_bound_newer_generation' };
}

export type ActiveTreeObservation =
  | { status: 'digest'; digest: string }
  | { status: 'missing' }
  | { status: 'unreadable' };

export type ConnectActivationEvidence =
  | { status: 'recorded_v2'; receipt: AuthGenerationReceiptV2 }
  | { status: 'legacy_v1' }
  | { status: 'unavailable' };

export type ConnectActivationDecision =
  | {
      allow: true;
      basis:
        | 'no_latch_recorded'
        | 'owner_released'
        | 'bound_superseding_generation'
        | 'superseding_generation_rotated';
    }
  | {
      allow: false;
      refusal:
        | 'latch_state_corrupt'
        | 'active_tree_unreadable'
        | 'revoked_material_present'
        | 'supersession_required'
        | 'superseded_generation_unbound';
    };

/**
 * The connect-boundary decision. While a latch is ACTIVE nothing activates:
 * the presence of a receipted newer tree is necessary but NOT sufficient — the
 * `generation_superseded` transition must have committed (never authorize by
 * timestamp alone). After supersession, activation requires a readable
 * non-revoked tree and a V2 receipt for exactly the superseding generation;
 * the tree digest may rotate past the receipt (credentials are rewritten on
 * every session) but the latched revoked digest is refused forever.
 */
export function decideConnectActivation(
  latchState: LatchJournalState,
  activeTree: ActiveTreeObservation,
  evidence: ConnectActivationEvidence,
): ConnectActivationDecision {
  if (latchState.status === 'corrupt') return { allow: false, refusal: 'latch_state_corrupt' };
  if (latchState.status === 'missing') return { allow: true, basis: 'no_latch_recorded' };
  if (latchState.status === 'released') return { allow: true, basis: 'owner_released' };
  if (latchState.status === 'active') {
    if (activeTree.status === 'unreadable') return { allow: false, refusal: 'active_tree_unreadable' };
    if (
      activeTree.status === 'digest' &&
      activeTree.digest === latchState.latch.latchedCredentialTreeDigest
    ) {
      return { allow: false, refusal: 'revoked_material_present' };
    }
    return { allow: false, refusal: 'supersession_required' };
  }
  // superseded
  if (activeTree.status === 'unreadable') return { allow: false, refusal: 'active_tree_unreadable' };
  if (activeTree.status === 'missing') return { allow: false, refusal: 'superseded_generation_unbound' };
  if (activeTree.digest === latchState.latch.latchedCredentialTreeDigest) {
    return { allow: false, refusal: 'revoked_material_present' };
  }
  if (evidence.status !== 'recorded_v2') return { allow: false, refusal: 'superseded_generation_unbound' };
  if (evidence.receipt.generationId !== latchState.supersededByGenerationId) {
    return { allow: false, refusal: 'superseded_generation_unbound' };
  }
  if (evidence.receipt.credentialTreeDigest === activeTree.digest) {
    return { allow: true, basis: 'bound_superseding_generation' };
  }
  // The session layer rewrites credentials on every connection, so the byte
  // digest drifts from the pairing-time receipt immediately after first use.
  // The binding that endures is the generation id; the refusal that endures
  // is the latched revoked digest above.
  return { allow: true, basis: 'superseding_generation_rotated' };
}
