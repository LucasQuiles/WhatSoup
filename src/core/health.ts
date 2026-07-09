import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { safeStringEqual } from '../lib/safe-compare.ts';
import { createChildLogger } from '../logger.ts';
import { CURRENT_SCHEMA_MIGRATION, type Database } from './database.ts';
import { readArcBindingHealth } from './arc-binding-health.ts';
import { assertSafeHealthBind } from './health-bind-guard.ts';
import { getMessageCount } from './messages.ts';
import { getPendingCount, upsertAccess } from './access-list.ts';
import type { RuntimeConnection } from '../transport/runtime-connection.ts';
import { decideDisconnectAction } from '../transport/auth-disconnect-policy.ts';
import { DEFAULT_FRESH_INVALID_GRACE_MS } from '../lib/auth-bond-policy.ts';
import type { DurabilityEngine } from './durability.ts';
import { sendTracked } from './durability.ts';
import { isRecord } from '../lib/type-guards.ts';
import { getModelAdvisories } from '../lib/model-advisor.ts';
import { enqueueScheduledMessage, type EnqueueMessageParams } from './schedule-enqueue.ts';
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
import type { ConnectionRecentDisconnects, ConnectionStateSnapshot } from '../transport/connection.ts';
import { readBody } from '../lib/http.ts';
import { readWhatsoupGitBranch, readWhatsoupGitSha } from '../lib/git-env.ts';

const log = createChildLogger('health');
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
  connectionManager: RuntimeConnection;
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
  /** Filesystem root that POST /schedule bounds media file paths to (fail-closed; route replies 409 when unset). */
  scheduleAllowedRoot?: string;
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

interface LatestSuccessfulOutboundSend {
  latest_successful_send_at: string | null;
  latest_successful_transport_id: string | null;
}

interface HealthTurnCapability {
  model_usable: boolean | null;
  // #1392 freshness fields: surfaced so runtime.agent.turnCapability and the
  // top-level snake-case turn_capability are freshness-honest too, not just
  // instance.turnCapability. Without these a consumer (e.g.
  // deploy/scripts/whatsoup-keychain-heal.sh) reading model_usable here can
  // act on a stale green. See FLEET-MATRIX F1.
  model_usable_stale: boolean | null;
  model_usable_checked_at: number | null;
  model_usability_status: string | null;
  last_successful_turn_at: number | null;
  last_turn_error_class: string | null;
  last_turn_error_at: number | null;
}

const HEALTH_MODEL_USABILITY_STATUSES = new Set([
  'usable',
  'model-unavailable',
  'credential-unavailable',
  'provider-unavailable',
  'timeout',
  'unknown',
]);

const HEALTH_TURN_ERROR_CLASSES = new Set([
  'usage-limit',
  'rate-limit',
  'auth-required',
  'model-unavailable',
  'policy-block',
  'context-overflow',
  'unknown-terminal',
  'empty-output',
]);

function latestSuccessfulOutboundSend(deps: HealthDeps): LatestSuccessfulOutboundSend {
  return safeDbQuery(
    () => {
      const row = deps.db.raw.prepare(`
        SELECT
          completed_at AS sent_at,
          transport_message_id AS transport_id
        FROM outbound_sends
        WHERE status = 'sent'
          AND completed_at IS NOT NULL
        ORDER BY completed_at DESC, id DESC
        LIMIT 1
      `).get() as { sent_at: string | null; transport_id: string | null } | undefined;
      return {
        latest_successful_send_at: row?.sent_at ?? null,
        latest_successful_transport_id: row?.transport_id ?? null,
      };
    },
    { latest_successful_send_at: null, latest_successful_transport_id: null },
    'failed to read latest successful outbound send',
  );
}

function normalizeBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeEnumStringOrNull(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function normalizeAgentTurnCapability(details: Record<string, unknown> | null): HealthTurnCapability | null {
  if (!details) return null;
  const raw = details.turnCapability;
  if (!isRecord(raw)) return null;
  return {
    model_usable: normalizeBooleanOrNull(raw.modelUsable),
    model_usable_stale: normalizeBooleanOrNull(raw.modelUsableStale),
    model_usable_checked_at: normalizeNumberOrNull(raw.modelUsableCheckedAt),
    model_usability_status: normalizeEnumStringOrNull(raw.modelUsabilityStatus, HEALTH_MODEL_USABILITY_STATUSES),
    last_successful_turn_at: normalizeNumberOrNull(raw.lastSuccessfulTurnAt),
    last_turn_error_class: normalizeEnumStringOrNull(raw.lastTurnErrorClass, HEALTH_TURN_ERROR_CLASSES),
    last_turn_error_at: normalizeNumberOrNull(raw.lastTurnErrorAt),
  };
}

function agentRuntimeDetailsForHealth(
  details: Record<string, unknown>,
  turnCapability: HealthTurnCapability | null,
): Record<string, unknown> {
  if (!('turnCapability' in details)) return details;
  return {
    ...details,
    turnCapability: turnCapability
      ? {
          modelUsable: turnCapability.model_usable,
          modelUsableStale: turnCapability.model_usable_stale,
          modelUsableCheckedAt: turnCapability.model_usable_checked_at,
          modelUsabilityStatus: turnCapability.model_usability_status,
          lastSuccessfulTurnAt: turnCapability.last_successful_turn_at,
          lastTurnErrorClass: turnCapability.last_turn_error_class,
          lastTurnErrorAt: turnCapability.last_turn_error_at,
        }
      : null,
  };
}

/**
 * ALERT-07 (WS-ALERT): derive a deterministic provider-reauth signal from the
 * existing turn_capability enums, so downstream consumers (the fleet
 * health-poller's provider-auth classifier, the fleet matrix) share one
 * derivation instead of each re-deriving it and drifting.
 *
 * TRUE when a probe/turn proved the primary needs human/provider re-auth:
 * model_usability_status==='credential-unavailable', or a last_turn_error_class
 * of 'auth-required' that has NOT been superseded by a fresher usable probe.
 *
 * Freshness supersession (fleet-cred spec decision 8): lastTurnErrorClass is
 * nulled only by a successful USER turn — never by the usability probe — so on
 * an idle bot the class would latch this flag true forever after the owner
 * re-authenticates (review wf_dc1654c1 finding 1). A usable probe strictly
 * newer than the auth error supersedes it; missing timestamps cannot prove
 * supersession and stay true (conservative).
 *
 * Everything else is FALSE — null turn_capability, null/'unknown' status, and
 * non-auth degradations (model-unavailable / provider-unavailable / timeout)
 * are provider_probe_inconclusive-class conditions and must never page reauth.
 */
function turnCapabilityReauthRequired(tc: HealthTurnCapability | null): boolean {
  if (tc === null) return false;
  if (tc.model_usability_status === 'credential-unavailable') return true;
  if (tc.last_turn_error_class !== 'auth-required') return false;
  return !(
    tc.model_usability_status === 'usable' &&
    tc.model_usable === true &&
    tc.model_usable_checked_at !== null &&
    tc.last_turn_error_at !== null &&
    tc.model_usable_checked_at > tc.last_turn_error_at
  );
}

export const ENRICHMENT_STALE_MS = 10 * 60 * 1000; // 10 minutes
const RECENT_DISCONNECT_DEGRADED_THRESHOLD = 3;
// #1433 — a post-first-turn `empty-output` is benign-by-default (the model
// returned one empty turn and typically recovers on the next). It only degrades
// when it is a CURRENT (came after the last successful turn), SUSTAINED stall:
//  - DEBOUNCE: must persist this long un-superseded before degrading, so a single
//    transient empty turn followed by a success never flaps the health body.
//  - STALE: a trailing empty-output older than this with no recovery is treated as
//    a benign idle artifact and self-clears (an idle bot has no turn to clear it);
//    a genuinely-broken model is still caught independently by model_usable===false.
const EMPTY_OUTPUT_DEGRADE_DEBOUNCE_MS = 60 * 1000; // 1 minute
const EMPTY_OUTPUT_STALE_MS = 15 * 60 * 1000; // 15 minutes

type AuthFailureClass =
  | 'none'
  | 'pairing_required'
  | 'serverside_logout_irreversible'
  | 'local_corruption_restorable'
  | 'local_corruption_unrestorable'
  | 'auth_bond_at_risk';

type DisconnectClass =
  | 'none'
  | 'serverside_logout_irreversible'
  | 'duplicate_session_replaced'
  | 'multidevice_mismatch'
  | 'restart_required'
  | 'restart_required_flapping'
  | 'transient_reconnect'
  | 'unknown_reconnect';


function emptyRecentDisconnects(): ConnectionRecentDisconnects {
  return {
    windowMs: 10 * 60 * 1000,
    count: 0,
    lastAt: null,
    lastReason: null,
    lastStatusCode: null,
    byReason: {},
  };
}

function getConnectionState(connectionManager: HealthDeps['connectionManager']): ConnectionStateSnapshot {
  if (typeof (connectionManager as { getConnectionState?: unknown }).getConnectionState === 'function') {
    return (connectionManager as { getConnectionState: () => ConnectionStateSnapshot }).getConnectionState();
  }

  const connected = connectionManager.botJid !== null;
  const cfg = config as typeof config & {
    authDir?: string;
    stateRoot?: string;
    dataRoot?: string;
    lockPath?: string;
    agentProvider?: string;
  };
  return {
    state: connected ? 'connected' : 'disconnected',
    connected,
    reconnectAttempts: 0,
    reconnectPhase: null,
    stateChangedAt: new Date().toISOString(),
    firstFailureAt: null,
    lastPingAt: null,
    lastPongAt: null,
    lastDisconnectReason: null,
    lastStatusCode: null,
    recentDisconnects: emptyRecentDisconnects(),
    credentialLifecycle: {
      version: 1,
      redaction: {
        version: 1,
        policy: 'credential material, tokens, pairing codes, full JIDs, and full phone numbers are blocked; identity fields use short hashes only',
      },
      environment: {
        instance: config.botName,
        host: process.env['HOSTNAME'] ?? 'unknown',
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        release: 'unknown',
        processUptimeSeconds: Math.floor(process.uptime()),
        osUptimeSeconds: 0,
        loadavg: [],
        memory: {
          freeBytes: 0,
          totalBytes: 0,
        },
        authDir: cfg.authDir ?? 'unknown',
        stateRoot: cfg.stateRoot ?? null,
        dataRoot: cfg.dataRoot ?? null,
        lockPath: cfg.lockPath ?? 'unknown',
        healthPort: config.healthPort,
        provider: cfg.agentProvider ?? 'unknown',
      },
      currentAuthBond: {
        status: 'missing',
        issues: ['connection_manager_does_not_expose_auth_bond'],
        authDir: { path: cfg.authDir ?? 'unknown', exists: false, mode: null, size: null, mtime: null },
        creds: {
          path: cfg.authDir ? `${cfg.authDir}/creds.json` : 'unknown',
          exists: false,
          mode: null,
          size: null,
          mtime: null,
          hash: null,
          identityHash: null,
        },
        treeHash: null,
        backup: {
          root: cfg.stateRoot ?? 'unknown',
          latest: null,
          latestAt: null,
          latestReason: null,
          latestTreeHash: null,
          lastCaptureAt: null,
          lastCaptureReason: null,
          lastCaptureError: null,
          lastCaptureDeferredAt: null,
          lastCaptureDeferredReason: null,
          lastCaptureDeferredAgeMs: null,
          lastRestoreAt: null,
          lastRestoreSource: null,
          lastRestoreError: null,
        },
      },
      latestBaileysVersion: null,
      connectStartedAt: null,
      lastOpenAt: null,
      lastCloseAt: null,
      lastQrAt: null,
      lastCredsUpdateAt: null,
      lastCredsUpdateFailedAt: null,
      lastAuthSnapshotAt: null,
      lastAuthSnapshotFailedAt: null,
      credsUpdateCount: 0,
      authSnapshotCaptureCount: 0,
      authSnapshotFailureCount: 0,
      lastDisconnectDiagnostic: null,
      recentEvents: [],
    },
  };
}

function formatAuthBond(connectionState: ConnectionStateSnapshot): Record<string, unknown> | null {
  const authBond = connectionState.authBond;
  if (!authBond) return null;
  return {
    status: authBond.status,
    issues: authBond.issues,
    auth_dir: {
      path: authBond.authDir.path,
      exists: authBond.authDir.exists,
      mode: authBond.authDir.mode,
      mtime: authBond.authDir.mtime,
    },
    creds: {
      path: authBond.creds.path,
      exists: authBond.creds.exists,
      mode: authBond.creds.mode,
      size: authBond.creds.size,
      mtime: authBond.creds.mtime,
      hash: authBond.creds.sha256?.slice(0, 20) ?? null,
      empty_hash: authBond.creds.sha256 === EMPTY_SHA256,
    },
    me_hash: authBond.meHash,
    tree_hash: authBond.treeHash?.slice(0, 20) ?? null,
    backup: {
      root: authBond.backup.root,
      latest: authBond.backup.latest,
      latest_at: authBond.backup.latestAt,
      latest_reason: authBond.backup.latestReason,
      latest_tree_hash: authBond.backup.latestTreeHash?.slice(0, 20) ?? null,
      last_capture_at: authBond.backup.lastCaptureAt,
      last_capture_reason: authBond.backup.lastCaptureReason,
      last_capture_error: authBond.backup.lastCaptureError,
      last_capture_deferred_at: authBond.backup.lastCaptureDeferredAt,
      last_capture_deferred_reason: authBond.backup.lastCaptureDeferredReason,
      last_capture_deferred_age_ms: authBond.backup.lastCaptureDeferredAgeMs,
      last_restore_at: authBond.backup.lastRestoreAt,
      last_restore_source: authBond.backup.lastRestoreSource,
      last_restore_error: authBond.backup.lastRestoreError,
    },
  };
}

function isFreshInvalidCredentialWriteInFlight(connectionState: ConnectionStateSnapshot): boolean {
  const authBond = connectionState.authBond;
  if (!authBond || !connectionState.connected) return false;
  if (authBond.status === 'present') return false;
  if (!authBond.creds.exists || !authBond.creds.mtime) return false;
  if (!authBond.issues.some(issue => issue === 'creds_json_empty' || issue === 'creds_json_invalid_json')) {
    return false;
  }
  const mtime = Date.parse(authBond.creds.mtime);
  if (!Number.isFinite(mtime)) return false;
  const ageMs = Date.now() - mtime;
  return ageMs >= 0 && ageMs < DEFAULT_FRESH_INVALID_GRACE_MS;
}

function classifyAuthFailure(connectionState: ConnectionStateSnapshot): AuthFailureClass {
  const reason = connectionState.lastDisconnectReason ?? '';
  if (
    !connectionState.connected
    && (
      connectionState.lastStatusCode === 401
      || reason === 'loggedOut'
      || reason.includes('device_removed')
    )
  ) {
    return 'serverside_logout_irreversible';
  }

  const lifecycle = connectionState.credentialLifecycle as Partial<ConnectionStateSnapshot['credentialLifecycle']> | undefined;
  const lastQrAt = lifecycle?.lastQrAt ? Date.parse(lifecycle.lastQrAt) : NaN;
  const lastOpenAt = lifecycle?.lastOpenAt ? Date.parse(lifecycle.lastOpenAt) : NaN;
  const qrRequiresPairing =
    !connectionState.connected
    && Number.isFinite(lastQrAt)
    && (!Number.isFinite(lastOpenAt) || lastQrAt >= lastOpenAt);
  if (qrRequiresPairing) {
    return 'pairing_required';
  }

  const authBond = connectionState.authBond;
  if (!authBond) return 'none';

  if (isFreshInvalidCredentialWriteInFlight(connectionState)) return 'none';

  const hasBackup = typeof authBond.backup.latest === 'string' && authBond.backup.latest.length > 0;
  if (authBond.status !== 'present') {
    return hasBackup ? 'local_corruption_restorable' : 'local_corruption_unrestorable';
  }

  if (
    authBond.issues.length > 0
    || authBond.backup.lastCaptureError !== null
    || authBond.backup.lastRestoreError !== null
  ) {
    return 'auth_bond_at_risk';
  }

  return 'none';
}

function classifyDisconnect(connectionState: ConnectionStateSnapshot): DisconnectClass {
  if (connectionState.connected && connectionState.state === 'connected') return 'none';
  const statusCode = connectionState.lastStatusCode ?? undefined;
  if (statusCode === undefined) return 'none';

  const action = decideDisconnectAction(statusCode);
  if (action.type === 'exit' && action.reason === 'logged-out') {
    return 'serverside_logout_irreversible';
  }
  if (action.type === 'reconnect') {
    if (action.reason === 'connection-replaced') return 'duplicate_session_replaced';
    if (action.reason === 'multidevice-mismatch') return 'multidevice_mismatch';
    if (action.reason === 'restart-required') return 'restart_required';
    if (action.reason === 'restart-required-flapping') return 'restart_required_flapping';
    if (action.reason === 'transient') return 'transient_reconnect';
  }
  return 'unknown_reconnect';
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
          // QR-086: the admin /send is an authenticated infra action — tag it as
          // a system caller ('health') so the outbound-identity guard's spec
          // §4.2-step-B exemption applies and a deliberate admin send to a cold
          // target is not floored under enforce mode.
          await sendTracked(deps.connectionManager, prepared.chatJid, prepared.text, deps.durability, { replayPolicy: 'unsafe', caller: 'health' });
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

    // ── POST /schedule — enqueue a text or media message for durable delivery ──
    // Reuses the scheduled_messages enqueue helper; the always-on MessageScheduler
    // delivers on its next tick (≤ ~60 s). Media is passed by FILE PATH (bounded to
    // deps.scheduleAllowedRoot), never inline bytes — a branded PDF exceeds the body cap.
    if (req.url === '/schedule' && req.method === 'POST') {
      if (!requireAuth(req, res)) return;

      const jsonHeaders = { 'Content-Type': 'application/json' };
      const MAX_BODY_BYTES = 64 * 1024; // 64 KB — JSON body references a file path, not bytes
      let body = '';
      let byteCount = 0;
      let destroyed = false;
      req.on('data', (chunk) => {
        if (destroyed) return;
        byteCount += Buffer.byteLength(chunk);
        if (byteCount > MAX_BODY_BYTES) {
          destroyed = true;
          res.writeHead(413, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'request body too large' }));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (destroyed) return;

        if (!deps.scheduleAllowedRoot) {
          res.writeHead(409, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'schedule route not configured' }));
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
          return;
        }
        if (!isRecord(parsed)) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'request body must be a JSON object' }));
          return;
        }

        const chatJid = parsed['chatJid'];
        if (typeof chatJid !== 'string' || chatJid.length === 0) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: 'chatJid is required' }));
          return;
        }

        const LEAD_SECONDS = 2;
        const now = Math.floor(Date.now() / 1000);
        const scheduledAtRaw = parsed['scheduledAt'];
        const scheduledAt = typeof scheduledAtRaw === 'number' ? scheduledAtRaw : now + LEAD_SECONDS;

        const str = (k: string): string | undefined => (typeof parsed[k] === 'string' ? (parsed[k] as string) : undefined);

        try {
          const result = enqueueScheduledMessage(
            deps.db,
            {
              chatJid,
              scheduled_at: scheduledAt,
              text: str('text'),
              filePath: str('filePath'),
              caption: str('caption'),
              filename: str('filename'),
              mediaType: str('mediaType') as EnqueueMessageParams['mediaType'],
              recurrence: str('recurrence'),
              timezone: str('timezone'),
              chatName: str('chatName'),
            },
            { allowedRoot: deps.scheduleAllowedRoot, now },
          );
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
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
        if (!isRecord(data)) {
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

        let data: unknown;
        try {
          data = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        if (!isRecord(data)) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'request body must be a JSON object' }));
          return;
        }

        if (!data['type']) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'missing type field' }));
          return;
        }
        if (typeof data['type'] !== 'string') {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'type must be a string' }));
          return;
        }

        const reportId = typeof data['reportId'] === 'string' ? data['reportId'] : randomUUID();
        const errorClass = normalizeErrorClass(
          data['type'],
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

        let data: unknown;
        try {
          data = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        if (!isRecord(data)) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'request body must be a JSON object' }));
          return;
        }

        const subjectType = data['subjectType'];
        const subjectId = data['subjectId'];
        const action = data['action'];

        if (
          typeof subjectType !== 'string' || !subjectType ||
          typeof subjectId !== 'string' || !subjectId ||
          typeof action !== 'string' || !action
        ) {
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

        let data: unknown;
        try {
          data = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        if (!isRecord(data)) {
          res.writeHead(400, jsonHeaders);
          res.end(JSON.stringify({ error: 'request body must be a JSON object' }));
          return;
        }

        const conversation_key = data['conversation_key'];
        if (typeof conversation_key !== 'string' || !conversation_key) {
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
      const authBond = formatAuthBond(connectionState);
      const authFailureClass = classifyAuthFailure(connectionState);
      const disconnectClass = classifyDisconnect(connectionState);

      const isConnected = connectionState.connected && connectionState.state === 'connected';
      const exposeDisconnectMetadata = !isConnected;
      const recentDisconnects = connectionState.recentDisconnects ?? emptyRecentDisconnects();
      const connectionChurnIsDegraded =
        isConnected && recentDisconnects.count >= RECENT_DISCONNECT_DEGRADED_THRESHOLD;
      const isRecoveringConnection =
        connectionState.state === 'connecting'
        || connectionState.state === 'reconnecting'
        || connectionState.state === 'cooldown';
      const enrichmentStaleness = enrichmentStats.lastRun
        ? Date.now() - new Date(enrichmentStats.lastRun).getTime()
        : null;
      const runtimeSnapshot = deps.runtime ? deps.runtime.getHealthSnapshot() : null;
      const agentRuntimeStatus = deps.instanceType === 'agent' ? runtimeSnapshot?.status ?? null : null;
      const turnCapability = deps.instanceType === 'agent'
        ? normalizeAgentTurnCapability(runtimeSnapshot?.details ?? null)
        : null;
      // `empty-output` is a known-transient/benign turn-error class and must not
      // pin or flap the health body (#1433). It degrades only as a CURRENT,
      // SUSTAINED stall; every other shape is benign:
      //   1. Boot/pre-first-turn (last_successful_turn_at === null): the boot
      //      sequence stamps empty-output ~1s after restart while the bot is idle
      //      and it never self-clears — always benign (no real turn has failed).
      //   2. Superseded by a success (last_successful_turn_at >= last_turn_error_at):
      //      the model already recovered — benign. This kills the active flap where
      //      empty/success turns alternate.
      //   3. Within the debounce window: a fresh trailing empty-output that has not
      //      yet persisted — benign, so a single empty turn followed by a success
      //      never trips.
      //   4. Older than the staleness bound with no recovery: a benign idle
      //      artifact (an idle bot has no turn to clear it) — self-clears.
      // Safety: a genuinely-broken model is still caught independently via
      // model_usable===false (the usability probe), and any non-empty-output error
      // class degrades immediately. Only a current, sustained, non-stale
      // empty-output stall (window [debounce, stale] after a proven turn) degrades.
      const emptyOutputError =
        turnCapability !== null && turnCapability.last_turn_error_class === 'empty-output';
      const postTurnEmptyOutputIsCurrent =
        emptyOutputError &&
        turnCapability.last_successful_turn_at !== null &&
        turnCapability.last_turn_error_at !== null &&
        turnCapability.last_turn_error_at > turnCapability.last_successful_turn_at;
      const postTurnEmptyOutputAgeMs =
        postTurnEmptyOutputIsCurrent && turnCapability.last_turn_error_at !== null
          ? Date.now() - turnCapability.last_turn_error_at
          : null;
      const emptyOutputIsDegrading =
        postTurnEmptyOutputAgeMs !== null &&
        postTurnEmptyOutputAgeMs >= EMPTY_OUTPUT_DEGRADE_DEBOUNCE_MS &&
        postTurnEmptyOutputAgeMs <= EMPTY_OUTPUT_STALE_MS;
      const turnCapabilityErrorIsDegraded =
        turnCapability !== null &&
        turnCapability.last_turn_error_class !== null &&
        (emptyOutputError ? emptyOutputIsDegrading : true);
      const turnCapabilityIsDegraded =
        turnCapability !== null &&
        (turnCapability.model_usable === false || turnCapabilityErrorIsDegraded);

      // Determine health status.
      // Enrichment staleness only matters if enrichment has actually run before
      // (instances without RAG/Pinecone never run enrichment — that's not degraded).
      const enrichmentIsStale = enrichmentStaleness !== null && enrichmentStaleness > ENRICHMENT_STALE_MS;
      const authFailureIsUnhealthy =
        authFailureClass === 'pairing_required'
        || authFailureClass === 'serverside_logout_irreversible'
        || authFailureClass === 'local_corruption_unrestorable';
      const authFailureIsDegraded = authFailureClass !== 'none';
      let status: 'healthy' | 'degraded' | 'unhealthy';
      if (authFailureIsUnhealthy) {
        status = 'unhealthy';
      } else if (!isConnected) {
        status = isRecoveringConnection ? 'degraded' : 'unhealthy';
      } else if (agentRuntimeStatus === 'unhealthy') {
        status = 'unhealthy';
      } else if (authFailureIsDegraded) {
        status = 'degraded';
      } else if (
        enrichmentIsStale ||
        enrichmentStats.runtimeDegraded ||
        connectionChurnIsDegraded ||
        agentRuntimeStatus === 'degraded' ||
        turnCapabilityIsDegraded
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

      const outboundSends = latestSuccessfulOutboundSend(deps);

      const schemaVersion = safeDbQuery(
        () => {
          const row = deps.db.raw.prepare('PRAGMA schema_version').get() as { schema_version: number } | undefined;
          return row?.schema_version ?? 0;
        },
        0,
        'failed to read sqlite schema_version',
      );

      const schemaMigrationLatest = safeDbQuery(
        () => {
          const row = deps.db.raw
            .prepare('SELECT COALESCE(MAX(version), 0) AS latest FROM schema_migrations')
            .get() as { latest: number } | undefined;
          return row?.latest ?? 0;
        },
        0,
        'failed to read sqlite schema migration version',
      );
      const schemaReady = schemaMigrationLatest >= CURRENT_SCHEMA_MIGRATION;

      let pendingPollsTotal = 0;
      let pendingPollsReadable = true;
      try {
        const row = deps.db.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get() as { cnt: number } | undefined;
        pendingPollsTotal = row?.cnt ?? 0;
      } catch (err) {
        pendingPollsReadable = false;
        log.error({ err }, 'failed to count pending polls');
      }

      if (status === 'healthy' && (!schemaReady || !pendingPollsReadable)) {
        status = 'degraded';
      }

      // Provider-fallback observability (agent runtimes only). Surfaced in the
      // instance block so operators can see when a bot is running on its
      // fallback provider and when that window expires.
      const fallbackState = deps.runtime?.getFallbackState?.() ?? null;

      // Mode-specific runtime block for control-plane
      let runtimeBlock: Record<string, unknown> = {};
      if (runtimeSnapshot) {
        const snap = runtimeSnapshot;
        if (snap.status === 'unhealthy') {
          status = 'unhealthy';
        } else if (snap.status === 'degraded' && status === 'healthy') {
          status = 'degraded';
        }
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
          runtimeBlock = { agent: agentRuntimeDetailsForHealth(snap.details, turnCapability) };
        }
      }

      const body = JSON.stringify({
        status,
        uptime_seconds: Math.floor((Date.now() - deps.startedAt) / 1000),
        arc: readArcBindingHealth(process.env.WHATSOUP_REPO_ROOT ?? process.cwd()),
        instance: {
          name: deps.instanceName,
          mode: deps.instanceType,
          accessMode: deps.accessMode,
          socketPath: deps.socketPath ?? null,
          provider: config.agentProvider,
          commit: readWhatsoupGitSha(),
          branch: readWhatsoupGitBranch(),
          pid: process.pid,
          ...(fallbackState
            ? {
                ...fallbackState,
                effectiveProvider: fallbackState.effectiveProvider,
                fallbackActiveUntil: fallbackState.fallbackActiveUntil,
                fallbackReason: fallbackState.fallbackReason ?? null,
                fallbackModel: fallbackState.fallbackModel ?? null,
                fallbackResetAt: fallbackState.fallbackResetAt ?? null,
                fallbackRecoveryProbeRequired: fallbackState.fallbackRecoveryProbeRequired ?? false,
              }
            : {}),
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
            last_disconnect_reason: exposeDisconnectMetadata ? connectionState.lastDisconnectReason ?? null : null,
            last_status_code: exposeDisconnectMetadata ? connectionState.lastStatusCode ?? null : null,
            recent_disconnects: {
              window_ms: recentDisconnects.windowMs,
              degraded_threshold: RECENT_DISCONNECT_DEGRADED_THRESHOLD,
              count: recentDisconnects.count,
              last_at: recentDisconnects.lastAt,
              last_reason: recentDisconnects.lastReason,
              last_status_code: recentDisconnects.lastStatusCode,
              by_reason: recentDisconnects.byReason,
            },
            disconnect_class: disconnectClass,
            auth_failure_class: authFailureClass,
          },
          auth_bond: authBond,
          credential_lifecycle: connectionState.credentialLifecycle ?? null,
        },
        sqlite: {
          schema_version: schemaVersion,
          schema_migration_latest: schemaMigrationLatest,
          schema_migration_required: CURRENT_SCHEMA_MIGRATION,
          schema_ready: schemaReady,
          messages_total: messagesTotal,
          unprocessed: enrichmentStats.unprocessed,
          pending_polls_total: pendingPollsTotal,
          pending_polls_readable: pendingPollsReadable,
        },
        access_control: {
          pending_count: pendingCount,
        },
        outbound_sends: outboundSends,
        enrichment: {
          last_run: enrichmentStats.lastRun,
        },
        models: {
          conversation: config.models.conversation,
          extraction: config.models.extraction,
          validation: config.models.validation,
          fallback: config.models.fallback,
        },
        model_advisories: getModelAdvisories(),
        durability: deps.durability?.getHealthStats() ?? null,
        turn_capability: turnCapability,
        // ALERT-07 (WS-ALERT): deterministic top-level provider-reauth signal.
        // A sibling of turn_capability (NOT a field inside it) so the many
        // `toEqual(turn_capability)` assertions stay exact-match. Consumers read
        // this instead of each re-deriving from the enums.
        reauth_required: turnCapabilityReauthRequired(turnCapability),
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
  // R7a: refuse a non-loopback bind without an explicit opt-in — the health server
  // exposes GET /health metadata and the token-gated POST /access endpoint, and a
  // remote plain-HTTP bind sends the health token over the wire. Mirrors the fleet guard.
  assertSafeHealthBind(healthHost);
  server.listen(config.healthPort, healthHost, () => {
    log.info({ port: config.healthPort, host: healthHost }, 'health server listening');
  });

  return server;
}
