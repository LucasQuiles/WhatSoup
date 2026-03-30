import { createHash } from 'node:crypto';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { Messenger } from './types.ts';
import { toConversationKey } from './conversation-key.ts';

const log = createChildLogger('durability');

// ── Status string unions ──

export type OutboundStatus = 'pending' | 'sending' | 'submitted' | 'echoed' | 'maybe_sent' | 'failed_permanent' | 'quarantined';
export type InboundStatus = 'pending' | 'processing' | 'turn_done' | 'complete' | 'failed';
export type SessionStatus = 'active' | 'suspended' | 'orphaned' | 'ended';
export type ToolCallStatus = 'pending' | 'executing' | 'complete' | 'replayed' | 'quarantined';

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
  wa_message_id: string | null;
  replay_policy: string;
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

export interface OutboundOpParams {
  conversationKey: string;
  chatJid: string;
  opType: string;
  payload: string;
  replayPolicy: 'safe' | 'unsafe' | 'read_only';
  sourceInboundSeq?: number;
  isTerminal?: boolean;
}

export class DurabilityEngine {
  constructor(private db: Database) {}

  // ── Inbound events ──
  journalInbound(messageId: string, conversationKey: string, chatJid: string, routedTo: string): number {
    const result = this.db.raw.prepare(
      `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to, processing_status)
       VALUES (?, ?, ?, ?, 'processing')`,
    ).run(messageId, conversationKey, chatJid, routedTo);
    const seq = Number(result.lastInsertRowid);
    log.debug({ seq, messageId, routedTo }, 'journalInbound');
    return seq;
  }

  markTurnDone(seq: number): void {
    this.db.raw.prepare(`UPDATE inbound_events SET processing_status = 'turn_done' WHERE seq = ?`).run(seq);
  }

  markInboundComplete(seq: number, terminalReason: string): void {
    this.db.raw.prepare(
      `UPDATE inbound_events SET processing_status = 'complete', completed_at = datetime('now'), terminal_reason = ? WHERE seq = ?`,
    ).run(terminalReason, seq);
  }

  markInboundFailed(seq: number): void {
    this.db.raw.prepare(
      `UPDATE inbound_events SET processing_status = 'failed', completed_at = datetime('now'), terminal_reason = 'error' WHERE seq = ?`,
    ).run(seq);
  }

  markInboundSkipped(seq: number, reason: string): void {
    this.db.raw.prepare(
      `UPDATE inbound_events SET processing_status = 'complete', completed_at = datetime('now'), terminal_reason = ? WHERE seq = ?`,
    ).run(reason, seq);
  }

  /** Transition inbound event: processing → turn_done → complete. */
  completeInbound(seq: number, reason: string): void {
    const row = this.db.raw.prepare(
      `SELECT processing_status FROM inbound_events WHERE seq = ?`,
    ).get(seq) as { processing_status: string } | undefined;
    if (row?.processing_status === 'processing') {
      this.markTurnDone(seq);
    }
    this.markInboundComplete(seq, reason);
  }

  // ── Outbound ops ──
  createOutboundOp(params: OutboundOpParams): number {
    const hash = createHash('sha256').update(params.payload).digest('hex');
    const result = this.db.raw.prepare(
      `INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, payload_hash, status, source_inbound_seq, is_terminal, replay_policy)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      params.conversationKey, params.chatJid, params.opType, params.payload, hash,
      params.sourceInboundSeq ?? null, params.isTerminal ? 1 : 0, params.replayPolicy,
    );
    const id = Number(result.lastInsertRowid);
    log.debug({ id, opType: params.opType, replayPolicy: params.replayPolicy }, 'createOutboundOp');
    return id;
  }

  markSending(id: number): void {
    this.db.raw.prepare(`UPDATE outbound_ops SET status = 'sending' WHERE id = ?`).run(id);
  }

  markSubmitted(id: number, waMessageId: string | null): void {
    this.db.raw.prepare(
      `UPDATE outbound_ops SET status = 'submitted', wa_message_id = ?, submitted_at = datetime('now') WHERE id = ?`,
    ).run(waMessageId, id);
  }

  markEchoed(id: number): void {
    this.db.raw.prepare(
      `UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = ?`,
    ).run(id);
    // If this is a terminal op, complete the linked inbound event
    const row = this.db.raw.prepare(
      `SELECT source_inbound_seq, is_terminal FROM outbound_ops WHERE id = ?`,
    ).get(id) as { source_inbound_seq: number | null; is_terminal: number } | undefined;
    if (row?.is_terminal && row.source_inbound_seq) {
      this.completeInbound(row.source_inbound_seq, 'response_sent');
    }
  }

  markMaybeSent(id: number, error?: string): void {
    this.db.raw.prepare(
      `UPDATE outbound_ops SET status = 'maybe_sent', error = ? WHERE id = ?`,
    ).run(error ?? null, id);
  }

  markFailedPermanent(id: number, error: string): void {
    this.db.raw.prepare(
      `UPDATE outbound_ops SET status = 'failed_permanent', error = ? WHERE id = ?`,
    ).run(error, id);
  }

  markQuarantined(id: number): void {
    this.db.raw.prepare(`UPDATE outbound_ops SET status = 'quarantined' WHERE id = ?`).run(id);
  }

  markTerminal(id: number): void {
    this.db.raw.prepare(`UPDATE outbound_ops SET is_terminal = 1 WHERE id = ?`).run(id);
  }

  // ── Echo matching ──
  matchEcho(waMessageId: string): boolean {
    const row = this.db.raw.prepare(
      `SELECT id FROM outbound_ops WHERE wa_message_id = ? AND status = 'submitted'`,
    ).get(waMessageId) as { id: number } | undefined;
    if (row) {
      this.markEchoed(row.id);
      return true;
    }
    return false;
  }

  // ── Tool calls ──
  recordToolCall(conversationKey: string, toolName: string, toolInput: string, replayPolicy: string, checkpointId?: number): number {
    const result = this.db.raw.prepare(
      `INSERT INTO tool_calls (conversation_key, session_checkpoint_id, tool_name, tool_input, status, replay_policy)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(conversationKey, checkpointId ?? null, toolName, toolInput, replayPolicy);
    const id = Number(result.lastInsertRowid);
    log.debug({ id, toolName, replayPolicy }, 'recordToolCall');
    return id;
  }

  markToolExecuting(id: number): void {
    this.db.raw.prepare(`UPDATE tool_calls SET status = 'executing' WHERE id = ?`).run(id);
  }

  markToolComplete(id: number, result: string, outboundOpId?: number): void {
    this.db.raw.prepare(
      `UPDATE tool_calls SET status = 'complete', result = ?, completed_at = datetime('now'), outbound_op_id = ? WHERE id = ?`,
    ).run(result, outboundOpId ?? null, id);
  }

  // ── Session checkpoints ──
  upsertSessionCheckpoint(conversationKey: string, fields: {
    sessionId?: string; transcriptPath?: string; activeTurnId?: string | null;
    lastInboundSeq?: number; lastFlushedOutboundId?: number;
    watchdogState?: string; workspacePath?: string;
    claudePid?: number; sessionStatus?: string;
  }): void {
    this.db.raw.prepare(`
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
    `).run(
      conversationKey, fields.sessionId ?? null, fields.transcriptPath ?? null,
      fields.activeTurnId ?? null, fields.lastInboundSeq ?? null,
      fields.lastFlushedOutboundId ?? null, fields.watchdogState ?? null,
      fields.workspacePath ?? null, fields.claudePid ?? null,
      fields.sessionStatus ?? 'active',
    );
  }

  getSessionCheckpoint(conversationKey: string): SessionCheckpointRow | undefined {
    return this.db.raw.prepare(
      `SELECT * FROM session_checkpoints WHERE conversation_key = ?`,
    ).get(conversationKey) as SessionCheckpointRow | undefined;
  }

  getAllActiveCheckpoints(): ActiveSessionCheckpointRow[] {
    return this.db.raw.prepare(
      `SELECT id, conversation_key, claude_pid, session_status FROM session_checkpoints WHERE session_status = 'active'`,
    ).all() as unknown as ActiveSessionCheckpointRow[];
  }

  markSessionOrphaned(conversationKey: string): void {
    this.db.raw.prepare(
      `UPDATE session_checkpoints SET session_status = 'orphaned', updated_at = datetime('now') WHERE conversation_key = ?`,
    ).run(conversationKey);
  }

  // ── Getters for recovery ──
  getPendingInbound(): InboundEventRow[] {
    return this.db.raw.prepare(
      `SELECT seq, message_id, processing_status, routed_to FROM inbound_events WHERE processing_status IN ('pending', 'processing', 'turn_done')`,
    ).all() as unknown as InboundEventRow[];
  }

  getOutboundByStatus(status: string): OutboundOpRow[] {
    return this.db.raw.prepare(
      `SELECT id, wa_message_id, replay_policy, submitted_at, source_inbound_seq, is_terminal FROM outbound_ops WHERE status = ?`,
    ).all(status) as unknown as OutboundOpRow[];
  }

  // ── Recovery engine ──

  /**
   * Phase 1: Run before reconnect. All synchronous SQLite operations.
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
      const executingCalls = this.db.raw.prepare(
        `SELECT id, conversation_key, tool_name, replay_policy, outbound_op_id
         FROM tool_calls WHERE status IN ('executing', 'pending')`,
      ).all() as Array<{
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
          this.db.raw.prepare(
            `UPDATE tool_calls SET status = 'replayed', completed_at = datetime('now') WHERE id = ?`,
          ).run(tc.id);
          stats.toolCallsReplayed += 1;
          log.info(
            { toolCallId: tc.id, toolName: tc.tool_name },
            'preConnectRecovery: safe/read_only tool call marked as replayed',
          );
        } else {
          // unsafe without an outbound op: quarantine
          this.db.raw.prepare(
            `UPDATE tool_calls SET status = 'quarantined', completed_at = datetime('now') WHERE id = ?`,
          ).run(tc.id);
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
      const processingEvents = this.db.raw.prepare(
        `SELECT seq FROM inbound_events WHERE processing_status = 'processing'`,
      ).all() as Array<{ seq: number }>;

      for (const ev of processingEvents) {
        // Check if there's any terminal outbound op linked to this inbound
        const terminalOp = this.db.raw.prepare(
          `SELECT id FROM outbound_ops
           WHERE source_inbound_seq = ? AND is_terminal = 1
             AND status NOT IN ('quarantined', 'failed_permanent')`,
        ).get(ev.seq) as { id: number } | undefined;

        if (!terminalOp) {
          this.markInboundFailed(ev.seq);
          log.info(
            { inboundSeq: ev.seq },
            'preConnectRecovery: inbound processing with no terminal op marked failed',
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

    log.info(stats, 'preConnectRecovery: complete');
    return stats;
  }

  /**
   * Phase 2: Run after reconnect + echo grace period. All synchronous SQLite operations.
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
      const staleSubmitted = this.db.raw.prepare(
        `SELECT id FROM outbound_ops WHERE status = 'submitted' AND submitted_at < datetime('now', '-30 seconds')`,
      ).all() as Array<{ id: number }>;
      for (const op of staleSubmitted) {
        this.markMaybeSent(op.id, 'stale-submitted-no-echo');
        stats.outboundReconciled += 1;
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
          const found = this.db.raw.prepare(
            `SELECT pk FROM messages WHERE message_id = ?`,
          ).get(op.wa_message_id) as { pk: number } | undefined;

          if (found) {
            this.markEchoed(op.id);
            log.info(
              { opId: op.id, waMessageId: op.wa_message_id },
              'postConnectRecovery: maybe_sent confirmed via messages table → echoed',
            );
          } else if (op.replay_policy === 'safe' || op.replay_policy === 'read_only') {
            // Re-enqueue for replay: reset to pending
            this.db.raw.prepare(
              `UPDATE outbound_ops SET status = 'pending', error = NULL WHERE id = ?`,
            ).run(op.id);
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
          }
        } else {
          // No wa_message_id: definitely not delivered; apply replay policy
          if (op.replay_policy === 'safe' || op.replay_policy === 'read_only') {
            this.db.raw.prepare(
              `UPDATE outbound_ops SET status = 'pending', error = NULL WHERE id = ?`,
            ).run(op.id);
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
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'postConnectRecovery: error reconciling maybe_sent ops');
    }

    // Step 3: Log recovery run
    this.logRecoveryRun('post_connect', stats);

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
    const result = this.db.raw.prepare(
      `UPDATE outbound_ops SET status = 'maybe_sent', error = 'echo_timeout'
       WHERE status = 'submitted' AND submitted_at < datetime('now', '-30 seconds')`,
    ).run();
    const count = Number(result.changes);
    if (count > 0) {
      log.warn({ count }, 'sweepStaleSubmitted: promoted stale submitted ops');
    }
    return count;
  }

  getHealthStats(): { pendingOutbound: number; quarantinedOutbound: number; lastRecoveryAt: string | null } {
    const pending = this.db.raw.prepare(
      `SELECT COUNT(*) as count FROM outbound_ops WHERE status IN ('pending', 'sending', 'submitted', 'maybe_sent')`,
    ).get() as { count: number };
    const quarantined = this.db.raw.prepare(
      `SELECT COUNT(*) as count FROM outbound_ops WHERE status = 'quarantined'`,
    ).get() as { count: number };
    const lastRecovery = this.db.raw.prepare(
      `SELECT completed_at FROM recovery_runs ORDER BY id DESC LIMIT 1`,
    ).get() as { completed_at: string } | undefined;
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
      this.db.raw.prepare(`
        INSERT INTO recovery_runs
          (trigger, inbound_replayed, outbound_reconciled, outbound_replayed,
           outbound_quarantined, tool_calls_recovered, tool_calls_replayed,
           tool_calls_quarantined, sessions_restored, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
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
  opts: { replayPolicy: 'safe' | 'unsafe' | 'read_only'; isTerminal?: boolean; sourceInboundSeq?: number },
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
    const receipt = await messenger.sendMessage(chatJid, text);
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
