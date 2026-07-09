// src/transport/outbound-rate-limiter.ts
/**
 * Per-destination sliding-window rate limiter for outbound sends (QR-068 → PR-F).
 *
 * Generalized from the Twilio `SmsRateLimiter` (QR-068), which is now a thin
 * re-export of this class (`./twilio/sms-rate-limiter.ts`). One window shape is
 * reused across the estate rather than a third copy (the send-path census
 * flagged the duplication: SmsRateLimiter + the provider budget request window).
 *
 * Contract: throttled sends are DELAYED, never rejected, by the classic
 * `acquire()` — the exact SmsRateLimiter behaviour, kept byte-for-byte so its
 * tests pass through the re-export. PR-F adds two bounded variants the socket
 * governor needs but SMS never did:
 *
 *   - `acquireBounded(dest, maxWaitMs)` — paces like `acquire()` but never waits
 *     longer than `maxWaitMs` for THIS reservation; if the window would need a
 *     longer wait it resolves `{capped:true}` WITHOUT reserving, so the caller
 *     sheds rather than blowing a downstream SEND_TIMEOUT (design F4).
 *   - `tryAcquireSync(dest)` — a synchronous prune-and-count reserve for a hard
 *     ceiling: reserves if under cap, else returns false immediately (no wait,
 *     no FIFO chain), so a concurrent flood rejects without growing the queue.
 *
 * Slots are RESERVED at acquire time, before the send, so a concurrent burst
 * cannot overshoot the cap while sends are in flight; a send that later fails
 * still consumes its slot (conservative, correct for a rate cap).
 */
export interface BoundedAcquireResult {
  /** Milliseconds this acquire waited before resolving. */
  delayMs: number;
  /** True when the slot was NOT reserved because pacing would exceed maxWaitMs. */
  capped: boolean;
}

export class OutboundRateLimiter {
  /** destination -> reserved-send timestamps (epoch ms), oldest first. */
  private readonly windows = new Map<string, number[]>();
  /** destination -> tail of the FIFO acquire chain. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  constructor(maxPerWindow: number, windowMs: number = 60_000) {
    // A cap below 1 would busy-loop the wait (window never admits, wait math
    // degenerates), so clamp instead. Config validation normally enforces a
    // sane range, but direct construction can bypass it.
    this.maxPerWindow = Math.max(1, Math.floor(maxPerWindow));
    this.windowMs = windowMs;
  }

  /** Number of destinations currently tracked (test/introspection only). */
  get size(): number {
    return this.windows.size;
  }

  /**
   * Resolves once a send slot for `destination` is reserved, waiting for the
   * window to slide when it is full. FIFO per destination; destinations do
   * not affect each other. Returns the delay (ms) this acquire waited, 0
   * when a slot was free immediately. Never rejects. (SmsRateLimiter contract.)
   */
  async acquire(destination: string): Promise<number> {
    return this.enqueue(destination, () => this.reserveSlot(destination));
  }

  /**
   * Like `acquire`, but bounds the wait: if reserving a slot would take longer
   * than `maxWaitMs`, resolves `{capped:true}` WITHOUT reserving instead of
   * waiting. `maxWaitMs` bounds THIS reservation's own wait, not the cumulative
   * FIFO-queue wall-clock — concurrent same-destination acquires still serialize
   * (order preserved), so a deep queue can settle past `maxWaitMs` in aggregate
   * even though each individual reservation is bounded. In WhatSoup the socket
   * send is awaited, so per-destination sends are effectively serialized.
   */
  async acquireBounded(destination: string, maxWaitMs: number): Promise<BoundedAcquireResult> {
    return this.enqueue(destination, () => this.reserveSlotBounded(destination, maxWaitMs));
  }

  /**
   * Synchronous reserve for a hard ceiling: prunes the window and reserves a
   * slot if under cap, returning true; otherwise returns false immediately
   * without waiting or chaining. Unlike `acquire`, this never blocks and never
   * touches the FIFO chain, so a concurrent flood over the ceiling rejects
   * cleanly instead of piling up waiters. Schedules the same idle-window
   * cleanup as the async path so the ceiling window does not leak entries.
   */
  tryAcquireSync(destination: string): boolean {
    let window = this.windows.get(destination);
    if (window === undefined) {
      window = [];
      this.windows.set(destination, window);
    }
    const now = Date.now();
    this.pruneWindow(window, now);
    if (window.length < this.maxPerWindow) {
      window.push(now);
      this.scheduleWindowCleanup(destination);
      return true;
    }
    return false;
  }

  /**
   * Runs `task` behind the per-destination FIFO chain, with the shared
   * last-waiter cleanup. `task` must never throw (reserveSlot / reserveSlotBounded
   * do not), so the chain tail cannot be poisoned for later acquirers.
   */
  private enqueue<T>(destination: string, task: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(destination) ?? Promise.resolve();
    const turn = prior.then(task);
    this.chains.set(destination, turn);
    void turn.finally(() => {
      if (this.chains.get(destination) === turn) {
        this.chains.delete(destination);
        this.scheduleWindowCleanup(destination);
      }
    });
    return turn;
  }

  private async reserveSlot(destination: string): Promise<number> {
    const started = Date.now();
    const window = this.getWindow(destination);
    for (;;) {
      const now = Date.now();
      this.pruneWindow(window, now);
      if (window.length < this.maxPerWindow) {
        window.push(now);
        return now - started;
      }
      const waitMs = window[0]! + this.windowMs - now;
      await sleep(Math.max(1, waitMs));
    }
  }

  private async reserveSlotBounded(destination: string, maxWaitMs: number): Promise<BoundedAcquireResult> {
    const started = Date.now();
    const window = this.getWindow(destination);
    for (;;) {
      const now = Date.now();
      this.pruneWindow(window, now);
      if (window.length < this.maxPerWindow) {
        window.push(now);
        return { delayMs: now - started, capped: false };
      }
      const waitMs = Math.max(1, window[0]! + this.windowMs - now);
      // Shed rather than wait if this reservation's total wait would exceed the
      // bound. Measured from `started` so the accumulated wait across loop
      // iterations stays within maxWaitMs.
      if (now - started + waitMs > maxWaitMs) {
        return { delayMs: now - started, capped: true };
      }
      await sleep(waitMs);
    }
  }

  private getWindow(destination: string): number[] {
    let window = this.windows.get(destination);
    if (window === undefined) {
      window = [];
      this.windows.set(destination, window);
    }
    return window;
  }

  /**
   * Prunes timestamps that have aged out of the window as of `now`.
   *
   * First clamps any stored timestamp ahead of `now` down to `now`: `Date.now()`
   * is not monotonic (NTP correction, VM resume/sleep, manual clock change), and
   * a backward step would otherwise leave `window[0] > now`, making the computed
   * wait exceed `windowMs` (or go negative). Treating a future-looking stored
   * send as having just happened is conservative (the cap only tightens across a
   * backward step) and keeps the wait bounded by `windowMs`. A forward step is
   * not guarded: it frees slots early, indistinguishable from time genuinely
   * passing, and accepted — this class stays on Date.now() rather than a
   * monotonic clock (fake-timer tests and production both rely on Date.now()).
   */
  private pruneWindow(window: number[], now: number): void {
    for (let i = 0; i < window.length; i++) {
      if (window[i]! > now) window[i] = now;
    }
    while (window.length > 0 && window[0]! <= now - this.windowMs) window.shift();
  }

  /**
   * Schedules a one-shot check `windowMs` after the destination went idle:
   * prunes its window and, if empty, deletes the entry. Idempotent and safe to
   * schedule redundantly. Three guards, all re-checked at fire time:
   *  - `window.length === 0` — never deletes a still-populated array.
   *  - `this.windows.get(destination) === window` — never deletes a different
   *    array a newer acquire installed.
   *  - `!this.chains.has(destination)` — never deletes while an acquire is in
   *    flight; a cleanup and a sleeping reserveSlot can share the same target
   *    tick (cleanup runs first), and deleting would orphan the sleeper's array
   *    reference so its push lands in a disconnected array (breaks cap + FIFO).
   */
  private scheduleWindowCleanup(destination: string): void {
    const window = this.windows.get(destination);
    if (window === undefined) return;
    setTimeout(() => {
      this.pruneWindow(window, Date.now());
      if (
        window.length === 0 &&
        this.windows.get(destination) === window &&
        !this.chains.has(destination)
      ) {
        this.windows.delete(destination);
      }
    }, this.windowMs).unref();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
