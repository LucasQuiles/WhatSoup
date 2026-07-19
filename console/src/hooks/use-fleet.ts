// ---------------------------------------------------------------------------
//  WhatSoup Console — Fleet Data Hooks
//  Uses TanStack Query with real fleet API calls.
//  Most polling is disabled while WebSocket is connected (realtime push).
//  Provider-status and lines keep a bounded poll instead of disabling
//  entirely: fallback health fields (provider-status) and line
//  health/counters (#1877) can both change while the instance_status label
//  remains stable, so the server never emits an event for them.
// ---------------------------------------------------------------------------

import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { computeKpis } from '../lib/compute-kpis.js';
import { queryFreshness } from '../lib/freshness.js';
import {
  shareChatsByConversationKey,
  shareLineByName,
  shareLinesByName,
  shareMessagesByPk,
} from '../lib/structural-sharing.js';
import type { ChatItem, LineInstance, Message } from '../types.js';
import { useRealtime } from './use-websocket.js';
export { computeKpis };

// ---------------------------------------------------------------------------
// Polling intervals (used as fallback when WS is disconnected)
// ---------------------------------------------------------------------------

const POLL_LINES = 5000;
const POLL_CHATS = 5000;
const POLL_MESSAGES = 3000;
const POLL_LOGS = 3000;
const POLL_TYPING = 2000;
const POLL_FEED = 5000;

/**
 * Bounded backstop poll for useLines/useLine while WS is connected (#1877).
 * The server publishes `instance_status` only on a coarse status-label
 * CHANGE, so a successful online→online poll can update health,
 * healthObservedAt, and DB counters with no event reaching the browser.
 * Slower than the disconnected POLL_LINES (5000) since WS still delivers
 * status transitions promptly — this interval only backstops freshness for
 * everything else in the payload.
 */
const POLL_LINES_WS_BACKSTOP = 15_000;

// ---------------------------------------------------------------------------
// Query option factories (static — no hook dependency)
// ---------------------------------------------------------------------------

/** All line instances — refreshes every 5 s (or via WS push). */
export function getLinesQueryOptions(poll: number | false = POLL_LINES) {
  return queryOptions<LineInstance[], Error, LineInstance[], ['lines']>({
    queryKey: ['lines'],
    queryFn: () => api.getLines(),
    refetchInterval: poll,
    structuralSharing: shareLinesByName,
  });
}

/** Single line by name. */
export function getLineQueryOptions(name: string, poll: number | false = POLL_LINES) {
  return queryOptions<LineInstance, Error, LineInstance, ['lines', string]>({
    queryKey: ['lines', name],
    queryFn: () => api.getLine(name),
    refetchInterval: poll,
    enabled: !!name,
    structuralSharing: shareLineByName,
  });
}

/** Chat list for a given line. */
export function getChatsQueryOptions(name: string, poll: number | false = POLL_CHATS) {
  return queryOptions<ChatItem[], Error, ChatItem[], ['chats', string]>({
    queryKey: ['chats', name],
    queryFn: () => api.getChats(name),
    refetchInterval: poll,
    enabled: !!name,
    structuralSharing: shareChatsByConversationKey,
  });
}

/** Messages in a specific conversation. */
export function getMessagesQueryOptions(name: string, conversationKey: string, poll: number | false = POLL_MESSAGES) {
  return queryOptions<Message[], Error, Message[], ['messages', string, string]>({
    queryKey: ['messages', name, conversationKey],
    queryFn: () => api.getMessages(name, conversationKey),
    refetchInterval: poll,
    enabled: !!name && !!conversationKey,
    structuralSharing: shareMessagesByPk,
  });
}

// ---------------------------------------------------------------------------
// Hooks (consume WS connection state to gate polling)
// ---------------------------------------------------------------------------

export function useLines() {
  const { connected } = useRealtime();
  // #1877 crit 2: message-derived counters (getMessageStats, getChatCounts,
  // getTotalSessions, getTokenStats, getLastMessageTime) are server-cached
  // for 60s (DAILY_CACHE_TTL, src/fleet/routes/lines.ts), so this bounded
  // poll — not a per-message ['lines'] invalidation — is what surfaces
  // counter changes on a connected tab without re-requesting cached data.
  const poll = connected ? POLL_LINES_WS_BACKSTOP : POLL_LINES;
  const query = useQuery(getLinesQueryOptions(poll));
  // D-3/F-UX-4: the fleet-lines plane carries the same fail-closed
  // {observedAt, stale} contract the metrics planes got in #1925
  // (use-metrics.ts). The threshold is poll-aware: 2 missed intervals of
  // the ACTIVE interval.
  return {
    ...query,
    freshness: queryFreshness({
      dataUpdatedAt: query.dataUpdatedAt,
      refetchFailed: query.isRefetchError,
      staleAfterMs: 2 * poll,
    }),
  };
}

export function useLine(name: string) {
  const { connected } = useRealtime();
  // Same #1877 backstop rationale as useLines above.
  return useQuery(getLineQueryOptions(name, connected ? POLL_LINES_WS_BACKSTOP : POLL_LINES));
}

export function useChats(name: string) {
  const { connected } = useRealtime();
  return useQuery(getChatsQueryOptions(name, connected ? false : POLL_CHATS));
}

export function useMessages(name: string, conversationKey: string) {
  const { connected } = useRealtime();
  return useQuery(getMessagesQueryOptions(name, conversationKey, connected ? false : POLL_MESSAGES));
}

/** Access control list for a line. */
export function useAccess(name: string) {
  return useQuery({
    queryKey: ['access', name],
    queryFn: () => api.getAccess(name),
    enabled: !!name,
  });
}

/** Structured logs for a line. */
export function useLogs(name: string) {
  const { connected } = useRealtime();
  return useQuery({
    queryKey: ['logs', name],
    queryFn: () => api.getLogs(name),
    refetchInterval: connected ? false : POLL_LOGS,
    enabled: !!name,
  });
}

/** Typing indicators from all instances. */
export function useTyping() {
  const { connected } = useRealtime();
  return useQuery({
    queryKey: ['typing'],
    queryFn: () => api.getTyping(),
    refetchInterval: connected ? false : POLL_TYPING,
  });
}

/** Global activity feed. */
export function useFeed() {
  const { connected } = useRealtime();
  return useQuery({
    queryKey: ['feed'],
    queryFn: () => api.getFeed(),
    refetchInterval: connected ? false : POLL_FEED,
  });
}

/** Provider catalog (display names + capability flags). Static — long stale time. */
export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.getProviders(),
    staleTime: 5 * 60_000,
  });
}

/** Per-instance provider / key / fallback status. */
export function useProviderStatus(name: string) {
  return useQuery({
    queryKey: ['provider-status', name],
    queryFn: () => api.getProviderStatus(name),
    refetchInterval: POLL_LINES,
    enabled: !!name,
  });
}
