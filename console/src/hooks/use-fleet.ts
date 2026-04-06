// ---------------------------------------------------------------------------
//  WhatSoup Console — Fleet Data Hooks
//  Uses TanStack Query with real fleet API calls.
//  Polling is disabled while WebSocket is connected (realtime push).
// ---------------------------------------------------------------------------

import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { computeKpis } from '../lib/compute-kpis.js';
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
  return useQuery(getLinesQueryOptions(connected ? false : POLL_LINES));
}

export function useLine(name: string) {
  const { connected } = useRealtime();
  return useQuery(getLineQueryOptions(name, connected ? false : POLL_LINES));
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
