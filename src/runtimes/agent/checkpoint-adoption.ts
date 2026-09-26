/**
 * Lazy per-chat checkpoint adoption (#3530 successor).
 *
 * The first turn for a non-sandbox per_chat manager that has never started
 * reads the chat's checkpoint and decides what the new manager may adopt.
 * Owner rulings:
 * - Decision 15 part 2: a checkpoint whose session belongs to another
 *   namespace is never adopted. The chat recovers its own newest resumable
 *   session; otherwise it starts fresh with a notice.
 * - Decision 65 O3: an own-namespace checkpoint with no resumable session row
 *   starts fresh with a notice. The fresh spawn merges recent chat messages
 *   into the turn, which is the context recovery. A resume refused at spawn
 *   takes the same path.
 * - Decision 65 O4: when a live owner of the chat's own session may exist
 *   (its row is active, it has duplicate rows, or the same session is active
 *   in another namespace), the turn fails closed with a notice. No session is
 *   spawned, so the chat never gets a second live session.
 */
import type { Database } from '../../core/database.ts';
import { getResumableSessionForChat } from './session-db.ts';

export const CHECKPOINT_NOT_RESTORED_NOTICE =
  '_Previous session could not be restored_ — continuing from recent messages.';

export const CHECKPOINT_OWNER_MAY_BE_LIVE_NOTICE =
  '_This chat\'s previous session may still be running_ — not starting a second one. Try again in a few minutes.';

export const CHECKPOINT_ADOPTION_REFUSED = 'CHECKPOINT_ADOPTION_REFUSED';

export type CheckpointAdoption =
  | { kind: 'none' }
  | { kind: 'resume'; rowId: number; sessionId: string; recoveredOwn: boolean }
  | {
    kind: 'fresh_with_notice';
    reason: 'foreign_checkpoint' | 'own_row_not_resumable' | 'resume_refused';
    notice: string;
  }
  | {
    kind: 'fail_closed';
    reason: 'active_row' | 'duplicate_row' | 'other_active_namespace';
    notice: string;
  };

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
  // Decision 65 O4. These checks apply only when the chat owns the session;
  // an active row that exists solely in another namespace is the foreign case above.
  const failClosed = (reason: 'active_row' | 'duplicate_row' | 'other_active_namespace'): CheckpointAdoption =>
    ({ kind: 'fail_closed', reason, notice: CHECKPOINT_OWNER_MAY_BE_LIVE_NOTICE });
  if (own.length > 1) return failClosed('duplicate_row');
  if (rows.some((row) => row.workspace_key !== input.conversationKey && row.status === 'active')) {
    return failClosed('other_active_namespace');
  }
  if (own.length === 1 && own[0]!.status === 'active') return failClosed('active_row');
  if (resumable && resumable.session_id === cp.session_id) {
    return { kind: 'resume', rowId: resumable.id, sessionId: resumable.session_id, recoveredOwn: false };
  }
  // Decision 65 O3: this chat's own context is gone; say so, never silently.
  return { kind: 'fresh_with_notice', reason: 'own_row_not_resumable', notice: CHECKPOINT_NOT_RESTORED_NOTICE };
}

/**
 * Tell the chat about a fallback before any spawn. A fail-closed adoption
 * also refuses the turn, so no session is started for it.
 */
export function announceAdoption(adoption: CheckpointAdoption, notify: (notice: string) => void): void {
  if (adoption.kind === 'fresh_with_notice') notify(adoption.notice);
  if (adoption.kind === 'fail_closed') {
    notify(adoption.notice);
    throw new Error(`${CHECKPOINT_ADOPTION_REFUSED}: ${adoption.reason}`);
  }
}

/**
 * Spawn for the adoption. A resume the session layer refuses (row or route
 * checks in spawnSession) falls back to a fresh spawn and reports the notice.
 * Returns the adoption that actually happened.
 */
export async function spawnForAdoption(
  session: { spawnSession(resumeSessionId?: string, existingRowId?: number): Promise<void> },
  adoption: CheckpointAdoption,
  onResumeRefused: (err: unknown, notice: string) => void,
): Promise<CheckpointAdoption> {
  if (adoption.kind !== 'resume') {
    await session.spawnSession();
    return adoption;
  }
  try {
    await session.spawnSession(adoption.sessionId, adoption.rowId);
    return adoption;
  } catch (err) {
    onResumeRefused(err, CHECKPOINT_NOT_RESTORED_NOTICE);
    await session.spawnSession();
    return { kind: 'fresh_with_notice', reason: 'resume_refused', notice: CHECKPOINT_NOT_RESTORED_NOTICE };
  }
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
