// src/transport/contract/extensions.ts
import type { ConversationRef, MessageRef } from '../../core/transport-refs.ts';
import type {
  AttachmentRef, ReactionEvent, EditEvent, DeleteEvent, PresenceEvent,
  ReadEvent, GroupUpdateEvent, ButtonPressEvent, OutboundStatusEvent,
} from './events.ts';
import type {
  KeyboardButton, MediaPayload, MediaBytes, VoicePayload,
  GroupMetadata, SendMediaOptions, SendVoiceOptions,
} from './commands.ts';
import type { Subscription } from './subscription.ts';

export interface SupportsMedia {
  sendMedia(target: ConversationRef, payload: MediaPayload, opts?: SendMediaOptions): Promise<MessageRef>;
  fetchAttachment(ref: AttachmentRef): Promise<MediaBytes>;
}

export interface SupportsVoiceNotes {
  sendVoiceNote(target: ConversationRef, audio: VoicePayload, opts?: SendVoiceOptions): Promise<MessageRef>;
}

export interface SupportsReactions {
  react(target: MessageRef, emoji: string): Promise<void>;
  unreact(target: MessageRef, emoji: string): Promise<void>;
  on(event: 'reaction', handler: (e: ReactionEvent) => void): Subscription;
}

export interface SupportsEdit {
  editText(target: MessageRef, newText: string): Promise<void>;
  on(event: 'edit', handler: (e: EditEvent) => void): Subscription;
}

export interface SupportsDelete {
  deleteMessage(target: MessageRef, scope: 'me' | 'everyone'): Promise<void>;
  on(event: 'delete', handler: (e: DeleteEvent) => void): Subscription;
}

export interface SupportsTyping {
  setTyping(target: ConversationRef, on: boolean): Promise<void>;
}

export interface SupportsPresence {
  on(event: 'presence', handler: (e: PresenceEvent) => void): Subscription;
}

export interface SupportsGroups {
  getGroupMetadata(target: ConversationRef): Promise<GroupMetadata>;
  on(event: 'group-update', handler: (e: GroupUpdateEvent) => void): Subscription;
}

export interface SupportsReadReceipts {
  markRead(target: MessageRef): Promise<void>;
  on(event: 'read', handler: (e: ReadEvent) => void): Subscription;
}

export interface SupportsInlineKeyboards {
  sendWithButtons(target: ConversationRef, text: string, buttons: ReadonlyArray<KeyboardButton>): Promise<MessageRef>;
  on(event: 'button-press', handler: (e: ButtonPressEvent) => void): Subscription;
}

export interface SupportsOutboundStatus {
  on(event: 'outbound-status', handler: (e: OutboundStatusEvent) => void): Subscription;
}

// ─── Type guards ────────────────────────────────────────────────────────────

import type { TransportAdapter } from './adapter.ts';

export const isMediaCapable = (a: TransportAdapter): a is TransportAdapter & SupportsMedia =>
  a.capabilities.extensions.has('media');
export const isVoiceCapable = (a: TransportAdapter): a is TransportAdapter & SupportsVoiceNotes =>
  a.capabilities.extensions.has('voice-notes');
export const isReactive = (a: TransportAdapter): a is TransportAdapter & SupportsReactions =>
  a.capabilities.extensions.has('reactions');
export const isEditable = (a: TransportAdapter): a is TransportAdapter & SupportsEdit =>
  a.capabilities.extensions.has('edit');
export const isDeletable = (a: TransportAdapter): a is TransportAdapter & SupportsDelete =>
  a.capabilities.extensions.has('delete');
export const isTypingCapable = (a: TransportAdapter): a is TransportAdapter & SupportsTyping =>
  a.capabilities.extensions.has('typing');
export const isPresenceCapable = (a: TransportAdapter): a is TransportAdapter & SupportsPresence =>
  a.capabilities.extensions.has('presence');
export const isGroupsCapable = (a: TransportAdapter): a is TransportAdapter & SupportsGroups =>
  a.capabilities.extensions.has('groups');
export const isReadReceiptCapable = (a: TransportAdapter): a is TransportAdapter & SupportsReadReceipts =>
  a.capabilities.extensions.has('read-receipts');
export const isInlineKeyboardCapable = (a: TransportAdapter): a is TransportAdapter & SupportsInlineKeyboards =>
  a.capabilities.extensions.has('inline-keyboards');
export const hasOutboundStatus = (a: TransportAdapter): a is TransportAdapter & SupportsOutboundStatus =>
  a.capabilities.extensions.has('outbound-status');
