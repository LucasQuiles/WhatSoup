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
      if (this.chains.get(destination) === turn) this.chains.delete(destination);
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
      while (window.length > 0 && window[0]! <= now - this.windowMs) window.shift();
      if (window.length < this.maxPerWindow) {
        window.push(now);
        return now - started;
      }
      // Window full: sleep until the oldest reservation ages out.
      const waitMs = window[0]! + this.windowMs - now;
      await sleep(Math.max(1, waitMs));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
