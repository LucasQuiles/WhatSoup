// ---------------------------------------------------------------------------
//  Pure helpers for WebSocket event handling — no React dependencies.
// ---------------------------------------------------------------------------

import type { QueryKey } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// WS event types (mirrors server contract)
// ---------------------------------------------------------------------------

export interface WsInvalidationEvent {
  type: 'instance_status' | 'message_received' | 'chat_updated' | 'log_entry' | 'feed_event' | 'access_changed';
  instance: string;
  conversationKey?: string;
}

export interface WsTypingEvent {
  type: 'typing_update';
  instance: string;
  jid: string;
  composing: boolean;
  since: number;
}

export interface WsConnectedEvent {
  type: 'connected';
  timestamp: number;
}

export type WsEvent = WsInvalidationEvent | WsTypingEvent | WsConnectedEvent;

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/** Build a WebSocket URL from the current page location and fleet token. */
export function getFleetWebSocketUrl(location: { protocol: string; host: string }, token: string | null): string | null {
  if (!token) return null;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Invalidation key mapping
// ---------------------------------------------------------------------------

/** Map a WS event to the TanStack Query keys that should be invalidated. */
export function getInvalidationKeys(event: WsInvalidationEvent): QueryKey[] {
  const { type, instance } = event;

  switch (type) {
    case 'instance_status':
      return [['lines'], ['lines', instance]];
    case 'message_received':
      return [['messages', instance], ['chats', instance]];
    case 'chat_updated':
      return [['chats', instance]];
    case 'log_entry':
      return [['logs', instance]];
    case 'feed_event':
      return [['feed']];
    case 'access_changed':
      return [['access', instance]];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Typing cache mutation
// ---------------------------------------------------------------------------

export interface TypingEntry {
  instance: string;
  jid: string;
  since: number;
}

/** Apply a typing_update event to the existing typing cache. */
export function applyTypingUpdate(
  previous: TypingEntry[] | undefined,
  event: WsTypingEvent,
): TypingEntry[] {
  const entries = previous ? [...previous] : [];

  if (event.composing) {
    // Add or update
    const idx = entries.findIndex((e) => e.instance === event.instance && e.jid === event.jid);
    const entry: TypingEntry = { instance: event.instance, jid: event.jid, since: event.since };
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
  } else {
    // Remove
    return entries.filter((e) => !(e.instance === event.instance && e.jid === event.jid));
  }

  return entries;
}
