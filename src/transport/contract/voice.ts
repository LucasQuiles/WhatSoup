// src/transport/contract/voice.ts
import type { ConversationRef } from '../../core/transport-refs.ts';
import type { TransportAdapter } from './adapter.ts';

/** Reference to a placed call (provider call SID). */
export interface CallRef {
  readonly id: string;
  readonly status: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'failed' | 'no-answer' | 'canceled';
}

export interface PlaceCallOptions {
  /** TwiML to execute when answered; the transport supplies a default voicemail prompt when omitted. */
  readonly twiml?: string;
  readonly correlationId?: string;
}

/**
 * Optional capability: transports that can place outbound voice calls.
 * Distinct from SupportsVoiceNotes (sending audio MEDIA over chat);
 * this is telephony. Queried structurally, not via ExtensionName.
 */
export interface VoiceCapableTransport {
  placeCall(target: ConversationRef, opts?: PlaceCallOptions): Promise<CallRef>;
}

export const isVoiceCallCapable = (
  a: TransportAdapter,
): a is TransportAdapter & VoiceCapableTransport =>
  typeof (a as Partial<VoiceCapableTransport>).placeCall === 'function';
