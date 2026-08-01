import type { Database } from './database.ts';
import { MS_PER_HOUR } from '../lib/time-units.ts';

interface HourWindow {
  bucket: string;
  startSec: number;
  endSec: number;
}

const METRIC_NAMES = [
  'messages_in', 'messages_out', 'messages_media',
  'agent_tokens_in', 'agent_tokens_out',
  'chat_tokens_in', 'chat_tokens_out',
  'sessions_started', 'sessions_active',
] as const;
type MetricName = typeof METRIC_NAMES[number];
const ACTIVE_MESSAGE_SQL = 'deleted_at IS NULL';

function toHourWindow(now: Date): HourWindow {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);

  return {
    bucket: start.toISOString(),
    startSec: Math.floor(start.getTime() / 1000),
    endSec: Math.floor((start.getTime() + MS_PER_HOUR) / 1000),
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

function sumColumn(
  db: Database,
  sql: string,
  ...params: Array<number | string>
): number {
  const row = db.raw.prepare(sql).get(...params) as { total: number | null } | undefined;
  return row?.total ?? 0;
}

function upsertMetric(db: Database, bucket: string, metric: string, value: number): void {
  db.raw.prepare(`
    INSERT INTO metrics_hourly (bucket, metric, value)
    VALUES (?, ?, ?)
    ON CONFLICT(bucket, metric) DO UPDATE SET value = excluded.value
  `).run(bucket, metric, value);
}

function querySessionMetrics(
  db: Database,
  startSec: number,
  endSec: number,
): { sessionsStarted: number; sessionsActive: number } {
  const sessionsStarted = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM agent_sessions
      WHERE unixepoch(started_at) >= ? AND unixepoch(started_at) < ?`,
    startSec,
    endSec,
  );
  const sessionsActive = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM agent_sessions
      WHERE unixepoch(started_at) < ?
        AND (ended_at IS NULL OR unixepoch(ended_at) > ?)
        AND status != 'suspended'`,
    endSec,
    startSec,
  );
  return { sessionsStarted, sessionsActive };
}

function queryTokenMetricsByProvider(
  db: Database,
  startSec: number,
  endSec: number,
): Map<string, { input: number; output: number }> {
  const rows = db.raw.prepare(`
    SELECT COALESCE(s.provider, 'claude-cli') AS provider,
           COALESCE(SUM(e.input_tokens), 0) AS total_in,
           COALESCE(SUM(e.output_tokens), 0) AS total_out
    FROM agent_token_events e
    JOIN agent_sessions s ON e.agent_session_id = s.id
    WHERE e.timestamp >= ? AND e.timestamp < ?
    GROUP BY s.provider
  `).all(startSec, endSec) as Array<{ provider: string; total_in: number; total_out: number }>;

  const map = new Map<string, { input: number; output: number }>();
  for (const row of rows) {
    map.set(row.provider, { input: row.total_in, output: row.total_out });
  }
  return map;
}

function querySessionMetricsByProvider(
  db: Database,
  startSec: number,
  endSec: number,
): Map<string, { started: number; active: number }> {
  const startedRows = db.raw.prepare(`
    SELECT COALESCE(provider, 'claude-cli') AS provider, COUNT(*) AS cnt
    FROM agent_sessions
    WHERE unixepoch(started_at) >= ? AND unixepoch(started_at) < ?
    GROUP BY provider
  `).all(startSec, endSec) as Array<{ provider: string; cnt: number }>;

  const activeRows = db.raw.prepare(`
    SELECT COALESCE(provider, 'claude-cli') AS provider, COUNT(*) AS cnt
    FROM agent_sessions
    WHERE unixepoch(started_at) < ?
      AND (ended_at IS NULL OR unixepoch(ended_at) > ?)
      AND status != 'suspended'
    GROUP BY provider
  `).all(endSec, startSec) as Array<{ provider: string; cnt: number }>;

  const map = new Map<string, { started: number; active: number }>();
  for (const row of startedRows) {
    const existing = map.get(row.provider) ?? { started: 0, active: 0 };
    existing.started = row.cnt;
    map.set(row.provider, existing);
  }
  for (const row of activeRows) {
    const existing = map.get(row.provider) ?? { started: 0, active: 0 };
    existing.active = row.cnt;
    map.set(row.provider, existing);
  }
  return map;
}

function collectMetricsForWindow(db: Database, window: HourWindow): void {
  const { bucket, startSec, endSec } = window;

  // ── Message metrics (existing) ──
  const messagesIn = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM messages
      WHERE timestamp >= ? AND timestamp < ?
        AND ${ACTIVE_MESSAGE_SQL}
        AND is_from_me = 0`,
    startSec,
    endSec,
  );

  const messagesOut = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM messages
      WHERE timestamp >= ? AND timestamp < ?
        AND ${ACTIVE_MESSAGE_SQL}
        AND is_from_me = 1`,
    startSec,
    endSec,
  );

  const messagesMedia = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM messages
      WHERE timestamp >= ? AND timestamp < ?
        AND ${ACTIVE_MESSAGE_SQL}
        AND content_type IN ('image', 'audio', 'document', 'video', 'sticker')`,
    startSec,
    endSec,
  );

  upsertMetric(db, bucket, 'messages_in', messagesIn);
  upsertMetric(db, bucket, 'messages_out', messagesOut);
  upsertMetric(db, bucket, 'messages_media', messagesMedia);

  // ── Token metrics ──
  const agentTokensIn = sumColumn(
    db,
    `SELECT SUM(input_tokens) AS total
       FROM agent_token_events
      WHERE timestamp >= ? AND timestamp < ?`,
    startSec,
    endSec,
  );

  const agentTokensOut = sumColumn(
    db,
    `SELECT SUM(output_tokens) AS total
       FROM agent_token_events
      WHERE timestamp >= ? AND timestamp < ?`,
    startSec,
    endSec,
  );

  const chatTokensIn = sumColumn(
    db,
    `SELECT SUM(input_tokens) AS total
       FROM messages
      WHERE timestamp >= ? AND timestamp < ? AND input_tokens > 0`,
    startSec,
    endSec,
  );

  const chatTokensOut = sumColumn(
    db,
    `SELECT SUM(output_tokens) AS total
       FROM messages
      WHERE timestamp >= ? AND timestamp < ? AND output_tokens > 0`,
    startSec,
    endSec,
  );

  upsertMetric(db, bucket, 'agent_tokens_in', agentTokensIn);
  upsertMetric(db, bucket, 'agent_tokens_out', agentTokensOut);
  upsertMetric(db, bucket, 'chat_tokens_in', chatTokensIn);
  upsertMetric(db, bucket, 'chat_tokens_out', chatTokensOut);

  const { sessionsStarted, sessionsActive } = querySessionMetrics(db, startSec, endSec);
  upsertMetric(db, bucket, 'sessions_started', sessionsStarted);
  upsertMetric(db, bucket, 'sessions_active', sessionsActive);

  // ── Per-provider token metrics ──
  const tokensByProvider = queryTokenMetricsByProvider(db, startSec, endSec);
  for (const [provider, totals] of tokensByProvider) {
    upsertMetric(db, bucket, `agent_tokens_in:${provider}`, totals.input);
    upsertMetric(db, bucket, `agent_tokens_out:${provider}`, totals.output);
  }

  // ── Per-provider session metrics ──
  const sessionsByProvider = querySessionMetricsByProvider(db, startSec, endSec);
  for (const [provider, counts] of sessionsByProvider) {
    upsertMetric(db, bucket, `sessions_started:${provider}`, counts.started);
    upsertMetric(db, bucket, `sessions_active:${provider}`, counts.active);
  }
}

/** Aggregate the current UTC hour and upsert the nine fleet metrics. */
export function collectHourlyMetrics(db: Database, now = new Date()): void {
  collectMetricsForWindow(db, toHourWindow(now));
}

/**
 * Backfill historical hourly buckets for the requested lookback window.
 *
 * Message and token metrics: only hours containing messages are materialized.
 * Session metrics: every hour in the window is iterated (sessions_active is
 * an overlap calculation — a long-running session must appear in every hour).
 * For hours without messages, session metrics are only written if non-zero.
 */
export function backfillMetrics(db: Database, days = 30, now = new Date()): void {
  const currentHour = toHourWindow(now);
  const lookbackHours = Math.max(1, Math.floor(days * 24));
  const lookbackStartSec = currentHour.startSec - ((lookbackHours - 1) * 60 * 60);

  // Discover hours with message activity (for message + token metrics)
  const hourRows = db.raw.prepare(`
    SELECT DISTINCT CAST(timestamp / 3600 AS INTEGER) AS hour_bucket
      FROM messages
     WHERE timestamp >= ? AND timestamp < ?
       AND ${ACTIVE_MESSAGE_SQL}
     ORDER BY hour_bucket
  `).all(lookbackStartSec, currentHour.endSec) as Array<{ hour_bucket: number }>;

  // Build set of message-active hours
  const messageHours = new Set(hourRows.map(r => r.hour_bucket));

  // Full-window iteration: every hour for session metrics
  const allHourBuckets: number[] = [];
  for (let sec = lookbackStartSec; sec <= currentHour.startSec; sec += 3600) {
    allHourBuckets.push(Math.floor(sec / 3600));
  }

  if (allHourBuckets.length === 0 && messageHours.size === 0) return;

  db.raw.exec('BEGIN');
  try {
    for (const hourBucket of allHourBuckets) {
      const bucketStartSec = hourBucket * 3600;
      const window: HourWindow = {
        bucket: new Date(bucketStartSec * 1000).toISOString(),
        startSec: bucketStartSec,
        endSec: bucketStartSec + 3600,
      };

      if (messageHours.has(hourBucket)) {
        // Full collection: messages + tokens + sessions
        collectMetricsForWindow(db, window);
      } else {
        // Session metrics only for hours without messages.
        // Only write rows if at least one session metric is non-zero to preserve
        // the "gaps" invariant (message-only hours don't pollute the bucket list).
        const { sessionsStarted, sessionsActive } = querySessionMetrics(db, window.startSec, window.endSec);

        if (sessionsStarted > 0 || sessionsActive > 0) {
          upsertMetric(db, window.bucket, 'sessions_started', sessionsStarted);
          upsertMetric(db, window.bucket, 'sessions_active', sessionsActive);

          const sessionsByProv = querySessionMetricsByProvider(db, window.startSec, window.endSec);
          for (const [provider, counts] of sessionsByProv) {
            if (counts.started > 0) upsertMetric(db, window.bucket, `sessions_started:${provider}`, counts.started);
            if (counts.active > 0) upsertMetric(db, window.bucket, `sessions_active:${provider}`, counts.active);
          }
        }
      }
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}
