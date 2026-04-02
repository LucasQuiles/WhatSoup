import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, parseQueryString, parseIntParam } from '../../lib/http.ts';
import type { FleetDiscovery, DiscoveredInstance } from '../discovery.ts';
import type { HealthPoller } from '../health-poller.ts';
import { findLatestLogFile, readTailLines } from '../log-utils.ts';
import { toIsoFromUnix } from '../time-utils.ts';

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

// ---------------------------------------------------------------------------
// Noise suppression — collapse repeated events into counts
// ---------------------------------------------------------------------------

/** Messages to suppress (show as a single "N messages sent" summary). */
const SUPPRESS_RE = /^(Sending message|Credentials saved|Health check OK|health endpoint responded)$/i;

/** Messages that are genuinely interesting for the activity feed. */
const BUSINESS_RE = /session|reply|inbound.*from|queue|enrichment|access|group|connect|disconnect|started|stopped|crashed|error|failed|restart|degraded|pipeline|processed|received/i;

/** Pino numeric level → warn/error threshold. */
const WARN_LEVEL = 40;

// ---------------------------------------------------------------------------
// Health-change events (synthesized from poller status)
// ---------------------------------------------------------------------------

const previousStatuses = new Map<string, string>();

function synthesizeHealthEvents(
  instances: Map<string, DiscoveredInstance>,
  healthPoller: HealthPoller,
): FeedEvent[] {
  const events: FeedEvent[] = [];
  const now = new Date().toISOString();

  for (const inst of instances.values()) {
    const poll = healthPoller.getStatus(inst.name);
    if (!poll) continue;

    const prevStatus = previousStatuses.get(inst.name);
    const currStatus = poll.status;

    if (prevStatus && prevStatus !== currStatus) {
      if (currStatus === 'online' && prevStatus !== 'online') {
        events.push({ time: now, mode: inst.type, text: `${inst.name}: came online` });
      } else if (currStatus === 'unreachable') {
        events.push({ time: now, mode: inst.type, text: `${inst.name}: connection lost`, isError: true });
      } else if (currStatus === 'degraded') {
        events.push({ time: now, mode: inst.type, text: `${inst.name}: degraded — ${poll.error ?? 'enrichment stale'}`, isError: true });
      }
    }

    previousStatuses.set(inst.name, currStatus);
  }

  // Prune entries for instances no longer in discovery
  for (const name of previousStatuses.keys()) {
    if (!instances.has(name)) previousStatuses.delete(name);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export function handleGetFeed(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FeedDeps,
): void {
  const qs = parseQueryString(req.url);
  const limit = parseIntParam(qs, 'limit', 20, 1, 100);

  const instances = deps.discovery.getInstances();
  const events: FeedEvent[] = [];

  // 1. Synthesize health-change events from poller status deltas
  events.push(...synthesizeHealthEvents(instances, deps.healthPoller));

  // 2. Parse log files for business events
  for (const inst of instances.values()) {
    const logFile = findLatestLogFile(inst.logDir);
    if (!logFile) continue;
    const lines = readTailLines(logFile, 60); // read more lines for better coverage

    // Track suppressed message counts per instance
    const suppressedCounts: Record<string, number> = {};

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

      const isWarnOrAbove = level >= WARN_LEVEL;

      // Suppress noisy messages — count instead of including
      if (SUPPRESS_RE.test(msg)) {
        const key = msg.replace(/\s+/g, ' ').trim().toLowerCase();
        suppressedCounts[key] = (suppressedCounts[key] ?? 0) + 1;
        continue;
      }

      // Only keep warn/error or business-relevant messages
      if (!isWarnOrAbove && !BUSINESS_RE.test(msg)) continue;

      const rawTs = obj.time ?? obj.timestamp;
      const time = typeof rawTs === 'number'
        ? toIsoFromUnix(rawTs)
        : typeof rawTs === 'string'
          ? rawTs
          : new Date().toISOString();

      const component = (obj.component ?? obj.name ?? obj.module ?? '') as string;
      const prefix = component ? `[${component}] ` : '';

      events.push({
        time,
        mode: inst.type,
        text: `${inst.name}: ${prefix}${msg}`,
        ...(isWarnOrAbove ? { isError: true } : {}),
      });
    }

    // Emit summaries for suppressed noisy messages
    const now = new Date().toISOString();
    for (const [key, count] of Object.entries(suppressedCounts)) {
      if (count > 0) {
        let summary: string;
        if (key.includes('sending')) summary = `${count} messages sent`;
        else if (key.includes('credential')) summary = `credentials refreshed`;
        else summary = `${key} (×${count})`;
        events.push({
          time: now,
          mode: inst.type,
          text: `${inst.name}: ${summary}`,
        });
      }
    }
  }

  // 3. Deduplicate identical events (same text within 1 minute)
  const seen = new Set<string>();
  const deduped = events.filter(e => {
    const key = `${e.text}|${e.time.slice(0, 16)}`; // dedupe within same minute
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 4. Sort descending by time, take the first `limit`
  deduped.sort((a, b) => (a.time > b.time ? -1 : a.time < b.time ? 1 : 0));
  jsonResponse(res, 200, deduped.slice(0, limit));
}

// readTailLines and findLatestLogFile imported from ../log-utils.ts
