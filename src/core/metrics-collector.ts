import type { Database } from './database.ts';

interface HourWindow {
  bucket: string;
  startSec: number;
  endSec: number;
}

const METRIC_NAMES = ['messages_in', 'messages_out', 'messages_media'] as const;
type MetricName = typeof METRIC_NAMES[number];

function toHourWindow(now: Date): HourWindow {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);

  return {
    bucket: start.toISOString(),
    startSec: Math.floor(start.getTime() / 1000),
    endSec: Math.floor((start.getTime() + 60 * 60 * 1000) / 1000),
  };
}

function countMessages(
  db: Database,
  sql: string,
  ...params: Array<number | string>
): number {
  const row = db.raw.prepare(sql).get(...params) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function upsertMetric(db: Database, bucket: string, metric: MetricName, value: number): void {
  db.raw.prepare(`
    INSERT INTO metrics_hourly (bucket, metric, value)
    VALUES (?, ?, ?)
    ON CONFLICT(bucket, metric) DO UPDATE SET value = excluded.value
  `).run(bucket, metric, value);
}

function collectMetricsForWindow(db: Database, window: HourWindow): void {
  const { bucket, startSec, endSec } = window;

  const messagesIn = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM messages
      WHERE timestamp >= ? AND timestamp < ? AND is_from_me = 0`,
    startSec,
    endSec,
  );

  const messagesOut = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM messages
      WHERE timestamp >= ? AND timestamp < ? AND is_from_me = 1`,
    startSec,
    endSec,
  );

  const messagesMedia = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM messages
      WHERE timestamp >= ? AND timestamp < ?
        AND content_type IN ('image', 'audio', 'document', 'video', 'sticker')`,
    startSec,
    endSec,
  );

  upsertMetric(db, bucket, 'messages_in', messagesIn);
  upsertMetric(db, bucket, 'messages_out', messagesOut);
  upsertMetric(db, bucket, 'messages_media', messagesMedia);
}

/** Aggregate the current UTC hour and upsert the three Phase 5 baseline metrics. */
export function collectHourlyMetrics(db: Database, now = new Date()): void {
  collectMetricsForWindow(db, toHourWindow(now));
}

/**
 * Backfill historical hourly buckets for the requested lookback window.
 * Only hours containing at least one message are materialized.
 */
export function backfillMetrics(db: Database, days = 30, now = new Date()): void {
  const currentHour = toHourWindow(now);
  const lookbackHours = Math.max(1, Math.floor(days * 24));
  const lookbackStartSec = currentHour.startSec - ((lookbackHours - 1) * 60 * 60);

  const hourRows = db.raw.prepare(`
    SELECT DISTINCT CAST(timestamp / 3600 AS INTEGER) AS hour_bucket
      FROM messages
     WHERE timestamp >= ? AND timestamp < ?
     ORDER BY hour_bucket
  `).all(lookbackStartSec, currentHour.endSec) as Array<{ hour_bucket: number }>;

  if (hourRows.length === 0) return;

  db.raw.exec('BEGIN');
  try {
    for (const row of hourRows) {
      const bucketStartSec = row.hour_bucket * 3600;
      collectMetricsForWindow(db, {
        bucket: new Date(bucketStartSec * 1000).toISOString(),
        startSec: bucketStartSec,
        endSec: bucketStartSec + 3600,
      });
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}
