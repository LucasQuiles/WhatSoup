/**
 * #3560 — read-only, content-free ownership snapshot for inbounds stuck in
 * `processing`.
 *
 * Two same-chat inbounds sat in `processing` for ~30 minutes with no visible
 * owner and then settled. The global health projection (provider idle, zero
 * pending, no active turn id) could not say who owned each row. This answers
 * that per row, from the persisted durability rows plus an optional capture of
 * the provider-execution gate, and classifies each row:
 *
 *   deferred   — a non-terminal deferred_turn_obligations row owns it (#3295)
 *   queued     — pending recovery job, behind the chat's persisted FIFO head,
 *                behind another outstanding recovery job for the scope, or the
 *                oldest waiter on the provider lane
 *   executing  — a live recovery claim, or the provider lane is held by a turn
 *                for this chat (head row only), per a capture no older than
 *                PROVIDER_CAPTURE_MAX_AGE_SECONDS, and not contradicted by a
 *                completed checkpoint at or past the row
 *   no_owner   — none of the above; never healthy
 *
 * What it can NOT see (in-process only, and deliberately not reached into):
 * the runtime's per-chat TurnQueue depth/position and active turn, and the
 * gate's lease generation. The queue here is the persisted proxy — open
 * inbounds per conversation in seq order — and `session_checkpoints.active_turn_id`
 * is reported as stored (current writers only ever store null).
 *
 * The caller owns the connection: the operator script opens it read-only with
 * `query_only`, so a write attempted here would throw. Every SELECT below
 * reads raw chat JIDs only to hash them, and never selects message text, ids,
 * sender identifiers, payloads or error text.
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  DEFERRED_TURN_MAX_ATTEMPTS,
  DEFERRED_TURN_NON_TERMINAL_STATUS_SQL,
} from '../../core/deferred-turn-store.ts';
import { validDeliveryCorroborationForJobSql } from '../../core/delivery-corroboration-sql.ts';
import { OPEN_INBOUND_STATUSES } from '../../core/inbound-status.ts';
import { TerminalRecordInboundCloser } from '../../core/terminal-record-inbound-close.ts';
import { shortHash } from '../../lib/short-hash.ts';
import type { ProviderExecutionGateSnapshot } from './provider-execution-gate.ts';

export const INBOUND_OWNERSHIP_SCHEMA_VERSION = 1;

/** Same 15 minutes the reply-guarantee observer uses to call an open inbound stale. */
export const DEFAULT_OWNERSHIP_MIN_AGE_MINUTES = 15;

export type InboundOwnershipClass = 'queued' | 'deferred' | 'executing' | 'no_owner';

export type InboundOwnershipReason =
  | 'deferred_obligation_open'
  | 'deferred_obligation_exhausted'
  | 'recovery_job_pending'
  | 'recovery_job_claimed'
  | 'recovery_claim_expired'
  | 'recovery_job_blocked_unsafe'
  | 'recovery_job_exhausted'
  | 'recovery_job_completed_inbound_open'
  | 'recovery_delivery_corroborated_inbound_open'
  | 'terminal_record_inbound_open'
  | 'transferred_without_recovery_job'
  | 'queued_behind_fifo_head'
  | 'queued_behind_scope_recovery'
  | 'provider_execution_active'
  | 'provider_execution_waiting'
  | 'provider_capture_stale'
  | 'provider_active_contradicts_completed_checkpoint'
  | 'no_attributable_owner'
  | 'no_persisted_owner_provider_not_observed';

export type InboundOwnerKind =
  | 'deferred_obligation'
  | 'recovery_job'
  | 'scope_recovery_job'
  | 'fifo_head_inbound'
  | 'provider_execution'
  | 'provider_execution_waiter'
  | 'none';

export type InboundOwnershipQueueScope = 'per_chat' | 'global';

/** The content-free provider-execution fields the snapshot joins (#2340/#3547 read only). */
export type ProviderExecutionObservation = Pick<
  ProviderExecutionGateSnapshot,
  | 'active'
  | 'activeWorkKind'
  | 'activeScopeHash'
  | 'activeAgeMs'
  | 'activePhase'
  | 'progressAgeMs'
  | 'pending'
  | 'oldestPendingWorkKind'
  | 'oldestPendingScopeHash'
  | 'oldestWaitMs'
>;

/**
 * A provider capture older than this (or undated) is not evidence of what the
 * lane holds now: holds turn over in seconds, so an old `active` proves nothing
 * about the row. A capture up to the skew bound in the future is tolerated.
 */
export const PROVIDER_CAPTURE_MAX_AGE_SECONDS = 60;
export const PROVIDER_CAPTURE_MAX_FUTURE_SKEW_SECONDS = 5;

export type ProviderExecutionEvidence =
  | 'not_supplied'
  | 'stale'
  | 'idle'
  | 'active_this_scope'
  | 'active_other_scope'
  | 'active_probe';

export interface InboundOwner {
  readonly kind: InboundOwnerKind;
  readonly inboundSeq: number | null;
  readonly logicalTurnId: string | null;
  readonly generation: number | null;
  readonly recoveryJobId: number | null;
  readonly deferredObligationId: number | null;
}

export interface InboundOwnershipRow {
  readonly inboundSeq: number;
  /** shortHash(chat JID) — the same content-free scope hash the provider gate publishes. */
  readonly chatScopeHash: string;
  readonly ageSeconds: number | null;
  readonly ageEvidence: 'valid' | 'invalid_timestamp';
  readonly classification: InboundOwnershipClass;
  readonly healthy: boolean;
  readonly reason: InboundOwnershipReason;
  readonly owner: InboundOwner;
  readonly queue: {
    readonly basis: 'persisted_open_inbounds';
    readonly scope: InboundOwnershipQueueScope;
    readonly depth: number;
    readonly position: number;
    readonly headInboundSeq: number;
  };
  readonly providerExecution: {
    readonly evidence: ProviderExecutionEvidence;
    readonly activePhase: string | null;
    readonly activeAgeMs: number | null;
    readonly progressAgeMs: number | null;
    readonly pending: number | null;
    readonly oldestPendingIsThisScope: boolean | null;
  };
  readonly deferredObligation: {
    readonly id: number;
    readonly status: string;
    readonly attemptCount: number;
    readonly claimEpoch: number;
  } | null;
  readonly recoveryJob: {
    readonly id: number;
    readonly state: string;
    readonly attemptCount: number;
    readonly claimEpoch: number;
    readonly assignedOwnerLogicalTurnId: string;
    readonly assignedOwnerGeneration: number;
    readonly nextAttemptInSeconds: number | null;
    readonly claimExpiresInSeconds: number | null;
    readonly deliveryCorroborated: boolean;
  } | null;
  readonly terminalRecord: {
    readonly id: number;
    readonly inboundDisposition: string;
    readonly deliveryKind: string;
    readonly logicalTurnId: string;
    readonly generation: number;
    readonly ageSeconds: number | null;
    readonly closeVerdict: string;
  } | null;
  readonly lastOutbound: {
    readonly id: number;
    readonly status: string;
    readonly isTerminal: boolean;
    readonly ageSeconds: number | null;
  } | null;
  readonly lastChatTerminal: {
    readonly inboundSeq: number | null;
    readonly inboundDisposition: string;
    readonly deliveryKind: string;
    readonly ageSeconds: number | null;
  } | null;
  readonly checkpoint: {
    readonly sessionStatus: string;
    readonly activeTurnId: string | null;
    readonly completedInboundSeq: number | null;
    readonly completedLogicalTurnId: string | null;
    readonly completedGeneration: number | null;
    readonly updatedAgeSeconds: number | null;
  } | null;
}

export interface InboundOwnershipSnapshot {
  readonly schemaVersion: typeof INBOUND_OWNERSHIP_SCHEMA_VERSION;
  readonly minAgeMinutes: number;
  readonly queueScope: InboundOwnershipQueueScope;
  readonly providerExecutionEvidence: 'supplied' | 'not_supplied' | 'stale';
  /** Seconds between the provider capture and this read (null when none or undated). */
  readonly providerCaptureAgeSeconds: number | null;
  readonly healthy: boolean;
  readonly counts: {
    readonly processing: number;
    readonly reported: number;
    readonly queued: number;
    readonly deferred: number;
    readonly executing: number;
    readonly no_owner: number;
  };
  readonly rows: readonly InboundOwnershipRow[];
}

export interface InboundOwnershipSnapshotOptions {
  readonly minAgeMinutes: number;
  readonly queueScope?: InboundOwnershipQueueScope;
  readonly providerExecution?: ProviderExecutionObservation | null;
  /**
   * When the provider capture was taken (epoch ms). Missing, or outside
   * PROVIDER_CAPTURE_MAX_AGE_SECONDS, makes the capture stale: it attributes nothing.
   */
  readonly providerExecutionCapturedAtMs?: number | null;
  readonly nowMs?: number;
}

const WORK_KIND = z.enum(['turn', 'probe']).nullable();
const SCOPE_HASH = z.string().regex(/^[0-9a-f]{12}$/).nullable();
const DURATION_MS = z.number().finite().nonnegative();

/** Fields not listed here (pressure counters etc.) are stripped, not rejected. */
const PROVIDER_EXECUTION_SCHEMA = z.object({
  active: z.boolean(),
  activeWorkKind: WORK_KIND,
  activeScopeHash: SCOPE_HASH,
  activeAgeMs: DURATION_MS,
  activePhase: z.enum(['queued_to_spawn', 'executing', 'terminalizing', 'cleanup']),
  progressAgeMs: DURATION_MS,
  pending: z.number().int().nonnegative(),
  oldestPendingWorkKind: WORK_KIND,
  oldestPendingScopeHash: SCOPE_HASH,
  oldestWaitMs: DURATION_MS,
});

export function parseProviderExecutionObservation(value: unknown): ProviderExecutionObservation | null {
  const parsed = PROVIDER_EXECUTION_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

/** Turn ids are runtime UUIDs; anything else is hashed so no stored text can leak. */
function safeIdentifier(value: string | null): string | null {
  if (value === null) return null;
  return SAFE_IDENTIFIER.test(value) ? value : `sha256:${shortHash(value)}`;
}

function secondsSince(unix: number | null, nowSeconds: number): number | null {
  return unix === null ? null : Math.max(0, nowSeconds - unix);
}

function secondsUntil(unix: number | null, nowSeconds: number): number | null {
  return unix === null ? null : unix - nowSeconds;
}

interface OpenInboundRow {
  seq: number;
  processing_status: string;
  chat_jid: string;
  received_unix: number | null;
  chat_depth: number;
  chat_position: number;
  chat_head: number;
  global_depth: number;
  global_position: number;
  global_head: number;
}

interface DeferredRow {
  id: number;
  status: string;
  attempt_count: number;
  claim_epoch: number;
}

interface RecoveryJobRow {
  id: number;
  state: string;
  attempt_count: number;
  claim_epoch: number;
  assigned_owner_logical_turn_id: string;
  assigned_owner_generation: number;
  next_attempt_unix: number | null;
  claim_expires_unix: number | null;
  corroborated: number;
}

interface ScopeRecoveryRow {
  id: number;
  source_inbound_seq: number;
  assigned_owner_logical_turn_id: string;
  assigned_owner_generation: number;
}

interface TerminalRow {
  id: number;
  inbound_disposition: string;
  delivery_kind: string;
  logical_turn_id: string;
  generation: number;
  created_unix: number | null;
}

interface OutboundRow {
  id: number;
  status: string;
  is_terminal: number;
  created_unix: number | null;
}

interface ChatTerminalRow {
  inbound_seq: number | null;
  inbound_disposition: string;
  delivery_kind: string;
  created_unix: number | null;
}

interface CheckpointRow {
  session_status: string;
  active_turn_id: string | null;
  completed_inbound_seq: number | null;
  completed_logical_turn_id: string | null;
  completed_generation: number | null;
  updated_unix: number | null;
}

interface Ownership {
  readonly classification: InboundOwnershipClass;
  readonly reason: InboundOwnershipReason;
  readonly healthy: boolean;
  readonly owner: InboundOwner;
}

const NO_OWNER: InboundOwner = {
  kind: 'none',
  inboundSeq: null,
  logicalTurnId: null,
  generation: null,
  recoveryJobId: null,
  deferredObligationId: null,
};

function owned(
  classification: Exclude<InboundOwnershipClass, 'no_owner'>,
  reason: InboundOwnershipReason,
  owner: Partial<InboundOwner> & Pick<InboundOwner, 'kind'>,
): Ownership {
  return { classification, reason, healthy: true, owner: { ...NO_OWNER, ...owner } };
}

function unowned(reason: InboundOwnershipReason): Ownership {
  return { classification: 'no_owner', reason, healthy: false, owner: NO_OWNER };
}

function prepareStatements(raw: DatabaseSync) {
  const openStatuses = OPEN_INBOUND_STATUSES.map((status) => `'${status}'`).join(', ');
  const conversationOf = '(SELECT conversation_key FROM inbound_events WHERE seq = ?)';
  return {
    // Window functions keep conversation_key inside SQL: it partitions the
    // persisted FIFO but is never returned.
    openInbounds: raw.prepare(`
      SELECT i.seq AS seq,
             i.processing_status AS processing_status,
             i.chat_jid AS chat_jid,
             unixepoch(i.received_at) AS received_unix,
             COUNT(*) OVER (PARTITION BY i.conversation_key) AS chat_depth,
             ROW_NUMBER() OVER (PARTITION BY i.conversation_key ORDER BY i.seq) AS chat_position,
             MIN(i.seq) OVER (PARTITION BY i.conversation_key) AS chat_head,
             COUNT(*) OVER () AS global_depth,
             ROW_NUMBER() OVER (ORDER BY i.seq) AS global_position,
             MIN(i.seq) OVER () AS global_head
      FROM inbound_events i
      WHERE i.processing_status IN (${openStatuses})
      ORDER BY i.seq ASC
    `),
    deferred: raw.prepare(`
      SELECT id, status, attempt_count, claim_epoch
      FROM deferred_turn_obligations
      WHERE inbound_seq = ? AND ${DEFERRED_TURN_NON_TERMINAL_STATUS_SQL}
      ORDER BY id DESC
      LIMIT 1
    `),
    recoveryJob: raw.prepare(`
      SELECT j.id, j.state, j.attempt_count, j.claim_epoch,
             j.assigned_owner_logical_turn_id, j.assigned_owner_generation,
             unixepoch(j.next_attempt_at) AS next_attempt_unix,
             unixepoch(j.claim_expires_at) AS claim_expires_unix,
             CASE WHEN ${validDeliveryCorroborationForJobSql('j')} THEN 1 ELSE 0 END AS corroborated
      FROM turn_recovery_jobs j
      WHERE j.source_inbound_seq = ?
      ORDER BY j.id DESC
      LIMIT 1
    `),
    // Mirrors the scope-blocking set TurnRecoveryStore uses for admission:
    // pending/claimed jobs without corroborated delivery.
    scopeRecovery: raw.prepare(`
      SELECT j.id, j.source_inbound_seq,
             j.assigned_owner_logical_turn_id, j.assigned_owner_generation
      FROM turn_recovery_jobs j
      WHERE j.state IN ('pending', 'claimed')
        AND NOT ${validDeliveryCorroborationForJobSql('j')}
        AND j.source_inbound_seq <> ?
        AND (? = 'global' OR j.conversation_key = ${conversationOf})
      ORDER BY j.id ASC
      LIMIT 1
    `),
    terminal: raw.prepare(`
      SELECT id, inbound_disposition, delivery_kind, logical_turn_id, generation,
             unixepoch(created_at) AS created_unix
      FROM turn_terminal_records
      WHERE inbound_seq_key = ?
      ORDER BY id DESC
      LIMIT 1
    `),
    lastOutbound: raw.prepare(`
      SELECT id, status, is_terminal, unixepoch(created_at) AS created_unix
      FROM outbound_ops
      WHERE source_inbound_seq = ?
      ORDER BY id DESC
      LIMIT 1
    `),
    lastChatTerminal: raw.prepare(`
      SELECT t.inbound_seq, t.inbound_disposition, t.delivery_kind,
             unixepoch(t.created_at) AS created_unix
      FROM turn_terminal_records t
      WHERE t.conversation_key = ${conversationOf}
      ORDER BY t.id DESC
      LIMIT 1
    `),
    checkpoint: raw.prepare(`
      SELECT session_status, active_turn_id, completed_inbound_seq,
             completed_logical_turn_id, completed_generation,
             unixepoch(updated_at) AS updated_unix
      FROM session_checkpoints
      WHERE conversation_key = ${conversationOf}
    `),
  };
}

export function readInboundOwnershipSnapshot(
  raw: DatabaseSync,
  options: InboundOwnershipSnapshotOptions,
): InboundOwnershipSnapshot {
  if (!Number.isFinite(options.minAgeMinutes) || options.minAgeMinutes < 0) {
    throw new RangeError('minAgeMinutes must be a finite number >= 0');
  }
  const queueScope = options.queueScope ?? 'per_chat';
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const supplied = options.providerExecution ?? null;
  const capturedAtMs = options.providerExecutionCapturedAtMs ?? null;
  const captureAgeSeconds = supplied !== null && capturedAtMs !== null && Number.isFinite(capturedAtMs)
    ? nowSeconds - Math.floor(capturedAtMs / 1000)
    : null;
  const captureFresh = captureAgeSeconds !== null
    && captureAgeSeconds <= PROVIDER_CAPTURE_MAX_AGE_SECONDS
    && captureAgeSeconds >= -PROVIDER_CAPTURE_MAX_FUTURE_SKEW_SECONDS;
  const captureStale = supplied !== null && !captureFresh;
  // A stale capture is kept out of every decision below, not just labelled.
  const provider = captureFresh ? supplied : null;
  const minAgeSeconds = options.minAgeMinutes * 60;
  const statements = prepareStatements(raw);
  const closer = new TerminalRecordInboundCloser(raw);

  const open = statements.openInbounds.all() as unknown as OpenInboundRow[];
  const openBySeq = new Map(open.map((row) => [row.seq, row]));

  const deferredOf = (seq: number): DeferredRow | undefined =>
    statements.deferred.get(seq) as DeferredRow | undefined;
  const recoveryOf = (seq: number): RecoveryJobRow | undefined =>
    statements.recoveryJob.get(seq) as RecoveryJobRow | undefined;
  const terminalOf = (seq: number): TerminalRow | undefined =>
    statements.terminal.get(seq) as TerminalRow | undefined;

  const queueOf = (row: OpenInboundRow) => queueScope === 'global'
    ? { depth: row.global_depth, position: row.global_position, head: row.global_head }
    : { depth: row.chat_depth, position: row.chat_position, head: row.chat_head };

  const providerEvidence = (scopeHash: string): ProviderExecutionEvidence => {
    if (captureStale) return 'stale';
    if (!provider) return 'not_supplied';
    if (!provider.active) return 'idle';
    // A probe hashes provider/model, not a chat: it never attributes a chat row.
    if (provider.activeWorkKind === 'probe') return 'active_probe';
    return provider.activeWorkKind === 'turn' && provider.activeScopeHash === scopeHash
      ? 'active_this_scope'
      : 'active_other_scope';
  };
  const oldestPendingIsThisScope = (scopeHash: string): boolean | null => provider
    ? provider.pending > 0
      && provider.oldestPendingWorkKind === 'turn'
      && provider.oldestPendingScopeHash === scopeHash
    : null;

  /** Ownership from evidence attached to this inbound alone (no FIFO inheritance). */
  const directOwnership = (seq: number): Ownership | null => {
    const deferred = deferredOf(seq);
    if (deferred) {
      return deferred.status === 'pending' && deferred.attempt_count >= DEFERRED_TURN_MAX_ATTEMPTS
        ? unowned('deferred_obligation_exhausted')
        : owned('deferred', 'deferred_obligation_open', {
          kind: 'deferred_obligation', deferredObligationId: deferred.id,
        });
    }
    const job = recoveryOf(seq);
    if (job) {
      if (job.corroborated === 1) return unowned('recovery_delivery_corroborated_inbound_open');
      const jobOwner = {
        kind: 'recovery_job' as const,
        recoveryJobId: job.id,
        logicalTurnId: safeIdentifier(job.assigned_owner_logical_turn_id),
        generation: job.assigned_owner_generation,
      };
      switch (job.state) {
        case 'pending':
          return owned('queued', 'recovery_job_pending', jobOwner);
        case 'claimed':
          return job.claim_expires_unix !== null && job.claim_expires_unix > nowSeconds
            ? owned('executing', 'recovery_job_claimed', jobOwner)
            : unowned('recovery_claim_expired');
        case 'blocked_unsafe':
          return unowned('recovery_job_blocked_unsafe');
        case 'exhausted':
          return unowned('recovery_job_exhausted');
        case 'completed':
          return unowned('recovery_job_completed_inbound_open');
        default:
          return unowned('no_attributable_owner');
      }
    }
    const terminal = terminalOf(seq);
    if (terminal) {
      return unowned(terminal.inbound_disposition === 'transferred_to_recovery_owner'
        ? 'transferred_without_recovery_job'
        : 'terminal_record_inbound_open');
    }
    return null;
  };

  const headOwnership = (row: OpenInboundRow): Ownership => {
    const direct = directOwnership(row.seq);
    if (direct) return direct;
    const scopeHash = shortHash(row.chat_jid);
    if (providerEvidence(scopeHash) === 'active_this_scope') {
      // The chat's persisted completed turn is at or past this row, so the turn
      // the lane holds for this chat cannot be this row's.
      const completed = statements.checkpoint.get(row.seq) as CheckpointRow | undefined;
      if (completed?.completed_inbound_seq != null && completed.completed_inbound_seq >= row.seq) {
        return unowned('provider_active_contradicts_completed_checkpoint');
      }
      return owned('executing', 'provider_execution_active', { kind: 'provider_execution' });
    }
    if (oldestPendingIsThisScope(scopeHash) === true) {
      return owned('queued', 'provider_execution_waiting', { kind: 'provider_execution_waiter' });
    }
    const scopeJob = statements.scopeRecovery.get(row.seq, queueScope, row.seq) as ScopeRecoveryRow | undefined;
    if (scopeJob) {
      return owned('queued', 'queued_behind_scope_recovery', {
        kind: 'scope_recovery_job',
        inboundSeq: scopeJob.source_inbound_seq,
        recoveryJobId: scopeJob.id,
        logicalTurnId: safeIdentifier(scopeJob.assigned_owner_logical_turn_id),
        generation: scopeJob.assigned_owner_generation,
      });
    }
    if (captureStale) return unowned('provider_capture_stale');
    return unowned(provider ? 'no_attributable_owner' : 'no_persisted_owner_provider_not_observed');
  };

  const headCache = new Map<number, Ownership>();
  const ownershipOf = (row: OpenInboundRow): Ownership => {
    const queue = queueOf(row);
    if (queue.head === row.seq) {
      let cached = headCache.get(row.seq);
      if (!cached) {
        cached = headOwnership(row);
        headCache.set(row.seq, cached);
      }
      return cached;
    }
    const direct = directOwnership(row.seq);
    if (direct) return direct;
    const headRow = openBySeq.get(queue.head)!;
    const head = ownershipOf(headRow);
    // Queued behind an unowned head is still queued, but inherits its health.
    return {
      classification: 'queued',
      reason: 'queued_behind_fifo_head',
      healthy: head.healthy,
      owner: {
        ...NO_OWNER,
        kind: 'fifo_head_inbound',
        inboundSeq: queue.head,
        logicalTurnId: head.owner.logicalTurnId,
        generation: head.owner.generation,
      },
    };
  };

  const rows: InboundOwnershipRow[] = [];
  let processing = 0;
  for (const row of open) {
    if (row.processing_status !== 'processing') continue;
    processing += 1;
    const ageSeconds = secondsSince(row.received_unix, nowSeconds);
    // An unparseable receipt time can never age out of the report.
    if (ageSeconds !== null && ageSeconds < minAgeSeconds) continue;

    const scopeHash = shortHash(row.chat_jid);
    const queue = queueOf(row);
    const ownership = ownershipOf(row);
    const evidence = providerEvidence(scopeHash);
    const activeProvider = provider !== null && provider.active;
    const deferred = deferredOf(row.seq);
    const job = recoveryOf(row.seq);
    const terminal = terminalOf(row.seq);
    const outbound = statements.lastOutbound.get(row.seq) as OutboundRow | undefined;
    const chatTerminal = statements.lastChatTerminal.get(row.seq) as ChatTerminalRow | undefined;
    const checkpoint = statements.checkpoint.get(row.seq) as CheckpointRow | undefined;
    let closeVerdict: string | null = null;
    if (terminal) {
      const evaluation = closer.evaluate(row.seq);
      closeVerdict = evaluation.verdict === 'refused' ? `refused:${evaluation.reason}` : evaluation.verdict;
    }

    rows.push({
      inboundSeq: row.seq,
      chatScopeHash: scopeHash,
      ageSeconds,
      ageEvidence: ageSeconds === null ? 'invalid_timestamp' : 'valid',
      classification: ownership.classification,
      healthy: ownership.healthy,
      reason: ownership.reason,
      owner: ownership.owner,
      queue: {
        basis: 'persisted_open_inbounds',
        scope: queueScope,
        depth: queue.depth,
        position: queue.position,
        headInboundSeq: queue.head,
      },
      providerExecution: {
        evidence,
        activePhase: activeProvider ? provider.activePhase : null,
        activeAgeMs: activeProvider ? provider.activeAgeMs : null,
        progressAgeMs: activeProvider ? provider.progressAgeMs : null,
        pending: provider ? provider.pending : null,
        oldestPendingIsThisScope: oldestPendingIsThisScope(scopeHash),
      },
      deferredObligation: deferred
        ? {
          id: deferred.id,
          status: deferred.status,
          attemptCount: deferred.attempt_count,
          claimEpoch: deferred.claim_epoch,
        }
        : null,
      recoveryJob: job
        ? {
          id: job.id,
          state: job.state,
          attemptCount: job.attempt_count,
          claimEpoch: job.claim_epoch,
          assignedOwnerLogicalTurnId: safeIdentifier(job.assigned_owner_logical_turn_id)!,
          assignedOwnerGeneration: job.assigned_owner_generation,
          nextAttemptInSeconds: secondsUntil(job.next_attempt_unix, nowSeconds),
          claimExpiresInSeconds: secondsUntil(job.claim_expires_unix, nowSeconds),
          deliveryCorroborated: job.corroborated === 1,
        }
        : null,
      terminalRecord: terminal
        ? {
          id: terminal.id,
          inboundDisposition: terminal.inbound_disposition,
          deliveryKind: terminal.delivery_kind,
          logicalTurnId: safeIdentifier(terminal.logical_turn_id)!,
          generation: terminal.generation,
          ageSeconds: secondsSince(terminal.created_unix, nowSeconds),
          closeVerdict: closeVerdict!,
        }
        : null,
      lastOutbound: outbound
        ? {
          id: outbound.id,
          status: outbound.status,
          isTerminal: outbound.is_terminal === 1,
          ageSeconds: secondsSince(outbound.created_unix, nowSeconds),
        }
        : null,
      lastChatTerminal: chatTerminal
        ? {
          inboundSeq: chatTerminal.inbound_seq,
          inboundDisposition: chatTerminal.inbound_disposition,
          deliveryKind: chatTerminal.delivery_kind,
          ageSeconds: secondsSince(chatTerminal.created_unix, nowSeconds),
        }
        : null,
      checkpoint: checkpoint
        ? {
          sessionStatus: checkpoint.session_status,
          activeTurnId: safeIdentifier(checkpoint.active_turn_id),
          completedInboundSeq: checkpoint.completed_inbound_seq,
          completedLogicalTurnId: safeIdentifier(checkpoint.completed_logical_turn_id),
          completedGeneration: checkpoint.completed_generation,
          updatedAgeSeconds: secondsSince(checkpoint.updated_unix, nowSeconds),
        }
        : null,
    });
  }

  const countOf = (classification: InboundOwnershipClass): number =>
    rows.filter((row) => row.classification === classification).length;
  return {
    schemaVersion: INBOUND_OWNERSHIP_SCHEMA_VERSION,
    minAgeMinutes: options.minAgeMinutes,
    queueScope,
    providerExecutionEvidence: captureStale ? 'stale' : provider ? 'supplied' : 'not_supplied',
    providerCaptureAgeSeconds: captureAgeSeconds,
    healthy: rows.every((row) => row.healthy),
    counts: {
      processing,
      reported: rows.length,
      queued: countOf('queued'),
      deferred: countOf('deferred'),
      executing: countOf('executing'),
      no_owner: countOf('no_owner'),
    },
    rows,
  };
}
