import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { getMessageCount } from './messages.ts';
import { getPendingCount } from './access-list.ts';
import type { ConnectionManager } from '../transport/connection.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';
import { normalizeErrorClass } from './heal-protocol.ts';
import type { Runtime } from '../runtimes/types.ts';
import { readBody, jsonResponse, checkBearerAuth } from '../lib/http.ts';

const log = createChildLogger('health');

export interface HealthDeps {
  db: Database;
  connectionManager: ConnectionManager;
  startedAt: number;
  getEnrichmentStats: () => { lastRun: string | null; unprocessed: number; runtimeDegraded?: boolean };
  durability?: DurabilityEngine;
  runtime?: Runtime;
  socketPath?: string | null;
  instanceType?: string;
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

/** Fail-closed auth: rejects when no token is configured or when the Bearer token doesn't match. */
function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const expectedToken = process.env.WHATSOUP_HEALTH_TOKEN;
  if (!expectedToken || !checkBearerAuth(req, expectedToken)) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

export function startHealthServer(deps: HealthDeps): ReturnType<typeof createServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // ── POST /send — send a text message to any chat ──
    if (req.url === '/send' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;

      readBody(req)
        .then((raw) => {
          try {
            const { chatJid, text } = JSON.parse(raw) as { chatJid?: string; text?: string };
            if (!chatJid || !text) {
              jsonResponse(res, 400, { ok: false, error: 'chatJid and text are required' });
              return;
            }
            sendTracked(deps.connectionManager, chatJid, text, deps.durability, { replayPolicy: 'unsafe' })
              .then(() => jsonResponse(res, 200, { ok: true }))
              .catch((err) => {
                log.error({ err, chatJid }, 'POST /send failed');
                jsonResponse(res, 500, { ok: false, error: (err as Error).message });
              });
          } catch {
            jsonResponse(res, 400, { ok: false, error: 'invalid JSON' });
          }
        })
        .catch((err) => {
          const status = (err as any).statusCode ?? 500;
          jsonResponse(res, status, { ok: false, error: (err as Error).message });
        });
      return;
    }

    // ── POST /heal — inject a Type 3 service-crash repair report ──
    if (req.url === '/heal' && req.method === 'POST') {
      (async () => {
        const expectedToken = process.env.WHATSOUP_HEALTH_TOKEN;
        if (!expectedToken || !checkBearerAuth(req, expectedToken)) {
          jsonResponse(res, 401, { error: 'unauthorized' });
          return;
        }

        const rawBody = await readBody(req);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          jsonResponse(res, 400, { error: 'invalid JSON' });
          return;
        }

        if (!data['type']) {
          jsonResponse(res, 400, { error: 'missing type field' });
          return;
        }

        const reportId = (data['reportId'] as string | undefined) ?? randomUUID();
        const errorClass = normalizeErrorClass(
          data['type'] as string,
          (data['errorHint'] as string | undefined) ?? (data['context'] as string | undefined) ?? 'unknown',
        );

        // Dedupe: reject if an unresolved report for the same error_class already exists
        const existing = deps.db.raw
          .prepare("SELECT report_id FROM pending_heal_reports WHERE error_class = ? AND state != 'resolved'")
          .get(errorClass) as { report_id: string } | undefined;

        if (existing) {
          jsonResponse(res, 409, { error: 'duplicate', existingReportId: existing.report_id });
          return;
        }

        // Store pending report
        deps.db.raw
          .prepare('INSERT INTO pending_heal_reports (report_id, error_class, context) VALUES (?, ?, ?)')
          .run(reportId, errorClass, JSON.stringify(data));

        // Dispatch to runtime
        if (deps.runtime?.handleControlTurn) {
          const payload = JSON.stringify({ ...data, reportId, errorClass });
          try {
            await deps.runtime.handleControlTurn(reportId, payload);
          } catch (err) {
            log.error({ err, reportId }, '/heal: handleControlTurn failed');
          }
        }

        jsonResponse(res, 202, { reportId, errorClass });
      })().catch((err) => {
        log.error({ err }, 'POST /heal: unhandled error');
        try {
          jsonResponse(res, 500, { error: 'internal error' });
        } catch { /* response already started */ }
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

      const responseBody = {
        status,
        uptime_seconds: Math.floor((Date.now() - deps.startedAt) / 1000),
        instance: {
          name: config.botName,
          mode: deps.instanceType ?? 'chat',
          accessMode: config.accessMode,
          socketPath: deps.socketPath ?? null,
        },
        whatsapp: {
          connected: isConnected,
          account_jid: deps.connectionManager.botJid ?? 'not connected',
        },
        sqlite: {
          messages_total: messagesTotal,
          unprocessed: enrichmentStats.unprocessed,
          schema_version: safeDbQuery(
            () => {
              const row = deps.db.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number } | undefined;
              return row?.v ?? 0;
            },
            0,
            'failed to get schema version',
          ),
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
      };

      // 'degraded' returns 200: enrichment staleness is a warning, not a
      // service outage. Callers check the JSON body for "status":"degraded".
      // Only 'unhealthy' (WhatsApp disconnected) warrants a 503.
      const httpStatus = status === 'unhealthy' ? 503 : 200;
      jsonResponse(res, httpStatus, responseBody);
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
