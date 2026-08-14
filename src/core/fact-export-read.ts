// Redacted fact-export queue reader (#2567 slice 2) — core layer so the MCP
// audit module can import it (mcp -> runtimes is a forbidden boundary edge).
// Pure DB projection: counts, ages, attempt distribution, and opaque-uid rows.
import type { Database } from './database.ts';
import { queryAll, queryOne } from '../lib/db-query.ts';
import { systemClock } from '../lib/clock.ts';
/** Redacted per-row projection for the operator reader — opaque uid, state,
 * attempt accounting, and stable failure codes only. The identity-bearing
 * fact_id, chat/sender JIDs, payload JSON, and lease owner never cross. */
export interface RedactedFactExportRow {
  fact_uid: string;
  state: string;
  attempt_count: number;
  failure_code: string | null;
  failure_stage: string | null;
  created_at: string;
  next_attempt_at: number | null;
  acked_at: number | null;
}

export interface FactExportQueueSummary {
  counts: Record<string, number>;
  oldest_pending_age_s: number;
  latest_ack_age_s: number | null;
  attempt_histogram: Record<string, number>;
}

export interface ListFactExportQueueOptions {
  state?: string;
  limit?: number;
  nowUnixSec?: number;
}

/**
 * Redacted operator reader (#2567 slice 2). The summary always covers the
 * whole queue (counts by state, oldest pending age, latest ack age, attempt
 * distribution over non-terminal rows); rows are bounded (limit clamp 1..200,
 * default 50, optional state filter), oldest-first.
 */
export function listFactExportQueueRedacted(
  db: Database,
  opts: ListFactExportQueueOptions = {},
): { summary: FactExportQueueSummary; rows: RedactedFactExportRow[] } {
  const now = opts.nowUnixSec ?? systemClock.nowUnixSec();

  const counts: Record<string, number> = {};
  for (const row of queryAll<{ state: string; n: number }>(
    db.raw,
    'SELECT state, COUNT(*) AS n FROM fact_export_queue GROUP BY state',
  )) {
    counts[row.state] = row.n;
  }
  const oldestPending = queryOne<{ t: number | null }>(
    db.raw,
    `SELECT MIN(CAST(strftime('%s', created_at) AS INTEGER)) AS t
       FROM fact_export_queue WHERE state = 'pending'`,
  )?.t ?? null;
  const latestAck = queryOne<{ t: number | null }>(
    db.raw,
    'SELECT MAX(acked_at) AS t FROM fact_export_queue',
  )?.t ?? null;
  const attemptHistogram: Record<string, number> = {};
  for (const row of queryAll<{ attempt_count: number; n: number }>(
    db.raw,
    `SELECT attempt_count, COUNT(*) AS n FROM fact_export_queue
      WHERE attempt_count > 0 AND state IN ('pending', 'leased', 'retry_wait')
      GROUP BY attempt_count`,
  )) {
    attemptHistogram[String(row.attempt_count)] = row.n;
  }

  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const rows = opts.state
    ? queryAll<RedactedFactExportRow>(
        db.raw,
        `SELECT fact_uid, state, attempt_count, failure_code, failure_stage, created_at, next_attempt_at, acked_at
           FROM fact_export_queue WHERE state = ? ORDER BY id LIMIT ?`,
        opts.state,
        limit,
      )
    : queryAll<RedactedFactExportRow>(
        db.raw,
        `SELECT fact_uid, state, attempt_count, failure_code, failure_stage, created_at, next_attempt_at, acked_at
           FROM fact_export_queue ORDER BY id LIMIT ?`,
        limit,
      );

  return {
    summary: {
      counts,
      oldest_pending_age_s: oldestPending == null ? 0 : Math.max(0, now - oldestPending),
      latest_ack_age_s: latestAck == null ? null : Math.max(0, now - latestAck),
      attempt_histogram: attemptHistogram,
    },
    rows,
  };
}
