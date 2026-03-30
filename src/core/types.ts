// src/core/types.ts
// Shared types for the core layer.

export type OutboundMedia =
  | { type: 'image'; buffer: Buffer; caption?: string; mimetype?: string }
  | { type: 'document'; buffer: Buffer; filename: string; mimetype: string; caption?: string }
  | { type: 'audio'; buffer: Buffer; mimetype: string; ptt?: boolean }
  | { type: 'video'; buffer: Buffer; caption?: string; mimetype?: string };

export interface SubmissionReceipt {
  waMessageId: string | null;
}

export interface Messenger {
  sendMessage(chatJid: string, text: string): Promise<SubmissionReceipt>;
  /** Send composing/paused presence update. Fire-and-forget; failures are silently ignored. */
  setTyping?(chatJid: string, typing: boolean): Promise<void>;
  sendMedia(chatJid: string, media: OutboundMedia): Promise<SubmissionReceipt>;
}

export interface IncomingMessage {
  messageId: string;
  chatJid: string;
  senderJid: string;
  senderName: string | null;
  content: string | null;
  /** 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'poll' | 'unknown' */
  contentType: string;
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
