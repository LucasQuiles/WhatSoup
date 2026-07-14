import { createHash } from 'node:crypto';
import { createChildLogger } from '../logger.ts';
import { emitAlertChecked, clearAlertSourceChecked } from '../lib/emit-alert.ts';
import { gateQuarantineClear } from '../lib/fleet-health-gate.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Database } from './database.ts';
import type { Messenger } from './types.ts';
import type { GuardCaller } from './outbound-identity/types.ts';
import { toConversationKey } from './conversation-key.ts';
import { withTransaction } from './db-tx.ts';
import {
  createRecoveryStats,
  DurabilityRecoveryEvidence,
  type RecoveryStats,
} from './durability-recovery-evidence.ts';
import { coerceInboundFailureClass } from './inbound-failure-class.ts';
import type { InboundFailureClass } from './inbound-failure-class.ts';
import { config } from '../config.ts';
import {
  DELIVERY_STATUS_PROOF,
  normalizeFinalizeTurnTerminalParams,
  terminalRecordMatches,
  validateCompletedCheckpointIdentity,
} from './turn-finalization-contract.ts';
import type {
  CompleteTurnParams,
  FinalizeTurnTerminalParams,
  FinalizeTurnTerminalResult,
  RecordTurnTerminalResult,
  SessionCheckpointFields,
  TerminalInboundMutation,
  TurnBookkeepingParams,
  TurnTerminalPersistenceParams,
  TurnTerminalRecordRow,
} from './turn-finalization-contract.ts';
import {
  TURN_RECOVERY_MAX_ID_BYTES,
  TurnRecoveryStore,
  validateBoundedRequired,
  validatePositiveSafeInteger,
} from './turn-recovery-store.ts';
import {
  SessionLifecycleStore,
  type BeginFreshSessionLifecycleParams,
  type CloseSessionLifecycleFailureParams,
  type CloseSessionLifecycleParams,
  type ReactivateSessionLifecycleParams,
} from './session-lifecycle-store.ts';
import type {
  ClaimTurnRecoveryJobOptions,
  ClaimTurnRecoveryJobResult,
  EnqueueTurnRecoveryJobResult,
  PromoteBlockedTurnRecoveryJobResult,
  ReassignTurnRecoveryJobResult,
  RequeueTurnRecoveryJobResult,
  RenewTurnRecoveryClaimResult,
  TurnRecoveryAssignmentFence,
  TurnRecoveryClaimFence,
  TurnRecoveryEnumerationPage,
  TurnRecoveryJobPersistenceParams,
  TurnRecoveryJobRow,
  TurnRecoveryJobTransitionResult,
  TurnRecoveryOwnerIdentity,
  TurnRecoverySourceIdentity,
  TurnRecoverySupervisorCounts,
} from './turn-recovery-store.ts';

export { TURN_RECOVERY_MAX_TEXT_BYTES } from './turn-recovery-contract.ts';
export { TURN_RECOVERY_MAX_ATTEMPTS } from './turn-recovery-store.ts';
export type { RecoveryStats } from './durability-recovery-evidence.ts';
export type {
  CompleteTurnParams,
  FinalizeTurnTerminalParams,
  FinalizeTurnTerminalResult,
  RecordTurnTerminalResult,
  SessionCheckpointFields,
  TerminalInboundMutation,
  TurnBookkeepingParams,
  TurnFinalizationBookkeepingParams,
  TurnTerminalPersistenceParams,
  TurnTerminalRecordRow,
} from './turn-finalization-contract.ts';
export type {
  ClaimTurnRecoveryJobOptions,
  ClaimTurnRecoveryJobResult,
  EnqueueTurnRecoveryJobResult,
  PromoteBlockedTurnRecoveryJobResult,
  ReassignTurnRecoveryJobResult,
  RequeueTurnRecoveryJobResult,
  RenewTurnRecoveryClaimResult,
  TurnRecoveryAssignmentFence,
  TurnRecoveryClaimFence,
  TurnRecoveryEnumerationPage,
  TurnRecoveryJobPersistenceParams,
  TurnRecoveryJobRow,
  TurnRecoveryJobState,
  TurnRecoveryJobTransitionResult,
  TurnRecoveryOwnerIdentity,
  TurnRecoverySourceIdentity,
  TurnRecoverySupervisorCounts,
} from './turn-recovery-store.ts';

const log = createChildLogger('durability');

// ── Status string unions ──

export type OutboundStatus = 'pending' | 'sending' | 'submitted' | 'echoed' | 'maybe_sent' | 'failed_permanent' | 'quarantined';
type InboundStatus = 'pending' | 'processing' | 'turn_done' | 'complete' | 'failed';
export type SessionStatus = 'active' | 'suspended' | 'orphaned' | 'ended';
type ToolCallStatus = 'pending' | 'executing' | 'complete' | 'error' | 'replayed' | 'quarantined';

// ── SQLite row interfaces ──

/** Row returned by SELECT on inbound_events for pending/processing recovery. */
export interface InboundEventRow {
  seq: number;
  message_id: string;
  processing_status: string;
  routed_to: string;
}

/** Row returned by SELECT on outbound_ops for status-based queries. */
export interface OutboundOpRow {
  id: number;
  chat_jid: string;
  op_type: string;
  payload: string;
  wa_message_id: string | null;
  replay_policy: string;
  submitted_at: string | null;
  source_inbound_seq: number | null;
  is_terminal: number;
}

export interface OutboundDeliveryIdentity {
  conversationKey: string;
  deliveryJid: string;
  sourceInboundSeq: number | null;
}

export interface OutboundDeliverySnapshot extends OutboundDeliveryIdentity {
  opId: number;
  status: OutboundStatus;
}

/** Full row returned by SELECT * on session_checkpoints. */
export interface SessionCheckpointRow {
  id: number;
  conversation_key: string;
  session_id: string | null;
  transcript_path: string | null;
  active_turn_id: string | null;
  last_inbound_seq: number | null;
  last_flushed_outbound_id: number | null;
  watchdog_state: string | null;
  workspace_path: string | null;
  claude_pid: number | null;
  session_status: string;
  checkpoint_version: number;
  completed_inbound_seq: number | null;
  completed_delivery_jid: string | null;
  completed_delivery_namespace: string | null;
  completed_scope: string | null;
  completed_logical_turn_id: string | null;
  completed_manager_id: string | null;
  completed_generation: number | null;
  updated_at: string | null;
}

/** Minimal session_checkpoints row used for active-session enumeration. */
export interface ActiveSessionCheckpointRow {
  id: number;
  conversation_key: string;
  session_id: string | null;
  claude_pid: number | null;
  session_status: string;
}

export type ContinuityCandidateReason =
  | 'crash_reclaim_no_terminal_outbound'
  | 'runtime_fault_no_terminal_outbound';

export type ContinuityCandidateSource =
  | 'pre_connect_recovery'
  | 'runtime_fault_disarm';

/** Counts returned by {@link DurabilityEngine.sweepStuckInbound}. */
export interface StuckInboundSweepResult {
  completedEchoed: number;
  completedTurnDone: number;
  failedStale: number;
}

export interface OutboundOpParams {
  conversationKey: string;
  chatJid: string;
  opType: string;
  payload: string;
  replayPolicy: 'safe' | 'unsafe' | 'read_only';
  sourceInboundSeq?: number;
  isTerminal?: boolean;
}

type PreparedStatement = ReturnType<Database['raw']['prepare']>;

type DurabilityStatements = {
  journalInbound: PreparedStatement;
  markTurnDone: PreparedStatement;
  markInboundComplete: PreparedStatement;
  markInboundFailed: PreparedStatement;
  markContinuityCandidate: PreparedStatement;
  markContinuityCandidateIfUnownedAndNoTerminalOutbound: PreparedStatement;
  markInboundSkipped: PreparedStatement;
  selectInboundStatus: PreparedStatement;
  recordTurnTerminal: PreparedStatement;
  getTurnTerminal: PreparedStatement;
  createOutboundOp: PreparedStatement;
  markSending: PreparedStatement;
  markSubmitted: PreparedStatement;
  markEchoed: PreparedStatement;
  selectEchoedOutboundInbound: PreparedStatement;
  markMaybeSent: PreparedStatement;
  markFailedPermanent: PreparedStatement;
  markQuarantined: PreparedStatement;
  markTerminal: PreparedStatement;
  selectOutboundTerminalIdentity: PreparedStatement;
  selectOutboundForEchoMatch: PreparedStatement;
  recordToolCall: PreparedStatement;
  markToolExecuting: PreparedStatement;
  markToolComplete: PreparedStatement;
  accumulateSessionTokens: PreparedStatement;
  insertTokenEvent: PreparedStatement;
  upsertSessionCheckpoint: PreparedStatement;
  getSessionCheckpoint: PreparedStatement;
  getLatestCompletedCheckpointForSession: PreparedStatement;
  getAllActiveCheckpoints: PreparedStatement;
  getResumableCheckpoints: PreparedStatement;
  markSessionOrphaned: PreparedStatement;
  getPendingInbound: PreparedStatement;
  getOutboundByStatus: PreparedStatement;
  getRecoverableToolCalls: PreparedStatement;
  markToolReplayed: PreparedStatement;
  markRecoveredToolQuarantined: PreparedStatement;
  getProcessingInboundEvents: PreparedStatement;
  getTurnDoneInboundEvents: PreparedStatement;
  getTerminalOutboundForInbound: PreparedStatement;
  getOpenInboundWithEchoedTerminal: PreparedStatement;
  getStaleTurnDoneNoSuccess: PreparedStatement;
  getStaleOpenNoSuccess: PreparedStatement;
  getStaleSubmitted: PreparedStatement;
  getMessageByWaMessageId: PreparedStatement;
  resetMaybeSentWithWaToPending: PreparedStatement;
  resetMaybeSentWithoutWaToPending: PreparedStatement;
  sweepStaleSubmitted: PreparedStatement;
  getPendingOutboundCount: PreparedStatement;
  getQuarantinedOutboundCount: PreparedStatement;
  getLastRecoveryRunCompletedAt: PreparedStatement;
  insertRecoveryRun: PreparedStatement;
  selectNow: PreparedStatement;
};

export class DurabilityEngine {
  private db: Database;
  private readonly statements: DurabilityStatements;
  private readonly recoveryEvidence: DurabilityRecoveryEvidence;
  private readonly turnRecovery: TurnRecoveryStore;
  private readonly sessionLifecycle: SessionLifecycleStore;
  private readonly confirmedOutboundProbe: (seconds: number) => boolean;
  constructor(db: Database) {
    this.db = db;
    const prepare = db.raw.prepare.bind(db.raw);
    this.statements = {
      journalInbound: prepare(
        `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to, processing_status)
         VALUES (?, ?, ?, ?, 'processing')`,
      ),
      markTurnDone: prepare(`UPDATE inbound_events SET processing_status = 'turn_done' WHERE seq = ?`),
      markInboundComplete: prepare(
        `UPDATE inbound_events SET processing_status = 'complete', completed_at = datetime('now'), terminal_reason = ? WHERE seq = ?`,
      ),
      markInboundFailed: prepare(
        // terminal_reason stays exactly 'error' (external matcher contract); the
        // bounded, content-free failure_class column carries the driver split.
        `UPDATE inbound_events SET processing_status = 'failed', completed_at = datetime('now'), terminal_reason = 'error', failure_class = ? WHERE seq = ?`,
      ),
      markContinuityCandidate: prepare(
        `UPDATE inbound_events
         SET continuity_candidate_reason = ?,
             continuity_candidate_source = ?,
             continuity_candidate_marked_at = COALESCE(continuity_candidate_marked_at, datetime('now'))
         WHERE seq = ? AND continuity_candidate_reason IS NULL`,
      ),
      markContinuityCandidateIfUnownedAndNoTerminalOutbound: prepare(
        `UPDATE inbound_events
         SET continuity_candidate_reason = ?,
             continuity_candidate_source = ?,
             continuity_candidate_marked_at = COALESCE(continuity_candidate_marked_at, datetime('now'))
         WHERE seq = ?
           AND continuity_candidate_reason IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM turn_terminal_records t
             WHERE t.inbound_seq_key = inbound_events.seq
           )
           AND NOT EXISTS (
             SELECT 1 FROM outbound_ops o
             WHERE o.source_inbound_seq = inbound_events.seq AND o.is_terminal = 1
               AND o.status NOT IN ('quarantined', 'failed_permanent')
           )`,
      ),
      markInboundSkipped: prepare(
        `UPDATE inbound_events SET processing_status = 'complete', completed_at = datetime('now'), terminal_reason = ? WHERE seq = ?`,
      ),
      selectInboundStatus: prepare(
        `SELECT processing_status, conversation_key, chat_jid, message_id
         FROM inbound_events WHERE seq = ?`,
      ),
      recordTurnTerminal: prepare(`
        INSERT INTO turn_terminal_records (
          scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
          logical_turn_id, manager_id, generation, attempt_kind, attempt_failure_class,
          inbound_disposition, delivery_kind, delivery_op_id,
          recovery_owner_logical_turn_id, recovery_owner_manager_id,
          recovery_owner_generation, reply_guarantee_disarmed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(inbound_seq_key, logical_turn_id, generation) DO UPDATE SET
          duplicate_finalize_count = turn_terminal_records.duplicate_finalize_count + 1,
          last_duplicate_at = datetime('now')
        RETURNING id, duplicate_finalize_count, reply_guarantee_disarmed
      `),
      getTurnTerminal: prepare(`
        SELECT * FROM turn_terminal_records
        WHERE inbound_seq_key = ? AND logical_turn_id = ? AND generation = ?
      `),
      createOutboundOp: prepare(
        `INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, payload_hash, status, source_inbound_seq, is_terminal, replay_policy)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ),
      markSending: prepare(
        `UPDATE outbound_ops SET status = 'sending' WHERE id = ? AND status = 'pending'`,
      ),
      markSubmitted: prepare(
        `UPDATE outbound_ops SET status = 'submitted', wa_message_id = ?, submitted_at = datetime('now') WHERE id = ?`,
      ),
      markEchoed: prepare(
        `UPDATE outbound_ops
         SET status = 'echoed', echoed_at = COALESCE(echoed_at, datetime('now'))
         WHERE id = ?`,
      ),
      selectEchoedOutboundInbound: prepare(
        // QR-102: also select `status` so markTerminal can detect an op that was
        // ALREADY echoed before being marked terminal (echo-before-terminal ordering)
        // and finalize the linked inbound then.
        `SELECT o.source_inbound_seq, o.is_terminal, o.status,
                EXISTS(
                  SELECT 1 FROM turn_terminal_records t
                  WHERE t.inbound_seq_key = o.source_inbound_seq
                ) AS terminal_record_owned
         FROM outbound_ops o WHERE o.id = ?`,
      ),
      markMaybeSent: prepare(
        `UPDATE outbound_ops SET status = 'maybe_sent', error = ? WHERE id = ?`,
      ),
      markFailedPermanent: prepare(
        `UPDATE outbound_ops SET status = 'failed_permanent', error = ? WHERE id = ?`,
      ),
      markQuarantined: prepare(`UPDATE outbound_ops SET status = 'quarantined' WHERE id = ?`),
      markTerminal: prepare(`UPDATE outbound_ops SET is_terminal = 1 WHERE id = ?`),
      selectOutboundTerminalIdentity: prepare(`
        SELECT conversation_key, chat_jid, source_inbound_seq, status
        FROM outbound_ops WHERE id = ?
      `),
      selectOutboundForEchoMatch: prepare(
        `SELECT id FROM outbound_ops
         WHERE wa_message_id = ?
           AND status IN ('submitted', 'maybe_sent', 'quarantined', 'failed_permanent')`,
      ),
      recordToolCall: prepare(
        `INSERT INTO tool_calls (conversation_key, session_checkpoint_id, tool_name, tool_input, status, replay_policy)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      ),
      markToolExecuting: prepare(`UPDATE tool_calls SET status = 'executing' WHERE id = ?`),
      markToolComplete: prepare(
        `UPDATE tool_calls SET status = ?, result = ?, completed_at = datetime('now'), outbound_op_id = ? WHERE id = ?`,
      ),
      accumulateSessionTokens: prepare(
        `UPDATE agent_sessions
         SET total_input_tokens = total_input_tokens + ?,
             total_output_tokens = total_output_tokens + ?,
             total_cache_read_tokens = total_cache_read_tokens + ?
         WHERE id = ?`,
      ),
      insertTokenEvent: prepare(
        `INSERT INTO agent_token_events (agent_session_id, timestamp, input_tokens, output_tokens)
         VALUES (?, unixepoch('now'), ?, ?)`,
      ),
      upsertSessionCheckpoint: prepare(`
        INSERT INTO session_checkpoints (conversation_key, session_id, transcript_path, active_turn_id,
          last_inbound_seq, last_flushed_outbound_id, watchdog_state, workspace_path, claude_pid,
          session_status, completed_inbound_seq, completed_delivery_jid,
          completed_delivery_namespace, completed_scope,
          completed_logical_turn_id, completed_manager_id, completed_generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_key) DO UPDATE SET
          session_id = COALESCE(excluded.session_id, session_checkpoints.session_id),
          transcript_path = COALESCE(excluded.transcript_path, session_checkpoints.transcript_path),
          active_turn_id = excluded.active_turn_id,
          last_inbound_seq = CASE
            WHEN excluded.session_id IS NOT NULL
              AND excluded.session_id IS NOT session_checkpoints.session_id
              THEN excluded.last_inbound_seq
            ELSE COALESCE(excluded.last_inbound_seq, session_checkpoints.last_inbound_seq)
          END,
          last_flushed_outbound_id = COALESCE(excluded.last_flushed_outbound_id, last_flushed_outbound_id),
          watchdog_state = COALESCE(excluded.watchdog_state, watchdog_state),
          workspace_path = COALESCE(excluded.workspace_path, workspace_path),
          claude_pid = COALESCE(excluded.claude_pid, claude_pid),
          session_status = COALESCE(excluded.session_status, session_status),
          completed_inbound_seq = CASE
            WHEN excluded.session_id IS NOT NULL
              AND excluded.session_id IS NOT session_checkpoints.session_id
              THEN excluded.completed_inbound_seq
            ELSE COALESCE(excluded.completed_inbound_seq, session_checkpoints.completed_inbound_seq)
          END,
          completed_delivery_jid = CASE
            WHEN excluded.session_id IS NOT NULL
              AND excluded.session_id IS NOT session_checkpoints.session_id
              THEN excluded.completed_delivery_jid
            ELSE COALESCE(excluded.completed_delivery_jid, session_checkpoints.completed_delivery_jid)
          END,
          completed_delivery_namespace = CASE
            WHEN excluded.session_id IS NOT NULL
              AND excluded.session_id IS NOT session_checkpoints.session_id
              THEN excluded.completed_delivery_namespace
            ELSE COALESCE(excluded.completed_delivery_namespace, session_checkpoints.completed_delivery_namespace)
          END,
          completed_scope = CASE
            WHEN excluded.session_id IS NOT NULL
              AND excluded.session_id IS NOT session_checkpoints.session_id
              THEN excluded.completed_scope
            ELSE COALESCE(excluded.completed_scope, session_checkpoints.completed_scope)
          END,
          completed_logical_turn_id = CASE
            WHEN excluded.session_id IS NOT NULL
              AND excluded.session_id IS NOT session_checkpoints.session_id
              THEN excluded.completed_logical_turn_id
            ELSE COALESCE(excluded.completed_logical_turn_id, session_checkpoints.completed_logical_turn_id)
          END,
          completed_manager_id = CASE
            WHEN excluded.session_id IS NOT NULL
              AND excluded.session_id IS NOT session_checkpoints.session_id
              THEN excluded.completed_manager_id
            ELSE COALESCE(excluded.completed_manager_id, session_checkpoints.completed_manager_id)
          END,
          completed_generation = CASE
            WHEN excluded.session_id IS NOT NULL
              AND excluded.session_id IS NOT session_checkpoints.session_id
              THEN excluded.completed_generation
            ELSE COALESCE(excluded.completed_generation, session_checkpoints.completed_generation)
          END,
          checkpoint_version = checkpoint_version + 1,
          updated_at = datetime('now')
      `),
      getSessionCheckpoint: prepare(
        `SELECT * FROM session_checkpoints WHERE conversation_key = ?`,
      ),
      getLatestCompletedCheckpointForSession: prepare(`
        SELECT * FROM session_checkpoints
        WHERE session_id = ?
          AND session_status IN ('active', 'suspended')
          AND last_inbound_seq IS NOT NULL
          AND completed_inbound_seq IS NOT NULL
          AND completed_delivery_jid IS NOT NULL
          AND completed_delivery_namespace IS NOT NULL
          AND completed_scope IS NOT NULL
          AND completed_logical_turn_id IS NOT NULL
          AND completed_manager_id IS NOT NULL
          AND completed_generation IS NOT NULL
        ORDER BY completed_inbound_seq DESC, id DESC
        LIMIT 1
      `),
      getAllActiveCheckpoints: prepare(
        `SELECT id, conversation_key, session_id, claude_pid, session_status
         FROM session_checkpoints WHERE session_status = 'active'`,
      ),
      getResumableCheckpoints: prepare(
        `SELECT id, conversation_key, session_id, claude_pid, session_status
         FROM session_checkpoints
         WHERE session_status IN ('active', 'suspended') AND session_id IS NOT NULL`,
      ),
      markSessionOrphaned: prepare(
        `UPDATE session_checkpoints SET session_status = 'orphaned', updated_at = datetime('now') WHERE conversation_key = ?`,
      ),
      getPendingInbound: prepare(
        `SELECT seq, message_id, processing_status, routed_to FROM inbound_events WHERE processing_status IN ('pending', 'processing', 'turn_done')`,
      ),
      getOutboundByStatus: prepare(
        `SELECT id, chat_jid, op_type, payload, wa_message_id, replay_policy, submitted_at, source_inbound_seq, is_terminal FROM outbound_ops WHERE status = ?`,
      ),
      getRecoverableToolCalls: prepare(
        `SELECT id, conversation_key, tool_name, replay_policy, outbound_op_id
         FROM tool_calls WHERE status IN ('executing', 'pending')`,
      ),
      markToolReplayed: prepare(
        `UPDATE tool_calls SET status = 'replayed', completed_at = datetime('now') WHERE id = ?`,
      ),
      markRecoveredToolQuarantined: prepare(
        `UPDATE tool_calls SET status = 'quarantined', completed_at = datetime('now') WHERE id = ?`,
      ),
      getProcessingInboundEvents: prepare(
        `SELECT i.seq FROM inbound_events i
         WHERE i.processing_status = 'processing'
           AND NOT EXISTS (
             SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq_key = i.seq
           )`,
      ),
      // QR-035: events stranded at 'turn_done' (turn completed but
      // markInboundComplete didn't run before a crash) — recovery finalizes them.
      getTurnDoneInboundEvents: prepare(
        `SELECT i.seq FROM inbound_events i
         WHERE i.processing_status = 'turn_done'
           AND NOT EXISTS (
             SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq_key = i.seq
           )`,
      ),
      getTerminalOutboundForInbound: prepare(
        `SELECT id, status FROM outbound_ops
         WHERE source_inbound_seq = ? AND is_terminal = 1
           AND status NOT IN ('quarantined', 'failed_permanent')`,
      ),
      // W2 stuck-inbound reconciler buckets. Open set is ('pending','processing',
      // 'turn_done'). 'pending' is the schema DEFAULT but journalInbound (the sole
      // INSERT site) always writes 'processing' explicitly, so no row is ever
      // actually 'pending' — matched defensively, not because it occurs. There is
      // no 'queued' state. An echoed terminal op is the
      // delivery-confirmed success signal (mirrors getTerminalOutboundForInbound's
      // exclusion of quarantined/failed_permanent by matching status='echoed'
      // directly). Each bounded to 200 rows so a large backlog drains over several
      // sweeps rather than in one long transaction.
      getOpenInboundWithEchoedTerminal: prepare(
        `SELECT DISTINCT i.seq AS seq
         FROM inbound_events i
         JOIN outbound_ops o
           ON o.source_inbound_seq = i.seq AND o.is_terminal = 1 AND o.status = 'echoed'
         WHERE i.processing_status IN ('pending', 'processing', 'turn_done')
           AND i.received_at < datetime('now', '-5 minutes')
           AND NOT EXISTS (
             SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq_key = i.seq
           )
         ORDER BY i.seq ASC
         LIMIT 200`,
      ),
      getStaleTurnDoneNoSuccess: prepare(
        `SELECT i.seq AS seq
         FROM inbound_events i
         WHERE i.processing_status = 'turn_done'
           AND i.received_at < datetime('now', '-24 hours')
           AND NOT EXISTS (
             SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq_key = i.seq
           )
           AND NOT EXISTS (
             SELECT 1 FROM outbound_ops o
             WHERE o.source_inbound_seq = i.seq AND o.is_terminal = 1 AND o.status = 'echoed'
           )
         ORDER BY i.seq ASC
         LIMIT 200`,
      ),
      getStaleOpenNoSuccess: prepare(
        `SELECT i.seq AS seq
         FROM inbound_events i
         WHERE i.processing_status IN ('pending', 'processing')
           AND i.received_at < datetime('now', '-24 hours')
           AND NOT EXISTS (
             SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq_key = i.seq
           )
           AND NOT EXISTS (
             SELECT 1 FROM outbound_ops o
             WHERE o.source_inbound_seq = i.seq AND o.is_terminal = 1 AND o.status = 'echoed'
           )
         ORDER BY i.seq ASC
         LIMIT 200`,
      ),
      getStaleSubmitted: prepare(
        `SELECT id FROM outbound_ops WHERE status = 'submitted' AND submitted_at < datetime('now', '-30 seconds')`,
      ),
      getMessageByWaMessageId: prepare(
        `SELECT pk FROM messages WHERE message_id = ?`,
      ),
      resetMaybeSentWithWaToPending: prepare(
        `UPDATE outbound_ops SET status = 'pending', error = NULL WHERE id = ?`,
      ),
      resetMaybeSentWithoutWaToPending: prepare(
        `UPDATE outbound_ops SET status = 'pending', error = NULL WHERE id = ?`,
      ),
      sweepStaleSubmitted: prepare(
        `UPDATE outbound_ops SET status = 'maybe_sent', error = 'echo_timeout'
         WHERE status = 'submitted' AND submitted_at < datetime('now', '-30 seconds')`,
      ),
      getPendingOutboundCount: prepare(
        `SELECT COUNT(*) as count FROM outbound_ops WHERE status IN ('pending', 'sending', 'submitted', 'maybe_sent')`,
      ),
      getQuarantinedOutboundCount: prepare(
        `SELECT COUNT(*) as count FROM outbound_ops WHERE status = 'quarantined'`,
      ),
      getLastRecoveryRunCompletedAt: prepare(
        `SELECT completed_at FROM recovery_runs ORDER BY id DESC LIMIT 1`,
      ),
      insertRecoveryRun: prepare(`
        INSERT INTO recovery_runs
          (trigger, inbound_replayed, outbound_reconciled, outbound_replayed,
           outbound_quarantined, tool_calls_recovered, tool_calls_replayed,
           tool_calls_quarantined, sessions_restored, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `),
      selectNow: prepare(`SELECT datetime('now') AS now`),
    };
    this.recoveryEvidence = new DurabilityRecoveryEvidence(db);
    this.turnRecovery = new TurnRecoveryStore(db, () => (
      this.statements.selectNow.get() as { now: string }
    ).now);
    this.sessionLifecycle = new SessionLifecycleStore(db);
    this.confirmedOutboundProbe = makeConfirmedOutboundProbe(db.raw);
  }

  private runUpsertSessionCheckpoint(conversationKey: string, fields: SessionCheckpointFields): void {
    validateCompletedCheckpointIdentity(fields);
    this.statements.upsertSessionCheckpoint.run(
      conversationKey, fields.sessionId ?? null, fields.transcriptPath ?? null,
      fields.activeTurnId ?? null, fields.lastInboundSeq ?? null,
      fields.lastFlushedOutboundId ?? null, fields.watchdogState ?? null,
      fields.workspacePath ?? null, fields.claudePid ?? null,
      fields.sessionStatus ?? 'active',
      fields.completedInboundSeq ?? null,
      fields.completedDeliveryJid ?? null,
      fields.completedDeliveryNamespace ?? null,
      fields.completedScope ?? null,
      fields.completedLogicalTurnId ?? null,
      fields.completedManagerId ?? null,
      fields.completedGeneration ?? null,
    );
  }

  private runCompleteInbound(seq: number, reason: string): void {
    const row = this.statements.selectInboundStatus.get(seq) as { processing_status: string } | undefined;
    if (row?.processing_status === 'processing') {
      this.markTurnDone(seq);
    }
    this.markInboundComplete(seq, reason);
  }

  private runTurnBookkeeping(params: TurnBookkeepingParams): void {
    if (params.sessionTokens) {
      // inputTokens here is the genuinely-new-only portion (#1774) — the
      // caller (turnFinalizationBookkeeping) has already split cache_read
      // out via splitInputTokenUsage(). agent_token_events carries no
      // separate cache-read column, so it logs the same corrected value.
      this.statements.accumulateSessionTokens.run(
        params.sessionTokens.inputTokens,
        params.sessionTokens.outputTokens,
        params.sessionTokens.cacheReadTokens,
        params.sessionTokens.dbRowId,
      );
      this.statements.insertTokenEvent.run(
        params.sessionTokens.dbRowId,
        params.sessionTokens.inputTokens,
        params.sessionTokens.outputTokens,
      );
    }
    if (params.checkpoint) {
      this.runUpsertSessionCheckpoint(params.checkpoint.conversationKey, params.checkpoint.fields);
    }
  }

  private validateTerminalInboundProof(params: FinalizeTurnTerminalParams): void {
    const { terminal, recoveryJob } = params;
    if (terminal.inboundSeq === null) {
      if (terminal.inboundDisposition === 'transferred_to_recovery_owner') {
        throw new Error('A recovery transfer requires an existing inbound row');
      }
      return;
    }
    const row = this.statements.selectInboundStatus.get(terminal.inboundSeq) as {
      processing_status: string;
      conversation_key: string;
      chat_jid: string;
      message_id: string;
    } | undefined;
    if (!row) throw new Error('Selected inbound row does not exist');
    if (
      row.conversation_key !== terminal.conversationKey ||
      row.chat_jid !== terminal.deliveryJid
    ) {
      throw new Error('Selected inbound identity does not match terminal identity');
    }
    if (!['processing', 'turn_done'].includes(row.processing_status)) {
      throw new Error('Selected inbound row is not eligible for terminal finalization');
    }
    if (recoveryJob !== undefined && row.message_id !== recoveryJob.sourceMessageId) {
      throw new Error('Recovery source message does not match the selected inbound row');
    }
  }

  private validateTerminalDeliveryProof(
    terminal: TurnTerminalPersistenceParams,
  ): { id: number; status: string } | undefined {
    if (terminal.deliveryKind === 'none') return undefined;
    const opId = terminal.deliveryOpId;
    if (opId === null) throw new Error('Terminal delivery evidence requires a durable op');
    const row = this.statements.selectOutboundTerminalIdentity.get(opId) as {
      conversation_key: string;
      chat_jid: string;
      source_inbound_seq: number | null;
      status: string;
    } | undefined;
    if (!row) throw new Error('Selected delivery outbound op does not exist');
    if (
      row.conversation_key !== terminal.conversationKey ||
      row.chat_jid !== terminal.deliveryJid ||
      row.source_inbound_seq !== terminal.inboundSeq
    ) {
      throw new Error('Selected outbound identity does not match terminal identity');
    }
    const expectedStatus = DELIVERY_STATUS_PROOF[terminal.deliveryKind];
    if (row.status !== expectedStatus) {
      throw new Error(`${row.status} does not prove ${terminal.deliveryKind} delivery evidence`);
    }
    return { id: opId, status: row.status };
  }

  private runTerminalInboundMutation(
    mutation: TerminalInboundMutation,
    terminal: TurnTerminalPersistenceParams,
  ): void {
    const existing = this.statements.selectInboundStatus.get(mutation.seq) as
      {
        processing_status: string;
        conversation_key: string;
        chat_jid: string;
      } | undefined;
    if (!existing) throw new Error('Selected inbound row does not exist');
    if (
      existing.conversation_key !== terminal.conversationKey ||
      existing.chat_jid !== terminal.deliveryJid
    ) {
      throw new Error('Selected inbound identity does not match terminal identity');
    }
    if (!['processing', 'turn_done'].includes(existing.processing_status)) {
      throw new Error('Selected inbound row is not eligible for terminal finalization');
    }
    if (mutation.kind === 'complete') {
      if (existing.processing_status === 'processing') this.markTurnDone(mutation.seq);
      const completed = this.statements.markInboundComplete.run(
        mutation.terminalReason,
        mutation.seq,
      );
      if (completed.changes !== 1) {
        throw new Error('Selected inbound completion did not update exactly one row');
      }
      return;
    }
    const failed = this.statements.markInboundFailed.run(
      coerceInboundFailureClass(mutation.failureClass),
      mutation.seq,
    );
    if (failed.changes !== 1) {
      throw new Error('Selected inbound failure did not update exactly one row');
    }
  }

  private runRecordTurnTerminal(
    params: TurnTerminalPersistenceParams,
  ): RecordTurnTerminalResult {
    const inboundSeqKey = params.inboundSeq ?? -1;
    const row = this.statements.recordTurnTerminal.get(
      params.scope,
      params.conversationKey,
      params.deliveryJid,
      params.inboundSeq,
      inboundSeqKey,
      params.logicalTurnId,
      params.managerId,
      params.generation,
      params.attemptKind,
      params.attemptFailureClass,
      params.inboundDisposition,
      params.deliveryKind,
      params.deliveryOpId,
      params.recoveryOwnerLogicalTurnId,
      params.recoveryOwnerManagerId,
      params.recoveryOwnerGeneration,
      params.replyGuaranteeDisarmed ? 1 : 0,
    ) as {
      id: number;
      duplicate_finalize_count: number;
      reply_guarantee_disarmed: number;
    } | undefined;
    if (!row) {
      throw new Error('Terminal CAS did not return its durable record');
    }
    return {
      applied: row.duplicate_finalize_count === 0,
      recordId: row.id,
      duplicateFinalizeCount: row.duplicate_finalize_count,
      replyGuaranteeDisarmed: row.reply_guarantee_disarmed === 1,
    };
  }

  // ── Inbound events ──
  journalInbound(messageId: string, conversationKey: string, chatJid: string, routedTo: string): number {
    const result = this.statements.journalInbound.run(messageId, conversationKey, chatJid, routedTo);
    const seq = Number(result.lastInsertRowid);
    log.debug({ seq, messageId, routedTo }, 'journalInbound');
    return seq;
  }

  markTurnDone(seq: number): void {
    this.statements.markTurnDone.run(seq);
  }

  getInboundStatus(seq: number): string | undefined {
    const row = this.statements.selectInboundStatus.get(seq) as { processing_status: string } | undefined;
    return row?.processing_status;
  }

  markInboundComplete(seq: number, terminalReason: string): void {
    this.statements.markInboundComplete.run(terminalReason, seq);
  }

  markInboundFailed(seq: number, failureClass?: InboundFailureClass): void {
    this.statements.markInboundFailed.run(coerceInboundFailureClass(failureClass), seq);
  }

  markContinuityCandidate(
    seq: number,
    reason: ContinuityCandidateReason,
    source: ContinuityCandidateSource,
  ): boolean {
    return this.statements.markContinuityCandidate.run(reason, source, seq).changes === 1;
  }

  markContinuityCandidateIfNoTerminalOutbound(
    seq: number,
    reason: ContinuityCandidateReason,
    source: ContinuityCandidateSource,
  ): boolean {
    return this.statements.markContinuityCandidateIfUnownedAndNoTerminalOutbound.run(
      reason,
      source,
      seq,
    ).changes === 1;
  }

  markInboundSkipped(seq: number, reason: string): void {
    this.statements.markInboundSkipped.run(reason, seq);
  }

  /** Transition inbound event: processing → turn_done → complete. */
  completeInbound(seq: number, reason: string): void {
    this.runCompleteInbound(seq, reason);
  }

  /** Batch turn-completion bookkeeping into a single SQLite transaction. */
  completeTurn(params: CompleteTurnParams): void {
    const hasWrites =
      params.sessionTokens !== undefined ||
      params.checkpoint !== undefined ||
      params.inbound !== undefined ||
      params.lastOpId !== undefined;
    if (!hasWrites) return;

    let inTransaction = false;
    try {
      this.db.raw.exec('BEGIN IMMEDIATE');
      inTransaction = true;

      this.runTurnBookkeeping(params);
      if (params.inbound) {
        this.runCompleteInbound(params.inbound.seq, params.inbound.terminalReason);
      }
      if (params.lastOpId !== undefined) {
        this.statements.markTerminal.run(params.lastOpId);
      }

      this.db.raw.exec('COMMIT');
      inTransaction = false;
    } catch (err) {
      log.error({
        agentSessionId: params.sessionTokens?.dbRowId,
        hasTokenWrite: params.sessionTokens !== undefined,
        hasCheckpoint: params.checkpoint !== undefined,
        hasInbound: params.inbound !== undefined,
        err,
      }, 'completeTurn.fail');
      if (inTransaction) {
        try {
          this.db.raw.exec('ROLLBACK');
        } catch (rollbackErr) {
          log.warn({ err: rollbackErr }, 'completeTurn: rollback failed');
        }
      }
      throw err;
    }
  }

  /**
   * Applies the terminal winner, its selected inbound disposition, and optional
   * turn bookkeeping in one immediate transaction. A duplicate winner only
   * increments the terminal duplicate counter; none of its companion writes
   * are repeated.
   */
  finalizeTurnTerminal(params: FinalizeTurnTerminalParams): FinalizeTurnTerminalResult {
    const normalized = normalizeFinalizeTurnTerminalParams(params);
    let inTransaction = false;
    try {
      this.db.raw.exec('BEGIN IMMEDIATE');
      inTransaction = true;

      const result = this.runRecordTurnTerminal(normalized.terminal);
      let winnerMatchesRequest = result.applied;
      let recoveryJob: EnqueueTurnRecoveryJobResult | undefined;
      if (result.applied) {
        this.validateTerminalInboundProof(normalized);
        const deliveryOp = this.validateTerminalDeliveryProof(normalized.terminal);
        if (normalized.recoveryJob !== undefined) {
          recoveryJob = this.turnRecovery.insertLinkedWithinCallerTransaction(
            result.recordId,
            normalized.recoveryJob,
          );
        }
        if (normalized.bookkeeping) this.runTurnBookkeeping(normalized.bookkeeping);
        if (normalized.inbound) {
          this.runTerminalInboundMutation(normalized.inbound, normalized.terminal);
        }
        if (deliveryOp !== undefined) {
          const terminalOp = this.statements.markTerminal.run(deliveryOp.id);
          if (terminalOp.changes !== 1) {
            throw new Error('Selected terminal outbound op does not exist');
          }
        }
      } else {
        const winner = this.getTurnTerminal(
          normalized.terminal.inboundSeq,
          normalized.terminal.logicalTurnId,
          normalized.terminal.generation,
        );
        winnerMatchesRequest = winner !== undefined &&
          terminalRecordMatches(winner, normalized.terminal);
        if (
          winner !== undefined &&
          winnerMatchesRequest &&
          normalized.recoveryJob !== undefined
        ) {
          recoveryJob = this.turnRecovery.findExactLinkedReceipt(
            winner.id,
            normalized.recoveryJob,
          );
          // A transferred terminal and its exact linked recovery envelope are
          // one durable request. A terminal-only match must not be reported as
          // an exact winner when its recovery receipt is absent or conflicts.
          winnerMatchesRequest = recoveryJob !== undefined;
        }
      }

      this.db.raw.exec('COMMIT');
      inTransaction = false;
      const replyGuaranteeDisarmed = winnerMatchesRequest && result.replyGuaranteeDisarmed;
      const effectiveReplyGuaranteeDisarmed = replyGuaranteeDisarmed || (
        winnerMatchesRequest &&
        normalized.terminal.inboundDisposition === 'transferred_to_recovery_owner' &&
        normalized.terminal.deliveryKind !== 'delivery_unknown' &&
        (
          recoveryJob?.status === 'durably_queued' ||
          recoveryJob?.status === 'durably_blocked'
        )
      );
      return {
        ...result,
        winnerMatchesRequest,
        replyGuaranteeDisarmed,
        effectiveReplyGuaranteeDisarmed,
        ...(recoveryJob === undefined ? {} : { recoveryJob }),
      };
    } catch (err) {
      log.error({
        logicalTurnId: normalized.terminal.logicalTurnId,
        generation: normalized.terminal.generation,
        hasInbound: normalized.inbound !== undefined,
        hasBookkeeping: normalized.bookkeeping !== undefined,
        err,
      }, 'finalizeTurnTerminal.fail');
      if (inTransaction) {
        try {
          this.db.raw.exec('ROLLBACK');
        } catch (rollbackErr) {
          log.warn({ err: rollbackErr }, 'finalizeTurnTerminal: rollback failed');
        }
      }
      throw err;
    }
  }

  getTurnTerminal(
    inboundSeq: number | null,
    logicalTurnId: string,
    generation: number,
  ): TurnTerminalRecordRow | undefined {
    return this.statements.getTurnTerminal.get(
      inboundSeq ?? -1,
      logicalTurnId,
      generation,
    ) as TurnTerminalRecordRow | undefined;
  }

  getTurnRecoveryJob(jobId: number): TurnRecoveryJobRow | undefined {
    return this.turnRecovery.getTurnRecoveryJob(jobId);
  }

  getTurnRecoveryJobBySource(
    source: TurnRecoverySourceIdentity,
  ): TurnRecoveryJobRow | undefined {
    return this.turnRecovery.getTurnRecoveryJobBySource(source);
  }

  claimTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    options: ClaimTurnRecoveryJobOptions,
  ): ClaimTurnRecoveryJobResult {
    return this.turnRecovery.claimTurnRecoveryJob(jobId, owner, options);
  }

  renewTurnRecoveryClaim(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
    options: { leaseSeconds: number },
  ): RenewTurnRecoveryClaimResult {
    return this.turnRecovery.renewTurnRecoveryClaim(jobId, owner, fence, options);
  }

  completeTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
  ): TurnRecoveryJobTransitionResult {
    return this.turnRecovery.completeTurnRecoveryJob(jobId, owner, fence);
  }

  requeueTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryClaimFence,
    backoffSeconds: number,
  ): RequeueTurnRecoveryJobResult {
    return this.turnRecovery.requeueTurnRecoveryJob(jobId, owner, fence, backoffSeconds);
  }

  recoverStaleTurnRecoveryJobs(limit = 200): { requeued: number; exhausted: number } {
    return this.turnRecovery.recoverStaleTurnRecoveryJobs(limit);
  }

  reassignPendingTurnRecoveryJob(
    jobId: number,
    currentOwner: TurnRecoveryOwnerIdentity,
    newOwner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryAssignmentFence,
  ): ReassignTurnRecoveryJobResult {
    return this.turnRecovery.reassignPendingTurnRecoveryJob(
      jobId,
      currentOwner,
      newOwner,
      fence,
    );
  }

  reassignBlockedTurnRecoveryJob(
    jobId: number,
    currentOwner: TurnRecoveryOwnerIdentity,
    newOwner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryAssignmentFence,
  ): ReassignTurnRecoveryJobResult {
    return this.turnRecovery.reassignBlockedTurnRecoveryJob(
      jobId,
      currentOwner,
      newOwner,
      fence,
    );
  }

  promoteBlockedTurnRecoveryJob(
    jobId: number,
    owner: TurnRecoveryOwnerIdentity,
    fence: TurnRecoveryAssignmentFence,
    proof: { idempotencyProofId: string },
  ): PromoteBlockedTurnRecoveryJobResult {
    return this.turnRecovery.promoteBlockedTurnRecoveryJob(jobId, owner, fence, proof);
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
    return this.turnRecovery.getRecoverableTurnRecoveryJobs(owner, options);
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
    return this.turnRecovery.getOutstandingTurnRecoveryJobsForSupervisor(options);
  }

  getTurnRecoverySupervisorCounts(): TurnRecoverySupervisorCounts {
    return this.turnRecovery.getTurnRecoverySupervisorCounts();
  }

  hasOutstandingTurnRecoveryForScope(
    scope: 'per_chat' | 'shared' | 'singleton',
    conversationKey: string,
  ): boolean {
    return this.turnRecovery.hasOutstandingTurnRecoveryForScope(scope, conversationKey);
  }

  // ── Outbound ops ──
  createOutboundOp(params: OutboundOpParams): number {
    const hash = createHash('sha256').update(params.payload).digest('hex');
    const result = this.statements.createOutboundOp.run(
      params.conversationKey, params.chatJid, params.opType, params.payload, hash,
      params.sourceInboundSeq ?? null, params.isTerminal ? 1 : 0, params.replayPolicy,
    );
    const id = Number(result.lastInsertRowid);
    log.debug({ id, opType: params.opType, replayPolicy: params.replayPolicy }, 'createOutboundOp');
    return id;
  }

  /**
   * Compare-and-swap pending → sending. Returns whether THIS call won the
   * transition (`changes === 1`). The `AND status = 'pending'` guard makes the
   * claim atomic so two un-serialized drainers (recover callback + echo-timeout
   * interval) over an overlapping stale snapshot cannot both send the same op
   * (BEAD-057 double-send). New-op callers (`sendTracked`, the chat/agent
   * runtimes) INSERT `pending` immediately before calling, so the CAS always
   * succeeds for them; they ignore the return value (behavior unchanged).
   */
  markSending(id: number): boolean {
    return this.statements.markSending.run(id).changes === 1;
  }

  markSubmitted(id: number, waMessageId: string | null): void {
    this.statements.markSubmitted.run(waMessageId, id);
  }

  markEchoed(id: number): void {
    withTransaction(this.db, () => {
      this.statements.markEchoed.run(id);
      const recovery = this.turnRecovery
        .settleEchoedTurnRecoveryJobWithinCallerTransaction(id);
      if (recovery.conflict) {
        log.warn(
          { outboundOpId: id, recoveryJobId: recovery.jobId, recoveryState: recovery.state },
          'echo recorded with a durable recovery settlement conflict',
        );
      }
      if (recovery.matched) return;

      // Preserve pre-CAS legacy completion only. Once a terminal record owns
      // the op, terminal/recovery settlement is the sole inbound authority.
      const row = this.statements.selectEchoedOutboundInbound.get(id) as
        {
          source_inbound_seq: number | null;
          is_terminal: number;
          status: string;
          terminal_record_owned: number;
        } | undefined;
      if (row?.is_terminal && row.source_inbound_seq && !row.terminal_record_owned) {
        this.completeInbound(row.source_inbound_seq, 'response_sent');
      }
    });
  }

  markMaybeSent(id: number, error?: string): void {
    this.statements.markMaybeSent.run(error ?? null, id);
  }

  markFailedPermanent(id: number, error: string): void {
    this.statements.markFailedPermanent.run(error, id);
  }

  markQuarantined(id: number): void {
    this.statements.markQuarantined.run(id);
  }

  markTerminal(id: number): void {
    this.statements.markTerminal.run(id);
    // QR-102 legacy echo-before-terminal ordering still completes an unowned
    // inbound here. A terminal-record-owned op is fenced to the atomic finalizer.
    const row = this.statements.selectEchoedOutboundInbound.get(id) as
      {
        source_inbound_seq: number | null;
        is_terminal: number;
        status: string;
        terminal_record_owned: number;
      } | undefined;
    if (
      row?.status === 'echoed' &&
      row.source_inbound_seq &&
      !row.terminal_record_owned
    ) {
      this.completeInbound(row.source_inbound_seq, 'response_sent');
    }
  }

  /** Read-only delivery truth for a single turn-owned outbound operation. */
  getOutboundDeliverySnapshot(
    opId: number,
    identity: OutboundDeliveryIdentity,
  ): OutboundDeliverySnapshot | undefined {
    validatePositiveSafeInteger(opId, 'Outbound delivery op ID');
    validateBoundedRequired(
      identity.conversationKey,
      'Outbound delivery conversation key',
      TURN_RECOVERY_MAX_ID_BYTES,
    );
    validateBoundedRequired(
      identity.deliveryJid,
      'Outbound delivery JID',
      TURN_RECOVERY_MAX_ID_BYTES,
    );
    if (identity.sourceInboundSeq !== null) {
      validatePositiveSafeInteger(identity.sourceInboundSeq, 'Outbound source inbound sequence');
    }
    const row = this.statements.selectOutboundTerminalIdentity.get(opId) as {
      conversation_key: string;
      chat_jid: string;
      source_inbound_seq: number | null;
      status: OutboundStatus;
    } | undefined;
    if (!row) return undefined;
    if (
      row.conversation_key !== identity.conversationKey ||
      row.chat_jid !== identity.deliveryJid ||
      row.source_inbound_seq !== identity.sourceInboundSeq
    ) {
      throw new Error('Selected outbound identity does not match the expected turn identity');
    }
    return { opId, ...identity, status: row.status };
  }

  // ── Echo matching ──
  matchEcho(waMessageId: string): boolean {
    const row = this.statements.selectOutboundForEchoMatch.get(waMessageId) as { id: number } | undefined;
    if (row) {
      this.markEchoed(row.id);
      return true;
    }
    return false;
  }

  // ── Tool calls ──
  recordToolCall(conversationKey: string, toolName: string, toolInput: string, replayPolicy: string, checkpointId?: number): number {
    const result = this.statements.recordToolCall.run(
      conversationKey, checkpointId ?? null, toolName, toolInput, replayPolicy,
    );
    const id = Number(result.lastInsertRowid);
    log.debug({ id, toolName, replayPolicy }, 'recordToolCall');
    return id;
  }

  markToolExecuting(id: number): void {
    this.statements.markToolExecuting.run(id);
  }

  // #1787: isError is a required discriminator, not an optional flag — the
  // three call sites (success, thrown, deny) must each make a conscious
  // choice rather than silently defaulting to 'complete'. This is the single
  // chokepoint that labels every terminal tool-call outcome.
  markToolComplete(id: number, result: string, isError: boolean, outboundOpId?: number): void {
    const status: ToolCallStatus = isError ? 'error' : 'complete';
    this.statements.markToolComplete.run(status, result, outboundOpId ?? null, id);
  }

  // ── Session checkpoints ──
  upsertSessionCheckpoint(conversationKey: string, fields: SessionCheckpointFields): void {
    this.runUpsertSessionCheckpoint(conversationKey, fields);
  }

  beginFreshSessionCheckpoint(conversationKey: string, claudePid?: number): void {
    this.sessionLifecycle.beginFreshCheckpoint(conversationKey, claudePid);
  }

  beginFreshSessionLifecycle(params: BeginFreshSessionLifecycleParams): number {
    return this.sessionLifecycle.beginFreshSessionLifecycle(params);
  }

  getSessionCheckpoint(conversationKey: string): SessionCheckpointRow | undefined {
    return this.statements.getSessionCheckpoint.get(conversationKey) as SessionCheckpointRow | undefined;
  }

  getLatestCompletedCheckpointForSession(sessionId: string): SessionCheckpointRow | undefined {
    return this.statements.getLatestCompletedCheckpointForSession.get(sessionId) as
      SessionCheckpointRow | undefined;
  }

  reactivateSessionLifecycle(params: ReactivateSessionLifecycleParams): number {
    return this.sessionLifecycle.reactivateSessionLifecycle(params);
  }

  /** Atomically retire an exact agent row and all checkpoints for its provider session. */
  retireSessionLifecycle(
    agentSessionRowId: number | undefined,
    providerSessionId: string,
  ): number {
    return this.sessionLifecycle.retireSessionLifecycle(
      agentSessionRowId,
      providerSessionId,
    );
  }

  closeSessionLifecycleFailure(params: CloseSessionLifecycleFailureParams): void {
    this.sessionLifecycle.closeSessionLifecycleFailure(params);
  }

  closeSessionLifecycle(params: CloseSessionLifecycleParams): void {
    this.sessionLifecycle.closeSessionLifecycle(params);
  }

  updateSessionCheckpointsStatusBySessionId(sessionId: string, sessionStatus: string): number {
    return this.sessionLifecycle.updateSessionCheckpointsStatusBySessionId(
      sessionId,
      sessionStatus,
    );
  }

  getAllActiveCheckpoints(): ActiveSessionCheckpointRow[] {
    return this.statements.getAllActiveCheckpoints.all() as unknown as ActiveSessionCheckpointRow[];
  }

  /** Return checkpoints that are active or suspended — candidates for proactive resume on startup. */
  getResumableCheckpoints(): ActiveSessionCheckpointRow[] {
    return this.statements.getResumableCheckpoints.all() as unknown as ActiveSessionCheckpointRow[];
  }

  markSessionOrphaned(conversationKey: string): void {
    this.statements.markSessionOrphaned.run(conversationKey);
  }

  // ── Getters for recovery ──
  getPendingInbound(): InboundEventRow[] {
    return this.statements.getPendingInbound.all() as unknown as InboundEventRow[];
  }

  getOutboundByStatus(status: string): OutboundOpRow[] {
    return this.statements.getOutboundByStatus.all(status) as unknown as OutboundOpRow[];
  }

  // ── Recovery engine ──

  /** Recover interrupted sessions, deliveries, tools, and inbound turns before reconnect. */
  preConnectRecovery(): RecoveryStats {
    log.info('preConnectRecovery: starting');
    const recoveryRun = this.recoveryEvidence.begin(
      'preConnectRecovery',
      'pre_connect_recovery',
      'pre_connect',
      'Pre-connect durability recovery',
    );
    const { receipt: recovery, stats } = recoveryRun;

    // Settle recovery deliveries before generic stuck-inbound handling.
    try {
      for (const opId of this.turnRecovery.getUnsettledEchoedTurnRecoveryOpIds()) {
        this.markEchoed(opId);
      }
    } catch (err) {
      recoveryRun.recordFailure('settle_echoed_recovery_deliveries', err);
      log.warn({ err }, 'preConnectRecovery: error settling already-echoed recovery deliveries');
    }

    // Step 1: Detect orphaned sessions
    try {
      const active = this.getAllActiveCheckpoints();
      for (const checkpoint of active) {
        if (checkpoint.claude_pid == null) continue;
        let alive = false;
        try {
          process.kill(checkpoint.claude_pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (!alive) {
          log.warn(
            { conversationKey: checkpoint.conversation_key, pid: checkpoint.claude_pid },
            'preConnectRecovery: orphaned session detected (pid dead)',
          );
          this.markSessionOrphaned(checkpoint.conversation_key);
        }
      }
    } catch (err) {
      recoveryRun.recordFailure('detect_orphaned_sessions', err);
      log.warn({ err }, 'preConnectRecovery: error during orphan detection');
    }

    // Step 2: Promote all `sending` ops → `maybe_sent`
    try {
      const sending = this.getOutboundByStatus('sending');
      for (const op of sending) {
        this.markMaybeSent(op.id, 'crash-in-flight');
        stats.outboundReconciled += 1;
        log.info({ opId: op.id }, 'preConnectRecovery: promoted sending → maybe_sent');
      }
    } catch (err) {
      recoveryRun.recordFailure('promote_sending_outbound', err);
      log.warn({ err }, 'preConnectRecovery: error promoting sending ops');
    }

    // Step 3: Recover executing and pending tool calls
    try {
      const executingCalls = this.statements.getRecoverableToolCalls.all() as Array<{
        id: number;
        conversation_key: string;
        tool_name: string;
        replay_policy: string;
        outbound_op_id: number | null;
      }>;

      for (const tc of executingCalls) {
        stats.toolCallsRecovered += 1;
        if (tc.outbound_op_id != null) {
          // The linked outbound op owns reconciliation.
          log.info(
            { toolCallId: tc.id, outboundOpId: tc.outbound_op_id },
            'preConnectRecovery: executing tool call has outbound_op_id, delegating to outbound reconciliation',
          );
        } else if (tc.replay_policy === 'safe' || tc.replay_policy === 'read_only') {
          this.statements.markToolReplayed.run(tc.id);
          stats.toolCallsReplayed += 1;
          log.info(
            { toolCallId: tc.id, toolName: tc.tool_name },
            'preConnectRecovery: safe/read_only tool call marked as replayed',
          );
        } else {
          // unsafe without an outbound op: quarantine
          this.statements.markRecoveredToolQuarantined.run(tc.id);
          stats.toolCallsQuarantined += 1;
          log.warn(
            { toolCallId: tc.id, toolName: tc.tool_name, replayPolicy: tc.replay_policy },
            'preConnectRecovery: unsafe tool call quarantined',
          );
        }
      }
    } catch (err) {
      recoveryRun.recordFailure('recover_tool_calls', err);
      log.warn({ err }, 'preConnectRecovery: error recovering tool calls');
    }

    // Step 4: Mark inbound `processing` events with no terminal outbound ops as failed
    try {
      const processingEvents = this.statements.getProcessingInboundEvents.all() as Array<{ seq: number }>;

      for (const ev of processingEvents) {
        // Check if there's any terminal outbound op linked to this inbound
        const terminalOp = this.statements.getTerminalOutboundForInbound.get(ev.seq) as
          { id: number; status: OutboundStatus } | undefined;

        if (!terminalOp) {
          this.recoveryEvidence.recordPending(
            ev.seq,
            recovery,
            'crash_reclaim_no_terminal_outbound',
            () => {
              this.markContinuityCandidate(
                ev.seq,
                'crash_reclaim_no_terminal_outbound',
                'pre_connect_recovery',
              );
              this.markInboundFailed(ev.seq, 'crash_recovery');
            },
          );
          log.info(
            { inboundSeq: ev.seq },
            'preConnectRecovery: inbound processing with no terminal op marked failed',
          );
        } else if (terminalOp.status === 'echoed') {
          // QR-102: delivery is proved; finish the interrupted inbound completion.
          this.completeInbound(ev.seq, 'response_sent');
          log.info(
            { inboundSeq: ev.seq, terminalOpId: terminalOp.id },
            'preConnectRecovery: inbound processing with echoed terminal op finalized (QR-102)',
          );
        } else {
          log.info(
            { inboundSeq: ev.seq, terminalOpId: terminalOp.id },
            'preConnectRecovery: inbound processing with terminal op — leaving for postConnect',
          );
        }
      }
    } catch (err) {
      log.error({ err }, 'preConnectRecovery: unsafe failure recording pending catch-up');
      recoveryRun.failImmediately('record_pending_operator_catchup', err);
    }

    // QR-035: finalize no-reply turns stranded after markTurnDone.
    try {
      const turnDoneEvents = this.statements.getTurnDoneInboundEvents.all() as Array<{ seq: number }>;
      for (const ev of turnDoneEvents) {
        // Non-echoed terminal deliveries remain owned by post-connect recovery.
        const terminalOp = this.statements.getTerminalOutboundForInbound.get(ev.seq) as
          { id: number; status: OutboundStatus } | undefined;
        if (terminalOp) {
          // QR-102: an echoed terminal op proves this stranded turn completed.
          if (terminalOp.status === 'echoed') {
            this.completeInbound(ev.seq, 'response_sent');
            log.info(
              { inboundSeq: ev.seq, terminalOpId: terminalOp.id },
              'preConnectRecovery: stranded turn_done inbound with echoed terminal op finalized (QR-102)',
            );
          }
          continue;
        }
        this.markInboundComplete(ev.seq, 'recovered_turn_done');
        log.info({ inboundSeq: ev.seq }, 'preConnectRecovery: stranded turn_done inbound (no terminal op) finalized to complete');
      }
    } catch (err) {
      recoveryRun.recordFailure('reconcile_turn_done_inbound', err);
      log.warn({ err }, 'preConnectRecovery: error reconciling turn_done inbound events');
    }

    recoveryRun.attestOpenRecoveries();
    recoveryRun.finalize();
    log.info(stats, 'preConnectRecovery: complete');
    return stats;
  }

  postConnectRecovery(): RecoveryStats {
    log.info('postConnectRecovery: starting');
    const recoveryRun = this.recoveryEvidence.begin(
      'postConnectRecovery',
      'post_connect_recovery',
      'post_connect',
      'Post-connect durability recovery',
    );
    const { receipt: recovery, stats } = recoveryRun;
    let corroborated: number;
    try {
      corroborated = this.recoveryEvidence.reconcileDeliveryCorroboration(recovery);
    } catch (err) {
      return recoveryRun.failImmediately('reconcile_turn_delivery_corroboration', err);
    }
    if (corroborated > 0) {
      log.info({ corroborated }, 'postConnectRecovery: recorded later-echo delivery corroboration');
    }

    // Promote only pre-startup submitted ops, then reconcile them in this pass.
    try {
      const staleSubmitted = this.statements.getStaleSubmitted.all() as Array<{ id: number }>;
      for (const op of staleSubmitted) {
        this.markMaybeSent(op.id, 'stale-submitted-no-echo');
        // BEAD-060: the maybe_sent pass is the sole reconciliation counting site.
        log.info(
          { opId: op.id },
          'postConnectRecovery: stale submitted (no echo) promoted to maybe_sent',
        );
      }
    } catch (err) {
      recoveryRun.recordFailure('promote_stale_submitted_outbound', err);
      log.warn({ err }, 'postConnectRecovery: error handling stale submitted ops');
    }

    // Step 2: Reconcile `maybe_sent` ops (includes those just promoted in Step 1)
    try {
      const maybeSent = this.getOutboundByStatus('maybe_sent');
      for (const op of maybeSent) {
        stats.outboundReconciled += 1;

        if (this.recoveryEvidence.hasDeliveryCorroboration(op.id)) {
          log.info(
            { opId: op.id },
            'postConnectRecovery: corroborated selected delivery preserved unchanged',
          );
          continue;
        }

        if (op.wa_message_id) {
          // Check if message was received via normal ingest (echo confirmation)
          const found = this.statements.getMessageByWaMessageId.get(op.wa_message_id) as
            | { pk: number }
            | undefined;

          if (found) {
            this.markEchoed(op.id);
            log.info(
              { opId: op.id, waMessageId: op.wa_message_id },
              'postConnectRecovery: maybe_sent confirmed via messages table → echoed',
            );
          } else if (op.replay_policy === 'safe' || op.replay_policy === 'read_only') {
            // Re-enqueue for replay: reset to pending
            this.statements.resetMaybeSentWithWaToPending.run(op.id);
            stats.outboundReplayed += 1;
            log.info(
              { opId: op.id },
              'postConnectRecovery: maybe_sent not confirmed, safe/read_only → reset to pending for replay',
            );
          } else {
            this.markQuarantined(op.id);
            stats.outboundQuarantined += 1;
            log.warn(
              { opId: op.id, replayPolicy: op.replay_policy },
              'postConnectRecovery: maybe_sent not confirmed, non-safe → quarantined',
            );
            const alertQueued = emitAlertChecked(
              config.botName,
              'outbound_quarantined',
              `whatsoup@${config.botName} outbound op ${op.id} quarantined`,
              `replay_policy=${op.replay_policy} wa_message_id=${op.wa_message_id ?? 'none'} reason=not_confirmed_non_safe`,
            );
            if (!alertQueued) {
              recoveryRun.recordFailure(
                'emit_outbound_quarantine_alert',
                new Error(`outbound quarantine alert could not be durably queued for op ${op.id}`),
              );
            }
          }
        } else {
          // No wa_message_id: definitely not delivered; apply replay policy
          if (op.replay_policy === 'safe' || op.replay_policy === 'read_only') {
            this.statements.resetMaybeSentWithoutWaToPending.run(op.id);
            stats.outboundReplayed += 1;
            log.info(
              { opId: op.id },
              'postConnectRecovery: maybe_sent (no wa_message_id), safe/read_only → reset to pending',
            );
          } else {
            this.markQuarantined(op.id);
            stats.outboundQuarantined += 1;
            log.warn(
              { opId: op.id, replayPolicy: op.replay_policy },
              'postConnectRecovery: maybe_sent (no wa_message_id), non-safe → quarantined',
            );
            const alertQueued = emitAlertChecked(
              config.botName,
              'outbound_quarantined',
              `whatsoup@${config.botName} outbound op ${op.id} quarantined`,
              `replay_policy=${op.replay_policy} wa_message_id=none reason=no_wa_id_non_safe`,
            );
            if (!alertQueued) {
              recoveryRun.recordFailure(
                'emit_outbound_quarantine_alert',
                new Error(`outbound quarantine alert could not be durably queued for op ${op.id}`),
              );
            }
          }
        }
      }
    } catch (err) {
      recoveryRun.recordFailure('reconcile_maybe_sent_outbound', err);
      log.warn({ err }, 'postConnectRecovery: error reconciling maybe_sent ops');
    }

    recoveryRun.attestOpenRecoveries();

    // Require confirmed outbound proof before clearing quarantine; fail safely.
    let quarantineClearRequested = false;
    try {
      const stateDir = join(homedir(), '.local', 'state', 'bot-errors', 'breaker');
      const decision = gateQuarantineClear(config.botName, {
        now: () => (this.statements.selectNow.get() as { now: string }).now,
        stateDir,
        recentWindowSeconds: 900,
        attemptWindowSeconds: 1800,
        tripThreshold: 5,
        confirmedOutboundWithinSeconds: this.confirmedOutboundProbe,
        emitClear: () => { quarantineClearRequested = true; },
        emitEscalation: (evidence: string) => {
          const queued = emitAlertChecked(
            config.botName,
            'auth_terminal',
            `whatsoup@${config.botName} authentication appears unresolved — repair lane cannot restore it`,
            `HUMAN_REQUIRED ${evidence}`,
            'critical',
          );
          if (!queued) {
            throw new Error(
              'postConnectRecovery: quarantine escalation could not be durably queued',
            );
          }
        },
        emitGateFailure: (evidence: string) => {
          const queued = emitAlertChecked(
            config.botName,
            'fleet_health_verify_gate_failed',
            `whatsoup@${config.botName} verify gate failed — quarantine clear suppressed`,
            `FLEET_HEALTH_VERIFY_GATE failure: ${evidence}; clear_suppressed=true`,
            'warning',
          );
          if (!queued) {
            throw new Error(
              'postConnectRecovery: quarantine gate-failure evidence could not be durably queued',
            );
          }
        },
      });
      log.info({ decision }, 'postConnectRecovery: quarantine-clear gate decision');
      if (
        quarantineClearRequested
        && !clearAlertSourceChecked(config.botName, 'outbound_quarantined')
      ) {
        throw new Error('postConnectRecovery: quarantine clear could not be durably queued');
      }
    } catch (err) {
      log.error({ err }, 'postConnectRecovery: quarantine-clear verification failed');
      recoveryRun.failImmediately(
        'verify_quarantine_clear',
        err,
        stats.openRecoveries ?? null,
      );
    }

    recoveryRun.finalize();
    log.info(stats, 'postConnectRecovery: complete');
    return stats;
  }

  /** Promote live outbound ops whose echo window expired. */
  sweepStaleSubmitted(): number {
    const result = this.statements.sweepStaleSubmitted.run();
    const count = Number(result.changes);
    if (count > 0) {
      log.warn({ count }, 'sweepStaleSubmitted: promoted stale submitted ops');
    }
    return count;
  }

  /** Atomically finalize live echoed/no-reply strands and fail stale open turns. */
  sweepStuckInbound(): StuckInboundSweepResult {
    return withTransaction(this.db, () => {
      let completedEchoed = 0;
      let completedTurnDone = 0;
      let failedStale = 0;

      const echoed = this.statements.getOpenInboundWithEchoedTerminal.all() as Array<{ seq: number }>;
      const turnDone = this.statements.getStaleTurnDoneNoSuccess.all() as Array<{ seq: number }>;
      const staleOpen = this.statements.getStaleOpenNoSuccess.all() as Array<{ seq: number }>;
      if (echoed.length === 0 && turnDone.length === 0 && staleOpen.length === 0) {
        return { completedEchoed, completedTurnDone, failedStale };
      }

      const recovery = this.recoveryEvidence.startWithinTransaction(
        'stuck_inbound_sweep',
        'stuck_inbound_sweep',
        'Stuck inbound durability sweep',
      );

      for (const row of echoed) {
        this.completeInbound(row.seq, 'recovered_response_sent');
        completedEchoed += 1;
      }

      for (const row of turnDone) {
        this.markInboundComplete(row.seq, 'recovered_turn_done');
        completedTurnDone += 1;
      }

      for (const row of staleOpen) {
        this.recoveryEvidence.recordPendingWithinTransaction(
          row.seq,
          recovery,
          'stale_reclaim',
          () => this.markInboundFailed(row.seq, 'stale_reclaim'),
        );
        failedStale += 1;
      }

      const result: StuckInboundSweepResult = { completedEchoed, completedTurnDone, failedStale };
      const recoveryStats = createRecoveryStats(recovery);
      recoveryStats.openRecoveries = this.recoveryEvidence.countOpen();
      this.recoveryEvidence.finalize(
        recovery,
        recoveryStats,
        JSON.stringify({ ...result, openRecoveries: recoveryStats.openRecoveries }),
      );
      if (completedEchoed > 0 || completedTurnDone > 0 || failedStale > 0) {
        log.info(result, 'sweepStuckInbound: finalized stuck inbound rows');
      }
      return result;
    });
  }

  getHealthStats(): {
    pendingOutbound: number;
    quarantinedOutbound: number;
    lastRecoveryAt: string | null;
    openRecoveries: number;
  } {
    const pending = this.statements.getPendingOutboundCount.get() as { count: number };
    const quarantined = this.statements.getQuarantinedOutboundCount.get() as { count: number };
    const lastRecovery = this.statements.getLastRecoveryRunCompletedAt.get() as
      | { completed_at: string }
      | undefined;
    return {
      pendingOutbound: pending.count,
      quarantinedOutbound: quarantined.count,
      lastRecoveryAt: lastRecovery?.completed_at ?? null,
      openRecoveries: this.recoveryEvidence.countOpen(),
    };
  }

  /**
   * Insert a recovery_run record with aggregated stats.
   */
  logRecoveryRun(trigger: string, stats: RecoveryStats): void {
    try {
      this.statements.insertRecoveryRun.run(
        trigger,
        stats.inboundReplayed,
        stats.outboundReconciled,
        stats.outboundReplayed,
        stats.outboundQuarantined,
        stats.toolCallsRecovered,
        stats.toolCallsReplayed,
        stats.toolCallsQuarantined,
        stats.sessionsRestored,
      );
      log.info({ trigger, ...stats }, 'logRecoveryRun: inserted');
    } catch (err) {
      log.warn({ err, trigger }, 'logRecoveryRun: failed to insert recovery run');
    }
  }
}

/**
 * Send a message and record it as an outbound op with full durability wiring.
 * Shared helper extracted from admin.ts, health.ts, and chat runtime.
 */
export async function sendTracked(
  messenger: Messenger,
  chatJid: string,
  text: string,
  durability: DurabilityEngine | undefined,
  opts: { replayPolicy: 'safe' | 'unsafe' | 'read_only'; isTerminal?: boolean; sourceInboundSeq?: number; caller?: GuardCaller },
): Promise<void> {
  let opId: number | undefined;
  if (durability) {
    const conversationKey = toConversationKey(chatJid);
    opId = durability.createOutboundOp({
      conversationKey,
      chatJid,
      opType: 'text',
      payload: JSON.stringify({ text }),
      replayPolicy: opts.replayPolicy,
      sourceInboundSeq: opts.sourceInboundSeq,
      isTerminal: opts.isTerminal,
    });
    durability.markSending(opId);
  }
  try {
    // QR-086: forward an optional infra caller token to the guard so a
    // health-server admin /send to a cold target is not floored (spec §4.2-B).
    // Keep the common path a 2-arg call (no trailing undefined).
    const receipt = opts.caller
      ? await messenger.sendMessage(chatJid, text, { caller: opts.caller })
      : await messenger.sendMessage(chatJid, text);
    if (opId !== undefined && durability) {
      durability.markSubmitted(opId, receipt.waMessageId);
    }
  } catch (err) {
    if (opId !== undefined && durability) {
      durability.markMaybeSent(opId, (err as Error)?.message ?? 'send_failed');
    }
    throw err;
  }
}

/** Drain replay-safe pending text ops; quarantine malformed ops and isolate failures. */
export async function drainPendingOutbound(
  messenger: Messenger,
  durability: DurabilityEngine,
): Promise<number> {
  const pending = durability.getOutboundByStatus('pending');
  let resent = 0;

  for (const op of pending) {
    try {
      let text: string | undefined;
      if (op.op_type === 'text') {
        try {
          const parsed = JSON.parse(op.payload) as unknown;
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as { text?: unknown }).text === 'string'
          ) {
            text = (parsed as { text: string }).text;
          }
        } catch {
          text = undefined;
        }
      }

      if (text === undefined) {
        // Non-reconstructable: cannot faithfully rebuild the send. Quarantine +
        // alert rather than leave it pending forever (BEAD-057 non-text guard).
        durability.markQuarantined(op.id);
        log.warn(
          { opId: op.id, opType: op.op_type, replayPolicy: op.replay_policy },
          'drainPendingOutbound: pending op not reconstructable → quarantined',
        );
        emitAlertChecked(
          config.botName,
          'outbound_quarantined',
          `whatsoup@${config.botName} outbound op ${op.id} quarantined`,
          `replay_policy=${op.replay_policy} op_type=${op.op_type} reason=pending_replay_unreconstructable`,
        );
        continue;
      }

      if (!durability.markSending(op.id)) {
        // Another concurrent drain (the un-serialized recover callback vs. the
        // echo-timeout interval) already claimed this op out of `pending` from
        // an overlapping stale snapshot. Skip — re-sending here is the BEAD-057
        // double-send. The winning drain owns the send.
        continue;
      }
      try {
        const receipt = await messenger.sendMessage(op.chat_jid, text);
        durability.markSubmitted(op.id, receipt.waMessageId);
        resent += 1;
        log.info(
          { opId: op.id, waMessageId: receipt.waMessageId },
          'drainPendingOutbound: pending op re-sent → submitted',
        );
      } catch (err) {
        // Re-enter the reconnect-paced recovery loop; do NOT tight-loop / retry inline.
        durability.markMaybeSent(op.id, (err as Error)?.message ?? 'replay_failed');
        log.warn(
          { opId: op.id, err },
          'drainPendingOutbound: re-send failed → maybe_sent (recoverable)',
        );
      }
    } catch (err) {
      // Defensive: one malformed op must never abort the rest of the drain.
      log.warn({ opId: op.id, err }, 'drainPendingOutbound: unexpected error draining op');
    }
  }

  if (pending.length > 0) {
    log.info({ pending: pending.length, resent }, 'drainPendingOutbound: complete');
  }
  return resent;
}

/**
 * Build a probe that answers "was any outbound op confirmed delivered within
 * the last N seconds?". A delivered agent message implies a successful
 * authenticated model completion — the genuine-recovery proof for auth_terminal.
 *
 * NOTE: this repo uses node:sqlite (DatabaseSync), not better-sqlite3. Pass the
 * raw handle (`db.raw`). DatabaseSync prepared statements bind positional `?`
 * params via `.get(...)` just like better-sqlite3.
 */
export function makeConfirmedOutboundProbe(
  db: DatabaseSync,
): (seconds: number) => boolean {
  const stmt = db.prepare(
    `SELECT 1 AS ok FROM outbound_ops
      WHERE echoed_at IS NOT NULL AND echoed_at >= datetime('now', ?)
      LIMIT 1`,
  );
  return (seconds: number) => {
    const row = stmt.get(`-${Math.max(0, Math.floor(seconds))} seconds`) as
      | { ok: number }
      | undefined;
    return row?.ok === 1;
  };
}
