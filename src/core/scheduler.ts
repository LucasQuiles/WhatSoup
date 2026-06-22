// src/core/scheduler.ts
// SP11 — Message Scheduling: tick-based scheduler that sends pending scheduled_messages.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { RuntimeConnection } from '../transport/runtime-connection.ts';
import { nextCronRun } from './cron.ts';
import { nowUnixSec } from '../fleet/time-utils.ts';
import { errorMessage } from '../lib/error-message.ts';

const log = createChildLogger('scheduler');

interface ScheduledRow {
  id: number;
  chat_jid: string;
  content_type: string;
  payload: string;
  retry_count: number;
  media_blob: Uint8Array | null;
  recurrence: string | null;
  next_run_at: number | null;
  run_count: number;
  timezone: string | null;
}

const MISSED_OCCURRENCE_SCAN_CAP = 10_000;

function advanceRecurringRun(
  recurrence: string,
  previousNextRun: number,
  sentAt: number,
  timezone: string,
): { nextRun: number; skippedOccurrences: number; capped: boolean } {
  let skippedOccurrences = 0;
  let cursor = previousNextRun;

  for (let i = 0; i < MISSED_OCCURRENCE_SCAN_CAP; i++) {
    const nextRun = nextCronRun(recurrence, cursor, timezone);
    if (nextRun > sentAt) {
      return { nextRun, skippedOccurrences, capped: false };
    }
    skippedOccurrences += 1;
    cursor = nextRun;
  }

  return {
    nextRun: nextCronRun(recurrence, sentAt, timezone),
    skippedOccurrences,
    capped: true,
  };
}

export class MessageScheduler {
  private timer: NodeJS.Timeout | null = null;
  private db: Database;
  private connection: RuntimeConnection;
  private config: { intervalMs: number; maxRetries: number };

  constructor(
    db: Database,
    connection: RuntimeConnection,
    config: { intervalMs: number; maxRetries: number },
  ) {
    this.db = db;
    this.connection = connection;
    this.config = config;
  }

  start(): void {
    // Idempotent: a second start() must not orphan the first interval (matches the
    // guard every sibling scheduler/poller uses, e.g. database-retention, consolidation).
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error({ err }, 'scheduler tick failed'));
    }, this.config.intervalMs);
    this.timer.unref();

    // Run immediately on startup
    this.tick().catch((err) => log.error({ err }, 'scheduler initial tick failed'));
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Recover rows stuck in 'processing' after a crash without blindly replaying uncertain sends. */
  recoverStale(): void {
    // Recurring rows caught mid-send by a crash must NOT be killed wholesale.
    // Fail closed on REPLAY (never re-send the uncertain occurrence) but keep
    // the schedule alive by skipping to the next slot — mirroring the in-tick
    // retry-exhaustion path. A blanket 'failed' would silently destroy the
    // entire recurring schedule on a single crash (#1069 asymmetry).
    const recurringUncertain = this.db.raw
      .prepare(
        `SELECT id, recurrence, next_run_at, timezone
         FROM scheduled_messages
         WHERE status = 'processing' AND send_started_at IS NOT NULL AND recurrence IS NOT NULL`,
      )
      .all() as unknown as Array<{
        id: number;
        recurrence: string;
        next_run_at: number | null;
        timezone: string | null;
      }>;
    for (const row of recurringUncertain) {
      const now = nowUnixSec();
      let nextRun: number | null = null;
      try {
        nextRun = advanceRecurringRun(row.recurrence, row.next_run_at ?? now, now, row.timezone ?? 'UTC').nextRun;
      } catch {
        nextRun = null;
      }
      if (nextRun !== null) {
        this.db.raw
          .prepare(
            `UPDATE scheduled_messages
             SET status = 'pending', retry_count = 0, next_run_at = ?, error = ?, send_started_at = NULL
             WHERE id = ?`,
          )
          .run(nextRun, 'Occurrence skipped after crash during send (uncertain delivery); recurring schedule kept alive', row.id);
        log.warn({ id: row.id, nextRun }, 'scheduler: recurring occurrence uncertain after crash, skipped to next slot');
      } else {
        this.db.raw
          .prepare(
            `UPDATE scheduled_messages
             SET status = 'failed', error = ?, send_started_at = NULL
             WHERE id = ?`,
          )
          .run('Recurring failed after crash during send (cannot compute next slot from recurrence)', row.id);
        log.warn({ id: row.id, recurrence: row.recurrence }, 'scheduler: recurring uncertain-send permanently failed (invalid cron)');
      }
    }

    // One-shot uncertain sends stay fail-closed: we cannot know whether the
    // single delivery happened, so manual verification is required before retry.
    const uncertainCount = this.db.raw
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'failed',
             error = 'Recovered after crash during scheduled send; manual verification required before retry',
             send_started_at = NULL
         WHERE status = 'processing' AND send_started_at IS NOT NULL AND recurrence IS NULL`,
      )
      .run().changes;
    if (uncertainCount > 0) {
      log.warn({ count: uncertainCount }, 'scheduler: failed closed stale processing rows with uncertain send status');
    }

    const requeuedCount = this.db.raw
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'pending', send_started_at = NULL
         WHERE status = 'processing' AND send_started_at IS NULL`,
      )
      .run().changes;
    if (requeuedCount > 0) {
      log.info({ count: requeuedCount }, 'scheduler: recovered stale pre-send processing rows to pending');
    }
  }

  async tick(): Promise<void> {
    const now = nowUnixSec();

    // Fetch pending rows whose scheduled_at (one-shot) or next_run_at (recurring)
    // has passed, then claim each by id. Fetching ids first and updating by id
    // ensures we only process rows we explicitly claimed in this tick —
    // pre-existing 'processing' rows (from a crash before recoverStale() ran)
    // are left alone.
    const candidates = this.db.raw
      .prepare(
        `SELECT id, chat_jid, content_type, payload, retry_count, media_blob, recurrence, next_run_at, run_count, timezone
         FROM scheduled_messages
         WHERE status = 'pending'
           AND (
             (recurrence IS NULL AND scheduled_at <= ?)
             OR (recurrence IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?)
           )`,
      )
      .all(now, now) as unknown as ScheduledRow[];

    if (candidates.length === 0) return;

    // Claim by id to avoid touching pre-existing 'processing' rows
    const ids = candidates.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db.raw
      .prepare(
        `UPDATE scheduled_messages SET status = 'processing'
         WHERE id IN (${placeholders}) AND status = 'pending'`,
      )
      .run(...ids);

    // Only process the rows we just claimed (re-fetch to confirm claimed status)
    const rows = this.db.raw
      .prepare(
        `SELECT id, chat_jid, content_type, payload, retry_count, media_blob, recurrence, next_run_at, run_count, timezone
         FROM scheduled_messages
         WHERE id IN (${placeholders}) AND status = 'processing'`,
      )
      .all(...ids) as unknown as ScheduledRow[];

    for (const row of rows) {
      try {
        const sendStartedAt = nowUnixSec();
        const marked = this.db.raw
          .prepare(
            `UPDATE scheduled_messages
             SET send_started_at = ?
             WHERE id = ? AND status = 'processing'`,
          )
          .run(sendStartedAt, row.id).changes;
        if (marked === 0) continue;

        await this.executeSend(row);
        const sentAt = nowUnixSec();
        if (row.recurrence) {
          // Recurring: stay pending with updated next_run_at and run_count.
          // Wrap nextCronRun separately — if a bad cron slipped into the DB,
          // mark it permanently failed rather than entering a send-retry loop.
          let nextRun: number;
          let skippedOccurrences = 0;
          let skippedOccurrencesCapped = false;
          try {
            const advanced = advanceRecurringRun(
              row.recurrence,
              row.next_run_at ?? sentAt,
              sentAt,
              row.timezone ?? 'UTC',
            );
            nextRun = advanced.nextRun;
            skippedOccurrences = advanced.skippedOccurrences;
            skippedOccurrencesCapped = advanced.capped;
          } catch (cronErr) {
            this.db.raw
              .prepare(
                `UPDATE scheduled_messages
                 SET status = 'failed', sent_at = ?, error = ?, send_started_at = NULL
                 WHERE id = ?`,
              )
              .run(sentAt, `Invalid recurrence after send: ${errorMessage(cronErr)}`, row.id);
            log.error({ id: row.id, recurrence: row.recurrence, err: cronErr }, 'scheduler: invalid cron in DB, marked failed after send');
            continue;
          }
          this.db.raw
            .prepare(
              `UPDATE scheduled_messages
               SET status = 'pending', sent_at = ?, run_count = ?, next_run_at = ?, retry_count = 0, send_started_at = NULL
               WHERE id = ?`,
            )
            .run(sentAt, row.run_count + 1, nextRun, row.id);
          if (skippedOccurrences > 0) {
            log.warn(
              {
                id: row.id,
                chatJid: row.chat_jid,
                previousNextRun: row.next_run_at,
                sentAt,
                nextRun,
                skippedOccurrences,
                skippedOccurrencesCapped,
              },
              'scheduler: recurring message skipped missed occurrences after downtime',
            );
          }
          log.info({ id: row.id, chatJid: row.chat_jid, nextRun }, 'scheduler: recurring message sent, rescheduled');
        } else {
          // One-shot: mark as sent
          this.db.raw
            .prepare(
              `UPDATE scheduled_messages
               SET status = 'sent', sent_at = ?, send_started_at = NULL
               WHERE id = ?`,
            )
            .run(sentAt, row.id);
          log.info({ id: row.id, chatJid: row.chat_jid }, 'scheduler: message sent');
        }
      } catch (err) {
        const newRetryCount = row.retry_count + 1;
        const errorMsg = errorMessage(err);
        if (newRetryCount >= this.config.maxRetries) {
          if (row.recurrence) {
            // Recurring: a recurring schedule must not be permanently destroyed by
            // transient per-occurrence failures. Skip the current occurrence, advance to
            // the next cron slot, and reset retry_count so failures don't accumulate
            // across occurrences. Only mark 'failed' if the next slot is uncomputable.
            let nextRun: number | null = null;
            let skippedOccurrences = 0;
            let skippedOccurrencesCapped = false;
            try {
              const now = nowUnixSec();
              const advanced = advanceRecurringRun(
                row.recurrence,
                row.next_run_at ?? now,
                now,
                row.timezone ?? 'UTC',
              );
              nextRun = advanced.nextRun;
              skippedOccurrences = advanced.skippedOccurrences;
              skippedOccurrencesCapped = advanced.capped;
            } catch {
              nextRun = null;
            }
            if (nextRun !== null) {
              this.db.raw
                .prepare(
                  `UPDATE scheduled_messages
                   SET status = 'pending', retry_count = 0, next_run_at = ?, error = ?, send_started_at = NULL
                   WHERE id = ?`,
                )
                .run(nextRun, `Occurrence skipped after ${newRetryCount} failures: ${errorMsg}`, row.id);
              log.warn(
                {
                  id: row.id,
                  retries: newRetryCount,
                  nextRun,
                  skippedOccurrences,
                  skippedOccurrencesCapped,
                  err,
                },
                'scheduler: recurring occurrence failed, skipped to next slot',
              );
            } else {
              this.db.raw
                .prepare(
                  `UPDATE scheduled_messages
                   SET status = 'failed', retry_count = ?, error = ?, send_started_at = NULL
                   WHERE id = ?`,
                )
                .run(newRetryCount, `Recurring failed (cannot compute next slot): ${errorMsg}`, row.id);
              log.warn(
                { id: row.id, retries: newRetryCount, err },
                'scheduler: recurring message permanently failed (invalid cron)',
              );
            }
          } else {
            this.db.raw
              .prepare(
                `UPDATE scheduled_messages
                 SET status = 'failed', retry_count = ?, error = ?, send_started_at = NULL
                 WHERE id = ?`,
              )
              .run(newRetryCount, errorMsg, row.id);
            log.warn({ id: row.id, retries: newRetryCount, err }, 'scheduler: message permanently failed');
          }
        } else {
          this.db.raw
            .prepare(
              `UPDATE scheduled_messages
               SET status = 'pending', retry_count = ?, send_started_at = NULL
               WHERE id = ?`,
            )
            .run(newRetryCount, row.id);
          log.warn({ id: row.id, retryCount: newRetryCount, err }, 'scheduler: message send failed, will retry');
        }
      }
    }
  }

  private async executeSend(row: ScheduledRow): Promise<void> {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;

    if (row.content_type === 'text') {
      await this.connection.sendRaw(row.chat_jid, payload);
    } else {
      // media types: image, video, audio, document, sticker
      const { type, ...rest } = payload as { type: string; [key: string]: unknown };

      // SP9: media is stored as a BLOB column, not in the JSON payload
      let buf: Buffer;
      if (row.media_blob) {
        buf = Buffer.from(row.media_blob);
      } else {
        // Legacy fallback: deserialize Buffer from JSON payload
        const { buffer: bufferData, ...legacyRest } = rest as {
          buffer?: { type: 'Buffer'; data: number[] } | number[];
          [key: string]: unknown;
        };
        if (bufferData && typeof bufferData === 'object' && 'data' in bufferData) {
          buf = Buffer.from((bufferData as { type: 'Buffer'; data: number[] }).data);
        } else if (Array.isArray(bufferData)) {
          buf = Buffer.from(bufferData as number[]);
        } else {
          throw new Error(`scheduler: no media_blob and no buffer in payload for id=${row.id}`);
        }
        Object.assign(rest, legacyRest);
      }

      await this.connection.sendMedia(row.chat_jid, { type, buffer: buf, ...rest } as Parameters<RuntimeConnection["sendMedia"]>[1]);
    }
  }
}
