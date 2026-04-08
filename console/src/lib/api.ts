/**
 * Fleet API client with mock data fallback.
 *
 * - In production: fleet server serves both the SPA and /api/* routes
 * - In dev mode: Vite proxies /api/* to the fleet server
 * - Fallback: if fleet server is unreachable, returns mock data so the
 *   console always renders (useful for design iteration and demos)
 */

import type {
  AccessEntry,
  ChatItem,
  ContactResult,
  FeedEvent,
  FleetMetrics,
  GroupDetail,
  GroupInfo,
  LineInstance,
  LineMetrics,
  LogEntry,
  Message,
  MetricsRange,
  ScheduledMessage,
} from '../types.js';

const API_BASE = '';

/** Read the fleet token from the meta tag injected by the production server. */
export function getFleetToken(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="fleet-token"]');
  return meta?.content || null;
}

/** Build auth headers — Bearer token in production, empty in dev (proxy handles it). */
function authHeaders(): Record<string, string> {
  const token = getFleetToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
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
      const res = await fetch(`${API_BASE}/api/lines`, {
        signal: controller.signal,
        headers: authHeaders(),
      });
      clearTimeout(timer);
      fleetAvailable = res.ok;
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
  const available = await checkFleetAvailable();
  if (!available) return mockFn();
  try {
    return await apiFn();
  } catch {
    fleetAvailable = null;
    return mockFn();
  }
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
    () => apiFetch<ChatItem[]>(`/api/lines/${encodeURIComponent(name)}/chats`),
    async () => (await loadMockData()).getChats(name),
  ),
  getMessages: (name: string, conversationKey: string, beforePk?: number) => withFallback(
    () => apiFetch<Message[]>(`/api/lines/${encodeURIComponent(name)}/messages?conversation_key=${encodeURIComponent(conversationKey)}${beforePk ? `&before_pk=${beforePk}` : ''}`),
    async () => (await loadMockData()).getMessages(name, conversationKey),
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
    apiFetch<{ results: Message[]; total: number; query: string }>(
      `/api/lines/${encodeURIComponent(name)}/messages/search?q=${encodeURIComponent(query)}${conversationKey ? `&conversation_key=${encodeURIComponent(conversationKey)}` : ''}`
    ),
  saveContact: (name: string, contact: { jid: string; firstName?: string; lastName?: string }) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/contacts`, {
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
  getFeed: () => withFallback(
    () => apiFetch<FeedEvent[]>('/api/feed'),
    async () => (await loadMockData()).getFeed(),
  ),

  getTyping: () => withFallback(
    () => apiFetch<{ instance: string; jid: string; since: number }[]>('/api/typing'),
    async () => (await loadMockData()).getTyping(),
  ).catch(() => []),

  // ── Write operations ──

  restart: (name: string) =>
    apiFetch<{ status: string; instance: string }>(`/api/lines/${encodeURIComponent(name)}/restart`, { method: 'POST' }),

  stopInstance: (name: string) =>
    apiFetch<{ status: string; instance: string }>(`/api/lines/${encodeURIComponent(name)}/stop`, { method: 'POST' }),

  deleteLine: (name: string) =>
    apiFetch<{ deleted: string }>(`/api/lines/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  sendMessage: (name: string, chatJid: string, text: string) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/send`, {
      method: 'POST',
      body: JSON.stringify({ chatJid, text }),
    }),

  accessDecision: (name: string, subjectType: string, subjectId: string, action: 'allow' | 'block') =>
    apiFetch<{ ok: boolean; result: string }>(`/api/lines/${encodeURIComponent(name)}/access`, {
      method: 'POST',
      body: JSON.stringify({ subjectType, subjectId, action }),
    }),

  updateConfig: (name: string, patch: Record<string, unknown>) =>
    apiFetch<Record<string, unknown>>(`/api/lines/${encodeURIComponent(name)}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(30_000),
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
};
