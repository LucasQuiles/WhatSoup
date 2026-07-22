import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { jsonResponse, parseQueryString, requireInstance, parseIntParam } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader, MessageRow } from '../db-reader.ts';
import { proxyToInstance } from '../http-proxy.ts';
import { configRoot } from '../paths.ts';

import { inspectLatestLogFile, readTailLinesDetailed } from '../log-utils.ts';
import { resolveGroupNames } from '../group-resolver.ts';
import { isGroupConversationKey, conversationKeyToJid } from '../../core/conversation-key.ts';
import { normalizeTimestamp, toIsoFromUnix } from '../time-utils.ts';
import { isTypingHealthEntry } from '../typing-payload.ts';
import { escapeDisplayControls } from '../../lib/display-controls.ts';

export interface DataDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

// Typed row interfaces for SQLite query results (replaces `as any` casts)
interface PreviewRow { content: string | null; sender_name: string | null; is_from_me: number }
interface UnreadRow { unread_count: number }
interface GroupNameRow { subject: string }
interface ChatNameRow { name: string }
interface ParticipantRow { sender_name: string }
interface DmNameRow { sender_name: string }

function logFieldToString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return String(value);
  }
}

function optionalLogFieldToString(value: unknown): string | undefined {
  const normalized = logFieldToString(value);
  return normalized === '' ? undefined : normalized;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requiredString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isoFromMaybeUnix(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? toIsoFromUnix(value) : '';
}

function messageDto(row: MessageRow) {
  const dto: {
    pk: number;
    conversationKey: string;
    senderJid: string;
    senderName: string;
    content: string | null;
    type: string;
    timestamp: string;
    fromMe: boolean;
    rawMessage?: string;
  } = {
    pk: row.pk,
    conversationKey: stringOrEmpty(row.conversation_key),
    senderJid: stringOrEmpty(row.sender_jid),
    senderName: stringOrEmpty(row.sender_name),
    content: typeof row.content === 'string' ? row.content : null,
    type: requiredString(row.content_type, 'unknown'),
    timestamp: isoFromMaybeUnix(row.timestamp),
    fromMe: row.is_from_me === 1,
  };

  if (typeof row.raw_message === 'string') {
    dto.rawMessage = row.raw_message;
  }

  return dto;
}

/** GET /api/lines/:name/chats — paginated chat list (ChatItem shape). */
export function handleGetChats(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
  params: { name: string },
): void {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const qs = parseQueryString(req.url);
  const limit = parseIntParam(qs, 'limit', 50, 1, 500);
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
      const lastMsg = previewStmt.get(chat.conversationKey) as PreviewRow | undefined;
      const preview = lastMsg?.content ?? null;
      const unread = (unreadStmt.get(chat.conversationKey) as UnreadRow | undefined)?.unread_count ?? 0;

      // Detect groups across every transport's raw or encoded key shape.
      const isGroup = isGroupConversationKey(chat.conversationKey);

      // Resolve display name
      let displayName: string;
      let needsBackfill = false;
      if (isGroup) {
        // Restore the transport-neutral conversation key for metadata lookup.
        const groupJid = conversationKeyToJid(chat.conversationKey);
        const groupSubject = (groupNameStmt.get(groupJid) as GroupNameRow | undefined)?.subject;
        const chatName = (chatNameStmt.get(chat.conversationKey) as ChatNameRow | undefined)?.name;
        if (groupSubject) {
          displayName = groupSubject;
        } else if (chatName) {
          displayName = chatName;
        } else {
          // No metadata — build from participant names (temporary fallback)
          const parts = (participantsStmt.all(chat.conversationKey) as unknown as ParticipantRow[]).map(p => p.sender_name);
          displayName = parts.length > 0 ? parts.join(', ') : chat.conversationKey;
          needsBackfill = true;
        }
      } else {
        // DM: prefer the other person's name
        const chatName = (chatNameStmt.get(chat.conversationKey) as ChatNameRow | undefined)?.name;
        const otherName = (dmNameStmt.get(chat.conversationKey) as DmNameRow | undefined)?.sender_name;
        displayName = chatName || otherName || chat.senderName || chat.conversationKey;
      }

      // Last message preview: prefix with sender name for groups
      let formattedPreview = preview;
      if (isGroup && preview && lastMsg?.sender_name && !lastMsg?.is_from_me) {
        const short = escapeDisplayControls(lastMsg.sender_name).split(' ')[0]; // first name only
        formattedPreview = `${short}: ${preview}`;
      } else if (isGroup && preview && lastMsg?.is_from_me) {
        formattedPreview = `You: ${preview}`;
      }

      return {
        conversationKey: chat.conversationKey,
        name: displayName,
        lastMessagePreview: formattedPreview ?? '',
        lastMessageAt: chat.lastMessageAt != null
          ? toIsoFromUnix(chat.lastMessageAt)
          : '',
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
    return {
      ...chat,
      name: requiredString((chat as { name?: unknown }).name, chat.conversationKey),
      lastMessagePreview: stringOrEmpty((chat as { lastMessagePreview?: unknown }).lastMessagePreview),
      lastMessageAt: stringOrEmpty((chat as { lastMessageAt?: unknown }).lastMessageAt),
    };
  });

  jsonResponse(res, 200, response);

  // Fire-and-forget: resolve missing group names via this instance's connection
  if (groupsNeedingBackfill.length > 0) {
    Promise.resolve(resolveGroupNames(instance, groupsNeedingBackfill))
      .catch(() => { /* group name backfill is best-effort — failure is not user-facing */ });
  }
}

/** GET /api/lines/:name/messages — paginated messages for a conversation. */
export function handleGetMessages(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
  params: { name: string },
): void {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const qs = parseQueryString(req.url);
  const conversationKey = qs.conversation_key;
  if (!conversationKey) {
    jsonResponse(res, 400, { error: 'missing required query parameter: conversation_key' });
    return;
  }

  const limit = parseIntParam(qs, 'limit', 50, 1, 500);
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
  const messages = result.data.map(messageDto);

  jsonResponse(res, 200, messages);
}

/** GET /api/lines/:name/messages/search — full-text search within an instance's messages. */
export function handleSearchMessages(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
  params: { name: string },
): void {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const qs = parseQueryString(req.url);
  const query = qs.q?.trim() ?? '';
  if (!query) {
    jsonResponse(res, 400, { error: 'missing required query parameter: q' });
    return;
  }

  const conversationKey = qs.conversation_key || undefined;
  const limit = parseIntParam(qs, 'limit', 20, 1, 100);

  const result = deps.dbReader.searchMessages(instance.name, instance.dbPath, {
    query,
    conversationKey,
    limit,
  });

  if (!result.ok) {
    jsonResponse(res, 500, { error: result.error });
    return;
  }

  const messages = result.data.map(messageDto);

  jsonResponse(res, 200, { results: messages, total: messages.length, query });
}

/** GET /api/lines/:name/access — access list entries. */
export function handleGetAccess(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
  params: { name: string },
): void {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

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
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const qs = parseQueryString(req.url);
  const levelFilter = qs.level ?? null;
  const limit = parseIntParam(qs, 'limit', 200, 1, 2000);

  const logResult = inspectLatestLogFile(instance.logDir);
  if (!logResult.ok) {
    jsonResponse(res, 503, {
      error: 'log evidence unavailable',
      code: logResult.code ?? 'UNKNOWN',
      detail: logResult.error,
    });
    return;
  }
  if (!logResult.file) {
    jsonResponse(res, 200, []);
    return;
  }
  const logFile = logResult.file.path;

  // readTailLinesDetailed reads last 64KB and returns up to maxLines — same logic that was inlined here
  const tailResult = readTailLinesDetailed(logFile, 2000);
  if (!tailResult.ok) {
    jsonResponse(res, 503, {
      error: 'log evidence unavailable',
      code: tailResult.code ?? 'UNKNOWN',
      detail: tailResult.error,
    });
    return;
  }
  const lines = tailResult.lines;

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
      const timestamp = normalizeTimestamp(rawTs) ?? new Date().toISOString();

      const level: 'debug' | 'info' | 'warn' | 'error' =
        typeof obj.level === 'number' ? (pinoLevelMap[obj.level] ?? 'info') : 'info';

      const source = logFieldToString(obj.name ?? obj.module, 'system');
      const component = optionalLogFieldToString(obj.component);
      const msg = logFieldToString(obj.msg);

      entries.push({ timestamp, level, msg, source, ...(component !== undefined ? { component } : {}) });
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
          if (!isTypingHealthEntry(entry)) continue;
          typing.push({ instance: inst.name, jid: entry.jid.trim(), since: entry.since });
        }
      }
    } catch { /* instance unreachable — skip */ }
  });

  await Promise.all(promises);
  jsonResponse(res, 200, typing);
}

/** GET /api/directories/check?path=... — check whether a directory exists and is writable. */
export function handleCheckDirectory(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const qs = parseQueryString(req.url);
  const dirPath = qs.path;
  if (!dirPath) {
    jsonResponse(res, 400, { error: 'missing required query parameter: path' });
    return;
  }
  const resolved = path.resolve(dirPath);
  if (!resolved.startsWith(os.homedir() + path.sep) && resolved !== os.homedir()) {
    jsonResponse(res, 400, { error: 'path must be within the home directory' });
    return;
  }
  let exists = false;
  let writable = false;
  try {
    const stat = fs.statSync(resolved);
    exists = stat.isDirectory();
    if (exists) {
      fs.accessSync(resolved, fs.constants.W_OK);
      writable = true;
    }
  } catch {
    // exists stays false, or writable stays false
  }
  jsonResponse(res, 200, { exists, writable });
}

/** GET /api/lines/:name/exists — check whether an instance name is already taken. */
export function handleCheckExists(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: DataDeps,
  params: { name: string },
): void {
  const configDir = path.join(configRoot(), params.name);
  const exists = deps.discovery.getInstance(params.name) != null || fs.existsSync(configDir);
  jsonResponse(res, 200, { exists });
}
