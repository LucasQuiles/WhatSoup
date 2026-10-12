/**
 * Bounded hold for the windowed health reasons: event_loop_starvation,
 * connection_churn and outbound_flood.
 *
 * Each is a rolling-window verdict, and a recurring fault can leave the window
 * between detections: a loop stall over 10 s empties the loop-lag window, and a
 * connection flapping every 4 minutes dips below 3 disconnects in 10 minutes.
 * The fleet poller clears an open page on one healthy body, so a reason that
 * reads clear between detections closes the page while the fault continues.
 * Health therefore keeps reporting the reason (same reason string, same cause)
 * until its hold has passed since the condition last held. A reading that
 * cannot be trusted counts as holding.
 *
 * "Last held" comes from the producer, which records it when it computes the
 * condition (the sampler per sample, the connection manager per disconnect,
 * the flood detector per send), so detection does not depend on when or how
 * often /health is read. Health also marks the instants it observes the
 * condition, or an unreadable input, itself.
 *
 * Clock: every stamp and every `nowMs` is monotonic milliseconds
 * (performance.now(), which is also the sampler's default `now`), never the
 * wall clock, so a wall-clock step cannot shorten or stretch a recorded hold.
 * Whether churn or a flood exists is decided only by the producer's own
 * wall-clock count; the monotonic clock only measures how long it holds.
 * Monotonic time starts again with each process; nothing here outlives one.
 *
 * The reasons stay out of the #2280 silence latch and never open its arm gate
 * (DIRECTLY_REPROBED_STATUS_REASONS in health.ts): the hold is bounded where
 * the latch lasted until restart. State is in memory, one instance per health
 * server, so a restart starts clean, as it did with the latch.
 *
 * Inputs are typed structurally: core may not import transport modules.
 */
import { MS_PER_MINUTE } from '../lib/time-units.ts';
import type { LoopLagSnapshot } from '../lib/loop-lag-sampler.ts';

/** connection_churn holds at this many disconnects in the connection
 * manager's 10-minute window. The connection manager stamps churn with it. */
export const RECENT_DISCONNECT_DEGRADED_THRESHOLD = 3;

/** Equals the connection manager's 10-minute disconnect window. A steady flap
 * of period P reaches 3 in 10 minutes only when P is 5 minutes or less, and it
 * then falls below the threshold for at most 3P - 10 minutes (at most 5)
 * between the instants churn holds. A hold of one full window covers that gap
 * with margin, as it does any irregular flap that holds again within 10 minutes. */
export const CONNECTION_CHURN_HOLD_MS = 10 * MS_PER_MINUTE;

/** The loop-lag window is only 10 s (20 samples at 500 ms), far shorter than
 * the gaps between bursts of a recurring starvation. 5 minutes is 30 windows,
 * and 60 polls by the fleet poller (every 5 s), which clears an open page on
 * one healthy body. It matches the 5-minute repeat of the starvation warning
 * log, and bounds how long a single episode or stall reads degraded after it
 * was last detected. */
export const EVENT_LOOP_STARVATION_HOLD_MS = 5 * MS_PER_MINUTE;

/** Equals the flood detector's 5-minute per-destination window
 * (OUTBOUND_FLOOD_WINDOW_MS): a flood that trips again within one detector
 * window reads continuously, by the same reasoning as churn. */
export const OUTBOUND_FLOOD_HOLD_MS = 5 * MS_PER_MINUTE;

class ReasonHold {
  private lastHeldAtMs: number | null = null;

  constructor(private readonly holdMs: number) {}

  /** True until holdMs has passed since the condition last held: now when
   * `holdsNow`, or the producer's stamp. */
  report(holdsNow: boolean, producerStampMs: number | null | undefined, nowMs: number): boolean {
    if (holdsNow) this.mark(nowMs);
    if (producerStampMs != null) this.mark(producerStampMs);
    return this.lastHeldAtMs !== null && nowMs - this.lastHeldAtMs < this.holdMs;
  }

  private mark(atMs: number): void {
    if (this.lastHeldAtMs === null || atMs > this.lastHeldAtMs) this.lastHeldAtMs = atMs;
  }
}

/** Per-server hold state. Call each method exactly once per health
 * evaluation, before any connected-state gating, so the hold sees every
 * observation, with a monotonic `nowMs` read after the producer's snapshot.
 * Each returns whether the reason is reported. */
export class WindowedReasonHolds {
  private readonly starvationHold = new ReasonHold(EVENT_LOOP_STARVATION_HOLD_MS);
  private readonly churnHold = new ReasonHold(CONNECTION_CHURN_HOLD_MS);
  private readonly floodHold = new ReasonHold(OUTBOUND_FLOOD_HOLD_MS);
  // The sampler's count starts at 0 when health starts it, so a stall before
  // the first evaluation counts as new.
  private seenDiscontinuityCount = 0;
  private floodSnapshotSeen = false;

  /** The verdict reads starved only on a full 20-sample window, and a stall
   * over 10 s empties the window. The window is readable only when it is full
   * and no discontinuity has occurred since the previous evaluation. A window
   * refilling after a discontinuity, or a new discontinuity, counts as starved
   * from this evaluation. A partial window at startup, or after the sampler
   * restarts, reads clear, as base. */
  starvation(
    loopLag: Pick<
      LoopLagSnapshot,
      'locallyStarved' | 'discontinuityCount' | 'refillingAfterDiscontinuity' | 'lastStarvedMonotonicMs'
    >,
    nowMs: number,
  ): boolean {
    const discontinuitySinceLastRead = loopLag.discontinuityCount !== this.seenDiscontinuityCount;
    this.seenDiscontinuityCount = loopLag.discontinuityCount;
    return this.starvationHold.report(
      loopLag.locallyStarved || discontinuitySinceLastRead || loopLag.refillingAfterDiscontinuity,
      loopLag.lastStarvedMonotonicMs,
      nowMs,
    );
  }

  /** Base's wall-clock `count` still holds the reason while it meets the
   * threshold. A missing disconnect window is unknown, not clear. The snapshot
   * type requires it: the Baileys manager supplies it, and the SMS, Signal and
   * iMessage bridges supply an empty one. */
  churn(
    recentDisconnects: { readonly count: number; readonly lastChurnMonotonicMs?: number | null } | null | undefined,
    nowMs: number,
  ): boolean {
    const holdsNow = recentDisconnects == null
      || recentDisconnects.count >= RECENT_DISCONNECT_DEGRADED_THRESHOLD;
    return this.churnHold.report(holdsNow, recentDisconnects?.lastChurnMonotonicMs, nowMs);
  }

  /** Base's wall-clock `flooding` still holds the reason while it is true. A
   * flood snapshot that goes missing after being supplied is unknown, not
   * clear. One never supplied reads clear: only the Baileys manager has a
   * flood detector, and the SMS, Signal and iMessage bridges never supply it. */
  flood(
    outboundFlood: { readonly flooding: boolean; readonly lastFloodingMonotonicMs?: number | null } | null | undefined,
    nowMs: number,
  ): boolean {
    if (outboundFlood != null) this.floodSnapshotSeen = true;
    const holdsNow = outboundFlood != null ? outboundFlood.flooding : this.floodSnapshotSeen;
    return this.floodHold.report(holdsNow, outboundFlood?.lastFloodingMonotonicMs, nowMs);
  }
}
