// src/core/types.ts
// Shared types for the core layer.

export type OutboundMedia =
  | { type: 'image'; buffer: Buffer; caption?: string; mimetype?: string; viewOnce?: boolean }
  | { type: 'document'; buffer: Buffer; filename: string; mimetype: string; caption?: string }
  | { type: 'audio'; buffer: Buffer; mimetype: string; ptt?: boolean; seconds?: number }
  | { type: 'video'; buffer: Buffer; caption?: string; mimetype?: string; ptv?: boolean; gifPlayback?: boolean; viewOnce?: boolean }
  | { type: 'sticker'; buffer: Buffer; mimetype?: string; isAnimated?: boolean };

export interface SubmissionReceipt {
  waMessageId: string | null;
}

export interface Messenger {
  sendMessage(chatJid: string, text: string): Promise<SubmissionReceipt>;
  /** Send composing/paused presence update. Fire-and-forget; failures are silently ignored. */
  setTyping?(chatJid: string, typing: boolean): Promise<void>;
  sendMedia(chatJid: string, media: OutboundMedia): Promise<SubmissionReceipt>;
}

export type ContentType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'poll' | 'unknown';

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

export interface InstanceInfo {
  name: string;
  mode: 'passive' | 'chat' | 'agent';
  accessMode: string;
}

export interface ChatRuntimeDetails {
  queueDepth: number;
  enrichmentUnprocessed: number;
}

export interface AgentRuntimeDetails {
  activeSessions: number;
  lastSessionStatus: string | null;
  lastSessionStartedAt: string | null;
}

export interface PassiveRuntimeDetails {
  unreadCount: number;
  lastActivityAt: string | null;
}
