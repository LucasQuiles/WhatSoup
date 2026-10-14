// #3295 slice S3: the drain that dispatches deferred-turn obligations.
//
// Obligations enter the store behind the same default-OFF
// `deferredTurnAdmission` flag from three pre-dispatch sources: S2 (a follower
// blocked solely by same-scope durable recovery), #3703 (a turn a planned stop
// took before it reached the provider, cause `planned_stop`) and S3 FIFO (live
// input behind an older runnable obligation of the same chat). The flag is
// read live: OFF stops new claims and dispatch commits; existing rows stay
// durable and visible.
//
// One pass, per per_chat conversation queue head (store FIFO):
//   - skip while a same-scope durable recovery blocks the conversation;
//   - claim (fenced), revalidate that the source inbound is still open, then
//     admit the turn to the chat's ordinary TurnQueue — the same FIFO, fencing
//     and planned-stop rules as live input (RuntimeTurnCoordinator);
//   - the coordinator calls `commit` at the provider boundary, BEFORE the turn
//     is published or sent: a stale fence throws there, nothing is published
//     and the provider is never called;
//   - a turn that never reached the provider is released back to its
//     obligation (fenced requeue, bounded by the store's attempt limit, then
//     quarantined and the source failed honestly). An operator cancellation
//     closes the obligation without a fence: it always wins over a claim. A
//     claim that lapsed while the turn waited and that nobody re-claimed is
//     restored to this claimant before the release decides, so neither a
//     cancellation nor an exhausted attempt is swallowed into a replay;
//   - every closure the drain makes itself settles or explicitly retains the
//     source: an open source of a closed obligation is failed
//     (`pre_dispatch_error`); a source another owner already settled is
//     left as it is (never relabelled completed);
//   - after the commit nothing is ever requeued: the ordinary terminal path
//     owns the turn and the obligation closes once the source is terminal
//     (`terminal_completed`, or `terminal_quarantined` / `source_failed`).
// The drain renews the claim of every turn it still has in a chat queue on
// each pass (before the expiry sweep), so a turn waiting longer than the claim
// TTL keeps its claim: it is neither replayed nor overtaken by live input. An
// exhausted head (no attempts left, e.g. a dead process's last claim expired)
// is closed so it never blocks its chat.
// Runs at start, after a dispatch made progress, on request (FIFO deferral of
// live input) and on a slow backstop timer (lost signals, cleared blockers,
// spaced retries).
//
// Logs are content-free: error class names and bounded tags only — no raw
// error, obligation id, inbound sequence or envelope field.

import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../../logger.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import {
  DEFERRED_TURN_MAX_ATTEMPTS,
  DeferredTurnClaimFenceError,
  type DeferredTurnClaimFence,
  type DeferredTurnClosedSource,
  type DeferredTurnObligation,
  type DeferredTurnOpenHead,
  type DeferredTurnStore,
} from '../../core/deferred-turn-store.ts';
import type {
  DeferredTurnDispatch,
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
 * A claim must outlive the wait from claim to provider boundary (queue wait,
 * session spawn, dispatch barriers); a claim lost to expiry is refused at commit.
 */
export const DEFERRED_TURN_CLAIM_TTL_SECONDS = 600;

const DRAIN_SCOPE = 'per_chat';

/** Content-free error label: the class name only, never the message. */
function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.name : 'non-error';
}

/** The drain refused the dispatch commit (flag turned off, or the runtime is stopping). */
export class DeferredTurnDispatchRefusedError extends Error {
  constructor() {
    super('Deferred turn dispatch refused: the drain is disabled or stopping');
    this.name = 'DeferredTurnDispatchRefusedError';
  }
}

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
  readonly requireSessionToolScopeKey: (session: SessionManager) => string;
  /** Register `dispatch` for the turn and admit it to the chat's TurnQueue. */
  readonly enqueueTurn: (mapKey: string, turn: QueuedTurn, dispatch: DeferredTurnDispatch) => boolean;
  readonly scanIntervalMs?: number;
}

export class DeferredTurnDrain {
  private readonly deps: DeferredTurnDrainDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pass: Promise<void> | null = null;
  private rescan = false;
  private stopped = true;
  /**
   * Conversations with a drained turn in their TurnQueue (one per drain queue),
   * with the claim each pass renews until the turn commits or is released.
   */
  private readonly inFlight = new Map<string, { readonly id: number; readonly fence: DeferredTurnClaimFence }>();

  constructor(deps: DeferredTurnDrainDeps) {
    this.deps = deps;
  }

  /** Idempotent. The first pass runs on a timer turn, never inside the caller. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** No new pass, claim or dispatch commit after this returns. */
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
      .catch((err: unknown) => log.error({ errorClass: errorClassOf(err) }, 'deferred-turn drain pass failed'))
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
    // Live claims first: a turn still waiting in its chat queue keeps its claim
    // (a committed or released one is no longer claimed, so this is a no-op).
    for (const { id, fence } of this.inFlight.values()) {
      store.renewClaim(id, fence, DEFERRED_TURN_CLAIM_TTL_SECONDS);
    }
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
      if (head.status !== 'pending') continue;
      if (head.attemptCount >= DEFERRED_TURN_MAX_ATTEMPTS) {
        // Nothing may claim it again: close it (and fail its open source) so
        // the obligations queued behind it can run.
        const closed = store.terminalizeExhaustedHead(head.id);
        if (closed !== null) {
          this.failOpenSource(durability, closed);
          log.warn({ reason: 'attempts_exhausted' }, 'deferred turn quarantined: exhausted head closed before dispatch');
          this.rescan = true;
        }
        continue;
      }
      this.claimAndEnqueue(head, durability, store);
    }
  }

  /**
   * A drain-owned closure of a never-dispatched obligation: if its source is
   * still open, nothing else owns it, so fail it honestly (`pre_dispatch_error`).
   * A source another owner already settled keeps its own terminal state.
   */
  private failOpenSource(durability: DurabilityEngine, source: DeferredTurnClosedSource): void {
    if (!durability.deferredTurns.isSourceOpen(source.inboundSeq)) return;
    if (!durability.markInboundFailedIfProcessing(
      source.inboundSeq, source.sourceMessageId, source.deliveryJid, 'pre_dispatch_error',
    )) {
      log.warn({ reason: 'source_not_processing' }, 'deferred turn source could not be failed — left with its current owner');
    }
  }

  private claimAndEnqueue(
    head: DeferredTurnOpenHead,
    durability: DurabilityEngine,
    store: DeferredTurnStore,
  ): void {
    // Blockers first, without a claim: a blocked head costs no attempt.
    if (durability.hasOutstandingTurnRecoveryForScope(DRAIN_SCOPE, head.conversationKey)) return;
    const target = this.deps.prepareTarget(head.deliveryJid);
    if (!target) return;
    const claimToken = `deferred-drain:${randomUUID()}`;
    const obligation = store.claimNextEligible(DRAIN_SCOPE, {
      conversationKey: head.conversationKey,
      claimToken,
      ttlSeconds: DEFERRED_TURN_CLAIM_TTL_SECONDS,
    });
    // Another drain (a concurrent process) won the head, or it moved.
    if (!obligation) return;
    const fence: DeferredTurnClaimFence = { claimToken, claimEpoch: obligation.claimEpoch };
    const dispatch = this.createDispatch(obligation, fence, store);
    if (!store.isSourceOpen(obligation.inboundSeq)) {
      // Another owner settled the inbound (its own terminal state stands):
      // nothing is owed by this lane and nothing is written to the source.
      store.terminalizeQuarantined(obligation.id, fence, 'source_not_open');
      this.rescan = true;
      return;
    }
    if (obligation.contentType !== 'text' || obligation.deliveryJid === '' || obligation.text.trim() === '') {
      // Never dispatchable: close the obligation and fail its open source.
      store.terminalizeQuarantined(obligation.id, fence, 'unsupported_envelope');
      this.failOpenSource(durability, obligation);
      this.rescan = true;
      return;
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
        inboundSeq: obligation.inboundSeq,
        source,
        session: target.session,
        toolScopeKey: this.deps.requireSessionToolScopeKey(target.session),
        mapKey: target.mapKey,
      });
    } catch (err) {
      log.warn({ errorClass: errorClassOf(err) }, 'deferred turn context construction failed');
      runtimeContext = null;
    }
    // A pre-boundary retry waits for the backstop timer: retries are spaced, not spun.
    if (!runtimeContext) {
      // `terminal`: attempts spent — the drain owns the source (no runtime turn exists).
      if (dispatch.release('context_unavailable') === 'terminal') this.failOpenSource(durability, obligation);
      return;
    }
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
      inboundSeq: obligation.inboundSeq,
    };
    this.inFlight.set(obligation.conversationKey, { id: obligation.id, fence });
    try {
      // Rejection by the queue releases the turn through the coordinator.
      this.deps.enqueueTurn(target.mapKey, turn, dispatch);
    } catch (err) {
      log.warn({ errorClass: errorClassOf(err) }, 'deferred turn queue admission failed');
      // `terminal`: attempts spent — the turn never ran, so the drain owns the source.
      if (dispatch.release('enqueue_failed') === 'terminal') this.failOpenSource(durability, obligation);
    }
  }

  /** The obligation's side of one drained turn (see DeferredTurnDispatch). */
  private createDispatch(
    obligation: DeferredTurnObligation,
    fence: DeferredTurnClaimFence,
    store: DeferredTurnStore,
  ): DeferredTurnDispatch {
    const { id, inboundSeq, conversationKey } = obligation;
    let closed = false;
    const close = (): boolean => {
      if (closed) return false;
      closed = true;
      this.inFlight.delete(conversationKey);
      return true;
    };
    return {
      commit: () => {
        if (closed || !this.canDispatch()) throw new DeferredTurnDispatchRefusedError();
        // The point of no return, durably written before publication and the
        // provider send. A stale fence throws here.
        store.markDispatchCommit(id, fence);
        log.info({ attempt: obligation.attemptCount }, 'deferred turn dispatch committed (#3295 S3)');
      },
      release: (errorClass) => {
        if (!close()) return 'retained';
        if (errorClass === 'operator_cancelled') {
          // Unfenced pre-commit close: a cancellation always wins over a claim
          // (stale or live), so the cancelled text is never replayed. The
          // ordinary undispatched terminal path then fails the source; if this
          // write fails, that closed source still keeps the drain from replaying.
          try {
            store.quarantinePreCommitForSource(inboundSeq, 'operator_cancelled');
          } catch (err) {
            log.warn({ errorClass: errorClassOf(err) }, 'deferred turn cancellation could not close its obligation');
          }
          return 'terminal';
        }
        const decide = (): 'retained' | 'terminal' => {
          if (!store.isSourceOpen(inboundSeq)) {
            store.terminalizeQuarantined(id, fence, 'source_settled_without_dispatch');
            return 'retained';
          }
          if (obligation.attemptCount >= DEFERRED_TURN_MAX_ATTEMPTS) {
            store.terminalizeQuarantined(id, fence, 'attempts_exhausted');
            log.warn({ errorClass }, 'deferred turn quarantined: attempts exhausted before dispatch');
            return 'terminal';
          }
          store.requeueClaim(id, fence, errorClass);
          log.info({ errorClass }, 'deferred turn returned to its obligation before the provider boundary');
          return 'retained';
        };
        try {
          try {
            return decide();
          } catch (err) {
            if (!(err instanceof DeferredTurnClaimFenceError)) throw err;
          }
          // Stale fence: the claim lapsed while the turn waited. If nobody
          // re-claimed it (same epoch) it is still this claimant's to decide.
          if (store.restoreLapsedClaim(id, fence, DEFERRED_TURN_CLAIM_TTL_SECONDS)) return decide();
          // Another owner closed it: the obligation no longer owns an open
          // source, so the ordinary terminal path does. Otherwise another
          // claimant holds it and owns the source.
          const outcome = store.isTerminal(id) && store.isSourceOpen(inboundSeq) ? 'terminal' : 'retained';
          log.warn({ outcome }, 'deferred turn release found the obligation with another owner');
          return outcome;
        } catch (err) {
          // Not an ownership change (e.g. a storage fault): the claim stays and
          // its expiry returns the obligation for a counted retry.
          log.warn({ errorClass: errorClassOf(err) }, 'deferred turn release failed — the claim expires into a counted retry');
          return 'retained';
        }
      },
      settle: () => {
        close();
        // Held (replay vetoed) until the source inbound is terminal; a later
        // pass settles it if the terminal lands after the turn.
        if (store.settleDispatchedObligation(id) !== null) this.kick();
      },
    };
  }
}
