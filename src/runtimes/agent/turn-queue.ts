// src/runtimes/agent/turn-queue.ts
// Global FIFO turn queue — serializes turns to Claude Code one at a time.

import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('turn-queue');

export interface QueuedTurn {
  chatJid: string;
  senderJid: string;
  senderName: string | null;
  text: string;
  isGroup: boolean;
  groupName?: string;
  /** durability: inbound_events.seq for this turn — threaded to outbound ops */
  inboundSeq?: number;
}

export interface TurnQueueOpts {
  maxDepth?: number;
  onReject?: (turn: QueuedTurn) => void;
}

export class TurnQueue {
  private queue: QueuedTurn[] = [];
  private processing = false;
  private processor: ((turn: QueuedTurn) => Promise<void>) | null = null;
  private readonly maxDepth: number;
  private readonly onReject?: (turn: QueuedTurn) => void;

  constructor(opts?: TurnQueueOpts) {
    this.maxDepth = opts?.maxDepth ?? Infinity;
    this.onReject = opts?.onReject;
  }

  setProcessor(fn: (turn: QueuedTurn) => Promise<void>): void {
    this.processor = fn;
    // Drain in case items were enqueued before the processor was set.
    void this.drain();
  }

  enqueue(turn: QueuedTurn): boolean {
    if (this.queue.length >= this.maxDepth) {
      log.warn({ chatJid: turn.chatJid, maxDepth: this.maxDepth, pending: this.queue.length },
        'turn rejected — queue depth cap reached');
      this.onReject?.(turn);
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

  /**
   * Returns a Promise that resolves when the queue is empty and no turn is
   * being processed. Useful in tests to await full drain.
   */
  async idle(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return;
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (!this.processing && this.queue.length === 0) {
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
        try {
          await this.processor(turn);
        } catch (err) {
          log.warn({ err, chatJid: turn.chatJid }, 'turn processor error — continuing queue');
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
