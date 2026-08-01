import type { BotErrorsSeverity } from '../../lib/bot-errors-outbox.ts';
import {
  DEFAULT_LEASE_SECONDS,
  evaluateTurnRecoverySupervisorHeartbeat,
  type TurnRecoveryScanFailureReason,
  type TurnRecoverySupervisorHealth,
  type TurnRecoverySupervisorHeartbeatVerdict,
} from './turn-recovery-supervisor.ts';

export const TURN_RECOVERY_SUPERVISOR_ALERT_SOURCE =
  'turn_recovery_supervisor_unavailable';

const DEFAULT_INTERVAL_MS = 15_000;

/**
 * `recordScanSuccess()` fires only at the END of `runScan()`, after a bounded
 * batch of up to SCAN_PAGE_SIZE jobs processed strictly sequentially (a
 * deliberate fair-scheduling requirement — see the
 * `no-await-in-loop`-justified loop in turn-recovery-supervisor.ts). Two
 * NORMAL, healthy scenarios can each legitimately push a single scan's wall
 * time well past a hand-picked fixed threshold:
 *   - a post-crash backlog of a full scan page at ~1s/job (~50s), and
 *   - a single replay that legitimately runs close to a full lease before
 *     completing (the entire lease-renewal design — renewLeaseWhilePending —
 *     exists because this is expected, not exceptional).
 * A fixed 45s budget is smaller than EITHER of these healthy scenarios, so it
 * fired a `critical` false positive during ordinary backlog recovery (#2819).
 * Deriving the budget from DEFAULT_LEASE_SECONDS instead of a second
 * hand-picked constant keeps it correct if the lease is ever retuned: 2 lease
 * cycles comfortably covers a legitimately-slow single replay (~1 lease)
 * PLUS the rest of a full page's worth of fast jobs finishing around it,
 * with margin to spare over either named scenario alone. The supervisor's
 * FIRST scan is subject to the exact same worst-case duration envelope as any
 * later one, so the startup grace before the deadman starts judging
 * staleness at all uses the same derived budget.
 */
const STALE_AFTER_LEASE_MULTIPLIER = 2;
const DEFAULT_STALE_AFTER_MS = DEFAULT_LEASE_SECONDS * 1_000 * STALE_AFTER_LEASE_MULTIPLIER;
const DEFAULT_STARTUP_GRACE_MS = DEFAULT_STALE_AFTER_MS;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export interface TurnRecoveryDeadmanDeps {
  readonly instanceName: string;
  readonly enabled: () => boolean;
  readonly health: () => TurnRecoverySupervisorHealth;
  readonly emitAlert: (
    instance: string,
    source: string,
    summary: string,
    evidence: string,
    severity: BotErrorsSeverity,
  ) => boolean;
  readonly clearAlert: (
    instance: string,
    source: string,
    evidence: string,
  ) => boolean;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly startupGraceMs?: number;
  readonly staleAfterMs?: number;
  readonly maxConsecutiveFailures?: number;
}

export interface TurnRecoveryDeadmanHealth {
  readonly running: boolean;
  readonly incidentActive: boolean;
  readonly lastVerdictReason:
    | TurnRecoverySupervisorHeartbeatVerdict['reason']
    | 'health_unavailable'
    | null;
  readonly lastScanFailureReason: TurnRecoveryScanFailureReason | null;
}

export class TurnRecoveryDeadman {
  private readonly deps: TurnRecoveryDeadmanDeps;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly startupGraceMs: number;
  private readonly staleAfterMs: number;
  private readonly maxConsecutiveFailures: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number | null = null;
  private incidentActive = false;
  private lastVerdictReason:
    | TurnRecoverySupervisorHeartbeatVerdict['reason']
    | 'health_unavailable'
    | null = null;
  private lastScanFailureReason: TurnRecoveryScanFailureReason | null = null;

  constructor(deps: TurnRecoveryDeadmanDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.startupGraceMs = deps.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
    this.staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.maxConsecutiveFailures =
      deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    this.timer = setInterval(() => this.checkOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.startedAt = null;
  }

  health(): TurnRecoveryDeadmanHealth {
    return {
      running: this.timer !== null,
      incidentActive: this.incidentActive,
      lastVerdictReason: this.lastVerdictReason,
      lastScanFailureReason: this.lastScanFailureReason,
    };
  }

  checkOnce(): void {
    if (!this.deps.enabled()) return;
    const now = this.now();
    if (this.startedAt !== null && now - this.startedAt < this.startupGraceMs) return;

    let snapshot: TurnRecoverySupervisorHealth;
    try {
      snapshot = this.deps.health();
    } catch {
      this.lastVerdictReason = 'health_unavailable';
      this.lastScanFailureReason = null;
      if (this.incidentActive) return;
      const emitted = this.deps.emitAlert(
        this.deps.instanceName,
        TURN_RECOVERY_SUPERVISOR_ALERT_SOURCE,
        'Turn-recovery supervisor unavailable',
        'reason=health_unavailable',
        'critical',
      );
      if (emitted) this.incidentActive = true;
      return;
    }
    const verdict = evaluateTurnRecoverySupervisorHeartbeat(snapshot, {
      nowMs: now,
      staleAfterMs: this.staleAfterMs,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
    });
    this.lastVerdictReason = verdict.reason;
    this.lastScanFailureReason = snapshot.lastScanFailureReason;

    if (verdict.reason !== 'ok') {
      if (this.incidentActive) return;
      const emitted = this.deps.emitAlert(
        this.deps.instanceName,
        TURN_RECOVERY_SUPERVISOR_ALERT_SOURCE,
        'Turn-recovery supervisor unavailable',
        this.unhealthyEvidence(snapshot, verdict.reason, now),
        'critical',
      );
      if (emitted) this.incidentActive = true;
      return;
    }

    if (!this.incidentActive) return;
    const cleared = this.deps.clearAlert(
      this.deps.instanceName,
      TURN_RECOVERY_SUPERVISOR_ALERT_SOURCE,
      this.healthyEvidence(snapshot, now),
    );
    if (cleared) this.incidentActive = false;
  }

  private unhealthyEvidence(
    snapshot: TurnRecoverySupervisorHealth,
    reason: Exclude<TurnRecoverySupervisorHeartbeatVerdict['reason'], 'ok'>,
    now: number,
  ): string {
    const successAge = snapshot.lastSuccessfulScanAt === null
      ? 'missing'
      : String(Math.max(0, now - snapshot.lastSuccessfulScanAt));
    return [
      `reason=${reason}`,
      `success_age_ms=${successAge}`,
      `attempts=${snapshot.scans}`,
      `consecutive_failures=${snapshot.consecutiveScanFailures}`,
      `last_failure=${snapshot.lastScanFailureReason ?? 'none'}`,
    ].join(' ');
  }

  private healthyEvidence(snapshot: TurnRecoverySupervisorHealth, now: number): string {
    const successAge = snapshot.lastSuccessfulScanAt === null
      ? 'missing'
      : String(Math.max(0, now - snapshot.lastSuccessfulScanAt));
    return `reason=successful_scan success_age_ms=${successAge} attempts=${snapshot.scans}`;
  }
}
