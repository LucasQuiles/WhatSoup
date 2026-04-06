/**
 * Fleet API client.
 *
 * - In production: fleet server serves both the SPA and /api/* routes
 * - In dev mode: Vite proxies /api/* to the fleet server
 */

import type {
  AccessEntry,
  ChatItem,
  ContactResult,
  FeedEvent,
  FleetMetrics,
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

export const api = {
  getLines: () =>
    apiFetch<LineInstance[]>('/api/lines'),
  getLine: (name: string) =>
    apiFetch<LineInstance>(`/api/lines/${encodeURIComponent(name)}`),
  getChats: (name: string) =>
    apiFetch<ChatItem[]>(`/api/lines/${encodeURIComponent(name)}/chats`),
  getMessages: (name: string, conversationKey: string, beforePk?: number) =>
    apiFetch<Message[]>(
      `/api/lines/${encodeURIComponent(name)}/messages?conversation_key=${encodeURIComponent(conversationKey)}${beforePk ? `&before_pk=${beforePk}` : ''}`
    ),
  getMetrics: (name: string, range: MetricsRange) =>
    apiFetch<LineMetrics>(`/api/lines/${encodeURIComponent(name)}/metrics?range=${encodeURIComponent(range)}`),
  getFleetMetrics: (range: MetricsRange) =>
    apiFetch<FleetMetrics>(`/api/metrics?range=${encodeURIComponent(range)}`),
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
  getAccess: (name: string) =>
    apiFetch<AccessEntry[]>(`/api/lines/${encodeURIComponent(name)}/access`),
  getLogs: (name: string) =>
    apiFetch<LogEntry[]>(`/api/lines/${encodeURIComponent(name)}/logs`),
  getFeed: () =>
    apiFetch<FeedEvent[]>('/api/feed'),

  getTyping: () =>
    apiFetch<{ instance: string; jid: string; since: number }[]>('/api/typing').catch(() => []),

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

  getScheduled: (name: string) =>
    apiFetch<{ scheduled: ScheduledMessage[] }>(`/api/lines/${encodeURIComponent(name)}/scheduled`, { signal: AbortSignal.timeout(15000) }),

  cancelScheduled: (name: string, messageId: string) =>
    apiFetch<{ cancelled: boolean; messageId: string }>(`/api/lines/${encodeURIComponent(name)}/scheduled?id=${encodeURIComponent(messageId)}`, { method: 'DELETE' }),

  getGroups: (name: string) =>
    apiFetch<{ groups: GroupInfo[] }>(`/api/lines/${encodeURIComponent(name)}/groups`, { signal: AbortSignal.timeout(15000) }),

  searchContacts: (name: string, query: string) =>
    apiFetch<{ contacts: ContactResult[] }>(`/api/lines/${encodeURIComponent(name)}/contacts/search?q=${encodeURIComponent(query)}`),
};
