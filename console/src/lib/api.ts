/**
 * Fleet API client with mock data fallback.
 *
 * - In production: fleet server serves both the SPA and /api/* routes
 * - In dev mode: Vite proxies /api/* to the fleet server
 * - Fallback: if fleet server is unreachable, returns mock data so the
 *   console always renders (useful for design iteration and demos)
 */

import type { AccessEntry, ChatItem, FeedEvent, LineInstance, LogEntry, Message } from '../types';

const API_BASE = '';

/** Read the fleet token from the meta tag injected by the production server. */
function getFleetToken(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="fleet-token"]');
  return meta?.content || null;
}

/** Build auth headers — Bearer token in production, empty in dev (proxy handles it). */
function authHeaders(): Record<string, string> {
  const token = getFleetToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
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
  // Deduplicate concurrent checks
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
    // Re-check periodically in case fleet server starts later
    setTimeout(() => { fleetAvailable = null; }, 60_000);
    return fleetAvailable;
  })();
  return checkInFlight;
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

/** Try fleet API first, fall back to mock data if unavailable. */
async function withFallback<T>(apiFn: () => Promise<T>, mockFn: () => Promise<T>): Promise<T> {
  const available = await checkFleetAvailable();
  if (!available) return mockFn();
  try {
    return await apiFn();
  } catch {
    // Fleet server went away mid-session — fall back
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
    async () => (await loadMockData()).getLine(name)!,
  ),
  getChats: (name: string) => withFallback(
    () => apiFetch<ChatItem[]>(`/api/lines/${encodeURIComponent(name)}/chats`),
    async () => (await loadMockData()).getChats(name),
  ),
  getMessages: (name: string, conversationKey: string, beforePk?: number) => withFallback(
    () => apiFetch<Message[]>(
      `/api/lines/${encodeURIComponent(name)}/messages?conversation_key=${encodeURIComponent(conversationKey)}${beforePk ? `&before_pk=${beforePk}` : ''}`
    ),
    async () => (await loadMockData()).getMessages(name, conversationKey),
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
  getMetrics: (name: string, range: '24h' | '7d' | '30d' = '24h') =>
    apiFetch<{
      range: string;
      messageVolume: { bucket: string; inbound: number; outbound: number }[];
      activeHours: number[][];
    }>(`/api/lines/${encodeURIComponent(name)}/metrics?range=${range}`),
  getFeed: () => withFallback(
    () => apiFetch<FeedEvent[]>('/api/feed'),
    async () => (await loadMockData()).getFeed(),
  ),

  getTyping: () =>
    apiFetch<{ instance: string; jid: string; since: number }[]>('/api/typing').catch(() => []),

  // ── Write operations (no mock fallback — these require a live fleet server) ──

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
};
