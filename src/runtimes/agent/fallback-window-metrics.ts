/**
 * FallbackWindowMetrics — process-local telemetry for the provider-fallback window.
 *
 * Second slice of the provider-fallback subsystem decomposition. Owns the
 * accumulate-only counters the fallback machinery reports through getFallbackState
 * and the revert alert: turns served/empty during a window, the arm-time snapshots
 * used to compute per-window deltas, the lifetime transition totals
 * (activations/reverts/replays), and the lifetime fallback-window USD cost.
 *
 * Deliberately NOT persisted — these reset on restart; the durable artifact is the
 * window itself (agent_fallback_state). All increment / snapshot / delta logic lives
 * here; the orchestration stays in AgentRuntime: the window-active gate on cost, the
 * served-vs-empty decision + alerting in recordFallbackTurnOutcome, and the
 * arm / deactivate / replay call sites that drive these counters.
 *
 * Behavior is identical to the previous inline fields — see the fallback
 * characterization coverage (fallback-cost-accumulation.test.ts,
 * fallback-transition-alerts.test.ts, fallback-empty-turn.test.ts,
 * provider-fallback.test.ts, health-snapshot.test.ts).
 */
import { systemClock } from '../../lib/clock.ts';

export class FallbackWindowMetrics {
  /** Lifetime (process) count of turns served while a fallback window was active. */
  turnsServed = 0;
  /** Lifetime count of served turns that produced zero visible output. */
  turnsEmpty = 0;
  /**
   * turnsServed snapshot at the most recent window arm. The lifetime counters accrue
   * across windows (getFallbackState contract), so the revert alert subtracts these
   * to report THIS window's turns instead of cumulative totals.
   */
  turnsServedAtArm = 0;
  /** turnsEmpty snapshot at the most recent window arm (see turnsServedAtArm). */
  turnsEmptyAtArm = 0;
  /** Epoch-ms of the most recent fallback turn; null until the first. Never reset. */
  lastTurnAt: number | null = null;
  /**
   * Lifetime count of window activations — first arms only (extensions and
   * post-restart restores are excluded by the caller).
   */
  activations = 0;
  /** Lifetime count of window reverts (deactivations of an active window). */
  reverts = 0;
  /** Lifetime count of COMPLETED continue-on-fallback replays (failed replays excluded). */
  replays = 0;
  /**
   * Lifetime USD cost of turns served while a fallback window was active
   * (provider-reported costUsd on result events; opencode-only today). Accumulates
   * only during windows, never resets on deactivation, resets on restart. The
   * expensive fallback path must be countable — a silent expensive fallback is a
   * billing surprise waiting to be found on the invoice instead of in /health.
   */
  windowCostUsd = 0;

  /** A turn was served during a window — bump served + stamp the last-turn time. */
  recordServedTurn(): void {
    this.turnsServed += 1;
    this.lastTurnAt = systemClock.now();
  }

  /** The served turn had zero visible output — bump the empty counter. */
  recordEmptyTurn(): void {
    this.turnsEmpty += 1;
  }

  /** Accumulate provider-reported cost for a turn served during a window. */
  addWindowCost(costUsd: number): void {
    this.windowCostUsd += costUsd;
  }

  /** Snapshot the lifetime turn counters at window arm (for per-window deltas). */
  snapshotAtArm(): void {
    this.turnsServedAtArm = this.turnsServed;
    this.turnsEmptyAtArm = this.turnsEmpty;
  }

  /** Per-window served/empty deltas since the last arm snapshot. */
  windowDeltas(): { served: number; empty: number } {
    return {
      served: this.turnsServed - this.turnsServedAtArm,
      empty: this.turnsEmpty - this.turnsEmptyAtArm,
    };
  }

  /** Count a first-arm window activation. */
  recordActivation(): void {
    this.activations += 1;
  }

  /** Count a window revert. */
  recordRevert(): void {
    this.reverts += 1;
  }

  /** Count a completed continue-on-fallback replay. */
  recordReplay(): void {
    this.replays += 1;
  }
}
