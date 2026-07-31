/// <reference types="vite/client" />

/**
 * Fleet API client with mock data fallback.
 *
 * - In production: fleet server serves both the SPA and /api/* routes.
 *   Mock fallback is DISABLED by default so real API/auth failures surface
 *   as errors instead of silently masquerading as healthy mock data
 *   (closes #420). Set `VITE_MOCK_MODE=1` at build time to opt back in
 *   for demos / design environments.
 * - In dev mode: Vite proxies /api/* to the fleet server and mock
 *   fallback auto-activates when the fleet is unreachable, so UI work
 *   doesn't require a running fleet.
 */

/**
 * True when mock-data fallback should auto-activate on fleet probe
 * failure or thrown API errors.
 *
 * Dev builds keep the legacy auto-activate behavior for convenience.
 * Production builds require explicit opt-in via `VITE_MOCK_MODE=1` so
 * a misbehaving fleet (or a stale auth ticket) cannot silently degrade
 * the console to mock data.
 */
function mockFallbackEnabled(): boolean {
  const env = import.meta.env;
  if (!env?.PROD) return true;
  return env.VITE_MOCK_MODE === '1';
}

import type {
  AccessEntry,
  ChatItem,
  CheckpointsPayload,
  LiveSessionsPayload,
  ContactResult,
  FeedEvent,
  FleetMetrics,
  GroupDetail,
  GroupInfo,
  LineInstance,
  LineMetrics,
  MarkConversationReadResult,
  RateLimitsPayload,
  ApprovalsPayload,
  LogEntry,
  Message,
  MetricsRange,
  ProviderCatalogEntry,
  ProviderStatus,
  ScheduledMessage,
} from '../types.js';
import { asRecordOrEmpty } from './type-guards.js';

const API_BASE = '';

/**
 * FleetApiError — renders only safe projection fields (#2517 requirement 7).
 * The message contains the bounded code, registered safe message, and
 * correlation ID — never raw response body bytes.
 */
export class FleetApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlation: string;
  constructor(status: number, code: string, message: string, correlation: string) {
    super(`${message} (${code})${correlation}`);
    this.name = 'FleetApiError';
    this.status = status;
    this.code = code;
    this.correlation = correlation;
  }
}

/**
 * B1 closure: the served HTML carries NO credentials. The production server
 * advertises its auth mode via a meta tag; the browser authenticates ticket
 * minting with an HttpOnly session cookie set by POST /api/console-session
 * after the operator unlocks the console with the root token.
 */
function getConsoleAuthMode(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="fleet-auth-mode"]');
  return meta?.content || null;
}

/** True when served by the production fleet server (session-auth mode). */
export function isProductionConsole(): boolean {
  return getConsoleAuthMode() === 'session';
}

/** Thrown when the console session is missing/expired — UI should show the unlock screen. */
export class ConsoleLockedError extends Error {
  constructor() { super('console locked: no valid session'); this.name = 'ConsoleLockedError'; }
}

/** Unlock the console: exchange the operator-entered root token for an HttpOnly session cookie. */
export async function unlockConsole(rootToken: string): Promise<{ expiresIn: number }> {
  const res = await fetch(`${API_BASE}/api/console-session`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${rootToken}` },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'invalid token' : `unlock failed (${res.status})`);
  }
  return await res.json() as { expiresIn: number };
}

/** Lock the console: revoke the session and clear the cookie. */
export async function lockConsole(): Promise<void> {
  await fetch(`${API_BASE}/api/console-session`, {
    method: 'DELETE',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(5000),
  });
}

// ---------------------------------------------------------------------------
// Audience-scoped tickets (#313)
//
// The HttpOnly console-session cookie (set by the unlock flow) is the
// bootstrap credential and is used ONLY to mint short-lived tickets via
// POST /api/auth-ticket. Every other call -- HTTP API or EventSource --
// threads a ticket of the matching audience; the browser never holds the
// root token (B1).
// ---------------------------------------------------------------------------

type TicketAudience = 'api' | 'sse';



async function mintTicket(audience: TicketAudience): Promise<string> {
  // Bootstrap: the HttpOnly session cookie (set by the unlock flow)
  // authenticates this mint; the browser never holds the root token.
  const res = await fetch(`${API_BASE}/api/auth-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ audience }),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 401) throw new ConsoleLockedError();
  if (!res.ok) {
    throw new Error(`auth-ticket ${audience} ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as { ticket?: unknown; expiresIn?: unknown };
  if (typeof data.ticket !== 'string' || data.ticket.length === 0) {
    throw new Error(`auth-ticket ${audience}: malformed server response`);
  }
  return data.ticket;
}

/**
 * Mint a fresh audience-scoped ticket. Server-side tickets are single-use:
 * sharing a fulfilled ticket across API calls causes the second redemption
 * to fail with 401.
 *
 * Exported for callers (e.g. EventSource bootstrap in `LinkStep`) that
 * need the raw ticket string.
 */
export async function getApiTicket(audience: TicketAudience = 'api'): Promise<string> {
  return mintTicket(audience);
}

/** Test helper kept stable for existing imports. */
export function clearTicketCache(): void {
}

/**
 * Build auth headers for the HTTP API.
 *
 * In production we mint and thread an `api`-audience ticket. In dev or when
 * no root token is available (the SPA is being served standalone), we omit
 * the header and let the Vite proxy / mock fallback handle the request.
 */
async function authHeaders(): Promise<Record<string, string>> {
  if (!isProductionConsole()) return {};
  try {
    const ticket = await getApiTicket('api');
    return { 'Authorization': `Bearer ${ticket}` };
  } catch (err) {
    // Mint failed (network, 401, server down). In production we surface
    // the failure so the UI can render a real error state instead of
    // degrading to an unauthenticated request that masquerades as
    // healthy. Dev / mock-mode builds tolerate the failure and let the
    // surrounding fetch fall through to mock data (#420).
    if (!mockFallbackEnabled()) {
      throw err;
    }
    return {};
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...auth,
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    // #2517: Parse the fleet-error-v1 projection and render only safe fields.
    // Never interpolate the raw response body into the exception message.
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { schema?: string; code?: string; message?: string; correlation_id?: string };
      if (parsed.schema === 'fleet-error-v1') {
        const code = parsed.code ?? 'unknown';
        const msg = parsed.message ?? 'An error occurred.';
        const cid = parsed.correlation_id ? ` [${parsed.correlation_id}]` : '';
        throw new FleetApiError(res.status, code, msg, cid);
      }
    } catch (parseErr) {
      if (parseErr instanceof FleetApiError) throw parseErr;
      // Body wasn't valid JSON — use status code only, never the raw body.
    }
    throw new Error(`API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

let fleetAvailable: boolean | null = null;
let checkInFlight: Promise<boolean> | null = null;
let mockDataPromise: Promise<typeof import('../mock-data.ts')> | null = null;

async function loadMockData(): Promise<typeof import('../mock-data.ts')> {
  if (!mockDataPromise) {
    mockDataPromise = import('../mock-data.ts');
  }
  return mockDataPromise;
}

async function checkFleetAvailable(): Promise<boolean> {
  if (fleetAvailable !== null) return fleetAvailable;
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const auth = await authHeaders();
        const res = await fetch(`${API_BASE}/api/lines`, {
          signal: controller.signal,
          headers: auth,
        });
        fleetAvailable = res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      fleetAvailable = false;
    }
    checkInFlight = null;
    setTimeout(() => { fleetAvailable = null; }, 60_000);
    return fleetAvailable!;
  })();
  return checkInFlight;
}

async function withFallback<T>(apiFn: () => Promise<T>, mockFn: () => Promise<T>): Promise<T> {
  // In production builds without explicit opt-in, bypass the mock
  // fallback entirely so real failures surface to the UI (#420). We
  // still run the API call directly; we just don't swallow its errors
  // or substitute mock data when the availability probe trips.
  if (!mockFallbackEnabled()) {
    return apiFn();
  }
  const available = await checkFleetAvailable();
  if (!available) return mockFn();
  try {
    return await apiFn();
  } catch {
    fleetAvailable = null;
    return mockFn();
  }
}

type ApiRecord = Record<string, unknown>;

function stringField(source: ApiRecord, key: string, fallback = ''): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

function requiredStringField(source: ApiRecord, key: string, fallback = ''): string {
  const value = stringField(source, key, fallback);
  return value || fallback;
}

function nullableStringField(source: ApiRecord, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function numberField(source: ApiRecord, key: string, fallback = 0): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanField(source: ApiRecord, key: string, fallback = false): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeChatItem(value: unknown): ChatItem {
  const row = asRecordOrEmpty(value);
  const conversationKey = requiredStringField(row, 'conversationKey');
  return {
    conversationKey,
    name: requiredStringField(row, 'name', conversationKey),
    lastMessagePreview: stringField(row, 'lastMessagePreview'),
    lastMessageAt: stringField(row, 'lastMessageAt'),
    unreadCount: numberField(row, 'unreadCount'),
    isGroup: booleanField(row, 'isGroup'),
  };
}

function normalizeMessage(value: unknown): Message {
  const row = asRecordOrEmpty(value);
  return {
    pk: numberField(row, 'pk'),
    conversationKey: requiredStringField(row, 'conversationKey'),
    senderName: stringField(row, 'senderName'),
    senderJid: stringField(row, 'senderJid'),
    content: nullableStringField(row, 'content'),
    timestamp: stringField(row, 'timestamp'),
    fromMe: booleanField(row, 'fromMe'),
    type: requiredStringField(row, 'type', 'unknown'),
    rawMessage: nullableStringField(row, 'rawMessage') ?? undefined,
  };
}

function normalizeSearchResponse(value: unknown): { results: Message[]; total: number; query: string } {
  const row = asRecordOrEmpty(value);
  const resultsValue = row.results;
  const results = Array.isArray(resultsValue) ? resultsValue.map(normalizeMessage) : [];
  return {
    results,
    total: numberField(row, 'total', results.length),
    query: stringField(row, 'query'),
  };
}

export const api = {
  getLines: () => withFallback(
    () => apiFetch<LineInstance[]>('/api/lines'),
    async () => (await loadMockData()).getLines(),
  ),
  getLine: (name: string) => withFallback(
    () => apiFetch<LineInstance>(`/api/lines/${encodeURIComponent(name)}`),
    async () => { const line = (await loadMockData()).getLine(name); if (!line) throw new Error('Not found'); return line; },
  ),
  getChats: (name: string) => withFallback(
    async () => (await apiFetch<unknown[]>(`/api/lines/${encodeURIComponent(name)}/chats`)).map(normalizeChatItem),
    async () => (await loadMockData()).getChats(name).map(normalizeChatItem),
  ),
  getMessages: (name: string, conversationKey: string, beforePk?: number) => withFallback(
    async () => (await apiFetch<unknown[]>(`/api/lines/${encodeURIComponent(name)}/messages?conversation_key=${encodeURIComponent(conversationKey)}${beforePk ? `&before_pk=${beforePk}` : ''}`)).map(normalizeMessage),
    async () => (await loadMockData()).getMessages(name, conversationKey).map(normalizeMessage),
  ),
  getMetrics: (name: string, range: MetricsRange) => withFallback(
    () => apiFetch<LineMetrics>(`/api/lines/${encodeURIComponent(name)}/metrics?range=${encodeURIComponent(range)}`),
    async () => (await loadMockData()).getMetrics(name, range),
  ),
  getFleetMetrics: (range: MetricsRange) => withFallback(
    () => apiFetch<FleetMetrics>(`/api/metrics?range=${encodeURIComponent(range)}`),
    async () => (await loadMockData()).getFleetMetrics(range),
  ),
  searchMessages: (name: string, query: string, conversationKey?: string) =>
    apiFetch<unknown>(
      `/api/lines/${encodeURIComponent(name)}/messages/search?q=${encodeURIComponent(query)}${conversationKey ? `&conversation_key=${encodeURIComponent(conversationKey)}` : ''}`
    ).then(normalizeSearchResponse),
  saveContact: (name: string, contact: { jid: string; firstName?: string; lastName?: string }) =>
    apiFetch<{ saved: boolean }>(`/api/lines/${encodeURIComponent(name)}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contact),
    }),
  getAccess: (name: string) => withFallback(
    () => apiFetch<AccessEntry[]>(`/api/lines/${encodeURIComponent(name)}/access`),
    async () => (await loadMockData()).getAccess(name),
  ),
  getLogs: (name: string) => withFallback(
    () => apiFetch<LogEntry[]>(`/api/lines/${encodeURIComponent(name)}/logs`),
    async () => (await loadMockData()).getLogs(name),
  ),
  // Checkpoint browser — plain apiFetch (getProviderStatus precedent: no mock lane).
  getCheckpoints: (name: string) =>
    apiFetch<CheckpointsPayload>(`/api/lines/${encodeURIComponent(name)}/checkpoints`),

  getLiveSessions: (name: string) =>
    apiFetch<LiveSessionsPayload>(`/api/lines/${encodeURIComponent(name)}/live-sessions`),
  getFeed: () => withFallback(
    () => apiFetch<FeedEvent[]>('/api/feed'),
    async () => (await loadMockData()).getFeed(),
  ),

  getTyping: () => withFallback(
    () => apiFetch<{ instance: string; jid: string; since: number }[]>('/api/typing'),
    async () => (await loadMockData()).getTyping(),
  ),

  // ── Write operations ──

  restart: (name: string) =>
    apiFetch<{ status: string; instance: string }>(`/api/lines/${encodeURIComponent(name)}/restart`, { method: 'POST' }),

  stopInstance: (name: string) =>
    apiFetch<{ status: string; instance: string }>(`/api/lines/${encodeURIComponent(name)}/stop`, { method: 'POST' }),

  deleteLine: (name: string) =>
    apiFetch<{ deleted: string }>(`/api/lines/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  sendMessage: (name: string, chatJid: string, text: string) =>
    apiFetch<{ sent: boolean }>(`/api/lines/${encodeURIComponent(name)}/send`, {
      method: 'POST',
      body: JSON.stringify({ chatJid, text }),
    }),

  accessDecision: (name: string, subjectType: string, subjectId: string, action: 'allow' | 'block') =>
    apiFetch<{ ok: boolean; result: string }>(`/api/lines/${encodeURIComponent(name)}/access`, {
      method: 'POST',
      body: JSON.stringify({ subjectType, subjectId, action }),
    }),

  restoreCheckpoint: (name: string, conversationKey: string) =>
    apiFetch<{ status: string }>(`/api/lines/${encodeURIComponent(name)}/checkpoints/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationKey }),
    }),

  // #2550: the instance route 404s (and apiFetch throws) on chat_not_found —
  // a 200 body is always the ok:true shape, carrying the independent
  // `remote` receipt (see MarkConversationReadResult doc for the split).
  markRead: (name: string, conversationKey: string) =>
    apiFetch<MarkConversationReadResult>(`/api/lines/${encodeURIComponent(name)}/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_key: conversationKey }),
    }),

  updateConfig: (name: string, patch: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>(`/api/lines/${encodeURIComponent(name)}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(30_000),
    }),

  /** Store a provider key in the OS keyring (write-only; body never echoed).
   *  404 = service not in the server's credential write allowlist — surface
   *  the CLI provisioning path, do not treat as a key error (QR-238). */
  setCredential: (service: string, value: string) =>
    apiFetch<{ ok: boolean; service: string; envShadowed?: boolean }>(
      `/api/credentials/${encodeURIComponent(service)}`,
      { method: 'PUT', body: JSON.stringify({ value }) },
    ),

  verifyCredential: (service: string) =>
    apiFetch<{ service: string; status: string }>(
      `/api/credentials/${encodeURIComponent(service)}/verify`,
      { method: 'POST', signal: AbortSignal.timeout(15_000) },
    ),

  /** Remove a provider key from the OS keyring (T5 b-09 Settings revoke). */
  deleteCredential: (service: string) =>
    apiFetch<{ ok: boolean; service: string; envShadowed?: boolean; inUse?: boolean }>(
      `/api/credentials/${encodeURIComponent(service)}`,
      { method: 'DELETE' },
    ),

  // ── Fleet alert silences (src/fleet/routes/silence.ts) — the only
  // notification-adjacent prefs with real persistence (fleet-silences.json).
  getSilences: () =>
    apiFetch<{
      availability: 'observed' | 'uninitialized' | 'unavailable' | 'invalid'
      readBasis: 'current' | 'last_known_good'
      observedAt: string
      revision?: string
      reasonClass?: 'invalid_json' | 'invalid_document' | 'missing_after_observed' | 'permission_denied' | 'read_failed'
      lastKnownGoodAt?: string
      lastKnownGoodAgeMs?: number
      silences: Array<{
        instance: string
        until: string
        reason: string | null
        silencedBy: string
        createdAt: string
      }>
    }>('/api/fleet/silences'),

  silenceLine: (instance: string, durationMinutes: number, reason?: string) =>
    apiFetch<{ ok: boolean; rule: unknown }>('/api/fleet/silence', {
      method: 'POST',
      body: JSON.stringify({ instance, duration_minutes: durationMinutes, reason }),
    }),

  unsilenceLine: (instance: string) =>
    apiFetch<{ ok: boolean }>(`/api/fleet/silence/${encodeURIComponent(instance)}`, {
      method: 'DELETE',
    }),

  createLine: (config: Record<string, unknown>) =>
    apiFetch<{ name: string; healthPort: number }>('/api/lines', {
      method: 'POST',
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(30_000),
    }),

  checkExists: (name: string) =>
    apiFetch<{ exists: boolean }>(`/api/lines/${encodeURIComponent(name)}/exists`),

  checkDirectory: (dirPath: string) =>
    apiFetch<{ exists: boolean; writable: boolean }>(`/api/directories/check?path=${encodeURIComponent(dirPath)}`),

  getVersion: () =>
    apiFetch<{ sha: string; remoteSha: string; updateAvailable: boolean; checkedAt: string }>('/api/version'),

  // Fleet-process liveness (src/fleet/livez.ts) — unauthenticated loopback
  // route; the Deployments surface reads fleet uptime from it.
  getLivez: () =>
    apiFetch<{ alive: boolean; instance: string; pid: number; uptime_seconds: number; started_at: string }>(
      '/livez',
    ),

  // ── Provider catalog + per-instance provider/key/fallback status ──

  getProviders: () =>
    apiFetch<ProviderCatalogEntry[]>('/api/providers'),

  getProviderStatus: (name: string) =>
    apiFetch<ProviderStatus>(`/api/lines/${encodeURIComponent(name)}/provider-status`),

  getRateLimits: (name: string) =>
    apiFetch<RateLimitsPayload>(`/api/lines/${encodeURIComponent(name)}/rate-limits`),

  getApprovals: (name: string) =>
    apiFetch<ApprovalsPayload>(`/api/lines/${encodeURIComponent(name)}/approvals`),
  postApprovalDecision: (name: string, decision: { mapKey: string; questionIndex: number; selectedOptions: string[] }) =>
    apiFetch<{ status: string }>(`/api/lines/${encodeURIComponent(name)}/approvals/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decision),
    }),
  // ── MCP proxy operations ──

  getScheduled: (name: string, status?: string) => withFallback(
    () => apiFetch<{ count: number; messages: ScheduledMessage[] }>(`/api/lines/${encodeURIComponent(name)}/scheduled${status ? `?status=${status}` : ''}`, { signal: AbortSignal.timeout(15000) }),
    async () => (await loadMockData()).getScheduled(name),
  ),

  cancelScheduled: (name: string, id: number) =>
    apiFetch<{ cancelled: boolean; id: number }>(
      `/api/lines/${encodeURIComponent(name)}/scheduled/${id}`,
      { method: 'DELETE' },
    ),

  getGroups: (name: string) => withFallback(
    () => apiFetch<{ groups: GroupInfo[] }>(`/api/lines/${encodeURIComponent(name)}/groups`, { signal: AbortSignal.timeout(15000) }),
    async () => (await loadMockData()).getGroups(name),
  ),

  searchContacts: (name: string, query: string) => withFallback(
    () => apiFetch<{ contacts: ContactResult[] }>(`/api/lines/${encodeURIComponent(name)}/contacts/search?q=${encodeURIComponent(query)}`),
    async () => (await loadMockData()).searchContacts(name, query),
  ),

  // ── Scheduled messages (new) ──

  createScheduled: (name: string, data: Record<string, unknown>) =>
    apiFetch<ScheduledMessage>(`/api/lines/${encodeURIComponent(name)}/scheduled`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateScheduled: (name: string, id: number, data: Record<string, unknown>) =>
    apiFetch<ScheduledMessage>(`/api/lines/${encodeURIComponent(name)}/scheduled/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  getScheduledById: (name: string, id: number) =>
    apiFetch<ScheduledMessage>(`/api/lines/${encodeURIComponent(name)}/scheduled/${id}`),

  // ── Groups (new) ──

  getGroupDetail: (name: string, jid: string) => withFallback(
    () => apiFetch<GroupDetail>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}`, {
      signal: AbortSignal.timeout(15000),
    }),
    async () => { const d = (await loadMockData()).getGroupDetail(name, jid); if (!d) throw new Error('Not found'); return d; },
  ),

  createGroup: (name: string, subject: string, participants: string[]) =>
    apiFetch<{ id: string }>(`/api/lines/${encodeURIComponent(name)}/groups`, {
      method: 'POST',
      body: JSON.stringify({ subject, participants }),
    }),

  leaveGroup: (name: string, jid: string) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}`, {
      method: 'DELETE',
    }),

  updateGroupSubject: (name: string, jid: string, subject: string) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/subject`, {
      method: 'PUT',
      body: JSON.stringify({ subject }),
    }),

  updateGroupDescription: (name: string, jid: string, description?: string) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/description`, {
      method: 'PUT',
      body: JSON.stringify({ description }),
    }),

  updateGroupParticipants: (name: string, jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote') =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/participants`, {
      method: 'POST',
      body: JSON.stringify({ participants, action }),
    }),

  updateGroupSettings: (name: string, jid: string, setting: string) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/settings`, {
      method: 'PUT',
      body: JSON.stringify({ setting }),
    }),

  getGroupInviteLink: (name: string, jid: string) =>
    apiFetch<{ jid: string; inviteCode: string; inviteLink: string }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/invite`),

  revokeGroupInvite: (name: string, jid: string) =>
    apiFetch<{ inviteCode: string }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/invite/revoke`, {
      method: 'POST',
    }),

  updateGroupEphemeral: (name: string, jid: string, expiration: number) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/ephemeral`, {
      method: 'PUT',
      body: JSON.stringify({ expiration }),
    }),

  updateGroupMemberAddMode: (name: string, jid: string, mode: 'all_member_add' | 'admin_add') =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/member-add-mode`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),

  updateGroupJoinApproval: (name: string, jid: string, mode: 'on' | 'off') =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/join-approval`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),

  /**
   * Mint a single-use WebSocket ticket (#237). The fleet server signs the
   * ticket with the active fleet token; the browser then opens the WS as
   * `wss://host/ws?ticket=<ticket>`. The root token never travels in the URL.
   */
  getWsTicket: async () => {
    const res = await fetch(`${API_BASE}/api/ws-ticket`, {
      method: 'POST',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) throw new ConsoleLockedError();
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${await res.text()}`);
    }
    return await res.json() as { ticket: string; expiresIn: number };
  },
};
