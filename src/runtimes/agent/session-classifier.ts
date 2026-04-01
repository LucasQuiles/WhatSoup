/**
 * Session state classifier — cross-references agent_sessions with
 * session_checkpoints to determine which sessions are authoritative,
 * which are stale (and should be reaped), and which are ambiguous
 * (and should be left alone with a warning).
 *
 * Safety rules (from investigation 2026-04-01):
 * - Never kill based on agent_sessions.status alone
 * - Only reap PIDs that belong to this service process (verified via PPID)
 * - Only reap PIDs for the same conversation that do NOT match the current checkpoint
 * - If checkpoint is missing or ambiguous, do not auto-kill — log and escalate
 * - If checkpoint status is not 'active', do not label its match as authoritative_live
 */

import { readFileSync } from 'node:fs';
import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('session-classifier');

export type SessionClassification =
  | 'authoritative_live'  // matches current checkpoint AND checkpoint is active — the real session
  | 'stale_live'          // PID alive, owned by this service, doesn't match checkpoint — safe to kill
  | 'stale_dead'          // PID dead, DB row still 'active' — should be marked orphaned
  | 'ambiguous';          // no checkpoint, ownership unverified, or multiple conflicts — do not touch

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
 * Verify a PID belongs to this WhatSoup service by checking:
 * 1. PID is alive (kill -0)
 * 2. Parent PID matches the current process (same service)
 * 3. Command contains 'claude' (not a reused PID)
 *
 * Returns { alive, owned } — alive without owned means the PID exists
 * but might belong to a different process (PID reuse).
 */
export interface PidCheckResult {
  alive: boolean;
  owned: boolean;
}

export type PidOwnershipChecker = (pid: number) => PidCheckResult;

/**
 * Default PID ownership checker using /proc on Linux.
 * Falls back to alive-only on non-Linux or read errors.
 */
export function defaultPidOwnershipChecker(pid: number): PidCheckResult {
  // Step 1: Is the PID alive?
  try {
    process.kill(pid, 0);
  } catch {
    return { alive: false, owned: false };
  }

  // Step 2: Verify ownership via /proc
  const myPid = process.pid;
  try {
    const statusContent = readFileSync(`/proc/${pid}/status`, 'utf8');
    const ppidMatch = statusContent.match(/^PPid:\s+(\d+)/m);
    const ppid = ppidMatch ? parseInt(ppidMatch[1], 10) : null;

    // Must be a direct child of this process
    if (ppid !== myPid) {
      return { alive: true, owned: false };
    }

    // Verify it's actually a claude process (guards against PID reuse)
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!cmdline.includes('claude')) {
      return { alive: true, owned: false };
    }

    return { alive: true, owned: true };
  } catch {
    // /proc not available (non-Linux) or permission denied
    // Conservative: alive but ownership unverified
    return { alive: true, owned: false };
  }
}

/**
 * Classify all 'active' agent_sessions against the authoritative
 * session_checkpoints. Returns a classification for each active session.
 *
 * @param pidChecker - function to verify PID liveness and ownership.
 *                     Injected for testability.
 */
export function classifyActiveSessions(
  db: Database,
  durability: DurabilityEngine,
  pidChecker: PidOwnershipChecker = defaultPidOwnershipChecker,
): ClassifiedSession[] {
  const activeSessions = db.raw
    .prepare(`SELECT id, session_id, claude_pid, chat_jid, status FROM agent_sessions WHERE status = 'active'`)
    .all() as unknown as ActiveSessionRow[];

  if (activeSessions.length === 0) return [];

  const results: ClassifiedSession[] = [];

  // Group sessions by conversation key for batch classification
  const byConversation = new Map<string, ActiveSessionRow[]>();

  for (const session of activeSessions) {
    let convKey: string | null = null;
    if (session.chat_jid) {
      try {
        convKey = toConversationKey(session.chat_jid);
      } catch {
        convKey = session.chat_jid;
      }
    }

    if (convKey) {
      const existing = byConversation.get(convKey) ?? [];
      existing.push(session);
      byConversation.set(convKey, existing);
    } else {
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
      for (const session of sessions) {
        results.push({
          ...sessionFields(session, convKey),
          classification: 'ambiguous',
          reason: 'no session_checkpoint for this conversation',
        });
      }
      continue;
    }

    // If checkpoint status is not 'active', no session should be authoritative_live.
    // The checkpoint was suspended/orphaned — any live sessions are leftovers.
    const checkpointIsActive = checkpoint.sessionStatus === 'active';

    // Find if any session matches the checkpoint (both PID and session_id)
    const matchingSession = checkpointIsActive
      ? sessions.find(s =>
          checkpoint.claudePid !== null &&
          s.claude_pid === checkpoint.claudePid &&
          checkpoint.sessionId !== null &&
          s.session_id === checkpoint.sessionId,
        )
      : null; // non-active checkpoint → no authoritative match

    for (const session of sessions) {
      const pidCheck = pidChecker(session.claude_pid);

      if (session === matchingSession) {
        // Full match AND checkpoint is active
        results.push({
          ...sessionFields(session, convKey),
          classification: 'authoritative_live',
          reason: `matches active checkpoint (pid=${checkpoint.claudePid}, sessionId=${checkpoint.sessionId})`,
        });
      } else if (matchingSession) {
        // Another session in this conversation is authoritative — this one is stale
        classifyNonAuthoritative(results, session, convKey, pidCheck, checkpoint);
      } else if (!checkpointIsActive) {
        // Checkpoint exists but isn't active (suspended/orphaned) — all sessions are stale
        classifyNonAuthoritative(results, session, convKey, pidCheck, checkpoint,
          `checkpoint status is '${checkpoint.sessionStatus}', not active`);
      } else {
        // Checkpoint is active but no session fully matches.
        // Check PID-only match (respawn without resume gives new session_id)
        if (checkpoint.claudePid !== null && session.claude_pid === checkpoint.claudePid) {
          if (sessions.length === 1) {
            results.push({
              ...sessionFields(session, convKey),
              classification: 'authoritative_live',
              reason: 'PID matches active checkpoint, session_id differs (respawned without resume)',
            });
          } else {
            results.push({
              ...sessionFields(session, convKey),
              classification: 'ambiguous',
              reason: 'PID matches checkpoint but multiple sessions exist for this conversation',
            });
          }
        } else {
          // Neither PID nor session_id matches the active checkpoint
          classifyNonAuthoritative(results, session, convKey, pidCheck, checkpoint,
            'no field matches checkpoint');
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

/**
 * Classify a session that is NOT the authoritative match.
 * Uses PID ownership to distinguish stale_live (safe to kill) from ambiguous (unsafe).
 */
function classifyNonAuthoritative(
  results: ClassifiedSession[],
  session: ActiveSessionRow,
  convKey: string,
  pidCheck: PidCheckResult,
  checkpoint: CheckpointInfo,
  extraReason?: string,
): void {
  const base = extraReason
    ? `${extraReason}; `
    : '';

  if (!pidCheck.alive) {
    results.push({
      ...sessionFields(session, convKey),
      classification: 'stale_dead',
      reason: `${base}PID ${session.claude_pid} dead, checkpoint points to PID ${checkpoint.claudePid}`,
    });
  } else if (pidCheck.owned) {
    // PID is alive AND verified as our child claude process → safe to kill
    results.push({
      ...sessionFields(session, convKey),
      classification: 'stale_live',
      reason: `${base}PID ${session.claude_pid} alive+owned, checkpoint points to PID ${checkpoint.claudePid}`,
    });
  } else {
    // PID is alive but ownership unverified (different parent, not claude, or /proc unavailable)
    results.push({
      ...sessionFields(session, convKey),
      classification: 'ambiguous',
      reason: `${base}PID ${session.claude_pid} alive but ownership unverified (PPID/cmdline mismatch or /proc unavailable)`,
    });
  }
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
