import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { jsonResponse, requireInstance } from '../../lib/http.ts';
import { extractLocal } from '../../core/access-list.ts';
import type { FleetDiscovery, DiscoveredInstance } from '../discovery.ts';
import type { HealthPoller, InstanceStatus } from '../health-poller.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface LinesDeps {
  discovery: FleetDiscovery;
  healthPoller: HealthPoller;
  dbReader: FleetDbReader;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format seconds into "Xd Xh" human-readable string. */
function formatUptime(seconds: number | undefined | null): string | null {
  if (seconds == null || seconds < 0) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/** Extract phone number from a WhatsApp JID. Null-safe wrapper around extractLocal. */
function phoneFromJid(jid: string | undefined | null): string {
  if (!jid) return 'unknown';
  return extractLocal(jid);
}

/**
 * Normalize a timestamp to ISO 8601 format.
 * SQLite datetime('now') produces "YYYY-MM-DD HH:MM:SS" (UTC but no timezone marker).
 * Agent runtimes produce ISO strings. This ensures a consistent format for the frontend.
 */
function normalizeTimestamp(ts: unknown): string | null {
  if (!ts || typeof ts !== 'string') return null;
  // Already ISO 8601 (has T and Z or timezone offset)
  if (ts.includes('T')) return ts;
  // SQLite datetime format "YYYY-MM-DD HH:MM:SS" — treat as UTC
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Safely traverse nested health snapshot using dot-separated keys. */
function dig(obj: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Generate a heartbeat array of 20 entries based on consecutive failure count. */
function buildHeartbeat(poll: InstanceStatus | undefined): ('up' | 'down')[] {
  const size = 20;
  if (!poll) return Array(size).fill('down') as ('up' | 'down')[];
  const failures = Math.min(poll.consecutiveFailures, size);
  // Most recent entries are at the end of the array.
  // Older entries are 'up', recent failures are 'down'.
  const ups = size - failures;
  return [
    ...Array(ups).fill('up'),
    ...Array(failures).fill('down'),
  ] as ('up' | 'down')[];
}

/** Detailed message stats by direction and content type — 60s cache. */
interface MessageStats {
  sent: number;
  received: number;
  images: number;
  audio: number;
  documents: number;
}

const DAILY_CACHE_TTL = 60_000; // 60 seconds
const messageStatsCache = new Map<string, { stats: MessageStats; cachedAt: number }>();
const sessionCountCache = new Map<string, { count: number; cachedAt: number }>();

/** Total lifetime agent sessions — 60s cache. */
function getTotalSessions(dbReader: FleetDbReader, inst: DiscoveredInstance): number {
  if (inst.type !== 'agent') return 0;
  const now = Date.now();
  const cached = sessionCountCache.get(inst.name);
  if (cached && now - cached.cachedAt < DAILY_CACHE_TTL) return cached.count;

  const result = dbReader.query(inst.name, inst.dbPath, (db) => {
    try {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM agent_sessions').get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0; // table may not exist for non-agent instances
    }
  });

  const count = result.ok ? result.data : 0;
  sessionCountCache.set(inst.name, { count, cachedAt: now });
  return count;
}

function getMessageStats(dbReader: FleetDbReader, inst: DiscoveredInstance): MessageStats {
  const now = Date.now();
  const cached = messageStatsCache.get(inst.name);
  if (cached && now - cached.cachedAt < DAILY_CACHE_TTL) return cached.stats;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startSec = Math.floor(startOfDay.getTime() / 1000);

  const result = dbReader.query(inst.name, inst.dbPath, (db) => {
    const rows = db.prepare(
      'SELECT content_type, is_from_me, COUNT(*) as cnt FROM messages WHERE timestamp >= ? GROUP BY content_type, is_from_me',
    ).all(startSec) as { content_type: string; is_from_me: number; cnt: number }[];
    return rows;
  });

  const stats: MessageStats = { sent: 0, received: 0, images: 0, audio: 0, documents: 0 };
  if (result.ok) {
    for (const row of result.data) {
      if (row.is_from_me === 1) stats.sent += row.cnt;
      else stats.received += row.cnt;
      if (row.content_type === 'image') stats.images += row.cnt;
      else if (row.content_type === 'audio') stats.audio += row.cnt;
      else if (row.content_type === 'document') stats.documents += row.cnt;
    }
  }

  messageStatsCache.set(inst.name, { stats, cachedAt: now });
  return stats;
}

function getLinkedStatus(configPath: string): 'linked' | 'unlinked' {
  try {
    const authDir = path.join(path.dirname(configPath), 'auth');
    const entries = fs.readdirSync(authDir);
    return entries.some(f => f.startsWith('creds') || f.startsWith('app-state-sync'))
      ? 'linked' : 'unlinked';
  } catch {
    return 'unlinked';
  }
}

interface ChatCounts {
  chats: number;
  groups: number;
}

const chatCountsCache = new Map<string, { counts: ChatCounts; cachedAt: number }>();

function getChatCounts(dbReader: FleetDbReader, inst: DiscoveredInstance): ChatCounts {
  const now = Date.now();
  const cached = chatCountsCache.get(inst.name);
  if (cached && now - cached.cachedAt < DAILY_CACHE_TTL) return cached.counts;

  const result = dbReader.query(inst.name, inst.dbPath, (db) => {
    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT conversation_key) as total,
        COUNT(DISTINCT CASE WHEN conversation_key LIKE '%@g.us' OR conversation_key LIKE '%_at_g.us' THEN conversation_key END) as groups
      FROM messages WHERE deleted_at IS NULL
    `).get() as { total: number; groups: number } | undefined;
    return { chats: (row?.total ?? 0) - (row?.groups ?? 0), groups: row?.groups ?? 0 };
  });

  const counts = result.ok ? result.data : { chats: 0, groups: 0 };
  chatCountsCache.set(inst.name, { counts, cachedAt: now });
  return counts;
}

interface TokenStats {
  input: number;
  output: number;
}

const tokenStatsCache = new Map<string, { stats: TokenStats; cachedAt: number }>();

function getTokenStats(dbReader: FleetDbReader, inst: DiscoveredInstance): TokenStats {
  const now = Date.now();
  const cached = tokenStatsCache.get(inst.name);
  if (cached && now - cached.cachedAt < DAILY_CACHE_TTL) return cached.stats;

  const result = dbReader.query(inst.name, inst.dbPath, (db) => {
    // Sum tokens from messages (chat runtime)
    let msgInput = 0, msgOutput = 0;
    try {
      const row = db.prepare(
        'SELECT COALESCE(SUM(input_tokens), 0) as i, COALESCE(SUM(output_tokens), 0) as o FROM messages'
      ).get() as { i: number; o: number } | undefined;
      msgInput = row?.i ?? 0;
      msgOutput = row?.o ?? 0;
    } catch { /* column may not exist yet */ }

    // Sum tokens from agent_sessions (agent runtime)
    let sesInput = 0, sesOutput = 0;
    try {
      const row = db.prepare(
        'SELECT COALESCE(SUM(total_input_tokens), 0) as i, COALESCE(SUM(total_output_tokens), 0) as o FROM agent_sessions'
      ).get() as { i: number; o: number } | undefined;
      sesInput = row?.i ?? 0;
      sesOutput = row?.o ?? 0;
    } catch { /* column may not exist yet */ }

    return { input: msgInput + sesInput, output: msgOutput + sesOutput };
  });

  const stats = result.ok ? result.data : { input: 0, output: 0 };
  tokenStatsCache.set(inst.name, { stats, cachedAt: now });
  return stats;
}

const lastActiveCache = new Map<string, { ts: string | null; cachedAt: number }>();

/** Most recent message timestamp for an instance — 60s cache. */
function getLastMessageTime(dbReader: FleetDbReader, inst: DiscoveredInstance): string | null {
  const now = Date.now();
  const cached = lastActiveCache.get(inst.name);
  if (cached && now - cached.cachedAt < DAILY_CACHE_TTL) return cached.ts;

  const result = dbReader.query(inst.name, inst.dbPath, (db) => {
    const row = db.prepare(
      'SELECT MAX(timestamp) as ts FROM messages WHERE deleted_at IS NULL'
    ).get() as { ts: number | null } | undefined;
    if (!row?.ts) return null;
    return new Date(row.ts * 1000).toISOString();
  });

  const ts = result.ok ? result.data : null;
  lastActiveCache.set(inst.name, { ts, cachedAt: now });
  return ts;
}

interface EnrichOpts {
  messagesToday?: number;
  messageStats?: MessageStats;
  totalSessions?: number;
  chatCounts?: ChatCounts;
  tokenStats?: TokenStats;
  lastMessageTime?: string | null;
}

/** Build the enriched LineInstance object the console expects. */
function enrichInstance(inst: DiscoveredInstance, poll: InstanceStatus | undefined, opts: EnrichOpts = {}): Record<string, unknown> {
  const h = poll?.health ?? null;

  const uptimeSec = dig(h, 'uptime_seconds') as number | undefined;
  const accountJid = dig(h, 'whatsapp', 'account_jid') as string | undefined;
  const messagesTotal = dig(h, 'sqlite', 'messages_total') as number | undefined;
  const unread = dig(h, 'runtime', 'passive', 'unreadCount') as number | undefined;
  const queueDepth = dig(h, 'runtime', 'chat', 'queueDepth') as number | undefined;
  const enrichmentUnprocessed = dig(h, 'runtime', 'chat', 'enrichmentUnprocessed') as number | undefined;
  const activeSessions = dig(h, 'runtime', 'agent', 'activeSessions') as number | undefined;
  const lastSessionStatus = (dig(h, 'runtime', 'agent', 'lastSessionStatus') as string | undefined)
    ?? (poll?.status === 'online' ? 'idle' : poll?.status === 'unreachable' ? 'error' : undefined)
    ?? null;

  return {
    // Discovery fields
    name: inst.name,
    mode: inst.type,
    accessMode: inst.accessMode,
    healthPort: inst.healthPort,
    socketPath: inst.socketPath,

    // Poller status
    status: poll?.status ?? 'unknown',
    error: poll?.error ?? null,

    // Derived from health snapshot
    phone: phoneFromJid(accountJid),
    uptime: formatUptime(uptimeSec),
    messagesTotal: messagesTotal ?? 0,
    messagesToday: opts.messagesToday ?? messagesTotal ?? 0,
    health: h,
    heartbeat: buildHeartbeat(poll),
    lastActive: normalizeTimestamp(
      (dig(h, 'runtime', 'passive', 'lastActivityAt') as string | undefined)
      ?? (dig(h, 'runtime', 'agent', 'lastSessionStartedAt') as string | undefined)
      ?? opts.lastMessageTime
      ?? null
    ),
    unread: unread ?? 0,
    queueDepth: queueDepth ?? 0,
    enrichmentUnprocessed: enrichmentUnprocessed ?? 0,
    activeSessions: activeSessions ?? 0,
    lastSessionStatus,
    messageStats: opts.messageStats ?? null,
    linkedStatus: getLinkedStatus(inst.configPath),
    totalSessions: opts.totalSessions ?? 0,
    models: inst.models ?? null,
    sandboxPerChat: inst.sandboxPerChat ?? false,
    chatCounts: opts.chatCounts ?? { chats: 0, groups: 0 },
    tokenUsage: opts.tokenStats ?? { input: 0, output: 0 },
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /api/lines — list all instances with their poller status. */
export function handleGetLines(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LinesDeps,
): void {
  const instances = deps.discovery.getInstances();
  const statuses = deps.healthPoller.getStatuses();

  const lines = Array.from(instances.values()).map((inst) => {
    const poll = statuses.get(inst.name);
    const stats = getMessageStats(deps.dbReader, inst);
    const todayCount = stats.sent + stats.received;
    const totalSessions = getTotalSessions(deps.dbReader, inst);
    const chatCounts = getChatCounts(deps.dbReader, inst);
    const tokenStats = getTokenStats(deps.dbReader, inst);
    const lastMessageTime = getLastMessageTime(deps.dbReader, inst);
    return enrichInstance(inst, poll, { messagesToday: todayCount, messageStats: stats, totalSessions, chatCounts, tokenStats, lastMessageTime });
  });

  jsonResponse(res, 200, lines);
}

/** GET /api/lines/:name — detailed view of a single instance. */
export async function handleGetLine(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LinesDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const poll = deps.healthPoller.getStatus(params.name);
  const dbStats = deps.dbReader.getSummaryStats(instance.name, instance.dbPath);

  // Start with the enriched shape the console expects, then add detail fields
  const stats = getMessageStats(deps.dbReader, instance);
  const totalSessions = getTotalSessions(deps.dbReader, instance);
  const enriched = enrichInstance(instance, poll, { messageStats: stats, totalSessions });

  let instanceConfig: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(instance.configPath, 'utf-8');
    instanceConfig = JSON.parse(raw);
  } catch { /* config unreadable */ }

  // Compute real messagesToday for detail view (derived from stats)
  const todayCount = stats.sent + stats.received;

  // Resolve LID admin phones to display-friendly phone numbers via lid_mappings DB.
  const adminPhones = instanceConfig.adminPhones as string[] | undefined;
  let adminPhonesDisplay: Record<string, string> | undefined;
  if (adminPhones && adminPhones.some(p => String(p).length > 11)) {
    const lidResult = deps.dbReader.query(instance.name, instance.dbPath, (db) => {
      const rows = db.prepare('SELECT lid, phone_jid FROM lid_mappings').all() as { lid: string; phone_jid: string }[];
      const map: Record<string, string> = {};
      for (const row of rows) {
        map[row.lid] = row.phone_jid.split('@')[0];
      }
      return map;
    });
    if (lidResult.ok) {
      adminPhonesDisplay = {};
      for (const phone of adminPhones) {
        adminPhonesDisplay[phone] = lidResult.data[phone] ?? phone;
      }
    }
  }

  jsonResponse(res, 200, {
    ...enriched,
    messagesToday: todayCount,
    // Additional detail-only fields (no filesystem paths — those are server internals)
    type: instance.type,
    gui: instance.gui,
    guiPort: instance.guiPort,
    dbStats: dbStats.ok ? dbStats.data : null,
    config: instanceConfig,
    ...(adminPhonesDisplay ? { adminPhonesDisplay } : {}),
  });
}
