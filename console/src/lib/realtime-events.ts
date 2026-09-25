// ---------------------------------------------------------------------------
//  Pure helpers for WebSocket event handling — no React dependencies.
// ---------------------------------------------------------------------------

import type { QueryKey } from '@tanstack/react-query';
import { isNonEmptyString, isRecord } from './type-guards';

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

/** Stream identity envelope stamped by servers ≥ #2519 draft-1 (additive).
 * Draft-2 adds `durableSequence`: the count of non-ephemeral frames emitted.
 * Typing frames advance `sequence` but not `durableSequence`, so the two
 * counters together attribute a gap to durable loss vs missed typing only. */
export interface WsStreamEnvelope {
  streamGeneration?: string;
  sequence?: number;
  durableSequence?: number;
}

export type WsEvent = (WsInvalidationEvent | WsTypingEvent | WsConnectedEvent) & WsStreamEnvelope;

/** Every event type that maps to query invalidations. Exported so the
 * realtime-owned closure test derives its coverage from this registry instead
 * of a manual literal a new event type could silently dodge. */
export const INVALIDATION_TYPES = new Set<WsInvalidationEvent['type']>([
  'instance_status',
  'message_received',
  'chat_updated',
  'log_entry',
  'feed_event',
  'access_changed',
  'lid_conflict',
]);

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

  const envelope: WsStreamEnvelope = {};
  if (isNonEmptyString(parsed.stream_generation)) envelope.streamGeneration = parsed.stream_generation;
  if (typeof parsed.sequence === 'number' && Number.isFinite(parsed.sequence)) {
    envelope.sequence = parsed.sequence;
  }
  if (typeof parsed.durable_sequence === 'number' && Number.isFinite(parsed.durable_sequence)) {
    envelope.durableSequence = parsed.durable_sequence;
  }

  if (parsed.type === 'connected') {
    return typeof parsed.timestamp === 'number' && Number.isFinite(parsed.timestamp)
      ? { type: 'connected', timestamp: parsed.timestamp, ...envelope }
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
      ...envelope,
    };
  }

  if (!INVALIDATION_TYPES.has(parsed.type as WsInvalidationEvent['type']) || !isNonEmptyString(parsed.instance)) {
    return null;
  }

  const event: WsInvalidationEvent & WsStreamEnvelope = {
    type: parsed.type as WsInvalidationEvent['type'],
    instance: parsed.instance,
    ...envelope,
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
// Stream gap detection (#2519) — pure helpers, no React dependencies.
// ---------------------------------------------------------------------------

/** Last verified position in the server's frame stream. `durableSequence`
 * stays null against pre-durable servers; gap judgment then falls back to the
 * raw-sequence rule. */
export interface StreamCursor {
  generation: string | null;
  sequence: number | null;
  durableSequence: number | null;
}

/** `ephemeral_gap`: the durable chain is intact but raw sequence shows missed
 * frames — only typing frames were lost, so only the typing cache needs
 * reconciliation. Every other gap class demands the full realtime-owned set. */
export type StreamGap = 'unverifiable' | 'generation_changed' | 'sequence_gap' | 'ephemeral_gap';

/** Every realtime-owned query family. A detected gap invalidates ALL of these:
 * partial invalidation is exactly the staleness class #2519 documents. The
 * closure test pins this list against getInvalidationKeys' families. */
export const REALTIME_OWNED_QUERY_KEYS: QueryKey[] = [
  ['lines'],
  ['provider-status'],
  ['feed'],
  ['messages'],
  ['chats'],
  ['search'],
  ['logs'],
  ['access'],
  ['lid-mappings'],
  ['typing'],
];

/** Judge a reconnect hello against the last verified cursor.
 *
 * First-ever connection: nothing could have been missed — no gap. After that,
 * a hello without a verifiable envelope, from a different generation, or at a
 * different sequence than last seen all mean displayed data cannot be assumed
 * current (fail toward reconciliation, never toward "restored").
 */
export function detectHelloGap(cursor: StreamCursor, hello: WsStreamEnvelope): StreamGap | null {
  if (cursor.generation === null) return null;
  if (typeof hello.streamGeneration !== 'string' || typeof hello.sequence !== 'number') {
    return 'unverifiable';
  }
  if (hello.streamGeneration !== cursor.generation) return 'generation_changed';
  if (typeof hello.durableSequence === 'number' && cursor.durableSequence !== null) {
    if (hello.durableSequence !== cursor.durableSequence) return 'sequence_gap';
    if (hello.sequence === cursor.sequence) return null;
    // Raw regression is never explainable by missed typing frames: fail full.
    return cursor.sequence !== null && hello.sequence > cursor.sequence ? 'ephemeral_gap' : 'sequence_gap';
  }
  if (hello.sequence !== cursor.sequence) return 'sequence_gap';
  return null;
}

/** Judge an in-stream frame against the cursor. Legacy frames without an
 * envelope (or before any envelope was seen) are tolerated — gap detection
 * simply stays unavailable for them.
 *
 * `ephemeral` declares the FRAME's own class (typing frames do not advance
 * durable_sequence). The judge needs it because an ephemeral frame carrying an
 * advanced durable position proves a durable frame was dropped, while a
 * durable frame advancing by exactly one is just its own arrival. */
export function detectFrameGap(cursor: StreamCursor, frame: WsStreamEnvelope, ephemeral = false): StreamGap | null {
  if (typeof frame.streamGeneration !== 'string' || typeof frame.sequence !== 'number') return null;
  if (cursor.generation === null || cursor.sequence === null) return null;
  if (frame.streamGeneration !== cursor.generation) return 'generation_changed';
  if (typeof frame.durableSequence === 'number' && cursor.durableSequence !== null) {
    const expectedDurable = cursor.durableSequence + (ephemeral ? 0 : 1);
    if (frame.durableSequence !== expectedDurable) return 'sequence_gap';
    if (frame.sequence === cursor.sequence + 1) return null;
    // Raw at/behind the cursor is a stream-integrity violation, not typing loss.
    return frame.sequence > cursor.sequence + 1 ? 'ephemeral_gap' : 'sequence_gap';
  }
  if (frame.sequence !== cursor.sequence + 1) return 'sequence_gap';
  return null;
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
