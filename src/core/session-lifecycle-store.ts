import type { Database } from './database.ts';
import { getTransactionRunner, type TransactionRunner } from './db-tx.ts';

type PreparedStatement = ReturnType<Database['raw']['prepare']>;

export interface BeginFreshSessionLifecycleParams {
  pid: number;
  cwd: string;
  chatJid: string;
  workspaceKey: string;
  provider: string;
  conversationKey: string;
}

export interface ReactivateSessionLifecycleParams {
  agentSessionRowId?: number;
  providerSessionId: string;
  provider: string;
  pid: number;
}

export interface RetireSessionLifecycleParams {
  agentSessionRowId?: number;
  providerSessionId: string;
  provider: string;
}

export interface CloseSessionLifecycleFailureParams {
  agentSessionRowId: number;
  providerSessionId: string | null;
  provider: string;
  conversationKey: string;
  agentStatus: 'crashed' | 'resume_failed';
}

export interface CloseSessionLifecycleParams {
  agentSessionRowId: number;
  providerSessionId: string | null;
  provider: string;
  conversationKey: string;
  status: 'suspended' | 'ended';
}

interface LifecycleStatements {
  insertAgentSession: PreparedStatement;
  beginFreshCheckpoint: PreparedStatement;
  selectResumableRowsBySessionId: PreparedStatement;
  reactivateExactAgentSession: PreparedStatement;
  reactivateSessionCheckpoints: PreparedStatement;
  retireExactAgentSession: PreparedStatement;
  retireSessionCheckpoints: PreparedStatement;
  closeExactAgentFailure: PreparedStatement;
  closePreInitAgentFailure: PreparedStatement;
  orphanExactSessionCheckpoints: PreparedStatement;
  orphanPreInitCheckpoint: PreparedStatement;
  suspendExactAgentSession: PreparedStatement;
  endExactAgentSession: PreparedStatement;
  suspendPreInitAgentSession: PreparedStatement;
  endPreInitAgentSession: PreparedStatement;
  closeExactSessionCheckpoints: PreparedStatement;
  closePreInitCheckpoint: PreparedStatement;
  updateSessionCheckpointsStatusBySessionId: PreparedStatement;
}

function validateRowId(rowId: number): void {
  if (!Number.isSafeInteger(rowId) || rowId <= 0) {
    throw new RangeError('Agent session row ID must be a positive safe integer');
  }
}

function validateProviderSessionId(sessionId: string): void {
  if (sessionId.length === 0) throw new Error('Provider session ID must not be empty');
}

function validateProvider(provider: string): void {
  if (provider.length === 0) throw new Error('Provider must not be empty');
}

function requireChanges(result: { changes: number | bigint }, message: string): void {
  if (Number(result.changes) < 1) throw new Error(message);
}

/**
 * Owns cross-table agent-session/checkpoint lifecycle transitions. Every method
 * that touches both tables is a single SQLite transaction and uses an exact
 * row/session or row/conversation identity.
 */
export class SessionLifecycleStore {
  private readonly statements: LifecycleStatements;
  private readonly transact: TransactionRunner;

  constructor(db: Database) {
    this.transact = getTransactionRunner(db);
    const prepare = db.raw.prepare.bind(db.raw);
    this.statements = {
      insertAgentSession: prepare(`
        INSERT INTO agent_sessions (
          claude_pid, started_in_directory, chat_jid, workspace_key,
          started_at, status, provider
        ) VALUES (?, ?, ?, ?, datetime('now'), 'active', ?)
      `),
      beginFreshCheckpoint: prepare(`
        INSERT INTO session_checkpoints (
          conversation_key, session_id, transcript_path, active_turn_id,
          last_inbound_seq, last_flushed_outbound_id, watchdog_state, claude_pid,
          session_status, completed_inbound_seq,
          completed_delivery_jid, completed_delivery_namespace,
          completed_scope, completed_logical_turn_id, completed_manager_id,
          completed_generation
        )
        VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, ?, 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
        ON CONFLICT(conversation_key) DO UPDATE SET
          session_id = NULL,
          transcript_path = NULL,
          active_turn_id = NULL,
          last_inbound_seq = NULL,
          last_flushed_outbound_id = NULL,
          watchdog_state = NULL,
          claude_pid = excluded.claude_pid,
          session_status = 'active',
          completed_inbound_seq = NULL,
          completed_delivery_jid = NULL,
          completed_delivery_namespace = NULL,
          completed_scope = NULL,
          completed_logical_turn_id = NULL,
          completed_manager_id = NULL,
          completed_generation = NULL,
          checkpoint_version = checkpoint_version + 1,
          updated_at = datetime('now')
      `),
      selectResumableRowsBySessionId: prepare(`
        SELECT id
        FROM agent_sessions
        WHERE session_id = ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
        ORDER BY id
      `),
      reactivateExactAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'active', claude_pid = ?, ended_at = NULL
        WHERE id = ?
          AND session_id = ?
          AND provider = ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
      `),
      reactivateSessionCheckpoints: prepare(`
        UPDATE session_checkpoints
        SET session_status = 'active',
            claude_pid = ?,
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE session_id = ?
          AND session_status IN ('active', 'suspended', 'orphaned')
      `),
      retireExactAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now'))
        WHERE id = ?
          AND session_id = ?
          AND provider = ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
      `),
      retireSessionCheckpoints: prepare(`
        UPDATE session_checkpoints
        SET session_status = 'ended',
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE session_id = ?
      `),
      closeExactAgentFailure: prepare(`
        UPDATE agent_sessions
        SET status = ?, ended_at = COALESCE(ended_at, datetime('now'))
        WHERE id = ?
          AND session_id = ?
          AND provider = ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
      `),
      closePreInitAgentFailure: prepare(`
        UPDATE agent_sessions
        SET status = ?, ended_at = COALESCE(ended_at, datetime('now'))
        WHERE id = ?
          AND session_id IS NULL
          AND provider = ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
      `),
      orphanExactSessionCheckpoints: prepare(`
        UPDATE session_checkpoints
        SET session_status = 'orphaned',
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE session_id = ?
      `),
      orphanPreInitCheckpoint: prepare(`
        UPDATE session_checkpoints
        SET session_status = 'orphaned',
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE conversation_key = ? AND session_id IS NULL
      `),
      suspendExactAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'suspended', ended_at = NULL
        WHERE id = ? AND session_id = ? AND provider = ? AND status = 'active'
      `),
      endExactAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now'))
        WHERE id = ? AND session_id = ? AND provider = ? AND status = 'active'
      `),
      suspendPreInitAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'suspended', ended_at = NULL
        WHERE id = ? AND session_id IS NULL AND provider = ? AND status = 'active'
      `),
      endPreInitAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now'))
        WHERE id = ? AND session_id IS NULL AND provider = ? AND status = 'active'
      `),
      closeExactSessionCheckpoints: prepare(`
        UPDATE session_checkpoints
        SET session_status = ?,
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE session_id = ?
      `),
      closePreInitCheckpoint: prepare(`
        UPDATE session_checkpoints
        SET session_status = ?,
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE conversation_key = ? AND session_id IS NULL
      `),
      updateSessionCheckpointsStatusBySessionId: prepare(`
        UPDATE session_checkpoints
        SET session_status = ?,
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE session_id = ?
      `),
    };
  }

  beginFreshCheckpoint(conversationKey: string, pid?: number): void {
    this.statements.beginFreshCheckpoint.run(conversationKey, pid ?? null);
  }

  beginFreshSessionLifecycle(params: BeginFreshSessionLifecycleParams): number {
    validateProvider(params.provider);
    return this.transact(() => {
      const result = this.statements.insertAgentSession.run(
        params.pid,
        params.cwd,
        params.chatJid,
        params.workspaceKey,
        params.provider,
      );
      const rowId = Number(result.lastInsertRowid);
      validateRowId(rowId);
      this.statements.beginFreshCheckpoint.run(params.conversationKey, params.pid || null);
      return rowId;
    });
  }

  private resolveExactResumableRowId(
    providerSessionId: string,
    provider: string,
    suppliedRowId?: number,
  ): number {
    validateProviderSessionId(providerSessionId);
    validateProvider(provider);
    if (suppliedRowId !== undefined) {
      validateRowId(suppliedRowId);
      return suppliedRowId;
    }
    const rows = this.statements.selectResumableRowsBySessionId.all(providerSessionId) as
      Array<{ id: number }>;
    if (rows.length !== 1) {
      throw new Error(
        `Expected exactly one resumable agent row for provider session '${providerSessionId}', found ${rows.length}`,
      );
    }
    return rows[0]!.id;
  }

  reactivateSessionLifecycle(params: ReactivateSessionLifecycleParams): number {
    return this.transact(() => {
      const rowId = this.resolveExactResumableRowId(
        params.providerSessionId,
        params.provider,
        params.agentSessionRowId,
      );
      requireChanges(
        this.statements.reactivateExactAgentSession.run(
          params.pid,
          rowId,
          params.providerSessionId,
          params.provider,
        ),
        'Exact agent session row is not resumable or does not match the provider session ID',
      );
      requireChanges(
        this.statements.reactivateSessionCheckpoints.run(
          params.pid || null,
          params.providerSessionId,
        ),
        'No resumable checkpoint rows match the provider session ID',
      );
      return rowId;
    });
  }

  retireSessionLifecycle(params: RetireSessionLifecycleParams): number {
    return this.transact(() => {
      const rowId = this.resolveExactResumableRowId(
        params.providerSessionId,
        params.provider,
        params.agentSessionRowId,
      );
      requireChanges(
        this.statements.retireExactAgentSession.run(
          rowId,
          params.providerSessionId,
          params.provider,
        ),
        'Exact agent session row is not resumable or does not match the provider session ID',
      );
      requireChanges(
        this.statements.retireSessionCheckpoints.run(params.providerSessionId),
        'No checkpoint rows match the provider session ID',
      );
      return rowId;
    });
  }

  closeSessionLifecycleFailure(params: CloseSessionLifecycleFailureParams): void {
    validateRowId(params.agentSessionRowId);
    validateProvider(params.provider);
    this.transact(() => {
      if (params.providerSessionId === null) {
        requireChanges(
          this.statements.closePreInitAgentFailure.run(
            params.agentStatus,
            params.agentSessionRowId,
            params.provider,
          ),
          'Exact pre-init agent session row is not open',
        );
        requireChanges(
          this.statements.orphanPreInitCheckpoint.run(params.conversationKey),
          'Exact pre-init checkpoint is missing',
        );
        return;
      }
      validateProviderSessionId(params.providerSessionId);
      requireChanges(
        this.statements.closeExactAgentFailure.run(
          params.agentStatus,
          params.agentSessionRowId,
          params.providerSessionId,
          params.provider,
        ),
        'Exact agent session row does not match the failed provider session',
      );
      requireChanges(
        this.statements.orphanExactSessionCheckpoints.run(params.providerSessionId),
        'No checkpoint rows match the failed provider session',
      );
    });
  }

  closeSessionLifecycle(params: CloseSessionLifecycleParams): void {
    validateRowId(params.agentSessionRowId);
    validateProvider(params.provider);
    this.transact(() => {
      const rowStatement = params.providerSessionId === null
        ? params.status === 'suspended'
          ? this.statements.suspendPreInitAgentSession
          : this.statements.endPreInitAgentSession
        : params.status === 'suspended'
          ? this.statements.suspendExactAgentSession
          : this.statements.endExactAgentSession;
      const rowResult = params.providerSessionId === null
        ? rowStatement.run(params.agentSessionRowId, params.provider)
        : rowStatement.run(
            params.agentSessionRowId,
            params.providerSessionId,
            params.provider,
          );
      requireChanges(rowResult, 'Exact active agent session row could not be closed');

      const checkpointResult = params.providerSessionId === null
        ? this.statements.closePreInitCheckpoint.run(params.status, params.conversationKey)
        : this.statements.closeExactSessionCheckpoints.run(
            params.status,
            params.providerSessionId,
          );
      requireChanges(checkpointResult, 'Exact session checkpoint lifecycle could not be closed');
    });
  }

  updateSessionCheckpointsStatusBySessionId(
    sessionId: string,
    sessionStatus: string,
  ): number {
    validateProviderSessionId(sessionId);
    return Number(this.statements.updateSessionCheckpointsStatusBySessionId.run(
      sessionStatus,
      sessionId,
    ).changes);
  }
}
