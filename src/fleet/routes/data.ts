import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { jsonResponse, parseQueryString } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

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
      SELECT content FROM messages
      WHERE conversation_key = ? AND deleted_at IS NULL
      ORDER BY timestamp DESC LIMIT 1
    `);
    const unreadStmt = db.prepare(`
      SELECT unread_count FROM chats WHERE conversation_key = ? LIMIT 1
    `);

    return result.data.map((chat) => {
      const preview = (previewStmt.get(chat.conversationKey) as any)?.content ?? null;
      const unread = (unreadStmt.get(chat.conversationKey) as any)?.unread_count ?? 0;
      return {
        conversationKey: chat.conversationKey,
        name: chat.senderName,
        lastMessagePreview: preview,
        lastMessageAt: chat.lastMessageAt != null ? new Date(chat.lastMessageAt).toISOString() : null,
        unreadCount: unread,
        isGroup: chat.isGroup,
      };
    });
  });

  if (!enriched.ok) {
    jsonResponse(res, 500, { error: enriched.error });
    return;
  }
  jsonResponse(res, 200, enriched.data);
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
    timestamp: new Date(row.timestamp).toISOString(),
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

  const logFile = path.join(instance.logDir, 'current.log');

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
        ? new Date(rawTs).toISOString()
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

  // Return the last `limit` entries
  jsonResponse(res, 200, entries.slice(-limit));
}
