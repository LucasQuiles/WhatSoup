import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { jsonResponse, requireInstance } from '../../lib/http.ts';
import { asRecord } from '../../lib/type-guards.ts';
import { lookupCredential, resolveProviderKeyService } from '../../lib/keyring.ts';
import { normalizeFallbackEntriesFromInstanceConfig } from '../../core/fallback-chain.ts';
import { extractLocal } from '../../core/access-list.ts';
import { bareNumber } from '../../core/jid-constants.ts';
import { resolveAgentModel } from '../../instance-loader.ts';
import type { FleetDiscovery, DiscoveredInstance } from '../discovery.ts';
import type { HealthPoller, InstanceStatus } from '../health-poller.ts';
import type { FleetDbReader } from '../db-reader.ts';
import { normalizeTimestamp, toIsoFromUnix } from '../time-utils.ts';
import { hasExplicitAuthLossSignal } from '../auth-loss-signals.ts';

export interface LinesDeps {
  discovery: FleetDiscovery;
  healthPoller: HealthPoller;
  dbReader: FleetDbReader;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format seconds into "Xd Xh" human-readable string. */
function formatUptime(seconds: number | undefined | null): string | null {
  if (seconds == null || seconds < 0) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/** Extract phone number from a WhatsApp JID. Null-safe wrapper around extractLocal. */
function phoneFromJid(jid: string | undefined | null): string {
  if (!jid) return 'unknown';
  return extractLocal(jid);
}


/** Safely traverse nested health snapshot using dot-separated keys. */
function dig(obj: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Generate a heartbeat array of 20 entries based on consecutive failure count. */
function buildHeartbeat(poll: InstanceStatus | undefined): ('up' | 'down')[] {
  const size = 20;
  if (!poll) return Array(size).fill('down') as ('up' | 'down')[];
  const failures = Math.min(poll.consecutiveFailures, size);
  // Most recent entries are at the end of the array.
  // Older entries are 'up', recent failures are 'down'.
  const ups = size - failures;
  return [
    ...Array(ups).fill('up'),
    ...Array(failures).fill('down'),
  ] as ('up' | 'down')[];
}

/** Detailed message stats by direction and content type — 60s cache. */
interface MessageStats {
  sent: number;
  received: number;
  images: number;
  audio: number;
  documents: number;
}

const DAILY_CACHE_TTL = 60_000; // 60 seconds

/**
 * Generic cache-with-TTL helper. Returns the cached value if fresh, otherwise
 * calls queryFn, stores the result, and returns it.
 */
function cachedQuery<T>(
  cache: Map<string, { data: T; cachedAt: number }>,
  key: string,
  ttl: number,
  queryFn: () => T,
): T {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.cachedAt < ttl) return cached.data;
  const data = queryFn();
  cache.set(key, { data, cachedAt: now });
  return data;
}

function pruneStaleCache<T>(
  cache: Map<string, { data: T; cachedAt: number }>,
  validNames: Set<string>,
): void {
  for (const key of cache.keys()) {
    if (!validNames.has(key)) {
      cache.delete(key);
    }
  }
}

const messageStatsCache = new Map<string, { data: MessageStats; cachedAt: number }>();
const sessionCountCache = new Map<string, { data: number; cachedAt: number }>();

/** Total lifetime agent sessions — 60s cache. */
function getTotalSessions(dbReader: FleetDbReader, inst: DiscoveredInstance): number {
  if (inst.type !== 'agent') return 0;
  return cachedQuery(sessionCountCache, inst.name, DAILY_CACHE_TTL, () => {
    const result = dbReader.query(inst.name, inst.dbPath, (db) => {
      try {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM agent_sessions').get() as { cnt: number } | undefined;
        return row?.cnt ?? 0;
      } catch {
        return 0; // table may not exist for non-agent instances
      }
    });
    return result.ok ? result.data : 0;
  });
}

function getMessageStats(dbReader: FleetDbReader, inst: DiscoveredInstance): MessageStats {
  return cachedQuery(messageStatsCache, inst.name, DAILY_CACHE_TTL, () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startSec = Math.floor(startOfDay.getTime() / 1000);

    const result = dbReader.query(inst.name, inst.dbPath, (db) => {
      const rows = db.prepare(
        'SELECT content_type, is_from_me, COUNT(*) as cnt FROM messages WHERE timestamp >= ? GROUP BY content_type, is_from_me',
      ).all(startSec) as { content_type: string; is_from_me: number; cnt: number }[];
      return rows;
    });

    const stats: MessageStats = { sent: 0, received: 0, images: 0, audio: 0, documents: 0 };
    if (result.ok) {
      for (const row of result.data) {
        if (row.is_from_me === 1) stats.sent += row.cnt;
        else stats.received += row.cnt;
        if (row.content_type === 'image') stats.images += row.cnt;
        else if (row.content_type === 'audio') stats.audio += row.cnt;
        else if (row.content_type === 'document') stats.documents += row.cnt;
      }
    }
    return stats;
  });
}

type LinkedStatus = 'linked' | 'unlinked' | 'unknown';

interface LinkedStatusDetails {
  status: LinkedStatus;
  confidence: InstanceStatus['statusConfidence'];
  reason: string;
  evidence: string[];
}

function linkedEvidenceField(name: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return `${name}=unknown`;
  return `${name}=${String(value)}`;
}

function linkedStatusFromHealth(health: Record<string, unknown> | null): LinkedStatusDetails | null {
  if (!health) return null;

  const connected = dig(health, 'whatsapp', 'connected');
  const accountJid = dig(health, 'whatsapp', 'account_jid');
  const connectionState =
    dig(health, 'whatsapp', 'connection', 'state') ??
    dig(health, 'connection', 'state');
  const lastDisconnectReason =
    dig(health, 'whatsapp', 'connection', 'last_disconnect_reason') ??
    dig(health, 'connection', 'last_disconnect_reason');
  const lastStatusCode =
    dig(health, 'whatsapp', 'connection', 'last_status_code') ??
    dig(health, 'connection', 'last_status_code');
  const authFailureClass =
    dig(health, 'whatsapp', 'connection', 'auth_failure_class') ??
    dig(health, 'connection', 'auth_failure_class');
  const healthStatus = dig(health, 'status');
  const accountJidStatus = accountJid === 'not connected'
    ? 'not_connected'
    : typeof accountJid === 'string' && accountJid.trim() !== ''
      ? 'present'
      : 'unknown';
  const explicitAuthLossSignal =
    hasExplicitAuthLossSignal({ lastStatusCode, lastDisconnectReason, authFailureClass });
  const evidence = [
    linkedEvidenceField('link_source', 'health'),
    linkedEvidenceField('health_status', healthStatus),
    linkedEvidenceField('whatsapp_connected', connected),
    linkedEvidenceField('account_jid_status', accountJidStatus),
    linkedEvidenceField('connection_state', connectionState),
    linkedEvidenceField('last_disconnect_reason', lastDisconnectReason),
    linkedEvidenceField('last_status_code', lastStatusCode),
    linkedEvidenceField('auth_failure_class', authFailureClass),
  ];

  if (connected === true && accountJidStatus === 'present') {
    return {
      status: 'linked',
      confidence: 'confirmed',
      reason: 'whatsapp_health_connected',
      evidence,
    };
  }

  if (
    connected === false &&
    accountJidStatus === 'not_connected' &&
    (connectionState === 'disconnected' || healthStatus === 'unhealthy')
  ) {
    if (!explicitAuthLossSignal) {
      return {
        status: 'unknown',
        confidence: 'ambiguous',
        reason: 'whatsapp_health_disconnected_without_auth_loss_signal',
        evidence,
      };
    }

    return {
      status: 'unlinked',
      confidence: 'confirmed',
      reason: 'whatsapp_health_disconnected',
      evidence,
    };
  }

  if (accountJidStatus === 'present') {
    return {
      status: 'linked',
      confidence: 'inferred',
      reason: 'whatsapp_account_present',
      evidence,
    };
  }

  return null;
}

function getLinkedStatus(configPath: string, health: Record<string, unknown> | null): LinkedStatusDetails {
  const healthStatus = linkedStatusFromHealth(health);
  if (healthStatus) return healthStatus;

  try {
    const authDir = path.join(path.dirname(configPath), 'auth');
    const entries = fs.readdirSync(authDir);
    const hasAuthArtifacts = entries.some(f => f.startsWith('creds') || f.startsWith('app-state-sync'));
    return {
      status: hasAuthArtifacts ? 'linked' : 'unlinked',
      confidence: 'inferred',
      reason: hasAuthArtifacts ? 'auth_artifacts_present' : 'auth_artifacts_absent',
      evidence: [
        linkedEvidenceField('link_source', 'auth_artifacts'),
        linkedEvidenceField('auth_artifacts_present', hasAuthArtifacts),
        linkedEvidenceField('auth_entry_count', entries.length),
      ],
    };
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : 'UNKNOWN';
    if (code === 'ENOENT') {
      return {
        status: 'unlinked',
        confidence: 'inferred',
        reason: 'auth_artifacts_absent',
        evidence: [
          linkedEvidenceField('link_source', 'auth_artifacts'),
          linkedEvidenceField('auth_artifacts_present', false),
          linkedEvidenceField('auth_read_error_code', code),
        ],
      };
    }
    return {
      status: 'unknown',
      confidence: 'ambiguous',
      reason: 'auth_artifacts_unreadable',
      evidence: [
        linkedEvidenceField('link_source', 'auth_artifacts'),
        linkedEvidenceField('auth_read_error_code', code),
      ],
    };
  }
}

interface ChatCounts {
  chats: number;
  groups: number;
}

const chatCountsCache = new Map<string, { data: ChatCounts; cachedAt: number }>();

function getChatCounts(dbReader: FleetDbReader, inst: DiscoveredInstance): ChatCounts {
  return cachedQuery(chatCountsCache, inst.name, DAILY_CACHE_TTL, () => {
    const result = dbReader.query(inst.name, inst.dbPath, (db) => {
      const row = db.prepare(`
        SELECT
          COUNT(DISTINCT conversation_key) as total,
          COUNT(DISTINCT CASE WHEN conversation_key LIKE '%@g.us' OR conversation_key LIKE '%_at_g.us' THEN conversation_key END) as groups
        FROM messages WHERE deleted_at IS NULL
      `).get() as { total: number; groups: number } | undefined;
      return { chats: (row?.total ?? 0) - (row?.groups ?? 0), groups: row?.groups ?? 0 };
    });
    return result.ok ? result.data : { chats: 0, groups: 0 };
  });
}

interface TokenStats {
  input: number;
  output: number;
}

const tokenStatsCache = new Map<string, { data: TokenStats; cachedAt: number }>();

function getTokenStats(dbReader: FleetDbReader, inst: DiscoveredInstance): TokenStats {
  return cachedQuery(tokenStatsCache, inst.name, DAILY_CACHE_TTL, () => {
    const result = dbReader.query(inst.name, inst.dbPath, (db) => {
      // Sum tokens from messages (chat runtime)
      let msgInput = 0, msgOutput = 0;
      try {
        const row = db.prepare(
          'SELECT COALESCE(SUM(input_tokens), 0) as i, COALESCE(SUM(output_tokens), 0) as o FROM messages'
        ).get() as { i: number; o: number } | undefined;
        msgInput = row?.i ?? 0;
        msgOutput = row?.o ?? 0;
      } catch { /* column may not exist yet */ }

      // Sum tokens from agent_sessions (agent runtime)
      let sesInput = 0, sesOutput = 0;
      try {
        const row = db.prepare(
          'SELECT COALESCE(SUM(total_input_tokens), 0) as i, COALESCE(SUM(total_output_tokens), 0) as o FROM agent_sessions'
        ).get() as { i: number; o: number } | undefined;
        sesInput = row?.i ?? 0;
        sesOutput = row?.o ?? 0;
      } catch { /* column may not exist yet */ }

      return { input: msgInput + sesInput, output: msgOutput + sesOutput };
    });
    return result.ok ? result.data : { input: 0, output: 0 };
  });
}

const lastActiveCache = new Map<string, { data: string | null; cachedAt: number }>();

function pruneLineCaches(validNames: Set<string>): void {
  pruneStaleCache(messageStatsCache, validNames);
  pruneStaleCache(sessionCountCache, validNames);
  pruneStaleCache(chatCountsCache, validNames);
  pruneStaleCache(tokenStatsCache, validNames);
  pruneStaleCache(lastActiveCache, validNames);
}

export function _getLineCachesForTests(): {
  messageStatsCache: typeof messageStatsCache;
  sessionCountCache: typeof sessionCountCache;
  chatCountsCache: typeof chatCountsCache;
  tokenStatsCache: typeof tokenStatsCache;
  lastActiveCache: typeof lastActiveCache;
} {
  return {
    messageStatsCache,
    sessionCountCache,
    chatCountsCache,
    tokenStatsCache,
    lastActiveCache,
  };
}

export function _resetLineCaches(): void {
  messageStatsCache.clear();
  sessionCountCache.clear();
  chatCountsCache.clear();
  tokenStatsCache.clear();
  lastActiveCache.clear();
}

/** Most recent message timestamp for an instance — 60s cache. */
function getLastMessageTime(dbReader: FleetDbReader, inst: DiscoveredInstance): string | null {
  return cachedQuery(lastActiveCache, inst.name, DAILY_CACHE_TTL, () => {
    const result = dbReader.query(inst.name, inst.dbPath, (db) => {
      const row = db.prepare(
        'SELECT MAX(timestamp) as ts FROM messages WHERE deleted_at IS NULL'
      ).get() as { ts: number | null } | undefined;
      if (!row?.ts) return null;
      return toIsoFromUnix(row.ts);
    });
    return result.ok ? result.data : null;
  });
}

interface EnrichOpts {
  messagesToday?: number;
  messageStats?: MessageStats;
  totalSessions?: number;
  chatCounts?: ChatCounts;
  tokenStats?: TokenStats;
  lastMessageTime?: string | null;
}

/** Build the enriched LineInstance object the console expects. */
function enrichInstance(inst: DiscoveredInstance, poll: InstanceStatus | undefined, opts: EnrichOpts = {}): Record<string, unknown> {
  const h = poll?.health ?? null;
  const isConfigError = inst.configError != null;
  const linkedStatus = getLinkedStatus(inst.configPath, h);

  const uptimeSec = dig(h, 'uptime_seconds') as number | undefined;
  const accountJid = dig(h, 'whatsapp', 'account_jid') as string | undefined;
  const messagesTotal = dig(h, 'sqlite', 'messages_total') as number | undefined;
  const unread = dig(h, 'runtime', 'passive', 'unreadCount') as number | undefined;
  const queueDepth = dig(h, 'runtime', 'chat', 'queueDepth') as number | undefined;
  const enrichmentUnprocessed = dig(h, 'runtime', 'chat', 'enrichmentUnprocessed') as number | undefined;
  const activeSessions = dig(h, 'runtime', 'agent', 'activeSessions') as number | undefined;
  const lastSessionStatus = (dig(h, 'runtime', 'agent', 'lastSessionStatus') as string | undefined)
    ?? (poll?.status === 'online' ? 'idle' : poll?.status === 'unreachable' ? 'error' : undefined)
    ?? null;

  return {
    // Discovery fields
    name: inst.name,
    mode: inst.type,
    accessMode: inst.accessMode,
    healthPort: inst.healthPort,
    socketPath: inst.socketPath,

    // Poller status
    status: isConfigError ? 'config_error' : (poll?.status ?? 'unknown'),
    statusConfidence: isConfigError ? 'confirmed' : (poll?.statusConfidence ?? null),
    statusReason: isConfigError ? 'config_error' : (poll?.statusReason ?? 'not_polled'),
    statusEvidence: isConfigError
      ? [inst.configError ?? 'config_error']
      : (poll?.statusEvidence ?? []),
    error: inst.configError ?? poll?.error ?? null,
    configError: inst.configError ?? null,
    sharedCwdWith: inst.sharedCwdWith ?? null,

    // Derived from health snapshot
    phone: phoneFromJid(accountJid),
    uptime: formatUptime(uptimeSec),
    messagesTotal: messagesTotal ?? 0,
    messagesToday: opts.messagesToday ?? messagesTotal ?? 0,
    health: h,
    heartbeat: buildHeartbeat(poll),
    lastActive: normalizeTimestamp(
      (dig(h, 'runtime', 'passive', 'lastActivityAt') as string | undefined)
      ?? (dig(h, 'runtime', 'agent', 'lastSessionStartedAt') as string | undefined)
      ?? opts.lastMessageTime
      ?? null
    ),
    unread: unread ?? 0,
    queueDepth: queueDepth ?? 0,
    enrichmentUnprocessed: enrichmentUnprocessed ?? 0,
    activeSessions: activeSessions ?? 0,
    lastSessionStatus,
    messageStats: opts.messageStats ?? null,
    linkedStatus: linkedStatus.status,
    linkedStatusConfidence: linkedStatus.confidence,
    linkedStatusReason: linkedStatus.reason,
    linkedStatusEvidence: linkedStatus.evidence,
    totalSessions: opts.totalSessions ?? 0,
    models: inst.models ?? null,
    sandboxPerChat: inst.sandboxPerChat ?? false,
    chatCounts: opts.chatCounts ?? { chats: 0, groups: 0 },
    tokenUsage: opts.tokenStats ?? { input: 0, output: 0 },
    provider: inst.provider ?? 'claude-cli',
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /api/lines — list all instances with their poller status. */
export function handleGetLines(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LinesDeps,
): void {
  const instances = deps.discovery.getInstances() ?? new Map<string, DiscoveredInstance>();
  pruneLineCaches(new Set(instances.keys()));
  const statuses = deps.healthPoller.getStatuses();

  const lines = Array.from(instances.values()).map((inst) => {
    const poll = statuses.get(inst.name);
    const stats = getMessageStats(deps.dbReader, inst);
    const todayCount = stats.sent + stats.received;
    const totalSessions = getTotalSessions(deps.dbReader, inst);
    const chatCounts = getChatCounts(deps.dbReader, inst);
    const tokenStats = getTokenStats(deps.dbReader, inst);
    const lastMessageTime = getLastMessageTime(deps.dbReader, inst);
    return enrichInstance(inst, poll, { messagesToday: todayCount, messageStats: stats, totalSessions, chatCounts, tokenStats, lastMessageTime });
  });

  jsonResponse(res, 200, lines);
}

/** GET /api/lines/:name — detailed view of a single instance. */
export async function handleGetLine(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LinesDeps,
  params: { name: string },
): Promise<void> {
  const instances = deps.discovery.getInstances() ?? new Map<string, DiscoveredInstance>();
  pruneLineCaches(new Set(instances.keys()));
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const poll = deps.healthPoller.getStatus(params.name);
  const dbStats = deps.dbReader.getSummaryStats(instance.name, instance.dbPath);

  // Start with the enriched shape the console expects, then add detail fields
  const stats = getMessageStats(deps.dbReader, instance);
  const totalSessions = getTotalSessions(deps.dbReader, instance);
  const enriched = enrichInstance(instance, poll, { messageStats: stats, totalSessions });

  let instanceConfig: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(instance.configPath, 'utf-8');
    instanceConfig = JSON.parse(raw);
  } catch { /* config unreadable */ }

  // Compute real messagesToday for detail view (derived from stats)
  const todayCount = stats.sent + stats.received;

  // Resolve LID admin phones to display-friendly phone numbers via lid_mappings DB.
  const adminPhones = instanceConfig.adminPhones as string[] | undefined;
  let adminPhonesDisplay: Record<string, string> | undefined;
  if (adminPhones && adminPhones.some(p => String(p).length > 11)) {
    const lidResult = deps.dbReader.query(instance.name, instance.dbPath, (db) => {
      const rows = db.prepare('SELECT lid, phone_jid FROM lid_mappings').all() as { lid: string; phone_jid: string }[];
      const map: Record<string, string> = {};
      for (const row of rows) {
        map[row.lid] = bareNumber(row.phone_jid);
      }
      return map;
    });
    if (lidResult.ok) {
      adminPhonesDisplay = {};
      for (const phone of adminPhones) {
        adminPhonesDisplay[phone] = lidResult.data[phone] ?? phone;
      }
    }
  }

  jsonResponse(res, 200, {
    ...enriched,
    messagesToday: todayCount,
    // Additional detail-only fields (no filesystem paths — those are server internals)
    type: instance.type,
    gui: instance.gui,
    guiPort: instance.guiPort,
    dbStats: dbStats.ok ? dbStats.data : null,
    config: instanceConfig,
    ...(adminPhonesDisplay ? { adminPhonesDisplay } : {}),
  });
}

// ---------------------------------------------------------------------------
// Provider status
// ---------------------------------------------------------------------------

/**
 * Boolean presence of the API key for a provider/model, or `null` when no key
 * is required (native-auth providers). Never returns or logs the key value —
 * only whether one is resolvable via env or keyring.
 */
function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function keyPresentFor(
  provider: string | null | undefined,
  model: string | null | undefined,
  providerConfig?: Record<string, unknown>,
): boolean | null {
  const service = resolveProviderKeyService(provider, model, providerConfig);
  if (service === null) return null;
  return lookupCredential(service) !== null;
}

function apiProviderConfigModel(
  provider: string | null | undefined,
  providerConfig: Record<string, unknown> | undefined,
): string | undefined {
  if (provider !== 'openai-api' && provider !== 'anthropic-api') return undefined;
  const model = providerConfig?.['model'];
  return typeof model === 'string' && model.trim() !== '' ? model : undefined;
}

function lineReachableFromPoll(poll: InstanceStatus | undefined): boolean {
  if (!poll) return false;
  if (poll.status === 'online' || poll.status === 'logged_out') return poll.health !== null;
  if (poll.status === 'degraded') return poll.error === null && poll.health !== null;
  return false;
}

function healthSignalFromPoll(poll: InstanceStatus | undefined): {
  status: InstanceStatus['status'] | null;
  confidence: InstanceStatus['statusConfidence'] | null;
  reason: string | null;
  evidence: string[];
} {
  if (!poll) {
    return {
      status: null,
      confidence: null,
      reason: 'not_polled',
      evidence: [],
    };
  }
  return {
    status: poll.status,
    confidence: poll.statusConfidence,
    reason: poll.statusReason,
    evidence: poll.statusEvidence,
  };
}

function fallbackEntryFromHealth(value: unknown): { provider: string; model: string | null } | null {
  const entry = asRecord(value);
  if (!entry) return null;
  const provider = stringValue(entry.provider);
  if (!provider) return null;
  return { provider, model: stringValue(entry.model) };
}

function fallbackChainFromHealth(
  value: unknown,
): Array<{ provider: string; model: string | null; eligible: boolean | null }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ provider: string; model: string | null; eligible: boolean | null }> = [];
  for (const raw of value) {
    const entry = asRecord(raw);
    const provider = stringValue(entry?.provider);
    if (!provider) continue;
    out.push({
      provider,
      model: stringValue(entry?.model),
      eligible: typeof entry?.eligible === 'boolean' ? entry.eligible : null,
    });
  }
  return out;
}

/**
 * GET /api/lines/:name/provider-status — per-instance provider / key / fallback
 * status. Read-only: surfaces the configured primary + fallback providers, the
 * presence (never the value) of any required API key, and whether the runtime
 * is currently serving on its fallback provider.
 */
export async function handleGetLineProviderStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LinesDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  let parsedConfig: Record<string, unknown> = {};
  let agentOptions: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(instance.configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsedConfig = parsed as Record<string, unknown>;
      agentOptions = asRecord(parsedConfig.agentOptions) ?? {};
    }
  } catch { /* config unreadable — treat as empty (provider defaults to runtime default) */ }

  const primaryProvider =
    stringValue(agentOptions.provider) ?? (instance.type === 'agent' ? 'claude-cli' : null);
  const providerConfig = asRecord(agentOptions.providerConfig);
  const primaryModel =
    resolveAgentModel(parsedConfig) ??
    apiProviderConfigModel(primaryProvider, providerConfig) ??
    stringValue(agentOptions.model);
  const fallbackEntries = normalizeFallbackEntriesFromInstanceConfig(parsedConfig);
  const configuredFallback = fallbackEntries[0] ?? null;
  const fallbackProvider = configuredFallback?.provider ?? null;
  const fallbackModel = configuredFallback?.model ?? null;
  // Mirror the runtime inheritance rule (fallbackProviderConfigFor,
  // src/runtimes/agent/fallback-config.ts): a fallback entry shares the
  // instance providerConfig when it is the SAME provider OR a managed-API
  // sibling (openai-api / anthropic-api) — not only the same-provider case.
  const fallbackInherits =
    fallbackProvider !== null &&
    (fallbackProvider === primaryProvider ||
      fallbackProvider === 'openai-api' ||
      fallbackProvider === 'anthropic-api');
  const fallbackProviderConfig = fallbackInherits ? providerConfig : undefined;

  // Fallback window state from the instance health snapshot (surface C emits
  // instance.fallbackActiveUntil as epoch ms or null).
  const poll = deps.healthPoller.getStatus(params.name);
  const health = poll?.health as Record<string, unknown> | null | undefined;
  const fallbackActiveUntilRaw = dig(health, 'instance', 'fallbackActiveUntil');
  const activeUntil = typeof fallbackActiveUntilRaw === 'number' ? fallbackActiveUntilRaw : null;
  const active = activeUntil !== null && Date.now() < activeUntil;
  const effectiveProviderRaw = dig(health, 'instance', 'effectiveProvider');
  const fallbackReasonRaw = dig(health, 'instance', 'fallbackReason');
  const fallbackResetAtRaw = dig(health, 'instance', 'fallbackResetAt');
  const fallbackRecoveryProbeRequiredRaw = dig(health, 'instance', 'fallbackRecoveryProbeRequired');
  const turnsServedRaw = dig(health, 'instance', 'fallbackTurnsServed');
  const turnsEmptyRaw = dig(health, 'instance', 'fallbackTurnsEmpty');
  const lastFallbackTurnAtRaw = dig(health, 'instance', 'lastFallbackTurnAt');
  const probeAttemptsRaw = dig(health, 'instance', 'probeAttempts');
  const lastProbeAtRaw = dig(health, 'instance', 'lastProbeAt');
  const windowCostUsdRaw = dig(health, 'instance', 'fallbackWindowCostUsd');
  const activationsRaw = dig(health, 'instance', 'fallbackActivations');
  const revertsRaw = dig(health, 'instance', 'fallbackReverts');
  const replaysRaw = dig(health, 'instance', 'fallbackReplays');
  const fallbackResetAt = typeof fallbackResetAtRaw === 'number' ? fallbackResetAtRaw : null;
  const activeEntry = fallbackEntryFromHealth(dig(health, 'instance', 'activeFallbackEntry'));
  const chainFromHealth = fallbackChainFromHealth(dig(health, 'instance', 'fallbackChain'));
  const fallbackChain = chainFromHealth ?? fallbackEntries.map((entry) => ({
    provider: entry.provider,
    model: entry.model ?? null,
    eligible: null,
  }));

  // QR-104-class observability: expose WHICH endpoint/key service the config
  // points at, so an operator can confirm a custom-endpoint (BYOK) instance
  // without reading config.json over SSH. Host only — never the full URL
  // (path/query could carry tenant identifiers), never key material.
  // Attribution follows CONSUMPTION, not mere presence: the fields appear
  // under a role only when that role's provider actually uses providerConfig
  // (openai-api/anthropic-api read baseUrl+apiKeyService directly;
  // opencode-cli consumes them as PRIMARY via the generated opencode.json but
  // has them STRIPPED as a fallback — runtime.ts sessionProviderConfig()).
  // A CLI primary with an orphaned providerConfig therefore reports null here
  // even though the raw config carries values.
  // This route reads raw disk JSON with no validator pass (hand-edited,
  // pre-validator, or authOnly-bootstrapped configs reach here), so a
  // malformed baseUrl is possible: URL parse failure and no-authority schemes
  // both normalize to null rather than throwing or emitting ''.
  const endpointFieldsFor = (
    provider: string | null,
    model: string | null,
    config: Record<string, unknown> | undefined,
    consumers: readonly string[],
  ): { endpointHost: string | null; apiKeyService: string | null } => {
    if (!provider || !consumers.includes(provider)) {
      return { endpointHost: null, apiKeyService: null };
    }
    let host: string | null = null;
    const baseUrlRaw = config ? stringValue(config.baseUrl) : undefined;
    if (baseUrlRaw) {
      try {
        host = new URL(baseUrlRaw).host || null;
      } catch { /* unparseable on-disk baseUrl — report null */ }
    }
    // opencode-cli's effective keyring service is derived from the model
    // prefix (resolveProviderKeyService ignores providerConfig.apiKeyService
    // for it), so report the SAME service keyPresent checks — the raw config
    // field is null in the common no-override case. For the API providers the
    // raw override read is kept deliberately: null preserves the "no override
    // configured" tri-state that flags BYOK at a glance. (QR-232 corner: with
    // an explicit override set on an opencode instance, the generated
    // opencode.json honors the override while the resolver — and therefore
    // keyPresent and this field — reports the derived service.)
    const apiKeyService = provider === 'opencode-cli'
      ? resolveProviderKeyService(provider, model, config)
      : config ? stringValue(config.apiKeyService) ?? null : null;
    return { endpointHost: host, apiKeyService };
  };
  const primaryEndpoint = endpointFieldsFor(
    primaryProvider, primaryModel, providerConfig, ['openai-api', 'anthropic-api', 'opencode-cli'],
  );
  const fallbackEndpoint = endpointFieldsFor(
    fallbackProvider, fallbackModel, fallbackProviderConfig, ['openai-api', 'anthropic-api'],
  );

  jsonResponse(res, 200, {
    primary: {
      provider: primaryProvider,
      model: primaryModel,
      keyPresent: keyPresentFor(primaryProvider, primaryModel, providerConfig),
      endpointHost: primaryEndpoint.endpointHost,
      apiKeyService: primaryEndpoint.apiKeyService,
    },
    fallback: {
      provider: fallbackProvider,
      model: fallbackModel,
      keyPresent: fallbackProvider ? keyPresentFor(fallbackProvider, fallbackModel, fallbackProviderConfig) : null,
      endpointHost: fallbackEndpoint.endpointHost,
      apiKeyService: fallbackEndpoint.apiKeyService,
      active,
      activeUntil,
      effectiveProvider: typeof effectiveProviderRaw === 'string' ? effectiveProviderRaw : null,
      reason: typeof fallbackReasonRaw === 'string' ? fallbackReasonRaw : null,
      resetAt: fallbackResetAt,
      recoveryProbeRequired: fallbackRecoveryProbeRequiredRaw === true,
      turnsServed: typeof turnsServedRaw === 'number' ? turnsServedRaw : null,
      turnsEmpty: typeof turnsEmptyRaw === 'number' ? turnsEmptyRaw : null,
      lastFallbackTurnAt: typeof lastFallbackTurnAtRaw === 'number' ? lastFallbackTurnAtRaw : null,
      probeAttempts: typeof probeAttemptsRaw === 'number' ? probeAttemptsRaw : null,
      lastProbeAt: typeof lastProbeAtRaw === 'number' ? lastProbeAtRaw : null,
      windowCostUsd: typeof windowCostUsdRaw === 'number' ? windowCostUsdRaw : null,
      activations: typeof activationsRaw === 'number' ? activationsRaw : null,
      reverts: typeof revertsRaw === 'number' ? revertsRaw : null,
      replays: typeof replaysRaw === 'number' ? replaysRaw : null,
      activeEntry,
      chain: fallbackChain,
    },
    signal: healthSignalFromPoll(poll),
    lineReachable: lineReachableFromPoll(poll),
  });
}
