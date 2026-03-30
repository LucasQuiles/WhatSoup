import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('queue');

export class ChatQueue {
  private chatChains: Map<string, Promise<void>>;
  private activeChats: number;
  private waiting: Array<() => void>;
  private maxConcurrent: number;

  constructor(maxConcurrent: number = 3) {
    this.chatChains = new Map();
    this.activeChats = 0;
    this.waiting = [];
    this.maxConcurrent = maxConcurrent;
  }

  async enqueue(chatJid: string, task: () => Promise<void>): Promise<void> {
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
