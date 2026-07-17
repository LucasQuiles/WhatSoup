// ---------------------------------------------------------------------------
//  Pure helpers for WebSocket event handling — no React dependencies.
// ---------------------------------------------------------------------------

import type { QueryKey } from '@tanstack/react-query';
import { isRecord } from './type-guards';

// ---------------------------------------------------------------------------
// WS event types (mirrors server contract)
// ---------------------------------------------------------------------------

export interface WsInvalidationEvent {
  type:
    | 'instance_status'
    | 'message_received'
    | 'chat_updated'
    | 'log_entry'
    | 'feed_event'
    | 'access_changed'
    | 'lid_conflict';
  instance: string;
  conversationKey?: string;
  lid?: string;
  messagePk?: number;
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

const INVALIDATION_TYPES = new Set<WsInvalidationEvent['type']>([
  'instance_status',
  'message_received',
  'chat_updated',
  'log_entry',
  'feed_event',
  'access_changed',
  'lid_conflict',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Parse and validate a WebSocket frame before the React hook uses it. */
export function parseWsEvent(data: unknown): WsEvent | null {
  if (typeof data !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;

  if (parsed.type === 'connected') {
    return typeof parsed.timestamp === 'number' && Number.isFinite(parsed.timestamp)
      ? { type: 'connected', timestamp: parsed.timestamp }
      : null;
  }

  if (parsed.type === 'typing_update') {
    if (
      !isNonEmptyString(parsed.instance) ||
      !isNonEmptyString(parsed.jid) ||
      typeof parsed.composing !== 'boolean' ||
      typeof parsed.since !== 'number' ||
      !Number.isFinite(parsed.since)
    ) {
      return null;
    }
    return {
      type: 'typing_update',
      instance: parsed.instance,
      jid: parsed.jid,
      composing: parsed.composing,
      since: parsed.since,
    };
  }

  if (!INVALIDATION_TYPES.has(parsed.type as WsInvalidationEvent['type']) || !isNonEmptyString(parsed.instance)) {
    return null;
  }

  const event: WsInvalidationEvent = {
    type: parsed.type as WsInvalidationEvent['type'],
    instance: parsed.instance,
  };
  if (typeof parsed.conversationKey === 'string') event.conversationKey = parsed.conversationKey;
  if (typeof parsed.lid === 'string') event.lid = parsed.lid;
  if (typeof parsed.messagePk === 'number' && Number.isFinite(parsed.messagePk)) event.messagePk = parsed.messagePk;
  return event;
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/**
 * Fetcher contract for {@link getFleetWebSocketUrl}. The real implementation
 * is the console's `apiFetch`, but tests supply a stub so they can assert
 * the request shape without standing up a server.
 */
export type TicketFetcher = () => Promise<{ ticket: string; expiresIn: number }>;

/**
 * Build a WebSocket URL by minting a short-lived ticket via the HTTP API.
 *
 * The previous implementation embedded the root fleet token in the URL,
 * which leaked through devtools, page source, and proxy logs. Issue #237.
 * Returns `null` when the ticket fetch fails (e.g. unauthenticated) so the
 * caller can fall back to its polling path.
 */
export async function getFleetWebSocketUrl(
  location: { protocol: string; host: string },
  fetchTicket: TicketFetcher,
): Promise<string | null> {
  let ticket: string;
  try {
    const result = await fetchTicket();
    ticket = result.ticket;
  } catch {
    return null;
  }
  if (typeof ticket !== 'string' || ticket.length === 0) return null;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws?ticket=${encodeURIComponent(ticket)}`;
}

// ---------------------------------------------------------------------------
// Invalidation key mapping
// ---------------------------------------------------------------------------

/** Map a WS event to the TanStack Query keys that should be invalidated. */
export function getInvalidationKeys(event: WsInvalidationEvent): QueryKey[] {
  const { type, instance } = event;

  switch (type) {
    case 'instance_status':
      // #1882 criterion 4: the activity feed synthesizes a health-transition
      // entry for this same status change (src/fleet/routes/feed.ts), so a
      // connected client's feed query must refresh alongside the line
      // queries — otherwise the historical alert list only catches up on the
      // next unrelated feed-triggering event.
      return [['lines'], ['lines', instance], ['provider-status', instance], ['feed']];
    case 'message_received':
      return [['messages', instance], ['chats', instance], ['search', instance]];
    case 'chat_updated':
      return [['chats', instance]];
    case 'log_entry':
      return [['logs', instance]];
    case 'feed_event':
      return [['feed']];
    case 'access_changed':
      return [['access', instance]];
    case 'lid_conflict':
      return [['lid-mappings']];
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
