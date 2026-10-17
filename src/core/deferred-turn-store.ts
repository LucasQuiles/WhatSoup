/**
 * #3295 slice S1 — durable store for `deferred_by_recovery_scope` obligations.
 *
 * A journaled follower turn blocked SOLELY by active same-scope durable turn
 * recovery gains a durable non-terminal deferred owner here instead of a
 * terminal admission rejection. The store owns persistence and the fenced
 * state machine ONLY — admission classification (slice S2) and the drain
 * supervisor (slice S3) are separate, feature-flagged consumers. Mirrors the
 * turn-recovery-store fencing architecture (claim token + claim epoch) without
 * reusing `turn_recovery_jobs` (#3295 forbids generalizing that table).
 *
 * State machine (CHECK-backed, fenced transitions):
 *   pending -> claimed -> dispatched_commit -> terminal_completed
 *   claimed -> pending                 (fenced requeue, PRE-commit only)
 *   claimed -> terminal_quarantined    (undispatchable envelope)
 *   non-terminal -> terminal_operator  (explicit operator remediation)
 *   dispatched_commit -> terminal_completed | terminal_quarantined is also
 *   reachable WITHOUT a fence (slice S3 `settleDispatchedObligation`), but only
 *   on durable proof that the source inbound already reached its own terminal
 *   status: the one dispatch authorization was used, the ordinary terminal path
 *   owns the outcome, and nothing is dispatched or requeued by the settle. A
 *   `complete` source closes `terminal_completed`; a `failed` source closes
 *   `terminal_quarantined` / `source_failed` — a failed turn is never labelled
 *   completed.
 *   Every non-terminal row -> terminal_quarantined is reachable WITHOUT a fence
 *   only from startup crash recovery when the deferred owner is disabled (flag
 *   off): no process will run or settle the obligation, so it is closed
 *   instead of left holding its source. A pre-commit row closes
 *   `owner_disabled`; a `dispatched_commit` row closes
 *   `owner_disabled_after_commit` — effects may have started, so it is never
 *   labelled completed and, being terminal, never replayed.
 *   pending -> terminal_quarantined (`attempts_exhausted`) is reachable WITHOUT
 *   a fence once the row has no attempts left: nothing may claim it, so the
 *   drain closes it instead of letting it block its queue.
 *   pending | claimed -> terminal_quarantined (`operator_cancelled`) is
 *   reachable WITHOUT a fence: an operator cancellation of a never-committed
 *   turn wins over any pre-commit claim (a later commit then fails its fence).
 *   pending -> claimed is restored WITHOUT a new claim (same token, same epoch)
 *   only when the row's claim lapsed and nobody re-claimed it: the epoch is
 *   unchanged, so the original claimant still owns the obligation.
 *
 * Invariants:
 * - one obligation per (scope, inbound_seq); enqueue is idempotent;
 * - strict head-of-line FIFO: only the LOWEST open inbound_seq per conversation
 *   in per_chat mode (otherwise per scope) is claimable — a held head blocks its
 *   queue rather than permitting out-of-order replay, and an exhausted head
 *   blocks it until the drain closes it (`terminalizeExhaustedHead`);
 * - `dispatched_commit` is the requirement-4 point of no return: automatic
 *   input replay (requeue) is permanently refused after it;
 * - bounded envelope: oversize replay text and replay-unsafe sources are
 *   refused at enqueue (never truncated, never silently accepted);
 * - `last_error_class` accepts bounded class tags only — never raw errors.
 */
import type { Database } from './database.ts';
import { TURN_RECOVERY_MAX_TEXT_BYTES } from './turn-recovery-contract.ts';
import { TURN_RECOVERY_MAX_ID_BYTES, validateBoundedRequired } from './turn-recovery-store.ts';

export const DEFERRED_TURN_MAX_ATTEMPTS = 5;

/**
 * The absorbing states of the lifecycle above — the CHECK-backed statuses after
 * which no further transition is possible and nothing is owed.
 */
export const DEFERRED_TURN_TERMINAL_STATUSES = [
  'terminal_completed',
  'terminal_quarantined',
  'terminal_operator',
] as const;

/**
 * SQL predicate that is TRUE while an obligation row is non-terminal, rendered
 * once from the list above.
 *
 * Exported because the retention sweep must hold the source inbound and its
 * replay envelope while ANY obligation for that inbound is still non-terminal
 * (#3295 required behaviour 8). A second copy of the status list over there
 * would silently resume deleting held evidence the day a terminal state is
 * added here, so both sites read the same definition.
 */
export const DEFERRED_TURN_NON_TERMINAL_STATUS_SQL =
  `status NOT IN (${DEFERRED_TURN_TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ')})`;

const ERROR_CLASS_RE = /^[a-z0-9_.:-]{1,64}$/;
const CLAIM_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export class DeferredTurnClaimFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeferredTurnClaimFenceError';
  }
}

export interface DeferredTurnEnqueueInput {
  scope: string;
  conversationKey: string;
  deliveryJid: string;
  inboundSeq: number;
  sourceMessageId: string;
  receivedAtUnixSeconds: number;
  replaySafe: boolean;
  senderJid: string;
  senderName?: string | null;
  text: string;
  isGroup: boolean;
  groupName?: string | null;
  contentType: string;
  toolScopeKey?: string | null;
}

export interface DeferredTurnClaimFence {
  claimToken: string;
  claimEpoch: number;
}

export interface DeferredTurnObligation {
  id: number;
  scope: string;
  conversationKey: string;
  deliveryJid: string;
  inboundSeq: number;
  sourceMessageId: string;
  receivedAtUnixSeconds: number;
  senderJid: string;
  senderName: string | null;
  text: string;
  isGroup: boolean;
  groupName: string | null;
  contentType: string;
  toolScopeKey: string | null;
  status: string;
  attemptCount: number;
  claimEpoch: number;
  lastErrorClass: string | null;
  terminalReason: string | null;
}

/** The lowest open obligation of one drain queue (slice S3 drain input). */
export interface DeferredTurnOpenHead {
  id: number;
  conversationKey: string;
  deliveryJid: string;
  inboundSeq: number;
  status: string;
  attemptCount: number;
}

export interface DeferredTurnOpenRow {
  id: number;
  inboundSeq: number;
  /** `pending` | `claimed` | `dispatched_commit` | `exhausted` (pending with no attempts left). */
  status: string;
  attemptCount: number;
}

type ObligationRow = {
  id: number;
  scope: string;
  conversation_key: string;
  delivery_jid: string;
  inbound_seq: number;
  source_message_id: string;
  received_at_unix: number;
  sender_jid: string;
  sender_name: string | null;
  replay_text: string;
  is_group: number;
  group_name: string | null;
  content_type: string;
  tool_scope_key: string | null;
  status: string;
  attempt_count: number;
  claim_epoch: number;
  last_error_class: string | null;
  terminal_reason: string | null;
};

const OBLIGATION_COLUMNS = `
  id, scope, conversation_key, delivery_jid, inbound_seq, source_message_id,
  received_at_unix, sender_jid, sender_name, replay_text, is_group, group_name,
  content_type, tool_scope_key, status, attempt_count, claim_epoch,
  last_error_class, terminal_reason
`;

function toObligation(row: ObligationRow): DeferredTurnObligation {
  return {
    id: row.id,
    scope: row.scope,
    conversationKey: row.conversation_key,
    deliveryJid: row.delivery_jid,
    inboundSeq: row.inbound_seq,
    sourceMessageId: row.source_message_id,
    receivedAtUnixSeconds: row.received_at_unix,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    text: row.replay_text,
    isGroup: row.is_group === 1,
    groupName: row.group_name,
    contentType: row.content_type,
    toolScopeKey: row.tool_scope_key,
    status: row.status,
    attemptCount: row.attempt_count,
    claimEpoch: row.claim_epoch,
    lastErrorClass: row.last_error_class,
    terminalReason: row.terminal_reason,
  };
}

function validateErrorClass(errorClass: string): void {
  if (!ERROR_CLASS_RE.test(errorClass)) {
    throw new Error(
      'Deferred turn error class must be a bounded lowercase tag — raw error text is refused',
    );
  }
}

/**
 * The replay-envelope contract every obligation must meet: a replay-safe
 * envelope whose text fits the byte bound. Returns the refusal tag, or null when
 * the envelope can be durably owned. The one definition read by `enqueue` and
 * by any caller that must decide BEFORE accepting work whether it can hand the
 * work to this store (the #3703 planned-stop intake).
 */
export function deferredTurnEnvelopeRefusal(envelope: {
  readonly replaySafe: boolean;
  readonly text: string;
}): 'replay_unsafe' | 'replay_text_oversize' | null {
  if (envelope.replaySafe !== true) return 'replay_unsafe';
  if (Buffer.byteLength(envelope.text, 'utf8') > TURN_RECOVERY_MAX_TEXT_BYTES) return 'replay_text_oversize';
  return null;
}

/** Source identity of an obligation closed without a fence (the caller settles the source). */
export interface DeferredTurnClosedSource {
  inboundSeq: number;
  sourceMessageId: string;
  deliveryJid: string;
}

function validateFenceShape(fence: DeferredTurnClaimFence): void {
  if (!CLAIM_TOKEN_RE.test(fence.claimToken)) {
    throw new Error('Deferred turn claim token has an invalid shape');
  }
  if (!Number.isSafeInteger(fence.claimEpoch) || fence.claimEpoch < 0) {
    throw new Error('Deferred turn claim epoch must be a non-negative safe integer');
  }
}

export class DeferredTurnStore {
  private readonly statements;

  constructor(db: Database) {
    const prepare = db.raw.prepare.bind(db.raw);
    this.statements = {
      enqueue: prepare(`
        INSERT INTO deferred_turn_obligations (
          scope, conversation_key, delivery_jid, inbound_seq, source_message_id,
          received_at_unix, replay_safe, sender_jid, sender_name, replay_text,
          is_group, group_name, content_type, tool_scope_key
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id, status
      `),
      getBySource: prepare(`
        SELECT id, status FROM deferred_turn_obligations
        WHERE scope = ? AND inbound_seq = ?
      `),
      // Strict head-of-line: claim ONLY the row that is the minimum open
      // inbound_seq for the selected queue AND is pending with attempts left. If the
      // head is claimed/committed/exhausted, no row matches — never skip.
      claimHead: prepare(`
        UPDATE deferred_turn_obligations
        SET status = 'claimed',
            attempt_count = attempt_count + 1,
            claim_epoch = claim_epoch + 1,
            claim_token = ?,
            claimed_at = datetime('now'),
            claim_expires_at = datetime('now', ?),
            updated_at = datetime('now')
        WHERE id = (
          SELECT id FROM deferred_turn_obligations
          WHERE scope = ?
            AND (scope <> 'per_chat' OR conversation_key = ?)
            AND ${DEFERRED_TURN_NON_TERMINAL_STATUS_SQL}
          ORDER BY inbound_seq ASC
          LIMIT 1
        )
          AND status = 'pending'
          AND attempt_count < ${DEFERRED_TURN_MAX_ATTEMPTS}
        RETURNING ${OBLIGATION_COLUMNS}
      `),
      fencedTransition: prepare(`
        UPDATE deferred_turn_obligations
        SET status = ?,
            last_error_class = COALESCE(?, last_error_class),
            terminal_reason = COALESCE(?, terminal_reason),
            claim_token = CASE WHEN ? = 'pending' THEN NULL ELSE claim_token END,
            claim_expires_at = CASE WHEN ? = 'pending' THEN NULL ELSE claim_expires_at END,
            updated_at = datetime('now')
        WHERE id = ?
          AND status = ?
          AND claim_token = ?
          AND claim_epoch = ?
        RETURNING id
      `),
      terminalizeByOperator: prepare(`
        UPDATE deferred_turn_obligations
        SET status = 'terminal_operator',
            terminal_reason = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND ${DEFERRED_TURN_NON_TERMINAL_STATUS_SQL}
        RETURNING id
      `),
      // Lease renewal for a claim its live owner still holds (same token and
      // epoch, still claimed). Never revives a claim another sweeper reset.
      renewClaim: prepare(`
        UPDATE deferred_turn_obligations
        SET claim_expires_at = datetime('now', ?),
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'claimed'
          AND claim_token = ?
          AND claim_epoch = ?
        RETURNING id
      `),
      // A lapsed claim nobody re-claimed (the expiry sweep reset it; the epoch
      // is unchanged) goes back to its original claimant. Attempts unchanged.
      restoreLapsedClaim: prepare(`
        UPDATE deferred_turn_obligations
        SET status = 'claimed',
            claim_token = ?,
            claim_expires_at = datetime('now', ?),
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'pending'
          AND claim_token IS NULL
          AND claim_epoch = ?
        RETURNING id
      `),
      // An exhausted pending row can never be claimed again: close it so it
      // stops blocking its queue. The caller settles the source.
      terminalizeExhausted: prepare(`
        UPDATE deferred_turn_obligations
        SET status = 'terminal_quarantined',
            terminal_reason = 'attempts_exhausted',
            last_error_class = COALESCE(last_error_class, 'attempts_exhausted'),
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'pending'
          AND attempt_count >= ${DEFERRED_TURN_MAX_ATTEMPTS}
        RETURNING inbound_seq, source_message_id, delivery_jid
      `),
      // Startup recovery with the deferred owner disabled: nothing will run or
      // settle any open obligation. Committed rows are never labelled completed.
      closeForDisabledOwner: prepare(`
        UPDATE deferred_turn_obligations
        SET terminal_reason = CASE status
              WHEN 'dispatched_commit' THEN 'owner_disabled_after_commit'
              ELSE 'owner_disabled'
            END,
            status = 'terminal_quarantined',
            last_error_class = 'owner_disabled',
            claim_token = NULL,
            claim_expires_at = NULL,
            updated_at = datetime('now')
        WHERE ${DEFERRED_TURN_NON_TERMINAL_STATUS_SQL}
      `),
      expireStale: prepare(`
        UPDATE deferred_turn_obligations
        SET status = 'pending',
            claim_token = NULL,
            claim_expires_at = NULL,
            updated_at = datetime('now')
        WHERE scope = ?
          AND status = 'claimed'
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at <= datetime('now')
      `),
      listOpen: prepare(`
        SELECT id, inbound_seq, status, attempt_count
        FROM deferred_turn_obligations
        WHERE scope = ?
          AND ${DEFERRED_TURN_NON_TERMINAL_STATUS_SQL}
        ORDER BY inbound_seq ASC
      `),
      countByStatus: prepare(`
        SELECT status, COUNT(*) AS n
        FROM deferred_turn_obligations
        WHERE scope = ?
        GROUP BY status
      `),
      hasNonTerminal: prepare(`
        SELECT 1 AS present FROM deferred_turn_obligations
        WHERE scope = ? AND inbound_seq = ?
          AND ${DEFERRED_TURN_NON_TERMINAL_STATUS_SQL}
      `),
      getStatus: prepare(`
        SELECT status FROM deferred_turn_obligations WHERE id = ?
      `),
      // The head of every drain queue: the lowest open inbound_seq per
      // conversation (per_chat) or per scope. Mirrors claimHead's selection.
      listOpenHeads: prepare(`
        SELECT o.id, o.conversation_key, o.delivery_jid, o.inbound_seq, o.status, o.attempt_count
        FROM deferred_turn_obligations o
        WHERE o.scope = ?
          AND o.${DEFERRED_TURN_NON_TERMINAL_STATUS_SQL}
          AND o.inbound_seq = (
            SELECT MIN(h.inbound_seq) FROM deferred_turn_obligations h
            WHERE h.scope = o.scope
              AND (o.scope <> 'per_chat' OR h.conversation_key = o.conversation_key)
              AND h.${DEFERRED_TURN_NON_TERMINAL_STATUS_SQL}
          )
        ORDER BY o.inbound_seq ASC
      `),
      // The source inbound may still be dispatched: open and without its own
      // terminal record. Anything else was settled by another owner.
      isSourceOpen: prepare(`
        SELECT 1 AS open FROM inbound_events i
        WHERE i.seq = ?
          AND i.processing_status IN ('pending', 'processing')
          AND NOT EXISTS (
            SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq_key = i.seq
          )
      `),
      settleDispatched: prepare(`
        UPDATE deferred_turn_obligations
        SET status = (
              SELECT CASE i.processing_status WHEN 'complete' THEN 'terminal_completed' ELSE 'terminal_quarantined' END
              FROM inbound_events i WHERE i.seq = deferred_turn_obligations.inbound_seq
            ),
            terminal_reason = (
              SELECT CASE i.processing_status WHEN 'complete' THEN 'completed' ELSE 'source_failed' END
              FROM inbound_events i WHERE i.seq = deferred_turn_obligations.inbound_seq
            ),
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'dispatched_commit'
          AND EXISTS (
            SELECT 1 FROM inbound_events i
            WHERE i.seq = deferred_turn_obligations.inbound_seq
              AND i.processing_status IN ('complete', 'failed')
          )
        RETURNING terminal_reason
      `),
      // FIFO against live input: ANY obligation of the conversation older than
      // the given inbound that can still run (pending with attempts left,
      // claimed, or committed and settling) — not only the queue head. An
      // exhausted head cannot run and the drain closes it, but the runnable
      // work queued behind it is still older than the live input.
      hasEligibleOpenHeadBefore: prepare(`
        SELECT 1 AS present FROM deferred_turn_obligations o
        WHERE o.scope = ?
          AND (o.scope <> 'per_chat' OR o.conversation_key = ?)
          AND o.inbound_seq < ?
          AND (o.status IN ('claimed', 'dispatched_commit')
            OR (o.status = 'pending' AND o.attempt_count < ${DEFERRED_TURN_MAX_ATTEMPTS}))
        LIMIT 1
      `),
      quarantinePreCommitForSource: prepare(`
        UPDATE deferred_turn_obligations
        SET status = 'terminal_quarantined',
            terminal_reason = ?,
            last_error_class = ?,
            claim_token = NULL,
            claim_expires_at = NULL,
            updated_at = datetime('now')
        WHERE inbound_seq = ?
          AND status IN ('pending', 'claimed')
      `),
    };
  }

  enqueueDeferredObligation(
    input: DeferredTurnEnqueueInput,
  ): { id: number; status: string; deduplicated: boolean } {
    const refusal = deferredTurnEnvelopeRefusal(input);
    if (refusal === 'replay_unsafe') {
      throw new Error(
        'Deferred turn obligations accept only replay-safe envelopes — replay-unsafe turns keep the terminal path',
      );
    }
    if (refusal === 'replay_text_oversize') {
      throw new Error(
        `Deferred turn replay text exceeds the ${TURN_RECOVERY_MAX_TEXT_BYTES}-byte envelope bound — refused, never truncated`,
      );
    }
    const existing = this.statements.getBySource.get(input.scope, input.inboundSeq) as
      | { id: number; status: string }
      | undefined;
    if (existing) {
      return { id: existing.id, status: existing.status, deduplicated: true };
    }
    const created = this.statements.enqueue.get(
      input.scope,
      input.conversationKey,
      input.deliveryJid,
      input.inboundSeq,
      input.sourceMessageId,
      input.receivedAtUnixSeconds,
      input.senderJid,
      input.senderName ?? null,
      input.text,
      input.isGroup ? 1 : 0,
      input.groupName ?? null,
      input.contentType,
      input.toolScopeKey ?? null,
    ) as { id: number; status: string };
    return { id: created.id, status: created.status, deduplicated: false };
  }

  claimNextEligible(
    scope: string,
    opts: { conversationKey?: string; claimToken: string; ttlSeconds: number },
  ): DeferredTurnObligation | null {
    if (scope === 'per_chat') {
      validateBoundedRequired(
        opts.conversationKey ?? '',
        'Deferred turn conversation key',
        TURN_RECOVERY_MAX_ID_BYTES,
      );
    }
    if (!CLAIM_TOKEN_RE.test(opts.claimToken)) {
      throw new Error('Deferred turn claim token has an invalid shape');
    }
    if (!Number.isSafeInteger(opts.ttlSeconds)) {
      throw new Error('Deferred turn claim ttlSeconds must be a safe integer');
    }
    const row = this.statements.claimHead.get(
      opts.claimToken,
      `${opts.ttlSeconds} seconds`,
      scope,
      opts.conversationKey ?? null,
    ) as ObligationRow | undefined;
    return row ? toObligation(row) : null;
  }

  private runFencedTransition(
    id: number,
    fence: DeferredTurnClaimFence,
    fromStatus: string,
    toStatus: string,
    errorClass: string | null,
    terminalReason: string | null,
  ): void {
    validateFenceShape(fence);
    const moved = this.statements.fencedTransition.get(
      toStatus,
      errorClass,
      terminalReason,
      toStatus,
      toStatus,
      id,
      fromStatus,
      fence.claimToken,
      fence.claimEpoch,
    ) as { id: number } | undefined;
    if (!moved) {
      const current = this.statements.getStatus.get(id) as { status: string } | undefined;
      if (current?.status === 'dispatched_commit' && toStatus === 'pending') {
        throw new Error(
          'Deferred turn requeue refused: provider dispatch is durably committed — automatic input replay is permanently vetoed',
        );
      }
      throw new DeferredTurnClaimFenceError(
        `Deferred turn fence is stale or the ${fromStatus} -> ${toStatus} transition is not legal for obligation ${id}`,
      );
    }
  }

  /** Fenced claimed -> pending. Legal only BEFORE dispatch commit. */
  requeueClaim(id: number, fence: DeferredTurnClaimFence, errorClass: string): void {
    validateErrorClass(errorClass);
    this.runFencedTransition(id, fence, 'claimed', 'pending', errorClass, null);
  }

  /** Fenced claimed -> dispatched_commit: the requirement-4 point of no return. */
  markDispatchCommit(id: number, fence: DeferredTurnClaimFence): void {
    this.runFencedTransition(id, fence, 'claimed', 'dispatched_commit', null, null);
  }

  /** Fenced dispatched_commit -> terminal_completed. */
  terminalizeCompleted(id: number, fence: DeferredTurnClaimFence): void {
    this.runFencedTransition(id, fence, 'dispatched_commit', 'terminal_completed', null, 'completed');
  }

  /** Fenced claimed -> terminal_quarantined (undispatchable envelope). */
  terminalizeQuarantined(id: number, fence: DeferredTurnClaimFence, reason: string): void {
    validateErrorClass(reason);
    this.runFencedTransition(id, fence, 'claimed', 'terminal_quarantined', reason, reason);
  }

  /** Operator remediation closes any non-terminal obligation without a fence. */
  terminalizeByOperator(id: number, reason: string): void {
    validateErrorClass(reason);
    const moved = this.statements.terminalizeByOperator.get(reason, id) as { id: number } | undefined;
    if (!moved) {
      throw new Error(`Deferred turn obligation ${id} is already terminal — operator close refused`);
    }
  }

  /**
   * Extend a claim its owner still holds (same token and epoch, still
   * `claimed`). Returns false when the claim was lost: the sweep reset it, it
   * was re-claimed, committed or closed.
   */
  renewClaim(id: number, fence: DeferredTurnClaimFence, ttlSeconds: number): boolean {
    validateFenceShape(fence);
    if (!Number.isSafeInteger(ttlSeconds)) {
      throw new Error('Deferred turn claim ttlSeconds must be a safe integer');
    }
    return this.statements.renewClaim.get(`${ttlSeconds} seconds`, id, fence.claimToken, fence.claimEpoch) !== undefined;
  }

  /**
   * Give a lapsed claim back to its original claimant: legal only while the
   * row is `pending` with no claim and the SAME epoch (the expiry sweep reset
   * it and nobody claimed it since). Returns false otherwise.
   */
  restoreLapsedClaim(id: number, fence: DeferredTurnClaimFence, ttlSeconds: number): boolean {
    validateFenceShape(fence);
    if (!Number.isSafeInteger(ttlSeconds)) {
      throw new Error('Deferred turn claim ttlSeconds must be a safe integer');
    }
    return this.statements.restoreLapsedClaim.get(
      fence.claimToken, `${ttlSeconds} seconds`, id, fence.claimEpoch,
    ) !== undefined;
  }

  /**
   * Close an exhausted `pending` row (no attempts left; nothing may claim it)
   * `terminal_quarantined` / `attempts_exhausted`. Returns the source identity
   * for the caller to settle, or null when the row is not an exhausted pending row.
   */
  terminalizeExhaustedHead(id: number): DeferredTurnClosedSource | null {
    const row = this.statements.terminalizeExhausted.get(id) as
      | { inbound_seq: number; source_message_id: string; delivery_jid: string }
      | undefined;
    return row
      ? { inboundSeq: row.inbound_seq, sourceMessageId: row.source_message_id, deliveryJid: row.delivery_jid }
      : null;
  }

  /**
   * Startup recovery with the deferred owner disabled: close every
   * non-terminal obligation (no fence; no process will run or settle it).
   * Pre-commit rows close `owner_disabled`; `dispatched_commit` rows close
   * `owner_disabled_after_commit` (replay vetoed, never completed). Returns the
   * number of rows closed.
   */
  closeForDisabledOwner(): number {
    return Number(this.statements.closeForDisabledOwner.run().changes ?? 0);
  }

  /** True when the obligation is in an absorbing state (or does not exist). */
  isTerminal(id: number): boolean {
    const row = this.statements.getStatus.get(id) as { status: string } | undefined;
    return row === undefined
      || (DEFERRED_TURN_TERMINAL_STATUSES as readonly string[]).includes(row.status);
  }

  /** claimed rows whose claim TTL passed return to pending (attempts kept). */
  expireStaleClaims(scope: string): number {
    const result = this.statements.expireStale.run(scope);
    return Number(result.changes ?? 0);
  }

  listOpenObligations(scope: string): DeferredTurnOpenRow[] {
    const rows = this.statements.listOpen.all(scope) as Array<{
      id: number;
      inbound_seq: number;
      status: string;
      attempt_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      inboundSeq: row.inbound_seq,
      status: row.status === 'pending' && row.attempt_count >= DEFERRED_TURN_MAX_ATTEMPTS
        ? 'exhausted'
        : row.status,
      attemptCount: row.attempt_count,
    }));
  }

  countByStatus(scope: string): Record<string, number> {
    const rows = this.statements.countByStatus.all(scope) as Array<{ status: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  /** Slice S3 drain input: the head obligation of every open drain queue. */
  listOpenHeads(scope: string): DeferredTurnOpenHead[] {
    const rows = this.statements.listOpenHeads.all(scope) as Array<{
      id: number;
      conversation_key: string;
      delivery_jid: string;
      inbound_seq: number;
      status: string;
      attempt_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      conversationKey: row.conversation_key,
      deliveryJid: row.delivery_jid,
      inboundSeq: row.inbound_seq,
      status: row.status,
      attemptCount: row.attempt_count,
    }));
  }

  /** True while the source inbound is open and has no terminal record of its own. */
  isSourceOpen(inboundSeq: number): boolean {
    return this.statements.isSourceOpen.get(inboundSeq) !== undefined;
  }

  /**
   * Close a `dispatched_commit` obligation once its source inbound is terminal.
   * A `complete` source closes `terminal_completed` / `completed`; a `failed`
   * one closes `terminal_quarantined` / `source_failed`. Never dispatches or
   * requeues. Returns the bounded terminal reason, or null while the source is
   * still open (the obligation stays held, its replay vetoed).
   */
  settleDispatchedObligation(id: number): 'completed' | 'source_failed' | null {
    const row = this.statements.settleDispatched.get(id) as { terminal_reason: string } | undefined;
    if (!row) return null;
    return row.terminal_reason === 'completed' ? 'completed' : 'source_failed';
  }

  /** True when an older, still runnable obligation of this conversation exists (FIFO against live input). */
  hasEligibleOpenHeadBefore(scope: string, conversationKey: string, inboundSeq: number): boolean {
    return this.statements.hasEligibleOpenHeadBefore.get(scope, conversationKey, inboundSeq) !== undefined;
  }

  /**
   * Close every pre-commit (`pending` | `claimed`) obligation of the source
   * without a fence. Used for an operator cancellation of a never-committed
   * turn: it must win over any claim, stale or live. Never touches a
   * `dispatched_commit` row. Returns the number of rows closed.
   */
  quarantinePreCommitForSource(inboundSeq: number, reason: string): number {
    validateErrorClass(reason);
    return Number(this.statements.quarantinePreCommitForSource.run(reason, reason, inboundSeq).changes ?? 0);
  }

  /** Retention guard hook: true while the inbound's obligation is non-terminal. */
  hasNonTerminalObligation(scope: string, inboundSeq: number): boolean {
    return this.statements.hasNonTerminal.get(scope, inboundSeq) !== undefined;
  }

  /** Content-free projection for logs/health — ids, seqs, statuses, counts only. */
  summarizeForDiagnostics(scope: string): {
    open: DeferredTurnOpenRow[];
    counts: Record<string, number>;
  } {
    return { open: this.listOpenObligations(scope), counts: this.countByStatus(scope) };
  }
}
