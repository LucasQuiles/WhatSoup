import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import { jsonResponse } from '../../lib/http.ts';
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

/** Extract phone number from a WhatsApp JID like "1234567890@s.whatsapp.net". */
function phoneFromJid(jid: string | undefined | null): string {
  if (!jid) return 'unknown';
  const at = jid.indexOf('@');
  return at > 0 ? jid.slice(0, at) : jid;
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

/** Count messages since midnight today for an instance. */
function countMessagesToday(dbReader: FleetDbReader, inst: DiscoveredInstance): number {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();
  const result = dbReader.query(inst.name, inst.dbPath, (db) => {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE timestamp >= ?').get(startMs) as { cnt: number };
    return row.cnt;
  });
  return result.ok ? result.data : 0;
}

/** Build the enriched LineInstance object the console expects. */
function enrichInstance(inst: DiscoveredInstance, poll: InstanceStatus | undefined, messagesToday?: number): Record<string, unknown> {
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
    messagesToday: messagesToday ?? messagesTotal ?? 0,
    health: h,
    heartbeat: buildHeartbeat(poll),
    lastActive: poll?.lastPollAt ?? null,
    unread: unread ?? 0,
    queueDepth: queueDepth ?? 0,
    enrichmentUnprocessed: enrichmentUnprocessed ?? 0,
    activeSessions: activeSessions ?? 0,
    lastSessionStatus,
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
    const todayCount = countMessagesToday(deps.dbReader, inst);
    return enrichInstance(inst, poll, todayCount);
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
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

  const poll = deps.healthPoller.getStatus(params.name);
  const dbStats = deps.dbReader.getSummaryStats(instance.name, instance.dbPath);

  // Start with the enriched shape the console expects, then add detail fields
  const enriched = enrichInstance(instance, poll);

  let instanceConfig: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(instance.configPath, 'utf-8');
    instanceConfig = JSON.parse(raw);
  } catch { /* config unreadable */ }

  jsonResponse(res, 200, {
    ...enriched,
    // Additional detail-only fields
    type: instance.type,
    dbPath: instance.dbPath,
    stateRoot: instance.stateRoot,
    logDir: instance.logDir,
    configPath: instance.configPath,
    gui: instance.gui,
    guiPort: instance.guiPort,
    dbStats: dbStats.ok ? dbStats.data : null,
    config: instanceConfig,
  });
}
