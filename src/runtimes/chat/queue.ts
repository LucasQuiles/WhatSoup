import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('queue');

/**
 * Per-chat pending-task cap (QR-060). The concurrency cap (maxConcurrent) bounds how many
 * tasks RUN at once, but the per-chat promise chain itself was unbounded: a sustained flood
 * on one chat (or a busy group with many senders) accumulated retained IncomingMessage
 * closures without limit, since the rate-limit is checked POST-dequeue (gates work, not
 * admission) and ingest's backpressure releases its slot before this expensive lane runs.
 * Shed admission once a chat's backlog reaches the cap — the message is already persisted by
 * ingest, so dropping the *processing* (not the storage) is acceptable load-shedding; a chat
 * already this far behind is being flooded. Generous so legit bursts are unaffected.
 */
const DEFAULT_MAX_PER_CHAT_DEPTH = 100;

export class ChatQueue {
  private chatChains: Map<string, Promise<void>>;
  /** Un-finished (queued + running) task count per chat — drives the admission cap. */
  private pendingByChat: Map<string, number>;
  private activeChats: number;
  private waiting: Array<() => void>;
  private maxConcurrent: number;
  private maxPerChatDepth: number;
  private dropped: number;

  constructor(maxConcurrent: number = 3, maxPerChatDepth: number = DEFAULT_MAX_PER_CHAT_DEPTH) {
    this.chatChains = new Map();
    this.pendingByChat = new Map();
    this.activeChats = 0;
    this.waiting = [];
    this.maxConcurrent = maxConcurrent;
    this.maxPerChatDepth = maxPerChatDepth;
    this.dropped = 0;
  }

  /**
   * Enqueue a task for sequential per-chat processing.
   * @returns `true` if admitted, `false` if shed because this chat's backlog is at capacity.
   */
  async enqueue(chatJid: string, task: () => Promise<void>): Promise<boolean> {
    const pending = this.pendingByChat.get(chatJid) ?? 0;
    if (pending >= this.maxPerChatDepth) {
      this.dropped += 1;
      log.warn(
        { chatJid, pending, cap: this.maxPerChatDepth, dropped: this.dropped },
        'queue: per-chat backlog at capacity — shedding task (message already persisted)',
      );
      return false;
    }
    this.pendingByChat.set(chatJid, pending + 1);

    // Get or create the existing chain for this chat
    const existingChain = this.chatChains.get(chatJid) ?? Promise.resolve();

    // Build the new chain link: wait for prior task, acquire slot, run task, release slot
    const newChain = existingChain.then(async () => {
      // Acquire a global concurrency slot
      await this.acquireSlot(chatJid);

      try {
        log.debug({ chatJid }, 'queue: running task');
        await task();
      } catch (err) {
        log.error({ chatJid, err }, 'queue: task error');
      } finally {
        this.releaseSlot(chatJid);

        // Decrement this chat's pending count; drop the entry at zero so the map cannot grow.
        const remaining = (this.pendingByChat.get(chatJid) ?? 1) - 1;
        if (remaining <= 0) this.pendingByChat.delete(chatJid);
        else this.pendingByChat.set(chatJid, remaining);

        // Clean up chain entry if this is still the last link
        if (this.chatChains.get(chatJid) === newChain) {
          this.chatChains.delete(chatJid);
          log.debug({ chatJid }, 'queue: chain cleared');
        }
      }
    });

    this.chatChains.set(chatJid, newChain);

    log.debug(
      { chatJid, trackedChats: this.chatChains.size },
      'queue: task enqueued',
    );
    return true;
  }

  /** Number of tasks shed due to the per-chat depth cap since construction (QR-060). */
  get droppedCount(): number {
    return this.dropped;
  }

  private acquireSlot(chatJid: string): Promise<void> {
    if (this.activeChats < this.maxConcurrent) {
      this.activeChats = this.activeChats + 1;
      log.debug(
        { chatJid, activeChats: this.activeChats, maxConcurrent: this.maxConcurrent },
        'queue: slot acquired immediately',
      );
      return Promise.resolve();
    }

    // At capacity — queue a waiter
    return new Promise<void>((resolve) => {
      log.debug(
        { chatJid, activeChats: this.activeChats, waiters: this.waiting.length },
        'queue: waiting for slot',
      );
      this.waiting.push(resolve);
    });
  }

  private releaseSlot(chatJid: string): void {
    const next = this.waiting.shift();
    if (next) {
      // Hand the slot directly to the next waiter — activeChats stays the same
      log.debug({ chatJid, waiters: this.waiting.length }, 'queue: slot handed to waiter');
      next();
    } else {
      this.activeChats = this.activeChats - 1;
      log.debug({ chatJid, activeChats: this.activeChats }, 'queue: slot released');
    }
  }

  get stats(): { activeChats: number; queuedChats: number; trackedChats: number } {
    return {
      activeChats: this.activeChats,
      queuedChats: this.waiting.length,
      trackedChats: this.chatChains.size,
    };
  }
}
