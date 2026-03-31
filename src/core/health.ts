import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { getMessageCount } from './messages.ts';
import { getPendingCount } from './access-list.ts';
import type { ConnectionManager } from '../transport/connection.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';

const log = createChildLogger('health');

export interface HealthDeps {
  db: Database;
  connectionManager: ConnectionManager;
  startedAt: number;
  getEnrichmentStats: () => { lastRun: string | null; unprocessed: number; runtimeDegraded?: boolean };
  durability?: DurabilityEngine;
}

function safeDbQuery<T>(fn: () => T, fallback: T, warnMsg: string): T {
  const start = Date.now();
  try {
    const result = fn();
    const elapsed = Date.now() - start;
    if (elapsed > 2_000) log.warn({ elapsed }, warnMsg + ' (slow query)');
    return result;
  } catch (err) {
    log.error({ err }, warnMsg);
    return fallback;
  }
}

export const ENRICHMENT_STALE_MS = 10 * 60 * 1000; // 10 minutes

export function startHealthServer(deps: HealthDeps): ReturnType<typeof createServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // ── POST /send — send a text message to any chat ──
    if (req.url === '/send' && req.method === 'POST') {
      // Shared-secret Authorization header check
      const authHeader = (req.headers as Record<string, string | undefined>)['authorization'];
      const expectedToken = process.env.WHATSOUP_HEALTH_TOKEN;
      if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const MAX_BODY_BYTES = 64 * 1024; // 64 KB
      let body = '';
      let byteCount = 0;
      let destroyed = false;
      req.on('data', (chunk) => {
        if (destroyed) return;
        byteCount += Buffer.byteLength(chunk);
        if (byteCount > MAX_BODY_BYTES) {
          destroyed = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'request body too large' }));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (destroyed) return;
        try {
          const { chatJid, text } = JSON.parse(body) as { chatJid?: string; text?: string };
          if (!chatJid || !text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'chatJid and text are required' }));
            return;
          }
          sendTracked(deps.connectionManager, chatJid, text, deps.durability, { replayPolicy: 'unsafe' })
            .then(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            })
            .catch((err) => {
              log.error({ err, chatJid }, 'POST /send failed');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
            });
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
        }
      });
      return;
    }

    if (req.url !== '/health' || req.method !== 'GET') {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const enrichmentStats = deps.getEnrichmentStats();

      const isConnected = deps.connectionManager.botJid !== null;
      const enrichmentStaleness = enrichmentStats.lastRun
        ? Date.now() - new Date(enrichmentStats.lastRun).getTime()
        : null;

      let status: 'healthy' | 'degraded' | 'unhealthy';
      if (!isConnected) {
        status = 'unhealthy';
      } else if (
        (enrichmentStaleness !== null && enrichmentStaleness > ENRICHMENT_STALE_MS) ||
        enrichmentStats.runtimeDegraded
      ) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }

      const messagesTotal = safeDbQuery(
        () => getMessageCount(deps.db),
        0,
        'failed to count messages',
      );

      const pendingCount = safeDbQuery(
        () => getPendingCount(deps.db),
        0,
        'failed to count pending access-list entries',
      );

      const body = JSON.stringify({
        status,
        uptime_seconds: Math.floor((Date.now() - deps.startedAt) / 1000),
        whatsapp: {
          connected: isConnected,
          account_jid: deps.connectionManager.botJid ?? 'not connected',
        },
        sqlite: {
          messages_total: messagesTotal,
          unprocessed: enrichmentStats.unprocessed,
        },
        access_control: {
          pending_count: pendingCount,
        },
        enrichment: {
          last_run: enrichmentStats.lastRun,
        },
        models: {
          conversation: config.models.conversation,
          extraction: config.models.extraction,
          validation: config.models.validation,
          fallback: config.models.fallback,
        },
        durability: deps.durability?.getHealthStats() ?? null,
      });

      // 'degraded' returns 200: enrichment staleness is a warning, not a
      // service outage. Callers check the JSON body for "status":"degraded".
      // Only 'unhealthy' (WhatsApp disconnected) warrants a 503.
      const httpStatus = status === 'unhealthy' ? 503 : 200;
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      log.error({ err }, 'health check failed');
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error' }));
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error({ port: config.healthPort }, 'health server port in use — another instance may be running');
    } else {
      log.error({ err, port: config.healthPort }, 'health server error');
    }
  });

  server.listen(config.healthPort, '127.0.0.1', () => {
    log.info({ port: config.healthPort }, 'health server listening');
  });

  return server;
}
