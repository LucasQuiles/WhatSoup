/**
 * Outbound-flood detector — a sliding-window, per-destination send counter.
 *
 * Mirrors the `recentDisconnects` sliding window in {@link file://./../core/health.ts}
 * (window + count + threshold), but keyed per conversation instead of globally.
 * It is pure observability: it counts, it never blocks a send. Placed at the
 * socket seam (`this.sock.sendMessage`) so it sees ALL outbound tiers — text,
 * media, poll, raw — because every tier funnels through `sock.sendMessage`.
 *
 * Detection is defense-in-depth: it fires even if a future code path bypasses
 * the in-band caps (PR-E / PR-F), shortening time-to-human from days to minutes.
 */
import { clockDriftHoldExtensionMs } from '../lib/clock.ts';

/** Rolling window over which sends to one destination are counted. */
export const OUTBOUND_FLOOD_WINDOW_MS = 300_000; // 5 minutes
/** Send count within the window that trips the flood flag for a destination. */
export const OUTBOUND_FLOOD_THRESHOLD = 20;

export interface OutboundFloodRecordResult {
  /** True when this destination is at/over threshold after this send. */
  flooding: boolean;
  /**
   * Rising edge: this send is the false→true crossing of the flood flag for
   * this destination. Alert ONLY on a rising edge so a sustained flood raises
   * exactly one alert. Re-arms once the destination drains below threshold.
   */
  tripped: boolean;
  /** Resolved destination key (RAW — redact at the surfacing boundary). */
  key: string;
  /** In-window send count for this destination after recording. */
  count: number;
}

export interface OutboundFloodStats {
  /** Rolling window width in ms. */
  windowMs: number;
  /** Per-destination send count that trips the flag. */
  threshold: number;
  /** True when any tracked destination is at/over threshold right now. */
  flooding: boolean;
  /** Number of distinct destinations with at least one in-window send. */
  destCount: number;
  /**
   * Resolved key of the worst offender (highest in-window count), or null.
   * RAW — a DM key is the bare phone number; redact (shortHash) at every
   * surfacing boundary (connection-state, WARN log, alert payload).
   */
  worstKey: string | null;
  /** In-window send count for {@link worstKey}. */
  worstCount: number;
  /**
   * Until when, on the monotonic clock (performance.now()), the latest flood
   * holds, capped at now: now while it holds, else that instant. Null if
   * there has been none. Whether a destination floods is decided only by its
   * wall-clock count above, when a send is recorded; the monotonic clock only
   * measures how long it holds: until that destination's threshold-th newest
   * counted send (for a threshold that is not a whole number of at least 1,
   * the smallest such number that meets it) leaves the window, plus
   * clockDriftHoldExtensionMs, at least until the send that completed it,
   * and the longest of all destinations.
   * Health holds `outbound_flood` from it, so a flood is seen whether or not
   * a health read fell inside it. The monotonic instants are always
   * performance.now(): the `tsMs` and `nowMs` arguments move only the
   * wall-clock window, and production passes neither.
   */
  lastFloodingMonotonicMs: number | null;
}

export interface OutboundFloodDetectorOptions {
  windowMs?: number;
  threshold?: number;
  /**
   * Folds a raw destination (chat JID) to the canonical conversation identity,
   * so a mid-stream `@lid` → phone-JID flip can't dodge the threshold (G2/H3).
   * Defaults to identity. The seam wires in the ingest-parity resolver
   * (`canonicalConversationKey`) so counts correlate with durability + PR-F.
   */
  resolveKey?: (dest: string) => string;
}

export class OutboundFloodDetector {
  private readonly windowMs: number;
  private readonly threshold: number;
  /**
   * The smallest whole count, at least 1, that meets `threshold`: the rank,
   * from the newest, of the counted send a flood is held from. It equals
   * `threshold` for every whole threshold of at least 1.
   */
  private readonly holdRank: number;
  private readonly resolveKey: (dest: string) => string;
  /**
   * resolved key → in-window sends (ascending wall time). Each send also
   * carries its monotonic instant, recorded with it, for the health hold
   * only, so no counted send lacks one.
   */
  private readonly sends = new Map<string, Array<{ atMs: number; monotonicMs: number }>>();
  /**
   * Keys currently latched as flooding — so the rising-edge dedup fires one
   * `tripped` per flood. Cleared when a key drains below threshold or ages out.
   */
  private readonly alerted = new Set<string>();
  /** When the latest flood stops holding (inclusive), on the monotonic clock, or null. */
  private floodHeldUntilMonotonicMs: number | null = null;

  constructor(opts: OutboundFloodDetectorOptions = {}) {
    this.windowMs = opts.windowMs ?? OUTBOUND_FLOOD_WINDOW_MS;
    this.threshold = opts.threshold ?? OUTBOUND_FLOOD_THRESHOLD;
    // Base takes the threshold as given and decides by `count >= threshold`,
    // so the verdict keeps it unchanged. Only the hold's index is derived:
    // after a send is recorded the count is a whole number of at least 1, so
    // whenever the verdict is a flood the count is at least this rank. A NaN
    // or +Infinity threshold never floods, so its rank is never used.
    this.holdRank = Number.isFinite(this.threshold) ? Math.max(1, Math.ceil(this.threshold)) : 1;
    this.resolveKey = opts.resolveKey ?? ((dest) => dest);
  }

  /**
   * Record one outbound send to `dest` at `tsMs` (default: now). Returns the
   * post-record flood state including the rising-edge `tripped` flag the caller
   * uses to alert exactly once per flood.
   */
  record(dest: string, tsMs: number = Date.now()): OutboundFloodRecordResult {
    // Read after the wall clock (`tsMs`, read at the call) and before
    // resolveKey, which can block on a database lookup: a pause between the
    // two reads can only lengthen the hold.
    const monotonicMs = performance.now();
    const key = this.resolveKey(dest);
    let arr = this.sends.get(key);
    const send = { atMs: tsMs, monotonicMs };
    if (arr) {
      arr.push(send);
      this.prune(key, arr, tsMs);
    } else {
      arr = [send];
      this.sends.set(key, arr);
    }
    const count = arr.length;
    const flooding = count >= this.threshold;
    let tripped = false;
    if (flooding) {
      // This count alone decides the flood; the monotonic instants only time
      // it. It holds until the holdRank-th newest counted send leaves the
      // window, extended for clock drift, and at least until now.
      const holdWindowMs = this.windowMs + clockDriftHoldExtensionMs(this.windowMs);
      const heldUntilMs = Math.max(arr[count - this.holdRank]!.monotonicMs + holdWindowMs, monotonicMs);
      this.floodHeldUntilMonotonicMs = Math.max(this.floodHeldUntilMonotonicMs ?? heldUntilMs, heldUntilMs);
      if (!this.alerted.has(key)) {
        tripped = true; // false→true rising edge
        this.alerted.add(key);
      }
    } else {
      this.alerted.delete(key); // drained below threshold — re-arm
    }
    return { flooding, tripped, key, count };
  }

  /** True when `dest`'s in-window send count is at/over the threshold. */
  isFlooding(dest: string, nowMs: number = Date.now()): boolean {
    return this.count(dest, nowMs) >= this.threshold;
  }

  /** In-window send count for `dest`. */
  count(dest: string, nowMs: number = Date.now()): number {
    const key = this.resolveKey(dest);
    const arr = this.sends.get(key);
    if (!arr) return 0;
    this.prune(key, arr, nowMs);
    return arr.length;
  }

  /** Snapshot of the worst offender + overall flood flag, for surfacing. */
  stats(nowMs: number = Date.now()): OutboundFloodStats {
    let worstKey: string | null = null;
    let worstCount = 0;
    let destCount = 0;
    for (const [key, arr] of this.sends) {
      this.prune(key, arr, nowMs);
      if (arr.length === 0) {
        this.sends.delete(key);
        this.alerted.delete(key);
        continue;
      }
      destCount += 1;
      if (arr.length > worstCount) {
        worstCount = arr.length;
        worstKey = key;
      }
    }
    const monotonicNowMs = performance.now();
    const heldUntilMs = this.floodHeldUntilMonotonicMs;
    return {
      windowMs: this.windowMs,
      threshold: this.threshold,
      flooding: worstCount >= this.threshold,
      destCount,
      worstKey,
      worstCount,
      lastFloodingMonotonicMs: heldUntilMs === null ? null : Math.min(heldUntilMs, monotonicNowMs),
    };
  }

  /**
   * Drop timestamps older than the window. Entries are appended in ~monotonic
   * order, so the expired prefix is contiguous — splice it in one shot. Mirrors
   * the `event.at >= cutoff` retention in `pruneRecentDisconnects`.
   */
  private prune(key: string, arr: Array<{ atMs: number }>, nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let expired = 0;
    while (expired < arr.length && arr[expired]!.atMs < cutoff) expired += 1;
    if (expired > 0) arr.splice(0, expired);
    if (arr.length === 0) this.alerted.delete(key); // drained — re-arm
  }
}
