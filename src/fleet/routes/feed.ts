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

type FeedDetail =
  | { type: 'connection'; statusCode?: number; reason?: string; reconnecting?: boolean }
  | { type: 'tool_error'; toolName: string; toolId?: string; error: string }
  | { type: 'tool_use'; toolName: string; toolId?: string }
  | { type: 'session'; action: string; sessionId?: string; chatJid?: string; reason?: string }
  | { type: 'health'; status: string; previousStatus?: string; error?: string }
  | { type: 'import'; table?: string; count?: number; skipped?: boolean }
  | { type: 'message'; direction: 'inbound' | 'outbound'; chatJid?: string }
  | { type: 'generic' };

interface FeedEvent {
  time: string;
  mode: 'passive' | 'chat' | 'agent';
  text: string;
  isError?: boolean;
  instance?: string;
  component?: string;
  level?: 'info' | 'warn' | 'error';
  detail?: FeedDetail;
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/** Pino numeric level → warn/error threshold. */
const WARN_LEVEL = 40;

/** Messages that are pure noise — collapse into counts. */
const NOISE_RE = /^(Credentials saved|Health check OK|health endpoint responded)$/i;

/** Messages that are genuinely interesting for the activity feed. */
const BUSINESS_RE = /session|reply|inbound.*from|queue|enrichment|access|group|connect|disconnect|started|stopped|crashed|error|failed|restart|degraded|pipeline|processed|received/i;

const PINO_LEVEL_MAP: Record<number, 'info' | 'warn' | 'error'> = {
  10: 'info', 20: 'info', 30: 'info', 40: 'warn', 50: 'error', 60: 'error',
};

interface ParseContext {
  instanceName: string;
  instanceType: 'passive' | 'chat' | 'agent';
}

export function parsePinoLine(line: string, ctx: ParseContext): FeedEvent | 'noise' | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line); } catch { return null; }

  const msg = typeof obj.msg === 'string' ? obj.msg : '';
  if (!msg) return null;

  const pinoLevel = typeof obj.level === 'number' ? obj.level : 30;
  const level = PINO_LEVEL_MAP[pinoLevel] ?? 'info';
  const isWarnOrAbove = pinoLevel >= WARN_LEVEL;

  const rawTs = obj.time ?? obj.timestamp;
  const time = typeof rawTs === 'number'
    ? toIsoFromUnix(rawTs)
    : typeof rawTs === 'string'
      ? rawTs
      : new Date().toISOString();

  const component = (obj.component ?? obj.name ?? obj.module ?? '') as string;
  const prefix = component ? `[${component}] ` : '';

  const base: Omit<FeedEvent, 'detail'> = {
    time,
    mode: ctx.instanceType,
    text: `${ctx.instanceName}: ${prefix}${msg}`,
    instance: ctx.instanceName,
    ...(component ? { component } : {}),
    level,
    ...(isWarnOrAbove ? { isError: true } : {}),
  };

  // 1. Connection error
  if (/stream errored out|WhatsApp connection closed/i.test(msg)) {
    return {
      ...base,
      detail: {
        type: 'connection',
        statusCode: typeof obj.statusCode === 'number' ? obj.statusCode : undefined,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      },
    };
  }

  // 2. Reconnect
  if (/Scheduling reconnect/i.test(msg)) {
    return { ...base, detail: { type: 'connection', reconnecting: true } };
  }

  // 3. Tool error
  if (/tool error reported/i.test(msg)) {
    return {
      ...base,
      detail: {
        type: 'tool_error',
        toolName: typeof obj.toolName === 'string' ? obj.toolName : '',
        toolId: typeof obj.toolId === 'string' ? obj.toolId : undefined,
        error: typeof obj.error === 'string' ? obj.error : String(obj.error ?? ''),
      },
    };
  }

  // 4. Session
  if (/agent idle|proactive resume|session.*spawn|session.*start|session.*kill|session.*end/i.test(msg)) {
    return {
      ...base,
      detail: {
        type: 'session',
        action: msg,
        sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
        chatJid: typeof obj.chatJid === 'string' ? obj.chatJid : undefined,
      },
    };
  }

  // 5. Outbound message
  if (/^Sending message$/.test(msg)) {
    return {
      ...base,
      detail: {
        type: 'message',
        direction: 'outbound',
        chatJid: typeof obj.chatJid === 'string' ? obj.chatJid : undefined,
      },
    };
  }

  // 6. Inbound message
  if (/inbound/i.test(msg)) {
    return {
      ...base,
      detail: {
        type: 'message',
        direction: 'inbound',
        chatJid: typeof obj.chatJid === 'string' ? obj.chatJid : undefined,
      },
    };
  }

  // 7. Import
  if (/legacy import|warm-start import|legacy DB has no|legacy.*skipping/i.test(msg)) {
    return {
      ...base,
      detail: {
        type: 'import',
        table: typeof obj.table === 'string' ? obj.table : undefined,
        skipped: /skipping/i.test(msg),
      },
    };
  }

  // 8. Noise
  if (NOISE_RE.test(msg)) return 'noise';

  // 9. Non-business info → drop
  if (!isWarnOrAbove && !BUSINESS_RE.test(msg)) return null;

  // 10. Generic fallback
  return { ...base, detail: { type: 'generic' } };
}

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
        events.push({
          time: now,
          mode: inst.type,
          text: `${inst.name}: came online`,
          instance: inst.name,
          component: 'health',
          level: 'info',
          detail: { type: 'health', status: currStatus, previousStatus: prevStatus },
        });
      } else if (currStatus === 'unreachable') {
        events.push({
          time: now,
          mode: inst.type,
          text: `${inst.name}: connection lost`,
          isError: true,
          instance: inst.name,
          component: 'health',
          level: 'error',
          detail: { type: 'health', status: currStatus, previousStatus: prevStatus, error: poll.error ?? undefined },
        });
      } else if (currStatus === 'degraded') {
        events.push({
          time: now,
          mode: inst.type,
          text: `${inst.name}: degraded — ${poll.error ?? 'enrichment stale'}`,
          isError: true,
          instance: inst.name,
          component: 'health',
          level: 'warn',
          detail: { type: 'health', status: currStatus, previousStatus: prevStatus, error: poll.error ?? undefined },
        });
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
    const lines = readTailLines(logFile, 60);
    const noiseCounts: Record<string, number> = {};

    for (const line of lines) {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = typeof obj.msg === 'string' ? obj.msg : '';

      const result = parsePinoLine(line, { instanceName: inst.name, instanceType: inst.type });
      if (result === 'noise') {
        const key = msg.replace(/\s+/g, ' ').trim().toLowerCase();
        noiseCounts[key] = (noiseCounts[key] ?? 0) + 1;
      } else if (result) {
        events.push(result);
      }
    }

    const now = new Date().toISOString();
    for (const [key, count] of Object.entries(noiseCounts)) {
      if (count > 0) {
        let summary: string;
        if (key.includes('credential')) summary = 'credentials refreshed';
        else summary = `${key} (×${count})`;
        events.push({ time: now, mode: inst.type, text: `${inst.name}: ${summary}`, instance: inst.name, detail: { type: 'generic' } });
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
