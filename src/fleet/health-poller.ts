import { createChildLogger } from '../logger.ts';
import { emitAlert } from '../lib/emit-alert.ts';
import { ALERT_THROTTLE_INTERVAL_MS, loadAlertThrottle, recordAlertThrottle } from './alert-throttle-store.ts';
import { isInstanceSilenced } from './silence-manager.ts';

const log = createChildLogger('fleet:health-poller');

const MIN_ALERT_INTERVAL_MS = ALERT_THROTTLE_INTERVAL_MS;

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
  error: string | null;
  lastAlertAt: string | null;
  silencedUntil: string | null;
}

export type StatusChangeCallback = (instance: string, newStatus: InstanceStatus['status'], oldStatus: InstanceStatus['status']) => void;

export class HealthPoller {
  private statuses: Map<string, InstanceStatus> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private getInstances: () => Map<string, InstanceHealth>;
  private selfName: string;
  private getSelfHealth: () => Record<string, unknown>;
  private intervalMs: number;
  private statusChangeListeners: StatusChangeCallback[] = [];
  private persistedAlertThrottle: Map<string, string>;

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
    this.persistedAlertThrottle = loadAlertThrottle();
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
            this.updateFailure(name, `HTTP ${res.status}`);
            return;
          }

          health = (await res.json()) as Record<string, unknown>;
        } finally {
          clearTimeout(timeout);
        }

        // Detect logged-out: backoff phase with zero attempts means fresh logout
        const waConn = (health as any)?.whatsapp?.connection;
        const isLoggedOut =
          waConn?.reconnect_phase === 'backoff' && waConn?.reconnect_attempts === 0;

        // HTTP 200 but body signals unhealthy → treat as degraded
        if (health['status'] === 'unhealthy' || isLoggedOut) {
          const derivedStatus = isLoggedOut ? 'logged_out' as const : 'degraded' as const;
          this.updateDegraded(name, health, derivedStatus);
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

  private updateFailure(name: string, error: string): void {
    const existing = this.statuses.get(name);
    const prevStatus = existing?.status ?? 'online';
    const failures = (existing?.consecutiveFailures ?? 0) + 1;
    const newStatus: InstanceStatus['status'] = failures >= 3 ? 'unreachable' : 'degraded';

    log.warn({ name, failures, error }, 'instance health poll failed');
    this.statuses.set(name, {
      name,
      health: existing?.health ?? null,
      lastPollAt: new Date().toISOString(),
      consecutiveFailures: failures,
      status: newStatus,
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
  ): void {
    const existing = this.statuses.get(name);
    const prevStatus = existing?.status ?? 'online';

    this.statuses.set(name, {
      name,
      health,
      lastPollAt: new Date().toISOString(),
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      status: newStatus,
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
        `reconnect_phase=backoff reconnect_attempts=0`,
      );
    } else if (newStatus === 'degraded' && prevStatus !== 'degraded') {
      this.maybeEmitAlert(name, 'instance_degraded',
        `whatsoup@${name} is degraded`,
        `Health body reports status=unhealthy`,
      );
    }
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

    emitAlert(name, source, summary, evidence);
  }
}
