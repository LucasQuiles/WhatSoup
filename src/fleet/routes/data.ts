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

/** GET /api/lines/:name/chats — paginated chat list. */
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
  jsonResponse(res, 200, result.data);
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
  jsonResponse(res, 200, result.data);
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
  jsonResponse(res, 200, result.data);
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
  const entries: unknown[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (levelFilter && obj.level !== undefined) {
        // pino uses numeric levels: 10=trace,20=debug,30=info,40=warn,50=error,60=fatal
        // Accept either numeric match or label match
        const numLevel = parseInt(levelFilter, 10);
        if (!isNaN(numLevel)) {
          if (obj.level !== numLevel) continue;
        } else if (typeof obj.level === 'number') {
          const labelMap: Record<number, string> = {
            10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
          };
          if (labelMap[obj.level] !== levelFilter) continue;
        }
      }
      entries.push(obj);
    } catch {
      // Skip non-JSON lines
    }
  }

  // Return the last `limit` entries
  jsonResponse(res, 200, entries.slice(-limit));
}
