/**
 * Group Metadata Resolver
 *
 * Universal, self-healing group name resolution for all instance types.
 * Works the same way across passive (MCP), chat (HTTP), and agent (HTTP) modes.
 *
 * On chat list requests, any group without a stored name triggers a background
 * fetch via the instance's communication channel. Results are persisted to the
 * groups table and appear on the next poll cycle.
 */

import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mcpCall } from './mcp-client.ts';
import { proxyToInstance } from './http-proxy.ts';
import type { DiscoveredInstance } from './discovery.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('fleet:group-resolver');

/** Track which groups we've already attempted (avoid repeated failures). */
const attemptedCache = new Map<string, number>();
const RETRY_MS = 5 * 60 * 1000;

/**
 * Queue background resolution for groups missing names.
 * Non-blocking — returns immediately, backfill runs async.
 */
export function resolveGroupNames(
  instance: DiscoveredInstance,
  groupKeys: string[],
): void {
  if (groupKeys.length === 0) return;

  const now = Date.now();
  const pending = groupKeys.filter(key => {
    const cacheKey = `${instance.name}:${key}`;
    const last = attemptedCache.get(cacheKey);
    return !last || (now - last > RETRY_MS);
  });

  if (pending.length === 0) return;

  for (const key of pending) {
    attemptedCache.set(`${instance.name}:${key}`, now);
  }

  backfill(instance, pending).catch(err => {
    log.warn({ instance: instance.name, err: (err as Error).message }, 'group backfill failed');
  });
}

/**
 * Fetch group metadata via the instance — universal across all modes.
 * Route 1: MCP socket (passive instances with verified socket)
 * Route 2: HTTP health port (all instance types — universal fallback)
 */
async function fetchGroupMetadata(
  instance: DiscoveredInstance,
  groupJid: string,
): Promise<{ subject?: string; size?: number } | null> {
  // Route 1: MCP socket (if available and exists)
  if (instance.socketPath && fs.existsSync(instance.socketPath)) {
    try {
      const result = await mcpCall(instance.socketPath, 'get_group_metadata', { groupJid }, 8000);
      if (result.success) {
        const content = (result.result as Record<string, unknown>)?.content;
        const text = (Array.isArray(content) ? content.find((c: { type: string }) => c.type === 'text')?.text : null) as string | null;
        if (text) return JSON.parse(text);
      }
    } catch { /* fall through to HTTP */ }
  }

  // Route 2: HTTP health port (universal fallback for all modes)
  if (instance.healthPort) {
    try {
      const body = JSON.stringify({ groupJid });
      const result = await proxyToInstance(
        instance.healthPort,
        '/group-metadata',
        'POST',
        body,
        instance.healthToken,
      );
      if (result.status === 200) {
        const parsed = JSON.parse(result.body);
        if (parsed.subject) return parsed;
      }
    } catch { /* no route available */ }
  }

  return null;
}

async function backfill(
  instance: DiscoveredInstance,
  keys: string[],
): Promise<void> {
  let resolved = 0;

  for (const key of keys) {
    const jid = key.replace('_at_g.us', '@g.us');
    const metadata = await fetchGroupMetadata(instance, jid);
    if (!metadata?.subject) continue;

    try {
      const db = new DatabaseSync(instance.dbPath, { open: true });
      try {
        db.prepare(`
          INSERT OR REPLACE INTO groups (jid, subject, participant_count, updated_at)
          VALUES (?, ?, ?, datetime('now'))
        `).run(jid, metadata.subject, metadata.size ?? 0);
        resolved++;
      } finally {
        db.close();
      }
    } catch (err) {
      log.warn({ jid, err: (err as Error).message }, 'failed to store group metadata');
    }
  }

  if (resolved > 0) {
    log.info({ instance: instance.name, resolved, total: keys.length }, 'backfilled group names');
  }
}
