import type { Database } from './database.ts';
import { getTransactionRunner, type TransactionRunner } from './db-tx.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('session-lifecycle-store');

type PreparedStatement = ReturnType<Database['raw']['prepare']>;

export interface BeginFreshSessionLifecycleParams {
  pid: number;
  cwd: string;
  chatJid: string;
  workspaceKey: string;
  provider: string;
  conversationKey: string;
  checkpointWatchdogState?: string | null;
}

export interface ReactivateSessionLifecycleParams {
  agentSessionRowId: number;
  providerSessionId: string;
  provider: string;
  pid: number;
  workspaceKey: string;
  conversationKey: string;
  checkpointWatchdogState?: string | null;
}

export interface RetireSessionLifecycleParams {
  agentSessionRowId?: number;
  providerSessionId: string;
  provider: string;
}

export interface RetireExactSessionLifecycleParams {
  agentSessionRowId: number;
  providerSessionId: string;
  provider: string;
  workspaceKey: string;
  conversationKey: string;
}

export interface UpdateExactSessionCheckpointStatusParams {
  providerSessionId: string;
  conversationKey: string;
  sessionStatus: string;
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

export type CompletedDeliveryIdentityAdmissionReason =
  | 'missing'
  | 'invalid'
  | 'scope_mismatch';

export interface QuarantineCompletedDeliveryIdentityCheckpointParams {
  conversationKey: string;
  providerSessionId: string;
  provider: string;
  reason: CompletedDeliveryIdentityAdmissionReason;
}

export interface QuarantineCompletedDeliveryIdentityAgentSessionParams {
  agentSessionRowId: number;
  providerSessionId: string;
  provider: string;
  workspaceKey: string | null;
  reason: CompletedDeliveryIdentityAdmissionReason;
}

interface LifecycleStatements {
  insertAgentSession: PreparedStatement;
  beginFreshCheckpoint: PreparedStatement;
  selectResumableRowsBySessionId: PreparedStatement;
  selectExactResumableAgentSession: PreparedStatement;
  selectExactResumableCheckpoint: PreparedStatement;
  reactivateExactAgentSession: PreparedStatement;
  reactivateExactSessionCheckpoint: PreparedStatement;
  retireExactAgentSession: PreparedStatement;
  retireSessionCheckpoints: PreparedStatement;
  retireScopedAgentSession: PreparedStatement;
  retireExactSessionCheckpoint: PreparedStatement;
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
  agentSessionRowAlreadyInStatusForProvider: PreparedStatement;
  updateExactSessionCheckpointStatus: PreparedStatement;
  recordCompletedDeliveryIdentityAdmission: PreparedStatement;
  quarantineExactSessionCheckpoint: PreparedStatement;
  selectQuarantinableAgentRowsForCheckpoint: PreparedStatement;
  selectExactQuarantinableAgentSessionForAdmission: PreparedStatement;
  markExactAgentResumeFailed: PreparedStatement;
  resolveCompletedDeliveryIdentityAdmissionsForFreshLifecycle: PreparedStatement;
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

function validateIdentityPart(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
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
        VALUES (?, NULL, NULL, NULL, NULL, NULL, ?, ?, 'active', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
        ON CONFLICT(conversation_key) DO UPDATE SET
          session_id = NULL,
          transcript_path = NULL,
          active_turn_id = NULL,
          last_inbound_seq = NULL,
          last_flushed_outbound_id = NULL,
          watchdog_state = excluded.watchdog_state,
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
      selectExactResumableAgentSession: prepare(`
        SELECT id
        FROM agent_sessions
        WHERE id = ?
          AND session_id = ?
          AND provider = ?
          AND workspace_key = ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
      `),
      selectExactResumableCheckpoint: prepare(`
        SELECT id
        FROM session_checkpoints
        WHERE conversation_key = ?
          AND session_id = ?
          AND session_status IN ('active', 'suspended', 'orphaned')
      `),
      reactivateExactAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'active', claude_pid = ?, ended_at = NULL
        WHERE id = ?
          AND session_id = ?
          AND provider = ?
          AND workspace_key = ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
      `),
      reactivateExactSessionCheckpoint: prepare(`
        UPDATE session_checkpoints
        SET session_status = 'active',
            claude_pid = ?,
            watchdog_state = CASE WHEN ? = 1 THEN ? ELSE watchdog_state END,
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE id = ?
          AND conversation_key = ?
          AND session_id = ?
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
      retireScopedAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now'))
        WHERE id = ?
          AND session_id = ?
          AND provider = ?
          AND workspace_key = ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
      `),
      retireExactSessionCheckpoint: prepare(`
        UPDATE session_checkpoints
        SET session_status = 'ended',
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE id = ?
          AND conversation_key = ?
          AND session_id = ?
          AND session_status IN ('active', 'suspended', 'orphaned')
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
        WHERE conversation_key = ? AND session_id = ?
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
        WHERE id = ? AND session_id = ? AND provider = ?
          AND status IN ('active', 'orphaned')
      `),
      endExactAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now'))
        WHERE id = ? AND session_id = ? AND provider = ?
          AND status IN ('active', 'orphaned')
      `),
      suspendPreInitAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'suspended', ended_at = NULL
        WHERE id = ? AND session_id IS NULL AND provider = ?
          AND status IN ('active', 'orphaned')
      `),
      endPreInitAgentSession: prepare(`
        UPDATE agent_sessions
        SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now'))
        WHERE id = ? AND session_id IS NULL AND provider = ?
          AND status IN ('active', 'orphaned')
      `),
      closeExactSessionCheckpoints: prepare(`
        UPDATE session_checkpoints
        SET session_status = ?,
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE conversation_key = ? AND session_id = ?
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
      agentSessionRowAlreadyInStatusForProvider: prepare(`
        SELECT 1 FROM agent_sessions
        WHERE id = ? AND provider = ? AND session_id IS ? AND status = ?
      `),
      updateExactSessionCheckpointStatus: prepare(`
        UPDATE session_checkpoints
        SET session_status = ?,
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE id = ?
           AND conversation_key = ?
           AND session_id = ?
      `),
      recordCompletedDeliveryIdentityAdmission: prepare(`
        INSERT INTO completed_delivery_identity_admissions (
          target_kind, target_id, state, reason, attempts, owner, next_action
        ) VALUES (?, ?, 'quarantined', ?, 1, ?, ?)
        ON CONFLICT(target_kind, target_id) WHERE state = 'quarantined' DO NOTHING
      `),
      quarantineExactSessionCheckpoint: prepare(`
        UPDATE session_checkpoints
        SET session_status = 'orphaned',
            checkpoint_version = checkpoint_version + 1,
            updated_at = datetime('now')
        WHERE id = ?
          AND conversation_key = ?
          AND session_id = ?
          AND session_status IN ('active', 'suspended')
      `),
      selectQuarantinableAgentRowsForCheckpoint: prepare(`
        SELECT id
        FROM agent_sessions
        WHERE session_id = ?
          AND provider = ?
          AND workspace_key = ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
        ORDER BY id
      `),
      selectExactQuarantinableAgentSessionForAdmission: prepare(`
        SELECT id
        FROM agent_sessions
        WHERE id = ?
          AND session_id = ?
          AND provider = ?
          AND workspace_key IS ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
      `),
      markExactAgentResumeFailed: prepare(`
        UPDATE agent_sessions
        SET status = 'resume_failed',
            ended_at = COALESCE(ended_at, datetime('now'))
        WHERE id = ?
          AND session_id = ?
          AND provider = ?
          AND workspace_key IS ?
          AND status IN ('active', 'suspended', 'orphaned', 'crashed')
      `),
      resolveCompletedDeliveryIdentityAdmissionsForFreshLifecycle: prepare(`
        UPDATE completed_delivery_identity_admissions
        SET state = 'resolved',
            last_transition_at = datetime('now'),
            resolved_at = datetime('now')
        WHERE state = 'quarantined'
          AND (
            (
              target_kind = 'checkpoint'
              AND EXISTS (
                SELECT 1
                FROM session_checkpoints
                WHERE session_checkpoints.id = completed_delivery_identity_admissions.target_id
                  AND session_checkpoints.conversation_key = ?
              )
            )
            OR (
              target_kind = 'agent_session'
              AND owner = 'fresh_inbound'
              AND EXISTS (
                SELECT 1
                FROM agent_sessions
                WHERE agent_sessions.id = completed_delivery_identity_admissions.target_id
                  AND agent_sessions.workspace_key = ?
              )
            )
          )
      `),
    };
  }

  beginFreshCheckpoint(conversationKey: string, pid?: number): void {
    this.statements.beginFreshCheckpoint.run(conversationKey, null, pid ?? null);
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
      this.statements.beginFreshCheckpoint.run(
        params.conversationKey,
        params.checkpointWatchdogState ?? null,
        params.pid || null,
      );
      this.statements.resolveCompletedDeliveryIdentityAdmissionsForFreshLifecycle.run(
        params.conversationKey,
        params.workspaceKey,
      );
      return rowId;
    });
  }

  quarantineCompletedDeliveryIdentityCheckpoint(
    params: QuarantineCompletedDeliveryIdentityCheckpointParams,
  ): void {
    validateProviderSessionId(params.providerSessionId);
    validateProvider(params.provider);
    validateIdentityPart(params.conversationKey, 'Conversation key');
    return this.transact(() => {
      const checkpoint = this.statements.selectExactResumableCheckpoint.get(
        params.conversationKey,
        params.providerSessionId,
      ) as { id: number } | undefined;
      if (checkpoint === undefined) {
        throw new Error('Exact resumable checkpoint does not match the completed-delivery identity');
      }
      this.statements.recordCompletedDeliveryIdentityAdmission.run(
        'checkpoint',
        checkpoint.id,
        params.reason,
        'fresh_inbound',
        'fresh_inbound',
      );
      const checkpointResult = this.statements.quarantineExactSessionCheckpoint.run(
        checkpoint.id,
        params.conversationKey,
        params.providerSessionId,
      );
      if (Number(checkpointResult.changes) === 0) {
        const stillQuarantined = this.statements.selectExactResumableCheckpoint.get(
          params.conversationKey,
          params.providerSessionId,
        ) as { id: number } | undefined;
        if (stillQuarantined === undefined) {
          throw new Error('Exact completed-delivery checkpoint changed during quarantine');
        }
      }
      const agentRows = this.statements.selectQuarantinableAgentRowsForCheckpoint.all(
        params.providerSessionId,
        params.provider,
        params.conversationKey,
      ) as Array<{ id: number }>;
      for (const agentRow of agentRows) {
        this.statements.recordCompletedDeliveryIdentityAdmission.run(
          'agent_session',
          agentRow.id,
          params.reason,
          'fresh_inbound',
          'fresh_inbound',
        );
        requireChanges(
          this.statements.markExactAgentResumeFailed.run(
            agentRow.id,
            params.providerSessionId,
            params.provider,
            params.conversationKey,
          ),
          'Exact agent session changed during completed-delivery identity quarantine',
        );
      }
    });
  }

  quarantineCompletedDeliveryIdentityAgentSession(
    params: QuarantineCompletedDeliveryIdentityAgentSessionParams,
  ): void {
    validateRowId(params.agentSessionRowId);
    validateProviderSessionId(params.providerSessionId);
    validateProvider(params.provider);
    if (params.workspaceKey !== null) {
      validateIdentityPart(params.workspaceKey, 'Workspace key');
    }
    this.transact(() => {
      const row = this.statements.selectExactQuarantinableAgentSessionForAdmission.get(
        params.agentSessionRowId,
        params.providerSessionId,
        params.provider,
        params.workspaceKey,
      ) as { id: number } | undefined;
      if (row === undefined) {
        throw new Error('Exact agent session row does not match the completed-delivery identity');
      }
      const owner = params.workspaceKey === null ? 'operator' : 'fresh_inbound';
      this.statements.recordCompletedDeliveryIdentityAdmission.run(
        'agent_session',
        row.id,
        params.reason,
        owner,
        owner,
      );
      requireChanges(
        this.statements.markExactAgentResumeFailed.run(
          row.id,
          params.providerSessionId,
          params.provider,
          params.workspaceKey,
        ),
        'Exact agent session changed during completed-delivery identity quarantine',
      );
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
    validateRowId(params.agentSessionRowId);
    validateProviderSessionId(params.providerSessionId);
    validateProvider(params.provider);
    validateIdentityPart(params.workspaceKey, 'Workspace key');
    validateIdentityPart(params.conversationKey, 'Conversation key');
    return this.transact(() => {
      const row = this.statements.selectExactResumableAgentSession.get(
        params.agentSessionRowId,
        params.providerSessionId,
        params.provider,
        params.workspaceKey,
      ) as { id: number } | undefined;
      if (row === undefined) {
        throw new Error('Exact resumable agent row does not match the provider and workspace identity');
      }
      const checkpoint = this.statements.selectExactResumableCheckpoint.get(
        params.conversationKey,
        params.providerSessionId,
      ) as { id: number } | undefined;
      if (checkpoint === undefined) {
        throw new Error('Exact resumable checkpoint does not match the conversation identity');
      }
      requireChanges(
        this.statements.reactivateExactAgentSession.run(
          params.pid,
          row.id,
          params.providerSessionId,
          params.provider,
          params.workspaceKey,
        ),
        'Exact agent session row is not resumable or does not match the provider session ID',
      );
      requireChanges(
        this.statements.reactivateExactSessionCheckpoint.run(
          params.pid || null,
          params.checkpointWatchdogState === undefined ? 0 : 1,
          params.checkpointWatchdogState ?? null,
          checkpoint.id,
          params.conversationKey,
          params.providerSessionId,
        ),
        'Exact resumable checkpoint changed during activation',
      );
      return row.id;
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

  retireExactSessionLifecycle(params: RetireExactSessionLifecycleParams): number {
    validateRowId(params.agentSessionRowId);
    validateProviderSessionId(params.providerSessionId);
    validateProvider(params.provider);
    validateIdentityPart(params.workspaceKey, 'Workspace key');
    validateIdentityPart(params.conversationKey, 'Conversation key');
    return this.transact(() => {
      const row = this.statements.selectExactResumableAgentSession.get(
        params.agentSessionRowId,
        params.providerSessionId,
        params.provider,
        params.workspaceKey,
      ) as { id: number } | undefined;
      if (row === undefined) {
        throw new Error('Exact resumable agent row does not match the provider and workspace identity');
      }
      const checkpoint = this.statements.selectExactResumableCheckpoint.get(
        params.conversationKey,
        params.providerSessionId,
      ) as { id: number } | undefined;
      if (checkpoint === undefined) {
        throw new Error('Exact resumable checkpoint does not match the conversation identity');
      }
      requireChanges(
        this.statements.retireScopedAgentSession.run(
          row.id,
          params.providerSessionId,
          params.provider,
          params.workspaceKey,
        ),
        'Exact agent session row changed during retirement',
      );
      requireChanges(
        this.statements.retireExactSessionCheckpoint.run(
          checkpoint.id,
          params.conversationKey,
          params.providerSessionId,
        ),
        'Exact session checkpoint changed during retirement',
      );
      return row.id;
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
        this.statements.orphanExactSessionCheckpoints.run(
          params.conversationKey,
          params.providerSessionId,
        ),
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
      if (Number(rowResult.changes) < 1) {
        // The close statements only match status = 'active', and can only ever
        // transition a row INTO the requested status. So the ONLY idempotent
        // no-op is a true repeat: the same-identity row is already in exactly the
        // status this close would set (a prior identical close already ran — e.g.
        // duplicate /new, or the concurrent-close race). Every other zero-change
        // case is a real invariant violation that must still throw: an absent row;
        // a still-active row whose session_id differs (codex resume-rejection
        // rewrite); OR — the reachable evict-suspend/resume race — a same-identity
        // row terminal in a DIFFERENT status (e.g. a delayed idle-suspend left it
        // 'suspended', then the user /new-ends it): silently no-oping there would
        // abandon a user-ended session as resumable. So the probe mirrors the
        // close's EXACT identity AND requires the row already be in params.status
        // (null-safe IS for the pre-init null-session branch).
        const rowAlreadyInStatus = this.statements.agentSessionRowAlreadyInStatusForProvider.get(
          params.agentSessionRowId,
          params.provider,
          params.providerSessionId,
          params.status,
        );
        if (rowAlreadyInStatus) {
          log.info(
            { agentSessionRowId: params.agentSessionRowId, provider: params.provider, status: params.status },
            'session lifecycle close: row already in the requested status for this identity — idempotent no-op',
          );
          return;
        }
        throw new Error('Exact active agent session row could not be closed');
      }

      const checkpointResult = params.providerSessionId === null
        ? this.statements.closePreInitCheckpoint.run(params.status, params.conversationKey)
        : this.statements.closeExactSessionCheckpoints.run(
            params.status,
            params.conversationKey,
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

  updateExactSessionCheckpointStatus(
    params: UpdateExactSessionCheckpointStatusParams,
  ): number {
    validateProviderSessionId(params.providerSessionId);
    validateIdentityPart(params.conversationKey, 'Conversation key');
    return this.transact(() => {
      const checkpoint = this.statements.selectExactResumableCheckpoint.get(
        params.conversationKey,
        params.providerSessionId,
      ) as { id: number } | undefined;
      if (checkpoint === undefined) {
        throw new Error('Exact resumable checkpoint does not match the conversation identity');
      }
      requireChanges(
        this.statements.updateExactSessionCheckpointStatus.run(
          params.sessionStatus,
          checkpoint.id,
          params.conversationKey,
          params.providerSessionId,
        ),
        'Exact session checkpoint changed during status update',
      );
      return checkpoint.id;
    });
  }
}
