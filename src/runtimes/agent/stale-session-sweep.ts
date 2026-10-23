import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import { systemClock } from '../../lib/clock.ts';
import { createChildLogger } from '../../logger.ts';
import { markOrphaned } from './session-db.ts';
import { reconcileResidentSessionStatuses } from './resident-session-reconciler.ts';
import { classifyActiveSessions, resolveAmbiguousAgeFallback } from './session-classifier.ts';
import type { SessionManager } from './session.ts';
import {
  getRegisteredProcessTreeTerminationLease,
  killSessionTree,
  ProcessTreeTerminationError,
  processTreeFailureDiagnostic,
  retryKillSessionTree,
  type KillSessionOutcome,
} from './process-tree.ts';
import { isScheduledAgentJobMapKey } from './scheduled-agent-job-isolation.ts';
import { AMBIGUOUS_SESSION_MAX_AGE_MS } from './runtime-tunables.ts';
import type { SessionScope } from './runtime-options.ts';

const log = createChildLogger('agent-runtime');

interface StaleProcessTreeRetry {
  readonly pid: number;
  readonly generationMarker: string;
  readonly birthToken: string;
  readonly provider: string | null;
}

interface StaleSessionSweepResident {
  readonly mapKey: string;
  readonly session: SessionManager;
}

interface StaleSessionSweepHost {
  readonly db: Database;
  readonly sessionScope: SessionScope;
  readonly sandboxPerChat: boolean;
  getDurability(): DurabilityEngine | null;
  getResidentSessions(): Iterable<SessionManager>;
  readonly staleProcessTreeRetries: Map<number, StaleProcessTreeRetry>;
  readonly staleProcessTreePermissionBlocks: Map<number, StaleProcessTreeRetry>;
  staleProcessTreeRetryTimerRowIds(): Iterable<number>;
  clearStaleProcessTreeRetryTimer(rowId: number): void;
  scheduleStaleProcessTreeRetry(rowId: number): void;
  isResidentManagerMakingProgress(rowId: number, now: number): boolean;
  findResidentManagerForRow(rowId: number): StaleSessionSweepResident | undefined;
  resetWedgedResidentSession(
    mapKey: string,
    session: SessionManager,
    trigger: 'compaction-livelock' | 'no-turn-progress',
    logFields: Record<string, unknown>,
  ): Promise<'reset' | 'failed' | 'in_progress'>;
}

function staleProcessTreeErrorAllowsAutomaticRetry(error: unknown): boolean {
  if (!(error instanceof ProcessTreeTerminationError)) return true;
  if (error.retryClass === 'permission_denied' || error.retryClass === 'invalid_request') {
    return false;
  }
  return error.code !== 'PROCESS_TREE_RETRY_LEASE_EXPIRED'
    && error.code !== 'PROCESS_TREE_RETRY_ATTEMPTS_EXHAUSTED'
    && error.code !== 'PROCESS_TREE_RETRY_NOT_ALLOWED';
}

export async function sweepStaleAgentSessions(
  host: StaleSessionSweepHost,
): Promise<Set<string>> {
  const proactiveResumeBlockedConversationKeys = new Set<string>();
  if (!(host.sessionScope === 'per_chat' || host.sandboxPerChat)) {
    return proactiveResumeBlockedConversationKeys;
  }
  const durability = host.getDurability();
  if (!durability) {
    log.warn('durability engine not set — skipping active session classification');
    return proactiveResumeBlockedConversationKeys;
  }

  const residentRowIds = reconcileResidentSessionStatuses(host.db, host.getResidentSessions());
  const classified = classifyActiveSessions(host.db, durability);
  const classifiedRowIds = new Set(classified.map((session) => session.id));
  for (const rowId of host.staleProcessTreeRetries.keys()) {
    if (!classifiedRowIds.has(rowId)) host.staleProcessTreeRetries.delete(rowId);
  }
  for (const rowId of host.staleProcessTreePermissionBlocks.keys()) {
    if (!classifiedRowIds.has(rowId)) host.staleProcessTreePermissionBlocks.delete(rowId);
  }
  for (const rowId of host.staleProcessTreeRetryTimerRowIds()) {
    if (!classifiedRowIds.has(rowId)) host.clearStaleProcessTreeRetryTimer(rowId);
  }
  const now = systemClock.now();
  for (const session of classified) {
    if (residentRowIds.has(session.id)) {
      host.clearStaleProcessTreeRetryTimer(session.id);
      // #3523 layer 2: the resident exemption is liveness-gated. A current-process
      // resident manager is only spared zombie disposition while it is making turn
      // progress. A resident wedged between turns (e.g. a compaction livelock, or a
      // manager whose child crashed but whose row is still mapped) would otherwise
      // be protected forever and never self-clear. When it is NOT progressing, fall
      // through to the classification's normal stale_live/stale_dead disposition
      // instead of skipping.
      if (host.isResidentManagerMakingProgress(session.id, now)) {
        log.warn(
          { id: session.id, conversationKey: session.conversationKey, classification: session.classification,
            reason: session.reason, providerSessionId: session.sessionId },
          'skipping zombie-session disposition for current-process resident manager');
        if (session.conversationKey) proactiveResumeBlockedConversationKeys.add(session.conversationKey);
        continue;
      }
      log.warn(
        { id: session.id, conversationKey: session.conversationKey, classification: session.classification,
          reason: session.reason, providerSessionId: session.sessionId },
        'resident manager making no turn progress — allowing zombie-session disposition');
      // #3523 layer 2 (iteration 1, review H1/S2): 'authoritative_live' is the
      // classification the incident's own journal records for the livelocked
      // row — its child process IS alive and DOES match the active checkpoint,
      // so every disposition arm below is a no-op for it (the switch only
      // re-adds the conversation key to the proactive-resume block set, exactly
      // what the old unconditional exemption did). A non-progressing
      // authoritative resident must therefore be dispositioned HERE, by the
      // same serialized owned reset the compaction-livelock escalation uses, so
      // the incident's state (authoritative_live + no turn progress past the
      // deadline) ends in a fresh, usable session instead of a log line.
      // Every other classification keeps its existing disposition below.
      //
      // Iteration 2 (the adversarial lens A0/A1 = the spec lens N1): the hard
      // reset is gated on the SCHEDULED scope, the same predicate layer 1's
      // escalation already carries, because #3523 AC1 restricts it to
      // '::scheduled-agent-job' scopes. Ungated, this arm aborted the in-flight
      // turn and dropped the resumable checkpoint of ANY per-chat scope whose
      // convergence streak had latched — the convergence gates in
      // isResidentManagerMakingProgress deliberately outrank turnInFlight (the
      // incident's compact turn is perpetually in flight), so an ordinary
      // interactive chat could be reset mid-turn. A non-scheduled resident that
      // stops progressing loses its exemption and keeps the pre-existing
      // disposition for this classification: proactive resume stays blocked for
      // the key, and the lapse is logged rather than acted on.
      if (session.classification === 'authoritative_live') {
        const entry = host.findResidentManagerForRow(session.id);
        if (entry === undefined || !isScheduledAgentJobMapKey(entry.mapKey)) {
          log.warn(
            {
              id: session.id, conversationKey: session.conversationKey,
              mapKey: entry?.mapKey ?? null, trigger: 'no-turn-progress',
            },
            'non-progressing resident is not a scheduled-agent-job scope — exemption lapsed without a hard reset',
          );
          if (session.conversationKey) proactiveResumeBlockedConversationKeys.add(session.conversationKey);
          continue;
        }
        const outcome = await host.resetWedgedResidentSession(
          entry.mapKey, entry.session, 'no-turn-progress',
          { id: session.id, conversationKey: session.conversationKey, providerSessionId: session.sessionId },
        );
        if (outcome !== 'reset' && session.conversationKey) {
          // The reset did not settle cleanly — the old session may still hold
          // the conversation, so keep proactive resume blocked for this key.
          proactiveResumeBlockedConversationKeys.add(session.conversationKey);
        }
        continue;
      }
    }
    const generationMarker =
      `stale:${session.id}:${session.sessionId ?? 'unknown'}:${session.claudePid}`;
    const retained = host.staleProcessTreeRetries.get(session.id);
    const permissionBlock = host.staleProcessTreePermissionBlocks.get(session.id);
    const retainedMatches = retained?.pid === session.claudePid
      && retained.generationMarker === generationMarker
      && retained.provider === session.provider;
    const permissionMatches = permissionBlock?.pid === session.claudePid
      && permissionBlock.generationMarker === generationMarker
      && permissionBlock.provider === session.provider;
    const registeredLease = session.classification === 'stale_live' || retainedMatches || permissionMatches
      ? getRegisteredProcessTreeTerminationLease(session.id, session.claudePid, session.provider)
      : null;
    const retryRetainedLease = retainedMatches
      && (registeredLease === null || retained.birthToken === registeredLease.rootAuthority.birthToken);
    const permissionBlocked = permissionMatches
      && (registeredLease === null || permissionBlock.birthToken === registeredLease.rootAuthority.birthToken);
    // Root exit is not completion of a previously admitted tree cleanup.
    const classification = retryRetainedLease || permissionBlocked ? 'stale_live' : session.classification;
    if (classification !== 'stale_live') {
      host.clearStaleProcessTreeRetryTimer(session.id);
      host.staleProcessTreeRetries.delete(session.id);
      host.staleProcessTreePermissionBlocks.delete(session.id);
    }
    switch (classification) {
      case 'stale_dead':
        markOrphaned(host.db, session.id);
        break;
      case 'stale_live':
        log.warn({
          id: session.id,
          pid: session.claudePid,
          conversationKey: session.conversationKey,
          reason: session.reason,
        }, 'reaping stale session');
        if (permissionBlocked) {
          if (session.conversationKey) {
            proactiveResumeBlockedConversationKeys.add(session.conversationKey);
          }
          break;
        }
        if (registeredLease === null && !retryRetainedLease) {
          host.clearStaleProcessTreeRetryTimer(session.id);
          log.error({
            id: session.id,
            pid: session.claudePid,
            conversationKey: session.conversationKey,
          }, 'stale session spawn authority unavailable — blocking proactive resume');
          if (session.conversationKey) {
            proactiveResumeBlockedConversationKeys.add(session.conversationKey);
          }
          break;
        }
        if (permissionBlock !== undefined) {
          host.staleProcessTreePermissionBlocks.delete(session.id);
        }
        if (retained !== undefined && !retryRetainedLease) {
          host.staleProcessTreeRetries.delete(session.id);
        }
        const birthToken = retryRetainedLease
          ? retained.birthToken
          : registeredLease!.rootAuthority.birthToken;
        if (!retryRetainedLease && host.staleProcessTreeRetries.size >= 64) {
          log.warn({ id: session.id, conversationKey: session.conversationKey },
            'stale session cleanup capacity exhausted — blocking proactive resume');
          if (session.conversationKey) {
            proactiveResumeBlockedConversationKeys.add(session.conversationKey);
          }
          break;
        }
        // Reserve retention before a signal can outlive the root process.
        host.staleProcessTreeRetries.set(session.id, {
          pid: session.claudePid,
          generationMarker,
          birthToken,
          provider: session.provider,
        });
        let cleanupOutcome: KillSessionOutcome;
        try {
          cleanupOutcome = retryRetainedLease
            ? await retryKillSessionTree(session.claudePid, generationMarker)
            : await killSessionTree(registeredLease!.target, 'SIGTERM', {
                generationMarker,
                rootAuthority: registeredLease!.rootAuthority,
                diagnosticSource: 'stale_session_sweep',
                diagnosticSessionRowId: session.id,
                onOutcome: (outcome) => {
                  log.debug(
                    {
                      id: session.id,
                      outcome: outcome.outcome,
                      ambiguousProcessCount: outcome.ambiguousProcessCount,
                      diagnosticState: outcome.diagnosticState,
                      diagnosticCodes: outcome.diagnosticCodes,
                    },
                    'stale session process-tree outcome',
                  );
                },
                onCgroupDivergence: (info) => {
                  log.debug(
                    { id: session.id, conversationKey: session.conversationKey, ...info },
                    'stale session cgroup divergence',
                  );
                },
              });
        } catch (err) {
          if (err instanceof ProcessTreeTerminationError && err.retryClass === 'permission_denied') {
            host.staleProcessTreePermissionBlocks.set(session.id, {
              pid: session.claudePid,
              generationMarker,
              birthToken,
              provider: session.provider,
            });
            host.staleProcessTreeRetries.delete(session.id);
            host.clearStaleProcessTreeRetryTimer(session.id);
          } else if (
            !retryRetainedLease
            && err instanceof ProcessTreeTerminationError
            && err.code === 'PROCESS_TREE_LEASE_CAPACITY'
          ) {
            host.staleProcessTreeRetries.delete(session.id);
            host.clearStaleProcessTreeRetryTimer(session.id);
          } else if (staleProcessTreeErrorAllowsAutomaticRetry(err)) {
            host.scheduleStaleProcessTreeRetry(session.id);
          } else {
            host.clearStaleProcessTreeRetryTimer(session.id);
          }
          log.error({
            ...processTreeFailureDiagnostic(err),
            id: session.id,
            pid: session.claudePid,
            conversationKey: session.conversationKey,
          }, 'stale session tree cleanup inconclusive — blocking proactive resume');
          if (session.conversationKey) {
            proactiveResumeBlockedConversationKeys.add(session.conversationKey);
            break;
          }
          throw err;
        }
        if (cleanupOutcome.outcome === 'unresolved_ambiguous') {
          host.scheduleStaleProcessTreeRetry(session.id);
          log.warn(
            {
              id: session.id,
              conversationKey: session.conversationKey,
              ambiguousCount: cleanupOutcome.ambiguousProcessCount,
            },
            'stale session tree cleanup unresolved — preserving active row',
          );
          if (session.conversationKey) {
            proactiveResumeBlockedConversationKeys.add(session.conversationKey);
          }
          break;
        }
        host.staleProcessTreeRetries.delete(session.id);
        host.staleProcessTreePermissionBlocks.delete(session.id);
        host.clearStaleProcessTreeRetryTimer(session.id);
        markOrphaned(host.db, session.id);
        break;
      case 'ambiguous': {
        const fallback = resolveAmbiguousAgeFallback(
          {
            id: session.id,
            claudePid: session.claudePid,
            startedAt: session.startedAt,
            messageCount: session.messageCount,
            provider: session.provider,
          },
          Date.now(),
          AMBIGUOUS_SESSION_MAX_AGE_MS,
        );
        if (fallback === 'orphan') {
          markOrphaned(host.db, session.id);
          log.warn({
            id: session.id,
            pid: session.claudePid,
            conversationKey: session.conversationKey,
            reason: session.reason,
          }, 'ambiguous session past age threshold with no activity — marked orphaned (#1756)');
          break;
        }
        log.warn({
          id: session.id,
          pid: session.claudePid,
          conversationKey: session.conversationKey,
          reason: session.reason,
        }, 'ambiguous session — not touching');
        // Left running — block a duplicate proactive resume for this key.
        if (session.conversationKey) proactiveResumeBlockedConversationKeys.add(session.conversationKey);
        break;
      }
      case 'authoritative_live':
        // Verified-live child left in place — block a duplicate proactive resume.
        if (session.conversationKey) proactiveResumeBlockedConversationKeys.add(session.conversationKey);
        break;
    }
  }
  return proactiveResumeBlockedConversationKeys;
}
