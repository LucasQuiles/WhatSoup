// src/core/scheduler.ts
// SP11 — Message Scheduling: tick-based scheduler that sends pending scheduled_messages.

import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import type { ConnectionManager } from '../transport/connection.ts';

const log = createChildLogger('scheduler');

interface ScheduledRow {
  id: number;
  chat_jid: string;
  content_type: string;
  payload: string;
  retry_count: number;
  media_blob: Uint8Array | null;
}

export class MessageScheduler {
  private timer: NodeJS.Timeout | null = null;
  private db: Database;
  private connection: ConnectionManager;
  private config: { intervalMs: number; maxRetries: number };

  constructor(
    db: Database,
    connection: ConnectionManager,
    config: { intervalMs: number; maxRetries: number },
  ) {
    this.db = db;
    this.connection = connection;
    this.config = config;
  }

  start(): void {
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

  /** Reset any rows stuck in 'processing' (crashed mid-send) back to 'pending'. */
  recoverStale(): void {
    const count = this.db.raw
      .prepare(`UPDATE scheduled_messages SET status = 'pending' WHERE status = 'processing'`)
      .run().changes;
    if (count > 0) {
      log.info({ count }, 'scheduler: recovered stale processing rows to pending');
    }
  }

  async tick(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Fetch pending rows whose scheduled_at has passed, then claim each by id.
    // Fetching ids first and updating by id ensures we only process rows we
    // explicitly claimed in this tick — pre-existing 'processing' rows (from a
    // crash before recoverStale() ran) are left alone.
    const candidates = this.db.raw
      .prepare(
        `SELECT id, chat_jid, content_type, payload, retry_count, media_blob
         FROM scheduled_messages
         WHERE status = 'pending' AND scheduled_at <= ?`,
      )
      .all(now) as unknown as ScheduledRow[];

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
        `SELECT id, chat_jid, content_type, payload, retry_count, media_blob
         FROM scheduled_messages
         WHERE id IN (${placeholders}) AND status = 'processing'`,
      )
      .all(...ids) as unknown as ScheduledRow[];

    for (const row of rows) {
      try {
        await this.executeSend(row);
        this.db.raw
          .prepare(
            `UPDATE scheduled_messages
             SET status = 'sent', sent_at = ?
             WHERE id = ?`,
          )
          .run(Math.floor(Date.now() / 1000), row.id);
        log.info({ id: row.id, chatJid: row.chat_jid }, 'scheduler: message sent');
      } catch (err) {
        const newRetryCount = row.retry_count + 1;
        if (newRetryCount >= this.config.maxRetries) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.db.raw
            .prepare(
              `UPDATE scheduled_messages
               SET status = 'failed', retry_count = ?, error = ?
               WHERE id = ?`,
            )
            .run(newRetryCount, errorMsg, row.id);
          log.warn({ id: row.id, retries: newRetryCount, err }, 'scheduler: message permanently failed');
        } else {
          this.db.raw
            .prepare(
              `UPDATE scheduled_messages
               SET status = 'pending', retry_count = ?
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

      await this.connection.sendMedia(row.chat_jid, { type, buffer: buf, ...rest } as Parameters<ConnectionManager['sendMedia']>[1]);
    }
  }
}
