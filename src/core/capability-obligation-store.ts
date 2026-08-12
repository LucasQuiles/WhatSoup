/**
 * D4 — capability-obligation store (capability-obligation replay).
 *
 * Persistence for the append-only capability-debt lifecycle (migration 57).
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

  claimObligation(
    id: number,
    params: { claimToken: string; leaseSeconds: number },
  ): { applied: true; claimEpoch: number; attemptCount: number } | { applied: false } {
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
         RETURNING claim_epoch, attempt_count`,
      )
      .get(params.claimToken, params.leaseSeconds, id) as
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
