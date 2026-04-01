// ---------------------------------------------------------------------------
//  WhatSoup Console — Fleet Data Hooks
//  Uses TanStack Query with real fleet API calls.
// ---------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { computeKpis } from '../mock-data'; // Keep KPI computation (pure function)
export { computeKpis };

/** All line instances — refreshes every 5 s. */
export function useLines() {
  return useQuery({
    queryKey: ['lines'],
    queryFn: () => api.getLines(),
    refetchInterval: 5000,
  });
}

/** Single line by name — refreshes every 5 s. */
export function useLine(name: string) {
  return useQuery({
    queryKey: ['lines', name],
    queryFn: () => api.getLine(name),
    refetchInterval: 5000,
    enabled: !!name,
  });
}

/** Chat list for a given line — refreshes every 5 s to show new messages/previews. */
export function useChats(name: string) {
  return useQuery({
    queryKey: ['chats', name],
    queryFn: () => api.getChats(name),
    refetchInterval: 5000,
    enabled: !!name,
  });
}

/** Messages in a specific conversation — refreshes every 3 s for live updates. */
export function useMessages(name: string, conversationKey: string) {
  return useQuery({
    queryKey: ['messages', name, conversationKey],
    queryFn: () => api.getMessages(name, conversationKey),
    refetchInterval: 3000,
    enabled: !!name && !!conversationKey,
  });
}

/** Access control list for a line. */
export function useAccess(name: string) {
  return useQuery({
    queryKey: ['access', name],
    queryFn: () => api.getAccess(name),
    enabled: !!name,
  });
}

/** Structured logs for a line — refreshes every 3 s. */
export function useLogs(name: string) {
  return useQuery({
    queryKey: ['logs', name],
    queryFn: () => api.getLogs(name),
    refetchInterval: 3000,
    enabled: !!name,
  });
}

/** Typing indicators from all instances — refreshes every 2 s. */
export function useTyping() {
  return useQuery({
    queryKey: ['typing'],
    queryFn: () => api.getTyping(),
    refetchInterval: 2000,
  });
}

/** Global activity feed — refreshes every 5 s. */
export function useFeed() {
  return useQuery({
    queryKey: ['feed'],
    queryFn: () => api.getFeed(),
    refetchInterval: 5000,
  });
}
