/**
 * Fleet API client with mock data fallback.
 *
 * - In production: fleet server serves both the SPA and /api/* routes
 * - In dev mode: Vite proxies /api/* to the fleet server
 * - Fallback: if fleet server is unreachable, returns mock data so the
 *   console always renders (useful for design iteration and demos)
 */

import * as mock from '../mock-data';

const API_BASE = '';

let fleetAvailable: boolean | null = null;
let checkInFlight: Promise<boolean> | null = null;

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
async function withFallback<T>(apiFn: () => Promise<T>, mockFn: () => T): Promise<T> {
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
    () => apiFetch<mock.LineInstance[]>('/api/lines'),
    () => mock.getLines(),
  ),
  getLine: (name: string) => withFallback(
    () => apiFetch<mock.LineInstance>(`/api/lines/${encodeURIComponent(name)}`),
    () => mock.getLine(name)!,
  ),
  getChats: (name: string) => withFallback(
    () => apiFetch<mock.ChatItem[]>(`/api/lines/${encodeURIComponent(name)}/chats`),
    () => mock.getChats(name),
  ),
  getMessages: (name: string, conversationKey: string, beforePk?: number) => withFallback(
    () => apiFetch<mock.Message[]>(
      `/api/lines/${encodeURIComponent(name)}/messages?conversation_key=${encodeURIComponent(conversationKey)}${beforePk ? `&before_pk=${beforePk}` : ''}`
    ),
    () => mock.getMessages(name, conversationKey),
  ),
  getAccess: (name: string) => withFallback(
    () => apiFetch<mock.AccessEntry[]>(`/api/lines/${encodeURIComponent(name)}/access`),
    () => mock.getAccess(name),
  ),
  getLogs: (name: string) => withFallback(
    () => apiFetch<mock.LogEntry[]>(`/api/lines/${encodeURIComponent(name)}/logs`),
    () => mock.getLogs(name),
  ),
  getFeed: () => withFallback(
    () => apiFetch<mock.FeedEvent[]>('/api/feed'),
    () => mock.getFeed(),
  ),

  getTyping: () =>
    apiFetch<{ instance: string; jid: string; since: number }[]>('/api/typing').catch(() => []),

  // ── Write operations (no mock fallback — these require a live fleet server) ──

  restart: (name: string) =>
    apiFetch<{ status: string; instance: string }>(`/api/lines/${encodeURIComponent(name)}/restart`, { method: 'POST' }),

  stopInstance: (name: string) =>
    apiFetch<{ status: string; instance: string }>(`/api/lines/${encodeURIComponent(name)}/stop`, { method: 'POST' }),

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
    }),

  createLine: (config: Record<string, unknown>) =>
    apiFetch<{ name: string; healthPort: number }>('/api/lines', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  checkExists: (name: string) =>
    apiFetch<{ exists: boolean }>(`/api/lines/${encodeURIComponent(name)}/exists`),

  checkDirectory: (dirPath: string) =>
    apiFetch<{ exists: boolean; writable: boolean }>(`/api/directories/check?path=${encodeURIComponent(dirPath)}`),
};
