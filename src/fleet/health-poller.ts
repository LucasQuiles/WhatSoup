import { createChildLogger } from '../logger.ts';
import { emitAlert } from '../lib/emit-alert.ts';

const log = createChildLogger('fleet:health-poller');

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
  status: 'online' | 'degraded' | 'unreachable';
  error: string | null;
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
  }

  /** Register a callback for instance status changes. */
  on(event: 'statusChange', callback: StatusChangeCallback): void {
    if (event === 'statusChange') this.statusChangeListeners.push(callback);
  }

  private emitStatusChange(instance: string, newStatus: InstanceStatus['status'], oldStatus: InstanceStatus['status']): void {
    for (const cb of this.statusChangeListeners) {
      try { cb(instance, newStatus, oldStatus); } catch { /* listener errors must not break poller */ }
    }
  }

  start(): void {
    this.poll(); // initial poll
    this.pollInterval = setInterval(() => this.poll(), this.intervalMs);
    this.pollInterval.unref();
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

  private async poll(): Promise<void> {
    const instances = this.getInstances();

    const promises = Array.from(instances.entries()).map(async ([name, inst]) => {
      if (name === this.selfName) {
        // Self-instance: use callback, no HTTP
        try {
          const health = this.getSelfHealth();
          this.statuses.set(name, {
            name,
            health,
            lastPollAt: new Date().toISOString(),
            consecutiveFailures: 0,
            status: 'online',
            error: null,
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

        const res = await fetch(`http://127.0.0.1:${inst.healthPort}/health`, {
          signal: controller.signal,
          headers,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          this.updateFailure(name, `HTTP ${res.status}`);
          return;
        }

        const health = (await res.json()) as Record<string, unknown>;
        const prevStatus = this.statuses.get(name)?.status ?? 'online';
        this.statuses.set(name, {
          name,
          health,
          lastPollAt: new Date().toISOString(),
          consecutiveFailures: 0,
          status: 'online',
          error: null,
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
    const newStatus = failures >= 3 ? 'unreachable' : 'degraded';

    log.warn({ name, failures, error }, 'instance health poll failed');
    this.statuses.set(name, {
      name,
      health: existing?.health ?? null,
      lastPollAt: new Date().toISOString(),
      consecutiveFailures: failures,
      status: newStatus,
      error,
    });

    // Notify listeners on any status transition
    if (newStatus !== prevStatus) {
      this.emitStatusChange(name, newStatus, prevStatus);
    }

    // Emit alert on transition into unreachable (exactly when failures crosses 2→3)
    if (newStatus === 'unreachable' && prevStatus !== 'unreachable') {
      emitAlert(name, 'instance_unreachable',
        `whatsoup@${name} unreachable (${failures} consecutive poll failures)`,
        `Last error: ${error}`,
      );
    }
  }
}
