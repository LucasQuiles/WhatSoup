// src/transport/contract/events.ts
import type { ChannelId, ConversationRef, MessageRef, ParticipantRef } from '../../core/transport-refs.ts';

export interface AttachmentRef {
  readonly id: string;
  readonly kind: 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'voice' | 'unknown';
  readonly mime?: string;
  readonly sizeBytes?: number;
  readonly filename?: string;
}

export interface InboundMessage {
  readonly ref: MessageRef;
  readonly conversation: ConversationRef;
  readonly sender: ParticipantRef;
  readonly fromMe: boolean;
  readonly text: string | null;
  readonly attachments: ReadonlyArray<AttachmentRef>;
  readonly inReplyTo?: MessageRef;
  readonly timestamp: Date;
  readonly inboundEventKey: string;
  readonly transportTimestamp: Date;
  readonly ingestSeq: number;
}

// `fromMe` is included in PR 0a so the contract shape is stable, but the
// self-echo/reconciliation behavior that depends on it is exercised in PR 6.
// PR 0a only asserts that the field is preserved across inbound delivery.

/** Adapter-private extension. Never crosses the fanout boundary. */
export interface InboundMessageInternal extends InboundMessage {
  readonly raw: unknown;
}

export interface OutboundStatusEvent {
  readonly correlationId: string;
  readonly candidateRef: MessageRef | null;
  readonly status: 'sent' | 'delivered' | 'read' | 'failed';
  readonly providerCode?: string;
  readonly at: Date;
}

export interface ReactionEvent {
  readonly target: MessageRef;
  readonly actor: ParticipantRef;
  readonly emoji: string;
  readonly removed: boolean;
  readonly at: Date;
}

export interface EditEvent {
  readonly target: MessageRef;
  readonly newText: string;
  readonly at: Date;
}

export interface DeleteEvent {
  readonly target: MessageRef;
  readonly scope: 'me' | 'everyone';
  readonly at: Date;
}

export interface PresenceEvent {
  readonly conversation: ConversationRef;
  readonly participant: ParticipantRef;
  readonly state: 'online' | 'offline' | 'last-seen';
  readonly at: Date;
}

export interface ReadEvent {
  readonly target: MessageRef;
  readonly reader: ParticipantRef;
  readonly at: Date;
}

export interface GroupUpdateEvent {
  readonly conversation: ConversationRef;
  readonly kind: 'metadata' | 'membership' | 'admin';
  readonly at: Date;
}

export interface ButtonPressEvent {
  readonly target: MessageRef;
  readonly actor: ParticipantRef;
  readonly buttonId: string;
  readonly at: Date;
}

/** Discriminated union of all event types that flow across the contract. */
export type InboundEvent =
  | { kind: 'message'; data: InboundMessage }
  | { kind: 'reaction'; data: ReactionEvent }
  | { kind: 'edit'; data: EditEvent }
  | { kind: 'delete'; data: DeleteEvent }
  | { kind: 'presence'; data: PresenceEvent }
  | { kind: 'read'; data: ReadEvent }
  | { kind: 'group-update'; data: GroupUpdateEvent }
  | { kind: 'button-press'; data: ButtonPressEvent }
  | { kind: 'outbound-status'; data: OutboundStatusEvent };

/** Whether a given event class is durable (must persist before dispatch). */
export function isDurableEventKind(kind: InboundEvent['kind']): boolean {
  switch (kind) {
    case 'message':
    case 'edit':
    case 'delete':
    case 'outbound-status':
      return true;
    case 'reaction':
    case 'presence':
    case 'read':
    case 'group-update':
    case 'button-press':
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
