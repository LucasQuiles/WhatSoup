/**
 * Lazy per-chat checkpoint adoption (#3530 successor).
 *
 * The first turn for a non-sandbox per_chat manager that has never started
 * reads the chat's checkpoint and decides what the new manager may adopt.
 * Owner rulings:
 * - Decision 15 part 2: a checkpoint whose session belongs to another
 *   namespace is never adopted. The chat recovers its own newest resumable
 *   session; otherwise it starts fresh with a notice.
 */
import type { Database } from '../../core/database.ts';
import { getResumableSessionForChat } from './session-db.ts';

export const CHECKPOINT_NOT_RESTORED_NOTICE =
  '_Previous session could not be restored_ — continuing from recent messages.';

export type CheckpointAdoption =
  | { kind: 'none' }
  | { kind: 'resume'; rowId: number; sessionId: string; recoveredOwn: boolean }
  | { kind: 'fresh_with_notice'; reason: 'foreign_checkpoint'; notice: string };

export const NO_CHECKPOINT_ADOPTION: CheckpointAdoption = { kind: 'none' };

export interface CheckpointAdoptionCheckpoint {
  session_id: string | null;
  session_status: string;
}

export interface CheckpointAdoptionManager {
  getDbRowId(): number | null;
  getProviderId(): string;
  getStatus(): { startedAt: string | null; sessionId: string | null };
}

interface SessionRowView {
  id: number;
  workspace_key: string | null;
  status: string;
}

/** Classify a checkpoint against the agent_sessions rows that carry its session id. */
export function classifyCheckpointAdoption(
  db: Database,
  input: {
    conversationKey: string;
    provider: string;
    checkpoint: CheckpointAdoptionCheckpoint | null | undefined;
  },
): CheckpointAdoption {
  const cp = input.checkpoint;
  if (!cp || cp.session_id === null || cp.session_status === 'ended') return NO_CHECKPOINT_ADOPTION;
  const rows = db.raw.prepare(
    'SELECT id, workspace_key, status FROM agent_sessions WHERE session_id = ? ORDER BY id',
  ).all(cp.session_id) as unknown as SessionRowView[];
  const own = rows.filter((row) => row.workspace_key === input.conversationKey);
  const resumable = getResumableSessionForChat(db, input.conversationKey, input.provider);

  if (own.length === 0 && rows.length > 0) {
    // Decision 15 part 2: the session belongs to another namespace (for
    // example a scheduled job's row written before #3570). Never adopt it.
    if (resumable) {
      return { kind: 'resume', rowId: resumable.id, sessionId: resumable.session_id, recoveredOwn: true };
    }
    return { kind: 'fresh_with_notice', reason: 'foreign_checkpoint', notice: CHECKPOINT_NOT_RESTORED_NOTICE };
  }
  if (resumable && resumable.session_id === cp.session_id) {
    return { kind: 'resume', rowId: resumable.id, sessionId: resumable.session_id, recoveredOwn: false };
  }
  return NO_CHECKPOINT_ADOPTION;
}

/**
 * Adoption for the first spawn of a per-chat manager. A manager that already
 * started in this process keeps main's fresh-spawn behaviour.
 */
export function lazyCheckpointAdoption(
  db: Database,
  durability: {
    getSessionCheckpoint(conversationKey: string): CheckpointAdoptionCheckpoint | undefined;
    upsertSessionCheckpoint(
      conversationKey: string,
      fields: { sessionId: string; sessionStatus: 'suspended'; transcriptPath?: string },
    ): void;
  },
  session: CheckpointAdoptionManager,
  conversationKey: string,
): CheckpointAdoption {
  const status = session.getStatus();
  if (session.getDbRowId() !== null || status.startedAt !== null || status.sessionId !== null) {
    return NO_CHECKPOINT_ADOPTION;
  }
  // Partial durability ports (test scaffolds) keep main's fresh-spawn path,
  // the same optional-method guard the startup resume uses for quarantine.
  if (typeof durability.getSessionCheckpoint !== 'function') return NO_CHECKPOINT_ADOPTION;
  const adoption = classifyCheckpointAdoption(db, {
    conversationKey,
    provider: session.getProviderId(),
    checkpoint: durability.getSessionCheckpoint(conversationKey),
  });
  if (adoption.kind === 'resume' && adoption.recoveredOwn) {
    // Re-point the checkpoint at the recovered session, which the resume
    // lookup requires. The foreign session's completed identity is reset by
    // the upsert (session id changed); it never described this chat. The
    // next completed turn writes this session's full identity bundle.
    const own = db.raw.prepare('SELECT transcript_path FROM agent_sessions WHERE id = ?')
      .get(adoption.rowId) as { transcript_path: string | null } | undefined;
    durability.upsertSessionCheckpoint(conversationKey, {
      sessionId: adoption.sessionId,
      sessionStatus: 'suspended',
      ...(own?.transcript_path ? { transcriptPath: own.transcript_path } : {}),
    });
  }
  return adoption;
}
