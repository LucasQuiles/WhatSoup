import { readdirSync, statSync, unlinkSync } from 'node:fs';
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
    if (!entry.isFile()) continue;
    const fullPath = join(dir, entry.name);
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
