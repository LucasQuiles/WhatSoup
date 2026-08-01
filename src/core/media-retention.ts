// src/core/media-retention.ts
// Background retention timer for media file cleanup (SP7).
// Cleans media/tmp/ (transient downloads) and media/cache/ (previews/thumbnails)
// on separate retention schedules, nullifying media_path in the DB for deleted files.

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { nowUnixSec } from './substrate/time.ts';
import { MS_PER_HOUR, MS_PER_WEEK } from '../lib/time-units.ts';

const log = createChildLogger('media:retention');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetentionConfig {
  /** Interval between cleanup runs in milliseconds. Default: 6 hours. */
  intervalMs: number;
  /** Max age for temp media files (downloads, transcodes) in milliseconds. Default: 72 hours. */
  tempMaxAgeMs: number;
  /** Max age for cache files (previews, thumbnails) in milliseconds. Default: 7 days. */
  cacheMaxAgeMs: number;
}

export interface CleanupResult {
  /** Number of files successfully deleted. */
  deleted: number;
  /** Number of files that could not be deleted (race conditions, permission errors). */
  skipped: number;
  /** Total bytes freed from deleted files. */
  bytesFreed: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RETENTION: RetentionConfig = {
  intervalMs:    6  * MS_PER_HOUR,
  tempMaxAgeMs:  72 * MS_PER_HOUR,
  cacheMaxAgeMs: MS_PER_WEEK,
};

// ---------------------------------------------------------------------------
// Core cleanup logic
// ---------------------------------------------------------------------------

function runCleanupDir(
  dir: string,
  maxAgeMs: number,
  db: Database,
  result: CleanupResult,
): void {
  const now = Date.now();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // directory may not exist yet — skip silently
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(dir, entry.name);

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue; // race condition — file deleted between readdir and stat
    }

    const ageMs = now - stat.mtimeMs;
    if (ageMs > maxAgeMs) {
      try {
        db.raw.prepare('UPDATE messages SET media_path = NULL WHERE media_path = ?').run(fullPath);
      } catch {
        result.skipped++;
        continue;
      }

      try {
        unlinkSync(fullPath);
        result.bytesFreed += stat.size;
        result.deleted++;
      } catch {
        result.skipped++;
      }
    }
  }
}

/**
 * Run a single cleanup pass over both media subdirectories.
 * Each subdirectory uses its own retention policy.
 * Must run outside an explicit database transaction because file deletion cannot roll back.
 *
 * Exported for direct use by the `cleanup_media` MCP tool and tests.
 */
export async function runCleanup(
  baseMediaDir: string,
  db: Database,
  retention: RetentionConfig,
): Promise<CleanupResult> {
  if (db.raw.isTransaction) {
    throw new Error('media retention cleanup refused inside an active database transaction');
  }

  const result: CleanupResult = { deleted: 0, skipped: 0, bytesFreed: 0 };

  runCleanupDir(join(baseMediaDir, 'tmp'),   retention.tempMaxAgeMs,  db, result);
  runCleanupDir(join(baseMediaDir, 'cache'), retention.cacheMaxAgeMs, db, result);

  // SP9: purge failed scheduled messages with stale BLOB data
  purgeFailedScheduledMessages(db);

  log.info(
    { deleted: result.deleted, skipped: result.skipped, bytesFreed: result.bytesFreed },
    'media retention: cleanup run complete',
  );

  return result;
}

// ---------------------------------------------------------------------------
// Scheduled-message purge (SP9)
// ---------------------------------------------------------------------------

/**
 * Delete failed scheduled messages older than `maxAgeDays` days.
 * Returns the number of rows deleted.
 */
export function purgeFailedScheduledMessages(db: Database, maxAgeDays = 7): number {
  const cutoff = nowUnixSec() - maxAgeDays * 24 * 60 * 60;
  const result = db.raw
    .prepare(`DELETE FROM scheduled_messages WHERE status = 'failed' AND created_at < ?`)
    .run(cutoff);
  const count = Number(result.changes);
  if (count > 0) {
    log.info({ count, maxAgeDays }, 'media retention: purged failed scheduled messages');
  }
  return count;
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

/**
 * Periodic cleanup timer for media files.
 *
 * Usage:
 *   const timer = new MediaRetentionTimer(config.mediaBase, db, retentionCfg);
 *   timer.start(intervalMs);         // runs immediately, then on interval
 *   // on shutdown:
 *   timer.stop();
 */
export class MediaRetentionTimer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseMediaDir: string;
  private db: Database;
  private retention: RetentionConfig;

  constructor(
    /** Base media directory — must contain `tmp/` and `cache/` subdirectories */
    baseMediaDir: string,
    db: Database,
    retention: RetentionConfig = DEFAULT_RETENTION,
  ) {
    this.baseMediaDir = baseMediaDir;
    this.db = db;
    this.retention = retention;
  }

  /**
   * Start the timer. Runs cleanup immediately, then every `intervalMs`.
   * The interval is unref()'d so it does not prevent process exit.
   * No-op when already started, so a repeated start() cannot leak an interval.
   */
  start(intervalMs: number = this.retention.intervalMs): void {
    if (this.timer) return;

    // Run immediately on start
    this.runCleanup().catch((err) => log.error({ err }, 'media retention: immediate cleanup failed'));

    this.timer = setInterval(() => {
      this.runCleanup().catch((err) => log.error({ err }, 'media retention: periodic cleanup failed'));
    }, intervalMs);

    this.timer.unref();
  }

  /** Stop the timer. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Execute a single cleanup pass. Returns the result. */
  async runCleanup(): Promise<CleanupResult> {
    return runCleanup(this.baseMediaDir, this.db, this.retention);
  }
}
