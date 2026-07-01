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
  /**
   * Retention window for the diagnostic `decryption_failures` table (QR-066).
   * Each distinct undecryptable message_id creates a row that is only ever
   * flipped `resolved`, never deleted — so without this the table grew
   * unbounded (a slow disk leak under a prolonged Signal desync). Keyed on
   * `last_seen_at`, so a still-recurring failure (seen_count incrementing) is
   * preserved; only rows with no activity past the window are reaped. Stays
   * well above the heal degradation-signal horizon (5 min, see core/heal.ts).
   */
  decryptionFailureDays: number;
}

export interface DatabaseRetentionResult {
  inboundEvents: number;
  outboundOps: number;
  toolCalls: number;
  factExportQueue: number;
  metricsHourly: number;
  decryptionFailures: number;
}

export const DEFAULT_DATABASE_RETENTION: DatabaseRetentionConfig = {
  intervalMs: 24 * 60 * 60 * 1000,
  terminalDurabilityDays: 30,
  exportedFactDays: 30,
  metricsHourlyDays: 180,
  decryptionFailureDays: 30,
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

  // QR-066: decryption_failures gets one row per distinct undecryptable
  // message_id (resolved rows are only flagged, never deleted), so it must be
  // pruned like its sibling terminal tables or it grows unbounded. Reap rows
  // with no activity past the window (last_seen_at), keeping a still-recurring
  // failure alive; a NULL last_seen_at (shouldn't occur — schema DEFAULTs it)
  // is also reaped so junk can't leak (mirrors the metrics_hourly NULL branch).
  const decryptionFailureCutoff = daysModifier(retention.decryptionFailureDays);
  const decryptionFailures = changes(db.raw.prepare(`
    DELETE FROM decryption_failures
     WHERE last_seen_at IS NULL
        OR datetime(last_seen_at) < datetime('now', ?)
  `).run(decryptionFailureCutoff));

  const result = { inboundEvents, outboundOps, toolCalls, factExportQueue, metricsHourly, decryptionFailures };
  const total = inboundEvents + outboundOps + toolCalls + factExportQueue + metricsHourly + decryptionFailures;
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
