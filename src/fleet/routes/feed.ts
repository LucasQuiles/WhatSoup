import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { jsonResponse, parseQueryString } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { HealthPoller } from '../health-poller.ts';

/** Find the most recent .log file in a directory (pino-roll uses numbered names). */
function findLatestLogFile(logDir: string): string | null {
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? path.join(logDir, files[0].name) : null;
  } catch {
    return null;
  }
}

export interface FeedDeps {
  discovery: FleetDiscovery;
  healthPoller: HealthPoller;
}

interface FeedEvent {
  time: string;
  mode: 'passive' | 'chat' | 'agent';
  text: string;
  isError?: boolean;
}

/** Keywords that make a log line "interesting" for the activity feed. */
const INTERESTING_RE = /session|reply|inbound|message|queue|enrichment/i;

/** Pino numeric level → warn/error threshold. */
const WARN_LEVEL = 40;

/** GET /api/feed — recent activity events aggregated across all instances. */
export function handleGetFeed(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FeedDeps,
): void {
  const qs = parseQueryString(req.url);
  const limit = Math.min(Math.max(parseInt(qs.limit ?? '20', 10) || 20, 1), 100);

  const instances = deps.discovery.getInstances();
  const events: FeedEvent[] = [];

  for (const inst of instances.values()) {
    const logFile = findLatestLogFile(inst.logDir);
    if (!logFile) continue;
    const lines = readTailLines(logFile, 30);

    for (const line of lines) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const level = typeof obj.level === 'number' ? obj.level : 30;
      const msg = typeof obj.msg === 'string' ? obj.msg : '';
      if (!msg) continue;

      // Keep lines that are warn/error OR match interesting keywords
      const isWarnOrAbove = level >= WARN_LEVEL;
      if (!isWarnOrAbove && !INTERESTING_RE.test(msg)) continue;

      const rawTs = obj.time ?? obj.timestamp;
      const time = typeof rawTs === 'number'
        ? new Date(rawTs).toISOString()
        : typeof rawTs === 'string'
          ? rawTs
          : new Date().toISOString();

      events.push({
        time,
        mode: inst.type,
        text: `${inst.name}: ${msg}`,
        ...(isWarnOrAbove ? { isError: true } : {}),
      });
    }
  }

  // Sort descending by time, take the first `limit`
  events.sort((a, b) => (a.time > b.time ? -1 : a.time < b.time ? 1 : 0));
  jsonResponse(res, 200, events.slice(0, limit));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the last N lines from a file (best-effort, reads last 32KB). */
function readTailLines(filePath: string, maxLines: number): string[] {
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 32_768);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      const lines = buf.toString('utf-8').split('\n').filter(Boolean);
      return lines.slice(-maxLines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}
