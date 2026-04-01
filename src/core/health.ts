import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { getMessageCount } from './messages.ts';
import { getPendingCount, upsertAccess, type SubjectType } from './access-list.ts';
import type { ConnectionManager } from '../transport/connection.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';
import { normalizeErrorClass } from './heal-protocol.ts';
import type { Runtime } from '../runtimes/types.ts';

const log = createChildLogger('health');

export interface HealthDeps {
  db: Database;
  connectionManager: ConnectionManager;
  startedAt: number;
  getEnrichmentStats: () => { lastRun: string | null; unprocessed: number; runtimeDegraded?: boolean };
  durability?: DurabilityEngine;
  runtime?: Runtime;
  // Phase 1: instance identity for control-plane fleet discovery
  instanceName: string;
  instanceType: string;  // 'chat' | 'agent' | 'passive'
  accessMode: string;
  /** Callback for POST /access — allow triggers queued-message replay. */
  handleAccessDecision?: (subjectType: string, subjectId: string, action: 'allow' | 'block') => Promise<void>;
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

    // ── POST /heal — inject a Type 3 service-crash repair report ──
    if (req.url === '/heal' && req.method === 'POST') {
      (async () => {
        const jsonHeaders = { 'Content-Type': 'application/json' };

        // Auth check — same pattern as /send
        const authHeader = (req.headers as Record<string, string | undefined>)['authorization'];
        const expectedToken = process.env.WHATSOUP_HEALTH_TOKEN;
        if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
          res.writeHead(401, jsonHeaders);
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        // Parse body
        let rawBody = '';
        for await (const chunk of req) rawBody += chunk;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }

        if (!data['type']) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'missing type field' }));
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
          res.writeHead(409, jsonHeaders);
          res.end(JSON.stringify({ error: 'duplicate', existingReportId: existing.report_id }));
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

        res.writeHead(202, jsonHeaders);
        res.end(JSON.stringify({ reportId, errorClass }));
      })().catch((err) => {
        log.error({ err }, 'POST /heal: unhandled error');
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        } catch { /* response already started */ }
      });
      return;
    }

    // ── POST /access — allow or block a contact/group ──
    if (req.url === '/access' && req.method === 'POST') {
      (async () => {
        const jsonHeaders = { 'Content-Type': 'application/json' };

        // Auth — same pattern as /send and /heal
        const authHeader = (req.headers as Record<string, string | undefined>)['authorization'];
        const expectedToken = process.env.WHATSOUP_HEALTH_TOKEN;
        if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
          res.writeHead(401, jsonHeaders);
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        // Parse body (with size limit matching /send)
        const MAX_BODY_BYTES = 64 * 1024;
        let rawBody = '';
        let byteCount = 0;
        let destroyed = false;
        await new Promise<void>((resolve) => {
          req.on('data', (chunk: Buffer) => {
            if (destroyed) return;
            byteCount += chunk.byteLength;
            if (byteCount > MAX_BODY_BYTES) {
              destroyed = true;
              res.writeHead(413, jsonHeaders);
              res.end(JSON.stringify({ error: 'request body too large' }));
              req.destroy();
              resolve();
              return;
            }
            rawBody += chunk;
          });
          req.once('end', resolve);
        });
        if (destroyed) return;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }

        const subjectType = data['subjectType'] as string | undefined;
        const subjectId = data['subjectId'] as string | undefined;
        const action = data['action'] as string | undefined;

        if (!subjectType || !subjectId || !action) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'subjectType, subjectId, and action are required' }));
          return;
        }
        if (subjectType !== 'phone' && subjectType !== 'group') {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'subjectType must be "phone" or "group"' }));
          return;
        }
        if (action !== 'allow' && action !== 'block') {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'action must be "allow" or "block"' }));
          return;
        }

        const status = action === 'allow' ? 'allowed' as const : 'blocked' as const;
        const result = upsertAccess(deps.db, subjectType, subjectId, status);

        // Invoke runtime callback (allow triggers queued-message replay)
        if (deps.handleAccessDecision) {
          try {
            await deps.handleAccessDecision(subjectType, subjectId, action);
          } catch (err) {
            log.error({ err, subjectId, action }, '/access: handleAccessDecision callback failed');
          }
        }

        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify({ ok: true, action, subjectType, subjectId, result: result.action }));
      })().catch((err) => {
        log.error({ err }, 'POST /access: unhandled error');
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
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

      // Mode-specific runtime block for control-plane
      let runtimeBlock: Record<string, unknown> = {};
      if (deps.runtime) {
        const snap = deps.runtime.getHealthSnapshot();
        if (deps.instanceType === 'passive') {
          runtimeBlock = { passive: snap.details };
        } else if (deps.instanceType === 'chat') {
          const details = snap.details as Record<string, unknown>;
          const queue = details.queue as { activeChats?: number; queuedChats?: number } | undefined;
          runtimeBlock = {
            chat: {
              queueDepth: (queue?.activeChats ?? 0) + (queue?.queuedChats ?? 0),
              enrichmentUnprocessed: enrichmentStats.unprocessed,
            },
          };
        } else if (deps.instanceType === 'agent') {
          runtimeBlock = { agent: snap.details };
        }
      }

      const body = JSON.stringify({
        status,
        uptime_seconds: Math.floor((Date.now() - deps.startedAt) / 1000),
        instance: {
          name: deps.instanceName,
          mode: deps.instanceType,
          accessMode: deps.accessMode,
        },
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
        runtime: runtimeBlock,
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
