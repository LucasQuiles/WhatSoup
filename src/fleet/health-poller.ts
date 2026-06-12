import { createChildLogger } from '../logger.ts';
import { emitAlert } from '../lib/emit-alert.ts';
// Aliased to keep this module's call sites unchanged (asRecord returns
// `undefined` for non-records; the one null-typed seam adapts with `?? null`).
import { asRecord as recordValue } from '../lib/type-guards.ts';
import { ALERT_THROTTLE_INTERVAL_MS, loadAlertThrottleDetailed, recordAlertThrottle } from './alert-throttle-store.ts';
import { isInstanceSilenced } from './silence-manager.ts';

const log = createChildLogger('fleet:health-poller');

const MIN_ALERT_INTERVAL_MS = ALERT_THROTTLE_INTERVAL_MS;
const TERMINAL_AUTH_FAILURE_CLASSES = new Set([
  'pairing_required',
  'serverside_logout_irreversible',
]);

export interface InstanceHealth {
  name: string;
  type: string;
  accessMode: string;
  healthPort: number;
  healthToken: string | null;
}

export interface InstanceStatus {
  name: string;
  health: Record<string, unknown> | null;
  lastPollAt: string;
  consecutiveFailures: number;
  status: 'online' | 'degraded' | 'unreachable' | 'logged_out';
  statusConfidence: 'confirmed' | 'inferred' | 'ambiguous';
  statusReason: string;
  statusEvidence: string[];
  error: string | null;
  lastAlertAt: string | null;
  silencedUntil: string | null;
}

export type StatusChangeCallback = (instance: string, newStatus: InstanceStatus['status'], oldStatus: InstanceStatus['status']) => void;

type StatusConfidence = InstanceStatus['statusConfidence'];

interface HealthSnapshotClassification {
  status: 'online' | 'degraded' | 'logged_out';
  confidence: StatusConfidence;
  reason: string;
  evidence: string[];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function evidenceField(name: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return `${name}=unknown`;
  return `${name}=${String(value)}`;
}

function classifyHealthSnapshot(health: Record<string, unknown>): HealthSnapshotClassification {
  const healthStatus = stringValue(health.status);
  const whatsapp = recordValue(health.whatsapp);
  const connected = booleanValue(whatsapp?.connected);
  const accountJid = stringValue(whatsapp?.account_jid);
  const connection = recordValue(whatsapp?.connection);
  const connectionState = stringValue(connection?.state);
  const reconnectPhase = stringValue(connection?.reconnect_phase);
  const reconnectAttempts = numberValue(connection?.reconnect_attempts);
  const lastDisconnectReason = stringValue(connection?.last_disconnect_reason);
  const lastStatusCode = numberValue(connection?.last_status_code);
  const authFailureClass = stringValue(connection?.auth_failure_class);
  const recentDisconnects = recordValue(connection?.recent_disconnects);
  const recentDisconnectCount = numberValue(recentDisconnects?.count);
  const recentDisconnectThreshold = numberValue(recentDisconnects?.degraded_threshold);
  const recentDisconnectWindowMs = numberValue(recentDisconnects?.window_ms);
  const recentDisconnectLastAt = stringValue(recentDisconnects?.last_at);
  const recentDisconnectLastReason = stringValue(recentDisconnects?.last_reason);
  const recentDisconnectLastStatusCode = numberValue(recentDisconnects?.last_status_code);
  const accountJidStatus = accountJid === null
    ? 'missing'
    : accountJid === 'not connected'
      ? 'not_connected'
      : 'present';

  const baseEvidence = [
    evidenceField('health_status', healthStatus),
    evidenceField('whatsapp_connected', connected),
    evidenceField('account_jid_status', accountJidStatus),
    evidenceField('connection_state', connectionState),
    evidenceField('reconnect_phase', reconnectPhase),
    evidenceField('reconnect_attempts', reconnectAttempts),
    evidenceField('last_disconnect_reason', lastDisconnectReason),
    evidenceField('last_status_code', lastStatusCode),
    evidenceField('auth_failure_class', authFailureClass),
    evidenceField('recent_disconnect_count', recentDisconnectCount),
    evidenceField('recent_disconnect_threshold', recentDisconnectThreshold),
    evidenceField('recent_disconnect_window_ms', recentDisconnectWindowMs),
    evidenceField('recent_disconnect_last_at', recentDisconnectLastAt),
    evidenceField('recent_disconnect_last_reason', recentDisconnectLastReason),
    evidenceField('recent_disconnect_last_status_code', recentDisconnectLastStatusCode),
  ];

  const loggedOutHeuristic = reconnectPhase === 'backoff' && reconnectAttempts === 0;
  const disconnectedCorroboration =
    connected === false ||
    accountJid === 'not connected' ||
    connectionState === 'disconnected' ||
    healthStatus === 'unhealthy';
  const explicitAuthLossSignal =
    lastStatusCode === 401 ||
    lastDisconnectReason === 'loggedOut' ||
    (authFailureClass !== null && TERMINAL_AUTH_FAILURE_CLASSES.has(authFailureClass));

  if (loggedOutHeuristic && disconnectedCorroboration && explicitAuthLossSignal) {
    return {
      status: 'logged_out',
      confidence: 'confirmed',
      reason: 'whatsapp_auth_loss_with_disconnect_corroboration',
      evidence: baseEvidence,
    };
  }

  if (loggedOutHeuristic && disconnectedCorroboration) {
    return {
      status: 'degraded',
      confidence: 'ambiguous',
      reason: 'whatsapp_backoff_zero_attempts_with_disconnect_without_auth_loss_signal',
      evidence: baseEvidence,
    };
  }

  if (loggedOutHeuristic) {
    return {
      status: 'degraded',
      confidence: 'ambiguous',
      reason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
      evidence: baseEvidence,
    };
  }

  if (healthStatus === 'unhealthy') {
    return {
      status: 'degraded',
      confidence: 'confirmed',
      reason: 'health_body_unhealthy',
      evidence: baseEvidence,
    };
  }

  if (healthStatus === 'degraded') {
    return {
      status: 'degraded',
      confidence: 'confirmed',
      reason: 'health_body_degraded',
      evidence: baseEvidence,
    };
  }

  return {
    status: 'online',
    confidence: 'confirmed',
    reason: 'health_body_ok',
    evidence: baseEvidence,
  };
}

function isNonOnlineClassification(
  classification: HealthSnapshotClassification,
): classification is HealthSnapshotClassification & { status: 'degraded' | 'logged_out' } {
  return classification.status !== 'online';
}

export class HealthPoller {
  private statuses: Map<string, InstanceStatus> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private getInstances: () => Map<string, InstanceHealth>;
  private selfName: string;
  private getSelfHealth: () => Record<string, unknown>;
  private intervalMs: number;
  private statusChangeListeners: StatusChangeCallback[] = [];
  private persistedAlertThrottle: Map<string, string>;
  private alertThrottleLoadErrorCode: string | null;

  constructor(
    getInstances: () => Map<string, InstanceHealth>,
    selfName: string,
    getSelfHealth: () => Record<string, unknown>,
    intervalMs = 5_000,
  ) {
    this.getInstances = getInstances;
    this.selfName = selfName;
    this.getSelfHealth = getSelfHealth;
    this.intervalMs = intervalMs;
    const throttle = loadAlertThrottleDetailed();
    this.persistedAlertThrottle = throttle.entries;
    this.alertThrottleLoadErrorCode = throttle.loadError?.code ?? (throttle.loadError ? 'UNKNOWN' : null);
  }

  /** Register a callback for instance status changes. */
  on(event: 'statusChange', callback: StatusChangeCallback): void {
    if (event === 'statusChange') this.statusChangeListeners.push(callback);
  }

  private emitStatusChange(instance: string, newStatus: InstanceStatus['status'], oldStatus: InstanceStatus['status']): void {
    for (const cb of this.statusChangeListeners) {
      try {
        cb(instance, newStatus, oldStatus);
      } catch (err) {
        log.warn({ err, instance, newStatus, oldStatus }, 'status change listener failed');
      }
    }
  }

  /**
   * Start polling. Returns a Promise that resolves once the initial poll
   * completes, so callers (especially tests) can await deterministic readiness
   * instead of sleeping. Subsequent polls are fire-and-forget on the interval.
   */
  start(): Promise<void> {
    const initial = this.poll(); // initial poll
    this.pollInterval = setInterval(() => this.poll(), this.intervalMs);
    this.pollInterval.unref();
    return initial;
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  getStatuses(): Map<string, InstanceStatus> {
    return this.statuses;
  }

  getStatus(name: string): InstanceStatus | undefined {
    return this.statuses.get(name);
  }

  private lastAlertAtFor(name: string, existing: InstanceStatus | undefined): string | null {
    return existing?.lastAlertAt ?? this.persistedAlertThrottle.get(name) ?? null;
  }

  private async poll(): Promise<void> {
    const instances = this.getInstances();

    const promises = Array.from(instances.entries()).map(async ([name, inst]) => {
      if (name === this.selfName) {
        // Self-instance: use callback, no HTTP
        try {
          const health = this.getSelfHealth();
          const existing = this.statuses.get(name);
          this.statuses.set(name, {
            name,
            health,
            lastPollAt: new Date().toISOString(),
            consecutiveFailures: 0,
            status: 'online',
            statusConfidence: 'confirmed',
            statusReason: 'self_health_callback',
            statusEvidence: ['self_health_callback=ok'],
            error: null,
            lastAlertAt: this.lastAlertAtFor(name, existing),
            silencedUntil: existing?.silencedUntil ?? null,
          });
        } catch (err) {
          this.updateFailure(name, (err as Error).message);
        }
        return;
      }

      // Remote instance: HTTP poll
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3_000);

        const headers: Record<string, string> = {};
        if (inst.healthToken) {
          headers['Authorization'] = `Bearer ${inst.healthToken}`;
        }

        let health: Record<string, unknown>;
        try {
          const res = await fetch(`http://127.0.0.1:${inst.healthPort}/health`, {
            signal: controller.signal,
            headers,
          });

          if (!res.ok) {
            const parsed = await this.parseHealthBody(res);
            if (parsed) {
              const classification = classifyHealthSnapshot(parsed);
              if (!isNonOnlineClassification(classification)) {
                this.updateFailure(name, `HTTP ${res.status}`);
                return;
              }
              this.updateFromHealthSnapshot(name, parsed, classification);
              return;
            }
            this.updateFailure(name, `HTTP ${res.status}`);
            return;
          }

          health = (await res.json()) as Record<string, unknown>;
        } finally {
          clearTimeout(timeout);
        }

        const classification = classifyHealthSnapshot(health);
        if (isNonOnlineClassification(classification)) {
          this.updateFromHealthSnapshot(name, health, classification);
          return;
        }

        const prevStatus = this.statuses.get(name)?.status ?? 'online';
        const existing = this.statuses.get(name);
        this.statuses.set(name, {
          name,
          health,
          lastPollAt: new Date().toISOString(),
          consecutiveFailures: 0,
          status: 'online',
          statusConfidence: classification.confidence,
          statusReason: classification.reason,
          statusEvidence: classification.evidence,
          error: null,
          lastAlertAt: this.lastAlertAtFor(name, existing),
          silencedUntil: existing?.silencedUntil ?? null,
        });
        if (prevStatus !== 'online') {
          this.emitStatusChange(name, 'online', prevStatus);
        }
      } catch (err) {
        this.updateFailure(name, (err as Error).message);
      }
    });

    await Promise.allSettled(promises);

    const discoveredNames = new Set(instances.keys());
    for (const name of this.statuses.keys()) {
      if (!discoveredNames.has(name)) {
        this.statuses.delete(name);
      }
    }
  }

  private async parseHealthBody(res: Response): Promise<Record<string, unknown> | null> {
    try {
      const parsed = await res.json();
      return recordValue(parsed) ?? null;
    } catch {
      return null;
    }
  }

  private updateFailure(name: string, error: string): void {
    const existing = this.statuses.get(name);
    const prevStatus = existing?.status ?? 'online';
    const failures = (existing?.consecutiveFailures ?? 0) + 1;
    const newStatus: InstanceStatus['status'] = failures >= 3 ? 'unreachable' : 'degraded';
    const confidence: StatusConfidence = newStatus === 'unreachable' ? 'confirmed' : 'inferred';

    log.warn({ name, failures, error }, 'instance health poll failed');
    this.statuses.set(name, {
      name,
      health: existing?.health ?? null,
      lastPollAt: new Date().toISOString(),
      consecutiveFailures: failures,
      status: newStatus,
      statusConfidence: confidence,
      statusReason: newStatus === 'unreachable' ? 'health_poll_failed_threshold' : 'health_poll_failed_transient',
      statusEvidence: [`consecutive_failures=${failures}`, `error=${error}`],
      error,
      lastAlertAt: this.lastAlertAtFor(name, existing),
      silencedUntil: existing?.silencedUntil ?? null,
    });

    // Notify listeners on any status transition
    if (newStatus !== prevStatus) {
      this.emitStatusChange(name, newStatus, prevStatus);
    }

    // Emit alert on transition into unreachable (exactly when failures crosses 2→3)
    if (newStatus === 'unreachable' && prevStatus !== 'unreachable') {
      this.maybeEmitAlert(name, 'instance_unreachable',
        `whatsoup@${name} unreachable (${failures} consecutive poll failures)`,
        `Last error: ${error}`,
      );
    }
  }

  private updateDegraded(
    name: string,
    health: Record<string, unknown>,
    newStatus: 'degraded' | 'logged_out',
    confidence: StatusConfidence,
    reason: string,
    evidence: string[],
  ): void {
    const existing = this.statuses.get(name);
    const prevStatus = existing?.status ?? 'online';

    this.statuses.set(name, {
      name,
      health,
      lastPollAt: new Date().toISOString(),
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      status: newStatus,
      statusConfidence: confidence,
      statusReason: reason,
      statusEvidence: evidence,
      error: null,
      lastAlertAt: this.lastAlertAtFor(name, existing),
      silencedUntil: existing?.silencedUntil ?? null,
    });

    if (newStatus !== prevStatus) {
      this.emitStatusChange(name, newStatus, prevStatus);
    }

    if (newStatus === 'logged_out' && prevStatus !== 'logged_out') {
      this.maybeEmitAlert(name, 'instance_logged_out',
        `whatsoup@${name} appears logged out`,
        [`confidence=${confidence}`, `reason=${reason}`, ...evidence].join(' '),
      );
    } else if (newStatus === 'degraded' && prevStatus !== 'degraded') {
      this.maybeEmitAlert(name, 'instance_degraded',
        `whatsoup@${name} is degraded`,
        [`confidence=${confidence}`, `reason=${reason}`, ...evidence].join(' '),
      );
    }
  }

  private updateFromHealthSnapshot(
    name: string,
    health: Record<string, unknown>,
    classification: HealthSnapshotClassification & { status: 'degraded' | 'logged_out' },
  ): void {
    this.updateDegraded(
      name,
      health,
      classification.status,
      classification.confidence,
      classification.reason,
      classification.evidence,
    );
  }

  private maybeEmitAlert(name: string, source: string, summary: string, evidence: string): void {
    if (isInstanceSilenced(name)) {
      log.info({ name, source }, 'alert suppressed — instance is silenced');
      return;
    }

    const existing = this.statuses.get(name);
    const lastAlertAt = existing?.lastAlertAt ?? null;
    if (lastAlertAt !== null) {
      const elapsed = Date.now() - new Date(lastAlertAt).getTime();
      if (elapsed < MIN_ALERT_INTERVAL_MS) {
        log.info({ name, source, elapsed }, 'alert suppressed — rate limit (15min)');
        return;
      }
    }

    // Set lastAlertAt BEFORE emitting to prevent races
    if (existing) {
      const now = new Date().toISOString();
      existing.lastAlertAt = now;
      this.persistedAlertThrottle.set(name, now);
      try {
        recordAlertThrottle(name, now);
      } catch (err) {
        log.warn({ err, name, source }, 'failed to persist alert throttle');
      }
    }

    const throttleEvidence = this.alertThrottleLoadErrorCode
      ? `${evidence} alert_throttle_load_error=true alert_throttle_load_error_code=${this.alertThrottleLoadErrorCode}`
      : evidence;
    emitAlert(name, source, summary, throttleEvidence);
  }
}
