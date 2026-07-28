import type { BotErrorsSeverity } from '../../lib/bot-errors-outbox.ts';
import {
  evaluateTurnRecoverySupervisorHeartbeat,
  type TurnRecoveryScanFailureReason,
  type TurnRecoverySupervisorHealth,
  type TurnRecoverySupervisorHeartbeatVerdict,
} from './turn-recovery-supervisor.ts';

export const TURN_RECOVERY_SUPERVISOR_ALERT_SOURCE =
  'turn_recovery_supervisor_unavailable';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_STARTUP_GRACE_MS = 45_000;
const DEFAULT_STALE_AFTER_MS = 45_000;
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
  readonly lastVerdictReason: TurnRecoverySupervisorHeartbeatVerdict['reason'] | null;
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
  private lastVerdictReason: TurnRecoverySupervisorHeartbeatVerdict['reason'] | null = null;
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

    const snapshot = this.deps.health();
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
