// src/runtimes/agent/runtime-poll-bridge.ts
// AskUserQuestion→WhatsApp-poll bridge, extracted from AgentRuntime (#1977 D3).
//
// Owns poll staging/settlement, vote handling, soft/hard expiry, send-poll
// awaiter registration, downtime rehydration, console decision resolution,
// and answer injection back into the waiting turn. All runtime state is
// reached through the RuntimePollBridgePort host — poll-owned collaborators
// (PendingPollStore, persistence, decision consumer) stay owned by
// AgentRuntime (test seams bind them on the runtime instance), and
// deletePendingPollQuestions / fetchGroupAdminJids stay whole on the runtime
// (structural-source and spy seams) with this module reaching them via the
// host. Zero state lives here.

import type { Messenger } from '../../core/types.ts';
import type { Database } from '../../core/database.ts';
import { isGroupJid } from '../../core/jid-constants.ts';
import {
  isOperatorDmPeer,
  isTrustedInternalDmPeer,
  resolveOutboundAudience,
  type OutboundAudience,
} from '../../core/outbound-message-safety.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { createChildLogger } from '../../logger.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import type { QueuedDecisionConsumer } from './pending-poll-health.ts';
import type { PendingPollStore } from './pending-poll-store.ts';
import type { PendingPollPersistence } from './pending-poll-persistence.ts';
import type { SystemTurnLeaseToken, SystemTurnPurpose } from './pending-system-result-tracker.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';
import type {
  PerChatRuntimeScopeRef,
  RuntimeTurnCompletion,
  RuntimeTurnCoordinator,
} from './runtime-turn-coordinator.ts';
import type { SessionManager } from './session.ts';
import type { TurnDeliveryKind } from './turn-chronology.ts';
import {
  advancePendingPollIndex,
  answerForPollSelection,
  clearPendingPollTimers,
  configuredDefaultPollTimeoutMs,
  deserializePendingPoll,
  evaluateResolution,
  evaluateResolutionOnTimeout,
  formatPollQuestion,
  formatTextFallbackQuestion,
  hasEscapeHatchOption,
  normalizeAskUserQuestions,
  normalizePendingPollTimeoutMs,
  pendingPollMatchesChatJid,
  removePollIdsForQuestion,
  resolveTypedPollAnswer,
  unansweredPollQuestions,
  type AskUserQuestion,
  type PendingPollQuestion,
  type PollVote,
  type ResolutionStrategy,
  type SerializedPendingPoll,
} from './poll-resolution.ts';

const log = createChildLogger('agent-runtime');

/**
 * Host port for the poll bridge — live-getter shape (#1977 D1/D2 precedent).
 * Getter-only: the bridge never reassigns runtime state; poll-owned
 * collaborators mutate in place. pollPersistence is assignment-stubbed by
 * tests on the runtime instance, so the live getter always reads the current
 * field. The three config reads pass through the host (ring boundary — this
 * module must not import src/config.ts).
 */
export interface RuntimePollBridgePort {
  readonly db: Database;
  readonly messenger: Messenger;
  readonly chatSessions: Map<string, SessionManager>;
  readonly pendingPolls: PendingPollStore;
  readonly pollPersistence: PendingPollPersistence;
  readonly suppressedAskUserToolIds: Set<string>;
  readonly pendingPollSourceTurnBarriers: WeakMap<PendingPollQuestion, Promise<void>>;
  readonly queuedDecisionConsumer: QueuedDecisionConsumer;
  readonly runtimeTurnCoordinator: RuntimeTurnCoordinator;
  readonly perChatRuntimeTurnCompletions: Map<string, RuntimeTurnCompletion>;
  readonly isFallbackWindowActive: boolean;
  readonly adminPhones: Set<string>;
  readonly internalPeerJids: Set<string>;
  readonly pollResolution: { defaultStrategy: string; defaultTimeoutMs: number };
  getQueueForChat(chatJid: string, mapKey?: string): IOutboundQueue | null;
  sendDirect(chatJid: string, text: string): void;
  deletePendingPollQuestions(mapKey: string): void;
  fetchGroupAdminJids(chatJid: string): Promise<Set<string> | null>;
  markSystemTurn(
    session: SessionManager,
    scopeKey: string,
    purpose: SystemTurnPurpose,
    routeChatJid?: string,
  ): SystemTurnLeaseToken;
  sendTurnPerChat(
    chatJid: string,
    text: string,
    mapKey?: string,
    actorJid?: string,
    runtimeContext?: RuntimeTurnContext,
    scopeRef?: PerChatRuntimeScopeRef,
    systemTurnLease?: SystemTurnLeaseToken,
    excludeJobId?: number,
    requestedDeliveryKind?: TurnDeliveryKind,
    targetDispatchAllowed?: () => boolean,
    onProviderBoundary?: () => void,
  ): Promise<void>;
  settleFailedSystemTurnDispatch(
    session: SessionManager,
    scopeKey: string,
    lease: SystemTurnLeaseToken | null | undefined,
    error: unknown,
  ): Promise<void>;
}

export class RuntimePollBridgeCoordinator {
  private readonly host: RuntimePollBridgePort;

  constructor(host: RuntimePollBridgePort) {
    this.host = host;
  }

  /** Remove an AskUser continuation from interception while retaining its durable row. */
  detachPendingPollContinuation(
    mapKey: string,
    pending: PendingPollQuestion,
  ): boolean {
    if (this.host.pendingPolls.questions.get(mapKey) !== pending) return false;
    clearPendingPollTimers(pending);
    this.host.suppressedAskUserToolIds.delete(pending.toolId);
    this.host.pendingPolls.questions.delete(mapKey);
    return true;
  }

  private abandonPendingPollContinuation(
    mapKey: string,
    pending: PendingPollQuestion,
    error: unknown,
  ): void {
    const current = this.host.pendingPolls.questions.get(mapKey);
    if (current === pending) {
      this.host.deletePendingPollQuestions(mapKey);
    } else if (current === undefined) {
      this.host.pollPersistence.remove(mapKey);
    }
    this.host.getQueueForChat(pending.chatJid, mapKey)?.setPollPending(false);
    this.host.sendDirect(
      pending.chatJid,
      'I received your poll answer, but could not continue it safely. Please send your answer again.',
    );
    log.error(
      { err: error, mapKey, chatJid: pending.chatJid },
      'resolved AskUser continuation abandoned after dispatch failure',
    );
  }

  stageResolvedAskUserPoll(
    mapKey: string,
    pending: PendingPollQuestion,
  ): void {
    pending.resolvedAt ??= Date.now();
    clearPendingPollTimers(pending);
    const connection = this.host.messenger as ConnectionManager;
    if (typeof connection.clearPollTracking === 'function') {
      for (const pollMessageId of pending.sentPollMessageIds) {
        connection.clearPollTracking(pollMessageId);
      }
    }
    this.host.pollPersistence.save(mapKey, pending);
    this.host.getQueueForChat(pending.chatJid, mapKey)?.setPollPending(false);
  }

  /**
   * Restore pending polls from the persistence table on runtime start. Live
   * polls (hard_closes_at > now) are rehydrated into `pendingPolls.questions`
   * with re-armed timers using the remaining time. Expired polls
   * (hard_closes_at <= now) have a brief "decision expired during downtime"
   * message sent to the originating chat (best-effort via outbound queue) and
   * are deleted from the table.
   *
   * Persistence errors are logged and swallowed; rehydration always succeeds
   * structurally even if some rows are unreadable.
   */
  /**
   * D-4 v1.1: consume console decisions that were queued durably while the
   * instance was down (pending_poll_decisions, written by the fleet's approvals
   * route — write-while-down discipline). Each queued decision resolves through
   * resolvePollDecisionFromConsole — the same poll-resolution path as a live
   * console decision or a WhatsApp vote. Moot / unparseable rows are dropped
   * visibly; 'invalid' rows are retained for operator retry. The loop, durable
   * consumption receipts, and the scheduled in-process retry live in the
   * extracted QueuedDecisionConsumer (CAR-20 #2539) — previously a transient
   * read/parse/delete failure stranded rows for "next boot" only. Runs once at
   * boot, after rehydratePendingPolls.
   */
  async consumeQueuedPollDecisions(): Promise<void> {
    await this.host.queuedDecisionConsumer.consume({
      hasPending: (mapKey) => this.host.pendingPolls.questions.has(mapKey),
      resolve: (decision) => this.resolvePollDecisionFromConsole(decision),
    });
  }

  async rehydratePendingPolls(): Promise<void> {
    const rows = this.host.pollPersistence.loadRows();
    if (rows.length === 0) return;

    const now = Date.now();
    let restored = 0;
    let expired = 0;
    // Accumulate expired-poll counts per chat so a long downtime that strands
    // many polls in one chat produces a single consolidated notification rather
    // than one message per stranded poll.
    const expiredByChat = new Map<string, number>();
    const interruptedContinuationsByChat = new Map<string, number>();
    for (const row of rows) {
      try {
        if (row.hard_closes_at !== null && row.hard_closes_at <= now) {
          this.host.pollPersistence.remove(row.map_key);
          expiredByChat.set(row.chat_jid, (expiredByChat.get(row.chat_jid) ?? 0) + 1);
          expired += 1;
          continue;
        }
        const serialized = JSON.parse(row.payload) as SerializedPendingPoll;
        const pending = deserializePendingPoll(serialized);
        if (pending.source === 'askuser' && pending.resolvedAt !== undefined) {
          this.host.pollPersistence.remove(row.map_key);
          interruptedContinuationsByChat.set(
            row.chat_jid,
            (interruptedContinuationsByChat.get(row.chat_jid) ?? 0) + 1,
          );
          continue;
        }
        this.host.pendingPolls.questions.set(row.map_key, pending);
        this.startPendingPollExpiry(row.map_key, pending);
        restored += 1;
      } catch (err) {
        this.host.pollPersistence.errors += 1;
        log.error({ err, mapKey: row.map_key }, 'rehydratePendingPolls: row deserialize failed; skipping');
      }
    }
    for (const [chatJid, count] of expiredByChat) {
      this.notifyPollExpiredDuringDowntime(chatJid, count);
    }
    for (const [chatJid, count] of interruptedContinuationsByChat) {
      this.notifyPollContinuationInterrupted(chatJid, count);
    }
    if (restored > 0 || expired > 0 || interruptedContinuationsByChat.size > 0) {
      log.info({
        restored,
        expired,
        chatsNotified: expiredByChat.size,
        interruptedContinuationChats: interruptedContinuationsByChat.size,
      }, 'rehydratePendingPolls: completed');
    }
  }

  /**
   * Best-effort notification that one or more pending polls expired during
   * process downtime. The recipient sees a single consolidated line per chat;
   * the polls themselves are dropped. Failure to send (messenger not ready,
   * JID unresolvable) is logged.
   */
  private notifyPollExpiredDuringDowntime(chatJid: string, count = 1): void {
    const message = count > 1
      ? `${count} polls I was waiting on expired before I picked them back up — ask me again if you still need those decisions.`
      : 'A poll I was waiting on expired before I picked it back up — ask me again if you still need that decision.';
    try {
      void this.host.messenger.sendMessage(chatJid, message).catch((err) =>
        log.warn({ err, chatJid }, 'notifyPollExpiredDuringDowntime: send failed (non-fatal)'),
      );
    } catch (err) {
      log.warn({ err, chatJid }, 'notifyPollExpiredDuringDowntime: dispatch failed (non-fatal)');
    }
  }

  private notifyPollContinuationInterrupted(chatJid: string, count = 1): void {
    const message = count > 1
      ? `I received ${count} poll answers before restarting, but could not continue them safely. Please send the answers again.`
      : 'I received your poll answer before restarting, but could not continue it safely. Please send the answer again.';
    try {
      void this.host.messenger.sendMessage(chatJid, message).catch((err) =>
        log.warn({ err, chatJid }, 'notifyPollContinuationInterrupted: send failed (non-fatal)'),
      );
    } catch (err) {
      log.warn({ err, chatJid }, 'notifyPollContinuationInterrupted: dispatch failed (non-fatal)');
    }
  }

  startPendingPollExpiry(mapKey: string, pending: PendingPollQuestion): void {
    const timeoutMs = normalizePendingPollTimeoutMs(pending.timeoutMs);
    pending.timeoutMs = timeoutMs;
    const softMs = timeoutMs;
    const hardMs = timeoutMs * 2;

    if (pending.mode === 'poll' && !pending.softExpiryTimer) {
      pending.softExpiryTimer = setTimeout(() => {
        pending.softExpiryTimer = undefined;
        this.handlePendingPollSoftExpiry(mapKey, pending);
      }, softMs);
      pending.softExpiryTimer.unref?.();
    }
    if (!pending.hardExpiryTimer) {
      pending.hardExpiryTimer = setTimeout(() => {
        pending.hardExpiryTimer = undefined;
        this.handlePendingPollHardExpiry(mapKey, pending);
      }, hardMs);
      pending.hardExpiryTimer.unref?.();
    }
  }

  /** T8-F1+F2: shared operator-DM elevation ctx for direct sends/polls. */
  private resolveSendAudience(chatJid: string, isGroup: boolean): OutboundAudience {
    const peerIsAdmin = isOperatorDmPeer(chatJid, isGroup, this.host.db, this.host.adminPhones);
    const peerIsTrustedInternal = isTrustedInternalDmPeer(
      chatJid,
      isGroup,
      this.host.internalPeerJids,
    );
    return resolveOutboundAudience(chatJid, {
      isGroup,
      peerIsAdmin,
      peerIsTrustedInternal,
      fallbackActive: this.host.isFallbackWindowActive,
    });
  }

  private sendUnansweredPollTextFallback(
    pending: PendingPollQuestion,
    intro: string,
  ): void {
    const audience = this.resolveSendAudience(pending.chatJid, isGroupJid(pending.chatJid));
    const unanswered = unansweredPollQuestions(pending);
    unanswered.forEach(({ question }, fallbackIndex) => {
      this.host.sendDirect(
        pending.chatJid,
        formatTextFallbackQuestion(
          question,
          fallbackIndex === 0 ? intro : 'Remaining decision question:',
          undefined,
          audience,
        ),
      );
    });
  }

  private settlePoll(
    mapKey: string,
    pending: PendingPollQuestion,
    reason: 'vote' | 'timeout' | 'abort' | 'expiry',
    answer: string,
  ): void {
    // Re-read and verify object identity — idempotent guard
    const current = this.host.pendingPolls.questions.get(mapKey);
    if (current !== pending || pending.resolvedAt !== undefined) {
      log.debug({ mapKey, reason }, 'settlePoll called but poll already settled or removed');
      return;
    }
    pending.resolvedAt = Date.now();

    // Clear timers
    if (pending.softExpiryTimer) { clearTimeout(pending.softExpiryTimer); pending.softExpiryTimer = undefined; }
    if (pending.hardExpiryTimer) { clearTimeout(pending.hardExpiryTimer); pending.hardExpiryTimer = undefined; }

    // Clear transport poll tracking using preserved sent IDs
    const connection = this.host.messenger as ConnectionManager;
    if (typeof connection.clearPollTracking === 'function' && pending.sentPollMessageIds) {
      for (const pollMsgId of pending.sentPollMessageIds) {
        connection.clearPollTracking(pollMsgId);
      }
    }

    // Resolve/reject BEFORE removing from map
    if (pending.source === 'send_poll') {
      if (reason === 'abort' || reason === 'expiry') {
        if (pending.awaitReject) {
          pending.awaitReject(new Error(`Poll ${reason}: ${answer}`));
        }
      } else if (pending.awaitResolve) {
        pending.awaitResolve(answer);
      }
      pending.awaitResolve = undefined;
      pending.awaitReject = undefined;
    }

    const askUserContinuation = pending.source === 'askuser' || pending.source === undefined;
    if (askUserContinuation) {
      // Retain the resolved answer in memory + SQLite until the continuation
      // has crossed the provider boundary. A crash or failed source
      // finalization must not turn a successfully collected vote into silence.
      this.host.pollPersistence.save(mapKey, pending);
    } else {
      // send_poll awaiters were settled above and have no provider continuation.
      this.host.deletePendingPollQuestions(mapKey);
    }

    // AskUser: inject answer into session (treat undefined source as 'askuser' for legacy compat)
    if (askUserContinuation) {
      void this.injectPollAnswers(mapKey, pending).catch((err) => {
        log.error({ err, mapKey, chatJid: pending.chatJid }, 'failed to inject poll answer via sendTurnPerChat');
      });
    }

    // Mark queue as no longer poll-pending
    const queue = this.host.getQueueForChat(pending.chatJid, mapKey);
    queue?.setPollPending(false);

    log.info({ mapKey, reason, source: pending.source }, 'poll settled');
  }

  handlePendingPollSoftExpiry(mapKey: string, expectedPending: PendingPollQuestion): void {
    const pending = this.host.pendingPolls.questions.get(mapKey);
    if (!pending || pending !== expectedPending || pending.mode !== 'poll') return;

    // send_poll awaiters should settle/reject without sending AskUser fallback text
    if (pending.source === 'send_poll') {
      if (pending.resolution === 'majority-after-timeout') {
        // Tally and settle with majority result
        for (const [qIndex, votes] of pending.votesByQuestion) {
          if (pending.answersCollected[qIndex] === undefined) {
            const winner = evaluateResolutionOnTimeout(votes);
            pending.answersCollected[qIndex] = winner ?? '[No votes received — decision expired]';
          }
        }
        for (let i = 0; i < pending.questions.length; i++) {
          if (pending.answersCollected[i] === undefined) {
            pending.answersCollected[i] = '[No votes received — decision expired]';
          }
        }
        const answer = pending.questions.map((_, i) => pending.answersCollected[i]).join('\n');
        this.settlePoll(mapKey, pending, 'timeout', answer);
        return;
      }

      // admin-wins timeout fallback: if no admin voted, use majority of recorded non-admin votes
      if (pending.resolution === 'admin-wins' && pending.adminJids !== null) {
        for (const [qIndex, votes] of pending.votesByQuestion) {
          if (pending.answersCollected[qIndex] === undefined) {
            const winner = evaluateResolutionOnTimeout(votes);
            pending.answersCollected[qIndex] = winner ?? '[No admin responded — decision expired]';
          }
        }
        for (let i = 0; i < pending.questions.length; i++) {
          if (pending.answersCollected[i] === undefined) {
            pending.answersCollected[i] = '[No admin responded — decision expired]';
          }
        }
        const answer = pending.questions.map((_, i) => pending.answersCollected[i]).join('\n');
        this.settlePoll(mapKey, pending, 'timeout', answer);
        return;
      }

      this.settlePoll(mapKey, pending, 'expiry', '[Poll timed out — no qualifying vote received]');
      return;
    }

    // For AskUser majority-after-timeout, resolve with tally
    if (pending.resolution === 'majority-after-timeout') {
      for (const [qIndex, votes] of pending.votesByQuestion) {
        if (pending.answersCollected[qIndex] === undefined) {
          const winner = evaluateResolutionOnTimeout(votes);
          pending.answersCollected[qIndex] = winner ?? '[No votes received — decision expired]';
        }
      }
      for (let i = 0; i < pending.questions.length; i++) {
        if (pending.answersCollected[i] === undefined) {
          pending.answersCollected[i] = '[No votes received — decision expired]';
        }
      }
      const answer = pending.questions.map((_, i) => pending.answersCollected[i]).join('\n');
      this.settlePoll(mapKey, pending, 'timeout', answer);
      return;
    }

    // AskUser admin-wins timeout fallback: if no admin voted, use majority of recorded non-admin votes
    if (pending.resolution === 'admin-wins' && pending.adminJids !== null) {
      for (const [qIndex, votes] of pending.votesByQuestion) {
        if (pending.answersCollected[qIndex] === undefined) {
          const winner = evaluateResolutionOnTimeout(votes);
          pending.answersCollected[qIndex] = winner ?? '[No admin responded — decision expired]';
        }
      }
      for (let i = 0; i < pending.questions.length; i++) {
        if (pending.answersCollected[i] === undefined) {
          pending.answersCollected[i] = '[No admin responded — decision expired]';
        }
      }
      const answer = pending.questions.map((_, i) => pending.answersCollected[i]).join('\n');
      this.settlePoll(mapKey, pending, 'timeout', answer);
      return;
    }

    const unanswered = unansweredPollQuestions(pending);
    if (unanswered.length === 0) return;

    pending.mode = 'textFallback';
    pending.pollMessageIdToQuestionIndex.clear();
    pending.softExpiryTimer = undefined;
    advancePendingPollIndex(pending);
    this.host.pollPersistence.save(mapKey, pending);
    this.sendUnansweredPollTextFallback(
      pending,
      'I did not receive the poll vote. Please reply with option number or text for the remaining decision question(s):',
    );
    log.warn({ mapKey, chatJid: pending.chatJid, unanswered: unanswered.length }, 'AskUserQuestion poll soft-expired to text fallback');
  }

  handlePendingPollHardExpiry(mapKey: string, expectedPending: PendingPollQuestion): void {
    const pending = this.host.pendingPolls.questions.get(mapKey);
    if (!pending || pending !== expectedPending) return;

    if (unansweredPollQuestions(pending).length > 0) {
      this.host.sendDirect(pending.chatJid, 'This decision has expired — please re-trigger when ready.');
    }
    log.warn({ mapKey, chatJid: pending.chatJid }, 'AskUserQuestion poll hard-expired and was cleared');
    this.host.deletePendingPollQuestions(mapKey);
  }

  /**
   * Register a send_poll tool call as a pending poll awaiter.
   * Bridges the MCP tool layer to the runtime's poll resolution engine
   * so that `awaitResult: true` polls block until a vote resolves them.
   */
  registerSendPollAwaiter(
    pollId: string,
    chatJid: string,
    options: string[],
    resolution: ResolutionStrategy,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const mapKey = `send_poll:${pollId}`;

      // DMs always use first-vote-wins — admin strategies require group metadata
      if (!isGroupJid(chatJid) && (resolution === 'admin-only' || resolution === 'admin-wins')) {
        log.warn({ pollId, chatJid, resolution }, 'admin poll strategy used in DM — degrading to first-vote-wins');
        resolution = 'first-vote-wins';
      }

      const pending: PendingPollQuestion = {
        questions: [{ question: 'send_poll', header: 'Poll', options: options.map(o => ({ label: o, description: '' })), multiSelect: false }],
        toolId: `send_poll:${pollId}`,
        chatJid,
        chatJidAliases: new Set([chatJid]),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([[pollId, 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt: Date.now(),
        resolution,
        timeoutMs,
        votesByQuestion: new Map(),
        adminJids: null,
        awaitResolve: resolve,
        awaitReject: reject,
        source: 'send_poll',
        sentPollMessageIds: [pollId],
      };
      this.host.pendingPolls.questions.set(mapKey, pending);
      this.host.pollPersistence.save(mapKey, pending);
      this.startPendingPollExpiry(mapKey, pending);

      // Wire AbortSignal for MCP client disconnect
      if (abortSignal) {
        const onAbort = () => {
          this.settlePoll(mapKey, pending, 'abort', 'MCP client disconnected');
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        // Wrap resolve/reject to clean up abort listener on normal settlement
        const origResolve = pending.awaitResolve;
        const origReject = pending.awaitReject;
        if (origResolve) {
          pending.awaitResolve = (answer: string) => {
            abortSignal.removeEventListener('abort', onAbort);
            origResolve(answer);
          };
        }
        if (origReject) {
          pending.awaitReject = (err: Error) => {
            abortSignal.removeEventListener('abort', onAbort);
            origReject(err);
          };
        }
      }

      // Fetch admin JIDs if strategy requires it
      if ((resolution === 'admin-only' || resolution === 'admin-wins') && isGroupJid(chatJid)) {
        void this.host.fetchGroupAdminJids(chatJid).then(admins => {
          if (this.host.pendingPolls.questions.get(mapKey) === pending) {
            pending.adminJids = admins;
            if (admins === null) {
              // QR-036: fail CLOSED, not open. Keep the admin-only/admin-wins
              // strategy with adminJids=null so NO member vote qualifies as admin
              // (a non-admin can no longer hijack the gated decision when group
              // metadata is transiently unavailable). Liveness is bounded by the
              // existing soft-expiry timeout fallback (admin-wins → non-admin
              // majority-after-timeout, admin-only → operator text-fallback).
              log.warn({ mapKey, resolution }, 'admin metadata unavailable — keeping admin gate (fail-closed)');
            }
          }
        });
      }
    });
  }

  /**
   * Intercept an AskUserQuestion tool_use: send WhatsApp polls for each
   * question, store pending state, and register the toolId for tool_result
   * suppression.
   */
  async handleAskUserQuestionAsPoll(
    questions: AskUserQuestion[],
    toolId: string,
    mapKey: string,
    queue: IOutboundQueue,
  ): Promise<void> {
    const chatJid = queue.targetChatJid;

    const normalizedQuestions = normalizeAskUserQuestions(questions);
    questions.forEach((question, index) => {
      const sourceOptions = question.options.map((option) => ({
        label: option.label,
        description: option.description ?? '',
      }));
      if (
        sourceOptions.length >= 12
        && !hasEscapeHatchOption(sourceOptions)
        && normalizedQuestions[index]?.options.length === sourceOptions.length
      ) {
        log.warn({ chatJid, toolId, question: question.question.slice(0, 80), optionCount: sourceOptions.length }, 'AskUserQuestion options at WhatsApp cap — default Other option not appended');
      }
    });

    const connection = this.host.messenger as import('../../transport/connection.ts').ConnectionManager;

    const instanceConfig = this.host.pollResolution;
    const isGroup = isGroupJid(chatJid);
    const resolvedStrategy: ResolutionStrategy = isGroup
      ? ((instanceConfig?.defaultStrategy as ResolutionStrategy | undefined) ?? 'first-vote-wins')
      : 'first-vote-wins';
    const sourceContext = this.host.runtimeTurnCoordinator.runtimeTurnContext(mapKey);
    const sourceCompletion = this.host.perChatRuntimeTurnCompletions.get(mapKey);
    const sourceSession = this.host.chatSessions.get(mapKey);
    const sourceBarrier = (
      sourceContext
      && sourceCompletion?.context.identity.logicalTurnId === sourceContext.identity.logicalTurnId
    )
      ? sourceCompletion.promise
      : sourceSession?.waitForProviderTurnToTerminalize();

    // Register every ownership/suppression surface before the first await.
    // Group metadata and poll transport can both outlive the source result.
    this.host.deletePendingPollQuestions(mapKey);
    this.host.suppressedAskUserToolIds.add(toolId);
    const pending: PendingPollQuestion = {
      questions: normalizedQuestions,
      toolId,
      chatJid,
      chatJidAliases: new Set([chatJid]),
      mode: 'poll',
      pollMessageIdToQuestionIndex: new Map<string, number>(),
      currentQuestionIndex: 0,
      answersCollected: {},
      createdAt: Date.now(),
      resolution: resolvedStrategy,
      timeoutMs: configuredDefaultPollTimeoutMs(),
      votesByQuestion: new Map(),
      adminJids: null,
      sentPollMessageIds: [],
      source: 'askuser' as const,
      resolvedAt: undefined,
    };
    this.host.pendingPolls.questions.set(mapKey, pending);
    if (sourceBarrier) this.host.pendingPollSourceTurnBarriers.set(pending, sourceBarrier);
    this.host.pollPersistence.save(mapKey, pending);

    if (isGroup && (resolvedStrategy === 'admin-only' || resolvedStrategy === 'admin-wins')) {
      const adminJids = await this.host.fetchGroupAdminJids(chatJid);
      if (!this.host.pendingPolls.shouldContinueSend(mapKey, pending)) return;
      pending.adminJids = adminJids;
      this.host.pollPersistence.save(mapKey, pending);
      if (adminJids === null) {
        // QR-036: fail CLOSED. Keep the admin-only/admin-wins strategy with
        // adminJids=null so no member vote qualifies as admin (no non-admin can
        // resolve the gated decision on transient metadata failure); liveness via
        // the soft-expiry timeout fallback.
        log.warn({ chatJid, resolvedStrategy }, 'admin metadata unavailable — keeping admin gate (fail-closed)');
      }
    }

    const pollMessageIds: string[] = [];
    let allHaveSecret = true;
    const pollAudience = this.resolveSendAudience(chatJid, isGroup); // T8-F1+F2
    const formattedQuestions = normalizedQuestions.map((q, index) => ({
      index,
      question: q,
      formatted: formatPollQuestion(q, pollAudience),
    }));
    const detailFlushedQuestionIndexes = new Set<number>();

    const sendPollLoop = async (): Promise<void> => {
      for (const { index, question: q, formatted } of formattedQuestions) {
        const selectableCount = q.multiSelect ? q.options.length : 1;

        if (formatted.followUpText) {
          queue.enqueueText(formatted.followUpText);
          // Long option details should arrive before the poll so the user can read
          // context first instead of scrolling back after the tap target appears.
          try {
            await queue.flush();
            detailFlushedQuestionIndexes.add(index);
          } catch (err) {
            log.warn({ err, chatJid }, 'failed to flush poll details before poll send');
          }
          if (!this.host.pendingPolls.shouldContinueSend(mapKey, pending)) return;
        }

        try {
          const result = await connection.sendPollMessage(chatJid, formatted.pollName, formatted.pollValues, selectableCount);
          if (!this.host.pendingPolls.shouldContinueSend(mapKey, pending)) return;
          if (result.waMessageId) {
            pollMessageIds.push(result.waMessageId);
            pending.pollMessageIdToQuestionIndex.set(result.waMessageId, index);
          }
          if (!result.hasSecret) {
            allHaveSecret = false;
          }
        } catch (err) {
          if (!this.host.pendingPolls.shouldContinueSend(mapKey, pending)) return;
          log.error({ err, chatJid, question: q.question.slice(0, 80) }, 'failed to send poll for AskUserQuestion');
          allHaveSecret = false;
        }
      }
    };

    const pollQueue = this.host.getQueueForChat(chatJid, mapKey);
    if (pollQueue) {
      await pollQueue.enqueuePoll(sendPollLoop);
      pollQueue.setPollPending(true);
    } else {
      await sendPollLoop();
    }

    if (!this.host.pendingPolls.shouldContinueSend(mapKey, pending)) return;

    pending.sentPollMessageIds = [...pollMessageIds];

    if (pollMessageIds.length === 0 || !allHaveSecret) {
      pending.mode = 'textFallback';
      pending.pollMessageIdToQuestionIndex.clear();
      // Fall back: send as text with numbered options.
      // Text fallback already includes full descriptions — no follow-up needed.
      log.warn({ chatJid, toolId }, 'poll send failed or missing secret — falling back to text question');
      for (const { index, question: q } of formattedQuestions) {
        queue.enqueueText(formatTextFallbackQuestion(q, undefined, {
          includeDescriptions: !detailFlushedQuestionIndexes.has(index),
        }, pollAudience));
      }
    }

    this.startPendingPollExpiry(mapKey, pending);
    log.info({ chatJid, mapKey, toolId, questionCount: normalizedQuestions.length, pollCount: pollMessageIds.length }, 'AskUserQuestion intercepted → polls sent');
  }

  /**
   * Handle a poll vote received from the transport layer.
   * Matches the vote to a pending AskUserQuestion and injects the answer
   * as a sendTurn text message.
   */
  handlePollVoteReceived(data: {
    pollMessageId: string;
    chatJid: string;
    voterJid: string;
    selectedOptions: string[];
  }): void {
    let matchedMapKey: string | null = null;
    let matchedQuestionIndex: number | undefined;
    for (const [mapKey, pending] of this.host.pendingPolls.questions) {
      if (!pendingPollMatchesChatJid(pending, data.chatJid) || pending.mode !== 'poll') continue;
      const index = pending.pollMessageIdToQuestionIndex.get(data.pollMessageId);
      if (index !== undefined) {
        matchedMapKey = mapKey;
        matchedQuestionIndex = index;
        break;
      }
    }

    if (matchedMapKey === null || matchedQuestionIndex === undefined) {
      log.debug({ chatJid: data.chatJid, pollMessageId: data.pollMessageId }, 'poll vote received but no matching pending poll');
      return;
    }

    const pending = this.host.pendingPolls.questions.get(matchedMapKey)!;
    const currentQ = pending.questions[matchedQuestionIndex];
    if (!currentQ) {
      log.warn({ mapKey: matchedMapKey, index: matchedQuestionIndex }, 'poll vote for out-of-range question index');
      pending.pollMessageIdToQuestionIndex.delete(data.pollMessageId);
      return;
    }

    if (pending.answersCollected[matchedQuestionIndex] !== undefined) {
      log.debug({ mapKey: matchedMapKey, pollMessageId: data.pollMessageId, index: matchedQuestionIndex }, 'duplicate poll vote ignored');
      return;
    }

    // Determine admin status for this voter
    const isAdmin = pending.adminJids?.has(jidNormalizedUser(data.voterJid)) ?? false;

    const vote: PollVote = {
      voterJid: data.voterJid,
      selectedOptions: data.selectedOptions,
      isAdmin,
      timestamp: Date.now(),
    };

    // Store vote per question (votesByQuestion may be absent on legacy state)
    if (!pending.votesByQuestion) pending.votesByQuestion = new Map();
    let questionVotes = pending.votesByQuestion.get(matchedQuestionIndex);
    if (!questionVotes) {
      questionVotes = new Map();
      pending.votesByQuestion.set(matchedQuestionIndex, questionVotes);
    }
    const canonicalVoter = jidNormalizedUser(data.voterJid);
    questionVotes.set(canonicalVoter, vote);

    // Evaluate resolution for this question (resolution may be absent on legacy state)
    const resolutionResult = evaluateResolution(pending.resolution ?? 'first-vote-wins', questionVotes, pending.adminJids);
    if (resolutionResult.status === 'resolved' && resolutionResult.answer !== undefined) {
      if (pending.answersCollected[matchedQuestionIndex] === undefined) {
        // Use answerForPollSelection to apply question-aware formatting (e.g. "Other" directive)
        const winningVote = questionVotes.get(canonicalVoter) ?? vote;
        pending.answersCollected[matchedQuestionIndex] = answerForPollSelection(currentQ, winningVote.selectedOptions);
        removePollIdsForQuestion(pending, matchedQuestionIndex);
        advancePendingPollIndex(pending);
      }
    }

    // Persist ballot/answer mutations so a restart during a multi-vote poll
    // doesn't lose the in-progress tally.
    this.host.pollPersistence.save(matchedMapKey, pending);

    // Check if all questions resolved
    const answered = Object.keys(pending.answersCollected).length;
    if (answered >= pending.questions.length) {
      const fullAnswer = pending.questions.map((_, i) => pending.answersCollected[i] ?? '(no answer)').join('\n');
      this.settlePoll(matchedMapKey, pending, 'vote', fullAnswer);
    } else {
      log.info({ mapKey: matchedMapKey, answered, total: pending.questions.length }, 'poll vote collected — waiting for more');
    }
  }

  handlePollVoteFailed(data: {
    pollMessageId: string;
    chatJid: string;
    reason: string;
  }): void {
    let matchedMapKey: string | null = null;
    for (const [mapKey, pending] of this.host.pendingPolls.questions) {
      if (!pendingPollMatchesChatJid(pending, data.chatJid) || pending.mode !== 'poll') continue;
      if (pending.pollMessageIdToQuestionIndex.has(data.pollMessageId)) {
        matchedMapKey = mapKey;
        break;
      }
    }

    if (matchedMapKey === null) {
      log.debug({ chatJid: data.chatJid, pollMessageId: data.pollMessageId, reason: data.reason }, 'poll vote failure received but no matching pending poll');
      return;
    }

    const pending = this.host.pendingPolls.questions.get(matchedMapKey);
    if (!pending || pending.mode !== 'poll') return;

    if (pending.source === 'send_poll') {
      this.settlePoll(matchedMapKey, pending, 'expiry', '[Poll vote decryption failed]');
      return;
    }

    pending.mode = 'textFallback';
    pending.pollMessageIdToQuestionIndex.clear();
    if (pending.softExpiryTimer) {
      clearTimeout(pending.softExpiryTimer);
      pending.softExpiryTimer = undefined;
    }
    advancePendingPollIndex(pending);
    this.sendUnansweredPollTextFallback(
      pending,
      "I couldn't read your poll vote. Please type your choice for the remaining decision question(s):",
    );
    log.warn({ mapKey: matchedMapKey, chatJid: pending.chatJid, pollMessageId: data.pollMessageId, reason: data.reason }, 'poll vote failure switched AskUserQuestion to text fallback');
  }

  /**
   * D-4: resolve a pending poll from the console approval queue. Translates
   * the decision into the exact vote-event shape and delegates to
   * handlePollVoteReceived — the SAME code path a WhatsApp vote takes
   * (first-resolution-wins, answer injection, persistence all shared
   * verbatim; UX-20 parity). Reached via the instance health server's
   * POST /poll-decision, proxied by the fleet approvals route. Never writes
   * the pending_polls row directly.
   */
  async resolvePollDecisionFromConsole(decision: {
    mapKey: string;
    questionIndex: number;
    selectedOptions: string[];
  }): Promise<{ ok: true } | { ok: false; error: string; code: 'not_found' | 'stale' | 'invalid' }> {
    const pending = this.host.pendingPolls.questions.get(decision.mapKey);
    if (!pending) {
      return { ok: false, error: 'pending poll not found (already resolved or expired)', code: 'not_found' };
    }
    if (pending.mode === 'textFallback') {
      // v1.1: console decisions for text-fallback pendings mirror the typed-
      // answer path verbatim (answer collect → index advance → persistence →
      // stage + inject when fully answered). completeConsumedPerChatInbound is
      // deliberately skipped: a console decision has no inbound WhatsApp
      // message to consume.
      const question = pending.questions[decision.questionIndex];
      if (!question) {
        return { ok: false, error: 'question index out of range', code: 'invalid' };
      }
      if (pending.answersCollected[decision.questionIndex] !== undefined) {
        return { ok: false, error: 'already resolved', code: 'stale' };
      }
      const validLabels = new Set(question.options.map((o) => o.label));
      if (decision.selectedOptions.length !== 1 || !validLabels.has(decision.selectedOptions[0]!)) {
        return { ok: false, error: 'text-fallback decisions take exactly one valid option', code: 'invalid' };
      }
      pending.answersCollected[decision.questionIndex] = resolveTypedPollAnswer(decision.selectedOptions[0]!, question);
      removePollIdsForQuestion(pending, decision.questionIndex);
      pending.currentQuestionIndex = Math.max(pending.currentQuestionIndex, decision.questionIndex + 1);
      advancePendingPollIndex(pending);
      this.host.pollPersistence.save(decision.mapKey, pending);
      log.info(
        { mapKey: decision.mapKey, questionIndex: decision.questionIndex, via: 'console' },
        'text-fallback decision delivered from the console approval queue',
      );
      if (Object.keys(pending.answersCollected).length >= pending.questions.length) {
        this.stageResolvedAskUserPoll(decision.mapKey, pending);
        const actorJid = pending.adminJids?.values().next().value ?? pending.chatJid;
        await this.injectPollAnswers(decision.mapKey, pending, actorJid);
      }
      return { ok: true };
    }
    if (pending.mode !== 'poll') {
      return { ok: false, error: 'unsupported pending mode', code: 'invalid' };
    }
    if (pending.answersCollected[decision.questionIndex] !== undefined) {
      return { ok: false, error: 'already resolved', code: 'stale' };
    }
    const question = pending.questions[decision.questionIndex];
    if (!question) {
      return { ok: false, error: 'question index out of range', code: 'invalid' };
    }
    const validLabels = new Set(question.options.map((o) => o.label));
    if (decision.selectedOptions.length === 0
        || !decision.selectedOptions.every((l) => validLabels.has(l))) {
      return { ok: false, error: 'selected option(s) are not options of this question', code: 'invalid' };
    }
    const pollMessageId = Array.from(pending.pollMessageIdToQuestionIndex.entries())
      .find(([, qi]) => qi === decision.questionIndex)?.[0];
    if (!pollMessageId) {
      return { ok: false, error: 'no live poll message for this question (already resolved?)', code: 'stale' };
    }
    const voterJid = pending.adminJids?.values().next().value ?? pending.chatJid;
    log.info(
      { mapKey: decision.mapKey, questionIndex: decision.questionIndex, via: 'console' },
      'poll decision delivered from the console approval queue',
    );
    this.handlePollVoteReceived({
      pollMessageId,
      chatJid: pending.chatJid,
      voterJid,
      selectedOptions: decision.selectedOptions,
    });
    // The vote handler is fire-and-forget on duplicates/races — verify the
    // answer actually landed before reporting delivery.
    if (pending.answersCollected[decision.questionIndex] === undefined) {
      return { ok: false, error: 'decision was not accepted (duplicate or raced resolution)', code: 'stale' };
    }
    return { ok: true };
  }

  /**
   * Inject collected poll answers back into the session as a user turn.
   * Routes through the runtime's normal turn path (sendTurnPerChat / shared
   * sendTurn) so pendingTurnText, post-turn-gate, and durability state stay
   * consistent.
   */
  async injectPollAnswers(
    mapKey: string,
    pending: PendingPollQuestion,
    answererActorJid?: string,
  ): Promise<void> {
    // Format the answer as structured context for Claude.
    const lines = ['[User answered poll]'];
    pending.questions.forEach((q, index) => {
      const a = pending.answersCollected[index] ?? '(no answer)';
      lines.push(`Q: ${q.question}`);
      if (a.includes('\n')) {
        lines.push('A:');
        lines.push(a);
      } else {
        lines.push(`A: ${a}`);
      }
      lines.push('');
    });
    const answerText = lines.join('\n').trim();

    // A fast vote can arrive before the provider emits the terminal result for
    // the AskUser turn. Wait for that exact logical owner to finish before even
    // reserving the continuation lease; otherwise the old result can consume
    // the new lease or the one-flight provider guard can drop the answer.
    try {
      const sourceBarrier = this.host.pendingPollSourceTurnBarriers.get(pending);
      if (sourceBarrier) {
        await sourceBarrier;
      } else {
        const sourceSession = this.host.chatSessions.get(mapKey);
        if (sourceSession) await sourceSession.waitForProviderTurnToTerminalize();
      }

      // An explicit reset/replacement cancels the staged continuation.
      if (this.host.pendingPolls.questions.get(mapKey) !== pending) return;

      // Remove only the in-memory interceptor before sending. The SQLite row
      // remains until provider-boundary acceptance is proven.
      if (!this.detachPendingPollContinuation(mapKey, pending)) return;

      // Route through sendTurnPerChat for proper lifecycle handling.
      // Poll bridge is per_chat only — shared mode guard in handleEvent prevents
      // pendingPolls.questions from being populated in shared mode.
      const pollSession = this.host.chatSessions.get(mapKey);
      if (!pollSession) throw new Error('Cannot inject poll answers without a current session');
      const pollLease = this.host.markSystemTurn(
        pollSession,
        mapKey,
        'poll_answer_continuation',
        pending.chatJid,
      );
      try {
        await this.host.sendTurnPerChat(
          pending.chatJid,
          answerText,
          mapKey,
          answererActorJid,
          undefined,
          undefined,
          pollLease,
        );
      } catch (err) {
        await this.host.settleFailedSystemTurnDispatch(pollSession, mapKey, pollLease, err);
        throw err;
      }

      // A newer poll may already own the same mapKey/row. Never delete it.
      if (!this.host.pendingPolls.questions.has(mapKey)) this.host.pollPersistence.remove(mapKey);
      log.info({ mapKey, chatJid: pending.chatJid, questionCount: pending.questions.length }, 'poll answers injected');
    } catch (err) {
      this.abandonPendingPollContinuation(mapKey, pending, err);
      throw err;
    }
  }
}
