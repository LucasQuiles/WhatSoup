import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, parseQueryString, parseIntParam } from '../../lib/http.ts';
import type { FleetDiscovery, DiscoveredInstance } from '../discovery.ts';
import type { HealthPoller, InstanceStatus } from '../health-poller.ts';
import { inspectLatestLogFile, readTailLinesDetailed, type LogReadFailure } from '../log-utils.ts';
import { normalizeTimestamp } from '../time-utils.ts';
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
  | {
      type: 'health';
      status: string;
      previousStatus?: string;
      error?: string;
      confidence?: InstanceStatus['statusConfidence'];
      reason?: string;
      evidence?: string[];
    }
  | { type: 'import'; table?: string; count?: number; skipped?: boolean }
  | { type: 'message'; direction: 'inbound' | 'outbound'; chatJid?: string; messageId?: string; preview?: string; senderName?: string; contentType?: string; conversationKey?: string }
  // PR-G — a PR-E/PR-F prevention log (a flood that the in-band caps blocked). The
  // in-bot seam counter is authoritative for actual floods; this surfaces PREVENTED
  // ones cross-bot so we learn a bot is trying to flood.
  | { type: 'outbound_flood_signal'; signal: string; chatJid?: string; conversationKey?: string; count?: number }
  | { type: 'generic' };

interface FeedEvent {
  time: string;
  mode: 'passive' | 'chat' | 'agent';
  text: string;
  isError?: boolean;
  instance?: string;
  provider?: string;
  component?: string;
  level?: 'info' | 'warn' | 'error';
  detail?: FeedDetail;
}

type MessageDetail = Extract<FeedDetail, { type: 'message' }>;

interface FeedObservability {
  parsed: number;
  suppressed: number;
  coalesced: number;
  deduped: number;
  previewHits: number;
  previewFallbackHits: number;
  previewMisses: number;
  previewErrors: number;
}

interface FeedPreviewWarning {
  instance: string;
  stage: 'messageId' | 'fallback' | 'instance';
  error: string;
}

function createFeedObservability(): FeedObservability {
  return {
    parsed: 0,
    suppressed: 0,
    coalesced: 0,
    deduped: 0,
    previewHits: 0,
    previewFallbackHits: 0,
    previewMisses: 0,
    previewErrors: 0,
  };
}

function sanitizePreview(content: string | null | undefined): string | undefined {
  if (!content) return undefined;
  const trimmed = content.trim();
  return trimmed ? trimmed.slice(0, 120) : undefined;
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

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function optionalInt(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface ParseContext {
  instanceName: string;
  instanceType: 'passive' | 'chat' | 'agent';
  provider?: string;
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
  const time = normalizeTimestamp(rawTs) ?? new Date().toISOString();

  const component = firstString(obj.component, obj.name, obj.module);
  const prefix = component ? `[${component}] ` : '';

  const base: Omit<FeedEvent, 'detail'> = {
    time,
    mode: ctx.instanceType,
    text: `${ctx.instanceName}: ${prefix}${msg}`,
    instance: ctx.instanceName,
    ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
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
    const errCode = optionalInt(fullErr?.attrs?.code);
    return {
      ...base,
      detail: {
        type: 'connection',
        ...(errCode !== undefined ? { statusCode: errCode } : {}),
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
    const chatJid = typeof obj.chatJid === 'string' ? obj.chatJid : undefined;
    let ck: string | undefined;
    if (chatJid) { try { ck = toConversationKey(chatJid); } catch { /* invalid JID */ } }
    return {
      ...base,
      detail: {
        type: 'message',
        direction: 'outbound',
        chatJid,
        messageId: typeof obj.messageId === 'string' ? obj.messageId : undefined,
        conversationKey: ck,
      },
    };
  }

  // 5b. Outbound media (PR-G G1). The feed was text-only ("Sending message"),
  // blind to media floods; media logs "Sending media" with a mediaType. Mirror
  // the outbound branch so the aggregator tallies media toward the same
  // conversation. (Best-effort cross-bot: sendRaw/poll log no uniform "Sending"
  // line, so the in-bot seam counter — which sees all tiers — stays authoritative.)
  if (/^Sending media$/.test(msg)) {
    const chatJid = typeof obj.chatJid === 'string' ? obj.chatJid : undefined;
    let ck: string | undefined;
    if (chatJid) { try { ck = toConversationKey(chatJid); } catch { /* invalid JID */ } }
    return {
      ...base,
      detail: {
        type: 'message',
        direction: 'outbound',
        chatJid,
        conversationKey: ck,
        contentType: typeof obj.mediaType === 'string' ? obj.mediaType : 'media',
      },
    };
  }

  // 5c. Outbound flood PREVENTION signal (PR-G Task 4). PR-E/PR-F emit a WARN
  // when the in-band caps block a runaway send; recognise those (string-matched,
  // no code dependency, so G lands independently) so a prevented flood still
  // surfaces — we learn a bot is *trying* to flood. Patterns track the design's
  // named strings; reconcile with E/F's final log text when those PRs land.
  if (/outbound flood-guard tripped|outbound governor ceiling exceeded|transport outbound ceiling exceeded|high-volume turn/i.test(msg)) {
    const chatJid = typeof obj.chatJid === 'string' ? obj.chatJid : undefined;
    let ck: string | undefined;
    if (chatJid) { try { ck = toConversationKey(chatJid); } catch { /* invalid JID */ } }
    return {
      ...base,
      detail: {
        type: 'outbound_flood_signal',
        signal: msg,
        chatJid,
        conversationKey: ck,
        count: optionalInt(obj.count),
      },
    };
  }

  // 6. Inbound message — exact match only to avoid matching durability recovery logs
  if (/^inbound message received$/i.test(msg)) {
    const chatJid = typeof obj.chatJid === 'string' ? obj.chatJid : undefined;
    let ck: string | undefined;
    if (chatJid) { try { ck = toConversationKey(chatJid); } catch { /* invalid JID */ } }
    return {
      ...base,
      detail: {
        type: 'message',
        direction: 'inbound',
        chatJid,
        messageId: typeof obj.messageId === 'string' ? obj.messageId : undefined,
        senderName: typeof obj.senderName === 'string' ? obj.senderName : undefined,
        contentType: typeof obj.contentType === 'string' ? obj.contentType : undefined,
        conversationKey: ck,
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
//
// #1882 residual (accepted): this comparison still runs at request time
// against one process-global `previousStatuses` baseline, so a degrade/
// recover cycle between two /api/feed requests can be missed, and two
// requests arriving close together can each observe a different diff as
// they race to advance the same baseline. The Ops page's headline health
// summary (console/src/pages/Operator.tsx) no longer reads this output at
// all — it derives "all healthy" / "N unhealthy" from the CURRENT line
// snapshot via computeKpis, so that number is immune to both defects. What
// remains dependent on this synthesis is the HISTORICAL activity feed's
// health-transition entries — a best-effort recent-activity trail, not an
// authoritative current-state count — so an occasionally-missed or
// differently-ordered entry there is a lower-severity residual than the
// summary regression this issue reports. See the brief's criterion 3 "OR
// document why the residual is acceptable once the summary is decoupled".
// ---------------------------------------------------------------------------

const previousStatuses = new Map<string, string>();

function healthStatusMessage(status: InstanceStatus['status'], error: string | null): string {
  if (status === 'online') return 'came online';
  if (status === 'unreachable') return 'connection lost';
  if (status === 'logged_out') return 'logged out';
  return `degraded - ${error ?? 'health signal degraded'}`;
}

function healthStatusLevel(status: InstanceStatus['status']): FeedEvent['level'] {
  if (status === 'online') return 'info';
  if (status === 'degraded') return 'warn';
  return 'error';
}

function healthDetail(
  poll: InstanceStatus,
  previousStatus: string,
): Extract<FeedDetail, { type: 'health' }> {
  return {
    type: 'health',
    status: poll.status,
    previousStatus,
    ...(poll.error ? { error: poll.error } : {}),
    confidence: poll.statusConfidence,
    reason: poll.statusReason,
    evidence: poll.statusEvidence,
  };
}

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
        const level = healthStatusLevel(currStatus);
        events.push({
          time: now,
          mode: inst.type,
          text: `${inst.name}: ${healthStatusMessage(currStatus, poll.error)}`,
          instance: inst.name,
          provider: inst.provider,
          component: 'health',
          level,
          detail: healthDetail(poll, prevStatus),
        });
      } else {
        const level = healthStatusLevel(currStatus);
        events.push({
          time: now,
          mode: inst.type,
          text: `${inst.name}: ${healthStatusMessage(currStatus, poll.error)}`,
          ...(level === 'error' ? { isError: true } : {}),
          instance: inst.name,
          provider: inst.provider,
          component: 'health',
          level,
          detail: healthDetail(poll, prevStatus),
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

function logEvidenceUnavailableEvent(inst: DiscoveredInstance, failure: LogReadFailure): FeedEvent {
  const code = failure.code ?? 'UNKNOWN';
  return {
    time: new Date().toISOString(),
    mode: inst.type,
    text: `${inst.name}: log evidence unavailable (${code})`,
    instance: inst.name,
    provider: inst.provider,
    component: 'logs',
    level: 'warn',
    detail: { type: 'generic' },
  };
}

// ---------------------------------------------------------------------------
// Post-parse coalescing
// ---------------------------------------------------------------------------

/**
 * Coalesce connection lifecycle events per instance within the same 10-second window.
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
  observability: FeedObservability,
): FeedPreviewWarning[] {
  const byInstance = new Map<string, FeedEvent[]>();
  const warnings: FeedPreviewWarning[] = [];
  for (const e of events) {
    const d = e.detail;
    if (d?.type === 'message' && e.instance) {
      const list = byInstance.get(e.instance);
      if (list) list.push(e);
      else byInstance.set(e.instance, [e]);
    }
  }

  const recordWarning = (
    instance: string,
    stage: FeedPreviewWarning['stage'],
    error: string,
  ) => {
    observability.previewErrors++;
    warnings.push({ instance, stage, error });
  };

  const fillFromFallback = (
    instName: string,
    inst: DiscoveredInstance,
    event: FeedEvent,
  ): 'hit' | 'miss' | 'error' => {
    const d = event.detail as MessageDetail;
    if (!d.chatJid) return 'miss';

    let ck: string;
    try {
      ck = d.conversationKey ?? toConversationKey(d.chatJid);
    } catch {
      return 'miss';
    }

    const ts = Math.floor(Date.parse(event.time) / 1000);
    if (Number.isNaN(ts)) return 'miss';

    try {
      const result = dbReader.getRecentMessagesByChat(instName, inst.dbPath, ck, d.direction, ts, 1);
      if (!result.ok) {
        recordWarning(instName, 'fallback', result.error);
        return 'error';
      }
      if (result.data.length === 0) return 'miss';

      const row = result.data[0];
      d.preview = sanitizePreview(row.content);
      d.senderName = d.senderName ?? row.sender_name ?? undefined;
      d.contentType = d.contentType ?? row.content_type ?? undefined;
      d.messageId = d.messageId ?? row.message_id ?? undefined;
      d.conversationKey = d.conversationKey ?? ck;
      return 'hit';
    } catch (err) {
      recordWarning(instName, 'fallback', (err as Error).message);
      return 'error';
    }
  };

  for (const [instName, msgEvents] of byInstance) {
    try {
      const inst = instances.get(instName);
      if (!inst) continue;

      // 1. Batch lookup by messageId
      const withIds = msgEvents.filter(e => (e.detail as MessageDetail).messageId);
      const ids = withIds.map(e => (e.detail as MessageDetail).messageId as string);
      const dbRows = new Map<string, { content: string | null; sender_name: string | null; content_type: string }>();

      if (ids.length > 0) {
        try {
          const result = dbReader.getMessagesByIds(instName, inst.dbPath, ids);
          if (result.ok) {
            for (const row of result.data) {
              if (row.message_id) {
                dbRows.set(row.message_id, { content: row.content, sender_name: row.sender_name, content_type: row.content_type });
              }
            }
          } else {
            recordWarning(instName, 'messageId', result.error);
          }
        } catch (err) {
          recordWarning(instName, 'messageId', (err as Error).message);
        }
      }

      // 2. Enrich events that matched by messageId
      for (const e of withIds) {
        const d = e.detail as MessageDetail;
        const row = dbRows.get(d.messageId as string);
        if (row) {
          d.preview = sanitizePreview(row.content);
          d.senderName = d.senderName ?? row.sender_name ?? undefined;
          d.contentType = d.contentType ?? row.content_type ?? undefined;
          observability.previewHits++;
          continue;
        }

        const fallback = fillFromFallback(instName, inst, e);
        if (fallback === 'hit') observability.previewFallbackHits++;
        else if (fallback === 'miss') observability.previewMisses++;
      }

      // 3. Fallback for events without messageId
      const withoutIds = msgEvents.filter(e => !(e.detail as MessageDetail).messageId);
      for (const e of withoutIds) {
        const fallback = fillFromFallback(instName, inst, e);
        if (fallback === 'hit') {
          observability.previewFallbackHits++;
        } else if (fallback === 'miss') {
          observability.previewMisses++;
        }
      }
    } catch (err) {
      recordWarning(instName, 'instance', (err as Error).message);
    }
  }

  return warnings;
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
  const observability = createFeedObservability();

  // 1. Synthesize health-change events from poller status deltas
  events.push(...synthesizeHealthEvents(instances, deps.healthPoller));

  // 2. Parse log files for business events
  for (const inst of instances.values()) {
    try {
      const logResult = inspectLatestLogFile(inst.logDir);
      if (!logResult.ok) {
        events.push(logEvidenceUnavailableEvent(inst, logResult));
        continue;
      }
      if (!logResult.file) continue;
      const tailResult = readTailLinesDetailed(logResult.file.path, 60);
      if (!tailResult.ok) {
        events.push(logEvidenceUnavailableEvent(inst, tailResult));
        continue;
      }
      const lines = tailResult.lines;
      for (const line of lines) {
        const result = parsePinoLine(line, { instanceName: inst.name, instanceType: inst.type, provider: inst.provider });
        if (result) {
          events.push(result);
          observability.parsed++;
        } else {
          observability.suppressed++;
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, instance: inst.name }, 'feed: log parsing degraded for instance');
    }
  }

  // 3. Coalesce connection lifecycle per instance
  let coalesced = events;
  try {
    coalesced = coalesceConnectionEvents(events);
    observability.coalesced = Math.max(0, events.length - coalesced.length);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'feed: connection coalescing failed');
  }

  // 4. Enrich message events with DB-backed content previews BEFORE collapsing,
  //    so each individual message gets its own preview by messageId.
  //    After collapsing, the merged card carries the last event's preview.
  const previewWarnings = enrichMessagePreviews(coalesced, instances, deps.dbReader, observability);

  // 5. Collapse rapid outbound sends by instance + chatJid
  let collapsed = coalesced;
  try {
    collapsed = collapseOutboundMessages(coalesced);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'feed: outbound collapse failed');
  }

  // 6. Deduplicate identical events (messageId-aware)
  let deduped = collapsed;
  try {
    const seen = new Set<string>();
    deduped = collapsed.filter(e => {
      const d = e.detail;
      const msgId = d?.type === 'message' ? (d as { messageId?: string }).messageId : undefined;
      const key = msgId
        ? `msg:${e.instance}|${msgId}`
        : `${e.text}|${e.time.slice(0, 16)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    observability.deduped = Math.max(0, collapsed.length - deduped.length);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'feed: dedupe failed');
  }

  if (previewWarnings.length > 0) {
    log.warn(
      {
        previewWarnings,
        stats: observability,
      },
      'feed: preview enrichment partially failed',
    );
  } else if (observability.previewFallbackHits > 0 || observability.suppressed > 0) {
    log.debug({ stats: observability }, 'feed: request summary');
  }

  // 7. Sort descending by time, take the first `limit`
  deduped.sort((a, b) => (a.time > b.time ? -1 : a.time < b.time ? 1 : 0));
  jsonResponse(res, 200, deduped.slice(0, limit));
}

// readTailLinesDetailed and inspectLatestLogFile imported from ../log-utils.ts
