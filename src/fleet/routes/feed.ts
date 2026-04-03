import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, parseQueryString, parseIntParam } from '../../lib/http.ts';
import type { FleetDiscovery, DiscoveredInstance } from '../discovery.ts';
import type { HealthPoller } from '../health-poller.ts';
import { findLatestLogFile, readTailLines } from '../log-utils.ts';
import { toIsoFromUnix } from '../time-utils.ts';
import type { FleetDbReader } from '../db-reader.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';
const log = createChildLogger('fleet:feed');

export interface FeedDeps {
  discovery: FleetDiscovery;
  healthPoller: HealthPoller;
  dbReader: FleetDbReader;
}

type FeedDetail =
  | { type: 'connection'; statusCode?: number; reason?: string; reconnecting?: boolean; state?: 'connecting' | 'connected' | 'disconnected' }
  | { type: 'tool_error'; toolName: string; toolId?: string; error: string }
  | { type: 'tool_use'; toolName: string; toolId?: string }
  | { type: 'session'; action: string; sessionId?: string; chatJid?: string; reason?: string }
  | { type: 'health'; status: string; previousStatus?: string; error?: string }
  | { type: 'import'; table?: string; count?: number; skipped?: boolean }
  | { type: 'message'; direction: 'inbound' | 'outbound'; chatJid?: string; messageId?: string; preview?: string; senderName?: string; contentType?: string }
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

export function parsePinoLine(line: string, ctx: ParseContext): FeedEvent | null {
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

  // 1a. Connection error — "WhatsApp connection closed" (richer, has reason)
  if (/WhatsApp connection closed/i.test(msg)) {
    return {
      ...base,
      detail: {
        type: 'connection',
        statusCode: typeof obj.statusCode === 'number' ? obj.statusCode : undefined,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      },
    };
  }

  // 1b. Connection error — "stream errored out" (low-level Baileys, often duplicates 1a)
  if (/stream errored out/i.test(msg)) {
    const fullErr = obj.fullErrorNode as { attrs?: { code?: string } } | undefined;
    const errCode = fullErr?.attrs?.code ? parseInt(fullErr.attrs.code, 10) : undefined;
    return {
      ...base,
      detail: {
        type: 'connection',
        statusCode: errCode,
        // Mark as stream-level so coalescer can suppress when a richer event exists
        reason: '_streamError',
      },
    };
  }

  // 2. Reconnect scheduling
  if (/Scheduling reconnect/i.test(msg)) {
    return { ...base, detail: { type: 'connection', reconnecting: true } };
  }

  // 2b. Connection state transitions
  if (/^Connecting to WhatsApp$/i.test(msg)) {
    return { ...base, detail: { type: 'connection', state: 'connecting' } };
  }
  if (/^WhatsApp connected$/i.test(msg)) {
    return { ...base, detail: { type: 'connection', state: 'connected' } };
  }
  if (/client disconnected/i.test(msg)) {
    return { ...base, detail: { type: 'connection', state: 'disconnected' } };
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
        messageId: typeof obj.messageId === 'string' ? obj.messageId : undefined,
      },
    };
  }

  // 6. Inbound message — exact match only to avoid matching durability recovery logs
  if (/^inbound message received$/i.test(msg)) {
    return {
      ...base,
      detail: {
        type: 'message',
        direction: 'inbound',
        chatJid: typeof obj.chatJid === 'string' ? obj.chatJid : undefined,
        messageId: typeof obj.messageId === 'string' ? obj.messageId : undefined,
        senderName: typeof obj.senderName === 'string' ? obj.senderName : undefined,
        contentType: typeof obj.contentType === 'string' ? obj.contentType : undefined,
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

  // 8. Noise — suppress entirely
  if (NOISE_RE.test(msg)) return null;

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
// Post-parse coalescing
// ---------------------------------------------------------------------------

/**
 * Coalesce connection lifecycle events per instance within the same second.
 * A disconnect/reconnect cycle (error → reconnecting → connecting → connected)
 * becomes one summary card. Also suppresses stream-error duplicates when a
 * richer connection-closed event exists for the same instance+second.
 */
function coalesceConnectionEvents(events: FeedEvent[]): FeedEvent[] {
  // Group connection events by instance + second
  const connGroups = new Map<string, FeedEvent[]>();
  const nonConn: FeedEvent[] = [];

  for (const e of events) {
    const d = e.detail;
    if (d?.type === 'connection' && e.instance) {
      const parsed = Date.parse(e.time);
      const bucket = isNaN(parsed) ? e.time.slice(0, 19) : Math.floor(parsed / 10000); // 10-second window
      const key = `${e.instance}|${bucket}`;
      const group = connGroups.get(key);
      if (group) group.push(e);
      else connGroups.set(key, [e]);
    } else {
      nonConn.push(e);
    }
  }

  const result = [...nonConn];

  for (const group of connGroups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Find the richest error event (prefer connection-closed over stream-error)
    const errors = group.filter(e => {
      const d = e.detail as { type: 'connection'; reason?: string; reconnecting?: boolean; state?: string };
      return !d.reconnecting && !d.state && d.reason !== '_streamError';
    });
    const streamErrors = group.filter(e => {
      const d = e.detail as { type: 'connection'; reason?: string };
      return d.reason === '_streamError';
    });
    const reconnects = group.filter(e => (e.detail as { reconnecting?: boolean }).reconnecting);
    const states = group.filter(e => (e.detail as { state?: string }).state);

    // Pick the best error event, or fall back to stream error
    const bestError = errors[0] ?? streamErrors[0];

    if (bestError) {
      // Build a merged event: error + reconnecting status + final state
      const d = bestError.detail as { type: 'connection'; statusCode?: number; reason?: string };
      const finalState = states.find(e => (e.detail as { state?: string }).state === 'connected');
      const isReconnecting = reconnects.length > 0;
      const reconnected = !!finalState;

      const reason = d.reason === '_streamError' ? undefined : d.reason;
      const statusCode = d.statusCode;

      // Build human-readable summary
      const reasonText = reason ? (REASON_LABELS[reason] ?? reason) : (statusCode ? `${statusCode}` : 'disconnected');
      const suffix = reconnected ? ' → reconnected' : isReconnecting ? ' → reconnecting' : '';

      result.push({
        ...bestError,
        text: `${bestError.instance}: ${reasonText}${suffix}`,
        detail: {
          type: 'connection',
          statusCode,
          reason,
          reconnecting: isReconnecting && !reconnected ? true : undefined,
          state: reconnected ? 'connected' : undefined,
        },
      });
    } else {
      // No error in this group — just state transitions (connecting → connected)
      const connected = states.find(e => (e.detail as { state?: string }).state === 'connected');
      if (connected) {
        result.push(connected);
      } else {
        // Keep the first event from the group
        result.push(group[0]);
      }
    }
  }

  return result;
}

/** Map Baileys reason codes to human-readable text (used in coalesced summaries). */
const REASON_LABELS: Record<string, string> = {
  unavailableService: 'WhatsApp unavailable',
  connectionClosed: 'connection closed',
  connectionLost: 'connection lost',
  connectionReplaced: 'connection replaced',
  timedOut: 'timed out',
  loggedOut: 'logged out',
  Unknown: 'disconnected',
};

/**
 * Collapse rapid outbound message events by instance + chatJid within a 60s window.
 * Instead of 10 identical "sent to X" cards, emit one "sent ×10 to X".
 */
function collapseOutboundMessages(events: FeedEvent[]): FeedEvent[] {
  const result: FeedEvent[] = [];
  // Bucket outbound messages by instance + chatJid + minute
  const buckets = new Map<string, { count: number; last: FeedEvent }>();

  for (const e of events) {
    const d = e.detail;
    if (d?.type === 'message' && d.direction === 'outbound' && e.instance) {
      const msgId = (d as { messageId?: string }).messageId;
      const key = msgId
        ? `${e.instance}|id:${msgId}`
        : (() => { const parsed = Date.parse(e.time); return `${e.instance}|${d.chatJid ?? '?'}|${isNaN(parsed) ? e.time.slice(0, 16) : Math.floor(parsed / 10000)}`; })();
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count++;
        bucket.last = e;
      } else {
        buckets.set(key, { count: 1, last: e });
      }
    } else {
      result.push(e);
    }
  }

  for (const { count, last } of buckets.values()) {
    const d = last.detail as { type: 'message'; direction: string; chatJid?: string };
    if (count === 1) {
      result.push(last);
    } else {
      result.push({
        ...last,
        text: `${last.instance}: sent ×${count} to ${d.chatJid ?? 'unknown'}`,
        detail: { type: 'message', direction: 'outbound', chatJid: d.chatJid },
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Preview enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich message-type events with DB-backed content previews.
 * Uses messageId-first lookup, falls back to conversationKey + timestamp.
 * Best-effort: outbound previews may lag until Baileys echo persistence.
 */
function enrichMessagePreviews(
  events: FeedEvent[],
  instances: Map<string, DiscoveredInstance>,
  dbReader: FleetDbReader,
): void {
  const byInstance = new Map<string, FeedEvent[]>();
  for (const e of events) {
    const d = e.detail;
    if (d?.type === 'message' && e.instance) {
      const list = byInstance.get(e.instance);
      if (list) list.push(e);
      else byInstance.set(e.instance, [e]);
    }
  }

  for (const [instName, msgEvents] of byInstance) {
    try {
      const inst = instances.get(instName);
      if (!inst) continue;

      // 1. Batch lookup by messageId
      const withIds = msgEvents.filter(e => (e.detail as any).messageId);
      const ids = withIds.map(e => (e.detail as any).messageId as string);
      const dbRows = new Map<string, { content: string | null; sender_name: string | null; content_type: string }>();

      if (ids.length > 0) {
        const result = dbReader.getMessagesByIds(instName, inst.dbPath, ids);
        if (result.ok) {
          for (const row of result.data) {
            if (row.message_id) {
              dbRows.set(row.message_id, { content: row.content, sender_name: row.sender_name, content_type: row.content_type });
            }
          }
        }
      }

      // 2. Enrich events that matched by messageId
      for (const e of withIds) {
        const d = e.detail as any;
        const row = dbRows.get(d.messageId);
        if (row) {
          d.preview = row.content ? row.content.trim().slice(0, 120) : undefined;
          d.senderName = d.senderName ?? row.sender_name ?? undefined;
          d.contentType = d.contentType ?? row.content_type ?? undefined;
        }
      }

      // 3. Fallback for events without messageId
      const withoutIds = msgEvents.filter(e => !(e.detail as any).messageId);
      for (const e of withoutIds) {
        const d = e.detail as any;
        if (!d.chatJid) continue;
        let ck: string;
        try { ck = toConversationKey(d.chatJid); } catch { continue; }
        const ts = Math.floor(Date.parse(e.time) / 1000);
        if (isNaN(ts)) continue;
        const result = dbReader.getRecentMessagesByChat(instName, inst.dbPath, ck, d.direction, ts, 1);
        if (result.ok && result.data.length > 0) {
          const row = result.data[0];
          d.preview = row.content ? row.content.trim().slice(0, 120) : undefined;
          d.senderName = d.senderName ?? row.sender_name ?? undefined;
          d.contentType = d.contentType ?? row.content_type ?? undefined;
          d.messageId = d.messageId ?? row.message_id ?? undefined;
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, instance: instName }, 'feed: preview enrichment failed for instance');
    }
  }
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
    for (const line of lines) {
      const result = parsePinoLine(line, { instanceName: inst.name, instanceType: inst.type });
      if (result) {
        events.push(result);
      }
    }
  }

  // 3. Coalesce connection lifecycle per instance
  //    A reconnect cycle produces: error → reconnecting → connecting → connected
  //    Collapse into one card per instance per time window (same second).
  //    Also suppress stream-error duplicates when a richer connection-closed exists.
  const coalesced = coalesceConnectionEvents(events);

  // 4. Collapse rapid outbound sends by instance + chatJid
  const collapsed = collapseOutboundMessages(coalesced);

  // 4b. Enrich message events with DB-backed content previews
  enrichMessagePreviews(collapsed, instances, deps.dbReader);

  // 5. Deduplicate identical events (messageId-aware)
  const seen = new Set<string>();
  const deduped = collapsed.filter(e => {
    const d = e.detail;
    const msgId = d?.type === 'message' ? (d as { messageId?: string }).messageId : undefined;
    const key = msgId
      ? `msg:${e.instance}|${msgId}`
      : `${e.text}|${e.time.slice(0, 16)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 6. Sort descending by time, take the first `limit`
  deduped.sort((a, b) => (a.time > b.time ? -1 : a.time < b.time ? 1 : 0));
  jsonResponse(res, 200, deduped.slice(0, limit));
}

// readTailLines and findLatestLogFile imported from ../log-utils.ts
