// src/transport/contract/commands.ts
import type { ConversationRef, MessageRef } from '../../core/transport-refs.ts';

export interface SendTextOptions {
  readonly inReplyTo?: MessageRef;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  /** Permitted ONLY for typing/read/presence side effects. Forbidden for sendText/sendMedia/etc. */
  readonly degradeOnFailure?: false;
}

export interface MediaPayload {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly filename?: string;
  readonly caption?: string;
}

export interface SendMediaOptions extends SendTextOptions {}

export interface VoicePayload {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly durationSec?: number;
}

export interface SendVoiceOptions extends SendTextOptions {}

export interface KeyboardButton {
  readonly label: string;
  readonly id: string;
}

export interface MediaBytes {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

export interface GroupMetadata {
  readonly conversation: ConversationRef;
  readonly title: string;
  readonly memberCount: number;
}
