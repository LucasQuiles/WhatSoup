// ---------------------------------------------------------------------------
//  WhatSoup Console — Fleet Data Hooks
//  Uses TanStack Query with real fleet API calls.
// ---------------------------------------------------------------------------

import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { computeKpis } from '../lib/compute-kpis';
import {
  shareChatsByConversationKey,
  shareLineByName,
  shareLinesByName,
  shareMessagesByPk,
} from '../lib/structural-sharing';
import type { ChatItem, LineInstance, Message } from '../types';
export { computeKpis };

/** All line instances — refreshes every 5 s. */
export function getLinesQueryOptions() {
  return queryOptions<LineInstance[], Error, LineInstance[], ['lines']>({
    queryKey: ['lines'],
    queryFn: () => api.getLines(),
    refetchInterval: 5000,
    structuralSharing: shareLinesByName,
  });
}

export function useLines() {
  return useQuery(getLinesQueryOptions());
}

/** Single line by name — refreshes every 5 s. */
export function getLineQueryOptions(name: string) {
  return queryOptions<LineInstance, Error, LineInstance, ['lines', string]>({
    queryKey: ['lines', name],
    queryFn: () => api.getLine(name),
    refetchInterval: 5000,
    enabled: !!name,
    structuralSharing: shareLineByName,
  });
}

export function useLine(name: string) {
  return useQuery(getLineQueryOptions(name));
}

/** Chat list for a given line — refreshes every 5 s to show new messages/previews. */
export function getChatsQueryOptions(name: string) {
  return queryOptions<ChatItem[], Error, ChatItem[], ['chats', string]>({
    queryKey: ['chats', name],
    queryFn: () => api.getChats(name),
    refetchInterval: 5000,
    enabled: !!name,
    structuralSharing: shareChatsByConversationKey,
  });
}

export function useChats(name: string) {
  return useQuery(getChatsQueryOptions(name));
}

/** Messages in a specific conversation — refreshes every 3 s for live updates. */
export function getMessagesQueryOptions(name: string, conversationKey: string) {
  return queryOptions<Message[], Error, Message[], ['messages', string, string]>({
    queryKey: ['messages', name, conversationKey],
    queryFn: () => api.getMessages(name, conversationKey),
    refetchInterval: 3000,
    enabled: !!name && !!conversationKey,
    structuralSharing: shareMessagesByPk,
  });
}

export function useMessages(name: string, conversationKey: string) {
  return useQuery(getMessagesQueryOptions(name, conversationKey));
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
