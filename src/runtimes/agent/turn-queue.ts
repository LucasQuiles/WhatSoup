// src/runtimes/agent/turn-queue.ts
// Global FIFO turn queue — serializes turns to Claude Code one at a time.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createChildLogger } from '../../logger.ts';
import type { ContentType } from '../../core/types.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';
import type { SessionContext } from '../../mcp/types.ts';

const log = createChildLogger('turn-queue');

export interface QueuedTurn {
  /** Stable journal/source message id captured at admission; never reconstructed at result time. */
  sourceMessageId: string;
  /** Immutable original journal receipt time, in Unix epoch seconds. */
  receivedAtUnixSeconds: number;
  /** Exact conversation key used when the inbound row was journaled. */
  conversationKey: string;
  chatJid: string;
  senderJid: string;
  senderName: string | null;
  text: string;
  isGroup: boolean;
  groupName?: string;
  contentType: ContentType;
  /** Authorization purpose captured from the admitted turn. */
  purpose?: SessionContext['purpose'];
  /** Immutable journal-backed context minted at admission for user turns. */
  runtimeContext?: RuntimeTurnContext;
  /** durability: inbound_events.seq for this turn — threaded to outbound ops */
  inboundSeq?: number;
  /** Called after this exact turn reaches a terminal queue outcome. */
  onSettled?: () => void;
}

type QueuedAsyncContext = ReturnType<typeof AsyncLocalStorage.snapshot>;

interface QueuedTurnAdmission {
  readonly context: QueuedAsyncContext;
}

// An object can represent only one live queue admission. Context stays in the
// owning queue; callers cannot prepopulate or overwrite it.
const activeQueuedTurns = new WeakSet<QueuedTurn>();

/**
 * Distinct admission-rejection reasons (#1750). Threaded through onReject so
 * the finalizer can stamp a distinct failure_class rather than collapsing every
 * reject to 'unknown'. The names are a subset of core AdmissionRejectClass.
 */
export type TurnRejectReason =
  | 'queue_closed'
  | 'queue_halted'
  | 'queue_full'
  | 'scope_blocked_recovery';

type TurnRejectHandler =
  | ((turn: QueuedTurn, reason: TurnRejectReason) => void)
  | ((turn: QueuedTurn, reason: TurnRejectReason) => Promise<void>);

export interface TurnQueueOpts {
  maxDepth?: number;
  onReject?: TurnRejectHandler;
  onProcessorError?: (turn: QueuedTurn, error: unknown) => void | Promise<void>;
  onHalt?: () => void;
}

export interface TurnQueueTeardownReceipt {
  readonly pending: readonly QueuedTurn[];
  readonly closeEpoch: number;
  readonly wasAccepting: boolean;
}

export class TurnQueue {
  private queue: QueuedTurn[] = [];
  private readonly queuedTurnAdmissions = new WeakMap<QueuedTurn, QueuedTurnAdmission>();
  private processing = false;
  private active: QueuedTurn | null = null;
  private processor: ((turn: QueuedTurn) => Promise<void>) | null = null;
  private accepting = true;
  private closeEpoch = 0;
  private activeTeardownReceipt: TurnQueueTeardownReceipt | null = null;
  private halted = false;
  private haltError: unknown;
  private readonly maxDepth: number;
  private readonly onReject?: TurnRejectHandler;
  private readonly onProcessorError?: (turn: QueuedTurn, error: unknown) => void | Promise<void>;
  private readonly onHalt?: () => void;

  constructor(opts?: TurnQueueOpts) {
    this.maxDepth = opts?.maxDepth ?? Infinity;
    this.onReject = opts?.onReject;
    this.onProcessorError = opts?.onProcessorError;
    this.onHalt = opts?.onHalt;
  }

  setProcessor(fn: (turn: QueuedTurn) => Promise<void>): void {
    this.processor = fn;
    // Drain in case items were enqueued before the processor was set.
    if (!this.halted) void this.drain();
  }

  enqueue(turn: QueuedTurn): boolean {
    if (activeQueuedTurns.has(turn)) {
      log.error({ chatJid: turn.chatJid }, 'turn rejected — queued turn object already has a live admission');
      return false;
    }
    this.captureQueuedAsyncContext(turn);
    if (!this.accepting) {
      log.warn({ chatJid: turn.chatJid }, 'turn rejected — queue admissions are closed');
      this.rejectAndSettle(turn, 'queue_closed');
      return false;
    }
    if (this.halted) {
      log.error({ chatJid: turn.chatJid }, 'turn rejected — queue is halted after finalization failure');
      this.rejectAndSettle(turn, 'queue_halted');
      return false;
    }
    if (this.queue.length >= this.maxDepth) {
      log.warn({ chatJid: turn.chatJid, maxDepth: this.maxDepth, pending: this.queue.length },
        'turn rejected — queue depth cap reached');
      this.rejectAndSettle(turn, 'queue_full');
      return false;
    }
    this.queue.push(turn);
    void this.drain();
    return true;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Count queued turns for a specific chat. */
  pendingForChat(chatJid: string): number {
    return this.queue.filter((t) => t.chatJid === chatJid).length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  get activeTurn(): QueuedTurn | null {
    return this.active;
  }

  closeAndTakePendingTurns(): QueuedTurn[] {
    if (this.activeTeardownReceipt) {
      throw new Error('Cannot close TurnQueue while a teardown transaction is active');
    }
    this.accepting = false;
    this.closeEpoch += 1;
    const pending = this.queue.splice(0);
    for (const turn of pending) this.releaseQueuedTurnAdmission(turn);
    return pending;
  }

  haltAndTakePendingTurns(error: unknown): QueuedTurn[] {
    // Latch the queue before checking teardown ownership. If a teardown owns
    // the pending turns, its later rollback may restore them, but it must not
    // be able to reopen and dispatch work after the external failure became
    // sticky.
    this.halt(error);
    return this.closeAndTakePendingTurns();
  }

  beginTeardown(): TurnQueueTeardownReceipt {
    if (this.activeTeardownReceipt) {
      throw new Error('Cannot overlap TurnQueue teardown transactions');
    }
    const receipt: TurnQueueTeardownReceipt = Object.freeze({
      pending: Object.freeze(this.queue.splice(0)),
      closeEpoch: ++this.closeEpoch,
      wasAccepting: this.accepting,
    });
    this.accepting = false;
    this.activeTeardownReceipt = receipt;
    return receipt;
  }

  commitTeardown(receipt: TurnQueueTeardownReceipt): void {
    if (this.activeTeardownReceipt !== receipt || this.closeEpoch !== receipt.closeEpoch) {
      throw new Error('TurnQueue teardown receipt is stale or already consumed');
    }
    this.activeTeardownReceipt = null;
    for (const turn of receipt.pending) this.releaseQueuedTurnAdmission(turn);
  }

  rollbackFailedTeardown(
    receipt: TurnQueueTeardownReceipt,
    unresolved: readonly QueuedTurn[],
    exactQueueOwned = true,
  ): boolean {
    if (
      this.activeTeardownReceipt !== receipt
      || this.closeEpoch !== receipt.closeEpoch
      || !exactQueueOwned
    ) {
      throw new Error('TurnQueue teardown receipt is stale or already consumed');
    }
    const unresolvedCounts = new Map<QueuedTurn, number>();
    for (const turn of unresolved) {
      unresolvedCounts.set(turn, (unresolvedCounts.get(turn) ?? 0) + 1);
    }
    const restored: QueuedTurn[] = [];
    for (const turn of receipt.pending) {
      const count = unresolvedCounts.get(turn) ?? 0;
      if (count === 0) continue;
      restored.push(turn);
      if (count === 1) unresolvedCounts.delete(turn);
      else unresolvedCounts.set(turn, count - 1);
    }
    if (unresolvedCounts.size > 0 || restored.length !== unresolved.length) {
      throw new Error('TurnQueue teardown rollback contains a turn outside its receipt');
    }
    if (restored.some((turn) => this.active === turn || this.queue.includes(turn))) {
      throw new Error('TurnQueue teardown rollback would duplicate an owned turn');
    }
    this.activeTeardownReceipt = null;
    const restoredTurns = new Set(restored);
    for (const turn of receipt.pending) {
      if (!restoredTurns.has(turn)) this.releaseQueuedTurnAdmission(turn);
    }
    this.queue.unshift(...restored);

    const reopened = (
      receipt.wasAccepting
      && this.closeEpoch === receipt.closeEpoch
    );
    if (reopened) {
      this.accepting = true;
      if (!this.halted) void this.drain();
    }
    return reopened;
  }

  async awaitRetirementQuiescence(): Promise<void> {
    while (this.processing) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    if (this.active !== null || this.queue.length > 0) {
      throw new Error('Cannot retire a non-empty TurnQueue');
    }
  }

  get haltedError(): unknown {
    return this.halted ? this.haltError : undefined;
  }

  get isHalted(): boolean {
    return this.halted;
  }

  /**
   * Returns a Promise that resolves when the queue is empty and no turn is
   * being processed. Useful in tests to await full drain.
   */
  async idle(): Promise<void> {
    if (!this.processing) {
      if (this.halted) throw this.haltError;
      if (this.queue.length === 0) return;
    }
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (!this.processing && this.halted) {
          reject(this.haltError);
        } else if (!this.processing && this.queue.length === 0) {
          resolve();
        } else {
          setTimeout(check, 1);
        }
      };
      setTimeout(check, 1);
    });
  }

  private async drain(): Promise<void> {
    if (this.processing || !this.processor) return;
    // Set processing=true synchronously before any await — prevents concurrent
    // drain invocations from all entering the loop when enqueues happen in burst.
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift()!;
        this.active = turn;
        const continueDraining = await this.runInQueuedAsyncContext(
          turn,
          () => this.processQueuedTurn(turn),
        );
        if (!continueDraining) break;
      }
    } finally {
      this.processing = false;
    }
  }

  private halt(error: unknown): void {
    if (this.halted) return;
    this.halted = true;
    this.haltError = error;
    this.onHalt?.();
  }

  private captureQueuedAsyncContext(turn: QueuedTurn): void {
    this.queuedTurnAdmissions.set(turn, Object.freeze({ context: AsyncLocalStorage.snapshot() }));
    activeQueuedTurns.add(turn);
  }

  private runInQueuedAsyncContext<T>(turn: QueuedTurn, work: () => T): T {
    const admission = this.queuedTurnAdmissions.get(turn);
    if (!admission) throw new Error('Queued turn is missing its admission context');
    return admission.context(work);
  }

  private releaseQueuedTurnAdmission(turn: QueuedTurn): void {
    this.queuedTurnAdmissions.delete(turn);
    activeQueuedTurns.delete(turn);
  }

  private rejectAndSettle(turn: QueuedTurn, reason: TurnRejectReason): void {
    this.runInQueuedAsyncContext(turn, () => {
      try {
        const finalization = this.onReject?.(turn, reason);
        const completion = finalization as Promise<void> | undefined;
        if (completion && typeof completion.then === 'function') {
          void completion.then(
            () => this.runInQueuedAsyncContext(turn, () => this.settle(turn)),
            (error: unknown) => this.runInQueuedAsyncContext(
              turn,
              () => this.haltRejectedFinalization(turn, reason, error),
            ),
          ).catch((error: unknown) => this.haltRejectedFinalization(turn, reason, error));
          return;
        }
        this.settle(turn);
      } catch (error) {
        this.haltRejectedFinalization(turn, reason, error);
        throw error;
      }
    });
  }

  private haltRejectedFinalization(turn: QueuedTurn, reason: TurnRejectReason, error: unknown): void {
    try {
      this.halt(error);
    } catch (haltError) {
      log.error(
        { err: haltError, finalizationError: error, chatJid: turn.chatJid, reason },
        'turn rejection finalization failed and queue halt callback threw',
      );
    }
    log.error(
      { err: error, chatJid: turn.chatJid, reason },
      'turn rejection finalization failed — queue halted without settlement',
    );
  }

  private async processQueuedTurn(turn: QueuedTurn): Promise<boolean> {
    try {
      await this.processor!(turn);
    } catch (err) {
      log.warn({ err, chatJid: turn.chatJid }, 'turn processor error — finalizing before queue advance');
      if (!this.onProcessorError) {
        this.halt(err);
        log.error(
          { err, chatJid: turn.chatJid },
          'turn processor has no failure finalizer — queue halted',
        );
        return false;
      }
      try {
        await this.onProcessorError(turn, err);
      } catch (finalizationError) {
        this.halt(finalizationError);
        log.error(
          { err: finalizationError, chatJid: turn.chatJid },
          'turn processor finalization failed — queue halted',
        );
        return false;
      }
    } finally {
      if (this.active === turn) this.active = null;
      this.settle(turn);
    }
    return true;
  }

  private settle(turn: QueuedTurn): void {
    try {
      turn.onSettled?.();
    } catch (err) {
      log.warn({ err, chatJid: turn.chatJid }, 'turn settlement callback threw');
    } finally {
      // A later admission of the same object is a new turn and must capture
      // that admission's context instead of retaining the prior snapshot.
      this.releaseQueuedTurnAdmission(turn);
    }
  }
}
