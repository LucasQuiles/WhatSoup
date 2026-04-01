/**
 * Session state classifier — cross-references agent_sessions with
 * session_checkpoints to determine which sessions are authoritative,
 * which are stale (and should be reaped), and which are ambiguous
 * (and should be left alone with a warning).
 *
 * Safety rules (from investigation 2026-04-01):
 * - Never kill based on agent_sessions.status alone
 * - Only reap PIDs that belong to this service, same conversation,
 *   and do NOT match the current checkpoint
 * - If checkpoint is missing or ambiguous, do not auto-kill — log and escalate
 */

import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('session-classifier');

export type SessionClassification =
  | 'authoritative_live'  // matches current checkpoint — the real session
  | 'stale_live'          // PID alive but doesn't match checkpoint — should be killed
  | 'stale_dead'          // PID dead, DB row still 'active' — should be marked orphaned
  | 'ambiguous';          // no checkpoint or multiple conflicts — do not touch

export interface ClassifiedSession {
  id: number;
  sessionId: string | null;
  claudePid: number;
  chatJid: string | null;
  conversationKey: string | null;
  status: string;
  classification: SessionClassification;
  reason: string;
}

interface ActiveSessionRow {
  id: number;
  session_id: string | null;
  claude_pid: number;
  chat_jid: string | null;
  status: string;
}

interface CheckpointInfo {
  claudePid: number | null;
  sessionId: string | null;
  sessionStatus: string;
}

/**
 * Classify all 'active' agent_sessions against the authoritative
 * session_checkpoints. Returns a classification for each active session.
 *
 * @param pidChecker - function to test if a PID is alive (default: process.kill(pid, 0))
 *                     Injected for testability.
 */
export function classifyActiveSessions(
  db: Database,
  durability: DurabilityEngine,
  pidChecker: (pid: number) => boolean = defaultPidChecker,
): ClassifiedSession[] {
  const activeSessions = db.raw
    .prepare(`SELECT id, session_id, claude_pid, chat_jid, status FROM agent_sessions WHERE status = 'active'`)
    .all() as ActiveSessionRow[];

  if (activeSessions.length === 0) return [];

  const results: ClassifiedSession[] = [];

  // Group sessions by conversation key for batch classification
  const byConversation = new Map<string, ActiveSessionRow[]>();
  const sessionConvKeys = new Map<number, string | null>(); // session.id → convKey

  for (const session of activeSessions) {
    let convKey: string | null = null;
    if (session.chat_jid) {
      try {
        convKey = toConversationKey(session.chat_jid);
      } catch {
        convKey = session.chat_jid;
      }
    }
    sessionConvKeys.set(session.id, convKey);

    if (convKey) {
      const existing = byConversation.get(convKey) ?? [];
      existing.push(session);
      byConversation.set(convKey, existing);
    } else {
      // No chat_jid → can't determine conversation → ambiguous
      results.push({
        ...sessionFields(session, null),
        classification: 'ambiguous',
        reason: 'no chat_jid — cannot determine conversation',
      });
    }
  }

  // Classify each conversation group
  for (const [convKey, sessions] of byConversation) {
    const checkpoint = getCheckpointForConversation(durability, convKey);

    if (!checkpoint) {
      // No checkpoint → ambiguous for all sessions in this conversation
      for (const session of sessions) {
        results.push({
          ...sessionFields(session, convKey),
          classification: 'ambiguous',
          reason: 'no session_checkpoint for this conversation',
        });
      }
      continue;
    }

    // Find if any session matches the checkpoint
    const matchingSession = sessions.find(s =>
      checkpoint.claudePid !== null &&
      s.claude_pid === checkpoint.claudePid &&
      checkpoint.sessionId !== null &&
      s.session_id === checkpoint.sessionId,
    );

    for (const session of sessions) {
      if (session === matchingSession) {
        results.push({
          ...sessionFields(session, convKey),
          classification: 'authoritative_live',
          reason: `matches checkpoint (pid=${checkpoint.claudePid}, sessionId=${checkpoint.sessionId})`,
        });
      } else if (matchingSession) {
        // Another session in this conversation matches — this one is stale
        const alive = pidChecker(session.claude_pid);
        results.push({
          ...sessionFields(session, convKey),
          classification: alive ? 'stale_live' : 'stale_dead',
          reason: alive
            ? `PID ${session.claude_pid} alive but checkpoint belongs to PID ${checkpoint.claudePid}`
            : `PID ${session.claude_pid} dead, checkpoint belongs to PID ${checkpoint.claudePid}`,
        });
      } else {
        // No session matches the checkpoint. Could be a race or stale checkpoint.
        // Check if THIS session's PID matches the checkpoint's PID (session_id mismatch)
        if (checkpoint.claudePid !== null && session.claude_pid === checkpoint.claudePid) {
          // PID matches but session_id doesn't — likely a session that was respawned
          // without resume (new session_id). Treat as authoritative if it's the only one.
          if (sessions.length === 1) {
            results.push({
              ...sessionFields(session, convKey),
              classification: 'authoritative_live',
              reason: `PID matches checkpoint, session_id differs (respawned without resume)`,
            });
          } else {
            results.push({
              ...sessionFields(session, convKey),
              classification: 'ambiguous',
              reason: `PID matches checkpoint but multiple sessions exist for this conversation`,
            });
          }
        } else {
          // Neither PID nor session_id matches
          const alive = pidChecker(session.claude_pid);
          if (!alive) {
            results.push({
              ...sessionFields(session, convKey),
              classification: 'stale_dead',
              reason: `PID ${session.claude_pid} dead, doesn't match checkpoint`,
            });
          } else {
            // Live PID but no match — ambiguous
            results.push({
              ...sessionFields(session, convKey),
              classification: 'ambiguous',
              reason: `PID ${session.claude_pid} alive but no session matches checkpoint (pid=${checkpoint.claudePid}, sid=${checkpoint.sessionId})`,
            });
          }
        }
      }
    }
  }

  // Log summary
  const counts = { authoritative_live: 0, stale_live: 0, stale_dead: 0, ambiguous: 0 };
  for (const r of results) counts[r.classification]++;
  if (counts.stale_live > 0 || counts.stale_dead > 0 || counts.ambiguous > 0) {
    log.info(counts, 'session classification complete');
  }

  return results;
}

function sessionFields(session: ActiveSessionRow, convKey: string | null) {
  return {
    id: session.id,
    sessionId: session.session_id,
    claudePid: session.claude_pid,
    chatJid: session.chat_jid,
    conversationKey: convKey,
    status: session.status,
  };
}

function getCheckpointForConversation(
  durability: DurabilityEngine,
  conversationKey: string,
): CheckpointInfo | null {
  const checkpoint = durability.getSessionCheckpoint(conversationKey);
  if (!checkpoint) return null;
  return {
    claudePid: checkpoint.claude_pid,
    sessionId: checkpoint.session_id,
    sessionStatus: checkpoint.session_status,
  };
}

function defaultPidChecker(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
