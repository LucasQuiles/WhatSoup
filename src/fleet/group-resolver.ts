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
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../lib/sqlite-constants.ts';
import { mcpCall } from './mcp-client.ts';
import { proxyToInstance } from './http-proxy.ts';
import { conversationKeyToJid } from '../core/conversation-key.ts';
import type { DiscoveredInstance } from './discovery.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('fleet:group-resolver');

/** Track which groups we've already attempted (avoid repeated failures). */
const attemptedCache = new Map<string, number>();
const RETRY_MS = 5 * 60 * 1000;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
let lastPruneAt = 0;

function pruneAttemptedCache(now: number): void {
  for (const [cacheKey, attemptedAt] of attemptedCache) {
    if (now - attemptedAt > RETRY_MS) {
      attemptedCache.delete(cacheKey);
    }
  }
}

function rememberAttempt(cacheKey: string, now: number): void {
  attemptedCache.set(cacheKey, now);
}

/** Test-only helpers for LEAK-10 coverage. */
export function __resetAttemptedCacheForTests(): void {
  attemptedCache.clear();
  lastPruneAt = 0;
}

/** Test-only helpers for LEAK-10 coverage. */
export function __setAttemptedCacheEntryForTests(cacheKey: string, attemptedAt: number): void {
  attemptedCache.set(cacheKey, attemptedAt);
}

/** Test-only helpers for LEAK-10 coverage. */
export function __getAttemptedCacheKeysForTests(): string[] {
  return [...attemptedCache.keys()];
}

/** Test-only helpers for LEAK-10 coverage. */
export function __pruneAttemptedCacheForTests(now: number): void {
  pruneAttemptedCache(now);
}

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
  if (now - lastPruneAt > PRUNE_INTERVAL_MS) {
    pruneAttemptedCache(now);
    lastPruneAt = now;
  }
  const pending = groupKeys.filter(key => {
    const cacheKey = `${instance.name}:${key}`;
    const last = attemptedCache.get(cacheKey);
    return !last || (now - last > RETRY_MS);
  });

  if (pending.length === 0) return;

  for (const key of pending) {
    rememberAttempt(`${instance.name}:${key}`, now);
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
      const result = await mcpCall(instance.socketPath, 'get_group_metadata', { jid: groupJid }, 8000);
      if (result.success && !result.toolError) {
        const resultObj = result.result as Record<string, unknown>;
        const content = resultObj?.content;
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
    const jid = conversationKeyToJid(key);
    const metadata = await fetchGroupMetadata(instance, jid);
    if (!metadata?.subject) continue;

    try {
      const db = new DatabaseSync(instance.dbPath, { open: true });
      try {
        // The instance process is actively writing the same bot.db. Without a busy
        // timeout this second writer gets an immediate SQLITE_BUSY under WAL; wait for
        // the lock instead, matching FleetDbReader.queryWrite (db-reader.ts).
        db.prepare(SQLITE_BUSY_TIMEOUT_PRAGMA).run();
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
