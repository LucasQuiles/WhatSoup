import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { withTransaction } from './db-tx.ts';
import { deleteOldMessages } from './messages.ts';
import { maintainOutboundSends } from './outbound-sends.ts';

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
  /** Age bound for content-free terminal memory-consolidation receipts. */
  memoryConsolidationDays: number;
  /** Hard terminal-row cap; values below the 100-row recovery floor become 100. */
  memoryConsolidationMaxRows: number;
  /** Age bound for terminal metadata-only outbound audit evidence. */
  outboundSendDays: number;
  /** Hard cap for terminal outbound audit evidence; unresolved intents are excluded. */
  outboundSendMaxRows: number;
  /**
   * Retention window for the `messages` table and its orphaned `receipts`
   * rows (#1445 QR-012). Folded in from the standalone main.ts setInterval
   * that used to call `deleteOldMessages` directly, outside this sweep —
   * that path is retired; this is now the sole place messages/receipts
   * retention runs. Callers that need the operator-configured window (e.g.
   * `config.retentionDays`) must pass it through explicitly, same as every
   * other field here — this default is just the fallback.
   */
  messageRetentionDays: number;
}

export interface DatabaseRetentionResult {
  turnRecoveryJobs: number;
  turnTerminalRecords: number;
  inboundEvents: number;
  outboundOps: number;
  toolCalls: number;
  outboundSends: number;
  factExportQueue: number;
  memoryConsolidationRuns: number;
  metricsHourly: number;
  decryptionFailures: number;
  messages: number;
}

export interface DatabaseRetentionHealth {
  running: boolean;
  state: 'not_run' | 'succeeded' | 'failed';
  consecutiveFailures: number;
  failureCode: 'retention_failed' | null;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastResult: DatabaseRetentionResult | null;
}

export const DEFAULT_DATABASE_RETENTION: DatabaseRetentionConfig = {
  intervalMs: 24 * 60 * 60 * 1000,
  terminalDurabilityDays: 30,
  exportedFactDays: 30,
  metricsHourlyDays: 180,
  decryptionFailureDays: 30,
  memoryConsolidationDays: 30,
  memoryConsolidationMaxRows: 10_000,
  outboundSendDays: 30,
  outboundSendMaxRows: 10_000,
  messageRetentionDays: 30,
};

/**
 * Unsafe-delivery and legacy quarantine evidence needs a longer operator
 * review window than terminal rows proven never to have reached a provider.
 */
export const OUTBOUND_QUARANTINE_EXTENDED_RETENTION_DAYS = 90;

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
  const extendedQuarantineCutoff = daysModifier(Math.max(
    retention.terminalDurabilityDays,
    OUTBOUND_QUARANTINE_EXTENDED_RETENTION_DAYS,
  ));
  const factCutoff = daysModifier(retention.exportedFactDays);

  const result = withTransaction(db, () => {
    const completedRecoveryTerminals = db.raw.prepare(`
      DELETE FROM turn_recovery_jobs
       WHERE state = 'completed'
         AND completed_at < datetime('now', ?)
         AND NOT EXISTS (
           SELECT 1
           FROM operator_catchup_closure_witnesses witness
           WHERE witness.recovery_job_id = turn_recovery_jobs.id
         )
         AND EXISTS (
           SELECT 1
           FROM inbound_events i
           WHERE i.seq = turn_recovery_jobs.source_inbound_seq
             AND i.message_id = turn_recovery_jobs.source_message_id
             AND i.conversation_key = turn_recovery_jobs.conversation_key
             AND i.chat_jid = turn_recovery_jobs.delivery_jid
             AND i.processing_status IN ('complete', 'failed')
         )
         AND EXISTS (
           SELECT 1
           FROM turn_terminal_records t
           JOIN outbound_ops o ON o.id = t.delivery_op_id
           WHERE t.id = turn_recovery_jobs.terminal_record_id
             AND t.inbound_disposition = 'transferred_to_recovery_owner'
             AND t.scope = turn_recovery_jobs.scope
             AND t.inbound_seq = turn_recovery_jobs.source_inbound_seq
             AND t.conversation_key = turn_recovery_jobs.conversation_key
             AND t.delivery_jid = turn_recovery_jobs.delivery_jid
             AND o.source_inbound_seq = turn_recovery_jobs.source_inbound_seq
             AND o.conversation_key = turn_recovery_jobs.conversation_key
             AND o.chat_jid = turn_recovery_jobs.delivery_jid
             AND o.status IN ('echoed', 'failed_permanent', 'quarantined')
         )
      RETURNING terminal_record_id
    `).all(terminalCutoff) as Array<{ terminal_record_id: number }>;
    const turnRecoveryJobs = completedRecoveryTerminals.length;

    const deleteCompletedRecoveryTerminal = db.raw.prepare(`
      DELETE FROM turn_terminal_records
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM turn_recovery_jobs
          WHERE terminal_record_id = turn_terminal_records.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM turn_delivery_corroboration
          WHERE terminal_record_id = turn_terminal_records.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM inbound_disposition_links
          WHERE superseded_by_seq = turn_terminal_records.inbound_seq
        )
    `);
    let turnTerminalRecords = 0;
    for (const { terminal_record_id: terminalRecordId } of completedRecoveryTerminals) {
      turnTerminalRecords += changes(deleteCompletedRecoveryTerminal.run(terminalRecordId));
    }

    turnTerminalRecords += changes(db.raw.prepare(`
      DELETE FROM turn_terminal_records
       WHERE created_at < datetime('now', ?)
         AND inbound_disposition IN (
           'finalized_replied', 'finalized_no_reply_policy', 'failed_terminal'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM turn_recovery_jobs
            WHERE terminal_record_id = turn_terminal_records.id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM turn_delivery_corroboration
            WHERE terminal_record_id = turn_terminal_records.id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM inbound_disposition_links
            WHERE superseded_by_seq = turn_terminal_records.inbound_seq
         )
         AND (
           (
             inbound_seq IS NULL
             AND inbound_disposition = 'finalized_no_reply_policy'
           )
           OR EXISTS (
             SELECT 1
             FROM inbound_events
             WHERE seq = turn_terminal_records.inbound_seq
               AND processing_status IN ('complete', 'failed')
           )
         )
    `).run(terminalCutoff));

    const inboundEvents = changes(db.raw.prepare(`
      DELETE FROM inbound_events
       WHERE processing_status IN ('complete', 'failed')
         AND COALESCE(completed_at, received_at) < datetime('now', ?)
         AND NOT EXISTS (
           SELECT 1
             FROM turn_recovery_jobs
            WHERE source_inbound_seq = inbound_events.seq
         )
         AND NOT EXISTS (
           SELECT 1
             FROM turn_terminal_records
            WHERE inbound_seq = inbound_events.seq
         )
         AND NOT EXISTS (
           SELECT 1
             FROM inbound_disposition_links
            WHERE inbound_seq = inbound_events.seq
               OR superseded_by_seq = inbound_events.seq
         )
    `).run(terminalCutoff));

    const outboundOps = changes(db.raw.prepare(`
      DELETE FROM outbound_ops
       WHERE status IN ('echoed', 'failed_permanent', 'quarantined')
         AND CASE
           WHEN status = 'quarantined' THEN CASE
             -- An ambiguous or legacy quarantine remains an open incident
            -- until the reviewed retirement command records its acknowledgement.
            WHEN quarantine_disposition IN (
              'delivery_not_attempted',
              'stale_status_discarded'
            )
               THEN COALESCE(quarantined_at, created_at) < datetime('now', ?)
             ELSE 0
           END
           WHEN status = 'failed_permanent' AND quarantined_at IS NOT NULL THEN CASE
             -- A terminalized quarantine is not resolved until a valid bounded
             -- retirement receipt ties its disposition, acknowledgement, and
             -- canonical evidence digest together.
             WHEN EXISTS (
               SELECT 1
                 FROM outbound_quarantine_retirements retirement
                WHERE retirement.outbound_op_id = outbound_ops.id
                  AND retirement.quarantine_disposition = outbound_ops.quarantine_disposition
                  AND (
                    (retirement.quarantine_disposition = 'delivery_ambiguous_unsafe'
                      AND retirement.acknowledgement = 'delivery-risk-reviewed')
                    OR (retirement.quarantine_disposition = 'record_unreconstructable'
                      AND retirement.acknowledgement = 'record-reconstruction-reviewed')
                    OR (retirement.quarantine_disposition IN ('delivery_not_attempted', 'stale_status_discarded')
                      AND retirement.acknowledgement = 'none')
                  )
                  AND retirement.evidence_sha256 = outbound_ops.quarantine_evidence_sha256
                  AND length(outbound_ops.quarantine_evidence_sha256) = 64
                  AND outbound_ops.quarantine_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
                  AND length(retirement.evidence_sha256) = 64
                  AND retirement.evidence_sha256 NOT GLOB '*[^0-9a-f]*'
             ) THEN CASE
               WHEN quarantine_disposition IN (
                 'delivery_not_attempted',
                 'record_unreconstructable',
                 'stale_status_discarded'
               )
                 THEN COALESCE(quarantined_at, created_at) < datetime('now', ?)
               ELSE COALESCE(quarantined_at, created_at) < datetime('now', ?)
             END
             ELSE 0
           END
           ELSE created_at < datetime('now', ?)
         END
         AND NOT EXISTS (
           SELECT 1
             FROM turn_terminal_records
            WHERE delivery_op_id = outbound_ops.id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM turn_delivery_corroboration
            WHERE corroborating_op_id = outbound_ops.id
         )
    `).run(
      terminalCutoff,
      terminalCutoff,
      extendedQuarantineCutoff,
      terminalCutoff,
    ));

    const toolCalls = changes(db.raw.prepare(`
      DELETE FROM tool_calls
       WHERE status IN ('complete', 'error', 'replayed', 'quarantined')
         AND COALESCE(completed_at, created_at) < datetime('now', ?)
    `).run(terminalCutoff));

    const outboundSends = maintainOutboundSends(db.raw, {
      mode: 'apply',
      terminalDays: retention.outboundSendDays,
      terminalMaxRows: retention.outboundSendMaxRows,
    }).deletedRows;

    const factExportQueue = changes(db.raw.prepare(`
      DELETE FROM fact_export_queue
       WHERE status = 'exported'
         AND COALESCE(exported_at, created_at) < datetime('now', ?)
    `).run(factCutoff));

    const memoryConsolidationMaxAgeMs =
      Math.max(1, Math.floor(retention.memoryConsolidationDays)) * 86_400_000;
    const memoryConsolidationMaxRows = Math.max(
      100,
      Math.floor(retention.memoryConsolidationMaxRows),
    );
    const memoryConsolidationRuns = changes(db.raw.prepare(`
      DELETE FROM memory_consolidation_runs
       WHERE completed_at IS NOT NULL
         AND (
           (
             completed_at
               < CAST(strftime('%s', 'now') AS INTEGER) * 1000 - ?
             AND run_id NOT IN (
               SELECT run_id
                 FROM memory_consolidation_runs
                WHERE completed_at IS NOT NULL
                ORDER BY attempted_at DESC, run_id DESC
                LIMIT 100
             )
           )
           OR run_id IN (
             SELECT run_id
               FROM memory_consolidation_runs
              WHERE completed_at IS NOT NULL
              ORDER BY attempted_at DESC, run_id DESC
              LIMIT -1 OFFSET ?
           )
         )
    `).run(memoryConsolidationMaxAgeMs, memoryConsolidationMaxRows));

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

    // #1445 QR-012: messages + their orphaned receipts (#1772), unified from
    // the standalone main.ts setInterval into this single sweep. Behavior is
    // unchanged — same cutoff math, same orphan-receipts cleanup — only the
    // location moved.
    const messages = deleteOldMessages(db, retention.messageRetentionDays);

    return {
      turnRecoveryJobs,
      turnTerminalRecords,
      inboundEvents,
      outboundOps,
      toolCalls,
      outboundSends,
      factExportQueue,
      memoryConsolidationRuns,
      metricsHourly,
      decryptionFailures,
      messages,
    };
  });
  const total = Object.values(result).reduce((sum, count) => sum + count, 0);
  if (total > 0) {
    log.info({ ...result, total }, 'database retention: deleted old terminal rows');
  }
  return result;
}

export class DatabaseRetentionTimer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private db: Database;
  private retention: DatabaseRetentionConfig;
  private lastRunAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastResult: DatabaseRetentionResult | null = null;
  private state: DatabaseRetentionHealth['state'] = 'not_run';
  private consecutiveFailures = 0;
  private failureCode: DatabaseRetentionHealth['failureCode'] = null;

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

  getHealthSnapshot(): DatabaseRetentionHealth {
    return {
      running: this.timer !== null,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failureCode: this.failureCode,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastResult: this.lastResult === null ? null : { ...this.lastResult },
    };
  }

  async runCleanup(): Promise<DatabaseRetentionResult> {
    this.lastRunAt = Date.now();
    try {
      const result = runDatabaseRetention(this.db, this.retention);
      this.lastSuccessAt = Date.now();
      this.lastResult = { ...result };
      this.state = 'succeeded';
      this.consecutiveFailures = 0;
      this.failureCode = null;
      return result;
    } catch (err) {
      this.lastFailureAt = Date.now();
      this.state = 'failed';
      this.consecutiveFailures = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.consecutiveFailures + 1,
      );
      this.failureCode = 'retention_failed';
      throw err;
    }
  }
}
