// src/runtimes/agent/turn-queue.ts
// Global FIFO turn queue — serializes turns to Claude Code one at a time.

import { createChildLogger } from '../../logger.ts';
import type { ContentType } from '../../core/types.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';

const log = createChildLogger('turn-queue');

export interface QueuedTurn {
  /** Stable journal/source message id captured at admission; never reconstructed at result time. */
  sourceMessageId: string;
  /** Exact conversation key used when the inbound row was journaled. */
  conversationKey: string;
  chatJid: string;
  senderJid: string;
  senderName: string | null;
  text: string;
  isGroup: boolean;
  groupName?: string;
  contentType: ContentType;
  /** Immutable journal-backed context minted at admission for user turns. */
  runtimeContext?: RuntimeTurnContext;
  /** durability: inbound_events.seq for this turn — threaded to outbound ops */
  inboundSeq?: number;
}

/**
 * Distinct admission-rejection reasons (#1750). Threaded through onReject so
 * the finalizer can stamp a distinct failure_class rather than collapsing every
 * reject to 'unknown'. The names are a subset of core AdmissionRejectClass.
 */
export type TurnRejectReason = 'queue_closed' | 'queue_halted' | 'queue_full';

export interface TurnQueueOpts {
  maxDepth?: number;
  onReject?: (turn: QueuedTurn, reason: TurnRejectReason) => void;
  onProcessorError?: (turn: QueuedTurn, error: unknown) => void | Promise<void>;
}

export class TurnQueue {
  private queue: QueuedTurn[] = [];
  private processing = false;
  private active: QueuedTurn | null = null;
  private processor: ((turn: QueuedTurn) => Promise<void>) | null = null;
  private accepting = true;
  private halted = false;
  private haltError: unknown;
  private readonly maxDepth: number;
  private readonly onReject?: (turn: QueuedTurn, reason: TurnRejectReason) => void;
  private readonly onProcessorError?: (turn: QueuedTurn, error: unknown) => void | Promise<void>;

  constructor(opts?: TurnQueueOpts) {
    this.maxDepth = opts?.maxDepth ?? Infinity;
    this.onReject = opts?.onReject;
    this.onProcessorError = opts?.onProcessorError;
  }

  setProcessor(fn: (turn: QueuedTurn) => Promise<void>): void {
    this.processor = fn;
    // Drain in case items were enqueued before the processor was set.
    if (!this.halted) void this.drain();
  }

  enqueue(turn: QueuedTurn): boolean {
    if (!this.accepting) {
      log.warn({ chatJid: turn.chatJid }, 'turn rejected — queue admissions are closed');
      this.onReject?.(turn, 'queue_closed');
      return false;
    }
    if (this.halted) {
      log.error({ chatJid: turn.chatJid }, 'turn rejected — queue is halted after finalization failure');
      this.onReject?.(turn, 'queue_halted');
      return false;
    }
    if (this.queue.length >= this.maxDepth) {
      log.warn({ chatJid: turn.chatJid, maxDepth: this.maxDepth, pending: this.queue.length },
        'turn rejected — queue depth cap reached');
      this.onReject?.(turn, 'queue_full');
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
    this.accepting = false;
    return this.queue.splice(0);
  }

  get haltedError(): unknown {
    return this.halted ? this.haltError : undefined;
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
        try {
          await this.processor(turn);
        } catch (err) {
          log.warn({ err, chatJid: turn.chatJid }, 'turn processor error — finalizing before queue advance');
          if (!this.onProcessorError) {
            this.halted = true;
            this.haltError = err;
            log.error(
              { err, chatJid: turn.chatJid },
              'turn processor has no failure finalizer — queue halted',
            );
            break;
          }
          try {
            await this.onProcessorError(turn, err);
          } catch (finalizationError) {
            this.halted = true;
            this.haltError = finalizationError;
            log.error(
              { err: finalizationError, chatJid: turn.chatJid },
              'turn processor finalization failed — queue halted',
            );
            break;
          }
        } finally {
          if (this.active === turn) this.active = null;
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
