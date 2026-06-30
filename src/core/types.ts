// src/core/types.ts
// Shared types for the core layer.

import type { Readable } from 'node:stream';
import type { GuardCaller } from './outbound-identity/types.ts';

export type OutboundMediaSource =
  | { buffer: Buffer; stream?: never; url?: never }
  | { stream: Readable; buffer?: never; url?: never }
  | { url: string; buffer?: never; stream?: never };

export type OutboundMedia =
  | ({ type: 'image'; caption?: string; mimetype?: string; viewOnce?: boolean } & OutboundMediaSource)
  | ({ type: 'document'; filename: string; mimetype: string; caption?: string } & OutboundMediaSource)
  | ({ type: 'audio'; mimetype: string; ptt?: boolean; seconds?: number } & OutboundMediaSource)
  | ({ type: 'video'; caption?: string; mimetype?: string; ptv?: boolean; gifPlayback?: boolean; viewOnce?: boolean } & OutboundMediaSource)
  | ({ type: 'sticker'; mimetype?: string; isAnimated?: boolean } & OutboundMediaSource);

export interface SubmissionReceipt {
  waMessageId: string | null;
}

export type TypingState = boolean | 'composing' | 'recording' | 'paused';

/**
 * Per-send options. `caller` is an OPTIONAL infra/system-caller token threaded
 * to the outbound-identity guard so the spec §4.2-step-B exemption (infra
 * callers are never floored) is reachable. ONLY trusted infra call sites set it
 * (the health-server admin /send); agent/MCP send paths never plumb it, so an
 * untrusted caller cannot use it to bypass the cold floor. Absent ⇒ 'agent'.
 */
export interface SendOptions {
  caller?: GuardCaller;
}

export interface Messenger {
  sendMessage(chatJid: string, text: string, opts?: SendOptions): Promise<SubmissionReceipt>;
  /** Send composing/paused/recording presence update. Fire-and-forget; failures are silently ignored. */
  setTyping?(chatJid: string, typing: TypingState): Promise<void>;
  sendMedia(chatJid: string, media: OutboundMedia): Promise<SubmissionReceipt>;
}

export type ContentType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'live_location' | 'contact' | 'poll' | 'group_invite' | 'product' | 'pin' | 'interactive' | 'unknown';

export interface IncomingMessage {
  messageId: string;
  chatJid: string;
  senderJid: string;
  senderName: string | null;
  content: string | null;
  /** Human-readable summary for FTS indexing. Null for text messages (content is already readable). */
  contentText: string | null;
  contentType: ContentType;
  isFromMe: boolean;
  isGroup: boolean;
  /** JIDs @mentioned in the message */
  mentionedJids: string[];
  /** Unix epoch seconds */
  timestamp: number;
  quotedMessageId: string | null;
  isResponseWorthy: boolean;
  /** Raw Baileys message — needed for media download */
  rawMessage?: unknown;
  /** durability: seq from inbound_events journal — threads the inbound event through the runtime lifecycle */
  inboundSeq?: number;
}

export interface RuntimeHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  details: Record<string, unknown>;
}

// InstanceInfo, ChatRuntimeDetails, AgentRuntimeDetails, PassiveRuntimeDetails
// removed — these were designed for a typed health response that was never implemented.
// The health endpoint uses inline object shapes instead.
