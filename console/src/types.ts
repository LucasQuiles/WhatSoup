// ---------------------------------------------------------------------------
//  WhatSoup Console — Shared Type Definitions
// ---------------------------------------------------------------------------

export type Mode = 'passive' | 'chat' | 'agent';
export type Status = 'online' | 'degraded' | 'unreachable';

export interface LineInstance {
  name: string;
  phone: string;
  mode: Mode;
  status: Status;
  accessMode: string;
  healthPort: number;
  uptime: string;
  messagesTotal: number;
  health: {
    status: string;
    uptime_seconds: number;
    messages_total: number;
    connection: { state: string };
    sqlite: { messages_total: number; schema_version: number };
    runtime?: {
      passive?: { unreadCount: number; lastActivityAt: string | null };
      chat?: { queueDepth: number; enrichmentUnprocessed: number };
      agent?: {
        activeSessions: number;
        lastSessionStatus: string | null;
        lastSessionStartedAt: string | null;
      };
    };
    instance?: {
      name: string;
      mode: Mode;
      accessMode: string;
      socketPath: string | null;
    };
  } | null;
  heartbeat: ('up' | 'down' | 'slow')[];
  lastActive: string;
  error: string | null;
  unread?: number;
  queueDepth?: number;
  enrichmentUnprocessed?: number;
  activeSessions?: number;
  lastSessionStatus?: string | null;
  messagesToday?: number;
  messageStats?: {
    sent: number;
    received: number;
    images: number;
    audio: number;
    documents: number;
  };
  group?: string;
  config?: Record<string, unknown>;
  linkedStatus?: 'linked' | 'unlinked';
}

export interface ChatItem {
  conversationKey: string;
  name: string;
  lastMessagePreview: string;
  lastMessageAt: string;
  unreadCount: number;
  isGroup: boolean;
}

export interface Message {
  pk: number;
  conversationKey: string;
  senderName: string;
  senderJid: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  type: string;
  rawMessage?: string;
}

export interface AccessEntry {
  subjectType: 'phone' | 'group';
  subjectId: string;
  subjectName: string;
  status: 'allowed' | 'blocked' | 'pending' | 'seen';
  updatedAt: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
  source: string;
  component?: string;
}

export interface FeedEvent {
  time: string;
  mode: Mode;
  text: string;
  isError?: boolean;
}
