/**
 * D4 — capability-obligation store (capability-obligation replay).
 *
 * Persistence for the append-only capability-debt lifecycle (migration 58).
 * The creation-side API follows the `*WithinCallerTransaction` convention
 * (turn-recovery-store.ts precedent): methods here NEVER open a transaction —
 * the caller owns it. The one production caller of the decision API is
 * `DurabilityEngine.finalizeTurnTerminal`'s C3 `BEGIN IMMEDIATE` body, so the
 * terminal record, the typed audit decision, and (only for the conclusive
 * eligible case) the unique obligation row commit or roll back together. An
 * audit/store failure aborts all three (D4): the runtime must not deliver a
 * refusal whose terminal/debt decision failed to commit.
 *
 * Exactly-once local creation is layered: the terminal CAS + read-only
 * duplicate-winner branch prevent re-entry, and the obligation table's UNIQUE
 * (source_inbound_seq, source_message_id, contract_version, required_capability)
 * is defense in depth. This is exactly-once obligation CREATION, not
 * exactly-once provider execution (D7 owns execution semantics).
 */
import { canonicalDependencyVersions } from './capability-attestation.ts';
import type { Database } from './database.ts';
import { withTransaction } from './db-tx.ts';

/** D7 bounded retry: total claim attempts before an obligation exhausts. */
export const CAPABILITY_OBLIGATION_MAX_ATTEMPTS = 5;

export const CAPABILITY_OBLIGATION_EVENT_ACTIONS = [
  'obligation.create',
  'obligation.not_created',
  'obligation.claim',
  'obligation.requeue',
  'obligation.dispatch',
  'obligation.settle',
  'obligation.block',
  'obligation.cancel',
  'obligation.re_arm',
  'obligation.migrate',
  'approval.record',
  'attestation.record',
] as const;

export type CapabilityObligationEventAction = (typeof CAPABILITY_OBLIGATION_EVENT_ACTIONS)[number];

export interface CapabilityObligationEventParams {
  action: CapabilityObligationEventAction;
  actorType: 'runtime' | 'supervisor' | 'operator';
  actorId?: string | null;
  reasonCode?: string | null;
  /** Privacy-safe correlation hash (e.g. the D1 input digest) — never content. */
  sourceHash?: string | null;
  claimEpoch?: number | null;
  /** Redacted-safe structured detail; serialized as canonical JSON. */
  detail?: Record<string, unknown> | null;
}

export interface OperatorAdjudicationParams {
  /** `cancel` retires; `requeue` re-arms a blocked obligation to the claim pool. */
  action: 'cancel' | 'requeue';
  /** Precondition: the obligation must currently be in this state, else refused. */
  expectedState?: string;
  reasonCode: string;
  /** Operator identity / run id, recorded as the audit actor. */
  actorId: string;
  /** Recorded in the audit detail; re-running once the target is reached is a no-op. */
  idempotencyKey?: string;
  /** Preview only: run every check but never mutate (CLI `--dry-run`). */
  dryRun?: boolean;
}

export interface OperatorAdjudicationResult {
  /** The write actually happened (false for dry-run, no-op, or refusal). */
  applied: boolean;
  /** A non-dry-run WOULD mutate (all checks pass and not already in target). */
  wouldApply: boolean;
  currentState: string | null;
  /** The obligation is already in the requested target state (idempotent no-op). */
  alreadyInTarget: boolean;
  refusedReason: 'not_found' | 'precondition_mismatch' | 'illegal_from_state' | null;
}

export interface OperatorObligationView {
  obligation: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  receipts: Array<Record<string, unknown>>;
}

export interface CapabilityObligationRetainedMedia {
  path: string;
  sha256: string;
  bytes: number;
  policyVersion: string;
}

export interface CapabilityObligationInsertParams {
  sourceInboundSeq: number;
  sourceMessageId: string;
  conversationKey: string;
  deliveryJid: string;
  senderJid: string;
  senderName: string | null;
  isGroup: boolean;
  groupName: string | null;
  scope: 'per_chat';
  originRecoveryJobId: number | null;
  replayText: string;
  contentTypeHint: string | null;
  contractVersion: string;
  requiredCapability: string;
  /** Canonical (sorted-key) JSON string — ambiguous JSON equality is forbidden. */
  capabilityParams: string;
  /** D1 input digest (64 hex) — the obligation's evaluation identity. */
  inputDigest: string;
  /**
   * D6 execution-source digest (64 hex): media sha256, or sha256 of the
   * canonical source token. Receipts must DERIVE and reproduce this from the
   * resolver's structured evidence.
   */
  sourceDigest: string;
  /**
   * The canonical execution-source STRING the replayed agent must pass to
   * execute_capability (its sha256 equals sourceDigest). Exactly one of
   * {sourceToken, retainedMedia}: the URL / command remainder for token
   * obligations; null for media obligations (retainedMedia is the source).
   */
  sourceToken: string | null;
  retainedMedia: CapabilityObligationRetainedMedia | null;
  creationReason: string;
}

/**
 * The C3-joined decision: a typed audit event ALWAYS, plus the obligation row
 * ONLY for the conclusive eligible case (candidate:491 — uncertain/mutable
 * evidence creates no dispatchable row).
 */
export interface CapabilityDecisionParams {
  auditEvent: CapabilityObligationEventParams;
  obligation?: CapabilityObligationInsertParams;
}

export interface CapabilityDecisionOutcome {
  eventId: number;
  obligationId: number | null;
}

/** Shallow shape validation, called from normalizeFinalizeTurnTerminalParams. */
export function validateCapabilityDecisionParams(decision: CapabilityDecisionParams): void {
  const { auditEvent, obligation } = decision;
  if (!CAPABILITY_OBLIGATION_EVENT_ACTIONS.includes(auditEvent.action)) {
    throw new Error('Capability decision has an unknown audit action');
  }
  if (auditEvent.action !== 'obligation.create' && auditEvent.action !== 'obligation.not_created') {
    throw new Error('Capability decision audit action must be create or not_created');
  }
  if ((auditEvent.action === 'obligation.create') !== (obligation !== undefined)) {
    throw new Error('Capability decision obligation payload must accompany exactly the create action');
  }
  if (obligation !== undefined) {
    if (obligation.replayText.length === 0) {
      throw new Error('Capability obligation requires non-empty replay text');
    }
    if (!Number.isSafeInteger(obligation.sourceInboundSeq) || obligation.sourceInboundSeq <= 0) {
      throw new Error('Capability obligation requires a journaled source inbound sequence');
    }
    if (obligation.isGroup && obligation.groupName === null) {
      throw new Error('Capability obligation for a group requires a group name');
    }
    if (!/^[0-9a-f]{64}$/.test(obligation.inputDigest)) {
      throw new Error('Capability obligation requires a 64-hex input digest');
    }
    if (!/^[0-9a-f]{64}$/.test(obligation.sourceDigest)) {
      throw new Error('Capability obligation requires a 64-hex source digest');
    }
    if (obligation.retainedMedia !== null && obligation.sourceDigest !== obligation.retainedMedia.sha256) {
      throw new Error('Capability obligation source digest must equal the retained media digest');
    }
    // Exactly one execution source. The media digest can diverge from its
    // separately-staged sha (checked above); the token digest is DERIVED from
    // the token in one expression at creation, so only the structural
    // exactly-one invariant is enforced here (the DB CHECK is defense in depth).
    if (obligation.retainedMedia !== null && obligation.sourceToken !== null) {
      throw new Error('Capability obligation must not carry both retained media and a source token');
    }
    if (obligation.retainedMedia === null && obligation.sourceToken === null) {
      throw new Error('Capability obligation without media requires a source token');
    }
    try {
      JSON.parse(obligation.capabilityParams);
    } catch {
      throw new Error('Capability obligation params must be canonical JSON');
    }
  }
}

export class CapabilityObligationStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  private assertInCallerTransaction(method: string): void {
    if (!this.db.raw.isTransaction) {
      throw new Error(`CapabilityObligationStore.${method} requires the caller-owned transaction`);
    }
  }

  appendEventWithinCallerTransaction(
    event: CapabilityObligationEventParams,
    obligationId: number | null,
  ): number {
    this.assertInCallerTransaction('appendEventWithinCallerTransaction');
    const result = this.db.raw
      .prepare(
        `INSERT INTO capability_obligation_events
           (obligation_id, action, actor_type, actor_id, reason_code, source_hash, claim_epoch, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        obligationId,
        event.action,
        event.actorType,
        event.actorId ?? null,
        event.reasonCode ?? null,
        event.sourceHash ?? null,
        event.claimEpoch ?? null,
        event.detail == null ? null : JSON.stringify(event.detail),
      );
    return Number(result.lastInsertRowid);
  }

  insertWithinCallerTransaction(
    params: CapabilityObligationInsertParams,
    creationEvidenceEventId: number,
  ): number {
    this.assertInCallerTransaction('insertWithinCallerTransaction');
    const initialState = params.isGroup ? 'waiting_approval' : 'waiting_capability';
    const result = this.db.raw
      .prepare(
        `INSERT INTO capability_obligations (
           source_inbound_seq, source_message_id, conversation_key, delivery_jid,
           sender_jid, sender_name, is_group, group_name, scope,
           origin_recovery_job_id, replay_text, content_type_hint,
           contract_version, required_capability, capability_params, input_digest,
           source_digest, source_token, creation_evidence_event_id,
           retained_media_path, media_sha256, media_bytes, retention_policy_version,
           state, creation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.sourceInboundSeq,
        params.sourceMessageId,
        params.conversationKey,
        params.deliveryJid,
        params.senderJid,
        params.senderName,
        params.isGroup ? 1 : 0,
        params.groupName,
        params.scope,
        params.originRecoveryJobId,
        params.replayText,
        params.contentTypeHint,
        params.contractVersion,
        params.requiredCapability,
        params.capabilityParams,
        params.inputDigest,
        params.sourceDigest,
        params.sourceToken,
        creationEvidenceEventId,
        params.retainedMedia?.path ?? null,
        params.retainedMedia?.sha256 ?? null,
        params.retainedMedia?.bytes ?? null,
        params.retainedMedia?.policyVersion ?? null,
        initialState,
        params.creationReason,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Apply the C3-joined decision: audit event first (its id becomes the
   * obligation's typed-signal evidence reference), then — for the conclusive
   * eligible case only — the unique obligation row.
   */
  applyDecisionWithinCallerTransaction(decision: CapabilityDecisionParams): CapabilityDecisionOutcome {
    this.assertInCallerTransaction('applyDecisionWithinCallerTransaction');
    validateCapabilityDecisionParams(decision);
    if (decision.obligation !== undefined) {
      // Ambiguity-safe dedup (§3.1): a recovery replay of the same source
      // re-derives the same decision; the existing row wins and the replay is
      // recorded as a suppressed duplicate instead of aborting finalization.
      const existing = this.db.raw
        .prepare(
          `SELECT id FROM capability_obligations
           WHERE source_inbound_seq = ? AND source_message_id = ?
             AND contract_version = ? AND required_capability = ?`,
        )
        .get(
          decision.obligation.sourceInboundSeq,
          decision.obligation.sourceMessageId,
          decision.obligation.contractVersion,
          decision.obligation.requiredCapability,
        ) as { id: number } | undefined;
      if (existing !== undefined) {
        const eventId = this.appendEventWithinCallerTransaction(
          {
            ...decision.auditEvent,
            reasonCode: 'duplicate_suppressed',
            detail: { existingObligationId: existing.id },
          },
          existing.id,
        );
        return { eventId, obligationId: existing.id };
      }
    }
    const eventId = this.appendEventWithinCallerTransaction(decision.auditEvent, null);
    if (decision.obligation === undefined) {
      return { eventId, obligationId: null };
    }
    const obligationId = this.insertWithinCallerTransaction(decision.obligation, eventId);
    return { eventId, obligationId };
  }

  // ── D7 single-flight claim/lease/fence machinery ──────────────────────────
  // Autocommit CAS statements mirroring the turn-recovery-store idiom: the
  // database transition IS the admission gate; readiness signals only wake the
  // scanner. Every terminal write is fenced by (claim_token, claim_epoch).

  listDueObligations(
    limit: number,
    opts: { mediaMaxAgeSeconds?: number } = {},
  ): CapabilityObligationDueRow[] {
    // A-08: media claimability is bounded — `mediaExpired` is computed in SQL
    // so the horizon comparison shares the database's own clock.
    const rows = this.db.raw
      .prepare(
        `SELECT id, source_inbound_seq, source_message_id, conversation_key, delivery_jid,
                sender_jid, sender_name, is_group, group_name, replay_text, content_type_hint,
                contract_version, required_capability, capability_params, input_digest,
                source_digest, source_token, retained_media_path, media_sha256, media_bytes, attempt_count,
                (retained_media_path IS NOT NULL AND ? IS NOT NULL
                  AND datetime(created_at, '+' || CAST(? AS INTEGER) || ' seconds') <= datetime('now')
                ) AS media_expired
         FROM capability_obligations
         WHERE state = 'waiting_capability'
           AND attempt_count < ${CAPABILITY_OBLIGATION_MAX_ATTEMPTS}
           AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(
        opts.mediaMaxAgeSeconds ?? null,
        opts.mediaMaxAgeSeconds ?? null,
        limit,
      ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      sourceInboundSeq: r.source_inbound_seq as number,
      sourceMessageId: r.source_message_id as string,
      conversationKey: r.conversation_key as string,
      deliveryJid: r.delivery_jid as string,
      senderJid: r.sender_jid as string,
      senderName: (r.sender_name as string | null) ?? null,
      isGroup: (r.is_group as number) === 1,
      groupName: (r.group_name as string | null) ?? null,
      replayText: r.replay_text as string,
      contentTypeHint: (r.content_type_hint as string | null) ?? null,
      contractVersion: r.contract_version as string,
      requiredCapability: r.required_capability as string,
      capabilityParams: r.capability_params as string,
      inputDigest: r.input_digest as string,
      sourceDigest: r.source_digest as string,
      sourceToken: (r.source_token as string | null) ?? null,
      retainedMediaPath: (r.retained_media_path as string | null) ?? null,
      mediaSha256: (r.media_sha256 as string | null) ?? null,
      mediaBytes: (r.media_bytes as number | null) ?? null,
      attemptCount: r.attempt_count as number,
      mediaExpired: (r.media_expired as number) === 1,
    }));
  }

  /**
   * Targeted drain (post-merge audit F2): the due row for ONE named obligation,
   * or a typed not-due classification derived from the same eligibility
   * predicate `listDueObligations` scans with. The drain-now path uses this so
   * a named obligation is never starved by the global oldest-first cap, and so
   * its reported outcome is derived from the row's actual state — never from
   * "a tick ran".
   */
  dueObligationById(
    id: number,
    opts: { mediaMaxAgeSeconds?: number } = {},
  ):
    | { due: CapabilityObligationDueRow }
    | { due: null; state: string | null; notDueReason: 'not_found' | 'not_waiting' | 'attempts_exhausted' | 'backoff_pending' } {
    const row = this.db.raw
      .prepare(
        `SELECT id, source_inbound_seq, source_message_id, conversation_key, delivery_jid,
                sender_jid, sender_name, is_group, group_name, replay_text, content_type_hint,
                contract_version, required_capability, capability_params, input_digest,
                source_digest, source_token, retained_media_path, media_sha256, media_bytes, attempt_count,
                state,
                (attempt_count >= ${CAPABILITY_OBLIGATION_MAX_ATTEMPTS}) AS attempts_exhausted,
                (next_attempt_at IS NOT NULL AND datetime(next_attempt_at) > datetime('now')) AS backoff_pending,
                (retained_media_path IS NOT NULL AND ? IS NOT NULL
                  AND datetime(created_at, '+' || CAST(? AS INTEGER) || ' seconds') <= datetime('now')
                ) AS media_expired
         FROM capability_obligations
         WHERE id = ?`,
      )
      .get(opts.mediaMaxAgeSeconds ?? null, opts.mediaMaxAgeSeconds ?? null, id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return { due: null, state: null, notDueReason: 'not_found' };
    const state = row.state as string;
    if (state !== 'waiting_capability') return { due: null, state, notDueReason: 'not_waiting' };
    if ((row.attempts_exhausted as number) === 1) return { due: null, state, notDueReason: 'attempts_exhausted' };
    if ((row.backoff_pending as number) === 1) return { due: null, state, notDueReason: 'backoff_pending' };
    return {
      due: {
        id: row.id as number,
        sourceInboundSeq: row.source_inbound_seq as number,
        sourceMessageId: row.source_message_id as string,
        conversationKey: row.conversation_key as string,
        deliveryJid: row.delivery_jid as string,
        senderJid: row.sender_jid as string,
        senderName: (row.sender_name as string | null) ?? null,
        isGroup: (row.is_group as number) === 1,
        groupName: (row.group_name as string | null) ?? null,
        replayText: row.replay_text as string,
        contentTypeHint: (row.content_type_hint as string | null) ?? null,
        contractVersion: row.contract_version as string,
        requiredCapability: row.required_capability as string,
        capabilityParams: row.capability_params as string,
        inputDigest: row.input_digest as string,
        sourceDigest: row.source_digest as string,
        sourceToken: (row.source_token as string | null) ?? null,
        retainedMediaPath: (row.retained_media_path as string | null) ?? null,
        mediaSha256: (row.media_sha256 as string | null) ?? null,
        mediaBytes: (row.media_bytes as number | null) ?? null,
        attemptCount: row.attempt_count as number,
        mediaExpired: (row.media_expired as number) === 1,
      },
    };
  }

  /**
   * Retained paths that must NOT be garbage-collected: media of live
   * (non-terminal) obligations still inside the retention horizon (A-08).
   */
  listRetainedMediaReferences(opts: { mediaMaxAgeSeconds: number }): Set<string> {
    const rows = this.db.raw
      .prepare(
        `SELECT retained_media_path FROM capability_obligations
         WHERE retained_media_path IS NOT NULL
           AND state IN ('waiting_capability', 'waiting_approval', 'claimed', 'blocked_media', 'blocked_ambiguous')
           AND datetime(created_at, '+' || CAST(? AS INTEGER) || ' seconds') > datetime('now')`,
      )
      .all(opts.mediaMaxAgeSeconds) as Array<{ retained_media_path: string }>;
    return new Set(rows.map((r) => r.retained_media_path));
  }

  /**
   * Drain-now PRE-CHECK (round-22, gap-doc remaining item 2): does ANY live
   * attestation (canary pass, unrevoked, unexpired) exist that could plausibly
   * admit this obligation? Mirrors `findAdmissibleAttestation`'s 16-field
   * conjunction EXACTLY, minus ONLY `provider_id`/`harness_type` — the two
   * fields that are unknowable until the session actually spawns (same `IS`
   * semantics for the nullable skill_version/resolver_digest, same canonical
   * dependency-versions serialization). Used to refuse ACTIVATING a session
   * that would necessarily park — including the resolver-drift case, where a
   * stale attestation bound to an OLD composite must NOT count as a candidate
   * (r22 AE1-review Medium). Heuristic pre-activation gate only: the claim's
   * exact-binding admission (r15 F4) remains the authoritative gate; this can
   * only refuse earlier, never admit more.
   */
  hasAttestationCandidateIgnoringProvider(params: {
    obligationId: number;
    hostId: string;
    runtimeUser: string;
    releaseSha: string;
    schemaVersion: number;
    skillName: string;
    skillVersion: string | null;
    skillDigest: string;
    resolverDigest: string | null;
    dependencyVersions: Record<string, string>;
    probeVersion: string;
    canaryId: string;
    mediaRoot: string;
  }): boolean {
    const row = this.db.raw
      .prepare(
        `SELECT 1 AS ok FROM capability_attestations att
         JOIN capability_obligations o ON o.id = ?
         WHERE att.host_id = ? AND att.runtime_user = ? AND att.release_sha = ?
           AND att.schema_version = ?
           AND att.contract_version = o.contract_version
           AND att.capability = o.required_capability
           AND att.skill_name = ? AND att.skill_version IS ? AND att.skill_digest = ?
           AND att.resolver_digest IS ? AND att.dependency_versions = ?
           AND att.probe_version = ? AND att.canary_id = ? AND att.media_root = ?
           AND att.canary_result = 'pass' AND att.revoked_at IS NULL
           AND datetime(att.expires_at) > datetime('now')
         LIMIT 1`,
      )
      .get(
        params.obligationId,
        params.hostId,
        params.runtimeUser,
        params.releaseSha,
        params.schemaVersion,
        params.skillName,
        params.skillVersion,
        params.skillDigest,
        params.resolverDigest,
        canonicalDependencyVersions(params.dependencyVersions),
        params.probeVersion,
        params.canaryId,
        params.mediaRoot,
      ) as { ok: number } | undefined;
    return row !== undefined;
  }

  claimObligation(
    id: number,
    params: {
      claimToken: string;
      leaseSeconds: number;
      admissionAttestationId?: number;
      admissionAttestationDigest?: string;
    },
  ): { applied: true; claimEpoch: number; attemptCount: number } | { applied: false } {
    // r15 F4 — ATOMIC attestation-bound claim. Admission (findAdmissibleAttestation)
    // runs BEFORE media verification, whose await is a window in which the admitted
    // attestation can be revoked or expire. The claim must therefore re-check, in
    // the SAME transaction that flips the state, that the exact admitted attestation
    // row is STILL admissible (canary pass, unrevoked, unexpired). This applies to
    // EVERY obligation (group and non-group) — non-group ones have no approval, so
    // without this nothing re-validates the attestation at claim. Fail-closed: a
    // missing admission id (NULL) matches no row, so the claim is refused.
    // r13 F3 — group obligations RE-VALIDATE the consumed drain approval at CLAIM
    // time, not only at the waiting_approval → waiting_capability transition (the
    // group_approval_gate trigger fires only there). Without this, an approval
    // revoked or expired AFTER consumption — or that drifted from the facts stored
    // on the obligation — could still be claimed and dispatched. Fail-closed: the
    // EXISTS must still hold (unrevoked, unexpired, facts match) or the claim is
    // refused and the group obligation dispatches nothing.
    //
    // r14 F1 — the approval must bind to the attestation ACTUALLY admitting THIS
    // claim, not merely to the drain facts cached on the obligation. The caller
    // (supervisor) supplies `admissionAttestationDigest` = the binding-identity
    // digest of whatever `findAdmissibleAttestation` admitted; the claim requires
    // it to equal `drain_attestation_digest` (which the EXISTS already ties to the
    // approval). Without this a drain approved under one release/attestation could
    // be executed under a DIFFERENT release-new attestation that admits at claim
    // time. Fail-closed: a group claim with no admission digest (NULL) can never
    // satisfy `drain_attestation_digest = NULL`, so it is refused.
    const row = this.db.raw
      .prepare(
        `UPDATE capability_obligations
         SET state = 'claimed',
             attempt_count = attempt_count + 1,
             claim_epoch = claim_epoch + 1,
             claim_token = ?,
             claim_expires_at = datetime('now', '+' || ? || ' seconds'),
             next_attempt_at = NULL,
             updated_at = datetime('now')
         WHERE id = ?
           AND state = 'waiting_capability'
           AND attempt_count < ${CAPABILITY_OBLIGATION_MAX_ATTEMPTS}
           AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
           AND EXISTS (
             SELECT 1 FROM capability_attestations att
             WHERE att.id = ?
               AND att.canary_result = 'pass'
               AND att.revoked_at IS NULL
               AND datetime(att.expires_at) > datetime('now')
           )
           AND (
             capability_obligations.is_group = 0
             OR (
               capability_obligations.drain_attestation_digest = ?
               AND EXISTS (
                 SELECT 1 FROM capability_drain_approvals a
                 WHERE a.id = capability_obligations.drain_approval_id
                   AND a.obligation_id = capability_obligations.id
                   AND a.scope = 'group'
                   AND a.destination_jid = capability_obligations.delivery_jid
                   AND a.release_sha = capability_obligations.drain_release_sha
                   AND a.manifest_digest = capability_obligations.drain_manifest_digest
                   AND a.drain_run_id = capability_obligations.drain_run_id
                   AND a.attestation_digest = capability_obligations.drain_attestation_digest
                   AND a.revoked_at IS NULL
                   AND datetime(a.expires_at) > datetime('now')
               )
             )
           )
         RETURNING claim_epoch, attempt_count`,
      )
      .get(
        params.claimToken,
        params.leaseSeconds,
        id,
        params.admissionAttestationId ?? null,
        params.admissionAttestationDigest ?? null,
      ) as
      | { claim_epoch: number; attempt_count: number }
      | undefined;
    if (row === undefined) return { applied: false };
    return { applied: true, claimEpoch: row.claim_epoch, attemptCount: row.attempt_count };
  }

  requeueObligation(
    id: number,
    fence: CapabilityObligationClaimFence,
    params: { backoffSeconds: number },
  ): { applied: boolean; exhausted: boolean } {
    const row = this.db.raw
      .prepare(
        `UPDATE capability_obligations
         SET state = CASE
               WHEN attempt_count >= ${CAPABILITY_OBLIGATION_MAX_ATTEMPTS} THEN 'exhausted'
               ELSE 'waiting_capability'
             END,
             claim_token = NULL,
             claim_expires_at = NULL,
             next_attempt_at = datetime('now', '+' || ? || ' seconds'),
             updated_at = datetime('now')
         WHERE id = ?
           AND state = 'claimed'
           AND claim_token = ?
           AND claim_epoch = ?
         RETURNING state`,
      )
      .get(params.backoffSeconds, id, fence.claimToken, fence.claimEpoch) as
      | { state: string }
      | undefined;
    if (row === undefined) return { applied: false, exhausted: false };
    return { applied: true, exhausted: row.state === 'exhausted' };
  }

  blockObligation(
    id: number,
    fence: CapabilityObligationClaimFence,
    state: 'blocked_media' | 'blocked_ambiguous',
    reasonCode: string,
  ): { applied: boolean } {
    return withTransaction(this.db, () => {
      const row = this.db.raw
        .prepare(
          `UPDATE capability_obligations
           SET state = ?, claim_token = NULL, claim_expires_at = NULL,
               updated_at = datetime('now')
           WHERE id = ? AND state = 'claimed' AND claim_token = ? AND claim_epoch = ?
           RETURNING id`,
        )
        .get(state, id, fence.claimToken, fence.claimEpoch);
      if (row === undefined) return { applied: false };
      this.appendEventWithinCallerTransaction(
        { action: 'obligation.block', actorType: 'supervisor', reasonCode, claimEpoch: fence.claimEpoch },
        id,
      );
      return { applied: true };
    });
  }

  /**
   * Operator adjudication of a NON-claimed obligation (inspect/cancel/adjudicate
   * CLI). `cancel` retires a waiting/blocked obligation; `requeue` re-arms a
   * blocked (`blocked_ambiguous`/`blocked_media`) obligation to the claimable
   * pool. Both go through the SAME guarded state machine as the runtime — never
   * raw SQL that dodges the transition whitelist — and append an `operator`
   * audit event. Idempotent: already-in-target is a no-op success. A claimed
   * (in-flight) obligation is never operator-mutated; wait for it to block.
   */
  operatorAdjudicateObligation(
    id: number,
    params: OperatorAdjudicationParams,
  ): OperatorAdjudicationResult {
    const target = params.action === 'cancel' ? 'cancelled' : 'waiting_capability';
    const legalFrom =
      params.action === 'cancel'
        ? ['waiting_approval', 'waiting_capability', 'blocked_media', 'blocked_ambiguous']
        : ['blocked_ambiguous', 'blocked_media'];
    return withTransaction(this.db, () => {
      const row = this.db.raw
        .prepare('SELECT state FROM capability_obligations WHERE id = ?')
        .get(id) as { state: string } | undefined;
      if (row === undefined) {
        return { applied: false, wouldApply: false, currentState: null, alreadyInTarget: false, refusedReason: 'not_found' };
      }
      if (row.state === target) {
        return { applied: false, wouldApply: false, currentState: row.state, alreadyInTarget: true, refusedReason: null };
      }
      if (params.expectedState !== undefined && row.state !== params.expectedState) {
        return { applied: false, wouldApply: false, currentState: row.state, alreadyInTarget: false, refusedReason: 'precondition_mismatch' };
      }
      if (!legalFrom.includes(row.state)) {
        return { applied: false, wouldApply: false, currentState: row.state, alreadyInTarget: false, refusedReason: 'illegal_from_state' };
      }
      // All checks pass — a real run would mutate. Dry-run stops here.
      if (params.dryRun === true) {
        return { applied: false, wouldApply: true, currentState: row.state, alreadyInTarget: false, refusedReason: null };
      }
      // The state-transition trigger is the ultimate authority; the WHERE state
      // guard makes the write optimistic-concurrency safe.
      const upd =
        params.action === 'cancel'
          ? this.db.raw
              .prepare(
                `UPDATE capability_obligations
                 SET state = 'cancelled', claim_token = NULL, claim_expires_at = NULL,
                     updated_at = datetime('now')
                 WHERE id = ? AND state = ? RETURNING id`,
              )
              .get(id, row.state)
          : this.db.raw
              .prepare(
                `UPDATE capability_obligations
                 SET state = 'waiting_capability', claim_token = NULL, claim_expires_at = NULL,
                     next_attempt_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ? AND state = ? RETURNING id`,
              )
              .get(id, row.state);
      if (upd === undefined) {
        return { applied: false, wouldApply: false, currentState: row.state, alreadyInTarget: false, refusedReason: 'illegal_from_state' };
      }
      this.appendEventWithinCallerTransaction(
        {
          action: params.action === 'cancel' ? 'obligation.cancel' : 'obligation.re_arm',
          actorType: 'operator',
          actorId: params.actorId,
          reasonCode: params.reasonCode,
          detail: { idempotencyKey: params.idempotencyKey ?? null, expectedState: params.expectedState ?? null },
        },
        id,
      );
      return { applied: true, wouldApply: true, currentState: target, alreadyInTarget: false, refusedReason: null };
    });
  }

  /** Operator read: one obligation's summary + its audit events + receipts. */
  operatorInspectObligation(id: number): OperatorObligationView | null {
    const obligation = this.db.raw
      .prepare(
        `SELECT id, state, is_group, delivery_jid, conversation_key, required_capability,
                contract_version, source_digest, source_token, retained_media_path,
                attempt_count, claim_epoch, next_attempt_at, completion_proof_id,
                creation_reason, created_at, updated_at
         FROM capability_obligations WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (obligation === undefined) return null;
    // The creation event is appended BEFORE the obligation row exists (its id
    // becomes creation_evidence_event_id), so it carries obligation_id = NULL;
    // include it via that back-reference for a complete operator history.
    const events = this.db.raw
      .prepare(
        `SELECT action, actor_type, actor_id, reason_code, created_at
         FROM capability_obligation_events
         WHERE obligation_id = ?
            OR id = (SELECT creation_evidence_event_id FROM capability_obligations WHERE id = ?)
         ORDER BY id ASC`,
      )
      .all(id, id) as Array<Record<string, unknown>>;
    const receipts = this.db.raw
      .prepare(
        `SELECT id, result_status, claim_epoch, attempt_number, source_digest, created_at
         FROM capability_execution_receipts WHERE obligation_id = ? ORDER BY id ASC`,
      )
      .all(id) as Array<Record<string, unknown>>;
    return { obligation, events, receipts };
  }

  /** Operator read: obligations filtered by state (or all), most-recent first. */
  operatorListObligations(params: { state?: string; limit: number }): Array<Record<string, unknown>> {
    const base =
      `SELECT id, state, is_group, delivery_jid, required_capability, attempt_count,
              next_attempt_at, created_at, updated_at
       FROM capability_obligations`;
    if (params.state !== undefined) {
      return this.db.raw
        .prepare(`${base} WHERE state = ? ORDER BY id DESC LIMIT ?`)
        .all(params.state, params.limit) as Array<Record<string, unknown>>;
    }
    return this.db.raw
      .prepare(`${base} ORDER BY id DESC LIMIT ?`)
      .all(params.limit) as Array<Record<string, unknown>>;
  }

  settleCompleted(
    id: number,
    fence: CapabilityObligationClaimFence,
    proofs: { executionReceiptId: number; completionProofId: string },
  ): { applied: boolean; reason?: 'receipt_binding_mismatch' } {
    return withTransaction(this.db, () => {
      // D6: the receipt must prove THIS obligation's CURRENT claimed attempt —
      // same obligation, same claim epoch, same attempt number, non-error
      // result, same contract version and input digest, and the retained-media
      // digest where the obligation carries media. The schema trigger enforces
      // the same predicate against raw writes; checking here yields a typed
      // rejection instead of an abort.
      const bound = this.db.raw
        .prepare(
          `SELECT r.id FROM capability_execution_receipts r
           JOIN capability_obligations o ON o.id = r.obligation_id
           WHERE r.id = ? AND r.obligation_id = ?
             AND o.state = 'claimed' AND o.claim_token = ? AND o.claim_epoch = ?
             AND r.claim_epoch = o.claim_epoch
             AND r.attempt_number = o.attempt_count
             AND r.result_status = 'ok'
             AND r.contract_version = o.contract_version
             AND r.input_digest = o.input_digest
             AND r.source_digest = o.source_digest
             AND (o.media_sha256 IS NULL OR r.media_digest = o.media_sha256)
             AND EXISTS (
               SELECT 1 FROM turn_terminal_records t
               JOIN inbound_events ie ON ie.seq = t.inbound_seq
               WHERE ie.message_id = 'obl:' || o.id || ':' || o.attempt_count
                 AND t.logical_turn_id = r.logical_turn_id
                 AND t.delivery_kind = 'echoed'
                 AND t.delivery_op_id IS NOT NULL
                 AND ? = 'ttr:' || t.id
             )`,
        )
        .get(
          proofs.executionReceiptId,
          id,
          fence.claimToken,
          fence.claimEpoch,
          proofs.completionProofId,
        );
      if (bound === undefined) return { applied: false, reason: 'receipt_binding_mismatch' as const };
      const row = this.db.raw
        .prepare(
          `UPDATE capability_obligations
           SET state = 'completed',
               capability_execution_receipt_id = ?,
               completion_proof_id = ?,
               claim_token = NULL,
               claim_expires_at = NULL,
               updated_at = datetime('now')
           WHERE id = ? AND state = 'claimed' AND claim_token = ? AND claim_epoch = ?
           RETURNING id`,
        )
        .get(proofs.executionReceiptId, proofs.completionProofId, id, fence.claimToken, fence.claimEpoch);
      if (row === undefined) return { applied: false };
      this.appendEventWithinCallerTransaction(
        { action: 'obligation.settle', actorType: 'supervisor', reasonCode: 'completed', claimEpoch: fence.claimEpoch },
        id,
      );
      return { applied: true };
    });
  }

  /**
   * D3: a media-integrity failure discovered BEFORE claiming blocks the
   * obligation without consuming an execution attempt (attempts increment only
   * at claim). CAS on waiting_capability.
   */
  blockWaitingObligation(id: number, reasonCode: string): { applied: boolean } {
    return withTransaction(this.db, () => {
      const row = this.db.raw
        .prepare(
          `UPDATE capability_obligations
           SET state = 'blocked_media', updated_at = datetime('now')
           WHERE id = ? AND state = 'waiting_capability'
           RETURNING id`,
        )
        .get(id);
      if (row === undefined) return { applied: false };
      this.appendEventWithinCallerTransaction(
        { action: 'obligation.block', actorType: 'supervisor', reasonCode },
        id,
      );
      return { applied: true };
    });
  }

  /**
   * Create a group-drain approval (round-15 finding 3) — the operator side of the
   * AS-08 authorization that `consumeGroupDrainApproval` later spends. Refuses
   * unless the obligation is a GROUP still in `waiting_approval` whose delivery
   * JID matches the approved destination. `attestationDigest` MUST be the
   * binding-identity digest (`attestationBindingDigest`) of the attestation the
   * drain will run under — the approval CLI computes it — so the claim's r14-F1
   * check (`drain_attestation_digest == admitting digest`) can pass; a hand-typed
   * string would produce an unclaimable approval.
   */
  recordGroupDrainApproval(params: {
    obligationId: number;
    destinationJid: string;
    releaseSha: string;
    manifestDigest: string;
    drainRunId: string;
    attestationDigest: string;
    approver: string;
    validForSeconds: number;
  }): { recorded: boolean; approvalId?: number; reason?: 'not_a_waiting_group' | 'destination_mismatch' } {
    return withTransaction(this.db, () => {
      const o = this.db.raw
        .prepare('SELECT is_group AS isGroup, state, delivery_jid AS deliveryJid FROM capability_obligations WHERE id = ?')
        .get(params.obligationId) as { isGroup: number; state: string; deliveryJid: string } | undefined;
      if (o === undefined || o.isGroup !== 1 || o.state !== 'waiting_approval') {
        return { recorded: false as const, reason: 'not_a_waiting_group' as const };
      }
      if (o.deliveryJid !== params.destinationJid) {
        return { recorded: false as const, reason: 'destination_mismatch' as const };
      }
      const inserted = this.db.raw
        .prepare(
          `INSERT INTO capability_drain_approvals
             (obligation_id, destination_jid, scope, release_sha, attestation_digest,
              manifest_digest, drain_run_id, approver, approved_at, expires_at)
           VALUES (?, ?, 'group', ?, ?, ?, ?, ?, datetime('now'),
                   datetime('now', '+' || CAST(? AS INTEGER) || ' seconds'))`,
        )
        .run(
          params.obligationId,
          params.destinationJid,
          params.releaseSha,
          params.attestationDigest,
          params.manifestDigest,
          params.drainRunId,
          params.approver,
          params.validForSeconds,
        );
      const approvalId = Number(inserted.lastInsertRowid);
      this.appendEventWithinCallerTransaction(
        {
          action: 'approval.record',
          actorType: 'operator',
          actorId: params.approver,
          reasonCode: 'group_drain_approved',
          detail: { approvalId, drainRunId: params.drainRunId },
        },
        params.obligationId,
      );
      return { recorded: true as const, approvalId };
    });
  }

  /**
   * Round-17 finding 3: record the group-drain approval AND consume it (arm the
   * drain to `waiting_capability`) in ONE transaction. The round-16 operator CLI
   * did these as two separate `withTransaction` calls (`recordGroupDrainApproval`
   * then `consumeGroupDrainApproval`); a failure between them left an unused
   * approval row behind (an orphan authorization). Here the INSERT and the state
   * flip share a single `withTransaction`, so any failure rolls BOTH back — there
   * is no partial-approval window by construction. The separate methods remain for
   * the cold-drain path, which consumes at drain time, not approval time.
   */
  recordAndConsumeGroupDrainApproval(params: {
    obligationId: number;
    destinationJid: string;
    releaseSha: string;
    manifestDigest: string;
    drainRunId: string;
    attestationDigest: string;
    approver: string;
    validForSeconds: number;
  }): { ok: boolean; approvalId?: number; reason?: 'not_a_waiting_group' | 'destination_mismatch' | 'consume_failed' } {
    return withTransaction(this.db, () => {
      const o = this.db.raw
        .prepare('SELECT is_group AS isGroup, state, delivery_jid AS deliveryJid FROM capability_obligations WHERE id = ?')
        .get(params.obligationId) as { isGroup: number; state: string; deliveryJid: string } | undefined;
      if (o === undefined || o.isGroup !== 1 || o.state !== 'waiting_approval') {
        return { ok: false as const, reason: 'not_a_waiting_group' as const };
      }
      if (o.deliveryJid !== params.destinationJid) {
        return { ok: false as const, reason: 'destination_mismatch' as const };
      }
      const inserted = this.db.raw
        .prepare(
          `INSERT INTO capability_drain_approvals
             (obligation_id, destination_jid, scope, release_sha, attestation_digest,
              manifest_digest, drain_run_id, approver, approved_at, expires_at)
           VALUES (?, ?, 'group', ?, ?, ?, ?, ?, datetime('now'),
                   datetime('now', '+' || CAST(? AS INTEGER) || ' seconds'))`,
        )
        .run(
          params.obligationId,
          params.destinationJid,
          params.releaseSha,
          params.attestationDigest,
          params.manifestDigest,
          params.drainRunId,
          params.approver,
          params.validForSeconds,
        );
      const approvalId = Number(inserted.lastInsertRowid);
      this.appendEventWithinCallerTransaction(
        {
          action: 'approval.record',
          actorType: 'operator',
          actorId: params.approver,
          reasonCode: 'group_drain_approved',
          detail: { approvalId, drainRunId: params.drainRunId },
        },
        params.obligationId,
      );
      // Consume immediately with the SAME live facts the approval was cut for, within
      // this transaction. The schema trigger requires `drain_approval_id`; we already
      // hold the freshly-inserted id, so no re-SELECT is needed. If the flip does not
      // apply the whole transaction rolls back (throw) — no orphan approval.
      const flipped = this.db.raw
        .prepare(
          `UPDATE capability_obligations
           SET state = 'waiting_capability', drain_approval_id = ?,
               drain_release_sha = ?, drain_manifest_digest = ?,
               drain_run_id = ?, drain_attestation_digest = ?,
               updated_at = datetime('now')
           WHERE id = ? AND state = 'waiting_approval'
           RETURNING id`,
        )
        .get(
          approvalId,
          params.releaseSha,
          params.manifestDigest,
          params.drainRunId,
          params.attestationDigest,
          params.obligationId,
        );
      if (flipped === undefined) {
        // Cannot happen under the checks above, but fail CLOSED: rolling back the INSERT.
        throw new Error('recordAndConsumeGroupDrainApproval: consume did not apply within the atomic transaction');
      }
      this.appendEventWithinCallerTransaction(
        {
          action: 'obligation.re_arm',
          actorType: 'operator',
          reasonCode: 'group_drain_approved',
          detail: { approvalId, drainRunId: params.drainRunId },
        },
        params.obligationId,
      );
      return { ok: true as const, approvalId };
    });
  }

  listClaimedObligations(): Array<{
    id: number;
    claimToken: string;
    claimEpoch: number;
    attemptCount: number;
  }> {
    const rows = this.db.raw
      .prepare(
        `SELECT id, claim_token, claim_epoch, attempt_count FROM capability_obligations
         WHERE state = 'claimed' ORDER BY id ASC`,
      )
      .all() as Array<{ id: number; claim_token: string; claim_epoch: number; attempt_count: number }>;
    return rows.map((r) => ({
      id: r.id,
      claimToken: r.claim_token,
      claimEpoch: r.claim_epoch,
      attemptCount: r.attempt_count,
    }));
  }

  /**
   * D7: the sole sanctioned waiting_approval → waiting_capability path. The
   * caller supplies the LIVE drain facts (running release, approved manifest
   * digest, current drain-run ID, admissible attestation digest); consumption
   * succeeds only when an unrevoked, unexpired group approval for exactly this
   * obligation and destination matches every one of them. The consumed
   * approval's id is stored on the obligation (drain_approval_id), which the
   * schema trigger requires — raw state flips without it abort.
   */
  consumeGroupDrainApproval(
    id: number,
    live: {
      destinationJid: string;
      releaseSha: string;
      manifestDigest: string;
      drainRunId: string;
      attestationDigest: string;
    },
  ): { applied: boolean; approvalId?: number; reason?: 'no_matching_approval' } {
    return withTransaction(this.db, () => {
      const approval = this.db.raw
        .prepare(
          `SELECT a.id FROM capability_drain_approvals a
           JOIN capability_obligations o ON o.id = a.obligation_id
           WHERE a.obligation_id = ? AND o.state = 'waiting_approval' AND o.is_group = 1
             AND a.scope = 'group'
             AND a.destination_jid = o.delivery_jid
             AND a.destination_jid = ?
             AND a.release_sha = ?
             AND a.manifest_digest = ?
             AND a.drain_run_id = ?
             AND a.attestation_digest = ?
             AND a.revoked_at IS NULL
             AND datetime(a.expires_at) > datetime('now')
           ORDER BY a.id DESC LIMIT 1`,
        )
        .get(
          id,
          live.destinationJid,
          live.releaseSha,
          live.manifestDigest,
          live.drainRunId,
          live.attestationDigest,
        ) as { id: number } | undefined;
      if (approval === undefined) return { applied: false, reason: 'no_matching_approval' as const };
      const row = this.db.raw
        .prepare(
          `UPDATE capability_obligations
           SET state = 'waiting_capability', drain_approval_id = ?,
               drain_release_sha = ?, drain_manifest_digest = ?,
               drain_run_id = ?, drain_attestation_digest = ?,
               updated_at = datetime('now')
           WHERE id = ? AND state = 'waiting_approval'
           RETURNING id`,
        )
        .get(
          approval.id,
          live.releaseSha,
          live.manifestDigest,
          live.drainRunId,
          live.attestationDigest,
          id,
        );
      if (row === undefined) return { applied: false, reason: 'no_matching_approval' as const };
      this.appendEventWithinCallerTransaction(
        {
          action: 'obligation.re_arm',
          actorType: 'operator',
          reasonCode: 'group_drain_approved',
          detail: { approvalId: approval.id, drainRunId: live.drainRunId },
        },
        id,
      );
      return { applied: true, approvalId: approval.id };
    });
  }

  recordExecutionReceipt(params: {
    obligationId: number;
    logicalTurnId: string;
    toolUseId: string;
    skillName: string;
    contractVersion: string;
    inputDigest: string;
    mediaDigest: string | null;
    resultStatus: 'ok' | 'error';
    outputEvidence: Record<string, unknown> | null;
    /** D6: the receipt names the exact claim/attempt it proves. */
    claimEpoch: number;
    attemptNumber: number;
    /** D6: DERIVED from the resolver's structured evidence; null = underivable. */
    sourceDigest: string | null;
  }): number {
    const result = this.db.raw
      .prepare(
        `INSERT INTO capability_execution_receipts
           (obligation_id, logical_turn_id, tool_use_id, skill_name, contract_version,
            input_digest, media_digest, result_status, output_evidence,
            claim_epoch, attempt_number, source_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.obligationId,
        params.logicalTurnId,
        params.toolUseId,
        params.skillName,
        params.contractVersion,
        params.inputDigest,
        params.mediaDigest,
        params.resultStatus,
        params.outputEvidence == null ? null : JSON.stringify(params.outputEvidence),
        params.claimEpoch,
        params.attemptNumber,
        params.sourceDigest,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Restart/lease-expiry sweep (D7): an expired claim whose provider execution
   * provably NEVER began requeues under bounded policy; anything that may have
   * crossed the provider boundary quarantines as blocked_ambiguous and is never
   * auto-retried. The caller supplies durable acceptance evidence.
   */
  reclaimExpiredClaims(params: {
    providerAcceptedIds: ReadonlySet<number>;
  }): { requeued: number[]; quarantined: number[] } {
    return withTransaction(this.db, () => {
      const expired = this.db.raw
        .prepare(
          `SELECT id, claim_epoch FROM capability_obligations
           WHERE state = 'claimed' AND datetime(claim_expires_at) <= datetime('now')
           ORDER BY id ASC`,
        )
        .all() as Array<{ id: number; claim_epoch: number }>;
      const requeued: number[] = [];
      const quarantined: number[] = [];
      for (const row of expired) {
        if (params.providerAcceptedIds.has(row.id)) {
          this.db.raw
            .prepare(
              `UPDATE capability_obligations
               SET state = 'blocked_ambiguous', claim_token = NULL, claim_expires_at = NULL,
                   updated_at = datetime('now')
               WHERE id = ? AND state = 'claimed'`,
            )
            .run(row.id);
          this.appendEventWithinCallerTransaction(
            {
              action: 'obligation.block',
              actorType: 'supervisor',
              reasonCode: 'lease_expired_after_acceptance',
              claimEpoch: row.claim_epoch,
            },
            row.id,
          );
          quarantined.push(row.id);
        } else {
          this.db.raw
            .prepare(
              `UPDATE capability_obligations
               SET state = CASE
                     WHEN attempt_count >= ${CAPABILITY_OBLIGATION_MAX_ATTEMPTS} THEN 'exhausted'
                     ELSE 'waiting_capability'
                   END,
                   claim_token = NULL, claim_expires_at = NULL,
                   next_attempt_at = datetime('now'),
                   updated_at = datetime('now')
               WHERE id = ? AND state = 'claimed'`,
            )
            .run(row.id);
          this.appendEventWithinCallerTransaction(
            {
              action: 'obligation.requeue',
              actorType: 'supervisor',
              reasonCode: 'lease_expired_before_acceptance',
              claimEpoch: row.claim_epoch,
            },
            row.id,
          );
          requeued.push(row.id);
        }
      }
      return { requeued, quarantined };
    });
  }
}

export interface CapabilityObligationClaimFence {
  claimToken: string;
  claimEpoch: number;
}

export interface CapabilityObligationDueRow {
  id: number;
  sourceInboundSeq: number;
  sourceMessageId: string;
  conversationKey: string;
  deliveryJid: string;
  senderJid: string;
  senderName: string | null;
  isGroup: boolean;
  groupName: string | null;
  replayText: string;
  contentTypeHint: string | null;
  contractVersion: string;
  requiredCapability: string;
  capabilityParams: string;
  inputDigest: string;
  sourceDigest: string;
  /** Canonical execution source string (URL / command remainder); null for media. */
  sourceToken: string | null;
  retainedMediaPath: string | null;
  mediaSha256: string | null;
  mediaBytes: number | null;
  attemptCount: number;
  /** A-08: retained media older than the configured horizon; never claimable. */
  mediaExpired: boolean;
}
