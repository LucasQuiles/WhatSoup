// ---------------------------------------------------------------------------
//  WhatSoup Console — Fleet Data Hooks
//  Uses TanStack Query with mock data (simulated async delay).
//  When the real API is ready, swap `delay(mock.fn())` for `fetch(...)`.
// ---------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import * as mock from '../mock-data';

function delay<T>(data: T, ms = 200): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(data), ms));
}

/** All line instances — refreshes every 5 s. */
export function useLines() {
  return useQuery({
    queryKey: ['lines'],
    queryFn: () => delay(mock.getLines()),
    refetchInterval: 5000,
  });
}

/** Single line by name — refreshes every 5 s. */
export function useLine(name: string) {
  return useQuery({
    queryKey: ['lines', name],
    queryFn: () => delay(mock.getLine(name)),
    refetchInterval: 5000,
  });
}

/** Chat list for a given line. */
export function useChats(name: string) {
  return useQuery({
    queryKey: ['chats', name],
    queryFn: () => delay(mock.getChats(name)),
  });
}

/** Messages in a specific conversation. Disabled until conversationKey is set. */
export function useMessages(name: string, conversationKey: string) {
  return useQuery({
    queryKey: ['messages', name, conversationKey],
    queryFn: () => delay(mock.getMessages(name, conversationKey)),
    enabled: !!conversationKey,
  });
}

/** Access control list for a line. */
export function useAccess(name: string) {
  return useQuery({
    queryKey: ['access', name],
    queryFn: () => delay(mock.getAccess(name)),
  });
}

/** Structured logs for a line — refreshes every 3 s. */
export function useLogs(name: string) {
  return useQuery({
    queryKey: ['logs', name],
    queryFn: () => delay(mock.getLogs(name)),
    refetchInterval: 3000,
  });
}

/** Global activity feed — refreshes every 5 s. */
export function useFeed() {
  return useQuery({
    queryKey: ['feed'],
    queryFn: () => delay(mock.getFeed()),
    refetchInterval: 5000,
  });
}
