import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { safeStringEqual } from '../fleet/safe-compare.ts';
import { createChildLogger } from '../logger.ts';
import type { Database } from './database.ts';
import { getMessageCount } from './messages.ts';
import { getPendingCount, upsertAccess } from './access-list.ts';
import type { ConnectionManager } from '../transport/connection.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';
import {
  AliasNotFoundError,
  MissingTargetError,
  MutuallyExclusiveError,
  createChatResolver,
} from './chats-resolver.ts';
import {
  InvalidSendRequestError,
  MissingTextError,
  createSendPipeline,
} from './send-pipeline.ts';
import { UnknownProfileError, type ProfileRegistry } from './profiles.ts';
import type { OutboundSendsWriter } from './outbound-sends.ts';
import { normalizeErrorClass } from './heal-protocol.ts';
import { markConversationRead } from './mark-read.ts';
import type { Runtime } from '../runtimes/types.ts';
import type { ConnectionStateSnapshot } from '../transport/connection.ts';
import { readBody } from '../lib/http.ts';

const log = createChildLogger('health');

/**
 * Timing-safe bearer token comparison to prevent timing attacks.
 *
 * Uses the shared `safeStringEqual` helper so a multibyte / malformed
 * `Authorization` header — e.g. `'Bearer ' + 'é'.repeat(N)` — returns
 * `false` instead of throwing a `RangeError` up the HTTP handler stack
 * (see #405). Pre-fix this could crash the request before the 401 reply.
 */
function verifyBearer(header: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken || !header) return false;
  return safeStringEqual(header, `Bearer ${expectedToken}`);
}

export interface HealthDeps {
  db: Database;
  connectionManager: ConnectionManager;
  startedAt: number;
  getEnrichmentStats: () => { lastRun: string | null; unprocessed: number; runtimeDegraded?: boolean };
  durability?: DurabilityEngine;
  runtime?: Runtime;
  profiles?: ProfileRegistry;
  auditWriter?: OutboundSendsWriter;
  // Instance identity for control-plane fleet discovery
  instanceName: string;
  instanceType: string;  // 'chat' | 'agent' | 'passive'
  accessMode: string;
  socketPath?: string | null;
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

function getConnectionState(connectionManager: HealthDeps['connectionManager']): ConnectionStateSnapshot {
  if (typeof (connectionManager as { getConnectionState?: unknown }).getConnectionState === 'function') {
    return (connectionManager as { getConnectionState: () => ConnectionStateSnapshot }).getConnectionState();
  }

  const connected = connectionManager.botJid !== null;
  return {
    state: connected ? 'connected' : 'disconnected',
    connected,
    reconnectAttempts: 0,
    reconnectPhase: null,
    stateChangedAt: new Date().toISOString(),
    firstFailureAt: null,
    lastPingAt: null,
    lastPongAt: null,
  };
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const authHeader = (req.headers as Record<string, string | undefined>)['authorization'];
  const expectedToken = process.env.WHATSOUP_HEALTH_TOKEN;
  if (!verifyBearer(authHeader, expectedToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function agentCommandStatus(err: unknown): number {
  const status = (err as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendRequestErrorMessage(err: unknown): string {
  if (
    err instanceof AliasNotFoundError ||
    err instanceof MissingTargetError ||
    err instanceof MutuallyExclusiveError ||
    err instanceof InvalidSendRequestError ||
    err instanceof MissingTextError ||
    err instanceof UnknownProfileError
  ) {
    return err.message;
  }
  return 'invalid send request';
}

export function startHealthServer(deps: HealthDeps): ReturnType<typeof createServer> {
  const chatResolver = createChatResolver({ db: deps.db.raw });
  const sendPipeline = createSendPipeline({
    resolver: chatResolver,
    profiles: deps.profiles,
    auditWriter: deps.auditWriter,
    caller: 'health',
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // ── POST /send — send a text message to any chat ──
    if (req.url === '/send' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;

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
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
          return;
        }

        sendPipeline.executeSend(parsed, async (prepared) => {
          await sendTracked(deps.connectionManager, prepared.chatJid, prepared.text, deps.durability, { replayPolicy: 'unsafe' });
          return {};
        })
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          })
          .catch((err) => {
            const sendError = sendRequestErrorMessage(err);
            if (sendError !== 'invalid send request') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: sendError }));
              return;
            }
            log.error({ err }, 'POST /send failed');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          });
      });
      return;
    }

    // ── POST /agent/compact — run runtime compaction without WhatsApp ingest ──
    if (req.url === '/agent/compact' && req.method === 'POST') {
      (async () => {
        const jsonHeaders = { 'Content-Type': 'application/json' };

        if (!requireAuth(req, res)) return;

        if (deps.instanceType !== 'agent' || !deps.runtime?.handleAgentCommand) {
          res.writeHead(409, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'agent commands are only available on agent instances' }));
          return;
        }

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
              res.end(JSON.stringify({ ok: false, error: 'request body too large' }));
              req.destroy();
              resolve();
              return;
            }
            rawBody += chunk;
          });
          req.once('end', resolve);
        });
        if (destroyed) return;

        let data: unknown;
        try {
          data = rawBody.trim() === '' ? {} : JSON.parse(rawBody);
        } catch {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
          return;
        }
        if (!isJsonObject(data)) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'request body must be a JSON object' }));
          return;
        }

        const chatJid = data['chatJid'];
        const silent = data['silent'];
        if (chatJid !== undefined && typeof chatJid !== 'string') {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'chatJid must be a string when provided' }));
          return;
        }
        if (silent !== undefined && typeof silent !== 'boolean') {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'silent must be a boolean when provided' }));
          return;
        }

        try {
          const result = await deps.runtime.handleAgentCommand({
            command: 'compact',
            ...(chatJid !== undefined ? { chatJid } : {}),
            silent: silent !== false,
          });
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify(result));
        } catch (err) {
          const code = (err as { code?: unknown })?.code;
          res.writeHead(agentCommandStatus(err), jsonHeaders);
          res.end(JSON.stringify({
            ok: false,
            error: (err as Error).message,
            ...(typeof code === 'string' ? { code } : {}),
          }));
        }
      })().catch((err) => {
        log.error({ err }, 'POST /agent/compact: unhandled error');
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'internal error' }));
        } catch { /* response already started */ }
      });
      return;
    }

    // ── POST /heal — inject a Type 3 service-crash repair report ──
    if (req.url === '/heal' && req.method === 'POST') {
      (async () => {
        const jsonHeaders = { 'Content-Type': 'application/json' };

        if (!requireAuth(req, res)) return;

        let rawBody = '';
        try {
          rawBody = await readBody(req);
        } catch (err) {
          res.writeHead(agentCommandStatus(err), jsonHeaders);
          res.end(JSON.stringify({ error: (err as Error).message }));
          return;
        }

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

        if (!requireAuth(req, res)) return;

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

    // ── POST /mark-read — zero unread_count for a chat and send chatModify ──
    if (req.url === '/mark-read' && req.method === 'POST') {
      (async () => {
        const jsonHeaders = { 'Content-Type': 'application/json' };

        if (!requireAuth(req, res)) return;

        // Parse body (with size limit matching /access)
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

        const conversation_key = data['conversation_key'] as string | undefined;
        if (!conversation_key) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'conversation_key is required' }));
          return;
        }

        const result = await markConversationRead(deps.db, deps.connectionManager, conversation_key);
        if (!result.ok) {
          res.writeHead(404, jsonHeaders);
          res.end(JSON.stringify({ error: 'chat not found', conversation_key }));
          return;
        }

        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify(result));
      })().catch((err) => {
        log.error({ err }, 'POST /mark-read: unhandled error');
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        } catch { /* response already started */ }
      });
      return;
    }

    // ── GET /typing — return JIDs currently composing from presence cache ──
    if (req.url === '/typing' && req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const cache = deps.connectionManager.presenceCache;
      const composing: { jid: string; since: number }[] = [];
      // presenceCache.entries is private — expose via a method
      for (const [jid, result] of cache.getAll()) {
        if (result.status === 'composing') {
          composing.push({ jid, since: result.updatedAt });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ composing }));
      return;
    }

    if (req.url !== '/health' || req.method !== 'GET') {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const enrichmentStats = deps.getEnrichmentStats();
      const connectionState = getConnectionState(deps.connectionManager);

      const isConnected = connectionState.connected;
      const isRecoveringConnection =
        connectionState.state === 'connecting'
        || connectionState.state === 'reconnecting'
        || connectionState.state === 'cooldown';
      const enrichmentStaleness = enrichmentStats.lastRun
        ? Date.now() - new Date(enrichmentStats.lastRun).getTime()
        : null;

      // Determine health status.
      // Enrichment staleness only matters if enrichment has actually run before
      // (instances without RAG/Pinecone never run enrichment — that's not degraded).
      const enrichmentIsStale = enrichmentStaleness !== null && enrichmentStaleness > ENRICHMENT_STALE_MS;
      let status: 'healthy' | 'degraded' | 'unhealthy';
      if (!isConnected) {
        status = isRecoveringConnection ? 'degraded' : 'unhealthy';
      } else if (enrichmentIsStale || enrichmentStats.runtimeDegraded) {
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

      const schemaVersion = safeDbQuery(
        () => {
          const row = deps.db.raw.prepare('PRAGMA schema_version').get() as { schema_version: number } | undefined;
          return row?.schema_version ?? 0;
        },
        0,
        'failed to read sqlite schema_version',
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
          socketPath: deps.socketPath ?? null,
          provider: config.agentProvider,
        },
        whatsapp: {
          connected: isConnected,
          account_jid: deps.connectionManager.botJid ?? 'not connected',
          connection: {
            state: connectionState.state,
            changed_at: connectionState.stateChangedAt,
            reconnect_attempts: connectionState.reconnectAttempts,
            reconnect_phase: connectionState.reconnectPhase,
            first_failure_at: connectionState.firstFailureAt,
            last_ping_at: connectionState.lastPingAt,
            last_pong_at: connectionState.lastPongAt,
          },
        },
        sqlite: {
          schema_version: schemaVersion,
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

      // 'degraded' returns 200: enrichment staleness and active reconnect/cooldown
      // are warnings, not hard outages. Callers inspect the JSON body for detail.
      // Only a fully disconnected/non-recovering state warrants a 503.
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

  const healthHost = process.env.HEALTH_BIND_ADDRESS ?? '127.0.0.1';
  server.listen(config.healthPort, healthHost, () => {
    log.info({ port: config.healthPort, host: healthHost }, 'health server listening');
  });

  return server;
}
