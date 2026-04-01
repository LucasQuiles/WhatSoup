/**
 * Fleet API client. In dev mode, Vite proxies /api/* to the fleet server.
 * In production, the fleet server serves the console as static files.
 */

const API_BASE = ''; // Same origin — Vite proxy or production static serving

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getLines: () => apiFetch<import('../mock-data').LineInstance[]>('/api/lines'),
  getLine: (name: string) => apiFetch<import('../mock-data').LineInstance>(`/api/lines/${encodeURIComponent(name)}`),
  getChats: (name: string) => apiFetch<import('../mock-data').ChatItem[]>(`/api/lines/${encodeURIComponent(name)}/chats`),
  getMessages: (name: string, conversationKey: string) =>
    apiFetch<import('../mock-data').Message[]>(`/api/lines/${encodeURIComponent(name)}/messages?conversation_key=${encodeURIComponent(conversationKey)}`),
  getAccess: (name: string) => apiFetch<import('../mock-data').AccessEntry[]>(`/api/lines/${encodeURIComponent(name)}/access`),
  getLogs: (name: string) => apiFetch<import('../mock-data').LogEntry[]>(`/api/lines/${encodeURIComponent(name)}/logs`),
  getFeed: () => apiFetch<import('../mock-data').FeedEvent[]>('/api/feed'),
};
