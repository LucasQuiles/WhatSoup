// #2566 slice 2 — independent trigger-liveness observer.
//
// The poller's tick is exactly the thing a liveness check must not depend on:
// a hung executor starves any watchdog that runs inside tickOnce. This
// observer runs the liveness gauges on its OWN timer and only reads the
// database — it never executes triggers. The poller keeps its opportunistic
// in-tick past-due check (both paths are latched and idempotent); this timer
// is the guarantee that the gauges still run when a tick hangs.
import type { DatabaseSync } from 'node:sqlite';
import { systemClock } from '../../lib/clock.ts';
import {
  countRecurringOverdueTriggers,
  DEFAULT_RECURRING_OVERDUE_GRACE_SEC,
} from './triggers.ts';
import { createChildLogger } from '../../logger.ts';
import { emitAlertChecked, clearAlertSourceChecked } from '../../lib/emit-alert.ts';
import {
  clearRecoveryMarker,
  loadRecoveryMarkers,
  setRecoveryMarker,
} from '../../lib/recovery-authority-store.ts';

const log = createChildLogger('substrate.trigger-liveness-observer');

const DEFAULT_OBSERVER_INTERVAL_MS = 60_000;

export interface TriggerLivenessObserverOptions {
  /**
   * Instance name for alert attribution. Without it the observer is inert
   * (start() is a no-op) — an alert with no attributable instance cannot be
   * routed, mirroring the poller's own alert gates.
   */
  instance?: string;
  /** Observer cadence. Default 60s. */
  intervalMs?: number;
  /**
   * Grace (seconds) before a previously-fired trigger with a stale
   * next_fire_at counts as recurring-overdue. Default 900s.
   */
  recurringOverdueGraceSeconds?: number;
  /** Injectable clock for tests. Returns unix seconds. */
  now?: () => number;
  /** Injectable timers for tests. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  /**
   * Hook running the poller-owned #1765 past-due check (never-fired rows).
   * Injected so the latch/marker machinery stays with its owner while the
   * SCHEDULE becomes tick-independent.
   */
  pastDueCheck?: (now: number) => void;
}

export class TriggerLivenessObserver {
  private readonly db: DatabaseSync;
  private readonly instance?: string;
  private readonly intervalMs: number;
  private readonly recurringOverdueGraceSeconds: number;
  private readonly nowFn: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly pastDueCheck?: (now: number) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  // Fire-once/clear-once latch for the recurring-overdue alert, with a
  // restart-safe recovery marker (#2394 pattern): the marker lets a NEW
  // process clear an incident an OLD process alerted on.
  private recurringOverdueAlertEmitted = false;
  private recurringOverdueMarkerReconciled = false;

  constructor(db: DatabaseSync, opts: TriggerLivenessObserverOptions = {}) {
    this.db = db;
    this.instance = opts.instance;
    this.intervalMs = opts.intervalMs ?? DEFAULT_OBSERVER_INTERVAL_MS;
    this.recurringOverdueGraceSeconds =
      opts.recurringOverdueGraceSeconds ?? DEFAULT_RECURRING_OVERDUE_GRACE_SEC;
    this.nowFn = opts.now ?? systemClock.nowUnixSec;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? clearTimeout;
    this.pastDueCheck = opts.pastDueCheck;
  }

  start(): void {
    if (!this.instance) return;
    if (this.timer !== null) return;
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      this.runOnce();
      if (!this.stopped) this.scheduleNext();
    }, this.intervalMs);
  }

  /** Run every gauge once. Public for tests and for one-shot health probes. */
  runOnce(now: number = this.nowFn()): void {
    try {
      this.pastDueCheck?.(now);
    } catch (err) {
      log.error({ err }, 'past-due liveness check failed unexpectedly');
    }
    try {
      this.checkRecurringOverdue(now);
    } catch (err) {
      log.error({ err }, 'recurring-overdue check failed unexpectedly');
    }
  }

  private checkRecurringOverdue(now: number): void {
    if (!this.instance) return;
    const count = countRecurringOverdueTriggers(this.db, now, this.recurringOverdueGraceSeconds);
    const over = count > 0;
    if (over && !this.recurringOverdueAlertEmitted) {
      this.recurringOverdueAlertEmitted = emitAlertChecked(
        this.instance,
        'trigger_recurring_overdue',
        `whatsoup@${this.instance} has ${count} recurring trigger(s) overdue by more than ${this.recurringOverdueGraceSeconds}s after having fired before — the firing path may have stalled`,
        [
          `recurringOverdueCount=${count}`,
          `graceSeconds=${this.recurringOverdueGraceSeconds}`,
          `checkedAt=${new Date(now * 1000).toISOString()}`,
          "ref: #2566 — a trigger that fired before and now sits past next_fire_at means the poller stopped draining it. Inspect: SELECT * FROM bead_triggers WHERE status='active' AND last_fire_at IS NOT NULL AND next_fire_at IS NOT NULL.",
        ].join('\n'),
        'warning',
      );
      if (this.recurringOverdueAlertEmitted) {
        try {
          setRecoveryMarker(`trigger_recurring_overdue:${this.instance}`);
        } catch {
          // intentional: marker write is best-effort — the alert itself was
          // durably queued; a missing marker only loses cross-restart
          // reconciliation for this incident.
        }
      }
    } else if (!over) {
      let hadIncident = this.recurringOverdueAlertEmitted;
      if (!hadIncident && !this.recurringOverdueMarkerReconciled) {
        try {
          hadIncident = loadRecoveryMarkers().has(`trigger_recurring_overdue:${this.instance}`);
        } catch {
          // intentional: marker file unreadable — treat as no prior incident
          // and stop consulting the store this process.
        }
        if (!hadIncident) this.recurringOverdueMarkerReconciled = true;
      }
      if (!hadIncident) return;
      if (!clearAlertSourceChecked(
        this.instance,
        'trigger_recurring_overdue',
        `recurringOverdueCount=0 (graceSeconds=${this.recurringOverdueGraceSeconds})`,
      )) {
        return;
      }
      this.recurringOverdueAlertEmitted = false;
      this.recurringOverdueMarkerReconciled = true;
      try {
        clearRecoveryMarker(`trigger_recurring_overdue:${this.instance}`);
      } catch {
        // intentional: marker removal is best-effort — a stale marker only
        // causes one redundant idempotent clear after the next restart.
      }
    }
  }
}
