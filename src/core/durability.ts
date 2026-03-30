import { createHash } from 'node:crypto';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';

const log = createChildLogger('durability');

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
      this.markInboundComplete(row.source_inbound_seq, 'response_sent');
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

  getSessionCheckpoint(conversationKey: string): {
    id: number; conversation_key: string; session_id: string | null;
    claude_pid: number | null; session_status: string; checkpoint_version: number;
  } | undefined {
    return this.db.raw.prepare(
      `SELECT * FROM session_checkpoints WHERE conversation_key = ?`,
    ).get(conversationKey) as any;
  }

  getAllActiveCheckpoints(): Array<{
    id: number; conversation_key: string; claude_pid: number | null; session_status: string;
  }> {
    return this.db.raw.prepare(
      `SELECT id, conversation_key, claude_pid, session_status FROM session_checkpoints WHERE session_status = 'active'`,
    ).all() as any[];
  }

  markSessionOrphaned(conversationKey: string): void {
    this.db.raw.prepare(
      `UPDATE session_checkpoints SET session_status = 'orphaned', updated_at = datetime('now') WHERE conversation_key = ?`,
    ).run(conversationKey);
  }

  // ── Getters for recovery ──
  getPendingInbound(): Array<{ seq: number; message_id: string; processing_status: string; routed_to: string }> {
    return this.db.raw.prepare(
      `SELECT seq, message_id, processing_status, routed_to FROM inbound_events WHERE processing_status IN ('pending', 'processing', 'turn_done')`,
    ).all() as any[];
  }

  getOutboundByStatus(status: string): Array<{ id: number; wa_message_id: string | null; replay_policy: string; submitted_at: string | null; source_inbound_seq: number | null; is_terminal: number }> {
    return this.db.raw.prepare(
      `SELECT id, wa_message_id, replay_policy, submitted_at, source_inbound_seq, is_terminal FROM outbound_ops WHERE status = ?`,
    ).all(status) as any[];
  }
}
