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
import { getImmediateTransactionRunner, withImmediateTransaction, withTransaction } from './db-tx.ts';
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
  normalizeToolDurabilityGroup,
  TOOL_INPUT_MARKER,
  TOOL_RESULT_MARKERS,
  type ToolCompletionEvidence,
} from './durability-evidence-contract.ts';
import {
  SessionLifecycleStore,
  type BeginFreshSessionLifecycleParams,
  type CloseSessionLifecycleFailureParams,
  type CloseSessionLifecycleParams,
  type CompletedDeliveryIdentityAdmissionReason,
  type QuarantineCompletedDeliveryIdentityAgentSessionParams,
  type QuarantineCompletedDeliveryIdentityCheckpointParams,
  type ReactivateSessionLifecycleParams,
  type RetireExactSessionLifecycleParams,
  type RetireSessionLifecycleParams,
  type UpdateExactSessionCheckpointStatusParams,
} from './session-lifecycle-store.ts';
import {
  classifyOutboundFailure,
  classifyOutboundQuarantineDisposition,
  createInternalOutboundFailureEvidence,
  decodeOutboundFailureEvidence,
  encodeOutboundFailureEvidence,
  OUTBOUND_FAILURE_EVIDENCE_SCHEMA,
  OUTBOUND_EVIDENCE_COVERAGE,
  OUTBOUND_QUARANTINE_DISPOSITION_POLICIES,
  OUTBOUND_QUARANTINE_DISPOSITIONS,
  type DecodedOutboundFailureEvidence,
  type OutboundEvidenceCoverage,
  type OutboundFailureEvidenceV1,
  type OutboundQuarantineDisposition,
  transferOutboundRetryOwnership,
} from './outbound-failure-disposition.ts';
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
export type {
  CompletedDeliveryIdentityAdmissionReason,
  QuarantineCompletedDeliveryIdentityAgentSessionParams,
  QuarantineCompletedDeliveryIdentityCheckpointParams,
} from './session-lifecycle-store.ts';

export interface CompletedDeliveryIdentityAdmissionHealth {
  unresolvedCount: number;
  oldestTransitionAt: string | null;
  maximumAttempts: number;
  nextAction: 'fresh_inbound' | 'operator' | null;
}

const log = createChildLogger('durability');

/**
 * PR-C: max age a `status_ping` op may sit in `pending` before the drain ages it
 * out (quarantine + alert) instead of re-sending. A "back online" notice older
 * than this is stale misinformation, so dropping it is correct. Strictly scoped
 * to `op_type='status_ping'` — `text` ops have no age gate.
 */
const STATUS_OP_TTL_MS = 30 * 60 * 1000;

/**
 * PR-C: max deferrals for a `text` op before the drain quarantines it instead of
 * re-deferring indefinitely. A persistently rate-limited conversation that keeps
 * hitting `retry_not_before` will accumulate pending rows with no terminal state.
 * This bound ensures the system fails loud through its bounded quarantine
 * disposition and alert pathway rather than accumulating silently.
 *
 * `status_ping` ops are exempt — they have their own TTL age-out above.
 * `failed_permanent` is a separate terminal path for non-retryable failures.
 */
const MAX_TEXT_OP_DEFERRAL_COUNT = 20;

/**
 * Emits only bounded taxonomy data. A quarantined outbound record can contain
 * user content or provider diagnostics in its durable payload, so neither is
 * included in the operator-facing alert.
 */
function emitOutboundQuarantineAlert(evidence: OutboundFailureEvidenceV1): boolean {
  const disposition = classifyOutboundQuarantineDisposition(evidence);
  const policy = OUTBOUND_QUARANTINE_DISPOSITION_POLICIES[disposition];
  return emitAlertChecked(
    config.botName,
    policy.alertSource,
    `whatsoup@${config.botName} ${policy.alertSummary}`,
    `disposition=${disposition} failure_code=${evidence.failure_code} evidence_coverage=${evidence.evidence_coverage}`,
    policy.alertSeverity,
  );
}

// ── Status string unions ──

const OUTBOUND_STATUSES = [
  'pending',
  'sending',
  'submitted',
  'echoed',
  'maybe_sent',
  'failed_permanent',
  'quarantined',
] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];
export type InboundStatus = 'pending' | 'processing' | 'turn_done' | 'complete' | 'failed';
export type SessionStatus = 'active' | 'suspended' | 'orphaned' | 'ended';

type OutboundQuarantineEvidenceCoverage =
  | OutboundEvidenceCoverage
  | 'legacy_unclassified';

function normalizeOutboundStatus(value: unknown): OutboundStatus | 'unknown' {
  return typeof value === 'string' && (OUTBOUND_STATUSES as readonly string[]).includes(value)
    ? value as OutboundStatus
    : 'unknown';
}

function normalizeOutboundQuarantineDisposition(
  value: unknown,
): OutboundQuarantineDisposition {
  return typeof value === 'string'
    && (OUTBOUND_QUARANTINE_DISPOSITIONS as readonly string[]).includes(value)
    ? value as OutboundQuarantineDisposition
    : 'legacy_unclassified';
}

function normalizeOutboundQuarantineEvidenceCoverage(
  value: unknown,
): OutboundQuarantineEvidenceCoverage {
  return typeof value === 'string'
    && (OUTBOUND_EVIDENCE_COVERAGE as readonly string[]).includes(value)
    ? value as OutboundEvidenceCoverage
    : 'legacy_unclassified';
}

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
  status: OutboundStatus;
  chat_jid: string;
  op_type: string;
  payload: string;
  wa_message_id: string | null;
  replay_policy: string;
  created_at: string;
  submitted_at: string | null;
  ambiguity_at: string | null;
  source_inbound_seq: number | null;
  retry_count: number;
  error: string | null;
  failure_evidence: DecodedOutboundFailureEvidence;
  is_terminal: number;
}

/**
 * Derive the age of the active ambiguity episode without treating missing or
 * malformed or future chronology as a fresh delivery. Existing rows without
 * the new clock fall back conservatively to their recorded submission, then
 * creation.
 */
function maybeSentDwellAtSql(prefix = ''): string {
  const column = (name: string) => `${prefix}${name}`;
  // The fallback must be older than the /health durability-debt window as
  // well as the live 30-second reconciliation grace. Re-evaluating this
  // bounded sentinel keeps malformed or future chronology visible without
  // inventing a durable event time.
  const stale = "datetime('now', '-31 minutes')";
  return `CASE
    WHEN ${column('ambiguity_at')} IS NOT NULL
      AND datetime(${column('ambiguity_at')}) IS NOT NULL
      AND datetime(${column('ambiguity_at')}) <= datetime('now')
      THEN datetime(${column('ambiguity_at')})
    WHEN ${column('ambiguity_at')} IS NOT NULL THEN ${stale}
    WHEN ${column('submitted_at')} IS NOT NULL
      AND datetime(${column('submitted_at')}) IS NOT NULL
      AND datetime(${column('submitted_at')}) <= datetime('now')
      THEN datetime(${column('submitted_at')})
    WHEN ${column('submitted_at')} IS NOT NULL THEN ${stale}
    WHEN datetime(${column('created_at')}) IS NOT NULL
      AND datetime(${column('created_at')}) <= datetime('now')
      THEN datetime(${column('created_at')})
    ELSE ${stale}
  END`;
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
  /**
   * #1749: inbound rows released from the recovery-owner trap — pinned by a
   * `transferred_to_recovery_owner` terminal record whose selected op is
   * terminally non-echoed (`failed_permanent`/`quarantined`) or whose recovery
   * job is `exhausted`. Failed `recovery_owner_reclaimed`, with any pending/
   * claimed owning job driven to `exhausted` so the scope becomes admissible.
   */
  reclaimedRecoveryOwned: number;
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

export interface OutboundFailureHealthGroup {
  failureCode: string;
  stage: string;
  mutationState: string;
  evidenceCoverage: string;
  terminalState: string;
  retryDecision: string;
  retryOwner: string;
  remainingDelayBucket: string;
  nextEligibleAt: string | null;
  providerSubmissionCount: number;
  count: number;
}

export interface OutboundFailureHealthProjection {
  sampledRows: number;
  groups: OutboundFailureHealthGroup[];
}

export interface OutboundQuarantineDispositionHealthGroup {
  disposition: OutboundQuarantineDisposition;
  evidenceCoverage: OutboundQuarantineEvidenceCoverage;
  count: number;
}

export interface OutboundQuarantineDispositionHealthProjection {
  /** Exact quarantined-row total; this is not a sampled failure-evidence view. */
  total: number;
  groups: OutboundQuarantineDispositionHealthGroup[];
}

type PreparedStatement = ReturnType<Database['raw']['prepare']>;

type DurabilityStatements = {
  journalInbound: PreparedStatement;
  markTurnDone: PreparedStatement;
  markInboundComplete: PreparedStatement;
  markInboundFailed: PreparedStatement;
  markInboundFailedIfProcessing: PreparedStatement;
  markContinuityCandidate: PreparedStatement;
  markContinuityCandidateIfUnownedAndNoTerminalOutbound: PreparedStatement;
  markInboundSkipped: PreparedStatement;
  selectInboundStatus: PreparedStatement;
  selectInboundReceipt: PreparedStatement;
  recordTurnTerminal: PreparedStatement;
  getTurnTerminal: PreparedStatement;
  createOutboundOp: PreparedStatement;
  selectOutstandingStatus: PreparedStatement;
  markSupersededStatus: PreparedStatement;
  markSending: PreparedStatement;
  markSubmitted: PreparedStatement;
  markEchoed: PreparedStatement;
  selectEchoedOutboundInbound: PreparedStatement;
  markMaybeSent: PreparedStatement;
  markFailedPermanent: PreparedStatement;
  markDeferred: PreparedStatement;
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
  getLiveReconcileMaybeSent: PreparedStatement;
  getRecoverableToolCalls: PreparedStatement;
  markToolReplayed: PreparedStatement;
  markRecoveredToolQuarantined: PreparedStatement;
  getProcessingInboundEvents: PreparedStatement;
  getTurnDoneInboundEvents: PreparedStatement;
  getTerminalOutboundForInbound: PreparedStatement;
  getOpenInboundWithEchoedTerminal: PreparedStatement;
  getStaleTurnDoneNoSuccess: PreparedStatement;
  getStaleOpenNoSuccess: PreparedStatement;
  getRecoveryOwnedReclaimable: PreparedStatement;
  getStaleSubmitted: PreparedStatement;
  getMessageByWaMessageId: PreparedStatement;
  resetMaybeSentWithWaToPending: PreparedStatement;
  resetMaybeSentWithoutWaToPending: PreparedStatement;
  getPendingOutboundCount: PreparedStatement;
  getQuarantinedOutboundCount: PreparedStatement;
  getQuarantinedOutboundDispositionGroups: PreparedStatement;
  getQuarantineClearContributorCounts: PreparedStatement;
  getMaybeSentOutboundCount: PreparedStatement;
  getOldestMaybeSentSubmittedAt: PreparedStatement;
  getRecentOutboundFailureEvidence: PreparedStatement;
  getLastRecoveryRunCompletedAt: PreparedStatement;
  getCompletedDeliveryIdentityAdmissionHealth: PreparedStatement;
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
        `INSERT INTO inbound_events (
           message_id, conversation_key, chat_jid, routed_to, processing_status, received_at
         )
         VALUES (?, ?, ?, ?, 'processing', COALESCE(datetime(?, 'unixepoch'), datetime('now')))`,
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
      markInboundFailedIfProcessing: prepare(
        `UPDATE inbound_events
         SET processing_status = 'failed',
             completed_at = datetime('now'),
             terminal_reason = 'error',
             failure_class = ?
         WHERE seq = ?
           AND message_id = ?
           AND chat_jid = ?
           AND processing_status = 'processing'`,
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
      selectInboundReceipt: prepare(
        `SELECT unixepoch(received_at) AS received_at_unix_seconds
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
      // PR-C: one outstanding status ping per chat. Enqueuing a new status_ping
      // marks any prior non-terminal status_ping for the same chat
      // failed_permanent/superseded (a terminal state retention already reclaims),
      // so a re-pair / crash-loop cannot flush a backlog of stale "back online"
      // notices in one burst. Scoped strictly to op_type='status_ping' — never
      // touches 'text' ops (user replies, admin responses, isResume continuity).
      selectOutstandingStatus: prepare(
        `SELECT id, status, retry_count, error
         FROM outbound_ops
         WHERE chat_jid = ? AND op_type = 'status_ping'
           AND status IN ('pending', 'sending', 'submitted', 'maybe_sent')`,
      ),
      markSupersededStatus: prepare(
        `UPDATE outbound_ops
         SET status = ?, error = ?, retry_count = MAX(retry_count, ?)
         WHERE id = ? AND status = ?`,
      ),
      markSending: prepare(
        `UPDATE outbound_ops SET status = 'sending' WHERE id = ? AND status = 'pending'`,
      ),
      markSubmitted: prepare(
        `UPDATE outbound_ops
         SET status = 'submitted', wa_message_id = ?, submitted_at = datetime('now'),
             error = NULL, retry_count = MAX(retry_count, ?)
         WHERE id = ?`,
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
        `UPDATE outbound_ops
         SET status = 'maybe_sent',
             ambiguity_at = CASE
               WHEN status = 'maybe_sent' THEN ambiguity_at
               ELSE datetime('now')
             END,
             error = ?, wa_message_id = COALESCE(?, wa_message_id),
             retry_count = MAX(retry_count, ?)
         WHERE id = ?
           AND status IN ('pending', 'sending', 'submitted', 'maybe_sent')`,
      ),
      markFailedPermanent: prepare(
        `UPDATE outbound_ops
         SET status = 'failed_permanent', error = ?, retry_count = MAX(retry_count, ?)
         WHERE id = ?
           AND status IN ('pending', 'sending', 'submitted', 'maybe_sent')`,
      ),
      markDeferred: prepare(
        `UPDATE outbound_ops
         SET status = 'pending', error = ?, retry_count = MAX(retry_count, ?)
         WHERE id = ? AND status IN ('pending', 'sending')`,
      ),
      markQuarantined: prepare(
        `UPDATE outbound_ops
         SET status = 'quarantined',
             error = ?,
             retry_count = MAX(retry_count, ?),
             quarantine_disposition = ?,
             quarantine_evidence_coverage = ?,
             quarantine_evidence_sha256 = ?,
             quarantined_at = datetime('now')
         WHERE id = ?
           AND status IN ('pending', 'sending', 'submitted', 'maybe_sent')`,
      ),
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
        `INSERT INTO tool_calls (
           conversation_key, session_checkpoint_id, tool_name, tool_group,
           tool_input, status, replay_policy, outcome_code,
           retry_disposition, operator_action, evidence_coverage
         )
         VALUES (?, ?, ?, ?, ?, 'pending', ?, 'not_terminal',
                 'not_applicable', 'none', 'complete')`,
      ),
      markToolExecuting: prepare(`UPDATE tool_calls SET status = 'executing' WHERE id = ?`),
      markToolComplete: prepare(
        `UPDATE tool_calls
         SET status = ?,
             result = ?,
             completed_at = datetime('now'),
             outbound_op_id = ?,
             outcome_code = ?,
             failure_code = ?,
             failure_stage = ?,
             retry_disposition = ?,
             operator_action = ?,
             evidence_coverage = ?,
             duration_ms = ?
         WHERE id = ?`,
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
          AND NOT EXISTS (
            SELECT 1
            FROM completed_delivery_identity_admissions AS admission
            WHERE admission.target_kind = 'checkpoint'
              AND admission.target_id = session_checkpoints.id
              AND admission.state = 'quarantined'
          )
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
         WHERE session_status IN ('active', 'suspended')
           AND session_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM completed_delivery_identity_admissions AS admission
             WHERE admission.target_kind = 'checkpoint'
               AND admission.target_id = session_checkpoints.id
               AND admission.state = 'quarantined'
           )`,
      ),
      markSessionOrphaned: prepare(
        `UPDATE session_checkpoints SET session_status = 'orphaned', updated_at = datetime('now') WHERE conversation_key = ?`,
      ),
      getPendingInbound: prepare(
        `SELECT seq, message_id, processing_status, routed_to FROM inbound_events WHERE processing_status IN ('pending', 'processing', 'turn_done')`,
      ),
      getOutboundByStatus: prepare(
        `SELECT id, status, chat_jid, op_type, payload, wa_message_id, replay_policy,
                created_at, submitted_at, ambiguity_at, source_inbound_seq, retry_count, error, is_terminal
         FROM outbound_ops WHERE status = ? ORDER BY id ASC`,
      ),
      getLiveReconcileMaybeSent: prepare(
        `SELECT o.id, o.status, o.chat_jid, o.op_type, o.payload, o.wa_message_id,
                o.replay_policy, o.created_at, o.submitted_at, o.ambiguity_at, o.source_inbound_seq,
                o.retry_count, o.error, o.is_terminal
         FROM outbound_ops o
         WHERE o.status = 'maybe_sent'
           AND ${maybeSentDwellAtSql('o.')} < datetime('now', '-30 seconds')
           AND NOT EXISTS (
             SELECT 1
             FROM turn_terminal_records t
             JOIN turn_delivery_corroboration c ON c.terminal_record_id = t.id
             WHERE t.delivery_op_id = o.id
           )
         ORDER BY o.id ASC
         LIMIT 200`,
      ),
      getRecoverableToolCalls: prepare(
        `SELECT id, conversation_key, tool_name, replay_policy, outbound_op_id
         FROM tool_calls WHERE status IN ('executing', 'pending')`,
      ),
      markToolReplayed: prepare(
        `UPDATE tool_calls
         SET status = 'replayed',
             result = ?,
             completed_at = datetime('now'),
             outcome_code = 'recovered_replayed',
             failure_code = NULL,
             failure_stage = NULL,
             retry_disposition = 'not_applicable',
             operator_action = 'none',
             evidence_coverage = 'complete',
             duration_ms = NULL
         WHERE id = ?`,
      ),
      markRecoveredToolQuarantined: prepare(
        `UPDATE tool_calls
         SET status = 'quarantined',
             result = ?,
             completed_at = datetime('now'),
             outcome_code = 'recovery_quarantined',
             failure_code = 'unknown',
             failure_stage = 'recovery',
             retry_disposition = 'not_retryable',
             operator_action = 'inspect',
             evidence_coverage = 'partial',
             duration_ms = NULL
         WHERE id = ?`,
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
      // #1749 recovery-owner reclaim bucket. The three buckets above deliberately
      // require NOT EXISTS turn_terminal_records, so a `transferred_to_recovery_owner`
      // record excludes its inbound from every one of them. This bucket is the exact
      // inverse: an open inbound WHOSE terminal record transferred to a recovery owner
      // whose selected op is provably dead (`failed_permanent`/`quarantined`) — so it
      // can never echo-settle — or whose linked recovery job is already `exhausted`.
      // Such a row is otherwise unreclaimable, so once past the grace window below this
      // bucket is its only path. `completed` jobs are excluded (their inbound completed
      // via echo settlement; a completed source may never leave terminal, per the
      // turn_recovery_completed_source_stays_terminal trigger). An echoed terminal op
      // still wins (mutual exclusion with bucket 1). #1833: gated on the same
      // `-5 minutes` min-age window as bucket 1 — a `failed_permanent`/`quarantined` op
      // is NOT terminal for echo (selectOutboundForEchoMatch still accepts it as a
      // late-echo candidate), so a genuine echo can still arrive and re-settle the op;
      // the grace window (measured from received_at, like every sibling bucket) lets a
      // late echo land before the reclaim records the turn a failure. Bounded to 200.
      getRecoveryOwnedReclaimable: prepare(
        `SELECT DISTINCT i.seq AS seq, j.id AS job_id, j.state AS job_state
         FROM inbound_events i
         JOIN turn_terminal_records t
           ON t.inbound_seq_key = i.seq
          AND t.inbound_disposition = 'transferred_to_recovery_owner'
         JOIN outbound_ops o ON o.id = t.delivery_op_id
         JOIN turn_recovery_jobs j ON j.terminal_record_id = t.id
         WHERE i.processing_status IN ('pending', 'processing', 'turn_done')
           AND i.received_at < datetime('now', '-5 minutes')
           AND j.state <> 'completed'
           AND (
             o.status IN ('failed_permanent', 'quarantined')
             OR j.state = 'exhausted'
           )
           AND NOT EXISTS (
             SELECT 1 FROM outbound_ops e
             WHERE e.source_inbound_seq = i.seq AND e.is_terminal = 1 AND e.status = 'echoed'
           )
         ORDER BY i.seq ASC
         LIMIT 200`,
      ),
      getStaleSubmitted: prepare(
        `SELECT id, status, chat_jid, op_type, payload, wa_message_id, replay_policy,
                created_at, submitted_at, ambiguity_at, source_inbound_seq, retry_count, error, is_terminal
         FROM outbound_ops
         WHERE status = 'submitted' AND submitted_at < datetime('now', '-30 seconds')`,
      ),
      getMessageByWaMessageId: prepare(
        `SELECT pk FROM messages WHERE message_id = ?`,
      ),
      resetMaybeSentWithWaToPending: prepare(
        `UPDATE outbound_ops
         SET status = 'pending', error = ?, retry_count = MAX(retry_count, ?)
         WHERE id = ? AND status = 'maybe_sent'`,
      ),
      resetMaybeSentWithoutWaToPending: prepare(
        `UPDATE outbound_ops
         SET status = 'pending', error = ?, retry_count = MAX(retry_count, ?)
         WHERE id = ? AND status = 'maybe_sent'`,
      ),
      getPendingOutboundCount: prepare(
        `SELECT COUNT(*) as count FROM outbound_ops WHERE status IN ('pending', 'sending', 'submitted', 'maybe_sent')`,
      ),
      getMaybeSentOutboundCount: prepare(
        `SELECT COUNT(*) as count FROM outbound_ops WHERE status = 'maybe_sent'`,
      ),
      // A current ambiguity episode owns its own dwell clock. Legacy rows use
      // the conservative receipt/queue fallback, while malformed chronology is
      // deliberately stale so it cannot make health read fresh.
      getOldestMaybeSentSubmittedAt: prepare(
        `SELECT MIN(${maybeSentDwellAtSql()}) as at FROM outbound_ops WHERE status = 'maybe_sent'`,
      ),
      getRecentOutboundFailureEvidence: prepare(
        `SELECT status, error
         FROM outbound_ops
         WHERE error IS NOT NULL
         ORDER BY id DESC
         LIMIT 500`,
      ),
      getQuarantinedOutboundCount: prepare(
        `SELECT COUNT(*) as count FROM outbound_ops WHERE status = 'quarantined'`,
      ),
      getQuarantinedOutboundDispositionGroups: prepare(
        `SELECT
           CASE quarantine_disposition
             WHEN 'delivery_ambiguous_unsafe' THEN 'delivery_ambiguous_unsafe'
             WHEN 'delivery_not_attempted' THEN 'delivery_not_attempted'
             WHEN 'record_unreconstructable' THEN 'record_unreconstructable'
             WHEN 'stale_status_discarded' THEN 'stale_status_discarded'
             ELSE 'legacy_unclassified'
           END AS quarantine_disposition,
           CASE quarantine_evidence_coverage
             WHEN 'complete' THEN 'complete'
             WHEN 'partial' THEN 'partial'
             ELSE 'legacy_unclassified'
           END AS quarantine_evidence_coverage,
           COUNT(*) AS count
         FROM outbound_ops
         WHERE status = 'quarantined'
         GROUP BY 1, 2`,
      ),
      getQuarantineClearContributorCounts: prepare(
        `SELECT
           CASE quarantine_disposition
             WHEN 'delivery_ambiguous_unsafe' THEN 'delivery_ambiguous_unsafe'
             WHEN 'delivery_not_attempted' THEN 'delivery_not_attempted'
             WHEN 'record_unreconstructable' THEN 'record_unreconstructable'
             WHEN 'stale_status_discarded' THEN 'stale_status_discarded'
             ELSE 'legacy_unclassified'
           END AS quarantine_disposition,
           COUNT(*) AS count
         FROM outbound_ops
         WHERE status = 'quarantined'
            OR (
              status = 'failed_permanent'
              AND quarantined_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM outbound_quarantine_retirements retirement
                 WHERE retirement.outbound_op_id = outbound_ops.id
                   AND retirement.quarantine_disposition = outbound_ops.quarantine_disposition
                   AND (
                     (retirement.quarantine_disposition = 'delivery_ambiguous_unsafe'
                       AND retirement.acknowledgement = 'delivery-risk-reviewed')
                     OR (retirement.quarantine_disposition = 'record_unreconstructable'
                       AND retirement.acknowledgement = 'record-reconstruction-reviewed')
                     OR (retirement.quarantine_disposition IN ('delivery_not_attempted', 'stale_status_discarded')
                       AND retirement.acknowledgement = 'none')
                  )
                  AND retirement.evidence_sha256 = outbound_ops.quarantine_evidence_sha256
                  AND length(outbound_ops.quarantine_evidence_sha256) = 64
                  AND outbound_ops.quarantine_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
                  AND length(retirement.evidence_sha256) = 64
                   AND retirement.evidence_sha256 NOT GLOB '*[^0-9a-f]*'
              )
            )
         GROUP BY 1`,
      ),
      getLastRecoveryRunCompletedAt: prepare(
        `SELECT completed_at FROM recovery_runs ORDER BY id DESC LIMIT 1`,
      ),
      getCompletedDeliveryIdentityAdmissionHealth: prepare(`
        SELECT COUNT(*) AS unresolved_count,
               MIN(last_transition_at) AS oldest_transition_at,
               MAX(attempts) AS maximum_attempts,
               CASE
                 WHEN MAX(CASE WHEN next_action = 'operator' THEN 1 ELSE 0 END) = 1
                   THEN 'operator'
                 WHEN COUNT(*) > 0 THEN 'fresh_inbound'
                 ELSE NULL
               END AS next_action
        FROM completed_delivery_identity_admissions
        WHERE state = 'quarantined'
      `),
      // #1789 companion fix: this INSERT sets completed_at at write time but
      // (until now) never set status, so under migration 45's
      // status DEFAULT 'started' a row born here was self-contradictory —
      // already completed_at-stamped while reading status='started' forever.
      // logRecoveryRun() is a synchronous, single-statement aggregate-stats
      // log (no separate "start" phase to record), so 'completed' is correct
      // at insert time, not a later transition.
      insertRecoveryRun: prepare(`
        INSERT INTO recovery_runs
          (trigger, inbound_replayed, outbound_reconciled, outbound_replayed,
           outbound_quarantined, tool_calls_recovered, tool_calls_replayed,
           tool_calls_quarantined, sessions_restored, completed_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'completed')
      `),
      selectNow: prepare(`SELECT datetime('now') AS now`),
    };
    this.recoveryEvidence = new DurabilityRecoveryEvidence(db);
    this.turnRecovery = new TurnRecoveryStore(db, () => (
      this.statements.selectNow.get() as { now: string }
    ).now);
    this.sessionLifecycle = new SessionLifecycleStore(db);
    this.confirmedOutboundProbe = makeConfirmedOutboundProbe(db.raw);
    // Pre-warm the immediate-transaction runner so lifecycle methods that call
    // withImmediateTransaction reuse cached BEGIN IMMEDIATE / COMMIT / ROLLBACK
    // instead of preparing them on first invocation (#2560).
    getImmediateTransactionRunner(db);
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
  journalInbound(
    messageId: string,
    conversationKey: string,
    chatJid: string,
    routedTo: string,
    receivedAtUnixSeconds?: number,
  ): number {
    if (
      receivedAtUnixSeconds !== undefined
      && (
        !Number.isSafeInteger(receivedAtUnixSeconds)
        || receivedAtUnixSeconds < 0
        || receivedAtUnixSeconds > 253_402_300_799
      )
    ) {
      throw new Error('Inbound receipt timestamp must be within the SQLite Unix timestamp range');
    }
    const result = this.statements.journalInbound.run(
      messageId,
      conversationKey,
      chatJid,
      routedTo,
      receivedAtUnixSeconds ?? null,
    );
    const seq = Number(result.lastInsertRowid);
    log.debug({ seq, messageId, routedTo }, 'journalInbound');
    return seq;
  }

  getInboundReceivedAtUnixSeconds(seq: number): number | undefined {
    const row = this.statements.selectInboundReceipt.get(seq) as {
      received_at_unix_seconds: number;
    } | undefined;
    return Number.isSafeInteger(row?.received_at_unix_seconds)
      ? row?.received_at_unix_seconds
      : undefined;
  }

  markTurnDone(seq: number): void {
    this.statements.markTurnDone.run(seq);
  }

  getInboundStatus(seq: number): InboundStatus | undefined {
    const row = this.statements.selectInboundStatus.get(seq) as { processing_status: InboundStatus } | undefined;
    return row?.processing_status;
  }

  markInboundComplete(seq: number, terminalReason: string): void {
    this.statements.markInboundComplete.run(terminalReason, seq);
  }

  markInboundFailed(seq: number, failureClass?: InboundFailureClass): void {
    this.statements.markInboundFailed.run(coerceInboundFailureClass(failureClass), seq);
  }

  /** Fail exactly the processing inbound owned by the supplied runtime message. */
  markInboundFailedIfProcessing(
    seq: number,
    messageId: string,
    chatJid: string,
    failureClass?: InboundFailureClass,
  ): boolean {
    return this.statements.markInboundFailedIfProcessing.run(
      coerceInboundFailureClass(failureClass),
      seq,
      messageId,
      chatJid,
    ).changes === 1;
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

  getTurnRecoveryOriginalDeliveryStatus(jobId: number): { outboundStatus: string } | undefined {
    return this.turnRecovery.getTurnRecoveryOriginalDeliveryStatus(jobId);
  }

  getTurnRecoverySourceProof(jobId: number): { processingStatus: string; outboundStatus: string } | undefined {
    return this.turnRecovery.getTurnRecoverySourceProof(jobId);
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
    options?: { excludeJobId?: number },
  ): boolean {
    return this.turnRecovery.hasOutstandingTurnRecoveryForScope(scope, conversationKey, options);
  }

  // ── Outbound ops ──
  createOutboundOp(params: OutboundOpParams): number {
    const hash = createHash('sha256').update(params.payload).digest('hex');
    // PR-C supersede-on-enqueue: collapse to one outstanding status ping per chat.
    if (params.opType === 'status_ping') {
      const outstanding = this.statements.selectOutstandingStatus.all(params.chatJid) as Array<{
        id: number;
        status: Extract<OutboundStatus, 'pending' | 'sending' | 'submitted' | 'maybe_sent'>;
        retry_count: number;
        error: string | null;
      }>;
      for (const row of outstanding) {
        const decoded = decodeOutboundFailureEvidence(row.error);
        const previous = decoded.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
          ? decoded
          : undefined;
        const mutationState = row.status === 'pending'
          ? 'not_started'
          : row.status === 'submitted'
            ? 'submitted'
            : 'ambiguous';
        const logicalAttemptCount = row.status === 'sending'
          ? row.retry_count + 1
          : row.status === 'submitted'
            ? Math.max(row.retry_count, 1)
            : row.retry_count;
        const providerSubmissionCount = row.status === 'sending'
          ? Math.min(
            logicalAttemptCount,
            (previous?.provider_submission_count ?? row.retry_count) + 1,
          )
          : row.status === 'submitted'
            ? Math.max(previous?.provider_submission_count ?? 0, 1)
            : previous?.provider_submission_count ?? Math.min(row.retry_count, 1);
        const evidence = createInternalOutboundFailureEvidence({
          failureCode: 'outbound.superseded',
          stage: 'runtime',
          mutationState,
          logicalAttemptCount,
          providerSubmissionCount,
          previousEvidence: previous,
          evidenceCoverage: previous ? 'complete' : 'partial',
        });
        const terminalStatus = row.status === 'pending'
          ? 'failed_permanent'
          : 'quarantined';
        this.statements.markSupersededStatus.run(
          terminalStatus,
          encodeOutboundFailureEvidence(evidence),
          evidence.logical_attempt_count,
          row.id,
          row.status,
        );
      }
    }
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

  markSubmitted(id: number, waMessageId: string | null, logicalAttemptCount = 1): void {
    if (!Number.isSafeInteger(logicalAttemptCount) || logicalAttemptCount < 1) {
      throw new RangeError('Submitted outbound logical attempt count must be positive');
    }
    this.statements.markSubmitted.run(waMessageId, logicalAttemptCount, id);
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

  markMaybeSent(
    id: number,
    evidenceOrLegacy?: OutboundFailureEvidenceV1 | string,
    waMessageId?: string,
  ): boolean {
    const evidence = this.normalizeOutboundTransitionEvidence(
      evidenceOrLegacy,
      'outbound.unknown_failure',
      'provider_request',
      'ambiguous',
    );
    if (evidence.mutation_state !== 'ambiguous') {
      throw new Error('Maybe-sent outbound transition requires ambiguous mutation evidence');
    }
    if (
      evidence.retry_decision !== 'stop'
      || evidence.retry_owner !== 'none'
      || evidence.attempt_budget_disposition !== 'stop'
    ) {
      throw new Error('Maybe-sent outbound transition requires terminal retry evidence');
    }
    return this.statements.markMaybeSent.run(
      encodeOutboundFailureEvidence(evidence),
      waMessageId ?? null,
      evidence.logical_attempt_count,
      id,
    ).changes === 1;
  }

  markFailedPermanent(
    id: number,
    evidenceOrLegacy: OutboundFailureEvidenceV1 | string,
  ): boolean {
    const evidence = this.normalizeOutboundTransitionEvidence(
      evidenceOrLegacy,
      'outbound.unknown_failure',
      'provider_response',
      'rejected',
    );
    if (
      evidence.mutation_state === 'ambiguous'
      || evidence.mutation_state === 'submitted'
    ) {
      throw new Error('Permanent outbound failure requires deterministic non-delivery evidence');
    }
    if (
      evidence.retry_decision !== 'stop'
      || evidence.retry_owner !== 'none'
      || evidence.attempt_budget_disposition !== 'stop'
    ) {
      throw new Error('Permanent outbound failure requires terminal retry evidence');
    }
    return this.statements.markFailedPermanent.run(
      encodeOutboundFailureEvidence(evidence),
      evidence.logical_attempt_count,
      id,
    ).changes === 1;
  }

  markDeferred(id: number, evidence: OutboundFailureEvidenceV1): boolean {
    if (
      evidence.retry_decision !== 'retry_not_before'
      || evidence.retry_not_before === null
      || evidence.retry_owner !== 'pending_drainer'
      || evidence.mutation_state === 'ambiguous'
      || evidence.mutation_state === 'submitted'
    ) {
      throw new Error('Deferred outbound transition requires pending-drainer deadline evidence');
    }
    return this.statements.markDeferred.run(
      encodeOutboundFailureEvidence(evidence),
      evidence.logical_attempt_count,
      id,
    ).changes === 1;
  }

  markQuarantined(
    id: number,
    evidence?: OutboundFailureEvidenceV1,
  ): boolean {
    const normalized = evidence ?? createInternalOutboundFailureEvidence({
      failureCode: 'outbound.unknown_failure',
      stage: 'runtime',
      mutationState: 'rejected',
      logicalAttemptCount: 0,
      providerSubmissionCount: 0,
      evidenceCoverage: 'partial',
    });
    if (normalized.retry_decision !== 'stop' || normalized.retry_owner !== 'none') {
      throw new Error('Quarantined outbound transition cannot retain retry ownership');
    }
    const encodedEvidence = encodeOutboundFailureEvidence(normalized);
    const evidenceSha256 = createHash('sha256').update(encodedEvidence).digest('hex');
    return this.statements.markQuarantined.run(
      encodedEvidence,
      normalized.logical_attempt_count,
      classifyOutboundQuarantineDisposition(normalized),
      normalized.evidence_coverage,
      evidenceSha256,
      id,
    ).changes === 1;
  }

  private normalizeOutboundTransitionEvidence(
    evidenceOrLegacy: OutboundFailureEvidenceV1 | string | undefined,
    fallbackCode: 'outbound.unknown_failure',
    stage: 'provider_request' | 'provider_response',
    mutationState: 'ambiguous' | 'rejected',
  ): OutboundFailureEvidenceV1 {
    if (typeof evidenceOrLegacy === 'object' && evidenceOrLegacy !== null) {
      encodeOutboundFailureEvidence(evidenceOrLegacy);
      return evidenceOrLegacy;
    }
    return createInternalOutboundFailureEvidence({
      failureCode: fallbackCode,
      stage,
      mutationState,
      providerSubmissionCount: mutationState === 'ambiguous' ? 1 : 0,
      evidenceCoverage: 'partial',
    });
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
  recordToolCall(
    conversationKey: string,
    toolName: string,
    toolGroup: string,
    replayPolicy: string,
    checkpointId?: number,
  ): number {
    const result = this.statements.recordToolCall.run(
      conversationKey,
      checkpointId ?? null,
      toolName,
      normalizeToolDurabilityGroup(toolGroup),
      TOOL_INPUT_MARKER,
      replayPolicy,
    );
    const id = Number(result.lastInsertRowid);
    log.debug({ id, toolName, replayPolicy }, 'recordToolCall');
    return id;
  }

  markToolExecuting(id: number): void {
    this.statements.markToolExecuting.run(id);
  }

  markToolComplete(id: number, completion: ToolCompletionEvidence, outboundOpId?: number): void;
  /** @deprecated Use the metadata-only ToolCompletionEvidence overload. */
  markToolComplete(id: number, legacyResult: string, isError: boolean, outboundOpId?: number): void;
  markToolComplete(
    id: number,
    completionOrLegacyResult: ToolCompletionEvidence | string,
    outboundOpIdOrLegacyIsError?: number | boolean,
    legacyOutboundOpId?: number,
  ): void {
    const completion: ToolCompletionEvidence = typeof completionOrLegacyResult === 'string'
      ? outboundOpIdOrLegacyIsError === true
        ? {
            isError: true,
            durationMs: 0,
            failure: {
              failureCode: 'unknown',
              failureStage: 'unknown',
              retryDisposition: 'unknown',
              operatorAction: 'inspect',
              evidenceCoverage: 'partial',
            },
          }
        : { isError: false, durationMs: 0, evidenceCoverage: 'partial' }
      : completionOrLegacyResult;
    const outboundOpId = typeof completionOrLegacyResult === 'string'
      ? legacyOutboundOpId
      : typeof outboundOpIdOrLegacyIsError === 'number'
        ? outboundOpIdOrLegacyIsError
        : undefined;
    const durationMs = Number.isSafeInteger(completion.durationMs) && completion.durationMs >= 0
      ? completion.durationMs
      : 0;
    if (completion.isError) {
      const failure = completion.failure;
      this.statements.markToolComplete.run(
        'error',
        TOOL_RESULT_MARKERS.error,
        outboundOpId ?? null,
        'failure',
        failure.failureCode,
        failure.failureStage,
        failure.retryDisposition,
        failure.operatorAction,
        failure.evidenceCoverage,
        durationMs,
        id,
      );
      return;
    }
    this.statements.markToolComplete.run(
      'complete',
      TOOL_RESULT_MARKERS.success,
      outboundOpId ?? null,
      'success',
      null,
      null,
      'not_applicable',
      'none',
      completion.evidenceCoverage ?? 'complete',
      durationMs,
      id,
    );
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
  retireSessionLifecycle(params: RetireSessionLifecycleParams): number {
    return this.sessionLifecycle.retireSessionLifecycle(params);
  }

  retireExactSessionLifecycle(params: RetireExactSessionLifecycleParams): number {
    return this.sessionLifecycle.retireExactSessionLifecycle(params);
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

  updateExactSessionCheckpointStatus(params: UpdateExactSessionCheckpointStatusParams): number {
    return this.sessionLifecycle.updateExactSessionCheckpointStatus(params);
  }

  quarantineCompletedDeliveryIdentityCheckpoint(
    params: QuarantineCompletedDeliveryIdentityCheckpointParams,
  ): void {
    this.sessionLifecycle.quarantineCompletedDeliveryIdentityCheckpoint(params);
  }

  quarantineCompletedDeliveryIdentityAgentSession(
    params: QuarantineCompletedDeliveryIdentityAgentSessionParams,
  ): void {
    this.sessionLifecycle.quarantineCompletedDeliveryIdentityAgentSession(params);
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
    return this.decodeOutboundRows(
      this.statements.getOutboundByStatus.all(status) as unknown as Array<
        Omit<OutboundOpRow, 'failure_evidence'>
      >,
    );
  }

  private decodeOutboundRows(
    rows: Array<Omit<OutboundOpRow, 'failure_evidence'>>,
  ): OutboundOpRow[] {
    return rows.map((row) => ({
      ...row,
      failure_evidence: decodeOutboundFailureEvidence(row.error),
    }));
  }

  private pendingReplayEvidence(op: OutboundOpRow): OutboundFailureEvidenceV1 {
    if (op.failure_evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA) {
      return transferOutboundRetryOwnership(op.failure_evidence, 'pending_drainer');
    }
    return createInternalOutboundFailureEvidence({
      failureCode: 'outbound.unknown_failure',
      stage: 'runtime',
      mutationState: 'ambiguous',
      retryable: true,
      retryDecision: 'retry_now',
      retryOwner: 'pending_drainer',
      attemptBudgetDisposition: 'preserve',
      logicalAttemptCount: op.retry_count,
      providerSubmissionCount: Math.min(op.retry_count, 1),
      evidenceCoverage: 'partial',
    });
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
        const previous = op.failure_evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
          ? op.failure_evidence
          : undefined;
        const changed = this.markMaybeSent(op.id, createInternalOutboundFailureEvidence({
          failureCode: 'outbound.crash_in_flight',
          stage: 'provider_request',
          mutationState: 'ambiguous',
          logicalAttemptCount: op.retry_count + 1,
          providerSubmissionCount: Math.min(
            op.retry_count + 1,
            (previous?.provider_submission_count ?? op.retry_count) + 1,
          ),
          previousEvidence: previous,
          evidenceCoverage: 'partial',
        }));
        if (!changed) continue;
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
          this.statements.markToolReplayed.run(TOOL_RESULT_MARKERS.recovery, tc.id);
          stats.toolCallsReplayed += 1;
          log.info(
            { toolCallId: tc.id, toolName: tc.tool_name },
            'preConnectRecovery: safe/read_only tool call marked as replayed',
          );
        } else {
          // unsafe without an outbound op: quarantine
          this.statements.markRecoveredToolQuarantined.run(TOOL_RESULT_MARKERS.recovery, tc.id);
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
      const staleSubmitted = this.decodeOutboundRows(
        this.statements.getStaleSubmitted.all() as unknown as Array<
          Omit<OutboundOpRow, 'failure_evidence'>
        >,
      );
      for (const op of staleSubmitted) {
        const changed = this.markMaybeSent(op.id, createInternalOutboundFailureEvidence({
          failureCode: 'outbound.echo_timeout',
          stage: 'acknowledgement',
          mutationState: 'ambiguous',
          logicalAttemptCount: Math.max(op.retry_count, 1),
          providerSubmissionCount: Math.max(
            op.failure_evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
              ? op.failure_evidence.provider_submission_count
              : 0,
            1,
          ),
          previousEvidence: op.failure_evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
            ? op.failure_evidence
            : undefined,
          evidenceCoverage: 'partial',
        }), op.wa_message_id ?? undefined);
        if (!changed) continue;
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

    // Step 2: Reconcile `maybe_sent` ops (includes those just promoted in Step 1).
    // This one-shot post-connect history/corroboration pass intentionally stays
    // immediate; the current-episode dwell gate applies to recurring live work
    // created after this startup recovery pass.
    this.reconcileMaybeSentOutbound(
      this.getOutboundByStatus('maybe_sent'),
      recoveryRun,
      'postConnectRecovery',
    );

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
      if (quarantineClearRequested) {
        // Serialize the exact aggregate and supported outbox writes with the
        // normal database writers. Raw out-of-band SQLite mutation is not a
        // recovery proof and remains outside this instance-local contract.
        withImmediateTransaction(this.db, () => {
          const counts = this.getQuarantineClearContributorCounts();

          for (const disposition of OUTBOUND_QUARANTINE_DISPOSITIONS) {
            const policy = OUTBOUND_QUARANTINE_DISPOSITION_POLICIES[disposition];
            if (!policy.clearWhenContributorFree || counts.get(disposition) !== 0) continue;
            if (!clearAlertSourceChecked(
              config.botName,
              policy.alertSource,
              undefined,
              undefined,
              { requireDurableOutbox: true },
            )) {
              throw new Error(
                `postConnectRecovery: quarantine clear could not be durably queued for ${disposition}`,
              );
            }
          }

          const total = [...counts.values()].reduce((count, value) => count + value, 0);
          if (
            total === 0
            && !clearAlertSourceChecked(
              config.botName,
              'outbound_quarantined',
              undefined,
              undefined,
              { requireDurableOutbox: true },
            )
          ) {
            throw new Error('postConnectRecovery: legacy quarantine clear could not be durably queued');
          }
        });
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

  /** Reconcile delivery debt created after the one-time post-connect pass. */
  reconcileLiveMaybeSent(): RecoveryStats {
    const maybeSent = this.decodeOutboundRows(
      this.statements.getLiveReconcileMaybeSent.all() as unknown as Array<
        Omit<OutboundOpRow, 'failure_evidence'>
      >,
    );
    if (maybeSent.length === 0) return createRecoveryStats();

    log.info({ count: maybeSent.length }, 'reconcileLiveMaybeSent: starting');
    const recoveryRun = this.recoveryEvidence.begin(
      'reconcileLiveMaybeSent',
      'post_connect_recovery',
      'live_maybe_sent_recovery',
      'Live maybe-sent outbound reconciliation',
    );
    this.reconcileMaybeSentOutbound(maybeSent, recoveryRun, 'reconcileLiveMaybeSent');
    recoveryRun.attestOpenRecoveries();
    recoveryRun.finalize();
    log.info(recoveryRun.stats, 'reconcileLiveMaybeSent: complete');
    return recoveryRun.stats;
  }

  private reconcileMaybeSentOutbound(
    maybeSent: OutboundOpRow[],
    recoveryRun: {
      readonly stats: RecoveryStats;
      recordFailure(phase: string, error: unknown): void;
    },
    operation: 'postConnectRecovery' | 'reconcileLiveMaybeSent',
  ): void {
    const { stats } = recoveryRun;
    try {
      for (const op of maybeSent) {
        stats.outboundReconciled += 1;

        if (this.recoveryEvidence.hasDeliveryCorroboration(op.id)) {
          log.info(
            { opId: op.id },
            `${operation}: corroborated selected delivery preserved unchanged`,
          );
          continue;
        }

        if (op.wa_message_id) {
          const found = this.statements.getMessageByWaMessageId.get(op.wa_message_id) as
            | { pk: number }
            | undefined;

          if (found) {
            this.markEchoed(op.id);
            log.info(
              { opId: op.id, waMessageId: op.wa_message_id },
              `${operation}: maybe_sent confirmed via messages table → echoed`,
            );
          } else if (op.replay_policy === 'safe' || op.replay_policy === 'read_only') {
            const evidence = this.pendingReplayEvidence(op);
            const reset = this.statements.resetMaybeSentWithWaToPending.run(
              encodeOutboundFailureEvidence(evidence),
              evidence.logical_attempt_count,
              op.id,
            );
            if (reset.changes !== 1) continue;
            stats.outboundReplayed += 1;
            log.info(
              { opId: op.id },
              `${operation}: maybe_sent not confirmed, safe/read_only → reset to pending for replay`,
            );
          } else {
            this.quarantineMaybeSent(op, recoveryRun, operation);
          }
        } else if (op.replay_policy === 'safe' || op.replay_policy === 'read_only') {
          const evidence = this.pendingReplayEvidence(op);
          const reset = this.statements.resetMaybeSentWithoutWaToPending.run(
            encodeOutboundFailureEvidence(evidence),
            evidence.logical_attempt_count,
            op.id,
          );
          if (reset.changes !== 1) continue;
          stats.outboundReplayed += 1;
          log.info(
            { opId: op.id },
            `${operation}: maybe_sent (no wa_message_id), safe/read_only → reset to pending`,
          );
        } else {
          this.quarantineMaybeSent(op, recoveryRun, operation);
        }
      }
    } catch (err) {
      recoveryRun.recordFailure('reconcile_maybe_sent_outbound', err);
      log.warn({ err }, `${operation}: error reconciling maybe_sent ops`);
    }
  }

  private quarantineMaybeSent(
    op: OutboundOpRow,
    recoveryRun: {
      readonly stats: RecoveryStats;
      recordFailure(phase: string, error: unknown): void;
    },
    operation: 'postConnectRecovery' | 'reconcileLiveMaybeSent',
  ): void {
    const previous = op.failure_evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
      ? op.failure_evidence
      : undefined;
    const evidence = createInternalOutboundFailureEvidence({
      failureCode: 'outbound.unsafe_delivery_unconfirmed',
      stage: 'runtime',
      mutationState: 'ambiguous',
      logicalAttemptCount: op.retry_count,
      providerSubmissionCount: previous?.provider_submission_count
        ?? Math.min(op.retry_count, 1),
      previousEvidence: previous,
      evidenceCoverage: previous ? 'complete' : 'partial',
    });
    const changed = this.markQuarantined(op.id, evidence);
    if (!changed) return;
    recoveryRun.stats.outboundQuarantined += 1;
    log.warn(
      { opId: op.id, replayPolicy: op.replay_policy },
      `${operation}: maybe_sent non-safe delivery quarantined`,
    );
    const alertQueued = emitOutboundQuarantineAlert(evidence);
    if (!alertQueued) {
      recoveryRun.recordFailure(
        'emit_outbound_quarantine_alert',
        new Error(`outbound quarantine alert could not be durably queued for op ${op.id}`),
      );
    }
  }

  /** Promote live outbound ops whose echo window expired. */
  sweepStaleSubmitted(): number {
    const stale = this.decodeOutboundRows(
      this.statements.getStaleSubmitted.all() as unknown as Array<
        Omit<OutboundOpRow, 'failure_evidence'>
      >,
    );
    let count = 0;
    for (const op of stale) {
      const changed = this.markMaybeSent(op.id, createInternalOutboundFailureEvidence({
        failureCode: 'outbound.echo_timeout',
        stage: 'acknowledgement',
        mutationState: 'ambiguous',
        logicalAttemptCount: Math.max(op.retry_count, 1),
        providerSubmissionCount: Math.max(
          op.failure_evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
            ? op.failure_evidence.provider_submission_count
            : 0,
          1,
        ),
        previousEvidence: op.failure_evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
          ? op.failure_evidence
          : undefined,
        evidenceCoverage: 'partial',
      }), op.wa_message_id ?? undefined);
      if (!changed) continue;
      count += 1;
    }
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
      let reclaimedRecoveryOwned = 0;

      const echoed = this.statements.getOpenInboundWithEchoedTerminal.all() as Array<{ seq: number }>;
      const turnDone = this.statements.getStaleTurnDoneNoSuccess.all() as Array<{ seq: number }>;
      const staleOpen = this.statements.getStaleOpenNoSuccess.all() as Array<{ seq: number }>;
      const recoveryOwned = this.statements.getRecoveryOwnedReclaimable.all() as Array<{
        seq: number;
        job_id: number;
        job_state: string;
      }>;
      if (
        echoed.length === 0 &&
        turnDone.length === 0 &&
        staleOpen.length === 0 &&
        recoveryOwned.length === 0
      ) {
        return { completedEchoed, completedTurnDone, failedStale, reclaimedRecoveryOwned };
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

      // #1749: release the recovery-owner trap. Drive EVERY pending/claimed owning
      // job to `exhausted` (so none of them pin admission), then fail each source
      // inbound ONCE so retention can reclaim it and the loss is operator-visible.
      // One inbound_seq_key can own more than one transferred terminal record
      // (turn_terminal_records is UNIQUE per inbound_seq_key/logical_turn_id/
      // generation), so the candidate set may repeat a seq. Failing it twice would
      // re-run markInboundFailed after its disposition link exists and trip
      // disposition_inbound_proof_immutable, aborting the whole sweep — so the
      // inbound mutation is deduplicated by seq.
      const reclaimedSeqs = new Set<number>();
      for (const row of recoveryOwned) {
        if (row.job_state === 'pending' || row.job_state === 'claimed') {
          this.turnRecovery.reclaimDeadDeliveryRecoveryJobWithinCallerTransaction(row.job_id);
        }
        reclaimedSeqs.add(row.seq);
      }
      for (const seq of reclaimedSeqs) {
        this.recoveryEvidence.recordPendingWithinTransaction(
          seq,
          recovery,
          'recovery_owner_reclaimed',
          () => this.markInboundFailed(seq, 'recovery_owner_reclaimed'),
        );
        reclaimedRecoveryOwned += 1;
      }

      const result: StuckInboundSweepResult = {
        completedEchoed,
        completedTurnDone,
        failedStale,
        reclaimedRecoveryOwned,
      };
      const recoveryStats = createRecoveryStats(recovery);
      recoveryStats.openRecoveries = this.recoveryEvidence.countOpen();
      this.recoveryEvidence.finalize(
        recovery,
        recoveryStats,
        JSON.stringify({ ...result, openRecoveries: recoveryStats.openRecoveries }),
      );
      if (
        completedEchoed > 0 ||
        completedTurnDone > 0 ||
        failedStale > 0 ||
        reclaimedRecoveryOwned > 0
      ) {
        log.info(result, 'sweepStuckInbound: finalized stuck inbound rows');
      }
      return result;
    });
  }

  getHealthStats(): {
    pendingOutbound: number;
    quarantinedOutbound: number;
    maybeSentOutbound: number;
    oldestMaybeSentAt: string | null;
    outboundFailureEvidence: OutboundFailureHealthProjection;
    outboundQuarantineDispositions: OutboundQuarantineDispositionHealthProjection;
    lastRecoveryAt: string | null;
    openRecoveries: number;
  } {
    const pending = this.statements.getPendingOutboundCount.get() as { count: number };
    const quarantined = this.statements.getQuarantinedOutboundCount.get() as { count: number };
    const maybeSent = this.statements.getMaybeSentOutboundCount.get() as { count: number };
    const oldestMaybeSent = this.statements.getOldestMaybeSentSubmittedAt.get() as
      | { at: string | null }
      | undefined;
    const evidenceRows = this.statements.getRecentOutboundFailureEvidence.all() as Array<{
      status: string;
      error: string | null;
    }>;
    const evidenceGroups = new Map<string, OutboundFailureHealthGroup>();
    const nowMs = Date.now();
    for (const row of evidenceRows) {
      const evidence = decodeOutboundFailureEvidence(row.error);
      const retryDelayMs = evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
        && evidence.retry_not_before !== null
        ? Date.parse(evidence.retry_not_before) - nowMs
        : null;
      const remainingDelayBucket = retryDelayMs === null
        ? 'none'
        : retryDelayMs <= 0
          ? 'due'
          : retryDelayMs < 60_000
            ? 'under_1m'
            : retryDelayMs < 300_000
              ? '1m_to_5m'
              : retryDelayMs < 3_600_000
                ? '5m_to_1h'
                : 'over_1h';
      const group: OutboundFailureHealthGroup = evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
        ? {
          failureCode: evidence.failure_code,
          stage: evidence.stage,
          mutationState: evidence.mutation_state,
          evidenceCoverage: evidence.evidence_coverage,
          terminalState: normalizeOutboundStatus(row.status),
          retryDecision: evidence.retry_decision,
          retryOwner: evidence.retry_owner,
          remainingDelayBucket,
          nextEligibleAt: evidence.retry_not_before,
          providerSubmissionCount: 0,
          count: 0,
        }
        : {
          failureCode: evidence.failure_code,
          stage: 'legacy_unclassified',
          mutationState: 'legacy_unclassified',
          evidenceCoverage: evidence.evidence_coverage,
          terminalState: normalizeOutboundStatus(row.status),
          retryDecision: 'legacy_unclassified',
          retryOwner: 'legacy_unclassified',
          remainingDelayBucket: 'unknown',
          nextEligibleAt: null,
          providerSubmissionCount: 0,
          count: 0,
        };
      const key = JSON.stringify([
        group.failureCode,
        group.stage,
        group.mutationState,
        group.evidenceCoverage,
        group.terminalState,
        group.retryDecision,
        group.retryOwner,
        group.remainingDelayBucket,
      ]);
      const existing = evidenceGroups.get(key);
      if (existing) {
        existing.count += 1;
        existing.providerSubmissionCount += evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
          ? evidence.provider_submission_count
          : 0;
        if (
          group.nextEligibleAt !== null
          && (
            existing.nextEligibleAt === null
            || group.nextEligibleAt < existing.nextEligibleAt
          )
        ) {
          existing.nextEligibleAt = group.nextEligibleAt;
        }
      } else {
        group.count = 1;
        group.providerSubmissionCount = evidence.schema === OUTBOUND_FAILURE_EVIDENCE_SCHEMA
          ? evidence.provider_submission_count
          : 0;
        evidenceGroups.set(key, group);
      }
    }
    const outboundFailureEvidence: OutboundFailureHealthProjection = {
      sampledRows: evidenceRows.length,
      groups: [...evidenceGroups.values()]
        .sort((a, b) => (
          b.count - a.count
          || a.failureCode.localeCompare(b.failureCode)
          || a.stage.localeCompare(b.stage)
          || a.evidenceCoverage.localeCompare(b.evidenceCoverage)
        ))
        .slice(0, 20),
    };
    const quarantineGroups = this.getQuarantinedOutboundDispositionGroups();
    const outboundQuarantineDispositions: OutboundQuarantineDispositionHealthProjection = {
      total: quarantineGroups.reduce((total, group) => total + group.count, 0),
      groups: quarantineGroups,
    };
    const lastRecovery = this.statements.getLastRecoveryRunCompletedAt.get() as
      | { completed_at: string }
      | undefined;
    return {
      pendingOutbound: pending.count,
      quarantinedOutbound: quarantined.count,
      maybeSentOutbound: maybeSent.count,
      oldestMaybeSentAt: oldestMaybeSent?.at ?? null,
      outboundFailureEvidence,
      outboundQuarantineDispositions,
      lastRecoveryAt: lastRecovery?.completed_at ?? null,
      openRecoveries: this.recoveryEvidence.countOpen(),
    };
  }

  private getQuarantinedOutboundDispositionGroups(): OutboundQuarantineDispositionHealthGroup[] {
    const quarantineRows = this.statements.getQuarantinedOutboundDispositionGroups.all() as Array<{
      quarantine_disposition: unknown;
      quarantine_evidence_coverage: unknown;
      count: number;
    }>;
    const quarantineGroups = new Map<string, OutboundQuarantineDispositionHealthGroup>();
    for (const row of quarantineRows) {
      const disposition = normalizeOutboundQuarantineDisposition(row.quarantine_disposition);
      const evidenceCoverage = normalizeOutboundQuarantineEvidenceCoverage(
        row.quarantine_evidence_coverage,
      );
      const key = `${disposition}\u0000${evidenceCoverage}`;
      const existing = quarantineGroups.get(key);
      if (existing) {
        existing.count += row.count;
      } else {
        quarantineGroups.set(key, { disposition, evidenceCoverage, count: row.count });
      }
    }
    return [...quarantineGroups.values()].sort((a, b) => (
      b.count - a.count
      || a.disposition.localeCompare(b.disposition)
      || a.evidenceCoverage.localeCompare(b.evidenceCoverage)
    ));
  }

  private getQuarantineClearContributorCounts(): Map<OutboundQuarantineDisposition, number> {
    const counts = new Map<OutboundQuarantineDisposition, number>(
      OUTBOUND_QUARANTINE_DISPOSITIONS.map((disposition) => [disposition, 0]),
    );
    const rows = this.statements.getQuarantineClearContributorCounts.all() as Array<{
      quarantine_disposition: unknown;
      count: number;
    }>;
    for (const row of rows) {
      const disposition = normalizeOutboundQuarantineDisposition(row.quarantine_disposition);
      counts.set(disposition, (counts.get(disposition) ?? 0) + row.count);
    }
    return counts;
  }

  getCompletedDeliveryIdentityAdmissionHealth(): CompletedDeliveryIdentityAdmissionHealth {
    const row = this.statements.getCompletedDeliveryIdentityAdmissionHealth.get() as {
      unresolved_count: number | bigint;
      oldest_transition_at: string | null;
      maximum_attempts: number | bigint | null;
      next_action: string | null;
    };
    const nextAction = row.next_action === 'fresh_inbound' || row.next_action === 'operator'
      ? row.next_action
      : null;
    return {
      unresolvedCount: Number(row.unresolved_count),
      oldestTransitionAt: row.oldest_transition_at,
      maximumAttempts: row.maximum_attempts === null ? 0 : Number(row.maximum_attempts),
      nextAction,
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
  opts: { replayPolicy: 'safe' | 'unsafe' | 'read_only'; isTerminal?: boolean; sourceInboundSeq?: number; caller?: GuardCaller; opType?: 'text' | 'status_ping' },
): Promise<void> {
  let opId: number | undefined;
  if (durability) {
    const conversationKey = toConversationKey(chatJid);
    opId = durability.createOutboundOp({
      conversationKey,
      chatJid,
      opType: opts.opType ?? 'text',
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
      const evidence = classifyOutboundFailure(err, {
        retryOwner: 'send_tracked',
        attemptsRemaining: 0,
      });
      persistOutboundFailureDisposition(durability, opId, evidence);
    }
    throw err;
  }
}

export function persistOutboundFailureDisposition(
  durability: DurabilityEngine,
  opId: number,
  evidence: OutboundFailureEvidenceV1,
  waMessageId?: string,
): void {
  if (evidence.retry_decision === 'retry_now') {
    throw new Error('Retry-now outbound evidence must remain with its active retry owner');
  }
  if (evidence.retry_decision === 'retry_not_before') {
    durability.markDeferred(opId, evidence);
  } else if (evidence.mutation_state === 'ambiguous') {
    durability.markMaybeSent(opId, evidence, waMessageId);
  } else {
    durability.markFailedPermanent(opId, evidence);
  }
}

/**
 * Drain replay-safe pending text/status_ping ops; quarantine malformed ops and
 * isolate failures. Returns `{ resent, expired }`: `resent` = ops re-sent via
 * `markSubmitted`; `expired` = `status_ping` ops aged out past
 * `STATUS_OP_TTL_MS` (quarantined, never sent).
 */
export async function drainPendingOutbound(
  messenger: Messenger,
  durability: DurabilityEngine,
): Promise<{ resent: number; expired: number }> {
  const pending = durability.getOutboundByStatus('pending');
  let resent = 0;
  let expired = 0;

  for (const op of pending) {
    try {
      const priorEvidence = op.failure_evidence.schema === 'whatsoup-outbound-failure-v1'
        ? op.failure_evidence
        : undefined;
      if (
        priorEvidence?.retry_decision === 'retry_not_before'
        && priorEvidence.retry_not_before !== null
        && Date.parse(priorEvidence.retry_not_before) > Date.now()
      ) {
        // PR-C max-deferral bound: a text op that has been deferred
        // MAX_TEXT_OP_DEFERRAL_COUNT+ times is quarantined instead of being
        // left pending forever. Status_ping has its own TTL age-out above.
        // The retry_count stored by markDeferred reflects total deferrals.
        if (
          op.op_type === 'text'
          && op.retry_count >= MAX_TEXT_OP_DEFERRAL_COUNT
        ) {
          const evidence = createInternalOutboundFailureEvidence({
            failureCode: 'outbound.deferral_limit_exceeded',
            stage: 'admission',
            mutationState: 'not_started',
            logicalAttemptCount: op.retry_count,
            providerSubmissionCount: priorEvidence?.provider_submission_count ?? 0,
            previousEvidence: priorEvidence,
            evidenceCoverage: priorEvidence ? 'complete' : 'partial',
          });
          const changed = durability.markQuarantined(op.id, evidence);
          if (!changed) continue;
          log.warn(
            { opId: op.id, retryCount: op.retry_count, maxDeferrals: MAX_TEXT_OP_DEFERRAL_COUNT },
            'drainPendingOutbound: text op exceeded max deferral count → quarantined',
          );
          emitOutboundQuarantineAlert(evidence);
        }
        continue;
      }
      let text: string | undefined;
      if (op.op_type === 'text' || op.op_type === 'status_ping') {
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
        const evidence = createInternalOutboundFailureEvidence({
          failureCode: 'outbound.pending_replay_unreconstructable',
          stage: 'admission',
          mutationState: 'not_started',
          logicalAttemptCount: op.retry_count,
          providerSubmissionCount: priorEvidence?.provider_submission_count ?? 0,
          previousEvidence: priorEvidence,
          evidenceCoverage: priorEvidence ? 'complete' : 'partial',
        });
        const changed = durability.markQuarantined(op.id, evidence);
        if (!changed) continue;
        log.warn(
          { opId: op.id, opType: op.op_type, replayPolicy: op.replay_policy },
          'drainPendingOutbound: pending op not reconstructable → quarantined',
        );
        emitOutboundQuarantineAlert(evidence);
        continue;
      }

      if (
        op.op_type === 'status_ping' &&
        Date.parse(op.created_at + 'Z') < Date.now() - STATUS_OP_TTL_MS
      ) {
        // PR-C TTL age-out (status class only): a "back online" ping stranded in
        // `pending` past the TTL is stale misinformation. Mirror the
        // non-reconstructable branch — quarantine (a terminal state retention
        // reclaims) + alert — but never re-send it. `text` ops are exempt: this
        // branch is gated on op_type='status_ping'.
        const evidence = createInternalOutboundFailureEvidence({
          failureCode: 'outbound.status_ping_expired',
          stage: 'admission',
          mutationState: 'not_started',
          logicalAttemptCount: op.retry_count,
          providerSubmissionCount: priorEvidence?.provider_submission_count ?? 0,
          previousEvidence: priorEvidence,
          evidenceCoverage: priorEvidence ? 'complete' : 'partial',
        });
        const changed = durability.markQuarantined(op.id, evidence);
        if (!changed) continue;
        log.warn(
          { opId: op.id, opType: op.op_type, createdAt: op.created_at },
          'drainPendingOutbound: stale status_ping past TTL → quarantined',
        );
        emitOutboundQuarantineAlert(evidence);
        expired += 1;
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
        // #2813: replayed ops deliberately send WITHOUT a caller token, even
        // when the original send carried one (QR-086 infra callers such as
        // 'health'). sendTracked persists only { text } in the payload, so the
        // caller identity does not survive the round-trip through the DB, and
        // the replay takes the default guard path — the most restrictive one
        // (no cold-floor bypass). Fail-safe by design: a replayed health send
        // may be floored where the original would not have been. If the bypass
        // must survive replay, persist the caller in the payload envelope and
        // read it back here (issue #2813, remediation branch A).
        const receipt = await messenger.sendMessage(op.chat_jid, text);
        durability.markSubmitted(
          op.id,
          receipt.waMessageId,
          (priorEvidence?.logical_attempt_count ?? op.retry_count) + 1,
        );
        resent += 1;
        log.info(
          { opId: op.id, waMessageId: receipt.waMessageId },
          'drainPendingOutbound: pending op re-sent → submitted',
        );
      } catch (err) {
        const evidence = classifyOutboundFailure(err, {
          retryOwner: 'pending_drainer',
          attemptsRemaining: 0,
          previousEvidence: priorEvidence,
        });
        persistOutboundFailureDisposition(durability, op.id, evidence);
        log.warn(
          {
            opId: op.id,
            failureCode: evidence.failure_code,
            stage: evidence.stage,
            mutationState: evidence.mutation_state,
            retryDecision: evidence.retry_decision,
          },
          'drainPendingOutbound: re-send failed with bounded disposition',
        );
      }
    } catch (err) {
      // Defensive: one malformed op must never abort the rest of the drain.
      log.warn({ opId: op.id, err }, 'drainPendingOutbound: unexpected error draining op');
    }
  }

  if (pending.length > 0) {
    log.info({ pending: pending.length, resent, expired }, 'drainPendingOutbound: complete');
  }
  return { resent, expired };
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
