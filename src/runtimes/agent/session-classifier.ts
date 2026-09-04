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
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { probeProcessBirthToken } from '../../lib/process-identity.ts';
import { createChildLogger } from '../../logger.ts';
import {
  DEFAULT_PROVIDER_ID,
  executionModeForProvider,
  isProviderId,
} from './providers/index.ts';
import { getProviderBinary } from './providers/provider-binary.ts';

const log = createChildLogger('session-classifier');

export type SessionClassification =
  | 'authoritative_live'  // matches current checkpoint AND checkpoint is active — the real session
  | 'stale_live'          // PID looks like an owned stale child; signaling still requires spawn capability
  | 'stale_dead'          // PID dead, DB row still 'active' — should be marked orphaned
  | 'ambiguous';          // no checkpoint, ownership unverified, or multiple conflicts — do not touch

export interface ClassifiedSession {
  id: number;
  sessionId: string | null;
  claudePid: number;
  chatJid: string | null;
  conversationKey: string | null;
  status: string;
  provider: string | null;
  classification: SessionClassification;
  reason: string;
  /** ISO timestamp the row was created, or null if unavailable (e.g. mocked callers). */
  startedAt: string | null;
  /** Turns processed by this session, or null if unavailable (e.g. mocked callers). */
  messageCount: number | null;
}

interface ActiveSessionRow {
  id: number;
  session_id: string | null;
  claude_pid: number;
  chat_jid: string | null;
  status: string;
  started_at: string | null;
  message_count: number | null;
  provider: string | null;
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
 * 3. Command contains the durable row's canonical provider binary (not a reused PID)
 *
 * Returns { alive, owned } — alive without owned means the PID exists
 * but might belong to a different process (PID reuse).
 */
export interface PidCheckResult {
  alive: boolean;
  owned: boolean;
}

export type PidOwnershipChecker = (pid: number, provider: string | null) => PidCheckResult;

function expectedProviderBinary(provider: string | null): string | null {
  const providerId = provider ?? DEFAULT_PROVIDER_ID;
  return isProviderId(providerId) ? getProviderBinary(providerId) : null;
}

function commandContainsBinary(command: string, binary: string): boolean {
  const parts = command
    .split(/[\0\s]+/u)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  if (basename(parts[0]!) === binary) return true;
  const executable = basename(parts[0]!);
  return ['node', 'nodejs', 'bun', 'deno'].includes(executable)
    && parts.length > 1
    && basename(parts[1]!) === binary;
}

/**
 * Default PID ownership checker using /proc on Linux.
 * Falls back to alive-only on non-Linux or read errors.
 */
export function defaultPidOwnershipChecker(
  pid: number,
  provider: string | null = DEFAULT_PROVIDER_ID,
): PidCheckResult {
  // Step 0: Reject invalid PIDs before ANY probe. agent_sessions.claude_pid can
  // be null/0 for a row whose subprocess was already torn down; pid<=0 is not a
  // single process to kill(2) (0 = own process group, negative = process group),
  // so kill(pid, 0) "succeeds" and the probe falls through to ps, where procps
  // rejects the argument with "error: process ID out of range" + usage text on
  // the service's stderr (production 2026-07-17). An invalid pid cannot name a
  // live session — treat it as dead.
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    log.debug({ pid }, 'pid probe skipped: invalid pid, treating as dead');
    return { alive: false, owned: false };
  }

  // Step 1: Is the PID alive?
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH'
      ? { alive: false, owned: false }
      : { alive: true, owned: false };
  }

  // Step 2: Verify ownership via /proc (Linux) or ps fallback (macOS/other)
  const myPid = process.pid;
  const providerBinary = expectedProviderBinary(provider);
  if (providerBinary === null) return { alive: true, owned: false };
  const birthTokenBefore = probeProcessBirthToken(pid);
  if (birthTokenBefore === null) return { alive: true, owned: false };
  try {
    const statusContent = readFileSync(`/proc/${pid}/status`, 'utf8');
    const ppidMatch = statusContent.match(/^PPid:\s+(\d+)/m);
    const ppid = ppidMatch ? parseInt(ppidMatch[1], 10) : null;

    // Must be a direct child of this process
    if (ppid !== myPid) {
      return { alive: true, owned: false };
    }

    // Verify the command belongs to the row's canonical CLI provider.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!commandContainsBinary(cmdline, providerBinary)) {
      return { alive: true, owned: false };
    }

    const birthTokenAfter = probeProcessBirthToken(pid);
    return birthTokenAfter === birthTokenBefore
      ? { alive: true, owned: true }
      : { alive: true, owned: false };
  } catch {
    // Intentional: procfs is absent on supported non-Linux hosts, so ps performs the conservative ownership fallback.
  }

  // Fallback: use ps for platforms without /proc (macOS, FreeBSD)
  try {
    // stderr 'pipe' (not the execFileSync default of inheriting the service's
    // stderr): any ps complaint must land on the thrown error, never as raw
    // non-JSON lines in the service log stream.
    const psOut = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
      maxBuffer: 64 * 1024,
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = (typeof psOut === 'string' ? psOut : psOut.toString('utf-8')).trim();
    const [ppidStr, ...commandParts] = line.split(/\s+/);
    const ppid = parseInt(ppidStr, 10);
    const command = commandParts.join(' ');
    if (ppid === myPid && commandContainsBinary(command, providerBinary)) {
      const birthTokenAfter = probeProcessBirthToken(pid);
      return birthTokenAfter === birthTokenBefore
        ? { alive: true, owned: true }
        : { alive: true, owned: false };
    }
    return { alive: true, owned: false };
  } catch {
    // ps unavailable or failed — conservative: alive but ownership unverified
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
    .prepare(
      `SELECT id, session_id, claude_pid, chat_jid, status, started_at, message_count, provider FROM agent_sessions WHERE status = 'active'`,
    )
    .all() as unknown as ActiveSessionRow[];

  if (activeSessions.length === 0) return [];

  const results: ClassifiedSession[] = [];
  const pidCounts = new Map<number, number>();
  for (const session of activeSessions) {
    if (!Number.isSafeInteger(session.claude_pid) || session.claude_pid <= 1) continue;
    pidCounts.set(session.claude_pid, (pidCounts.get(session.claude_pid) ?? 0) + 1);
  }
  const duplicatePids = new Set(
    [...pidCounts].filter(([, count]) => count > 1).map(([pid]) => pid),
  );

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

    if (duplicatePids.has(session.claude_pid)) {
      results.push({
        ...sessionFields(session, convKey),
        classification: 'ambiguous',
        reason: `duplicate live PID ${session.claude_pid} appears in multiple active rows`,
      });
    } else if (convKey) {
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

    // Resident providers are identified by both durable session ID and live PID.
    // Spawn-per-turn and managed-loop providers have no durable child process, so
    // the provider session ID is their authoritative runtime identity.
    const matchingSession = checkpointIsActive
      ? sessions.find((s) => {
          const mode = executionMode(s.provider);
          if (mode === null || checkpoint.sessionId === null || s.session_id !== checkpoint.sessionId) {
            return false;
          }
          return mode !== 'persistent_session' || (
            checkpoint.claudePid !== null &&
            s.claude_pid === checkpoint.claudePid
          );
        })
      : null; // non-active checkpoint → no authoritative match

    for (const session of sessions) {
      const pidCheck = pidChecker(session.claude_pid, session.provider);

      if (session === matchingSession) {
        const mode = executionMode(session.provider);
        if (mode !== null && mode !== 'persistent_session') {
          results.push({
            ...sessionFields(session, convKey),
            classification: 'authoritative_live',
            reason: `logical session matches active checkpoint (executionMode=${mode}, sessionId=${checkpoint.sessionId})`,
          });
          continue;
        }
        // Full match AND checkpoint is active — but only 'authoritative_live' if the
        // PID is actually ALIVE. QR-101: a checkpoint match with a DEAD pid (the
        // process crashed and the checkpoint row was never reconciled) was wrongly
        // classified live, so the runtime "leaves it alone" and the chat is silently
        // dead. Gate on LIVENESS ONLY (not ownership): pidChecker returns alive:false
        // ONLY for a genuinely-gone PID (process.kill(pid,0) → ESRCH); every transient
        // ps/proc failure returns alive:true, so this never demotes a live session on a
        // flaky check, and it stays provider-agnostic.
        if (!pidCheck.alive) {
          classifyNonAuthoritative(results, session, convKey, pidCheck, checkpoint);
        } else {
          results.push({
            ...sessionFields(session, convKey),
            classification: 'authoritative_live',
            reason: `matches active checkpoint (pid=${checkpoint.claudePid}, sessionId=${checkpoint.sessionId})`,
          });
        }
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
            // QR-101: same liveness gate as the full-match branch — a dead PID that
            // happens to equal the checkpoint pid is a stale row, not a live respawn.
            if (!pidCheck.alive) {
              classifyNonAuthoritative(results, session, convKey, pidCheck, checkpoint);
            } else {
              results.push({
                ...sessionFields(session, convKey),
                classification: 'authoritative_live',
                reason: 'PID matches active checkpoint, session_id differs (respawned without resume)',
              });
            }
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

function executionMode(provider: string | null) {
  return isProviderId(provider)
    ? executionModeForProvider(provider)
    : null;
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
    // PID is alive AND verified as our child for the durable provider → safe to kill
    results.push({
      ...sessionFields(session, convKey),
      classification: 'stale_live',
      reason: `${base}PID ${session.claude_pid} alive+owned, checkpoint points to PID ${checkpoint.claudePid}`,
    });
  } else {
    // PID is alive but ownership unverified (parent/provider mismatch or probe unavailable)
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
    provider: session.provider,
    startedAt: session.started_at ?? null,
    messageCount: session.message_count ?? null,
  };
}

export type AmbiguousAgeFallbackVerdict = 'orphan' | 'leave';

export interface AmbiguousAgeFallbackInput {
  id: number;
  claudePid: number;
  provider?: string | null;
  startedAt: string | null;
  messageCount: number | null;
}

/**
 * Age-based fallback disposition for the 'ambiguous' classification bucket
 * (#1756). classifyActiveSessions runs at startup only; an init-failure
 * session that never checkpointed lands in 'ambiguous' and — before this —
 * was permanently skipped, so its agent_sessions row never reached a
 * terminal state (10 opencode-cli zombies observed stuck 'active' up to 31
 * days). The interval sweep now re-classifies every pass, and for rows still
 * 'ambiguous' consults this function to decide whether enough time has
 * passed with zero activity to call it terminal.
 *
 * Deliberately conservative — every check fails CLOSED (returns 'leave') on
 * missing or unparseable evidence, and this independently re-verifies PID
 * liveness/ownership rather than trusting the classifier's verdict alone:
 * two of the 'ambiguous' sub-cases (no chat_jid, no checkpoint) never ran a
 * pidChecker at all, so this is the only liveness check some rows ever get.
 * A session with ANY processed messages, or a PID that is alive AND owned by
 * this service, is left alone regardless of age — orphaning here only
 * updates the DB row status, it never sends a signal, so a false 'orphan'
 * verdict cannot kill a running process, but it can wrongly let a resumed
 * conversation spawn a duplicate session, hence the caution.
 */
export function resolveAmbiguousAgeFallback(
  session: AmbiguousAgeFallbackInput,
  now: number,
  maxAgeMs: number,
  pidChecker: PidOwnershipChecker = defaultPidOwnershipChecker,
): AmbiguousAgeFallbackVerdict {
  if (session.messageCount !== 0) return 'leave';
  if (!session.startedAt) return 'leave';
  const startedAtMs = Date.parse(session.startedAt);
  if (!Number.isFinite(startedAtMs)) return 'leave';
  if (now - startedAtMs < maxAgeMs) return 'leave';
  const pidCheck = pidChecker(session.claudePid, session.provider ?? null);
  return pidCheck.alive ? 'leave' : 'orphan';
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
