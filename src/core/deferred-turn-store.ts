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
 *
 * Invariants:
 * - one obligation per (scope, inbound_seq); enqueue is idempotent;
 * - strict head-of-line FIFO: only the LOWEST open inbound_seq per scope is
 *   claimable — an exhausted or held head blocks the scope rather than
 *   permitting out-of-order replay;
 * - `dispatched_commit` is the requirement-4 point of no return: automatic
 *   input replay (requeue) is permanently refused after it;
 * - bounded envelope: oversize replay text and replay-unsafe sources are
 *   refused at enqueue (never truncated, never silently accepted);
 * - `last_error_class` accepts bounded class tags only — never raw errors.
 */
import type { Database } from './database.ts';
import { TURN_RECOVERY_MAX_TEXT_BYTES } from './turn-recovery-contract.ts';

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
      // inbound_seq for the scope AND is pending with attempts left. If the
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
    };
  }

  enqueueDeferredObligation(
    input: DeferredTurnEnqueueInput,
  ): { id: number; status: string; deduplicated: boolean } {
    if (!input.replaySafe) {
      throw new Error(
        'Deferred turn obligations accept only replay-safe envelopes — replay-unsafe turns keep the terminal path',
      );
    }
    if (Buffer.byteLength(input.text, 'utf8') > TURN_RECOVERY_MAX_TEXT_BYTES) {
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
    opts: { claimToken: string; ttlSeconds: number },
  ): DeferredTurnObligation | null {
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
