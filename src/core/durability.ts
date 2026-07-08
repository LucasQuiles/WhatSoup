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
import { coerceInboundFailureClass } from './inbound-failure-class.ts';
import type { InboundFailureClass } from './inbound-failure-class.ts';
import { config } from '../config.ts';

const log = createChildLogger('durability');

/**
 * PR-C: max age a `status_ping` op may sit in `pending` before the drain ages it
 * out (quarantine + alert) instead of re-sending. A "back online" notice older
 * than this is stale misinformation, so dropping it is correct. Strictly scoped
 * to `op_type='status_ping'` — `text` ops have no age gate.
 */
const STATUS_OP_TTL_MS = 30 * 60 * 1000;

// ── Status string unions ──

type OutboundStatus = 'pending' | 'sending' | 'submitted' | 'echoed' | 'maybe_sent' | 'failed_permanent' | 'quarantined';
type InboundStatus = 'pending' | 'processing' | 'turn_done' | 'complete' | 'failed';
export type SessionStatus = 'active' | 'suspended' | 'orphaned' | 'ended';
type ToolCallStatus = 'pending' | 'executing' | 'complete' | 'replayed' | 'quarantined';

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
  created_at: string;
  submitted_at: string | null;
  source_inbound_seq: number | null;
  is_terminal: number;
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
  updated_at: string | null;
}

/** Minimal session_checkpoints row used for active-session enumeration. */
export interface ActiveSessionCheckpointRow {
  id: number;
  conversation_key: string;
  claude_pid: number | null;
  session_status: string;
}

export type ContinuityCandidateReason =
  | 'crash_reclaim_no_terminal_outbound'
  | 'runtime_fault_no_terminal_outbound';

export type ContinuityCandidateSource =
  | 'pre_connect_recovery'
  | 'runtime_fault_disarm';

export interface RecoveryStats {
  inboundReplayed: number;
  outboundReconciled: number;
  outboundReplayed: number;
  outboundQuarantined: number;
  toolCallsRecovered: number;
  toolCallsReplayed: number;
  toolCallsQuarantined: number;
  sessionsRestored: number;
}

/** Counts returned by {@link DurabilityEngine.sweepStuckInbound}. */
export interface StuckInboundSweepResult {
  completedEchoed: number;
  completedTurnDone: number;
  failedStale: number;
}

export interface SessionCheckpointFields {
  sessionId?: string;
  transcriptPath?: string;
  activeTurnId?: string | null;
  lastInboundSeq?: number;
  lastFlushedOutboundId?: number;
  watchdogState?: string;
  workspacePath?: string;
  claudePid?: number;
  sessionStatus?: string;
}

export interface CompleteTurnParams {
  sessionTokens?: {
    dbRowId: number;
    inputTokens: number;
    outputTokens: number;
  };
  checkpoint?: {
    conversationKey: string;
    fields: SessionCheckpointFields;
  };
  inbound?: {
    seq: number;
    terminalReason: string;
  };
  lastOpId?: number;
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
  markInboundSkipped: PreparedStatement;
  selectInboundStatus: PreparedStatement;
  createOutboundOp: PreparedStatement;
  supersedeOutstandingStatus: PreparedStatement;
  markSending: PreparedStatement;
  markSubmitted: PreparedStatement;
  markEchoed: PreparedStatement;
  selectEchoedOutboundInbound: PreparedStatement;
  markMaybeSent: PreparedStatement;
  markFailedPermanent: PreparedStatement;
  markQuarantined: PreparedStatement;
  markTerminal: PreparedStatement;
  selectOutboundForEchoMatch: PreparedStatement;
  recordToolCall: PreparedStatement;
  markToolExecuting: PreparedStatement;
  markToolComplete: PreparedStatement;
  accumulateSessionTokens: PreparedStatement;
  insertTokenEvent: PreparedStatement;
  upsertSessionCheckpoint: PreparedStatement;
  getSessionCheckpoint: PreparedStatement;
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
      markInboundSkipped: prepare(
        `UPDATE inbound_events SET processing_status = 'complete', completed_at = datetime('now'), terminal_reason = ? WHERE seq = ?`,
      ),
      selectInboundStatus: prepare(
        `SELECT processing_status FROM inbound_events WHERE seq = ?`,
      ),
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
      supersedeOutstandingStatus: prepare(
        `UPDATE outbound_ops SET status = 'failed_permanent', error = 'superseded'
           WHERE chat_jid = ? AND op_type = 'status_ping'
             AND status IN ('pending', 'sending', 'submitted', 'maybe_sent')`,
      ),
      markSending: prepare(
        `UPDATE outbound_ops SET status = 'sending' WHERE id = ? AND status = 'pending'`,
      ),
      markSubmitted: prepare(
        `UPDATE outbound_ops SET status = 'submitted', wa_message_id = ?, submitted_at = datetime('now') WHERE id = ?`,
      ),
      markEchoed: prepare(
        `UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = ?`,
      ),
      selectEchoedOutboundInbound: prepare(
        // QR-102: also select `status` so markTerminal can detect an op that was
        // ALREADY echoed before being marked terminal (echo-before-terminal ordering)
        // and finalize the linked inbound then.
        `SELECT source_inbound_seq, is_terminal, status FROM outbound_ops WHERE id = ?`,
      ),
      markMaybeSent: prepare(
        `UPDATE outbound_ops SET status = 'maybe_sent', error = ? WHERE id = ?`,
      ),
      markFailedPermanent: prepare(
        `UPDATE outbound_ops SET status = 'failed_permanent', error = ? WHERE id = ?`,
      ),
      markQuarantined: prepare(`UPDATE outbound_ops SET status = 'quarantined' WHERE id = ?`),
      markTerminal: prepare(`UPDATE outbound_ops SET is_terminal = 1 WHERE id = ?`),
      selectOutboundForEchoMatch: prepare(
        `SELECT id FROM outbound_ops WHERE wa_message_id = ? AND status = 'submitted'`,
      ),
      recordToolCall: prepare(
        `INSERT INTO tool_calls (conversation_key, session_checkpoint_id, tool_name, tool_input, status, replay_policy)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      ),
      markToolExecuting: prepare(`UPDATE tool_calls SET status = 'executing' WHERE id = ?`),
      markToolComplete: prepare(
        `UPDATE tool_calls SET status = 'complete', result = ?, completed_at = datetime('now'), outbound_op_id = ? WHERE id = ?`,
      ),
      accumulateSessionTokens: prepare(
        `UPDATE agent_sessions
         SET total_input_tokens = total_input_tokens + ?,
             total_output_tokens = total_output_tokens + ?
         WHERE id = ?`,
      ),
      insertTokenEvent: prepare(
        `INSERT INTO agent_token_events (agent_session_id, timestamp, input_tokens, output_tokens)
         VALUES (?, unixepoch('now'), ?, ?)`,
      ),
      upsertSessionCheckpoint: prepare(`
        INSERT INTO session_checkpoints (conversation_key, session_id, transcript_path, active_turn_id,
          last_inbound_seq, last_flushed_outbound_id, watchdog_state, workspace_path, claude_pid, session_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_key) DO UPDATE SET
          session_id = COALESCE(excluded.session_id, session_id),
          transcript_path = COALESCE(excluded.transcript_path, transcript_path),
          active_turn_id = excluded.active_turn_id,
          last_inbound_seq = COALESCE(excluded.last_inbound_seq, last_inbound_seq),
          last_flushed_outbound_id = COALESCE(excluded.last_flushed_outbound_id, last_flushed_outbound_id),
          watchdog_state = COALESCE(excluded.watchdog_state, watchdog_state),
          workspace_path = COALESCE(excluded.workspace_path, workspace_path),
          claude_pid = COALESCE(excluded.claude_pid, claude_pid),
          session_status = COALESCE(excluded.session_status, session_status),
          checkpoint_version = checkpoint_version + 1,
          updated_at = datetime('now')
      `),
      getSessionCheckpoint: prepare(
        `SELECT * FROM session_checkpoints WHERE conversation_key = ?`,
      ),
      getAllActiveCheckpoints: prepare(
        `SELECT id, conversation_key, claude_pid, session_status FROM session_checkpoints WHERE session_status = 'active'`,
      ),
      getResumableCheckpoints: prepare(
        `SELECT id, conversation_key, claude_pid, session_status FROM session_checkpoints WHERE session_status IN ('active', 'suspended') AND session_id IS NOT NULL`,
      ),
      markSessionOrphaned: prepare(
        `UPDATE session_checkpoints SET session_status = 'orphaned', updated_at = datetime('now') WHERE conversation_key = ?`,
      ),
      getPendingInbound: prepare(
        `SELECT seq, message_id, processing_status, routed_to FROM inbound_events WHERE processing_status IN ('pending', 'processing', 'turn_done')`,
      ),
      getOutboundByStatus: prepare(
        `SELECT id, chat_jid, op_type, payload, wa_message_id, replay_policy, created_at, submitted_at, source_inbound_seq, is_terminal FROM outbound_ops WHERE status = ?`,
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
        `SELECT seq FROM inbound_events WHERE processing_status = 'processing'`,
      ),
      // QR-035: events stranded at 'turn_done' (turn completed but
      // markInboundComplete didn't run before a crash) — recovery finalizes them.
      getTurnDoneInboundEvents: prepare(
        `SELECT seq FROM inbound_events WHERE processing_status = 'turn_done'`,
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
         ORDER BY i.seq ASC
         LIMIT 200`,
      ),
      getStaleTurnDoneNoSuccess: prepare(
        `SELECT i.seq AS seq
         FROM inbound_events i
         WHERE i.processing_status = 'turn_done'
           AND i.received_at < datetime('now', '-24 hours')
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
    this.confirmedOutboundProbe = makeConfirmedOutboundProbe(db.raw);
  }

  private runUpsertSessionCheckpoint(conversationKey: string, fields: SessionCheckpointFields): void {
    this.statements.upsertSessionCheckpoint.run(
      conversationKey, fields.sessionId ?? null, fields.transcriptPath ?? null,
      fields.activeTurnId ?? null, fields.lastInboundSeq ?? null,
      fields.lastFlushedOutboundId ?? null, fields.watchdogState ?? null,
      fields.workspacePath ?? null, fields.claudePid ?? null,
      fields.sessionStatus ?? 'active',
    );
  }

  private runCompleteInbound(seq: number, reason: string): void {
    const row = this.statements.selectInboundStatus.get(seq) as { processing_status: string } | undefined;
    if (row?.processing_status === 'processing') {
      this.markTurnDone(seq);
    }
    this.markInboundComplete(seq, reason);
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
    const terminalOp = this.statements.getTerminalOutboundForInbound.get(seq) as { id: number } | undefined;
    if (terminalOp) return false;
    return this.markContinuityCandidate(seq, reason, source);
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

      if (params.sessionTokens) {
        this.statements.accumulateSessionTokens.run(
          params.sessionTokens.inputTokens,
          params.sessionTokens.outputTokens,
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

  // ── Outbound ops ──
  createOutboundOp(params: OutboundOpParams): number {
    const hash = createHash('sha256').update(params.payload).digest('hex');
    // PR-C supersede-on-enqueue: collapse to one outstanding status ping per chat.
    if (params.opType === 'status_ping') {
      this.statements.supersedeOutstandingStatus.run(params.chatJid);
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

  markSubmitted(id: number, waMessageId: string | null): void {
    this.statements.markSubmitted.run(waMessageId, id);
  }

  markEchoed(id: number): void {
    this.statements.markEchoed.run(id);
    // If this is a terminal op, complete the linked inbound event
    const row = this.statements.selectEchoedOutboundInbound.get(id) as
      { source_inbound_seq: number | null; is_terminal: number; status: string } | undefined;
    if (row?.is_terminal && row.source_inbound_seq) {
      this.completeInbound(row.source_inbound_seq, 'response_sent');
    }
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
    // QR-102: markEchoed only completes the linked inbound if the op was ALREADY
    // terminal at echo time. In the real ordering the reply is sent + echoed
    // (markEchoed, is_terminal=0 -> skipped) BEFORE markLastTerminal runs, so the
    // echo-path completion is missed and -- if the process crashes before the direct
    // completeInbound -- the inbound is stranded (processing/turn_done). Mirror
    // markEchoed here: if this op is already 'echoed', finalize the inbound now.
    // completeInbound is idempotent (status-guarded markTurnDone + a redundant
    // markInboundComplete), so this never double-finalizes when the direct path also
    // runs, and the terminal-then-echo ordering still completes via markEchoed.
    const row = this.statements.selectEchoedOutboundInbound.get(id) as
      { source_inbound_seq: number | null; is_terminal: number; status: string } | undefined;
    if (row?.status === 'echoed' && row.source_inbound_seq) {
      this.completeInbound(row.source_inbound_seq, 'response_sent');
    }
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

  markToolComplete(id: number, result: string, outboundOpId?: number): void {
    this.statements.markToolComplete.run(result, outboundOpId ?? null, id);
  }

  // ── Session checkpoints ──
  upsertSessionCheckpoint(conversationKey: string, fields: {
    sessionId?: string; transcriptPath?: string; activeTurnId?: string | null;
    lastInboundSeq?: number; lastFlushedOutboundId?: number;
    watchdogState?: string; workspacePath?: string;
    claudePid?: number; sessionStatus?: string;
  }): void {
    this.runUpsertSessionCheckpoint(conversationKey, fields);
  }

  getSessionCheckpoint(conversationKey: string): SessionCheckpointRow | undefined {
    return this.statements.getSessionCheckpoint.get(conversationKey) as SessionCheckpointRow | undefined;
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

  /**
   * Pre-reconnect step: Run before reconnect. All synchronous SQLite operations.
   *
   * 1. Detect orphaned sessions via kill -0 on claude_pid.
   * 2. Promote all `sending` outbound ops → `maybe_sent` (crash-in-flight).
   * 3. Recover `executing` tool calls:
   *    - With outbound_op_id: delegate to outbound reconciliation (no-op here, the
   *      outbound op already handles it via maybe_sent promotion).
   *    - Without outbound_op_id + replay_policy='safe': mark as 'replayed'.
   *    - Without outbound_op_id + replay_policy='unsafe'/'read_only': quarantine.
   * 4. For inbound events in `processing` with no terminal outbound ops: mark failed.
   */
  preConnectRecovery(): RecoveryStats {
    const stats: RecoveryStats = {
      inboundReplayed: 0,
      outboundReconciled: 0,
      outboundReplayed: 0,
      outboundQuarantined: 0,
      toolCallsRecovered: 0,
      toolCallsReplayed: 0,
      toolCallsQuarantined: 0,
      sessionsRestored: 0,
    };

    log.info('preConnectRecovery: starting');

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
          // Delegate to outbound reconciliation — the op was already promoted to
          // maybe_sent above (or was already in a terminal state). No additional
          // action needed; just log.
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
          this.markContinuityCandidate(ev.seq, 'crash_reclaim_no_terminal_outbound', 'pre_connect_recovery');
          this.markInboundFailed(ev.seq, 'crash_recovery');
          log.info(
            { inboundSeq: ev.seq },
            'preConnectRecovery: inbound processing with no terminal op marked failed',
          );
        } else if (terminalOp.status === 'echoed') {
          // QR-102 (recovery site): the reply was echoed (delivery confirmed) but the
          // inbound completion was interrupted — the echo path finalizes in autocommit
          // steps (markEchoed.run → completeInbound) and a crash between them leaves the
          // op 'echoed' while the inbound is still 'processing'. postConnect only
          // reconciles submitted/maybe_sent ops, so an already-echoed op is NEVER
          // revisited and the inbound would leak. Finalize it here (idempotent).
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
      log.warn({ err }, 'preConnectRecovery: error handling processing inbound events');
    }

    // Step 4b (QR-035): finalize inbound events stranded at `turn_done`. The turn
    // completed (markTurnDone ran) but markInboundComplete didn't before the crash,
    // so the row is terminal-by-intent — mark it `complete` (NOT `failed`). The
    // reply's outbound op is reconciled independently by the outbound steps. Without
    // this the row never reaches a terminal status and retention never reclaims it.
    try {
      const turnDoneEvents = this.statements.getTurnDoneInboundEvents.all() as Array<{ seq: number }>;
      for (const ev of turnDoneEvents) {
        // Only the genuine strand: a turn_done with NO terminal outbound op (a
        // no-reply turn). One WITH a terminal op is deliberately left for
        // postConnect, which reconciles the op (echo/replay) and marks the inbound
        // complete only after delivery is confirmed — finalizing it here would
        // prematurely complete it before its reply is verified.
        const terminalOp = this.statements.getTerminalOutboundForInbound.get(ev.seq) as
          { id: number; status: OutboundStatus } | undefined;
        if (terminalOp) {
          // QR-102 (recovery site): a turn_done with an already-echoed terminal op is
          // the same interrupted-completion strand (crash after markTurnDone, before
          // markInboundComplete). Delivery is confirmed, and postConnect never revisits
          // an echoed op — so finalize it now (idempotent). A non-echoed terminal op is
          // still left for postConnect (delivery not yet confirmed).
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
      log.warn({ err }, 'preConnectRecovery: error reconciling turn_done inbound events');
    }

    log.info(stats, 'preConnectRecovery: complete');
    return stats;
  }

  /**
   * Post-reconnect step: Run after reconnect + echo grace period. All synchronous SQLite operations.
   *
   * 1. Reconcile `maybe_sent` ops: check messages table for wa_message_id match.
   *    - Found: mark echoed.
   *    - Not found + safe: mark for replay (outbound_replayed).
   *    - Not found + unsafe/read_only: quarantine.
   * 2. Reconcile stale `submitted` (no echo after grace): promote to `maybe_sent`.
   * 3. Log recovery_run with aggregated stats.
   */
  postConnectRecovery(): RecoveryStats {
    const stats: RecoveryStats = {
      inboundReplayed: 0,
      outboundReconciled: 0,
      outboundReplayed: 0,
      outboundQuarantined: 0,
      toolCallsRecovered: 0,
      toolCallsReplayed: 0,
      toolCallsQuarantined: 0,
      sessionsRestored: 0,
    };

    log.info('postConnectRecovery: starting');

    // Step 1: Promote stale `submitted` ops (no echo after 30s grace period) → maybe_sent
    // Only promote ops submitted before the current session's startup window to avoid
    // racing with echoes from messages sent in the current reconnect attempt.
    // Done first so newly-promoted ops are reconciled in the same pass (Step 2).
    try {
      const staleSubmitted = this.statements.getStaleSubmitted.all() as Array<{ id: number }>;
      for (const op of staleSubmitted) {
        this.markMaybeSent(op.id, 'stale-submitted-no-echo');
        // NOTE (BEAD-060): do NOT increment outboundReconciled here. These ops are
        // re-read as maybe_sent in Step 2, which is the single counting site for
        // outboundReconciled — counting here too would double-count every
        // stale-submitted op.
        log.info(
          { opId: op.id },
          'postConnectRecovery: stale submitted (no echo) promoted to maybe_sent',
        );
      }
    } catch (err) {
      log.warn({ err }, 'postConnectRecovery: error handling stale submitted ops');
    }

    // Step 2: Reconcile `maybe_sent` ops (includes those just promoted in Step 1)
    try {
      const maybeSent = this.getOutboundByStatus('maybe_sent');
      for (const op of maybeSent) {
        stats.outboundReconciled += 1;

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
            emitAlertChecked(
              config.botName,
              'outbound_quarantined',
              `whatsoup@${config.botName} outbound op ${op.id} quarantined`,
              `replay_policy=${op.replay_policy} wa_message_id=${op.wa_message_id ?? 'none'} reason=not_confirmed_non_safe`,
            );
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
            emitAlertChecked(
              config.botName,
              'outbound_quarantined',
              `whatsoup@${config.botName} outbound op ${op.id} quarantined`,
              `replay_policy=${op.replay_policy} wa_message_id=none reason=no_wa_id_non_safe`,
            );
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'postConnectRecovery: error reconciling maybe_sent ops');
    }

    // Step 3: Log recovery run
    this.logRecoveryRun('post_connect', stats);

    // Gate the quarantine clear behind a genuine-recovery proof. A drained queue
    // is NOT proof auth recovered (ml-bot 401, 2026-06-21). The gate emits a real
    // clear only when a confirmed outbound proves auth works; otherwise it
    // suppresses the cosmetic clear and raises one durable HUMAN_REQUIRED escalation.
    // Fail-safe: a gate failure must never break recovery — fall back to the legacy
    // clear so a healthy instance is not left with a stale quarantine alert.
    try {
      const stateDir = join(homedir(), '.local', 'state', 'bot-errors', 'breaker');
      const decision = gateQuarantineClear(config.botName, {
        now: () => (this.statements.selectNow.get() as { now: string }).now,
        stateDir,
        recentWindowSeconds: 900,
        attemptWindowSeconds: 1800,
        tripThreshold: 5,
        confirmedOutboundWithinSeconds: this.confirmedOutboundProbe,
        emitClear: () => clearAlertSourceChecked(config.botName, 'outbound_quarantined'),
        emitEscalation: (evidence: string) =>
          emitAlertChecked(
            config.botName,
            'auth_terminal',
            `whatsoup@${config.botName} authentication appears unresolved — repair lane cannot restore it`,
            `HUMAN_REQUIRED ${evidence}`,
            'critical',
          ),
        emitGateFailure: (evidence: string) =>
          emitAlertChecked(
            config.botName,
            'fleet_health_verify_gate_failed',
            `whatsoup@${config.botName} verify gate failed — legacy clear fallback used`,
            `FLEET_HEALTH_VERIFY_GATE failure: ${evidence}; legacy_clear_fallback=true`,
            'warning',
          ),
      });
      log.info({ decision }, 'postConnectRecovery: quarantine-clear gate decision');
    } catch (err) {
      log.warn({ err }, 'postConnectRecovery: verify gate failed; falling back to legacy clear');
      clearAlertSourceChecked(config.botName, 'outbound_quarantined');
    }

    log.info(stats, 'postConnectRecovery: complete');
    return stats;
  }

  /**
   * Periodic sweep: promote outbound ops stuck in 'submitted' for > 30 s to
   * 'maybe_sent'. Runs on a short interval while the process is live so that
   * ops whose echo never arrives are not silently stranded.
   *
   * Returns the number of ops promoted.
   */
  sweepStaleSubmitted(): number {
    const result = this.statements.sweepStaleSubmitted.run();
    const count = Number(result.changes);
    if (count > 0) {
      log.warn({ count }, 'sweepStaleSubmitted: promoted stale submitted ops');
    }
    return count;
  }

  /**
   * Periodic reconciler for inbound rows stranded in a non-terminal
   * processing_status WHILE the process is live (preConnectRecovery only runs at
   * startup). Without this a stranded row never reaches complete/failed and
   * retention never reclaims it → unbounded growth. Three buckets:
   *
   *   1. open (pending/processing/turn_done) with an echoed terminal op, older
   *      than 5 min → complete, 'recovered_response_sent' (delivery confirmed but
   *      the completion step was missed — the QR-102 strand, seen live not just
   *      across crashes).
   *   2. turn_done older than 24h with no echoed terminal op → complete,
   *      'recovered_turn_done' (a no-reply turn that finished but never finalized).
   *   3. pending/processing older than 24h with no echoed terminal op → failed
   *      (terminal_reason='error') — the turn silently died with no delivered reply.
   *
   * The whole sweep runs in one transaction. It uses completeInbound /
   * markInboundComplete / markInboundFailed (never completeTurn, which opens its
   * own BEGIN IMMEDIATE). continuity_candidate_* columns are left untouched.
   */
  sweepStuckInbound(): StuckInboundSweepResult {
    return withTransaction(this.db, () => {
      let completedEchoed = 0;
      let completedTurnDone = 0;
      let failedStale = 0;

      const echoed = this.statements.getOpenInboundWithEchoedTerminal.all() as Array<{ seq: number }>;
      for (const row of echoed) {
        this.completeInbound(row.seq, 'recovered_response_sent');
        completedEchoed += 1;
      }

      const turnDone = this.statements.getStaleTurnDoneNoSuccess.all() as Array<{ seq: number }>;
      for (const row of turnDone) {
        this.markInboundComplete(row.seq, 'recovered_turn_done');
        completedTurnDone += 1;
      }

      const staleOpen = this.statements.getStaleOpenNoSuccess.all() as Array<{ seq: number }>;
      for (const row of staleOpen) {
        this.markInboundFailed(row.seq, 'stale_reclaim');
        failedStale += 1;
      }

      const result: StuckInboundSweepResult = { completedEchoed, completedTurnDone, failedStale };
      if (completedEchoed > 0 || completedTurnDone > 0 || failedStale > 0) {
        log.info(result, 'sweepStuckInbound: finalized stuck inbound rows');
      }
      return result;
    });
  }

  getHealthStats(): { pendingOutbound: number; quarantinedOutbound: number; lastRecoveryAt: string | null } {
    const pending = this.statements.getPendingOutboundCount.get() as { count: number };
    const quarantined = this.statements.getQuarantinedOutboundCount.get() as { count: number };
    const lastRecovery = this.statements.getLastRecoveryRunCompletedAt.get() as
      | { completed_at: string }
      | undefined;
    return {
      pendingOutbound: pending.count,
      quarantinedOutbound: quarantined.count,
      lastRecoveryAt: lastRecovery?.completed_at ?? null,
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
      durability.markMaybeSent(opId, (err as Error)?.message ?? 'send_failed');
    }
    throw err;
  }
}

/**
 * Drain outbound ops in `status='pending'` by actually re-sending them.
 *
 * `postConnectRecovery` resets unconfirmed `safe`/`read_only` `maybe_sent` ops to
 * `pending` (the "reset for replay" step), but nothing else re-sends them — so
 * before this drainer existed, genuinely-undelivered safe/read_only ops were
 * silently dropped (BEAD-057). This function closes that gap. It is invoked both
 * from the post-connect recover callback (after `postConnectRecovery`) and from
 * the live echo-timeout interval, so any op that lands in `pending` between
 * reconnects is re-sent without waiting for a future restart.
 *
 * Per-op handling:
 *  - Reconstructable text op (`op_type === 'text'` and payload parses to
 *    `{ text: string }`, the exact shape `sendTracked` writes): `markSending`,
 *    re-send via `messenger.sendMessage`, then `markSubmitted` with the receipt.
 *    On send failure → `markMaybeSent` so the op re-enters the reconnect-paced
 *    recovery loop (no inline retry / tight-loop).
 *  - Non-reconstructable op (unknown `op_type`, or a `text` op whose payload does
 *    not parse to `{ text }`): `markQuarantined` + an `outbound_quarantined`
 *    alert. We must NOT leave these `pending` forever — that would reintroduce the
 *    original silent-drop bug for non-text ops.
 *
 * Idempotency / double-send: only `safe`/`read_only` ops ever reach `pending`
 * (postConnectRecovery quarantines `unsafe`, and terminal USER replies are
 * `unsafe`). A replay that duplicates an already-delivered message is therefore
 * the ACCEPTED tradeoff for safe/read_only ops (admin notices, heal notices, MCP
 * read ops) — never for user-terminal replies. This is the same risk profile
 * `sendTracked`-created ops already carry on a maybe_sent → reset cycle; the
 * drainer does not widen it.
 *
 * One failing op never aborts the rest of the drain. Returns `{ resent, expired }`:
 * `resent` = ops transitioned out of `pending` via `markSubmitted`; `expired` =
 * `status_ping` ops aged out past `STATUS_OP_TTL_MS` (quarantined, never sent).
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

      if (
        op.op_type === 'status_ping' &&
        Date.parse(op.created_at + 'Z') < Date.now() - STATUS_OP_TTL_MS
      ) {
        // PR-C TTL age-out (status class only): a "back online" ping stranded in
        // `pending` past the TTL is stale misinformation. Mirror the
        // non-reconstructable branch — quarantine (a terminal state retention
        // reclaims) + alert — but never re-send it. `text` ops are exempt: this
        // branch is gated on op_type='status_ping'.
        durability.markQuarantined(op.id);
        log.warn(
          { opId: op.id, opType: op.op_type, createdAt: op.created_at },
          'drainPendingOutbound: stale status_ping past TTL → quarantined',
        );
        emitAlertChecked(
          config.botName,
          'outbound_quarantined',
          `whatsoup@${config.botName} outbound op ${op.id} quarantined`,
          `replay_policy=${op.replay_policy} op_type=${op.op_type} reason=status_op_ttl_expired`,
        );
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
