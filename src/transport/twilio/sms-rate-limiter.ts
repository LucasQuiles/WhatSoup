// src/transport/twilio/sms-rate-limiter.ts
/**
 * Per-destination sliding-window rate limiter for outbound SMS (QR-068).
 *
 * `twilioConfig.rateLimit.smsPerMinute` was validated and plumbed but never
 * enforced; this enforces it at the adapter send seam. Throttled sends are
 * DELAYED, never rejected: callers (bridge relay, MCP send_sms) treat a
 * sendText rejection as a hard failure, and the cap exists for cost control,
 * not availability control. Same timestamp-window shape as the provider
 * budget's request window (runtimes/agent/providers/budget.ts) — duplicated
 * here because transport must not import from runtimes/ (import boundary).
 *
 * Slots are RESERVED at acquire time, before the port call, so a concurrent
 * burst cannot overshoot the cap while sends are in flight; a send that later
 * fails still consumes its slot (conservative, correct for a cost cap).
 */
export class SmsRateLimiter {
  /** destination -> reserved-send timestamps (epoch ms), oldest first. */
  private readonly windows = new Map<string, number[]>();
  /** destination -> tail of the FIFO acquire chain. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  constructor(maxPerWindow: number, windowMs: number = 60_000) {
    // Config validation enforces smsPerMinute in [1, 600], but direct
    // construction can bypass it — a cap below 1 would busy-loop the wait
    // (window never admits, wait math degenerates), so clamp instead.
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
   * when a slot was free immediately. Never rejects.
   */
  async acquire(destination: string): Promise<number> {
    const prior = this.chains.get(destination) ?? Promise.resolve();
    // reserveSlot never throws, so the chain tail cannot be poisoned for
    // later acquirers.
    const turn = prior.then(() => this.reserveSlot(destination));
    this.chains.set(destination, turn);
    void turn.finally(() => {
      // Last waiter cleans up so an idle destination does not pin its chain.
      if (this.chains.get(destination) === turn) {
        this.chains.delete(destination);
        // The destination has no more in-flight acquires — schedule a
        // one-shot check to evict its `windows` entry once the reservation
        // just made ages out, so a destination that never sends again does
        // not pin a Map entry forever (QR-068b G1). Mirrors the self-cleanup
        // above: reactive to "this was the last one", just on a timer
        // instead of a settle, because the relevant expiry is time-based.
        this.scheduleWindowCleanup(destination);
      }
    });
    return turn;
  }

  private async reserveSlot(destination: string): Promise<number> {
    const started = Date.now();
    let window = this.windows.get(destination);
    if (window === undefined) {
      window = [];
      this.windows.set(destination, window);
    }
    for (;;) {
      const now = Date.now();
      this.pruneWindow(window, now);
      if (window.length < this.maxPerWindow) {
        window.push(now);
        return now - started;
      }
      // Window full: sleep until the oldest reservation ages out.
      const waitMs = window[0]! + this.windowMs - now;
      await sleep(Math.max(1, waitMs));
    }
  }

  /**
   * Prunes timestamps that have aged out of the window as of `now`.
   *
   * First clamps any stored timestamp that is ahead of `now` down to `now`
   * (QR-068b G2): `Date.now()` is not guaranteed monotonic (NTP correction,
   * VM resume/sleep, manual clock change), and a backward step would
   * otherwise leave `window[0] > now`, making `window[0] + windowMs - now`
   * exceed `windowMs` — both the wait and the prune threshold below assume
   * `window[0] <= now`. Treating a future-looking stored send as having
   * just happened is conservative (the cap only ever gets tighter, never
   * looser, across a backward step) and keeps the computed wait bounded by
   * `windowMs`, never negative or absurd. A forward step is not guarded: it
   * frees slots early, which is indistinguishable from time genuinely
   * having passed and is accepted (see the characterization test) — this
   * class intentionally stays on Date.now() rather than a monotonic clock
   * (fake-timer tests and production code both rely on Date.now() today).
   */
  private pruneWindow(window: number[], now: number): void {
    for (let i = 0; i < window.length; i++) {
      if (window[i]! > now) window[i] = now;
    }
    while (window.length > 0 && window[0]! <= now - this.windowMs) window.shift();
  }

  /**
   * Schedules a one-shot check `windowMs` after the destination's chain went
   * idle: prunes its window and, if that leaves it empty, deletes the
   * `windows` entry (QR-068b G1). Idempotent and safe to schedule
   * redundantly — a destination that keeps sending just keeps re-scheduling
   * harmless no-ops (the array will not be empty yet) until it actually goes
   * idle.
   *
   * Three guards, all re-checked at fire time (not just schedule time):
   *  - `window.length === 0` — never deletes a still-populated array, so a
   *    timestamp recorded by a newer acquire() is never evicted.
   *  - `this.windows.get(destination) === window` — never deletes a
   *    different array a newer acquire() may have installed. Defensive: as
   *    of the 2026-07-04 review, no interleaving under this class's actual
   *    (Date.now()-based, non-monotonic-tick) fake-timer semantics was found
   *    that makes this guard alone the difference between pass and fail —
   *    mutation-removing it in isolation left the full suite green,
   *    including an adversarial multi-generation/backward-step probe built
   *    specifically to trigger it. Kept because the analogous `chains` guard
   *    below IS reachable (a cleanup and a sleeping reserveSlot's own wait
   *    can share the same target tick), and this guard is the array-identity
   *    counterpart to that same shared-tick scenario.
   *  - `!this.chains.has(destination)` — never deletes while an acquire() is
   *    in flight for this destination. This one matters even when the array
   *    looks empty: this cleanup and a currently-sleeping reserveSlot's own
   *    wait can share the exact same target tick (both windowMs after the
   *    same reservation), and cleanup runs first (registered first). Without
   *    this guard, deleting here would orphan the sleeping call's array
   *    reference from the map — its eventual push would land in a
   *    disconnected array, invisible to the next acquire(), which would then
   *    fetch a fresh empty window and wrongly grant an immediate slot
   *    (breaks both the cap and FIFO ordering; caught by the existing FIFO
   *    test).
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
