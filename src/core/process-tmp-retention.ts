import { readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('process-tmp:retention');

// One-shot per directory: the cleanup runs on an interval and a permissions
// regression would otherwise warn every tick.
const warnedUnreadable = new Set<string>();

export interface ProcessTmpRetentionConfig {
  intervalMs: number;
  maxAgeMs: number;
}

export interface ProcessTmpCleanupResult {
  deleted: number;
  skipped: number;
  bytesFreed: number;
}

export const DEFAULT_PROCESS_TMP_RETENTION: ProcessTmpRetentionConfig = {
  intervalMs: 60 * 60 * 1000,
  maxAgeMs: 3 * 60 * 60 * 1000,
};

/**
 * Newest mtime among a directory and its IMMEDIATE children (ms since epoch).
 *
 * Used as the staleness signal for a directory so an in-use browser/profile
 * temp is never reclaimed out from under a live process: Chrome and Playwright
 * churn files inside their temp dir continuously while alive, which keeps a
 * child mtime fresh; a dead process freezes, so the directory ages out. Only
 * immediate children are inspected — cheap, and sufficient because these tools
 * write scratch files directly in the temp dir. Falls back to the directory's
 * own mtime when it cannot be read.
 */
function newestChildMtimeMs(dir: string, ownMtimeMs: number): number {
  let newest = ownMtimeMs;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    try {
      const stat = statSync(join(dir, entry.name));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      // race: entry vanished between readdir and stat — ignore
    }
  }
  return newest;
}

/**
 * Best-effort recursive byte total, computed only for a directory that is about
 * to be removed (so the walk cost is paid once, on confirmed-stale dirs).
 */
function directorySizeBytes(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directorySizeBytes(fullPath);
      } else {
        total += statSync(fullPath).size;
      }
    } catch {
      // race — ignore
    }
  }
  return total;
}

export function runProcessTmpCleanup(dir: string, maxAgeMs: number): ProcessTmpCleanupResult {
  const result: ProcessTmpCleanupResult = { deleted: 0, skipped: 0, bytesFreed: 0 };
  const now = Date.now();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!warnedUnreadable.has(dir)) {
      warnedUnreadable.add(dir);
      log.warn({ err, dir }, 'tmp dir unreadable; cleanup disabled for this directory until restart');
    }
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isFile()) {
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      try {
        unlinkSync(fullPath);
        result.deleted += 1;
        result.bytesFreed += stat.size;
      } catch {
        result.skipped += 1;
      }
      continue;
    }

    if (entry.isDirectory()) {
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      // The leak (orphaned Chrome/Playwright temp, tool caches, test scratch) is
      // entirely directories. Reclaim a dir only when it AND its immediate
      // children are all older than maxAge, so a live browser's temp — still
      // churning files — is never removed out from under it.
      const newestMtimeMs = newestChildMtimeMs(fullPath, stat.mtimeMs);
      if (now - newestMtimeMs <= maxAgeMs) continue;
      const bytes = directorySizeBytes(fullPath);
      try {
        rmSync(fullPath, { recursive: true, force: true });
        result.deleted += 1;
        result.bytesFreed += bytes;
      } catch {
        result.skipped += 1;
      }
      continue;
    }

    // symlinks, sockets, fifos, etc. — left untouched
  }

  return result;
}

export class ProcessTmpRetentionTimer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dir: string;
  private retention: ProcessTmpRetentionConfig;

  constructor(
    dir: string,
    retention: ProcessTmpRetentionConfig = DEFAULT_PROCESS_TMP_RETENTION,
  ) {
    this.dir = dir;
    this.retention = retention;
  }

  start(intervalMs: number = this.retention.intervalMs): void {
    if (this.timer) return;

    this.runCleanup();
    this.timer = setInterval(() => {
      this.runCleanup();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  runCleanup(): ProcessTmpCleanupResult {
    const result = runProcessTmpCleanup(this.dir, this.retention.maxAgeMs);
    if (result.deleted > 0 || result.skipped > 0) {
      log.info(result, 'process tmp retention: cleanup run complete');
    }
    return result;
  }
}
