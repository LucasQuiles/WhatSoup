import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';

const log = createChildLogger('database:retention');

export interface DatabaseRetentionConfig {
  intervalMs: number;
  terminalDurabilityDays: number;
  exportedFactDays: number;
  /**
   * Retention window for the append-only `metrics_hourly` rollup table.
   * Must stay above the dashboard reader's max lookback (720h / 30d, see
   * `src/fleet/db-reader.ts`) so pruning never removes a readable bucket.
   */
  metricsHourlyDays: number;
}

export interface DatabaseRetentionResult {
  inboundEvents: number;
  outboundOps: number;
  toolCalls: number;
  factExportQueue: number;
  metricsHourly: number;
}

export const DEFAULT_DATABASE_RETENTION: DatabaseRetentionConfig = {
  intervalMs: 24 * 60 * 60 * 1000,
  terminalDurabilityDays: 30,
  exportedFactDays: 30,
  metricsHourlyDays: 180,
};

function daysModifier(days: number): string {
  return `-${Math.max(1, Math.floor(days))} days`;
}

function changes(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

export function runDatabaseRetention(
  db: Database,
  retention: DatabaseRetentionConfig = DEFAULT_DATABASE_RETENTION,
): DatabaseRetentionResult {
  const terminalCutoff = daysModifier(retention.terminalDurabilityDays);
  const factCutoff = daysModifier(retention.exportedFactDays);

  const inboundEvents = changes(db.raw.prepare(`
    DELETE FROM inbound_events
     WHERE processing_status IN ('complete', 'failed')
       AND COALESCE(completed_at, received_at) < datetime('now', ?)
  `).run(terminalCutoff));

  const outboundOps = changes(db.raw.prepare(`
    DELETE FROM outbound_ops
     WHERE status IN ('echoed', 'failed_permanent', 'quarantined')
       AND created_at < datetime('now', ?)
  `).run(terminalCutoff));

  const toolCalls = changes(db.raw.prepare(`
    DELETE FROM tool_calls
     WHERE status IN ('complete', 'replayed', 'quarantined')
       AND COALESCE(completed_at, created_at) < datetime('now', ?)
  `).run(terminalCutoff));

  const factExportQueue = changes(db.raw.prepare(`
    DELETE FROM fact_export_queue
     WHERE status = 'exported'
       AND COALESCE(exported_at, created_at) < datetime('now', ?)
  `).run(factCutoff));

  // metrics_hourly is an append-only rollup keyed on an ISO-8601 `bucket`
  // (written via toISOString()); datetime(bucket) normalizes it for comparison.
  // A malformed/unparseable bucket makes datetime(bucket) NULL, and `NULL < x`
  // is falsy — so without the explicit NULL branch a junk row would NEVER be
  // pruned (a fail-open leak, the inverse of the bug this retention fixes). Junk
  // buckets are unreadable by the dashboard (it compares ISO strings), so prune
  // them too.
  const metricsCutoff = daysModifier(retention.metricsHourlyDays);
  const metricsHourly = changes(db.raw.prepare(`
    DELETE FROM metrics_hourly
     WHERE datetime(bucket) IS NULL
        OR datetime(bucket) < datetime('now', ?)
  `).run(metricsCutoff));

  const result = { inboundEvents, outboundOps, toolCalls, factExportQueue, metricsHourly };
  const total = inboundEvents + outboundOps + toolCalls + factExportQueue + metricsHourly;
  if (total > 0) {
    log.info({ ...result, total }, 'database retention: deleted old terminal rows');
  }
  return result;
}

export class DatabaseRetentionTimer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private db: Database;
  private retention: DatabaseRetentionConfig;

  constructor(
    db: Database,
    retention: DatabaseRetentionConfig = DEFAULT_DATABASE_RETENTION,
  ) {
    this.db = db;
    this.retention = retention;
  }

  start(intervalMs: number = this.retention.intervalMs): void {
    if (this.timer) return;

    this.runCleanup().catch((err) => log.error({ err }, 'database retention: immediate cleanup failed'));

    this.timer = setInterval(() => {
      this.runCleanup().catch((err) => log.error({ err }, 'database retention: periodic cleanup failed'));
    }, intervalMs);

    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runCleanup(): Promise<DatabaseRetentionResult> {
    return runDatabaseRetention(this.db, this.retention);
  }
}
