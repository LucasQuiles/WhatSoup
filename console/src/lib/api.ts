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

let fleetAvailable: boolean | null = null; // null = unknown, true/false = cached result

async function checkFleetAvailable(): Promise<boolean> {
  if (fleetAvailable !== null) return fleetAvailable;
  try {
    const res = await fetch(`${API_BASE}/api/lines`, { signal: AbortSignal.timeout(2000) });
    fleetAvailable = res.ok;
  } catch {
    fleetAvailable = false;
  }
  // Re-check every 30s in case fleet server starts later
  setTimeout(() => { fleetAvailable = null; }, 30_000);
  return fleetAvailable;
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
  getMessages: (name: string, conversationKey: string) => withFallback(
    () => apiFetch<mock.Message[]>(`/api/lines/${encodeURIComponent(name)}/messages?conversation_key=${encodeURIComponent(conversationKey)}`),
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
};
