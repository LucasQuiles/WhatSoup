import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { jsonResponse, parseQueryString } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';
import { proxyToInstance } from '../http-proxy.ts';

import { findLatestLogFile } from '../log-utils.ts';
import { resolveGroupNames } from '../group-resolver.ts';

export interface DataDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

/** GET /api/lines/:name/chats — paginated chat list (ChatItem shape). */
export function handleGetChats(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
  params: { name: string },
): void {
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

  const qs = parseQueryString(req.url);
  const limit = Math.min(Math.max(parseInt(qs.limit ?? '50', 10) || 50, 1), 500);
  const offset = Math.max(parseInt(qs.offset ?? '0', 10) || 0, 0);

  const result = deps.dbReader.getChats(instance.name, instance.dbPath, { limit, offset });
  if (!result.ok) {
    jsonResponse(res, 500, { error: result.error });
    return;
  }

  // Enrich each ChatSummary → ChatItem expected by the console frontend.
  // Fetch last-message previews and unread counts in a single db pass.
  const enriched = deps.dbReader.query(instance.name, instance.dbPath, (db) => {
    const previewStmt = db.prepare(`
      SELECT content, sender_name, is_from_me FROM messages
      WHERE conversation_key = ? AND deleted_at IS NULL
      ORDER BY timestamp DESC LIMIT 1
    `);
    const unreadStmt = db.prepare(`
      SELECT unread_count FROM chats WHERE conversation_key = ? LIMIT 1
    `);
    // Group name: check groups table (jid uses @g.us), then chats table
    const groupNameStmt = db.prepare(`
      SELECT subject FROM groups WHERE jid = ? LIMIT 1
    `);
    const chatNameStmt = db.prepare(`
      SELECT name FROM chats WHERE conversation_key = ? LIMIT 1
    `);
    // DM name: find the OTHER person's name (not from_me, non-numeric)
    const dmNameStmt = db.prepare(`
      SELECT sender_name FROM messages
      WHERE conversation_key = ? AND is_from_me = 0
        AND sender_name IS NOT NULL
        AND sender_name != conversation_key
        AND sender_name NOT GLOB '[0-9]*'
      ORDER BY timestamp DESC LIMIT 1
    `);
    // For groups without metadata: list unique participant names
    const participantsStmt = db.prepare(`
      SELECT DISTINCT sender_name FROM messages
      WHERE conversation_key = ? AND sender_name IS NOT NULL
        AND sender_name NOT GLOB '[0-9]*'
        AND is_from_me = 0
      LIMIT 4
    `);

    return result.data.map((chat) => {
      const lastMsg = previewStmt.get(chat.conversationKey) as any;
      const preview = lastMsg?.content ?? null;
      const unread = (unreadStmt.get(chat.conversationKey) as any)?.unread_count ?? 0;

      // Detect group: conversation_key contains _at_g.us or @g.us
      const isGroup = chat.conversationKey.includes('_at_g.us') || chat.conversationKey.includes('@g.us');

      // Resolve display name
      let displayName: string;
      let needsBackfill = false;
      if (isGroup) {
        // Convert _at_g.us back to @g.us for the groups table lookup
        const groupJid = chat.conversationKey.replace('_at_g.us', '@g.us');
        const groupSubject = (groupNameStmt.get(groupJid) as any)?.subject;
        const chatName = (chatNameStmt.get(chat.conversationKey) as any)?.name;
        if (groupSubject) {
          displayName = groupSubject;
        } else if (chatName) {
          displayName = chatName;
        } else {
          // No metadata — build from participant names (temporary fallback)
          const parts = (participantsStmt.all(chat.conversationKey) as any[]).map(p => p.sender_name);
          displayName = parts.length > 0 ? parts.join(', ') : chat.conversationKey;
          needsBackfill = true;
        }
      } else {
        // DM: prefer the other person's name
        const chatName = (chatNameStmt.get(chat.conversationKey) as any)?.name;
        const otherName = (dmNameStmt.get(chat.conversationKey) as any)?.sender_name;
        displayName = chatName || otherName || chat.senderName || chat.conversationKey;
      }

      // Last message preview: prefix with sender name for groups
      let formattedPreview = preview;
      if (isGroup && preview && lastMsg?.sender_name && !lastMsg?.is_from_me) {
        const short = lastMsg.sender_name.split(' ')[0]; // first name only
        formattedPreview = `${short}: ${preview}`;
      } else if (isGroup && preview && lastMsg?.is_from_me) {
        formattedPreview = `You: ${preview}`;
      }

      return {
        conversationKey: chat.conversationKey,
        name: displayName,
        lastMessagePreview: formattedPreview,
        lastMessageAt: chat.lastMessageAt != null
          ? new Date((chat.lastMessageAt > 1e12 ? chat.lastMessageAt : chat.lastMessageAt * 1000)).toISOString()
          : null,
        unreadCount: unread,
        isGroup,
        _needsBackfill: needsBackfill,
      };
    });
  });

  if (!enriched.ok) {
    jsonResponse(res, 500, { error: enriched.error });
    return;
  }

  // Strip internal flags before sending, trigger backfill for groups missing names
  const groupsNeedingBackfill: string[] = [];
  const response = enriched.data.map(({ _needsBackfill, ...chat }) => {
    if (_needsBackfill) groupsNeedingBackfill.push(chat.conversationKey);
    return chat;
  });

  jsonResponse(res, 200, response);

  // Fire-and-forget: resolve missing group names via this instance's connection
  if (groupsNeedingBackfill.length > 0) {
    resolveGroupNames(instance, groupsNeedingBackfill);
  }
}

/** GET /api/lines/:name/messages — paginated messages for a conversation. */
export function handleGetMessages(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
  params: { name: string },
): void {
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

  const qs = parseQueryString(req.url);
  const conversationKey = qs.conversation_key;
  if (!conversationKey) {
    jsonResponse(res, 400, { error: 'missing required query parameter: conversation_key' });
    return;
  }

  const limit = Math.min(Math.max(parseInt(qs.limit ?? '50', 10) || 50, 1), 500);
  const beforePk = qs.before_pk ? parseInt(qs.before_pk, 10) : undefined;

  const result = deps.dbReader.getMessages(instance.name, instance.dbPath, {
    conversationKey,
    beforePk: beforePk != null && !isNaN(beforePk) ? beforePk : undefined,
    limit,
  });
  if (!result.ok) {
    jsonResponse(res, 500, { error: result.error });
    return;
  }

  // Transform MessageRow → Message shape expected by the console frontend.
  const messages = result.data.map((row) => ({
    pk: row.pk,
    conversationKey: row.conversation_key,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    content: row.content,
    type: row.content_type,
    timestamp: new Date(row.timestamp > 1e12 ? row.timestamp : row.timestamp * 1000).toISOString(),
    fromMe: row.is_from_me === 1,
  }));

  jsonResponse(res, 200, messages);
}

/** GET /api/lines/:name/access — access list entries. */
export function handleGetAccess(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
  params: { name: string },
): void {
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

  const result = deps.dbReader.getAccessList(instance.name, instance.dbPath);
  if (!result.ok) {
    jsonResponse(res, 500, { error: result.error });
    return;
  }

  // Transform AccessEntry → shape expected by the console frontend.
  const entries = result.data.map((entry) => ({
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    subjectName: entry.displayName,
    status: entry.status,
    updatedAt: entry.decidedAt ?? entry.requestedAt,
  }));

  jsonResponse(res, 200, entries);
}

/** GET /api/lines/:name/logs — recent log entries as JSON array. */
export function handleGetLogs(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
  params: { name: string },
): void {
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

  const qs = parseQueryString(req.url);
  const levelFilter = qs.level ?? null;
  const limit = Math.min(Math.max(parseInt(qs.limit ?? '200', 10) || 200, 1), 2000);

  const logFile = findLatestLogFile(instance.logDir);
  if (!logFile) {
    jsonResponse(res, 200, []);
    return;
  }

  let raw: Buffer;
  try {
    const stat = fs.statSync(logFile);
    const readSize = Math.min(stat.size, 65_536); // last 64KB
    const fd = fs.openSync(logFile, 'r');
    try {
      raw = Buffer.alloc(readSize);
      fs.readSync(fd, raw, 0, readSize, Math.max(0, stat.size - readSize));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // File missing or unreadable — return empty
    jsonResponse(res, 200, []);
    return;
  }

  const text = raw.toString('utf-8');
  const lines = text.split('\n').filter(Boolean);

  // Map pino numeric level → LogEntry label
  const pinoLevelMap: Record<number, 'debug' | 'info' | 'warn' | 'error'> = {
    10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error',
  };
  // Reverse: label → set of numeric levels (for filtering)
  const labelToNums: Record<string, number[]> = {
    trace: [10], debug: [10, 20], info: [30], warn: [40], error: [50, 60], fatal: [60],
  };

  interface LogEntry {
    timestamp: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    source: string;
    component?: string;
  }

  const entries: LogEntry[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      // Level filtering (support both numeric and label filter values)
      if (levelFilter && obj.level !== undefined) {
        const numLevel = parseInt(levelFilter, 10);
        if (!isNaN(numLevel)) {
          if (obj.level !== numLevel) continue;
        } else if (typeof obj.level === 'number') {
          const allowed = labelToNums[levelFilter];
          if (allowed && !allowed.includes(obj.level)) continue;
        }
      }

      // Derive ISO timestamp from pino's time/timestamp field
      const rawTs = obj.time ?? obj.timestamp;
      const timestamp = typeof rawTs === 'number'
        ? new Date(rawTs > 1e12 ? rawTs : rawTs * 1000).toISOString()  // handle both ms and seconds
        : typeof rawTs === 'string'
          ? rawTs
          : new Date().toISOString();

      const level: 'debug' | 'info' | 'warn' | 'error' =
        typeof obj.level === 'number' ? (pinoLevelMap[obj.level] ?? 'info') : 'info';

      const source: string = obj.name ?? obj.module ?? 'system';
      const component: string | undefined = obj.component ?? undefined;

      entries.push({ timestamp, level, msg: obj.msg ?? '', source, ...(component != null ? { component } : {}) });
    } catch {
      // Skip non-JSON lines
    }
  }

  // Collapse consecutive identical messages into "msg (×N)"
  const collapsed: LogEntry[] = [];
  for (const entry of entries) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.msg === entry.msg && prev.source === entry.source && prev.level === entry.level) {
      // Update timestamp to latest and append count
      prev.timestamp = entry.timestamp;
      const match = prev.msg.match(/\(×(\d+)\)$/);
      if (match) {
        prev.msg = prev.msg.replace(/\(×\d+\)$/, `(×${parseInt(match[1], 10) + 1})`);
      } else {
        prev.msg = `${prev.msg} (×2)`;
      }
    } else {
      collapsed.push({ ...entry });
    }
  }

  // Return the last `limit` entries
  jsonResponse(res, 200, collapsed.slice(-limit));
}

/** GET /api/typing — aggregate typing indicators from all instances. */
export async function handleGetTyping(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
): Promise<void> {
  const instances = deps.discovery.getInstances();
  const typing: { instance: string; jid: string; since: number }[] = [];

  // Query all instances in parallel
  const promises = Array.from(instances.values()).map(async (inst) => {
    if (!inst.healthPort) return;
    try {
      const result = await proxyToInstance(inst.healthPort, '/typing', 'GET', null, inst.healthToken, 2000);
      if (result.status !== 200) return;
      const data = JSON.parse(result.body);
      if (Array.isArray(data.composing)) {
        for (const entry of data.composing) {
          typing.push({ instance: inst.name, jid: entry.jid, since: entry.since });
        }
      }
    } catch { /* instance unreachable — skip */ }
  });

  await Promise.all(promises);
  jsonResponse(res, 200, typing);
}
