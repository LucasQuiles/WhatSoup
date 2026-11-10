// src/runtimes/agent/stalled-operation-holds.ts
//
// F7: extracted from AgentRuntime to keep runtime.ts under the per-file
// ceiling (12500 lines). Owns the restart protection after a stalled-operation
// kill: the park of the killed session's checkpoint (the resume hold plus the
// withdrawal from proactive resume), the withheld respawn and its deferred
// in-place resume. The hold's JSON encoding is in
// stalled-operation-resume-hold.ts.
//
// A stalled-operation kill tells the user to send the message again and
// finalizes the killed request as failed, so neither the automatic respawn nor
// a service restart may continue that work on the agent's own initiative.

import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';
import type { CheckpointAdoption } from './checkpoint-adoption.ts';
import { markOrphaned } from './session-db.ts';
import type { SessionCrashInfo, SessionManager } from './session.ts';
import {
  stalledOperationResumeHoldApplies,
  withStalledOperationResumeHold,
  withoutStalledOperationResumeHold,
  type StalledOperationRestartProtection,
} from './stalled-operation-resume-hold.ts';

const log = createChildLogger('agent-runtime');

/** The session_checkpoints key for a per-chat map key (sandbox map keys already are one). */
export function checkpointConversationKey(mapKey: string): string {
  return mapKey.includes('@') ? toConversationKey(mapKey) : mapKey;
}

export interface StalledOperationHoldsDeps {
  /** Read at each call: the runtime sets both after field initialisation. */
  readonly durability: () => DurabilityEngine | null;
  readonly db: () => Database;
}

export class StalledOperationHolds {
  /** Chats whose stalled-operation kill is not yet saved on their checkpoint, by conversation key. */
  private readonly unverified = new Map<string, { mapKey: string; sessionId: string }>();
  /** Sessions whose respawn was withheld; the next turn resumes this provider session in place. */
  private readonly deferredResumes = new WeakMap<SessionManager, { sessionId: string; rowId: number }>();

  private readonly deps: StalledOperationHoldsDeps;

  constructor(deps: StalledOperationHoldsDeps) {
    this.deps = deps;
  }

  /**
   * Park the killed provider session durably: save the stalled-operation kill
   * on its checkpoint (the hold, read back) and keep that checkpoint out of
   * proactive resume (orphaned, read back from the resumable set). The
   * orphaned state is what protects a restart into a build that ignores the
   * hold: every build excludes orphaned checkpoints from proactive resume
   * (getResumableCheckpoints reads active and suspended only), and lazy
   * adoption still resumes the session on the chat's next message. The hold
   * covers the next resume in place, which reactivates the checkpoint before
   * the user's turn is accepted. A chat with no checkpoint has nothing a
   * restart could resume. Unless both writes are verified the chat stays
   * unverified, so the service shutdown repeats this step.
   *
   * Returns what protects a restart: `parked` (no resumable checkpoint names
   * the held session), `held` (only the hold, which this build reads),
   * `unprotected` (neither) or `not_needed` (no checkpoint). Only
   * `not_needed` admits the automatic respawn: its resume would reactivate a
   * parked checkpoint.
   */
  record(mapKey: string, sessionId: string): StalledOperationRestartProtection {
    const durability = this.deps.durability();
    if (!durability || typeof durability.getSessionCheckpoint !== 'function') return 'not_needed';
    const conversationKey = checkpointConversationKey(mapKey);
    let held = false;
    try {
      const checkpoint = durability.getSessionCheckpoint(conversationKey);
      if (!checkpoint) {
        this.unverified.delete(conversationKey);
        return 'not_needed';
      }
      held = this.saveHold(conversationKey, mapKey, sessionId);
    } catch (err) {
      log.warn({ err, mapKey, sessionId }, 'failed to save the stalled-operation resume hold');
    }
    const parked = this.withdrawFromProactiveResume(conversationKey, mapKey, sessionId);
    if (held && parked) this.unverified.delete(conversationKey);
    else this.unverified.set(conversationKey, { mapKey, sessionId });
    if (parked) return 'parked';
    if (held) {
      log.warn(
        { mapKey, sessionId },
        'stalled-operation session not parked — only the resume hold keeps a restart from continuing the stopped work',
      );
      return 'held';
    }
    log.error(
      { mapKey, sessionId },
      'stalled-operation kill not saved and the checkpoint is still resumable — a service restart may continue the stopped work',
    );
    return 'unprotected';
  }

  /** Write the hold when it is missing and read it back. A checkpoint that names another session gets none. */
  private saveHold(conversationKey: string, mapKey: string, sessionId: string): boolean {
    const durability = this.deps.durability()!;
    const checkpoint = durability.getSessionCheckpoint(conversationKey);
    if (checkpoint?.session_id !== sessionId) {
      log.warn({ mapKey, sessionId }, 'stalled-operation resume hold not saved — the checkpoint names another session');
      return false;
    }
    if (!stalledOperationResumeHoldApplies(checkpoint.watchdog_state, sessionId)) {
      durability.upsertSessionCheckpoint(conversationKey, {
        watchdogState: withStalledOperationResumeHold(checkpoint.watchdog_state, sessionId),
      });
    }
    if (stalledOperationResumeHoldApplies(durability.getSessionCheckpoint(conversationKey)?.watchdog_state, sessionId)) {
      return true;
    }
    log.warn({ mapKey, sessionId }, 'stalled-operation resume hold not found after the write');
    return false;
  }

  /**
   * At the provider exit, before any respawn is scheduled: park the session
   * when the exit was a stalled-operation kill. Any other exit needs no
   * protection.
   */
  recordExit(mapKey: string, info: SessionCrashInfo | undefined): StalledOperationRestartProtection {
    const stalledSessionId = info?.terminationReason === 'stalled_operation' ? info.sessionId : undefined;
    return typeof stalledSessionId === 'string'
      ? this.record(mapKey, stalledSessionId)
      : 'not_needed';
  }

  /**
   * The park: only the held session's checkpoint is orphaned. A checkpoint
   * that names another session, such as the fresh session a /new reset
   * started, cannot resume the stopped work and keeps its own resume; the
   * unverified chat repeats this step at shutdown, so a conversation-wide
   * write would orphan that session. Verified by reading the resumable set
   * for the held session.
   */
  private withdrawFromProactiveResume(conversationKey: string, mapKey: string, sessionId: string): boolean {
    const durability = this.deps.durability();
    try {
      if (
        durability
        && typeof durability.updateExactSessionCheckpointStatus === 'function'
        && typeof durability.getResumableCheckpoints === 'function'
      ) {
        if (durability.getSessionCheckpoint(conversationKey)?.session_id === sessionId) {
          durability.updateExactSessionCheckpointStatus({
            providerSessionId: sessionId,
            conversationKey,
            sessionStatus: 'orphaned',
          });
        }
        return !durability.getResumableCheckpoints().some(
          (cp) => cp.conversation_key === conversationKey && cp.session_id === sessionId,
        );
      }
    } catch (err) {
      log.error({ err, mapKey, sessionId }, 'failed to park the stalled-operation session out of proactive resume');
    }
    return false;
  }

  /**
   * Respawn gate: after a stalled-operation kill with a checkpoint the
   * automatic respawn is withheld, because its resume reactivates the parked
   * checkpoint and a restart into a build that ignores the hold would then
   * continue the stopped work. The chat stays recoverable_dead and keeps its
   * provider session for the next request: in this process the next turn
   * resumes it in place (adoptDeferredResume); after a restart the crashed
   * row, marked orphaned here, is what lazy adoption resumes on the chat's
   * next message (never proactive resume, which skips orphaned checkpoints).
   */
  withholdRespawn(
    mapKey: string,
    session: SessionManager,
    sessionId: string,
    dbRowId: number | null | undefined,
    protection: StalledOperationRestartProtection,
  ): void {
    if (typeof dbRowId === 'number') {
      this.deferredResumes.set(session, { sessionId, rowId: dbRowId });
      try {
        markOrphaned(this.deps.db(), dbRowId);
      } catch (err) {
        log.warn({ err, mapKey, sessionId }, 'stalled-operation session row not kept for lazy resume — a restart starts fresh with a notice');
      }
    }
    log[protection === 'parked' ? 'info' : protection === 'unprotected' ? 'error' : 'warn'](
      { mapKey, sessionId, protection, deferredResume: typeof dbRowId === 'number' },
      'stalled-operation kill parked — no automatic respawn; the next request resumes the session',
    );
  }

  /**
   * Re-verify restart protection at the automatic resume itself: time has
   * passed since the kill, and the resume reactivates the checkpoint. Returns
   * false when the respawn was withheld instead.
   */
  admitRespawn(mapKey: string, session: SessionManager, sessionId: string, dbRowId: number | null): boolean {
    const protection = this.record(mapKey, sessionId);
    if (protection === 'not_needed') return true;
    this.withholdRespawn(mapKey, session, sessionId, dbRowId, protection);
    return false;
  }

  /**
   * The automatic respawn resumed the killed session, which had no checkpoint
   * when it was admitted. The caller sends no context or continuation turn:
   * either would re-run the stopped work unbidden. The session is live, so a
   * checkpoint written by its resume gets the hold, never the park.
   */
  recordAfterRespawnResume(mapKey: string, session: SessionManager, sessionId: string): void {
    log.info(
      { mapKey, sessionId },
      'auto-respawn resumed after a stalled-operation kill — no context or continuation turn sent',
    );
    const resumedSessionId = session.getStatus().sessionId ?? sessionId;
    const durability = this.deps.durability();
    if (!resumedSessionId || !durability || typeof durability.getSessionCheckpoint !== 'function') return;
    const conversationKey = checkpointConversationKey(mapKey);
    try {
      if (durability.getSessionCheckpoint(conversationKey)) this.saveHold(conversationKey, mapKey, resumedSessionId);
    } catch (err) {
      log.warn({ err, mapKey, sessionId: resumedSessionId }, 'failed to save the stalled-operation resume hold');
    }
  }

  /**
   * Proactive resume after a service restart: true when the checkpoint holds
   * this provider session after a stalled-operation kill. The caller then
   * sends no context or continuation turn; the session waits for the user's
   * resend.
   */
  holdsProactiveResume(
    chatJid: string,
    watchdogState: string | null | undefined,
    sessionId: string | null | undefined,
  ): boolean {
    if (!stalledOperationResumeHoldApplies(watchdogState, sessionId)) return false;
    log.info(
      { chatJid, sessionId },
      'proactive resume after a stalled-operation kill — no context or continuation turn sent',
    );
    return true;
  }

  /**
   * The checkpoint adoption for this session's next turn. A withheld resume
   * (withholdRespawn) is removed in every case and resumes the provider
   * session in place when nothing else was adopted.
   */
  adoptDeferredResume(session: SessionManager, adoption: CheckpointAdoption): CheckpointAdoption {
    const deferred = this.deferredResumes.get(session);
    this.deferredResumes.delete(session);
    if (deferred === undefined || adoption.kind !== 'none') return adoption;
    return { kind: 'resume', rowId: deferred.rowId, sessionId: deferred.sessionId, recoveredOwn: false };
  }

  /** Any spawn or reset supersedes a withheld resume. */
  forgetDeferredResume(session: SessionManager): void {
    this.deferredResumes.delete(session);
  }

  /** Repeat the park for chats whose kill is not yet saved, after shutdown suspended their checkpoints. */
  settleUnverified(): void {
    for (const { mapKey, sessionId } of Array.from(this.unverified.values())) {
      this.record(mapKey, sessionId);
    }
  }

  /**
   * Release the hold; later restarts resume normally. The runtime calls this
   * only after the provider accepted a live user turn: a refused, cancelled or
   * failed dispatch, a recovery or fallback replay and a scheduled turn keep it.
   */
  clear(mapKey: string): void {
    const conversationKey = checkpointConversationKey(mapKey);
    this.unverified.delete(conversationKey);
    const durability = this.deps.durability();
    if (!durability || typeof durability.getSessionCheckpoint !== 'function') return;
    try {
      const watchdogState = withoutStalledOperationResumeHold(
        durability.getSessionCheckpoint(conversationKey)?.watchdog_state,
      );
      if (watchdogState === null) return;
      durability.upsertSessionCheckpoint(conversationKey, { watchdogState });
      log.info({ mapKey }, 'stalled-operation resume hold cleared by the next request');
    } catch (err) {
      log.warn({ err, mapKey }, 'failed to clear the stalled-operation resume hold');
    }
  }
}
