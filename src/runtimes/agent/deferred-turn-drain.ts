// #3295 slice S3: the drain that dispatches deferred-turn obligations.
//
// Obligations enter the store from two pre-dispatch sources behind the same
// default-OFF `deferredTurnAdmission` flag: S2 (a follower blocked solely by
// same-scope durable recovery) and #3703 (a queued turn a planned stop took
// before it reached the provider). The flag is read live: OFF stops new
// claims and dispatch authorizations; existing rows stay durable and visible.
//
// One pass, per per_chat conversation queue head (store FIFO):
//   - skip while a same-scope durable recovery blocks the conversation or the
//     chat lane is busy (both are re-checked at admission);
//   - claim (fenced), revalidate the source inbound is still open, then
//     dispatch through the ordinary per-chat pipeline (processPerChatTurn),
//     the same route turn-recovery replay uses;
//   - write `dispatched_commit` at the provider boundary, BEFORE the send. A
//     stale fence throws there, so the provider is never called;
//   - before that boundary a failure requeues (bounded by the store's
//     attempt limit, then quarantined); after it nothing is ever requeued —
//     the ordinary terminal path owns the turn and the obligation is closed
//     once the source inbound is terminal.
// Runs at start, after each dispatch that made progress, and on a slow
// backstop timer (lost signals, cleared blockers, spaced retries). No content
// is logged.

import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../../logger.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import {
  DEFERRED_TURN_MAX_ATTEMPTS,
  type DeferredTurnClaimFence,
  type DeferredTurnObligation,
  type DeferredTurnOpenHead,
  type DeferredTurnStore,
} from '../../core/deferred-turn-store.ts';
import type {
  PerChatRuntimeScopeRef,
  RuntimeTurnCoordinator,
  RuntimeTurnSourceSnapshot,
} from './runtime-turn-coordinator.ts';
import type { SessionManager } from './session.ts';
import type { QueuedTurn } from './turn-queue.ts';
import { recoveryPurpose } from './turn-recovery-dispatch.ts';

const log = createChildLogger('deferred-turn-drain');

/** Backstop scan cadence (matches the turn-recovery supervisor). */
export const DEFERRED_TURN_DRAIN_INTERVAL_MS = 15_000;
/**
 * A claim must outlive the wait from claim to provider boundary (session
 * spawn, dispatch barriers); a claim lost to expiry is refused at commit.
 */
export const DEFERRED_TURN_CLAIM_TTL_SECONDS = 600;

const DRAIN_SCOPE = 'per_chat';

export interface DeferredTurnDrainTarget {
  readonly mapKey: string;
  readonly session: SessionManager;
}

export interface DeferredTurnDrainDeps {
  /** Live read of the deferredTurnAdmission flag (kill switch). */
  readonly enabled: () => boolean;
  readonly getDurability: () => DurabilityEngine | null;
  readonly isShuttingDown: () => boolean;
  readonly coordinator: RuntimeTurnCoordinator;
  /** The chat's owned per-chat session, created as live admission would. */
  readonly prepareTarget: (deliveryJid: string) => DeferredTurnDrainTarget | null;
  readonly isTargetCurrent: (target: DeferredTurnDrainTarget) => boolean;
  /** True while the chat lane holds or queues a turn. */
  readonly isChatBusy: (mapKey: string) => boolean;
  readonly requireSessionToolScopeKey: (session: SessionManager) => string;
  readonly scanIntervalMs?: number;
}

export class DeferredTurnDrain {
  private readonly deps: DeferredTurnDrainDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pass: Promise<void> | null = null;
  private rescan = false;
  private stopped = true;
  /** Dispatches in flight, keyed by conversation: one per drain queue. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: DeferredTurnDrainDeps) {
    this.deps = deps;
  }

  /** Idempotent. The first pass runs on a timer turn, never inside the caller. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** No new pass, claim or dispatch authorization after this returns. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Request a pass now (coalesced with one in flight). */
  kick(): void {
    if (this.stopped) return;
    if (this.pass) {
      this.rescan = true;
      return;
    }
    this.pass = this.runPass()
      .catch((err: unknown) => log.error({ err }, 'deferred-turn drain pass failed'))
      .finally(() => {
        this.pass = null;
        if (this.rescan) {
          this.rescan = false;
          this.kick();
        }
      });
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
      this.schedule(this.deps.scanIntervalMs ?? DEFERRED_TURN_DRAIN_INTERVAL_MS);
    }, delayMs);
    this.timer.unref?.();
  }

  private canDispatch(): boolean {
    return !this.stopped && !this.deps.isShuttingDown() && this.deps.enabled();
  }

  private async runPass(): Promise<void> {
    if (!this.canDispatch()) return;
    const durability = this.deps.getDurability();
    if (!durability) return;
    const store = durability.deferredTurns;
    store.expireStaleClaims(DRAIN_SCOPE);
    for (const head of store.listOpenHeads(DRAIN_SCOPE)) {
      if (!this.canDispatch()) return;
      if (this.inFlight.has(head.conversationKey)) continue;
      if (head.status === 'dispatched_commit') {
        // Held: replay vetoed. Closed once the source inbound is terminal,
        // which unblocks the next obligation of this conversation.
        if (store.settleDispatchedObligation(head.id) !== null) this.rescan = true;
        continue;
      }
      if (head.status !== 'pending' || head.attemptCount >= DEFERRED_TURN_MAX_ATTEMPTS) continue;
      this.claimAndDispatch(head, durability, store);
    }
  }

  private claimAndDispatch(
    head: DeferredTurnOpenHead,
    durability: DurabilityEngine,
    store: DeferredTurnStore,
  ): void {
    // Blockers first, without a claim: a blocked head costs no attempt.
    if (durability.hasOutstandingTurnRecoveryForScope(DRAIN_SCOPE, head.conversationKey)) return;
    const target = this.deps.prepareTarget(head.deliveryJid);
    if (!target || this.deps.isChatBusy(target.mapKey)) return;
    const claimToken = `deferred-drain:${randomUUID()}`;
    const obligation = store.claimNextEligible(DRAIN_SCOPE, {
      conversationKey: head.conversationKey,
      claimToken,
      ttlSeconds: DEFERRED_TURN_CLAIM_TTL_SECONDS,
    });
    // Another drain (a concurrent process) won the head, or it moved.
    if (!obligation) return;
    const fence: DeferredTurnClaimFence = { claimToken, claimEpoch: obligation.claimEpoch };
    // A dispatch that made progress re-scans at once (the next obligation of
    // this conversation, or of a chat it was holding back). A pre-boundary
    // retry waits for the backstop timer, so retries are spaced, not spun.
    const dispatch = this.dispatchClaimed(obligation, fence, target, store)
      .catch((err: unknown) => {
        log.error({ err, obligationId: obligation.id }, 'deferred-turn dispatch bookkeeping failed');
        return false;
      })
      .then((progressed) => {
        this.inFlight.delete(head.conversationKey);
        if (progressed) this.kick();
      });
    this.inFlight.set(head.conversationKey, dispatch);
  }

  private async dispatchClaimed(
    obligation: DeferredTurnObligation,
    fence: DeferredTurnClaimFence,
    target: DeferredTurnDrainTarget,
    store: DeferredTurnStore,
  ): Promise<boolean> {
    const { id, inboundSeq } = obligation;
    /** Pre-boundary failure: requeue, or quarantine once attempts are spent. */
    const retryOrExhaust = (errorClass: string): boolean => {
      if (obligation.attemptCount >= DEFERRED_TURN_MAX_ATTEMPTS) {
        store.terminalizeQuarantined(id, fence, 'attempts_exhausted');
        log.warn({ obligationId: id, inboundSeq, errorClass }, 'deferred turn quarantined: attempts exhausted before dispatch');
        return true;
      }
      store.requeueClaim(id, fence, errorClass);
      return false;
    };
    if (!store.isSourceOpen(inboundSeq)) {
      // Another owner settled the inbound: nothing is owed by this lane.
      store.terminalizeQuarantined(id, fence, 'source_not_open');
      return true;
    }
    if (obligation.contentType !== 'text' || obligation.deliveryJid === '' || obligation.text.trim() === '') {
      store.terminalizeQuarantined(id, fence, 'unsupported_envelope');
      return true;
    }
    const source: RuntimeTurnSourceSnapshot = {
      sourceMessageId: obligation.sourceMessageId,
      receivedAtUnixSeconds: obligation.receivedAtUnixSeconds,
      conversationKey: obligation.conversationKey,
      senderJid: obligation.senderJid,
      senderName: obligation.senderName,
      contentType: 'text',
      isGroup: obligation.isGroup,
      ...(obligation.isGroup ? { groupName: obligation.groupName ?? obligation.deliveryJid } : {}),
    };
    let runtimeContext;
    try {
      runtimeContext = this.deps.coordinator.createRuntimeTurnForDispatch({
        scope: DRAIN_SCOPE,
        chatJid: obligation.deliveryJid,
        text: obligation.text,
        inboundSeq,
        source,
        session: target.session,
        toolScopeKey: this.deps.requireSessionToolScopeKey(target.session),
        mapKey: target.mapKey,
      });
    } catch (err) {
      log.warn({ err, obligationId: id }, 'deferred turn context construction failed');
      runtimeContext = null;
    }
    if (!runtimeContext) return retryOrExhaust('context_unavailable');
    const turn: QueuedTurn = {
      sourceMessageId: source.sourceMessageId,
      receivedAtUnixSeconds: source.receivedAtUnixSeconds,
      conversationKey: source.conversationKey,
      chatJid: obligation.deliveryJid,
      senderJid: source.senderJid,
      senderName: source.senderName,
      text: obligation.text,
      isGroup: source.isGroup,
      groupName: source.groupName,
      contentType: 'text',
      purpose: recoveryPurpose(obligation.sourceMessageId),
      runtimeContext,
      inboundSeq,
    };
    const scopeRef: PerChatRuntimeScopeRef = { value: target.mapKey };
    let boundaryEntered = false;
    let committed = false;
    try {
      await this.deps.coordinator.processPerChatTurn(
        scopeRef,
        turn,
        undefined,
        () => this.canDispatch() && this.deps.isTargetCurrent(target),
        () => {
          boundaryEntered = true;
          // The point of no return, durably written before the provider send.
          // A stale fence throws here and the provider is not called.
          store.markDispatchCommit(id, fence);
          committed = true;
          log.info({ obligationId: id, inboundSeq }, 'deferred turn dispatch committed (#3295 S3)');
        },
      );
    } catch (err) {
      if (boundaryEntered) {
        // The turn was published at the boundary: the ordinary processor-error
        // finalizer owns it. Never requeued.
        log.warn({ err, obligationId: id, committed }, 'deferred turn failed at or after the provider boundary');
        await this.deps.coordinator.finalizePerChatProcessorError(target.mapKey, turn, err);
        if (committed) store.settleDispatchedObligation(id);
        return true;
      }
      log.warn({ err, obligationId: id }, 'deferred turn dispatch failed before the provider boundary');
      return retryOrExhaust('dispatch_failed');
    }
    if (!boundaryEntered) {
      // Cancelled before the boundary, or consumed without a provider turn.
      if (store.isSourceOpen(inboundSeq)) return retryOrExhaust('dispatch_cancelled');
      store.terminalizeQuarantined(id, fence, 'source_settled_without_dispatch');
      return true;
    }
    // Held (replay vetoed) until the source inbound is terminal; a later pass
    // settles it if the terminal lands after the turn promise.
    store.settleDispatchedObligation(id);
    return true;
  }
}
