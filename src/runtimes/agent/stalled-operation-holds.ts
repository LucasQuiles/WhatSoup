// src/runtimes/agent/stalled-operation-holds.ts
//
// F7: extracted from AgentRuntime to keep runtime.ts under the per-file
// ceiling (12500 lines). Owns the restart protection after a stalled-operation
// kill: the resume hold on the killed session's checkpoint, the fail-closed
// withdrawal from proactive resume, the withheld respawn and its deferred
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
import { markOrphaned } from './session-db.ts';
import type { SessionManager } from './session.ts';
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

  constructor(private readonly deps: StalledOperationHoldsDeps) {}

  /**
   * Save the stalled-operation kill on the checkpoint of the killed provider
   * session, so a service restart does not continue the work either, and read
   * it back. A chat with no checkpoint has nothing a restart could resume.
   * When the hold cannot be saved or read back, or the checkpoint names
   * another session, the checkpoint is taken out of proactive resume instead,
   * and the chat stays unverified so the respawn and the service shutdown,
   * which both make the checkpoint resumable again, repeat this step.
   *
   * Returns what protects a restart: `held` (the hold was read back, or there
   * is no checkpoint), `withdrawn` (the checkpoint was verified out of
   * proactive resume) or `unprotected` (both protective writes failed). Only
   * `held` survives a resume: reactivation keeps watchdog_state but makes the
   * checkpoint resumable again, so the respawn gate admits `held` alone.
   */
  record(mapKey: string, sessionId: string): StalledOperationRestartProtection {
    const durability = this.deps.durability();
    if (!durability || typeof durability.getSessionCheckpoint !== 'function') return 'held';
    const conversationKey = checkpointConversationKey(mapKey);
    try {
      const checkpoint = durability.getSessionCheckpoint(conversationKey);
      if (!checkpoint) {
        this.unverified.delete(conversationKey);
        return 'held';
      }
      if (checkpoint.session_id === sessionId) {
        if (!stalledOperationResumeHoldApplies(checkpoint.watchdog_state, sessionId)) {
          durability.upsertSessionCheckpoint(conversationKey, {
            watchdogState: withStalledOperationResumeHold(checkpoint.watchdog_state, sessionId),
          });
        }
        if (stalledOperationResumeHoldApplies(durability.getSessionCheckpoint(conversationKey)?.watchdog_state, sessionId)) {
          this.unverified.delete(conversationKey);
          return 'held';
        }
        log.warn({ mapKey, sessionId }, 'stalled-operation resume hold not found after the write');
      } else {
        log.warn({ mapKey, sessionId }, 'stalled-operation resume hold not saved — the checkpoint names another session');
      }
    } catch (err) {
      log.warn({ err, mapKey, sessionId }, 'failed to save the stalled-operation resume hold');
    }
    this.unverified.set(conversationKey, { mapKey, sessionId });
    return this.withdrawFromProactiveResume(conversationKey, mapKey, sessionId) ? 'withdrawn' : 'unprotected';
  }

  /**
   * Fail-closed path: an orphaned checkpoint is not proactively resumed on
   * startup (getResumableCheckpoints reads active and suspended only); the
   * chat's next message rebuilds it. Verified by reading the resumable set.
   */
  private withdrawFromProactiveResume(conversationKey: string, mapKey: string, sessionId: string): boolean {
    const durability = this.deps.durability();
    try {
      if (
        durability
        && typeof durability.markSessionOrphaned === 'function'
        && typeof durability.getResumableCheckpoints === 'function'
      ) {
        durability.markSessionOrphaned(conversationKey);
        if (!durability.getResumableCheckpoints().some((cp) => cp.conversation_key === conversationKey)) {
          log.warn({ mapKey, sessionId }, 'stalled-operation resume hold unavailable — checkpoint withdrawn from proactive resume');
          return true;
        }
      }
    } catch (err) {
      log.error({ err, mapKey, sessionId }, 'failed to withdraw the checkpoint from proactive resume');
    }
    log.error(
      { mapKey, sessionId },
      'stalled-operation kill not saved and the checkpoint is still resumable — a service restart may continue the stopped work',
    );
    return false;
  }

  /**
   * Respawn gate: without a verified hold the automatic respawn is withheld,
   * because its resume makes the checkpoint resumable again and a restart
   * would then continue the stopped work. The chat stays recoverable_dead and
   * keeps its provider session for the next request: in this process the
   * next turn resumes it in place (takeDeferredResume); after a restart the
   * crashed row, marked orphaned here, is what lazy adoption resumes on the
   * chat's next message (never proactive resume, which reads checkpoints).
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
    log[protection === 'unprotected' ? 'error' : 'warn'](
      { mapKey, sessionId, protection, deferredResume: typeof dbRowId === 'number' },
      'auto-respawn withheld after a stalled-operation kill — no verified hold; the next request resumes the session',
    );
  }

  /** The withheld resume for this session, removed; the caller's next turn resumes it in place. */
  takeDeferredResume(session: SessionManager): { sessionId: string; rowId: number } | undefined {
    const deferred = this.deferredResumes.get(session);
    this.deferredResumes.delete(session);
    return deferred;
  }

  /** Any spawn or reset supersedes a withheld resume. */
  forgetDeferredResume(session: SessionManager): void {
    this.deferredResumes.delete(session);
  }

  /** Repeat the hold for chats whose kill is not yet saved, after shutdown suspended their checkpoints. */
  settleUnverified(): void {
    for (const { mapKey, sessionId } of Array.from(this.unverified.values())) {
      this.record(mapKey, sessionId);
    }
  }

  /** The user's next request releases the hold; later restarts resume normally. */
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
