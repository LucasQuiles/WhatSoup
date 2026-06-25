// ---------------------------------------------------------------------------
//  Realtime publisher — typed event emission helpers for WebSocket broadcast.
//  Keeps route handlers decoupled from WS server internals.
// ---------------------------------------------------------------------------

import type { WsEvent, WsInvalidationEvent, WsTypingEvent } from './websocket-server.ts';

export interface FleetRealtimePublisher {
  publish(event: WsEvent): void;
}

// ---------------------------------------------------------------------------
//  Convenience helpers — route handlers call these instead of building events
// ---------------------------------------------------------------------------

export function publishInstanceStatus(rt: FleetRealtimePublisher, instance: string): void {
  rt.publish({ type: 'instance_status', instance });
}

export function publishMessageReceived(
  rt: FleetRealtimePublisher,
  instance: string,
  conversationKey?: string,
  messagePk?: number,
): void {
  const event: WsInvalidationEvent = { type: 'message_received', instance };
  if (conversationKey) event.conversationKey = conversationKey;
  if (messagePk !== undefined) event.messagePk = messagePk;
  rt.publish(event);
}

export function publishChatUpdated(rt: FleetRealtimePublisher, instance: string, conversationKey?: string): void {
  const event: WsInvalidationEvent = { type: 'chat_updated', instance };
  if (conversationKey) event.conversationKey = conversationKey;
  rt.publish(event);
}

export function publishAccessChanged(rt: FleetRealtimePublisher, instance: string): void {
  rt.publish({ type: 'access_changed', instance });
}

export function publishLogChanged(rt: FleetRealtimePublisher, instance: string): void {
  rt.publish({ type: 'log_entry', instance });
}

export function publishFeedEvent(rt: FleetRealtimePublisher, instance: string): void {
  rt.publish({ type: 'feed_event', instance });
}

/**
 * Broadcast a LID-mapping conflict signal so consoles can refetch the
 * `/api/lid-mappings` panel (#251). The `instance` field carries the
 * controller's deterministic choice for the conflict's "owning" peer —
 * see `handleGetLidMappings`/`handleSyncLidMappings` for how it is picked.
 */
export function publishLidConflict(rt: FleetRealtimePublisher, instance: string, lid: string): void {
  const event: WsInvalidationEvent = { type: 'lid_conflict', instance };
  if (lid) event.lid = lid;
  rt.publish(event);
}

export function publishTypingUpdate(
  rt: FleetRealtimePublisher,
  instance: string,
  jid: string,
  composing: boolean,
): void {
  const event: WsTypingEvent = { type: 'typing_update', instance, jid, composing, since: Date.now() };
  rt.publish(event);
}

