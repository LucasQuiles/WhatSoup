import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Database } from './database.ts';
import { TURN_RECOVERY_MAX_TEXT_BYTES } from './turn-recovery-contract.ts';

export const TURN_RECOVERY_MAX_ID_BYTES = 2048;
const TURN_RECOVERY_MAX_NAME_BYTES = 4096;
export const TURN_RECOVERY_MAX_ATTEMPTS = 5;
const TURN_RECOVERY_MAX_LEASE_SECONDS = 300;
const TURN_RECOVERY_MAX_BACKOFF_SECONDS = 3600;

export type TurnRecoveryJobState =
  | 'blocked_unsafe'
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'exhausted';

export interface TurnRecoveryJobPersistenceParams {
  scope: 'per_chat' | 'shared' | 'singleton';
  conversationKey: string;
  deliveryJid: string;
  sourceInboundSeq: number;
  sourceLogicalTurnId: string;
  sourceManagerId: string;
  sourceGeneration: number;
  sourceMessageId: string;
  ownerLogicalTurnId: string;
  ownerManagerId: string;
  ownerGeneration: number;
  replaySafe: boolean;
  senderJid: string;
  senderName: string | null;
  replayText: string;
  isGroup: boolean;
  groupName: string | null;
}

export interface TurnRecoveryOwnerIdentity {
  logicalTurnId: string;
  managerId: string;
  generation: number;
}

export interface TurnRecoverySourceIdentity {
  inboundSeq: number;
  logicalTurnId: string;
  generation: number;
}

export interface TurnRecoveryJobRow {
  id: number;
  terminal_record_id: number;
  scope: string;
  conversation_key: string;
  delivery_jid: string;
  source_inbound_seq: number;
  source_inbound_seq_key: number;
  source_logical_turn_id: string;
  source_manager_id: string;
  source_generation: number;
  source_message_id: string;
  owner_logical_turn_id: string;
  owner_manager_id: string;
  owner_generation: number;
  assigned_owner_logical_turn_id: string;
  assigned_owner_manager_id: string;
  assigned_owner_generation: number;
  replay_safe: number;
  replay_safety_proof_id: string | null;
  sender_jid: string;
  sender_name: string | null;
  replay_text: string;
  is_group: number;
  group_name: string | null;
  state: TurnRecoveryJobState;
  attempt_count: number;
  claim_epoch: number;
  assignment_epoch: number;
  claim_expires_at: string | null;
  next_attempt_at: string;
  duplicate_enqueue_count: number;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  completion_kind: 'worker' | 'echo' | null;
  completion_proof_id: string | null;
  echo_conflict_at: string | null;
  echo_conflict_reason: string | null;
}

export interface EnqueueTurnRecoveryJobResult {
  status: 'durably_queued' | 'durably_blocked';
  applied: boolean;
  jobId: number;
  state: TurnRecoveryJobState;
  duplicateEnqueueCount: number;
}

export interface TurnRecoveryJobTransitionResult {
  applied: boolean;
  jobId: number;
  state: TurnRecoveryJobState;
}

export interface EchoedTurnRecoverySettlementResult {
  matched: boolean;
  applied: boolean;
  jobId: number | null;
  state: TurnRecoveryJobState | null;
  conflict: boolean;
}

export interface TurnRecoveryClaimFence {
  claimToken: string;
  claimEpoch: number;
}

export interface TurnRecoveryAssignmentFence {
  claimEpoch: number;
  assignmentEpoch: number;
}

type InternalTurnRecoveryJobRow = TurnRecoveryJobRow & {
  claim_token: string | null;
  last_requeue_claim_token_hash: string | null;
  last_requeue_claim_epoch: number | null;
  last_requeue_backoff_seconds: number | null;
};

export interface ClaimTurnRecoveryJobOptions {
  claimToken: string;
  leaseSeconds: number;
}

export interface ClaimTurnRecoveryJobResult extends TurnRecoveryClaimFence {
  applied: boolean;
  jobId: number;
  state: 'claimed';
  attemptCount: number;
  claimExpiresAt: string;
}

export interface RequeueTurnRecoveryJobResult {
  applied: boolean;
  jobId: number;
  state: 'pending' | 'exhausted';
  attemptCount: number;
}

export interface ReassignTurnRecoveryJobResult {
  applied: boolean;
  jobId: number;
  assignedOwner: TurnRecoveryOwnerIdentity;
  assignmentEpoch: number;
}

export interface PromoteBlockedTurnRecoveryJobResult {
  applied: boolean;
  jobId: number;
  state: 'pending';
  idempotencyProofId: string;
  assignmentEpoch: number;
}

export interface RenewTurnRecoveryClaimResult {
  applied: true;
  jobId: number;
  claimEpoch: number;
  claimExpiresAt: string;
}

export interface TurnRecoveryEnumerationPage {
  jobs: TurnRecoveryJobRow[];
  nextCursor: number | null;
  /** True when this scan cycle reached the end; reset afterId to zero next cycle. */
  scanComplete: boolean;
}

export interface TurnRecoverySupervisorCounts {
  /** Admission-blocking active jobs plus orphan transfers. */
  outstanding: number;
  blockedUnsafe: number;
  pending: number;
  liveClaimed: number;
  expiredClaimed: number;
  exhausted: number;
  quarantinedDelivery: number;
  corruptLinks: number;
  orphanTransfers: number;
  echoConflicts: number;
  /** Pending operator catch-ups that lack an append-only closure link. */
  openRecoveries: number;
}

export function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

export function validateBoundedRequired(value: string, label: string, maxBytes: number): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be nonempty`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds its byte limit`);
  }
}

function validateOptionalBounded(
  value: string | null,
  label: string,
  maxBytes: number,
): void {
  if (value !== null) {
    if (typeof value !== 'string') throw new Error(`${label} must be a string or null`);
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new Error(`${label} exceeds its byte limit`);
    }
  }
}

function validateTurnRecoveryOwnerIdentity(owner: TurnRecoveryOwnerIdentity): void {
  validateBoundedRequired(
    owner.logicalTurnId,
    'Recovery owner logical turn ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateBoundedRequired(
    owner.managerId,
    'Recovery owner manager ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validatePositiveSafeInteger(owner.generation, 'Recovery owner generation');
}

function validateRecoveryClaimToken(token: string): void {
  validateBoundedRequired(token, 'Recovery claim token', TURN_RECOVERY_MAX_ID_BYTES);
}

function validateRecoveryLeaseSeconds(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > TURN_RECOVERY_MAX_LEASE_SECONDS) {
    throw new Error(`Recovery claim lease must be between 1 and ${TURN_RECOVERY_MAX_LEASE_SECONDS} seconds`);
  }
}

function validateRecoveryBackoffSeconds(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > TURN_RECOVERY_MAX_BACKOFF_SECONDS) {
    throw new Error(`Recovery backoff must be between 0 and ${TURN_RECOVERY_MAX_BACKOFF_SECONDS} seconds`);
  }
}

function validateRecoveryAssignmentFence(fence: TurnRecoveryAssignmentFence): void {
  if (!Number.isSafeInteger(fence.claimEpoch) || fence.claimEpoch < 0) {
    throw new Error('Expected recovery claim epoch must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(fence.assignmentEpoch) || fence.assignmentEpoch < 0) {
    throw new Error('Expected recovery assignment epoch must be a nonnegative safe integer');
  }
}

function recoveryClaimTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function recoveryTimeModifier(seconds: number): string {
  return `+${seconds} seconds`;
}

function recoveryReceiptStatus(
  row: Pick<TurnRecoveryJobRow, 'state'>,
): EnqueueTurnRecoveryJobResult['status'] {
  return row.state === 'blocked_unsafe' ? 'durably_blocked' : 'durably_queued';
}

function publicRecoveryJobRow(row: InternalTurnRecoveryJobRow): TurnRecoveryJobRow {
  const {
    claim_token: _claimToken,
    last_requeue_claim_token_hash: _lastRequeueClaimTokenHash,
    last_requeue_claim_epoch: _lastRequeueClaimEpoch,
    last_requeue_backoff_seconds: _lastRequeueBackoffSeconds,
    ...publicRow
  } = row;
  return publicRow;
}

function recoveryJobMatches(
  row: TurnRecoveryJobRow,
  params: TurnRecoveryJobPersistenceParams,
): boolean {
  return row.scope === params.scope &&
    row.conversation_key === params.conversationKey &&
    row.delivery_jid === params.deliveryJid &&
    row.source_inbound_seq === params.sourceInboundSeq &&
    row.source_logical_turn_id === params.sourceLogicalTurnId &&
    row.source_manager_id === params.sourceManagerId &&
    row.source_generation === params.sourceGeneration &&
    row.source_message_id === params.sourceMessageId &&
    row.owner_logical_turn_id === params.ownerLogicalTurnId &&
    row.owner_manager_id === params.ownerManagerId &&
    row.owner_generation === params.ownerGeneration &&
    row.replay_safe === (params.replaySafe ? 1 : 0) &&
    row.sender_jid === params.senderJid &&
    row.sender_name === params.senderName &&
    row.replay_text === params.replayText &&
    row.is_group === (params.isGroup ? 1 : 0) &&
    row.group_name === params.groupName;
}

export function validateTurnRecoveryJob(params: TurnRecoveryJobPersistenceParams): void {
  if (!['per_chat', 'shared', 'singleton'].includes(params.scope)) {
    throw new Error('Recovery job scope is invalid');
  }
  validateBoundedRequired(
    params.conversationKey,
    'Recovery conversation key',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateBoundedRequired(
    params.deliveryJid,
    'Recovery delivery JID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validatePositiveSafeInteger(params.sourceInboundSeq, 'Recovery source inbound sequence');
  validateBoundedRequired(
    params.sourceLogicalTurnId,
    'Recovery source logical turn ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateBoundedRequired(
    params.sourceManagerId,
    'Recovery source manager ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validatePositiveSafeInteger(params.sourceGeneration, 'Recovery source generation');
  validateBoundedRequired(
    params.sourceMessageId,
    'Recovery source message ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateBoundedRequired(
    params.ownerLogicalTurnId,
    'Recovery owner logical turn ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateBoundedRequired(
    params.ownerManagerId,
    'Recovery owner manager ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validatePositiveSafeInteger(params.ownerGeneration, 'Recovery owner generation');
  if (typeof params.replaySafe !== 'boolean') {
    throw new Error('Recovery jobs require an explicit replay-safety decision');
  }
  validateBoundedRequired(
    params.senderJid,
    'Recovery sender JID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateOptionalBounded(
    params.senderName,
    'Recovery sender name',
    TURN_RECOVERY_MAX_NAME_BYTES,
  );
  if (typeof params.replayText !== 'string') {
    throw new Error('Recovery replay text must be a string');
  }
  if (Buffer.byteLength(params.replayText, 'utf8') > TURN_RECOVERY_MAX_TEXT_BYTES) {
    throw new Error('Recovery replay text exceeds its byte limit');
  }
  if (params.replayText.trim() === '') {
    throw new Error('Recovery jobs require nonempty replay text');
  }
  validateOptionalBounded(
    params.groupName,
    'Recovery group name',
    TURN_RECOVERY_MAX_NAME_BYTES,
  );
  if (typeof params.isGroup !== 'boolean') {
    throw new Error('Recovery group flag must be a boolean');
  }
  if (!params.isGroup && params.groupName !== null) {
    throw new Error('A direct-message recovery job cannot carry a group name');
  }
}

type PreparedStatement = ReturnType<Database['raw']['prepare']>;

const VALID_RECOVERY_JOB_FROM = `
  FROM turn_recovery_jobs j
  JOIN turn_terminal_records t
    ON t.id = j.terminal_record_id
   AND t.inbound_disposition = 'transferred_to_recovery_owner'
   AND t.scope = j.scope
   AND t.inbound_seq = j.source_inbound_seq
   AND t.logical_turn_id = j.source_logical_turn_id
   AND t.manager_id = j.source_manager_id
   AND t.generation = j.source_generation
   AND t.conversation_key = j.conversation_key
   AND t.delivery_jid = j.delivery_jid
   AND t.recovery_owner_logical_turn_id = j.owner_logical_turn_id
   AND t.recovery_owner_manager_id = j.owner_manager_id
   AND t.recovery_owner_generation = j.owner_generation
   AND t.delivery_kind IN ('enqueued', 'flushed', 'delivery_unknown')
  JOIN inbound_events i
    ON i.seq = j.source_inbound_seq
   AND i.message_id = j.source_message_id
   AND i.conversation_key = j.conversation_key
   AND i.chat_jid = j.delivery_jid
  JOIN outbound_ops o
    ON o.id = t.delivery_op_id
   AND o.source_inbound_seq = j.source_inbound_seq
   AND o.conversation_key = j.conversation_key
   AND o.chat_jid = j.delivery_jid
`;

type TurnRecoveryStatements = {
  enqueueTurnRecoveryJob: PreparedStatement;
  getTurnRecoveryJob: PreparedStatement;
  getTurnRecoveryJobBySource: PreparedStatement;
  incrementDuplicateTurnRecoveryJob: PreparedStatement;
  claimTurnRecoveryJob: PreparedStatement;
  renewTurnRecoveryClaim: PreparedStatement;
  completeTurnRecoveryJob: PreparedStatement;
  getTurnRecoverySourceInboundStatus: PreparedStatement;
  getTurnRecoveryOriginalDeliveryStatus: PreparedStatement;
  getEchoedTurnRecoverySettlement: PreparedStatement;
  completeEchoedTurnRecoveryInbound: PreparedStatement;
  completeEchoedTurnRecoveryJob: PreparedStatement;
  recordEchoedTurnRecoveryConflict: PreparedStatement;
  getUnsettledEchoedTurnRecoveryOps: PreparedStatement;
  requeueTurnRecoveryJob: PreparedStatement;
  reassignTurnRecoveryJob: PreparedStatement;
  reassignBlockedTurnRecoveryJob: PreparedStatement;
  promoteBlockedTurnRecoveryJob: PreparedStatement;
  getStaleTurnRecoveryJobs: PreparedStatement;
  requeueStaleTurnRecoveryJob: PreparedStatement;
  exhaustStaleTurnRecoveryJob: PreparedStatement;
  reclaimDeadDeliveryRecoveryJob: PreparedStatement;
  getRecoverableTurnRecoveryJobs: PreparedStatement;
  getOutstandingTurnRecoveryJobsForSupervisor: PreparedStatement;
  getTurnRecoverySupervisorCounts: PreparedStatement;
  hasOutstandingTurnRecoveryForScope: PreparedStatement;
};

export class TurnRecoveryStore {
  private readonly db: Database;
  private readonly now: () => string;
  private readonly statements: TurnRecoveryStatements;

  constructor(db: Database, now: () => string) {
    this.db = db;
    this.now = now;
    const prepare = db.raw.prepare.bind(db.raw);
    this.statements = {
      enqueueTurnRecoveryJob: prepare(`
        INSERT INTO turn_recovery_jobs (
          terminal_record_id, scope, conversation_key, delivery_jid,
          source_inbound_seq, source_inbound_seq_key,
          source_logical_turn_id, source_manager_id, source_generation, source_message_id,
          owner_logical_turn_id, owner_manager_id, owner_generation,
          assigned_owner_logical_turn_id, assigned_owner_manager_id,
          assigned_owner_generation,
          replay_safe, sender_jid, sender_name, replay_text, is_group, group_name,
          state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id, state, duplicate_enqueue_count
      `),
      getTurnRecoveryJob: prepare(`
        SELECT j.* ${VALID_RECOVERY_JOB_FROM}
        WHERE j.id = ?
      `),
      getTurnRecoveryJobBySource: prepare(`
        SELECT j.* ${VALID_RECOVERY_JOB_FROM}
        WHERE j.source_inbound_seq_key = ?
          AND j.source_logical_turn_id = ?
          AND j.source_generation = ?
      `),
      incrementDuplicateTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET duplicate_enqueue_count = duplicate_enqueue_count + 1,
            updated_at = datetime('now')
        WHERE id = ?
        RETURNING state, duplicate_enqueue_count
      `),
      claimTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET state = 'claimed',
            attempt_count = attempt_count + 1,
            claim_epoch = claim_epoch + 1,
            claim_token = ?,
            claimed_at = datetime('now'),
            claim_expires_at = datetime('now', ?),
            last_requeue_claim_token_hash = NULL,
            last_requeue_claim_epoch = NULL,
            last_requeue_backoff_seconds = NULL,
            updated_at = datetime('now')
        WHERE id = ?
          AND assigned_owner_logical_turn_id = ?
          AND assigned_owner_manager_id = ?
          AND assigned_owner_generation = ?
          AND state = 'pending'
          AND attempt_count < ${TURN_RECOVERY_MAX_ATTEMPTS}
          AND next_attempt_at <= datetime('now')
        RETURNING *
      `),
      renewTurnRecoveryClaim: prepare(`
        UPDATE turn_recovery_jobs
        SET claim_expires_at = datetime('now', ?),
            updated_at = datetime('now')
        WHERE id = ?
          AND assigned_owner_logical_turn_id = ?
          AND assigned_owner_manager_id = ?
          AND assigned_owner_generation = ?
          AND state = 'claimed'
          AND claim_token = ?
          AND claim_epoch = ?
          AND claim_expires_at > datetime('now')
        RETURNING claim_expires_at
      `),
      completeTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET state = 'completed',
            completed_at = datetime('now'),
            completion_kind = 'worker',
            completion_proof_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND assigned_owner_logical_turn_id = ?
          AND assigned_owner_manager_id = ?
          AND assigned_owner_generation = ?
          AND state = 'claimed'
          AND claim_token = ?
          AND claim_epoch = ?
          AND claim_expires_at > datetime('now')
          AND EXISTS (
            SELECT 1 FROM inbound_events i
            WHERE i.seq = turn_recovery_jobs.source_inbound_seq
              AND i.processing_status IN ('complete', 'failed')
          )
          AND EXISTS (
            SELECT 1
            FROM turn_terminal_records t
            JOIN outbound_ops o ON o.id = t.delivery_op_id
            WHERE t.id = turn_recovery_jobs.terminal_record_id
              AND t.inbound_disposition = 'transferred_to_recovery_owner'
              AND t.scope = turn_recovery_jobs.scope
              AND t.inbound_seq = turn_recovery_jobs.source_inbound_seq
              AND t.conversation_key = turn_recovery_jobs.conversation_key
              AND t.delivery_jid = turn_recovery_jobs.delivery_jid
              AND o.source_inbound_seq = turn_recovery_jobs.source_inbound_seq
              AND o.conversation_key = turn_recovery_jobs.conversation_key
              AND o.chat_jid = turn_recovery_jobs.delivery_jid
              AND o.status IN ('echoed', 'failed_permanent', 'quarantined')
          )
        RETURNING *
      `),
      getTurnRecoverySourceInboundStatus: prepare(`
        SELECT i.processing_status, o.status AS outbound_status
        ${VALID_RECOVERY_JOB_FROM}
        WHERE j.id = ?
          AND j.claim_expires_at > datetime('now')
      `),
      // Same join, no claim-liveness filter: callable BEFORE a claim exists,
      // so the supervisor can skip claiming a job whose original selected
      // delivery is still ambiguous (maybe_sent) rather than claim, replay,
      // and then fail completeTurnRecoveryJob's own terminal-status gate
      // after a real send already went out (the duplicate-output risk).
      getTurnRecoveryOriginalDeliveryStatus: prepare(`
        SELECT o.status AS outbound_status
        ${VALID_RECOVERY_JOB_FROM}
        WHERE j.id = ?
      `),
      getEchoedTurnRecoverySettlement: prepare(`
        SELECT j.id AS job_id, j.state, i.seq AS inbound_seq,
               i.processing_status, i.terminal_reason,
               o.status AS outbound_status
        ${VALID_RECOVERY_JOB_FROM}
        WHERE o.id = ?
      `),
      completeEchoedTurnRecoveryInbound: prepare(`
        UPDATE inbound_events
        SET processing_status = 'complete',
            completed_at = COALESCE(completed_at, datetime('now')),
            terminal_reason = 'response_echoed'
        WHERE seq = ? AND processing_status IN ('processing', 'turn_done')
      `),
      completeEchoedTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET state = 'completed',
            completed_at = COALESCE(completed_at, datetime('now')),
            updated_at = datetime('now'),
            attempt_count = CASE WHEN attempt_count = 0 THEN 1 ELSE attempt_count END,
            claim_epoch = CASE WHEN attempt_count = 0 THEN 1 ELSE attempt_count END,
            claim_token = ?,
            claimed_at = COALESCE(claimed_at, datetime('now')),
            claim_expires_at = datetime('now', '+300 seconds'),
            last_requeue_claim_token_hash = NULL,
            last_requeue_claim_epoch = NULL,
            last_requeue_backoff_seconds = NULL,
            replay_safety_proof_id = CASE
              WHEN replay_safe = 0 THEN COALESCE(replay_safety_proof_id, ?)
              ELSE replay_safety_proof_id
            END,
            completion_kind = 'echo',
            completion_proof_id = ?
        WHERE id = ? AND state <> 'completed'
      `),
      recordEchoedTurnRecoveryConflict: prepare(`
        UPDATE turn_recovery_jobs
        SET echo_conflict_at = COALESCE(echo_conflict_at, datetime('now')),
            echo_conflict_reason = COALESCE(echo_conflict_reason, ?),
            updated_at = datetime('now')
        WHERE id = ?
      `),
      getUnsettledEchoedTurnRecoveryOps: prepare(`
        SELECT o.id
        ${VALID_RECOVERY_JOB_FROM}
        WHERE o.status = 'echoed'
          AND (
            j.state <> 'completed'
            OR i.processing_status <> 'complete'
            OR i.terminal_reason <> 'response_echoed'
          )
          AND j.echo_conflict_at IS NULL
        ORDER BY o.id
        LIMIT ?
      `),
      requeueTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET state = CASE
              WHEN attempt_count >= ${TURN_RECOVERY_MAX_ATTEMPTS} THEN 'exhausted'
              ELSE 'pending'
            END,
            claim_token = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            last_requeue_claim_token_hash = ?,
            last_requeue_claim_epoch = claim_epoch,
            last_requeue_backoff_seconds = ?,
            next_attempt_at = CASE
              WHEN attempt_count >= ${TURN_RECOVERY_MAX_ATTEMPTS} THEN datetime('now')
              ELSE datetime('now', ?)
            END,
            updated_at = datetime('now')
        WHERE id = ?
          AND assigned_owner_logical_turn_id = ?
          AND assigned_owner_manager_id = ?
          AND assigned_owner_generation = ?
          AND state = 'claimed'
          AND claim_token = ?
          AND claim_epoch = ?
          AND claim_expires_at > datetime('now')
        RETURNING *
      `),
      reassignTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET assigned_owner_logical_turn_id = ?,
            assigned_owner_manager_id = ?,
            assigned_owner_generation = ?,
            assignment_epoch = assignment_epoch + 1,
            updated_at = datetime('now')
        WHERE id = ?
          AND assigned_owner_logical_turn_id = ?
          AND assigned_owner_manager_id = ?
          AND assigned_owner_generation = ?
          AND state = 'pending'
          AND claim_token IS NULL
          AND claim_epoch = ?
          AND assignment_epoch = ?
        RETURNING *
      `),
      reassignBlockedTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET assigned_owner_logical_turn_id = ?,
            assigned_owner_manager_id = ?,
            assigned_owner_generation = ?,
            assignment_epoch = assignment_epoch + 1,
            updated_at = datetime('now')
        WHERE id = ?
          AND assigned_owner_logical_turn_id = ?
          AND assigned_owner_manager_id = ?
          AND assigned_owner_generation = ?
          AND state = 'blocked_unsafe'
          AND replay_safe = 0
          AND replay_safety_proof_id IS NULL
          AND claim_token IS NULL
          AND claim_epoch = ?
          AND assignment_epoch = ?
        RETURNING *
      `),
      promoteBlockedTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET state = 'pending',
            replay_safety_proof_id = ?,
            next_attempt_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
          AND assigned_owner_logical_turn_id = ?
          AND assigned_owner_manager_id = ?
          AND assigned_owner_generation = ?
          AND state = 'blocked_unsafe'
          AND replay_safe = 0
          AND replay_safety_proof_id IS NULL
          AND attempt_count = 0
          AND claim_token IS NULL
          AND claim_epoch = ?
          AND assignment_epoch = ?
        RETURNING *
      `),
      getStaleTurnRecoveryJobs: prepare(`
        SELECT j.* ${VALID_RECOVERY_JOB_FROM}
        WHERE j.state = 'claimed'
          AND j.claim_expires_at <= datetime('now')
        ORDER BY j.id ASC
        LIMIT ?
      `),
      requeueStaleTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET state = 'pending',
            claim_token = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            last_requeue_claim_token_hash = ?,
            last_requeue_claim_epoch = claim_epoch,
            last_requeue_backoff_seconds = 0,
            next_attempt_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
          AND state = 'claimed'
          AND claim_token = ?
          AND claim_epoch = ?
          AND attempt_count < ${TURN_RECOVERY_MAX_ATTEMPTS}
      `),
      exhaustStaleTurnRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET state = 'exhausted',
            claim_token = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            last_requeue_claim_token_hash = ?,
            last_requeue_claim_epoch = claim_epoch,
            last_requeue_backoff_seconds = 0,
            next_attempt_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
          AND state = 'claimed'
          AND claim_token = ?
          AND claim_epoch = ?
          AND attempt_count >= ${TURN_RECOVERY_MAX_ATTEMPTS}
      `),
      // #1749: bounded reclaim for the recovery-owner trap. When the selected
      // delivery is provably dead (failed_permanent/quarantined) it can never
      // echo-settle, so an open recovery job would pin admission forever. The
      // stuck-inbound sweep drives such a pending/claimed job to the existing
      // terminal `exhausted` state so it no longer counts toward admission. The
      // schema requires attempt_count = 5 for `exhausted`; a reclaim is still
      // distinguishable from genuine attempt exhaustion by its selected op's
      // terminal non-echoed status. This mutates only claim/attempt/state fields
      // (the immutable-envelope and assignment-epoch triggers guard other
      // columns) and clears the requeue receipt so the coherence CHECK holds.
      reclaimDeadDeliveryRecoveryJob: prepare(`
        UPDATE turn_recovery_jobs
        SET state = 'exhausted',
            attempt_count = 5,
            claim_epoch = 5,
            claim_token = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            last_requeue_claim_token_hash = NULL,
            last_requeue_claim_epoch = NULL,
            last_requeue_backoff_seconds = NULL,
            next_attempt_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
          AND state IN ('pending', 'claimed')
      `),
      getRecoverableTurnRecoveryJobs: prepare(`
        SELECT j.* ${VALID_RECOVERY_JOB_FROM}
        WHERE j.assigned_owner_logical_turn_id = ?
          AND j.assigned_owner_manager_id = ?
          AND j.assigned_owner_generation = ?
          AND j.id > ?
          AND (
            j.state = 'pending'
            OR j.state = 'claimed'
          )
        ORDER BY j.id ASC
        LIMIT ?
      `),
      getOutstandingTurnRecoveryJobsForSupervisor: prepare(`
        SELECT j.* ${VALID_RECOVERY_JOB_FROM}
        WHERE j.id > ?
          AND (
            j.state = 'blocked_unsafe'
            OR
            j.state = 'pending'
            OR j.state = 'exhausted'
            OR (j.state = 'claimed' AND j.claim_expires_at <= datetime('now'))
          )
        ORDER BY j.id ASC
        LIMIT ?
      `),
      getTurnRecoverySupervisorCounts: prepare(`
        WITH orphan_transfers AS (
          SELECT COUNT(*) AS count
          FROM turn_terminal_records terminal
          LEFT JOIN turn_recovery_jobs linked
            ON linked.terminal_record_id = terminal.id
          WHERE terminal.inbound_disposition = 'transferred_to_recovery_owner'
            AND linked.id IS NULL
        ),
        open_recoveries AS (
          SELECT COUNT(*) AS count
          FROM inbound_disposition_links pending
          WHERE pending.disposition = 'recovery_pending_operator_catchup'
            AND NOT EXISTS (
              SELECT 1
              FROM inbound_disposition_links closure
              WHERE closure.inbound_seq = pending.inbound_seq
                AND closure.recovery_plan_id = pending.recovery_plan_id
                AND closure.disposition = 'superseded_by_operator_catchup'
            )
        )
        SELECT
          COALESCE(SUM(CASE WHEN j.state IN ('pending', 'claimed') THEN 1 ELSE 0 END), 0)
            + (SELECT count FROM orphan_transfers)
            AS outstanding,
          COALESCE(SUM(CASE WHEN j.state = 'blocked_unsafe' THEN 1 ELSE 0 END), 0)
            AS blocked_unsafe,
          COALESCE(SUM(CASE WHEN j.state = 'pending' THEN 1 ELSE 0 END), 0)
            AS pending,
          COALESCE(SUM(CASE
            WHEN j.state = 'claimed' AND j.claim_expires_at > datetime('now') THEN 1
            ELSE 0
          END), 0) AS live_claimed,
          COALESCE(SUM(CASE
            WHEN j.state = 'claimed' AND j.claim_expires_at <= datetime('now') THEN 1
            ELSE 0
          END), 0) AS expired_claimed,
          COALESCE(SUM(CASE WHEN j.state = 'exhausted' THEN 1 ELSE 0 END), 0)
            AS exhausted,
          COALESCE(SUM(CASE
            WHEN j.state <> 'completed' AND o.status = 'quarantined' THEN 1
            ELSE 0
          END), 0) AS quarantined_delivery,
          COALESCE(SUM(CASE
            WHEN NOT (
              t.id IS NOT NULL
              AND t.inbound_disposition = 'transferred_to_recovery_owner'
              AND t.scope = j.scope
              AND t.inbound_seq_key = j.source_inbound_seq_key
              AND t.inbound_seq = j.source_inbound_seq
              AND t.logical_turn_id = j.source_logical_turn_id
              AND t.manager_id = j.source_manager_id
              AND t.generation = j.source_generation
              AND t.conversation_key = j.conversation_key
              AND t.delivery_jid = j.delivery_jid
              AND t.recovery_owner_logical_turn_id = j.owner_logical_turn_id
              AND t.recovery_owner_manager_id = j.owner_manager_id
              AND t.recovery_owner_generation = j.owner_generation
              AND t.delivery_kind IN ('enqueued', 'flushed', 'delivery_unknown')
              AND i.seq IS NOT NULL
              AND i.message_id = j.source_message_id
              AND i.conversation_key = j.conversation_key
              AND i.chat_jid = j.delivery_jid
              AND o.id IS NOT NULL
              AND o.conversation_key = j.conversation_key
              AND o.chat_jid = j.delivery_jid
              AND o.source_inbound_seq = j.source_inbound_seq
            ) THEN 1 ELSE 0
          END), 0) + (SELECT count FROM orphan_transfers) AS corrupt_links,
          (SELECT count FROM orphan_transfers) AS orphan_transfers,
          COALESCE(SUM(CASE WHEN j.echo_conflict_at IS NOT NULL THEN 1 ELSE 0 END), 0)
            AS echo_conflicts,
          (SELECT count FROM open_recoveries) AS open_recoveries
        FROM turn_recovery_jobs j
        LEFT JOIN turn_terminal_records t ON t.id = j.terminal_record_id
        LEFT JOIN inbound_events i ON i.seq = j.source_inbound_seq
        LEFT JOIN outbound_ops o ON o.id = t.delivery_op_id
      `),
      // job_id is carried through both arms (NULL in the second: a terminal
      // record not yet promoted to a job row can never BE the excluded job)
      // so the exclusion is one uniform outer-query predicate instead of two
      // arm-specific ones — a job actively claimed by the caller's own
      // supervisor replay must not block that replay's own admission check.
      hasOutstandingTurnRecoveryForScope: prepare(`
        SELECT 1 AS found
        FROM (
          SELECT j.scope, j.conversation_key, j.id AS job_id
          FROM turn_recovery_jobs j
          WHERE j.state IN ('pending', 'claimed')
          UNION ALL
          SELECT t.scope, t.conversation_key, j.id AS job_id
          FROM turn_terminal_records t
          LEFT JOIN turn_recovery_jobs j ON j.terminal_record_id = t.id
          WHERE t.inbound_disposition = 'transferred_to_recovery_owner'
            AND j.id IS NULL
        ) outstanding
        WHERE outstanding.scope = ?
          AND (outstanding.scope <> 'per_chat' OR outstanding.conversation_key = ?)
          AND (? IS NULL OR outstanding.job_id IS NULL OR outstanding.job_id != ?)
        LIMIT 1
      `),
    };
  }

  insertLinkedWithinCallerTransaction(
    terminalRecordId: number,
    params: TurnRecoveryJobPersistenceParams,
  ): EnqueueTurnRecoveryJobResult {
    validateTurnRecoveryJob(params);
    const row = this.statements.enqueueTurnRecoveryJob.get(
      terminalRecordId,
      params.scope,
      params.conversationKey,
      params.deliveryJid,
      params.sourceInboundSeq,
      params.sourceInboundSeq,
      params.sourceLogicalTurnId,
      params.sourceManagerId,
      params.sourceGeneration,
      params.sourceMessageId,
      params.ownerLogicalTurnId,
      params.ownerManagerId,
      params.ownerGeneration,
      params.ownerLogicalTurnId,
      params.ownerManagerId,
      params.ownerGeneration,
      params.replaySafe ? 1 : 0,
      params.senderJid,
      params.senderName,
      params.replayText,
      params.isGroup ? 1 : 0,
      params.groupName,
      params.replaySafe ? 'pending' : 'blocked_unsafe',
    ) as {
      id: number;
      state: TurnRecoveryJobState;
      duplicate_enqueue_count: number;
    } | undefined;
    if (!row) {
      throw new Error('Recovery source identity already has a different payload or owner');
    }
    return {
      status: recoveryReceiptStatus(row),
      applied: row.duplicate_enqueue_count === 0,
      jobId: row.id,
      state: row.state,
      duplicateEnqueueCount: row.duplicate_enqueue_count,
    };
  }

  findExactLinkedReceipt(
    terminalRecordId: number,
    params: TurnRecoveryJobPersistenceParams,
  ): EnqueueTurnRecoveryJobResult | undefined {
    const linked = this.getTurnRecoveryJobBySource({
      inboundSeq: params.sourceInboundSeq,
      logicalTurnId: params.sourceLogicalTurnId,
      generation: params.sourceGeneration,
    });
    if (
      linked === undefined ||
      linked.terminal_record_id !== terminalRecordId ||
      !recoveryJobMatches(linked, params)
    ) {
      return undefined;
    }
    const counted = this.statements.incrementDuplicateTurnRecoveryJob.get(linked.id) as {
      state: TurnRecoveryJobState;
      duplicate_enqueue_count: number;
    } | undefined;
    if (!counted) {
      throw new Error(`Recovery job ${linked.id} disappeared while recording a duplicate enqueue`);
    }
    return {
      status: recoveryReceiptStatus(counted),
      applied: false,
      jobId: linked.id,
      state: counted.state,
      duplicateEnqueueCount: counted.duplicate_enqueue_count,
    };
  }

  getTurnRecoveryJob(jobId: number): TurnRecoveryJobRow | undefined {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    const row = this.statements.getTurnRecoveryJob.get(jobId) as
      InternalTurnRecoveryJobRow | undefined;
    return row ? publicRecoveryJobRow(row) : undefined;
  }

  private getInternalTurnRecoveryJob(jobId: number): InternalTurnRecoveryJobRow | undefined {
    return this.statements.getTurnRecoveryJob.get(jobId) as
      InternalTurnRecoveryJobRow | undefined;
  }

  getTurnRecoveryJobBySource(
    source: TurnRecoverySourceIdentity,
  ): TurnRecoveryJobRow | undefined {
    // This key deliberately mirrors turn_terminal_records' CAS identity.
    // source_manager_id is still immutable provenance: enqueue conflict
    // matching rejects a different manager instead of manufacturing a second
    // recovery job for the same terminal winner.
    validatePositiveSafeInteger(source.inboundSeq, 'Recovery source inbound sequence');
    validateBoundedRequired(
      source.logicalTurnId,
      'Recovery source logical turn ID',
      TURN_RECOVERY_MAX_ID_BYTES,
    );
    validatePositiveSafeInteger(source.generation, 'Recovery source generation');
    const row = this.statements.getTurnRecoveryJobBySource.get(
      source.inboundSeq,
      source.logicalTurnId,
      source.generation,
    ) as InternalTurnRecoveryJobRow | undefined;
    return row ? publicRecoveryJobRow(row) : undefined;
  }

  private getOwnedTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
  ): InternalTurnRecoveryJobRow {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    validateTurnRecoveryOwnerIdentity(owner);
    const row = this.getInternalTurnRecoveryJob(jobId);
    if (!row) throw new Error('Recovery job does not exist');
    if (
      row.assigned_owner_logical_turn_id !== owner.logicalTurnId ||
      row.assigned_owner_manager_id !== owner.managerId ||
      row.assigned_owner_generation !== owner.generation
    ) {
      throw new Error('Recovery job may only be changed by its assigned recovery owner');
    }
    return row;
  }

  claimTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    options: ClaimTurnRecoveryJobOptions,
  ): ClaimTurnRecoveryJobResult {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    validateTurnRecoveryOwnerIdentity(owner);
    validateRecoveryClaimToken(options.claimToken);
    validateRecoveryLeaseSeconds(options.leaseSeconds);
    const before = this.getOwnedTurnRecoveryJob(jobId, owner);
    if (before.state === 'blocked_unsafe') {
      throw new Error('Recovery job is blocked unsafe pending an idempotency proof');
    }
    if (before.state === 'claimed') {
      if (before.claim_token !== options.claimToken) {
        throw new Error('Recovery job is already claimed by another claim token');
      }
      if (!this.isRecoveryClaimUnexpired(before)) {
        throw new Error('Recovery job claim lease has expired');
      }
      return {
        applied: false,
        jobId,
        state: 'claimed',
        claimToken: options.claimToken,
        claimEpoch: before.claim_epoch,
        attemptCount: before.attempt_count,
        claimExpiresAt: before.claim_expires_at!,
      };
    }
    if (before.state === 'completed') throw new Error('Recovery job is already completed');
    if (before.state === 'exhausted') throw new Error('Recovery job attempts are exhausted');
    const row = this.statements.claimTurnRecoveryJob.get(
      options.claimToken,
      recoveryTimeModifier(options.leaseSeconds),
      jobId,
      owner.logicalTurnId,
      owner.managerId,
      owner.generation,
    ) as InternalTurnRecoveryJobRow | undefined;
    if (row) {
      return {
        applied: true,
        jobId: row.id,
        state: 'claimed',
        claimToken: options.claimToken,
        claimEpoch: row.claim_epoch,
        attemptCount: row.attempt_count,
        claimExpiresAt: row.claim_expires_at!,
      };
    }

    const current = this.getOwnedTurnRecoveryJob(jobId, owner);
    if (current.state === 'claimed') {
      if (current.claim_token !== options.claimToken) {
        throw new Error('Recovery job is already claimed by another claim token');
      }
      if (!this.isRecoveryClaimUnexpired(current)) {
        throw new Error('Recovery job claim lease has expired');
      }
      return {
        applied: false,
        jobId,
        state: 'claimed',
        claimToken: options.claimToken,
        claimEpoch: current.claim_epoch,
        attemptCount: current.attempt_count,
        claimExpiresAt: current.claim_expires_at!,
      };
    }
    if (current.state === 'exhausted') throw new Error('Recovery job attempts are exhausted');
    if (current.state === 'blocked_unsafe') {
      throw new Error('Recovery job is blocked unsafe pending an idempotency proof');
    }
    if (current.state === 'pending') throw new Error('Recovery job is still in backoff');
    throw new Error('Recovery job cannot be claimed');
  }

  private isRecoveryClaimUnexpired(row: InternalTurnRecoveryJobRow): boolean {
    if (row.claim_expires_at === null) return false;
    return row.claim_expires_at > this.now();
  }

  renewTurnRecoveryClaim(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
    options: { leaseSeconds: number },
  ): RenewTurnRecoveryClaimResult {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    validateTurnRecoveryOwnerIdentity(owner);
    validateRecoveryClaimToken(fence.claimToken);
    validatePositiveSafeInteger(fence.claimEpoch, 'Recovery claim epoch');
    validateRecoveryLeaseSeconds(options.leaseSeconds);
    this.getOwnedTurnRecoveryJob(jobId, owner);
    const row = this.statements.renewTurnRecoveryClaim.get(
      recoveryTimeModifier(options.leaseSeconds),
      jobId,
      owner.logicalTurnId,
      owner.managerId,
      owner.generation,
      fence.claimToken,
      fence.claimEpoch,
    ) as { claim_expires_at: string } | undefined;
    if (!row) throw new Error('Recovery claim fence is stale or expired');
    return {
      applied: true,
      jobId,
      claimEpoch: fence.claimEpoch,
      claimExpiresAt: row.claim_expires_at,
    };
  }

  completeTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
  ): TurnRecoveryJobTransitionResult {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    validateTurnRecoveryOwnerIdentity(owner);
    validateRecoveryClaimToken(fence.claimToken);
    validatePositiveSafeInteger(fence.claimEpoch, 'Recovery claim epoch');
    this.getOwnedTurnRecoveryJob(jobId, owner);
    const row = this.statements.completeTurnRecoveryJob.get(
      `worker-claim:${jobId}:${fence.claimEpoch}`,
      jobId,
      owner.logicalTurnId,
      owner.managerId,
      owner.generation,
      fence.claimToken,
      fence.claimEpoch,
    ) as InternalTurnRecoveryJobRow | undefined;
    if (row) return { applied: true, jobId: row.id, state: row.state };

    const current = this.getOwnedTurnRecoveryJob(jobId, owner);
    if (
      current.state === 'completed' &&
      current.claim_token === fence.claimToken &&
      current.claim_epoch === fence.claimEpoch
    ) {
      return { applied: false, jobId, state: 'completed' };
    }
    if (
      current.state === 'claimed' &&
      current.claim_token === fence.claimToken &&
      current.claim_epoch === fence.claimEpoch
    ) {
      const source = this.statements.getTurnRecoverySourceInboundStatus.get(jobId) as
        { processing_status: string; outbound_status: string } | undefined;
      if (source && !['complete', 'failed'].includes(source.processing_status)) {
        throw new Error('Recovery source inbound must be terminal before job completion');
      }
      if (
        source &&
        !['echoed', 'failed_permanent', 'quarantined'].includes(source.outbound_status)
      ) {
        throw new Error('Recovery selected delivery must have a terminal outcome before completion');
      }
    }
    throw new Error('Recovery claim fence does not match the current owner claim');
  }

  /** Transaction-neutral: the caller owns the outbound-echo transaction. */
  settleEchoedTurnRecoveryJobWithinCallerTransaction(
    outboundOpId: number,
  ): EchoedTurnRecoverySettlementResult {
    validatePositiveSafeInteger(outboundOpId, 'Recovery outbound op ID');
    const match = this.statements.getEchoedTurnRecoverySettlement.get(outboundOpId) as
      | {
          job_id: number;
          state: TurnRecoveryJobState;
          inbound_seq: number;
          processing_status: string;
          terminal_reason: string | null;
          outbound_status: string;
        }
      | undefined;
    if (!match) {
      return { matched: false, applied: false, jobId: null, state: null, conflict: false };
    }
    if (match.outbound_status !== 'echoed') {
      throw new Error('Recovery delivery must be echoed before settlement');
    }
    if (match.state === 'completed') {
      if (
        match.processing_status !== 'complete' ||
        match.terminal_reason !== 'response_echoed'
      ) {
        this.statements.recordEchoedTurnRecoveryConflict.run(
          'completed_job_source_conflict',
          match.job_id,
        );
        return {
          matched: true,
          applied: false,
          jobId: match.job_id,
          state: 'completed',
          conflict: true,
        };
      }
      return {
        matched: true,
        applied: false,
        jobId: match.job_id,
        state: 'completed',
        conflict: false,
      };
    }

    const sourceAlreadySettled = match.processing_status === 'complete'
      && match.terminal_reason === 'response_echoed';
    if (!sourceAlreadySettled) {
      if (!['processing', 'turn_done'].includes(match.processing_status)) {
        this.statements.recordEchoedTurnRecoveryConflict.run(
          'open_job_source_not_echo_settleable',
          match.job_id,
        );
        return {
          matched: true,
          applied: false,
          jobId: match.job_id,
          state: match.state,
          conflict: true,
        };
      }
      const inbound = this.statements.completeEchoedTurnRecoveryInbound.run(match.inbound_seq);
      if (inbound.changes !== 1) {
        throw new Error('Echoed recovery settlement did not update exactly one source inbound');
      }
    }
    const token = `echo-delivery:${outboundOpId}`;
    const completed = this.statements.completeEchoedTurnRecoveryJob.run(
      token,
      token,
      `outbound-op:${outboundOpId}`,
      match.job_id,
    );
    if (completed.changes !== 1) {
      throw new Error('Echoed recovery job settlement did not update exactly one row');
    }
    return {
      matched: true,
      applied: true,
      jobId: match.job_id,
      state: 'completed',
      conflict: false,
    };
  }

  getUnsettledEchoedTurnRecoveryOpIds(limit = 1_000): number[] {
    validatePositiveSafeInteger(limit, 'Echoed recovery settlement limit');
    return (this.statements.getUnsettledEchoedTurnRecoveryOps.all(limit) as Array<{ id: number }>)
      .map((row) => row.id);
  }

  requeueTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
    backoffSeconds: number,
  ): RequeueTurnRecoveryJobResult {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    validateTurnRecoveryOwnerIdentity(owner);
    validateRecoveryClaimToken(fence.claimToken);
    validatePositiveSafeInteger(fence.claimEpoch, 'Recovery claim epoch');
    validateRecoveryBackoffSeconds(backoffSeconds);
    const before = this.getOwnedTurnRecoveryJob(jobId, owner);
    const idempotentBefore = this.getIdempotentRequeueResult(
      before,
      fence,
      backoffSeconds,
    );
    if (idempotentBefore) return idempotentBefore;
    const row = this.statements.requeueTurnRecoveryJob.get(
      recoveryClaimTokenHash(fence.claimToken),
      backoffSeconds,
      recoveryTimeModifier(backoffSeconds),
      jobId,
      owner.logicalTurnId,
      owner.managerId,
      owner.generation,
      fence.claimToken,
      fence.claimEpoch,
    ) as InternalTurnRecoveryJobRow | undefined;
    if (row) {
      return {
        applied: true,
        jobId,
        state: row.state === 'exhausted' ? 'exhausted' : 'pending',
        attemptCount: row.attempt_count,
      };
    }
    const current = this.getOwnedTurnRecoveryJob(jobId, owner);
    const idempotentCurrent = this.getIdempotentRequeueResult(
      current,
      fence,
      backoffSeconds,
    );
    if (idempotentCurrent) return idempotentCurrent;
    throw new Error('Recovery claim fence does not match the current owner claim');
  }

  private getIdempotentRequeueResult(
    row: InternalTurnRecoveryJobRow,
    fence: TurnRecoveryClaimFence,
    backoffSeconds: number,
  ): RequeueTurnRecoveryJobResult | undefined {
    if (
      row.state !== 'pending' &&
      row.state !== 'exhausted'
    ) {
      return undefined;
    }
    if (
      row.last_requeue_claim_token_hash !== recoveryClaimTokenHash(fence.claimToken) ||
      row.last_requeue_claim_epoch !== fence.claimEpoch
    ) {
      return undefined;
    }
    if (row.last_requeue_backoff_seconds !== backoffSeconds) {
      throw new Error('Recovery requeue retry supplied a different backoff');
    }
    return {
      applied: false,
      jobId: row.id,
      state: row.state,
      attemptCount: row.attempt_count,
    };
  }

  recoverStaleTurnRecoveryJobs(limit = 200): { requeued: number; exhausted: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('Stale recovery limit must be between 1 and 200');
    }
    let inTransaction = false;
    try {
      this.db.raw.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      const stale = this.statements.getStaleTurnRecoveryJobs.all(
        limit,
      ) as unknown as InternalTurnRecoveryJobRow[];
      let requeued = 0;
      let exhausted = 0;
      for (const row of stale) {
        if (row.claim_token === null) continue;
        if (row.attempt_count >= TURN_RECOVERY_MAX_ATTEMPTS) {
          exhausted += Number(this.statements.exhaustStaleTurnRecoveryJob.run(
            recoveryClaimTokenHash(row.claim_token),
            row.id,
            row.claim_token,
            row.claim_epoch,
          ).changes);
        } else {
          requeued += Number(this.statements.requeueStaleTurnRecoveryJob.run(
            recoveryClaimTokenHash(row.claim_token),
            row.id,
            row.claim_token,
            row.claim_epoch,
          ).changes);
        }
      }
      this.db.raw.exec('COMMIT');
      inTransaction = false;
      return { requeued, exhausted };
    } catch (err) {
      if (inTransaction) this.db.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Transaction-neutral: the caller owns the reclaim transaction (the
   * stuck-inbound sweep). Drives a `pending`/`claimed` recovery job whose
   * selected delivery is provably dead to the terminal `exhausted` state so it
   * stops pinning admission. No-op (returns false) for any other state —
   * already-`exhausted`, `blocked_unsafe`, and `completed` jobs need no mutation
   * (none of them block admission), so the caller only fails their source
   * inbound. #1749.
   */
  reclaimDeadDeliveryRecoveryJobWithinCallerTransaction(jobId: number): boolean {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    return this.statements.reclaimDeadDeliveryRecoveryJob.run(jobId).changes === 1;
  }

  reassignPendingTurnRecoveryJob(
    jobId: number,
    currentOwner: TurnRecoveryOwnerIdentity,
    newOwner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryAssignmentFence,
  ): ReassignTurnRecoveryJobResult {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    validateTurnRecoveryOwnerIdentity(currentOwner);
    validateTurnRecoveryOwnerIdentity(newOwner);
    validateRecoveryAssignmentFence(fence);
    const current = this.getInternalTurnRecoveryJob(jobId);
    if (!current) throw new Error('Recovery job does not exist');
    if (
      current.source_logical_turn_id === newOwner.logicalTurnId &&
      current.source_manager_id === newOwner.managerId &&
      current.source_generation === newOwner.generation
    ) {
      throw new Error('Recovery source and assigned owner identities must differ');
    }
    if (
      current.state === 'pending' &&
      current.assigned_owner_logical_turn_id === newOwner.logicalTurnId &&
      current.assigned_owner_manager_id === newOwner.managerId &&
      current.assigned_owner_generation === newOwner.generation &&
      current.claim_epoch === fence.claimEpoch &&
      current.assignment_epoch === fence.assignmentEpoch + 1
    ) {
      return {
        applied: false,
        jobId,
        assignedOwner: newOwner,
        assignmentEpoch: current.assignment_epoch,
      };
    }
    if (
      current.assigned_owner_logical_turn_id !== currentOwner.logicalTurnId ||
      current.assigned_owner_manager_id !== currentOwner.managerId ||
      current.assigned_owner_generation !== currentOwner.generation
    ) {
      throw new Error('Recovery job may only be changed by its assigned recovery owner');
    }
    if (current.state !== 'pending') {
      throw new Error('Only pending recovery work can be reassigned');
    }
    const row = this.statements.reassignTurnRecoveryJob.get(
      newOwner.logicalTurnId,
      newOwner.managerId,
      newOwner.generation,
      jobId,
      currentOwner.logicalTurnId,
      currentOwner.managerId,
      currentOwner.generation,
      fence.claimEpoch,
      fence.assignmentEpoch,
    ) as InternalTurnRecoveryJobRow | undefined;
    if (!row) throw new Error('Recovery reassignment lost its pending epoch fence');
    return {
      applied: true,
      jobId,
      assignedOwner: newOwner,
      assignmentEpoch: row.assignment_epoch,
    };
  }

  reassignBlockedTurnRecoveryJob(
    jobId: number,
    currentOwner: TurnRecoveryOwnerIdentity,
    newOwner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryAssignmentFence,
  ): ReassignTurnRecoveryJobResult {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    validateTurnRecoveryOwnerIdentity(currentOwner);
    validateTurnRecoveryOwnerIdentity(newOwner);
    validateRecoveryAssignmentFence(fence);
    const current = this.getInternalTurnRecoveryJob(jobId);
    if (!current) throw new Error('Recovery job does not exist');
    if (
      current.source_logical_turn_id === newOwner.logicalTurnId &&
      current.source_manager_id === newOwner.managerId &&
      current.source_generation === newOwner.generation
    ) {
      throw new Error('Recovery source and assigned owner identities must differ');
    }
    if (
      current.state === 'blocked_unsafe' &&
      current.assigned_owner_logical_turn_id === newOwner.logicalTurnId &&
      current.assigned_owner_manager_id === newOwner.managerId &&
      current.assigned_owner_generation === newOwner.generation &&
      current.claim_epoch === fence.claimEpoch &&
      current.assignment_epoch === fence.assignmentEpoch + 1
    ) {
      return {
        applied: false,
        jobId,
        assignedOwner: newOwner,
        assignmentEpoch: current.assignment_epoch,
      };
    }
    if (
      current.assigned_owner_logical_turn_id !== currentOwner.logicalTurnId ||
      current.assigned_owner_manager_id !== currentOwner.managerId ||
      current.assigned_owner_generation !== currentOwner.generation
    ) {
      throw new Error('Recovery job may only be changed by its assigned recovery owner');
    }
    if (current.state !== 'blocked_unsafe') {
      throw new Error('Only blocked unsafe recovery work can use blocked reassignment');
    }
    const row = this.statements.reassignBlockedTurnRecoveryJob.get(
      newOwner.logicalTurnId,
      newOwner.managerId,
      newOwner.generation,
      jobId,
      currentOwner.logicalTurnId,
      currentOwner.managerId,
      currentOwner.generation,
      fence.claimEpoch,
      fence.assignmentEpoch,
    ) as InternalTurnRecoveryJobRow | undefined;
    if (!row) throw new Error('Blocked recovery reassignment lost its epoch fence');
    return {
      applied: true,
      jobId,
      assignedOwner: newOwner,
      assignmentEpoch: row.assignment_epoch,
    };
  }

  promoteBlockedTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryAssignmentFence,
    proof: { idempotencyProofId: string },
  ): PromoteBlockedTurnRecoveryJobResult {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    validateTurnRecoveryOwnerIdentity(owner);
    validateRecoveryAssignmentFence(fence);
    validateBoundedRequired(
      proof.idempotencyProofId,
      'Recovery idempotency proof ID',
      TURN_RECOVERY_MAX_ID_BYTES,
    );
    const before = this.getOwnedTurnRecoveryJob(jobId, owner);
    if (before.state === 'pending' && before.replay_safe === 0) {
      if (
        before.replay_safety_proof_id === proof.idempotencyProofId &&
        before.claim_epoch === fence.claimEpoch &&
        before.assignment_epoch === fence.assignmentEpoch
      ) {
        return {
          applied: false,
          jobId,
          state: 'pending',
          idempotencyProofId: proof.idempotencyProofId,
          assignmentEpoch: before.assignment_epoch,
        };
      }
      if (before.replay_safety_proof_id === proof.idempotencyProofId) {
        throw new Error('Blocked recovery proof promotion lost its epoch fence');
      }
      throw new Error('Recovery work was promoted with a different idempotency proof');
    }
    if (before.state !== 'blocked_unsafe') {
      throw new Error('Only blocked unsafe recovery work can be proof-promoted');
    }
    const row = this.statements.promoteBlockedTurnRecoveryJob.get(
      proof.idempotencyProofId,
      jobId,
      owner.logicalTurnId,
      owner.managerId,
      owner.generation,
      fence.claimEpoch,
      fence.assignmentEpoch,
    ) as InternalTurnRecoveryJobRow | undefined;
    if (row) {
      return {
        applied: true,
        jobId,
        state: 'pending',
        idempotencyProofId: proof.idempotencyProofId,
        assignmentEpoch: row.assignment_epoch,
      };
    }

    const current = this.getOwnedTurnRecoveryJob(jobId, owner);
    if (
      current.state === 'pending' &&
      current.replay_safe === 0 &&
      current.replay_safety_proof_id === proof.idempotencyProofId &&
      current.claim_epoch === fence.claimEpoch &&
      current.assignment_epoch === fence.assignmentEpoch
    ) {
      return {
        applied: false,
        jobId,
        state: 'pending',
        idempotencyProofId: proof.idempotencyProofId,
        assignmentEpoch: current.assignment_epoch,
      };
    }
    if (current.state === 'pending' && current.replay_safe === 0) {
      throw new Error('Recovery work was promoted with a different idempotency proof');
    }
    throw new Error('Blocked recovery proof promotion lost its epoch fence');
  }

  /**
   * Enumerates every pending or claimed job for one owner, including pending
   * backoff. Cursors are scoped to one scan cycle; after scanComplete, reset
   * afterId to zero on the next poll so a lower-ID state/time transition is
   * observed in a later cycle. Claim CAS still enforces next_attempt_at.
   */
  getRecoverableTurnRecoveryJobs(
    owner: TurnRecoveryOwnerIdentity,
    options: { limit?: number; afterId?: number } = {},
  ): TurnRecoveryEnumerationPage {
    validateTurnRecoveryOwnerIdentity(owner);
    const limit = options.limit ?? 200;
    const afterId = options.afterId ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('Recovery enumeration limit must be between 1 and 200');
    }
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new Error('Recovery enumeration cursor must be a nonnegative safe integer');
    }
    const rows = this.statements.getRecoverableTurnRecoveryJobs.all(
      owner.logicalTurnId,
      owner.managerId,
      owner.generation,
      afterId,
      limit + 1,
    ) as unknown as InternalTurnRecoveryJobRow[];
    return this.toRecoveryEnumerationPage(rows, limit);
  }

  /**
   * Supervisor-only discovery across assigned owners. Live claims are hidden;
   * blocked and exhausted obligations remain operator-visible, while expired
   * claims remain visible so startup recovery can sweep them and then perform
   * epoch-fenced pending reassignment. Claim tokens are never returned. Cursors
   * belong to one bounded scan cycle only: after scanComplete, the next poll
   * resets afterId to zero so lower-ID state transitions cannot be skipped.
   */
  getOutstandingTurnRecoveryJobsForSupervisor(
    options: { limit?: number; afterId?: number } = {},
  ): TurnRecoveryEnumerationPage {
    const limit = options.limit ?? 200;
    const afterId = options.afterId ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('Supervisor recovery enumeration limit must be between 1 and 200');
    }
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new Error('Supervisor recovery cursor must be a nonnegative safe integer');
    }
    const rows = this.statements.getOutstandingTurnRecoveryJobsForSupervisor.all(
      afterId,
      limit + 1,
    ) as unknown as InternalTurnRecoveryJobRow[];
    return this.toRecoveryEnumerationPage(rows, limit);
  }

  getTurnRecoverySupervisorCounts(): TurnRecoverySupervisorCounts {
    const row = this.statements.getTurnRecoverySupervisorCounts.get() as {
      outstanding: number;
      blocked_unsafe: number;
      pending: number;
      live_claimed: number;
      expired_claimed: number;
      exhausted: number;
      quarantined_delivery: number;
      corrupt_links: number;
      orphan_transfers: number;
      echo_conflicts: number;
      open_recoveries: number;
    };
    return {
      outstanding: row.outstanding,
      blockedUnsafe: row.blocked_unsafe,
      pending: row.pending,
      liveClaimed: row.live_claimed,
      expiredClaimed: row.expired_claimed,
      exhausted: row.exhausted,
      quarantinedDelivery: row.quarantined_delivery,
      corruptLinks: row.corrupt_links,
      orphanTransfers: row.orphan_transfers,
      echoConflicts: row.echo_conflicts,
      openRecoveries: row.open_recoveries,
    };
  }

  /**
   * The ORIGINAL selected-delivery op's outbound status, independent of
   * claim state — callable on a still-`pending` job (unlike
   * `getEchoedTurnRecoverySettlement`/the completion-time check, both of
   * which require a live claim). `undefined` covers both "job does not
   * exist" and "no valid recovery link" the same way the shared join does
   * elsewhere; callers that need to distinguish those already hold the row
   * from enumeration.
   */
  getTurnRecoveryOriginalDeliveryStatus(jobId: number): { outboundStatus: string } | undefined {
    validatePositiveSafeInteger(jobId, 'Recovery job ID');
    const row = this.statements.getTurnRecoveryOriginalDeliveryStatus.get(jobId) as
      | { outbound_status: string }
      | undefined;
    return row ? { outboundStatus: row.outbound_status } : undefined;
  }

  /**
   * `options.excludeJobId` lets a caller that already owns a specific
   * recovery job (a supervisor replaying its own claimed job) ask "is this
   * scope blocked by OTHER outstanding recovery work" without the job it is
   * actively replaying counting as its own blocker — see PRESTAGE-T4's
   * admission self-block finding: without this, a supervisor replay dispatch
   * through the normal admission gate would find its own `claimed` job still
   * outstanding in-scope and deadlock against itself, since the job cannot
   * reach a terminal state until the replay it is gating completes.
   */
  hasOutstandingTurnRecoveryForScope(
    scope: 'per_chat' | 'shared' | 'singleton',
    conversationKey: string,
    options?: { excludeJobId?: number },
  ): boolean {
    validateBoundedRequired(
      conversationKey,
      'Recovery conversation key',
      TURN_RECOVERY_MAX_ID_BYTES,
    );
    const excludeJobId = options?.excludeJobId;
    if (excludeJobId !== undefined) {
      validatePositiveSafeInteger(excludeJobId, 'Recovery job ID');
    }
    return this.statements.hasOutstandingTurnRecoveryForScope.get(
      scope,
      conversationKey,
      excludeJobId ?? null,
      excludeJobId ?? null,
    ) !== undefined;
  }

  private toRecoveryEnumerationPage(
    rows: InternalTurnRecoveryJobRow[],
    limit: number,
  ): TurnRecoveryEnumerationPage {
    const scanComplete = rows.length <= limit;
    const jobs = rows.slice(0, limit).map(publicRecoveryJobRow);
    return {
      jobs,
      nextCursor: scanComplete ? null : jobs.at(-1)?.id ?? null,
      scanComplete,
    };
  }
}
