import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';

const log = createChildLogger('database:retention');

export interface DatabaseRetentionConfig {
  intervalMs: number;
  terminalDurabilityDays: number;
  exportedFactDays: number;
}

export interface DatabaseRetentionResult {
  inboundEvents: number;
  outboundOps: number;
  toolCalls: number;
  factExportQueue: number;
}

export const DEFAULT_DATABASE_RETENTION: DatabaseRetentionConfig = {
  intervalMs: 24 * 60 * 60 * 1000,
  terminalDurabilityDays: 30,
  exportedFactDays: 30,
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

  const result = { inboundEvents, outboundOps, toolCalls, factExportQueue };
  const total = inboundEvents + outboundOps + toolCalls + factExportQueue;
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
